/**
 * [INPUT]: 依赖 src/index.ts（Host）与 src/client.tsx（Client）的 apply。
 * [OUTPUT]: **代理安全门禁**——用真 Cordis 代理语义的假 ctx 驱动 apply，证明：
 *   访问未 inject 的属性**不会**把插件挂载打挂。
 * [POS]: 本包最关键的一道回归门。它挡住「代码全对、测试全绿、实机挂载失败」这类事故。
 * [PROTOCOL]: 变更时更新此头部，然后检查 src/index.ts
 *
 * 【为什么需要这个文件】
 * Cordis 的 `ctx` 是 **Proxy**：访问未在 `inject` 数组里声明的属性会**抛异常**
 * （`cannot get property "webServer" without inject`），导致插件条目
 * `fiberPhase: failed`。
 *
 * 而普通对象假件**测不出来**——因为它取任何属性都返回 undefined，不抛。
 * 本文件用 `new Proxy` 复刻 Cordis 的真实语义：未声明的属性访问即抛。
 * 于是「忘了用 ctx.get()」这类错误在**单测里就会红**，不必等实机。
 */

import { describe, expect, it } from 'vitest'

import { apply as applyHost } from '../src/index.js'
import { apply as applyClient } from '../src/client.js'

/**
 * 复刻 Cordis ctx 代理语义的假 ctx。
 *
 * @param services - 已「inject」进去的服务面（可访问）
 * @param effects - 收集 ctx.effect 注册的回调
 */
function cordisLikeCtx(services: Record<string, unknown>) {
  // `get` 是 Cordis ctx 的公共方法：未 inject 的服务用它取会得到 undefined（不抛）。
  // 这是本插件取可选面的**唯一**安全方式。
  const withGet = {
    ...services,
    get(key: string): unknown {
      return (services as Record<string, unknown>)[key]
    },
  }
  return new Proxy(withGet as Record<string, unknown>, {
    get(target, prop: string) {
      // 未 inject 的属性访问 → 抛（与 Cordis 一致）
      if (!(prop in target)) {
        throw new Error(`cannot get property "${prop}" without inject`)
      }
      const value = target[prop]
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** 带 effect 收集的 ctx。 */
function hostCtx(extra: Record<string, unknown> = {}) {
  const effects: (() => void)[] = []
  const registered: string[] = []
  const ctx = cordisLikeCtx({
    effect(fn: () => void) {
      effects.push(fn)
      return () => {}
    },
    webServer: {
      register(route: { path: string }) {
        registered.push(route.path)
        return () => undefined
      },
    },
    ...extra,
  })
  return { ctx, effects, registered }
}

describe('Host apply —— 代理安全', () => {
  it('webServer 已 inject 时正常注册四条路由', () => {
    const { ctx, effects, registered } = hostCtx()
    expect(() => applyHost(ctx as never)).not.toThrow()
    for (const run of effects) run()
    expect(registered).toEqual([
      '/dsh-team/api/v1/local/teams',
      '/dsh-team/api/v1/local/teams/detail',
      '/dsh-team/api/v1/local/teams/activity',
      '/dsh-team/api/v1/local/teams/changes',
    ])
  })

  it('webServer **未 inject** 时安静跳过，不抛（代理会抛，直接冒到宿主）', () => {
    // 这是实机事故的原场景：早期版本用 (ctx as any).webServer 取值，
    // 代理直接抛错 → 插件 fiberPhase: failed。
    const effects: (() => void)[] = []
    const ctx = cordisLikeCtx({
      effect(fn: () => void) {
        effects.push(fn)
        return () => undefined
      },
    })
    expect(() => applyHost(ctx as never)).not.toThrow()
    for (const run of effects) expect(() => run()).not.toThrow()
  })

  it('agentTeams 未 inject 时安全降级为「宿主不支持」，不抛', () => {
    const { ctx, effects, registered } = hostCtx()
    applyHost(ctx as never)
    for (const run of effects) run()
    // 路由仍注册（宿主不支持时路由回 TEAM_UNSUPPORTED，而非 404）
    expect(registered.length).toBe(4)
  })

  it('agents 未 inject 时安全降级为空数组', () => {
    const { ctx, effects } = hostCtx()
    applyHost(ctx as never)
    expect(() => {
      for (const run of effects) run()
    }).not.toThrow()
  })

  it('真正的 Cordis 代理下整体不抛', () => {
    // 组合各种「有的有、有的没有」的情形，确保没有一条路径会去碰未 inject 的属性
    const cases: (() => Record<string, unknown>)[] = [
      () => ({}),
      () => ({ webServer: { register: () => () => undefined } }),
      () => ({ agentTeams: { membership: () => undefined, listMembers: () => [] } }),
      () => ({
        agentTeams: { membership: () => ({ id: 't', name: 'n' }), listMembers: () => [] },
        agents: { roots: () => [] },
      }),
    ]
    for (const build of cases) {
      const effects: (() => void)[] = []
      const base = build()
      const ctx = cordisLikeCtx({
        ...base,
        effect(fn: () => void) {
          effects.push(fn)
          return () => undefined
        },
      })
      expect(() => {
        applyHost(ctx as never)
        for (const run of effects) run()
      }).not.toThrow()
    }
  })
})

describe('Client apply —— 代理安全', () => {
  it('slots 已 inject 时正常注册两处座位', () => {
    const registered: { slot: string; options: Record<string, unknown> }[] = []
    const ctx = cordisLikeCtx({
      slots: {
        inject(_name: string, register: () => unknown) {
          register()
          return () => undefined
        },
        register(options: Record<string, unknown>) {
          registered.push({ slot: String(options['name']), options })
          return () => undefined
        },
      },
    })
    expect(() => applyClient(ctx as never)).not.toThrow()
    expect(registered.map((r) => r.slot).sort()).toEqual(['main', 'sidebar.panellist'])
  })

  it('slots **未 inject** 时安静跳过，不抛（实机事故同款）', () => {
    const ctx = cordisLikeCtx({})
    expect(() => applyClient(ctx as never)).not.toThrow()
  })
})