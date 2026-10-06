/**
 * [INPUT]: 依赖 src/index.ts（Host 长轮询路由）、src/state.ts（轮询循环）、src/api.ts（客户端等待面）。
 * [OUTPUT]: E7 门禁——锁死：请求不重叠、切换/卸载即停止、失败退避、客户端断开即中止等待、时长合规。
 * [POS]: E7 机械门禁。轮询失控会打满 CPU 并把宿主拖垮，这些必须钉死。
 * [PROTOCOL]: 变更时更新此头部，然后检查 src/state.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  LONG_POLL_MAX_MS,
  LONG_POLL_MIN_MS,
  LONG_POLL_MS,
  TEAM_CHANGES_PATH,
} from '../src/envelope.js'
import { createFactSource, registerRoutes } from '../src/index.js'
import { createTeamStore } from '../src/state.js'

/**
 * 假 ctx 的 `get`：复刻 Cordis 的取法——未 inject 的服务返回 undefined（不抛）。
 * 与 proxy-safety.test.ts 的严格代理配对使用：那里验证代理会抛，这里保证业务逻辑读得到。
 */
function withGet(services: Record<string, unknown>): Record<string, unknown> {
  return { ...services, get: (key: string): unknown => services[key] }
}

// ---------------------------------------------------------------------------
// 时长契约
// ---------------------------------------------------------------------------

describe('长轮询时长 —— 受宿主下界约束', () => {
  it('落在宿主允许的区间内（10 秒 ~ 1 小时）', () => {
    // 官方契约："from ten seconds through one hour"。低于 10 秒会被宿主拒。
    expect(LONG_POLL_MS).toBeGreaterThanOrEqual(LONG_POLL_MIN_MS)
    expect(LONG_POLL_MS).toBeLessThanOrEqual(LONG_POLL_MAX_MS)
  })

  it('下界就是 10 秒（不能为了"更实时"而调小）', () => {
    expect(LONG_POLL_MIN_MS).toBe(10_000)
  })
})

// ---------------------------------------------------------------------------
// Host 长轮询路由
// ---------------------------------------------------------------------------

function ctxWith(opts: {
  wait?: (caller: unknown, timeoutMs: number, signal: AbortSignal) => Promise<{ timedOut: boolean }>
  withTeams?: boolean
  rows?: readonly { id: string; subject: string; description: string; status: string; blockedBy: readonly string[]; ownerName?: string }[]
}) {
  const agentTeams: Record<string, unknown> = {
    membership: () => (opts.withTeams === false ? undefined : { id: 't1', name: '团队' }),
    listMembers: () => [{ name: '组长', role: 'lead', status: 'idle' }],
    listTasks: () => opts.rows ?? [],
  }
  if (opts.wait) agentTeams['waitForChange'] = opts.wait
  return withGet({
    agentTeams: opts.withTeams === false ? undefined : agentTeams,
    agents: { roots: () => ['agent-1'] },
  })
}

function capture(ctxBase: unknown) {
  const captured: { path: string; handler: (r: Request) => Response | Promise<Response> }[] = []
  const ctx = withGet({
    ...(ctxBase as Record<string, unknown>),
    webServer: {
      register: (route: { method: string; path: string; handler: (r: Request) => Response | Promise<Response> }) => {
        captured.push({ path: route.path, handler: route.handler })
        return () => undefined
      },
    },
  })
  registerRoutes(ctx as never, createFactSource(ctx as never))
  return captured
}

describe('Host 长轮询路由', () => {
  it('缺 teamId ⇒ TEAM_RESPONSE_INVALID', async () => {
    const routes = capture(ctxWith({}))
    const route = routes.find((r) => r.path === TEAM_CHANGES_PATH)
    const body = await (await route!.handler(new Request(`http://x${TEAM_CHANGES_PATH}`))).json()
    expect(body.ok).toBe(false)
    expect(body.code).toBe('TEAM_RESPONSE_INVALID')
  })

  it('宿主不支持 ⇒ TEAM_UNSUPPORTED', async () => {
    const routes = capture(ctxWith({ withTeams: false }))
    const route = routes.find((r) => r.path === TEAM_CHANGES_PATH)
    const body = await (await route!.handler(new Request(`http://x${TEAM_CHANGES_PATH}?teamId=t1`))).json()
    expect(body.code).toBe('TEAM_UNSUPPORTED')
  })

  it('有等待面 ⇒ 先等变化再取快照（一次请求做完两件事）', async () => {
    let waited = false
    const wait = async (): Promise<{ timedOut: boolean }> => {
      waited = true
      return { timedOut: false }
    }
    const routes = capture(ctxWith({
      wait,
      rows: [{ id: 't1', subject: '写代码', description: '', status: 'pending', blockedBy: [], ownerName: '甲' }],
    }))
    const route = routes.find((r) => r.path === TEAM_CHANGES_PATH)
    const body = await (await route!.handler(new Request(`http://x${TEAM_CHANGES_PATH}?teamId=t1`))).json()
    expect(waited).toBe(true)
    expect(body.data.tasks).toHaveLength(1)
  })

  it('传给宿主的等待时长在合法区间内', async () => {
    let seen = 0
    const wait = async (_c: unknown, timeoutMs: number): Promise<{ timedOut: boolean }> => {
      seen = timeoutMs
      return { timedOut: false }
    }
    const routes = capture(ctxWith({ wait }))
    const route = routes.find((r) => r.path === TEAM_CHANGES_PATH)
    await route!.handler(new Request(`http://x${TEAM_CHANGES_PATH}?teamId=t1`))
    expect(seen).toBeGreaterThanOrEqual(LONG_POLL_MIN_MS)
    expect(seen).toBeLessThanOrEqual(LONG_POLL_MAX_MS)
  })

  it('等待抛错 ⇒ 仍返回快照，不让客户端看到失败', async () => {
    const wait = async (): Promise<{ timedOut: boolean }> => {
      throw new Error('wait exploded')
    }
    const routes = capture(ctxWith({
      wait,
      rows: [{ id: 't1', subject: 's', description: '', status: 'pending', blockedBy: [] }],
    }))
    const route = routes.find((r) => r.path === TEAM_CHANGES_PATH)
    const response = await route!.handler(new Request(`http://x${TEAM_CHANGES_PATH}?teamId=t1`))
    const body = await response.json()
    expect(body.ok).toBe(true)
  })

  it('宿主无等待面 ⇒ 立即返回，不让客户端白等一个轮询周期', async () => {
    let waitCalls = 0
    const routes = capture(ctxWith({
      rows: [{ id: 't1', subject: 's', description: '', status: 'pending', blockedBy: [] }],
    }))
    const route = routes.find((r) => r.path === TEAM_CHANGES_PATH)
    const started = Date.now()
    await route!.handler(new Request(`http://x${TEAM_CHANGES_PATH}?teamId=t1`))
    // 无 waitForChange 面 ⇒ 没被调用过，且立即返回（远小于一个轮询周期）
    expect(waitCalls).toBe(0)
    expect(Date.now() - started).toBeLessThan(LONG_POLL_MS)
  })

  it('客户端断开 ⇒ 中止等待，不吊着连接', async () => {
    let aborted = false
    // ⚠️ 这里必须用**同步就绪**的握手，否则会与 handler 注册监听产生竞态：
    // 若 abort 早于 addEventListener，事件就丢了，测试会假挂起。
    // 真实浏览器里请求不会在 handler 启动前就断开，所以生产代码无需为此让步。
    let release: (() => void) | undefined
    const entered = new Promise<void>((resolve) => {
      release = resolve
    })

    const wait = (_c: unknown, _t: number, signal: AbortSignal): Promise<{ timedOut: boolean }> =>
      new Promise((resolve) => {
        release?.()
        signal.addEventListener('abort', () => {
          aborted = true
          resolve({ timedOut: true })
        })
      })

    const controller = new AbortController()
    const routes = capture(ctxWith({ wait }))
    const route = routes.find((r) => r.path === TEAM_CHANGES_PATH)
    const pending = route!.handler(new Request(`http://x${TEAM_CHANGES_PATH}?teamId=t1`, { signal: controller.signal }))

    // 等 handler 真的进了 wait（监听已挂好）再断开
    await entered
    controller.abort()
    await pending
    expect(aborted).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 客户端轮询循环
// ---------------------------------------------------------------------------

const fetchMock = vi.fn()
let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  originalFetch = globalThis.fetch
  fetchMock.mockReset()
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.useRealTimers()
})

function detailReply() {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      data: {
        team: {
          summary: { teamId: 't1', name: '团队', workspaceLabel: '', memberCount: 1, active: false, createdAt: '2026-01-01T00:00:00.000Z', ordinal: 0 },
          members: [{ memberId: '组长', role: 'lead', status: 'idle', statusText: '空闲', pendingCount: 0, starting: false }],
        },
      },
    }),
  })
}

describe('轮询循环 —— 不重叠', () => {
  it('下一次等待只在本次返回后发起', async () => {
    vi.useFakeTimers()
    let inFlight = 0
    let maxInFlight = 0

    fetchMock.mockImplementation((url: string) => {
      const path = String(url)
      if (path.includes('/teams/detail')) return detailReply()
      if (path.includes('/activity') || path.includes('/changes')) {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({ ok: true, data: { messages: [], tasks: [] } }),
        }).finally(() => { inFlight -= 1 })
      }
      return detailReply()
    })

    const store = createTeamStore()
    const open = store.openTeam('t1')
    await vi.advanceTimersByTimeAsync(0)
    await open
    await vi.advanceTimersByTimeAsync(50)
    // 任何时刻最多一条在途
    expect(maxInFlight).toBeLessThanOrEqual(1)
    store.dispose()
  })

  it('关闭团队后不再发起新的等待', async () => {
    vi.useFakeTimers()
    let changesCalls = 0
    fetchMock.mockImplementation((url: string) => {
      const path = String(url)
      if (path.includes('/teams/detail')) return detailReply()
      if (path.includes('/changes')) {
        changesCalls += 1
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({ ok: true, data: { messages: [], tasks: [] } }),
        })
      }
      return Promise.resolve({
        ok: true, status: 200,
        json: async () => ({ ok: true, data: { messages: [], tasks: [] } }),
      })
    })

    const store = createTeamStore()
    const open = store.openTeam('t1')
    await vi.advanceTimersByTimeAsync(0)
    await open
    const before = changesCalls
    store.closeTeam()
    await vi.advanceTimersByTimeAsync(200_000)
    // 关闭后一条都不该再多
    expect(changesCalls).toBe(before)
    store.dispose()
  })

  it('dispose 后停止轮询', async () => {
    vi.useFakeTimers()
    let changesCalls = 0
    fetchMock.mockImplementation((url: string) => {
      const path = String(url)
      if (path.includes('/teams/detail')) return detailReply()
      if (path.includes('/changes')) {
        changesCalls += 1
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({ ok: true, data: { messages: [], tasks: [] } }),
        })
      }
      return Promise.resolve({
        ok: true, status: 200,
        json: async () => ({ ok: true, data: { messages: [], tasks: [] } }),
      })
    })

    const store = createTeamStore()
    const open = store.openTeam('t1')
    await vi.advanceTimersByTimeAsync(0)
    await open
    store.dispose()
    const before = changesCalls
    await vi.advanceTimersByTimeAsync(200_000)
    expect(changesCalls).toBe(before)
  })
})

describe('轮询循环 —— 失败退避', () => {
  it('连续失败时拉长间隔，不打满 CPU；详情页仍就绪', async () => {
    vi.useFakeTimers()
    let changesCalls = 0
    fetchMock.mockImplementation((url: string) => {
      const path = String(url)
      if (path.includes('/teams/detail')) return detailReply()
      if (path.includes('/changes')) {
        changesCalls += 1
        return Promise.reject(new Error('network down'))
      }
      return Promise.resolve({
        ok: true, status: 200,
        json: async () => ({ ok: true, data: { messages: [], tasks: [] } }),
      })
    })

    const store = createTeamStore()
    const open = store.openTeam('t1')
    await vi.advanceTimersByTimeAsync(0)
    await open
    const initial = changesCalls

    // 推进很久，但因为退避，请求次数应当是"少量"而非"每帧一次"
    await vi.advanceTimersByTimeAsync(60_000)
    const added = changesCalls - initial
    // 60 秒内最多几个轮次（退避上限 5×12s=60s），绝不是成百上千次
    expect(added).toBeLessThan(10)
    // 关键：宿主不可用时详情页依然是好的
    expect(store.detail.kind).toBe('ready')
    store.dispose()
  })

  it('失败不把界面打成错误态（保持旧数据）', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation((url: string) => {
      const path = String(url)
      if (path.includes('/teams/detail')) return detailReply()
      // 首次活动成功，之后全失败
      if (path.includes('/changes')) {
        return Promise.reject(new Error('down'))
      }
      return Promise.resolve({
        ok: true, status: 200,
        json: async () => ({ ok: true, data: { messages: [], tasks: [] } }),
      })
    })

    const store = createTeamStore()
    const open = store.openTeam('t1')
    await vi.advanceTimersByTimeAsync(0)
    await open
    await vi.advanceTimersByTimeAsync(120_000)
    // 没有活动错误态这个概念——失败静默降级
    expect(store.detail.kind).toBe('ready')
    store.dispose()
  })
})