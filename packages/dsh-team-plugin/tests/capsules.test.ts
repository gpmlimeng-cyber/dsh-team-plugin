/**
 * [INPUT]: 依赖 src/capsules.tsx（纯组件）、src/state.ts（状态机）、src/identity.ts（取色）。
 * [OUTPUT]: E2 门禁——锁死：组长恒首位且不可移除、颜色钉死跨会话保持、点击切人、待确认角标按需出现。
 * [POS]: E2 机械门禁。胶囊栏是 E2 的可见交付，交互口径必须钉死。
 * [PROTOCOL]: 变更时更新此头部，然后检查 src/capsules.tsx
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MemberCapsule, MemberCapsuleBar } from '../src/capsules.js'
import { TEAM_ENTRY_ID, TEAM_ENTRY_ORDER, teamMainOptions, teamPanelOptions } from '../src/client.js'
import type { TeamMemberView } from '../src/contracts.js'
import { TEAM_MEMBER_LEADER_BADGE, TEAM_MEMBER_REMOVE_LABEL } from '../src/copy.js'
import { assignMemberColors, EMPTY_COLOR_MAP, TEAM_MEMBER_PALETTE, type MemberColorMap } from '../src/identity.js'
import { TeamDetailView } from '../src/panel.js'
import { createTeamStore } from '../src/state.js'

/** 拍平元素树为文本（模拟 reconciler 调用函数组件）。 */
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

/** 收集全部元素 props。 */
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
const colorMap: MemberColorMap = assignMemberColors(EMPTY_COLOR_MAP, members)

const noop = () => undefined

// ---------------------------------------------------------------------------
// 胶囊栏
// ---------------------------------------------------------------------------

describe('MemberCapsuleBar', () => {
  it('成员 ≤1 时整块不进 DOM（单成员不需要"选谁"）', () => {
    expect(MemberCapsuleBar({
      members: [lead],
      colorMap,
      activeMemberId: '组长',
      onSelect: noop,
    })).toBeNull()
    expect(MemberCapsuleBar({ members: [], colorMap, activeMemberId: null, onSelect: noop })).toBeNull()
  })

  it('每个成员一枚胶囊，顺序与 Host 一致（组长首位）', () => {
    const props = propsOf(MemberCapsuleBar({ members, colorMap, activeMemberId: '组长', onSelect: noop }))
    const ids = props.filter((p) => typeof p['data-member-capsule'] === 'string').map((p) => p['data-member-capsule'])
    expect(ids).toEqual(['组长', '成员甲', '成员乙'])
  })

  it('组长胶囊带「组长」标记，其余不带', () => {
    const props = propsOf(MemberCapsuleBar({ members, colorMap, activeMemberId: null, onSelect: noop }))
    const badges = props.filter((p) => p['data-member-leader-badge'] === 'true')
    expect(badges).toHaveLength(1)
    expect(texts(MemberCapsuleBar({ members, colorMap, activeMemberId: null, onSelect: noop }))).toContain(TEAM_MEMBER_LEADER_BADGE)
  })

  it('选中态：只有当前成员 aria-selected=true', () => {
    const props = propsOf(MemberCapsuleBar({ members, colorMap, activeMemberId: '成员乙', onSelect: noop }))
    const selected = props.filter((p) => p['aria-selected'] === true).map((p) => p['data-member-capsule'])
    expect(selected).toEqual(['成员乙'])
  })

  it('点击胶囊回调带上正确 memberId', () => {
    const picked: string[] = []
    const props = propsOf(MemberCapsuleBar({
      members,
      colorMap,
      activeMemberId: null,
      onSelect: (id) => picked.push(id),
    }))
    const capsule = props.find((p) => p['data-member-capsule'] === '成员甲')
    ;(capsule?.['onClick'] as () => void)()
    expect(picked).toEqual(['成员甲'])
  })

  it('键盘 Enter/Space 等同点击（胶囊可键盘操作）', () => {
    const picked: string[] = []
    const props = propsOf(MemberCapsuleBar({
      members,
      colorMap,
      activeMemberId: null,
      onSelect: (id) => picked.push(id),
    }))
    const capsule = props.find((p) => p['data-member-capsule'] === '成员甲')
    const onKeyDown = capsule?.['onKeyDown'] as (e: { key: string }) => void
    onKeyDown({ key: 'Enter' })
    onKeyDown({ key: ' ' })
    onKeyDown({ key: 'Tab' })
    expect(picked).toEqual(['成员甲', '成员甲']) // Tab 不触发
  })
})

describe('MemberCapsule — 身份色与状态呈现', () => {
  it('身份色下发给容器并落在名字上', () => {
    const props = propsOf(MemberCapsule({ member: members[1]!, colorMap, active: false, onSelect: noop }))
    const capsule = props.find((p) => p['data-member-capsule'] === '成员甲')
    const style = capsule?.['style'] as Record<string, string>
    // 成员甲 是色号 1
    expect(style['--mc']).toBe(TEAM_MEMBER_PALETTE[1])
  })

  it('选中态底色比未选中更深（用不同 mix 比例）', () => {
    const active = propsOf(MemberCapsule({ member: members[1]!, colorMap, active: true, onSelect: noop }))
    const idle = propsOf(MemberCapsule({ member: members[1]!, colorMap, active: false, onSelect: noop }))
    const activeStyle = active.find((p) => p['data-member-capsule'])?.['style'] as Record<string, string>
    const idleStyle = idle.find((p) => p['data-member-capsule'])?.['style'] as Record<string, string>
    expect(activeStyle['background']).not.toBe(idleStyle['background'])
  })

  it('选中时描边用身份色，未选中时透明', () => {
    const active = propsOf(MemberCapsule({ member: members[1]!, colorMap, active: true, onSelect: noop }))
    const style = active.find((p) => p['data-member-capsule'])?.['style'] as Record<string, string>
    expect(style['borderColor']).toBe(TEAM_MEMBER_PALETTE[1])
  })

  it('状态点带状态值，供样式与读屏区分（色 + 词双编码）', () => {
    const failed = propsOf(MemberCapsule({
      member: member({ memberId: '甲', status: 'failed', statusText: '启动失败' }),
      colorMap,
      active: false,
      onSelect: noop,
    }))
    const dot = failed.find((p) => typeof p['data-member-status-dot'] === 'string')
    expect(dot?.['data-member-status-dot']).toBe('failed')
    expect(texts(MemberCapsule({
      member: member({ memberId: '甲', status: 'failed', statusText: '启动失败' }),
      colorMap,
      active: false,
      onSelect: noop,
    }))).toContain('启动失败')
  })

  it('待确认为 0 时不画角标，>0 时画', () => {
    const zero = propsOf(MemberCapsule({ member: members[1]!, colorMap, active: false, onSelect: noop }))
    expect(zero.some((p) => p['data-member-pending'] === 'true')).toBe(false)

    const pending = propsOf(MemberCapsule({
      member: member({ memberId: '甲', pendingCount: 3 }),
      colorMap,
      active: false,
      onSelect: noop,
    }))
    const badge = pending.find((p) => p['data-member-pending'] === 'true')
    expect(badge).toBeDefined()
    expect(texts(MemberCapsule({ member: member({ memberId: '甲', pendingCount: 3 }), colorMap, active: false, onSelect: noop }))).toContain('3')
  })
})

describe('MemberCapsule — 移除按钮的克制', () => {
  it('组长永不可移除', () => {
    const props = propsOf(MemberCapsule({ member: lead, colorMap, active: false, onSelect: noop, onRemove: noop }))
    expect(props.some((p) => p['data-member-remove'] === '组长')).toBe(false)
  })

  it('普通成员有移除按钮，无障碍名含成员名', () => {
    const props = propsOf(MemberCapsule({
      member: members[1]!,
      colorMap,
      active: false,
      onSelect: noop,
      onRemove: noop,
    }))
    const remove = props.find((p) => p['data-member-remove'] === '成员甲')
    expect(remove?.['aria-label']).toBe(`${TEAM_MEMBER_REMOVE_LABEL}：成员甲`)
  })

  it('回调缺席时不画死按钮', () => {
    const props = propsOf(MemberCapsule({ member: members[1]!, colorMap, active: false, onSelect: noop }))
    expect(props.some((p) => typeof p['data-member-remove'] === 'string')).toBe(false)
  })

  it('点移除不会连带触发选中（stopPropagation）', () => {
    const picked: string[] = []
    const removed: string[] = []
    const props = propsOf(MemberCapsule({
      member: members[1]!,
      colorMap,
      active: false,
      onSelect: (id) => picked.push(id),
      onRemove: (id) => removed.push(id),
    }))
    const remove = props.find((p) => p['data-member-remove'] === '成员甲')
    const onClick = remove?.['onClick'] as (e: { stopPropagation: () => void }) => void
    onClick({ stopPropagation: () => undefined })
    expect(removed).toEqual(['成员甲'])
    expect(picked).toEqual([]) // 只移除，不切换
  })
})

describe('详情视图集成 —— 胶囊栏出现在成员 >1 的团队', () => {
  it('多成员团队渲染胶囊栏', () => {
    const props = propsOf(TeamDetailView({
      state: { kind: 'ready', team: { summary: { teamId: 't1', name: '团队', workspaceLabel: '', memberCount: 3, active: false, createdAt: '2026-01-01T00:00:00.000Z', ordinal: 0 }, members } },
      onBack: noop,
      onRetry: noop,
      colorMap,
      activeMemberId: '组长',
      onSelectMember: noop,
    }))
    expect(props.some((p) => p['data-member-bar'] === 'true')).toBe(true)
  })

  it('单成员团队不渲染胶囊栏', () => {
    const props = propsOf(TeamDetailView({
      state: { kind: 'ready', team: { summary: { teamId: 't1', name: '团队', workspaceLabel: '', memberCount: 1, active: false, createdAt: '2026-01-01T00:00:00.000Z', ordinal: 0 }, members: [lead] } },
      onBack: noop,
      onRetry: noop,
      colorMap,
    }))
    expect(props.some((p) => p['data-member-bar'] === 'true')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 状态机：颜色钉死跨会话
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

describe('store —— 打开团队后颜色与默认聚焦', () => {
  it('进入团队默认聚焦组长（先跟组长说话）', async () => {
    replyDetail(members)
    const store = createTeamStore()
    await store.openTeam('t1')
    expect(store.activeMemberId).toBe('组长')
    store.dispose()
  })

  it('颜色映射按当前成员分配，组长拿品牌色', async () => {
    replyDetail(members)
    const store = createTeamStore()
    await store.openTeam('t1')
    expect(store.colorMap['组长']).toBe(0)
    expect(store.colorMap['成员甲']).toBe(1)
    store.dispose()
  })

  it('selectMember 切换聚焦成员', async () => {
    replyDetail(members)
    const store = createTeamStore()
    await store.openTeam('t1')
    store.selectMember('成员乙')
    expect(store.activeMemberId).toBe('成员乙')
    store.dispose()
  })

  it('团队已解散时清空颜色与聚焦态', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, data: { team: null } }) })
    const store = createTeamStore()
    await store.openTeam('t1')
    expect(store.activeMemberId).toBeNull()
    expect(store.colorMap).toEqual({})
    store.dispose()
  })

  it('返回列表时清空聚焦与颜色（不串到下一个团队）', async () => {
    replyDetail(members)
    const store = createTeamStore()
    await store.openTeam('t1')
    store.closeTeam()
    expect(store.activeMemberId).toBeNull()
    expect(store.colorMap).toEqual({})
    store.dispose()
  })
})
// ---------------------------------------------------------------------------
// 并存隔离性（方案 1）
// ---------------------------------------------------------------------------

describe('并存隔离 —— 不与宿主原生团队 UI 抢位置', () => {
  /**
   * 宿主当前 `sidebar.panellist` 的占用者（实机 Inspect 取得）：
   * `plugins`(order 0) 与 `schedules`(order 10)。
   *
   * 关键事实：**宿主原生的 agent-team UI 并没有占用这个插槽**——
   * 它不进侧栏一级入口。所以本插件的 `team` 是**新增**一格，不是替换。
   */
  const SHIPPED_SIDEBAR_IDS = new Set(['plugins', 'schedules'])

  it('入口 id 不与宿主既有 id 撞车', () => {
    expect(SHIPPED_SIDEBAR_IDS.has(TEAM_ENTRY_ID)).toBe(false)
  })

  it('排序排在宿主既有项之后（升序，故 order 更大=更靠后）', () => {
    // 官方实测：plugins=0 / schedules=10
    expect(TEAM_ENTRY_ORDER).toBeGreaterThan(10)
  })

  it('只注册两个插槽，不越界挂别的东西', () => {
    const panel = teamPanelOptions()
    const main = teamMainOptions(createTeamStore())
    expect(panel['name']).toBe('sidebar.panellist')
    expect(main['name']).toBe('main')
    // 不声明 priority（那是遮蔽官方用的；并存场景下绝不能遮）
    expect(panel['priority']).toBeUndefined()
    expect(main['priority']).toBeUndefined()
  })

  it('入口文案是「智能体团队」，与宿主原生团队 UI 可区分', () => {
    expect(teamPanelOptions()['label']).toBe('智能体团队')
  })
})
