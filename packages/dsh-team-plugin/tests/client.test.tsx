/**
 * [INPUT]: 依赖 src/state.ts（状态机）、src/api.ts（取数，被 stub）、src/panel.tsx（纯组件）、src/copy.ts（文案）。
 * [OUTPUT]: Client 侧门禁——锁住四态互斥、后发先至作废、失败保码、文案无裸码、DOM 契约。
 * [POS]: 本包的 Client 侧机械门禁。纯组件直接函数调用断言，不引入渲染测试环境。
 * [PROTOCOL]: 变更时更新此头部，然后检查 src/state.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TEAM_ERROR_CODES, type TeamSummaryView } from '../src/contracts.js'
import { TEAM_ENTRY_ID, TEAM_ENTRY_ORDER, teamMainOptions, teamPanelOptions } from '../src/client.js'
import {
  TEAM_EMPTY_TITLE,
  TEAM_LIST_TITLE,
  teamErrorCopy,
  teamErrorRetryable,
} from '../src/copy.js'
import { TeamDetailView, TeamEmptyState, TeamErrorNotice, TeamListView } from '../src/panel.js'
import { TEAM_LIST_EMPTY, createTeamStore } from '../src/state.js'

/**
 * 把 React 元素树拍平成可断言的文本，便于断言「文案有没有上屏」。
 *
 * 关键：这里**没有渲染器**（不引 ReactDOM），而真实运行时是由 reconciler 调用函数组件的。
 * 故遍历时遇到函数型组件就**直接调用它**（本包的纯组件都是「无 hook、可直接函数调用」的），
 * 这与真实渲染等价，又不必引入渲染测试环境。
 */
function texts(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out)
    return out
  }
  if (typeof node !== 'object') return out

  const element = node as { type?: unknown; props?: Record<string, unknown> }
  // 函数型组件：模拟 reconciler 的调用
  if (typeof element.type === 'function') {
    const render = element.type as (props: unknown) => unknown
    return texts(render(element.props), out)
  }
  texts(element.props?.children, out)
  return out
}

/** 深度优先找出第一个满足条件的元素（用于取 onClick）。 */
function findElement(
  node: unknown,
  predicate: (el: { props: Record<string, unknown> }) => boolean,
): { props: Record<string, unknown> } | null {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate)
      if (found) return found
    }
    return null
  }
  if (typeof node !== 'object') return null
  const element = node as { type?: unknown; props?: Record<string, unknown> }
  if (!element.props) return null
  if (typeof element.type === 'function') {
    const render = element.type as (props: unknown) => unknown
    return findElement(render(element.props), predicate)
  }
  if (predicate(element as { props: Record<string, unknown> })) return element as { props: Record<string, unknown> }
  return findElement(element.props.children, predicate)
}

const summary = (over: Partial<TeamSummaryView> = {}): TeamSummaryView => ({
  teamId: 't1',
  name: '我的团队',
  workspaceLabel: 'project',
  memberCount: 3,
  active: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  ordinal: 0,
  ...over,
})

// ---------------------------------------------------------------------------
// fetch stub
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

/** 让 fetch 返回一个成功信封。 */
function replyOk(data: unknown): void {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, data }),
  })
}

/** 让 fetch 返回一个失败信封。 */
function replyFail(code: string): void {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ok: false, code }),
  })
}

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

describe('createTeamStore — 四态互斥且不谎称空列表', () => {
  it('初始为 loading，不是空列表', () => {
    const store = createTeamStore()
    expect(store.list).toEqual({ kind: 'loading' })
    store.dispose()
  })

  it('取到空列表才落到 ready 空态', async () => {
    replyOk({ teams: [] })
    const store = createTeamStore()
    await store.refreshList()
    // 关键：空列表是「取过了、确实没有」，不是「还没取到」。
    expect(store.list).toEqual(TEAM_LIST_EMPTY)
    store.dispose()
  })

  it('失败落 failed 态并保码，不回落成空列表', async () => {
    replyFail('TEAM_UNSUPPORTED')
    const store = createTeamStore()
    await store.refreshList()
    expect(store.list).toEqual({ kind: 'failed', code: 'TEAM_UNSUPPORTED' })
    store.dispose()
  })

  it('网络异常归到 TEAM_REQUEST_FAILED（异常文本不外泄）', async () => {
    fetchMock.mockRejectedValue(new Error('socket hang up: 内网地址泄露'))
    const store = createTeamStore()
    await store.refreshList()
    const state = store.list
    expect(state.kind).toBe('failed')
    if (state.kind === 'failed') expect(state.code).toBe('TEAM_REQUEST_FAILED')
    store.dispose()
  })

  it('响应结构非法归到 TEAM_RESPONSE_INVALID', async () => {
    replyOk({ teams: [{ teamId: 't' }] }) // 缺字段
    const store = createTeamStore()
    await store.refreshList()
    expect(store.list).toEqual({ kind: 'failed', code: 'TEAM_RESPONSE_INVALID' })
    store.dispose()
  })

  it('后发先至：迟到响应不得覆盖新选择', async () => {
    const store = createTeamStore()
    const deferred: (() => void)[] = []
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          deferred.push(() =>
            resolve({
              ok: true,
              status: 200,
              json: async () => ({ ok: true, data: { team: null } }),
            }),
          )
        }),
    )

    const first = store.openTeam('t1')
    const second = store.openTeam('t2')
    // 两条请求都已发出；只让**第一条**（先发后至）落地，它必须被作废。
    deferred[0]?.()
    deferred[1]?.()
    await Promise.all([first, second])

    // 最终状态属于后一条请求的选中项。
    expect(store.selectedTeamId).toBe('t2')
    store.dispose()
  })

  it('详情：团队不存在是 missing 态而非失败', async () => {
    replyOk({ team: null })
    const store = createTeamStore()
    await store.openTeam('gone')
    expect(store.detail).toEqual({ kind: 'missing' })
    store.dispose()
  })

  it('retry 在详情场景重取详情，列表场景重取列表', async () => {
    replyOk({ team: null })
    const store = createTeamStore()
    await store.openTeam('t1')
    const before = fetchMock.mock.calls.length
    await store.retry()
    // 在详情里 ⇒ 重取详情，不再拉列表。
    expect(fetchMock.mock.calls.length).toBe(before + 1)
    expect(String(fetchMock.mock.calls[before]?.[0])).toContain('teamId=t1')
    store.dispose()
  })

  it('closeTeam 清空选中并回到未选中态', async () => {
    replyOk({ team: null })
    const store = createTeamStore()
    await store.openTeam('t1')
    store.closeTeam()
    expect(store.selectedTeamId).toBeNull()
    store.dispose()
  })

  it('订阅者抛错不阻断其它订阅者，也不崩宿主', () => {
    const store = createTeamStore()
    const good = vi.fn()
    store.subscribe(() => {
      throw new Error('坏订阅者')
    })
    store.subscribe(good)
    expect(() => void store.refreshList()).not.toThrow()
    store.dispose()
  })
})

// ---------------------------------------------------------------------------
// 文案纪律
// ---------------------------------------------------------------------------

describe('文案纪律——界面不得出现裸码', () => {
  it('每个错误码都有人话与下一步，且人话里没有裸码', () => {
    for (const code of TEAM_ERROR_CODES) {
      const copy = teamErrorCopy(code)
      expect(copy.title.length).toBeGreaterThan(0)
      expect(copy.next.length).toBeGreaterThan(0)
      // 人话与下一步都不得含 TEAM_ 前缀——技术信息由组件单独渲染。
      expect(copy.title).not.toContain('TEAM_')
      expect(copy.next).not.toContain('TEAM_')
    }
  })

  it('可重试判定与文案表一致（终止码不给假重试）', () => {
    expect(teamErrorRetryable('TEAM_REQUEST_FAILED')).toBe(true)
    expect(teamErrorRetryable('TEAM_RESPONSE_INVALID')).toBe(false)
    expect(teamErrorRetryable('TEAM_UNSUPPORTED')).toBe(false)
  })

  it('失败提示块：人话上屏，裸码只进技术信息区', () => {
    const node = TeamErrorNotice({ code: 'TEAM_UNSUPPORTED' })
    const flat = texts(node)
    expect(flat).toContain('当前宿主未启用团队能力')
    expect(flat.some((t) => t.includes('TEAM_UNSUPPORTED'))).toBe(true)
    // 终止码 ⇒ 不画重试按钮（文本里不应出现「重试」这个动作词）
    expect(flat).not.toContain('重试')
  })

  it('可重试错误且回调在场时才画真重试', () => {
    const withRetry = texts(TeamErrorNotice({ code: 'TEAM_REQUEST_FAILED', onRetry: () => undefined }))
    expect(withRetry).toContain('重试')
    // 回调缺席 ⇒ 不给死按钮
    const noRetry = texts(TeamErrorNotice({ code: 'TEAM_REQUEST_FAILED' }))
    expect(noRetry).not.toContain('重试')
  })
})

// ---------------------------------------------------------------------------
// 纯组件 DOM 契约
// ---------------------------------------------------------------------------

describe('TeamListView', () => {
  it('loading 态只出状态提示，不出列表', () => {
    const node = TeamListView({ state: { kind: 'loading' }, onOpen: () => undefined, onRetry: () => undefined })
    const flat = texts(node)
    expect(flat).toContain('正在加载团队…')
    expect(flat).not.toContain(TEAM_LIST_TITLE)
  })

  it('空态说清「为什么空」和「下一步」', () => {
    const node = TeamEmptyState()
    const flat = texts(node)
    expect(flat).toContain(TEAM_EMPTY_TITLE)
    expect(flat.some((t) => t.includes('组长'))).toBe(true) // 给出可照抄的说法
  })

  it('ready 态渲染每个团队一行，成员数上屏', () => {
    const node = TeamListView({
      state: { kind: 'ready', teams: [summary(), summary({ teamId: 't2', name: '第二个团队' })] },
      onOpen: () => undefined,
      onRetry: () => undefined,
    })
    const flat = texts(node)
    expect(flat).toContain('我的团队')
    expect(flat).toContain('第二个团队')
    expect(flat).toContain('3 位成员')
  })

  it('活跃团队显示「运行中」，非活跃不显示（不做常驻占位）', () => {
    const active = TeamListView({
      state: { kind: 'ready', teams: [summary({ active: true })] },
      onOpen: () => undefined,
      onRetry: () => undefined,
    })
    expect(texts(active)).toContain('运行中')

    const idle = TeamListView({
      state: { kind: 'ready', teams: [summary({ active: false })] },
      onOpen: () => undefined,
      onRetry: () => undefined,
    })
    expect(texts(idle)).not.toContain('运行中')
  })

  it('点击行回调带上正确 teamId', () => {
    const opened: string[] = []
    const node = TeamListView({
      state: { kind: 'ready', teams: [summary({ teamId: 'abc' })] },
      onOpen: (id) => opened.push(id),
      onRetry: () => undefined,
    })
    // 找出那一行带 data-team-row 的按钮并触发其 onClick
    const button = findElement(node, (el) => el.props['data-team-row'] === 'abc')
    expect(button).not.toBeNull()
    ;(button!.props['onClick'] as () => void)()
    expect(opened).toEqual(['abc'])
  })
})

describe('TeamDetailView', () => {
  const member = (over = {}) => ({
    memberId: '组长',
    role: 'lead' as const,
    status: 'idle' as const,
    statusText: '空闲',
    pendingCount: 0,
    starting: false,
    ...over,
  })

  it('missing 态说「已不存在」而不是报错', () => {
    const flat = texts(TeamDetailView({ state: { kind: 'missing' }, onBack: () => undefined, onRetry: () => undefined }))
    expect(flat).toContain('该团队已不存在')
  })

  it('ready 态渲染团队名与全部成员，lead 保持首位', () => {
    const node = TeamDetailView({
      state: {
        kind: 'ready',
        team: {
          summary: summary(),
          members: [member(), member({ memberId: '成员乙', role: 'teammate', status: 'active', statusText: '工作中' })],
        },
      },
      onBack: () => undefined,
      onRetry: () => undefined,
    })
    const flat = texts(node)
    expect(flat).toContain('我的团队')
    expect(flat).toContain('组长')
    expect(flat).toContain('成员乙')
    expect(flat).toContain('工作中')
  })

  it('待确认数为 0 时不画角标，>0 时上屏', () => {
    const zero = TeamDetailView({
      state: { kind: 'ready', team: { summary: summary(), members: [member()] } },
      onBack: () => undefined,
      onRetry: () => undefined,
    })
    expect(texts(zero)).not.toContain('0')

    const pending = TeamDetailView({
      state: { kind: 'ready', team: { summary: summary(), members: [member({ pendingCount: 2 })] } },
      onBack: () => undefined,
      onRetry: () => undefined,
    })
    expect(texts(pending)).toContain('2')
  })

  it('failed 态渲染错误块且带返回', () => {
    const flat = texts(TeamDetailView({
      state: { kind: 'failed', code: 'TEAM_REQUEST_FAILED' },
      onBack: () => undefined,
      onRetry: () => undefined,
    }))
    expect(flat).toContain('没能取到团队信息')
    expect(flat).toContain('返回团队列表')
  })
})

// ---------------------------------------------------------------------------
// 座位契约
// ---------------------------------------------------------------------------

describe('座位注册面——照官方实物，不发明字段', () => {
  it('sidebar.panellist 只有官方那四个 metadata 字段', () => {
    const options = teamPanelOptions()
    expect(options['name']).toBe('sidebar.panellist')
    expect(options['id']).toBe(TEAM_ENTRY_ID)
    expect(options['order']).toBe(TEAM_ENTRY_ORDER)
    expect(options['label']).toBe('智能体团队')
    // 官方实物没有 title/icon 字段，出现即为违规
    expect(options['title']).toBeUndefined()
    expect(options['icon']).toBeUndefined()
  })

  it('main 的 key 与 sidebar 的 id 同名（结构性一致，不可能漂移）', () => {
    expect(teamMainOptions(createTeamStore())['key']).toBe(teamPanelOptions()['id'])
  })

  it('main 的 inject 面交出同一个 store 实例', () => {
    const store = createTeamStore()
    const injected = teamMainOptions(store)['inject'] as () => { store: unknown }
    expect(injected().store).toBe(store)
    store.dispose()
  })
})