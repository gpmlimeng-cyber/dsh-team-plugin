/**
 * [INPUT]: 依赖 src/view-mode.ts（规则）、src/view-toggle.tsx（控件）、src/panel.tsx（两种布局）、src/state.ts（状态机）。
 * [OUTPUT]: E3 门禁——锁死：两视图共享选中态、成员移除回退组长、按团队记忆、存储损坏回落默认。
 * [POS]: E3 机械门禁。「切视图不丢选中态」是本阶段的核心不变量。
 * [PROTOCOL]: 变更时更新此头部，然后检查 src/view-mode.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TeamMemberView } from '../src/contracts.js'
import { TEAM_VIEW_BOARD, TEAM_VIEW_PARALLEL, TEAM_VIEW_SINGLE, TEAM_SINGLE_NO_MEMBER } from '../src/copy.js'
import { assignMemberColors, EMPTY_COLOR_MAP, type ColorStorage } from '../src/identity.js'
import { ParallelMemberPanes, SingleMemberPane, TeamDetailView } from '../src/panel.js'
import { createTeamStore } from '../src/state.js'
import { TeamViewToggle } from '../src/view-toggle.js'
import {
  DEFAULT_VIEW_MODE,
  isMemberView,
  parseViewMode,
  readViewMode,
  resolveSingleViewMemberId,
  VIEW_MODE_KEY_PREFIX,
  viewModeStorageKey,
  writeViewMode,
} from '../src/view-mode.js'

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
  if (typeof element.type === 'function') return texts((element.type as (p: unknown) => unknown)(element.props), out)
  texts(element.props?.children, out)
  return out
}

function propsOf(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (node === null || node === undefined || typeof node === 'boolean' || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) propsOf(child, out)
    return out
  }
  const element = node as { type?: unknown; props?: Record<string, unknown> }
  if (typeof element.type === 'function') return propsOf((element.type as (p: unknown) => unknown)(element.props), out)
  if (element.props) out.push(element.props)
  propsOf(element.props?.children, out)
  return out
}

const member = (over: Partial<TeamMemberView> = {}): TeamMemberView => ({
  memberId: '成员',
  role: 'teammate',
  status: 'idle',
  statusText: '空闲',
  pendingCount: 0,
  starting: false,
  ...over,
})

const lead = member({ memberId: '组长', role: 'lead' })
const members = [lead, member({ memberId: '成员甲' }), member({ memberId: '成员乙' })]
const colorMap = assignMemberColors(EMPTY_COLOR_MAP, members)
const noop = () => undefined

function fakeStorage(initial: Record<string, string> = {}): ColorStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial))
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) }
}

// ---------------------------------------------------------------------------
// 模式规则
// ---------------------------------------------------------------------------

describe('parseViewMode — 非法值一律回落默认', () => {
  it('认得三个合法值', () => {
    expect(parseViewMode('parallel')).toBe('parallel')
    expect(parseViewMode('single')).toBe('single')
    expect(parseViewMode('board')).toBe('board')
  })

  it('未知值 / 空 / null 都回并行（绝不渲染界面不认识的值）', () => {
    for (const raw of ['flow', 'FLOW', '', '乱写', null]) {
      expect(parseViewMode(raw)).toBe(DEFAULT_VIEW_MODE)
      expect(parseViewMode(raw)).toBe('parallel')
    }
  })
})

describe('按团队记忆', () => {
  it('键按 teamId 分键，各团队各记各的', () => {
    expect(viewModeStorageKey('t1')).toBe(`${VIEW_MODE_KEY_PREFIX}t1`)
    const storage = fakeStorage()
    writeViewMode(storage, 't1', 'single')
    writeViewMode(storage, 't2', 'parallel')
    expect(readViewMode(storage, 't1')).toBe('single')
    expect(readViewMode(storage, 't2')).toBe('parallel')
  })

  it('存储不可用（null）时读回默认，写入静默降级', () => {
    expect(readViewMode(null, 't1')).toBe('parallel')
    expect(() => writeViewMode(null, 't1', 'single')).not.toThrow()
  })

  it('写入抛异常（配额满）不崩', () => {
    const failing: ColorStorage = { getItem: () => null, setItem: () => { throw new Error('QuotaExceeded') } }
    expect(() => writeViewMode(failing, 't1', 'single')).not.toThrow()
  })

  it('读取抛异常（无痕模式）回默认', () => {
    const throwing: ColorStorage = {
      getItem: () => { throw new Error('SecurityError') },
      setItem: () => undefined,
    }
    expect(readViewMode(throwing, 't1')).toBe('parallel')
  })
})

describe('resolveSingleViewMemberId — 选中成员消失时回退组长', () => {
  it('选中成员仍在队里 ⇒ 保持选中（切视图不丢选中态）', () => {
    expect(resolveSingleViewMemberId(members, '成员乙')).toBe('成员乙')
  })

  it('选中成员已移除 ⇒ 回退组长（不留空白页）', () => {
    expect(resolveSingleViewMemberId(members, '已移除的人')).toBe('组长')
  })

  it('从未选中过 ⇒ 选组长', () => {
    expect(resolveSingleViewMemberId(members, null)).toBe('组长')
  })

  it('没有组长时回退第一个成员', () => {
    const noLead = [member({ memberId: '甲' }), member({ memberId: '乙' })]
    expect(resolveSingleViewMemberId(noLead, null)).toBe('甲')
  })

  it('空团队返回 null', () => {
    expect(resolveSingleViewMemberId([], null)).toBeNull()
  })
})

describe('isMemberView', () => {
  it('并行与单聊需要成员列表；看板不需要', () => {
    expect(isMemberView('parallel')).toBe(true)
    expect(isMemberView('single')).toBe(true)
    expect(isMemberView('board')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 切换控件
// ---------------------------------------------------------------------------

describe('TeamViewToggle', () => {
  it('渲染三个可用模式（并行 / 单聊 / 看板）', () => {
    const props = propsOf(TeamViewToggle({ mode: 'parallel', onChange: noop }))
    const modes = props.filter((p) => typeof p['data-view-mode'] === 'string').map((p) => p['data-view-mode'])
    expect(modes).toEqual(['parallel', 'single', 'board'])
  })

  it('可用模式可显式收窄（将来按团队规模关掉某些视图）', () => {
    const props = propsOf(TeamViewToggle({ mode: 'parallel', onChange: noop, available: ['parallel', 'single'] }))
    const modes = props.filter((p) => typeof p['data-view-mode'] === 'string').map((p) => p['data-view-mode'])
    expect(modes).toEqual(['parallel', 'single'])
  })

  it('当前模式 aria-pressed=true', () => {
    const props = propsOf(TeamViewToggle({ mode: 'single', onChange: noop }))
    const pressed = props.filter((p) => p['aria-pressed'] === true).map((p) => p['data-view-mode'])
    expect(pressed).toEqual(['single'])
  })

  it('点击回调带上目标模式', () => {
    const picked: string[] = []
    const props = propsOf(TeamViewToggle({ mode: 'parallel', onChange: (m) => picked.push(m) }))
    const btn = props.find((p) => p['data-view-mode'] === 'single')
    ;(btn?.['onClick'] as () => void)()
    expect(picked).toEqual(['single'])
  })

  it('只有一种可选项时整块不渲染（不做死控件）', () => {
    expect(TeamViewToggle({ mode: 'parallel', onChange: noop, available: ['parallel'] })).toBeNull()
    expect(TeamViewToggle({ mode: 'parallel', onChange: noop, available: [] })).toBeNull()
  })

  it('文案完整可见', () => {
    const flat = texts(TeamViewToggle({ mode: 'parallel', onChange: noop }))
    expect(flat).toContain(TEAM_VIEW_PARALLEL)
    expect(flat).toContain(TEAM_VIEW_SINGLE)
  })
})

// ---------------------------------------------------------------------------
// 两种布局
// ---------------------------------------------------------------------------

describe('ParallelMemberPanes — 全员并排', () => {
  it('每个成员一列，顺序与 Host 一致', () => {
    const props = propsOf(ParallelMemberPanes({ members, colorMap }))
    const panes = props.filter((p) => typeof p['data-pane'] === 'string').map((p) => p['data-pane'])
    expect(panes).toEqual(['组长', '成员甲', '成员乙'])
  })

  it('容器标记为 parallel 且带成员数', () => {
    const props = propsOf(ParallelMemberPanes({ members, colorMap }))
    const container = props.find((p) => p['data-view-panes'] === 'parallel')
    expect(container?.['data-member-count']).toBe('3')
  })

  it('每列带身份色变量（与胶囊栏同源）', () => {
    const props = propsOf(ParallelMemberPanes({ members, colorMap }))
    const pane = props.find((p) => p['data-pane'] === '成员甲')
    const style = pane?.['style'] as Record<string, string>
    expect(style['--mc']).toBeTruthy()
  })
})

describe('SingleMemberPane — 只显示当前成员', () => {
  it('只渲染一列', () => {
    const props = propsOf(SingleMemberPane({ members, colorMap, memberId: '成员乙' }))
    const panes = props.filter((p) => typeof p['data-pane'] === 'string')
    expect(panes).toHaveLength(1)
    expect(panes[0]?.['data-pane']).toBe('成员乙')
  })

  it('成员为空时给提示而不是空白页', () => {
    const flat = texts(SingleMemberPane({ members, colorMap, memberId: null }))
    expect(flat).toContain(TEAM_SINGLE_NO_MEMBER)
  })

  it('单聊容器标记为 single', () => {
    const props = propsOf(SingleMemberPane({ members, colorMap, memberId: '组长' }))
    expect(props.some((p) => p['data-view-panes'] === 'single')).toBe(true)
  })
})

describe('详情页按视图模式切换布局', () => {
  const detail = {
    summary: { teamId: 't1', name: '团队', workspaceLabel: '', memberCount: 3, active: false, createdAt: '2026-01-01T00:00:00.000Z', ordinal: 0 },
    members,
  }

  it('并行视图 ⇒ 并排布局', () => {
    const props = propsOf(TeamDetailView({
      state: { kind: 'ready', team: detail },
      onBack: noop, onRetry: noop, colorMap, viewMode: 'parallel',
    }))
    expect(props.some((p) => p['data-view-panes'] === 'parallel')).toBe(true)
  })

  it('单聊视图 ⇒ 单列布局', () => {
    const props = propsOf(TeamDetailView({
      state: { kind: 'ready', team: detail },
      onBack: noop, onRetry: noop, colorMap, activeMemberId: '成员乙', viewMode: 'single',
    }))
    expect(props.some((p) => p['data-view-panes'] === 'single')).toBe(true)
    expect(props.some((p) => p['data-view-panes'] === 'parallel')).toBe(false)
  })

  it('单聊时胶囊栏高亮的是**实际显示**的成员（选中者被移除 ⇒ 高亮组长）', () => {
    const props = propsOf(TeamDetailView({
      state: { kind: 'ready', team: detail },
      onBack: noop, onRetry: noop, colorMap, activeMemberId: '已移除的人', viewMode: 'single',
    }))
    const selected = props.filter((p) => p['aria-selected'] === true).map((p) => p['data-member-capsule'])
    expect(selected).toEqual(['组长'])
  })

  it('两视图都渲染胶囊栏（切视图不该让"选谁"消失）', () => {
    for (const mode of ['parallel', 'single'] as const) {
      const props = propsOf(TeamDetailView({
        state: { kind: 'ready', team: detail },
        onBack: noop, onRetry: noop, colorMap, viewMode: mode,
      }))
      expect(props.some((p) => p['data-member-bar'] === 'true')).toBe(true)
    }
  })

  it('单成员团队不渲染视图切换（只有一种视图可选）', () => {
    const props = propsOf(TeamDetailView({
      state: { kind: 'ready', team: { ...detail, members: [lead], summary: { ...detail.summary, memberCount: 1 } } },
      onBack: noop, onRetry: noop, colorMap, viewMode: 'parallel',
    }))
    expect(props.some((p) => p['data-view-toggle'] === 'true')).toBe(false)
  })

  it('多成员团队渲染视图切换', () => {
    const props = propsOf(TeamDetailView({
      state: { kind: 'ready', team: detail },
      onBack: noop, onRetry: noop, colorMap, viewMode: 'parallel',
    }))
    expect(props.some((p) => p['data-view-toggle'] === 'true')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 状态机
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
  if (typeof globalThis.localStorage !== 'undefined') {
    globalThis.localStorage.clear()
  }
})

function replyDetail(membersOut: readonly TeamMemberView[]): void {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      data: {
        team: {
          summary: { teamId: 't1', name: '团队', workspaceLabel: '', memberCount: membersOut.length, active: false, createdAt: '2026-01-01T00:00:00.000Z', ordinal: 0 },
          members: membersOut,
        },
      },
    }),
  })
}

describe('store —— 视图模式与选中态', () => {
  it('首次进入团队默认并行', async () => {
    replyDetail(members)
    const store = createTeamStore()
    await store.openTeam('t1')
    expect(store.viewMode).toBe('parallel')
    store.dispose()
  })

  it('切视图**不动**选中成员（核心不变量）', async () => {
    replyDetail(members)
    const store = createTeamStore()
    await store.openTeam('t1')
    store.selectMember('成员乙')
    store.setViewMode('single')
    // 视图变了，选中的人没变——切视图不该"丢掉"刚选的人
    expect(store.viewMode).toBe('single')
    expect(store.activeMemberId).toBe('成员乙')
    store.setViewMode('parallel')
    expect(store.activeMemberId).toBe('成员乙')
    store.dispose()
  })

  it('返回列表后视图模式回默认（不串到下一个团队）', async () => {
    replyDetail(members)
    const store = createTeamStore()
    await store.openTeam('t1')
    store.setViewMode('single')
    store.closeTeam()
    expect(store.viewMode).toBe('parallel')
    store.dispose()
  })
})

describe('看板模式（E5 起正式开放）', () => {
  it('看板是切换器里的正式选项，文案可见', () => {
    expect(TEAM_VIEW_BOARD).toBe('看板')
    const modes = propsOf(TeamViewToggle({ mode: 'parallel', onChange: noop }))
      .filter((p) => typeof p['data-view-mode'] === 'string')
      .map((p) => p['data-view-mode'])
    expect(modes).toContain('board')
    expect(texts(TeamViewToggle({ mode: 'board', onChange: noop }))).toContain(TEAM_VIEW_BOARD)
  })
})