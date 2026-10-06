/**
 * [INPUT]: 依赖 src/index.ts（Host 活动源）、src/contracts.ts（活动解码）、src/activity.ts（DTO→模型）、src/state.ts。
 * [OUTPUT]: E6 门禁——锁住：活动路由的三态、任务脱敏（不下发内部句柄）、依赖名解析、失败降级不拖垮详情页。
 * [POS]: E6 机械门禁。活动是唯一会把宿主任务板暴露给界面的通道，脱敏规则必须钉死。
 * [PROTOCOL]: 变更时更新此头部，然后检查 src/index.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { decodeTeamActivityResponse, TeamDecodeError } from '../src/contracts.js'
import { TEAM_ACTIVITY_PATH } from '../src/envelope.js'
import { createFactSource, registerRoutes } from '../src/index.js'
import { resolveBlockerNames, toActivityMessages, toActivityTasks } from '../src/activity.js'
import { createTeamStore } from '../src/state.js'

/**
 * 假 ctx 的 `get`：复刻 Cordis 的取法——未 inject 的服务返回 undefined（不抛）。
 * 与 proxy-safety.test.ts 的严格代理配对使用：那里验证代理会抛，这里保证业务逻辑读得到。
 */
function withGet(services: Record<string, unknown>): Record<string, unknown> {
  return { ...services, get: (key: string): unknown => services[key] }
}

// ---------------------------------------------------------------------------
// 严格解码
// ---------------------------------------------------------------------------

describe('活动契约 —— 键集封闭', () => {
  const message = {
    messageId: 'm1',
    from: '组长',
    to: '甲',
    content: '开始吧',
    summary: '',
    system: false,
    createdAtMs: 1700000000000,
  }
  const task = {
    taskId: 't1',
    subject: '写代码',
    description: '',
    status: 'pending',
    owner: '甲',
    blockedBy: [],
    createdAtMs: 1700000000000,
  }

  it('合法载荷解出消息与任务', () => {
    const payload = decodeTeamActivityResponse({ messages: [message], tasks: [task] })
    expect(payload.messages).toHaveLength(1)
    expect(payload.tasks[0]?.taskId).toBe('t1')
  })

  it('空数组合法（团队还没活动）', () => {
    expect(decodeTeamActivityResponse({ messages: [], tasks: [] })).toEqual({ messages: [], tasks: [] })
  })

  it('缺字段 / 多字段 / 类型错一律判畸形', () => {
    expect(() => decodeTeamActivityResponse({ messages: [] })).toThrow(TeamDecodeError)
    expect(() => decodeTeamActivityResponse({ messages: [], tasks: [], extra: 1 })).toThrow(TeamDecodeError)
    expect(() => decodeTeamActivityResponse({ messages: [{ ...message, leaked: 'x' }], tasks: [] })).toThrow(TeamDecodeError)
    expect(() => decodeTeamActivityResponse({ messages: [{ ...message, system: 'yes' }], tasks: [] })).toThrow(TeamDecodeError)
    expect(() => decodeTeamActivityResponse({ messages: [{ ...message, createdAtMs: 'now' }], tasks: [] })).toThrow(TeamDecodeError)
  })

  it('blockedBy 非数组或含非字符串即判畸形', () => {
    expect(() => decodeTeamActivityResponse({ messages: [], tasks: [{ ...task, blockedBy: 'x' }] })).toThrow(TeamDecodeError)
    expect(() => decodeTeamActivityResponse({ messages: [], tasks: [{ ...task, blockedBy: [1] }] })).toThrow(TeamDecodeError)
  })

  it('正文超长判畸形（防宿主塞爆浏览器）', () => {
    expect(() => decodeTeamActivityResponse({
      messages: [{ ...message, content: 'x'.repeat(8193) }],
      tasks: [],
    })).toThrow(TeamDecodeError)
  })
})

// ---------------------------------------------------------------------------
// DTO → 模型
// ---------------------------------------------------------------------------

describe('DTO → 看板模型', () => {
  it('消息字段直译，系统标记采信 Host（不靠文案猜）', () => {
    const [msg] = toActivityMessages([{
      messageId: 'm1', from: '组长', to: '甲', content: '开工', system: true, createdAtMs: 5,
    }])
    expect(msg).toEqual({ id: 'm1', from: '组长', to: '甲', content: '开工', summary: '', system: true, createdAt: 5 })
  })

  it('任务字段直译，blockedBy 复制而非引用', () => {
    const source = [{ taskId: 't1', subject: 's', description: '', status: 'pending', owner: '甲', blockedBy: ['x'], createdAtMs: 1 }]
    const [task] = toActivityTasks(source)
    expect(task?.blockedBy).toEqual(['x'])
    expect(task?.blockedBy).not.toBe(source[0]?.blockedBy)
  })
})

describe('resolveBlockerNames —— 依赖名解析', () => {
  const task = (id: string, owner: string, blockedBy: string[]) => ({
    id, subject: `任务${id}`, description: '', status: 'pending', owner, blockedBy, createdAt: 0,
  })

  it('依赖已加载 ⇒ 显示其负责人名', () => {
    const tasks = [task('t1', '甲', ['t2']), task('t2', '乙', [])]
    expect(resolveBlockerNames(tasks)['t1']).toEqual(['乙'])
  })

  it('依赖未加载 ⇒ 跳过该依赖，不显示「未知」', () => {
    const tasks = [task('t1', '甲', ['不存在'])]
    // 解析不出 ⇒ 键不存在 ⇒ 前端整段依赖标签不出现
    expect(resolveBlockerNames(tasks)['t1']).toBeUndefined()
  })

  it('多个依赖，部分可解析时只列可解析的', () => {
    const tasks = [task('t1', '甲', ['t2', '不存在']), task('t2', '乙', [])]
    expect(resolveBlockerNames(tasks)['t1']).toEqual(['乙'])
  })

  it('依赖任务没有负责人 ⇒ 退回任务标题（至少知道在等什么）', () => {
    const tasks = [task('t1', '甲', ['t2']), task('t2', '', [])]
    expect(resolveBlockerNames(tasks)['t1']).toEqual(['任务t2'])
  })

  it('无依赖的任务不进索引', () => {
    expect(resolveBlockerNames([task('t1', '甲', [])])).toEqual({})
  })

  it('空任务列表不炸', () => {
    expect(resolveBlockerNames([])).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// Host 活动源与路由
// ---------------------------------------------------------------------------

interface FakeOptions {
  rows?: readonly { id: string; subject: string; description: string; status: string; blockedBy: readonly string[]; ownerName?: string }[]
  withTeams?: boolean
  throwOnListTasks?: boolean
  withListTasks?: boolean
}

function fakeCtx(options: FakeOptions = {}): unknown {
  const agentTeams = {
    membership: () => (options.withTeams === false ? undefined : { id: 't1', name: '团队' }),
    listMembers: () => [{ name: '组长', role: 'lead', status: 'idle' }],
  }
  const withListTasks = options.withListTasks !== false
  const target = agentTeams as unknown as Record<string, unknown>
  if (withListTasks) {
    target['listTasks'] = () => {
      if (options.throwOnListTasks) throw new Error('内部细节')
      return options.rows ?? []
    }
  }
  return withGet({
    agentTeams: options.withTeams === false ? undefined : agentTeams,
    agents: { roots: () => ['agent-1'] },
  })
}

describe('Host 活动源', () => {
  it('宿主不支持 ⇒ null（不是"没有活动"）', () => {
    const source = createFactSource(fakeCtx({ withTeams: false }) as never)
    expect(source.activity('t1')).toBeNull()
  })

  it('团队不存在 ⇒ null', () => {
    const source = createFactSource(fakeCtx({ withTeams: true }) as never)
    // 已知团队 t1；问一个不存在的
    expect(source.activity('不存在的团队')).toBeNull()
  })

  it('任务脱敏：下发字段恰好是约定的七项，不含内部句柄', () => {
    const source = createFactSource(fakeCtx({
      rows: [{ id: 't1', subject: '写代码', description: '', status: 'pending', blockedBy: ['t2'], ownerName: '甲' }],
    }) as never)
    const activity = source.activity('t1')
    expect(activity?.tasks[0]).toEqual({
      taskId: 't1',
      subject: '写代码',
      description: '',
      status: 'pending',
      owner: '甲',
      blockedBy: ['t2'],
      createdAtMs: 0,
    })
  })

  it('owner 缺失 ⇒ 空串（未指派），绝不把内部句柄当名字下发', () => {
    const source = createFactSource(fakeCtx({
      rows: [{ id: 't1', subject: 's', description: '', status: 'pending', blockedBy: [] }],
    }) as never)
    // 空串 ⇒ 看板会把任务放到 fallback 泳道，而不是造一个叫 Session_xxx 的泳道
    expect(source.activity('t1')?.tasks[0]?.owner).toBe('')
  })

  it('listTasks 抛错 ⇒ 降级成空任务，不冒泡', () => {
    const source = createFactSource(fakeCtx({ throwOnListTasks: true }) as never)
    expect(source.activity('t1')).toEqual({ messages: [], tasks: [] })
  })

  it('宿主没有 listTasks 面 ⇒ 退化但不崩', () => {
    const source = createFactSource(fakeCtx({ withListTasks: false }) as never)
    expect(source.activity('t1')).toEqual({ messages: [], tasks: [] })
  })

  it('行畸形（无 id）被跳过，不污染载荷', () => {
    const source = createFactSource(fakeCtx({
      rows: [
        { id: '', subject: '坏行', description: '', status: 'pending', blockedBy: [] },
        { id: 't2', subject: '好行', description: '', status: 'pending', blockedBy: [] },
      ],
    }) as never)
    const tasks = source.activity('t1')?.tasks ?? []
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.taskId).toBe('t2')
  })
})

describe('活动路由', () => {
  function capture(ctxBase: unknown) {
    const captured: { path: string; handler: (request: Request) => Response | Promise<Response> }[] = []
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

  it('缺 teamId ⇒ TEAM_RESPONSE_INVALID', async () => {
    const routes = capture(fakeCtx())
    const route = routes.find((r) => r.path === TEAM_ACTIVITY_PATH)
    const body = await (await route!.handler(new Request(`http://x${TEAM_ACTIVITY_PATH}`))).json()
    expect(body.ok).toBe(false)
    expect(body.code).toBe('TEAM_RESPONSE_INVALID')
  })

  it('宿主不支持 ⇒ TEAM_UNSUPPORTED', async () => {
    const routes = capture(fakeCtx({ withTeams: false }))
    const route = routes.find((r) => r.path === TEAM_ACTIVITY_PATH)
    const body = await (await route!.handler(new Request(`http://x${TEAM_ACTIVITY_PATH}?teamId=t1`))).json()
    expect(body.ok).toBe(false)
    expect(body.code).toBe('TEAM_UNSUPPORTED')
  })

  it('成功 ⇒ 键集恰为 { messages, tasks } 且可被 Client 解码', async () => {
    const routes = capture(fakeCtx({
      rows: [{ id: 't1', subject: '写代码', description: '', status: 'pending', blockedBy: [], ownerName: '甲' }],
    }))
    const route = routes.find((r) => r.path === TEAM_ACTIVITY_PATH)
    const response = await route!.handler(new Request(`http://x${TEAM_ACTIVITY_PATH}?teamId=t1`))
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json()
    expect(Object.keys(body.data).sort()).toEqual(['messages', 'tasks'])
    expect(decodeTeamActivityResponse(body.data).tasks).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// store：活动失败不拖垮详情页
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
})

describe('store —— 活动取数不影响详情页', () => {
  it('详情成功、活动成功 ⇒ 看板有条目', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/activity')) {
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({
            ok: true,
            data: {
              messages: [{ messageId: 'm1', from: '组长', to: '甲', content: '开工', summary: '', system: false, createdAtMs: 2 }],
              tasks: [{ taskId: 't1', subject: '写代码', description: '', status: 'pending', owner: '甲', blockedBy: [], createdAtMs: 1 }],
            },
          }),
        })
      }
      return Promise.resolve({
        ok: true, status: 200,
        json: async () => ({
          ok: true,
          data: {
            team: {
              summary: { teamId: 't1', name: '团队', workspaceLabel: '', memberCount: 2, active: false, createdAt: '2026-01-01T00:00:00.000Z', ordinal: 0 },
              members: [
                { memberId: '组长', role: 'lead', status: 'idle', statusText: '空闲', pendingCount: 0, starting: false },
                { memberId: '甲', role: 'teammate', status: 'idle', statusText: '空闲', pendingCount: 0, starting: false },
              ],
            },
          },
        }),
      })
    })

    const store = createTeamStore()
    await store.openTeam('t1')
    await vi.waitFor(() => expect(store.boardItems.length).toBeGreaterThan(0))
    expect(store.detail.kind).toBe('ready')
    store.dispose()
  })

  it('活动失败 ⇒ 详情页仍就绪，看板降级为空', async () => {
    let calls = 0
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/activity')) {
        calls += 1
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}) })
      }
      return Promise.resolve({
        ok: true, status: 200,
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
    })

    const store = createTeamStore()
    await store.openTeam('t1')
    await vi.waitFor(() => expect(calls).toBe(1))
    // 关键：活动挂了，但详情页照常就绪，用户仍能看成员
    expect(store.detail.kind).toBe('ready')
    expect(store.boardItems).toEqual([])
    store.dispose()
  })

  it('切走团队后清空活动，不串到下一个团队', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/activity')) {
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({
            ok: true,
            data: {
              messages: [],
              tasks: [{ taskId: 't1', subject: '写代码', description: '', status: 'pending', owner: '甲', blockedBy: [], createdAtMs: 1 }],
            },
          }),
        })
      }
      return Promise.resolve({
        ok: true, status: 200,
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
    })
    const store = createTeamStore()
    await store.openTeam('t1')
    await vi.waitFor(() => expect(store.boardItems.length).toBeGreaterThan(0))
    store.closeTeam()
    expect(store.boardItems).toEqual([])
    store.dispose()
  })
})