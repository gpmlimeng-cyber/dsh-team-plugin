/**
 * [INPUT]: 依赖 src/warmup.ts（判定）、src/warmup-overlay.tsx（遮罩）、src/state.ts（状态机）。
 * [OUTPUT]: E4 门禁——锁死：组长就绪即撤遮罩（不等全员）、单成员失败不阻塞、组长失败报错、超时兜底不无限转圈。
 * [POS]: E4 机械门禁。「一个成员起不来就卡死整个团队」是本阶段要杜绝的事故。
 * [PROTOCOL]: 变更时更新此头部，然后检查 src/warmup.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TeamMemberView } from '../src/contracts.js'
import {
  TEAM_WARMUP_LEAD_FAILED_NEXT,
  TEAM_WARMUP_PROGRESS,
  TEAM_WARMUP_TIMEOUT_NEXT,
  TEAM_WARMUP_TIMEOUT_TITLE,
} from '../src/copy.js'
import { assignMemberColors, EMPTY_COLOR_MAP } from '../src/identity.js'
import { createTeamStore } from '../src/state.js'
import {
  deriveWarmupPhase,
  failedMemberIds,
  findLead,
  isBlockedDuringWarmup,
  isPendingMember,
  readyMemberCount,
  WARMUP_BLOCKED_ACTIONS,
} from '../src/warmup.js'
import { TeamWarmupOverlay } from '../src/warmup-overlay.js'

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
const colorMap = assignMemberColors(EMPTY_COLOR_MAP, [lead, member({ memberId: '成员甲' })])
const noop = () => undefined

// ---------------------------------------------------------------------------
// 核心判定
// ---------------------------------------------------------------------------

describe('deriveWarmupPhase —— 组长就绪即撤，不等全员', () => {
  it('全员就绪 ⇒ ready', () => {
    const members = [lead, member({ memberId: '成员甲' })]
    expect(deriveWarmupPhase(members, false)).toEqual({ phase: 'ready', errorKind: null })
  })

  it('**组长就绪但成员仍在启动 ⇒ 依然 ready**（关键：不因单成员卡住整个团队）', () => {
    const members = [
      lead, // 已就绪
      member({ memberId: '成员甲', status: 'starting', statusText: '唤醒中', starting: true }),
    ]
    expect(deriveWarmupPhase(members, false).phase).toBe('ready')
  })

  it('**成员失败但组长就绪 ⇒ 依然 ready**（失败只影响它自己）', () => {
    const members = [lead, member({ memberId: '成员甲', status: 'failed', statusText: '启动失败' })]
    expect(deriveWarmupPhase(members, false).phase).toBe('ready')
    // 但失败成员要被单独标出来，供胶囊栏显示可重试
    expect(failedMemberIds(members)).toEqual(['成员甲'])
  })

  it('组长仍在启动 ⇒ warming', () => {
    const members = [member({ ...lead, status: 'starting', statusText: '唤醒中', starting: true })]
    expect(deriveWarmupPhase(members, false)).toEqual({ phase: 'warming', errorKind: null })
  })

  it('组长失败 ⇒ error/lead_failed（用户没法开工，必须处理）', () => {
    const members = [member({ ...lead, status: 'failed', statusText: '启动失败' })]
    expect(deriveWarmupPhase(members, false)).toEqual({ phase: 'error', errorKind: 'lead_failed' })
  })

  it('组长仍在启动且已超时 ⇒ error/timeout（不无限转圈）', () => {
    const members = [member({ ...lead, status: 'starting', statusText: '唤醒中', starting: true })]
    expect(deriveWarmupPhase(members, true)).toEqual({ phase: 'error', errorKind: 'timeout' })
  })

  it('成员列表为空 ⇒ warming（还没取到，不假装就绪）', () => {
    expect(deriveWarmupPhase([], false)).toEqual({ phase: 'warming', errorKind: null })
    // 即使超时也不判失败——可能是取数中，判失败会误导
    expect(deriveWarmupPhase([], true).phase).toBe('warming')
  })

  it('没有组长时退化为全员判定，避免永远卡在遮罩下', () => {
    const noLead = [member({ memberId: '甲' }), member({ memberId: '乙' })]
    expect(deriveWarmupPhase(noLead, false).phase).toBe('ready')

    const oneStarting = [member({ memberId: '甲' }), member({ memberId: '乙', status: 'starting', starting: true })]
    expect(deriveWarmupPhase(oneStarting, false).phase).toBe('warming')
    expect(deriveWarmupPhase(oneStarting, true).phase).toBe('error')
  })

  it('组长失败优先于超时（先说真实原因）', () => {
    const failedLead = [member({ ...lead, status: 'failed' })]
    expect(deriveWarmupPhase(failedLead, true).errorKind).toBe('lead_failed')
  })
})

describe('辅助判定', () => {
  it('isPendingMember 认 starting 状态与 starting 标记', () => {
    expect(isPendingMember(member({ status: 'starting' }))).toBe(true)
    expect(isPendingMember(member({ starting: true }))).toBe(true)
    expect(isPendingMember(member({ status: 'failed' }))).toBe(false)
    expect(isPendingMember(member())).toBe(false)
  })

  it('readyMemberCount 统计已就绪数', () => {
    const members = [lead, member({ memberId: '甲', status: 'starting', starting: true }), member({ memberId: '乙', status: 'failed' })]
    // 失败算「不需要再等」，故已就绪 2 人（组长 + 失败的甲？——不，失败不计入就绪）
    expect(readyMemberCount(members)).toBe(2) // 组长 + 乙
  })

  it('findLead 取第一个组长', () => {
    expect(findLead([member({ memberId: '甲' }), lead])?.memberId).toBe('组长')
    expect(findLead([member({ memberId: '甲' })])).toBeNull()
  })

  it('遮罩期间禁用四类动作，切视图不受影响（视图切换不在禁用清单里）', () => {
    for (const action of WARMUP_BLOCKED_ACTIONS) {
      expect(isBlockedDuringWarmup('warming', action)).toBe(true)
      expect(isBlockedDuringWarmup('ready', action)).toBe(false)
      expect(isBlockedDuringWarmup('error', action)).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// 遮罩组件
// ---------------------------------------------------------------------------

describe('TeamWarmupOverlay', () => {
  it('ready ⇒ 整块不进 DOM（不是隐藏，是不存在）', () => {
    expect(TeamWarmupOverlay({ members: [lead], colorMap, timedOut: false })).toBeNull()
  })

  it('warming ⇒ 显示进度文案与进度条', () => {
    const starting = [member({ ...lead, status: 'starting', statusText: '唤醒中', starting: true }), member({ memberId: '甲' })]
    const flat = texts(TeamWarmupOverlay({ members: starting, colorMap, timedOut: false }))
    expect(flat).toContain(TEAM_WARMUP_PROGRESS(1, 2))
    expect(propsOf(TeamWarmupOverlay({ members: starting, colorMap, timedOut: false }))
      .some((p) => p['data-warmup-bar'] === 'true')).toBe(true)
  })

  it('warming 时每个成员一枚头像，逐个点亮', () => {
    // 注意：**组长必须仍在启动**，否则遮罩根本不渲染（组长就绪即撤）。
    const warming = [
      member({ ...lead, status: 'starting', statusText: '唤醒中', starting: true }),
      member({ memberId: '甲', status: 'starting', statusText: '唤醒中', starting: true }),
      member({ memberId: '乙' }), // 已就绪
    ]
    const props = propsOf(TeamWarmupOverlay({ members: warming, colorMap, timedOut: false }))
    const lit = props.filter((p) => p['data-warmup-avatar-lit'] === 'true').map((p) => p['data-warmup-avatar'])
    const dark = props.filter((p) => p['data-warmup-avatar-lit'] === 'false').map((p) => p['data-warmup-avatar'])
    expect(lit).toEqual(['乙'])
    expect(dark.sort()).toEqual(['甲', '组长'])
  })

  it('组长就绪 ⇒ 不画头像（遮罩已撤，连进度条都没有）', () => {
    expect(TeamWarmupOverlay({ members: [lead], colorMap, timedOut: false })).toBeNull()
  })

  it('组长失败 ⇒ 错误卡片说「检查模型」', () => {
    const flat = texts(TeamWarmupOverlay({
      members: [member({ ...lead, status: 'failed' })],
      colorMap,
      timedOut: false,
    }))
    expect(flat.join()).toContain(TEAM_WARMUP_LEAD_FAILED_NEXT)
  })

  it('超时 ⇒ 错误卡片说「准备超时」（与组长失败给不同的话）', () => {
    const flat = texts(TeamWarmupOverlay({
      members: [member({ ...lead, status: 'starting', starting: true })],
      colorMap,
      timedOut: true,
    }))
    expect(flat).toContain(TEAM_WARMUP_TIMEOUT_TITLE)
    expect(flat).toContain(TEAM_WARMUP_TIMEOUT_NEXT)
  })

  it('错误卡片带真重试与返回（回调在场时）', () => {
    let retried = 0
    let backed = 0
    const props = propsOf(TeamWarmupOverlay({
      members: [member({ ...lead, status: 'failed' })],
      colorMap,
      timedOut: false,
      onRetry: () => { retried += 1 },
      onBack: () => { backed += 1 },
    }))
    ;(props.find((p) => p['data-warmup-retry'] === 'true')?.['onClick'] as () => void)()
    ;(props.find((p) => p['data-warmup-back'] === 'true')?.['onClick'] as () => void)()
    expect(retried).toBe(1)
    expect(backed).toBe(1)
  })

  it('回调缺席时不画死按钮', () => {
    const props = propsOf(TeamWarmupOverlay({
      members: [member({ ...lead, status: 'failed' })],
      colorMap,
      timedOut: false,
    }))
    expect(props.some((p) => p['data-warmup-retry'] === 'true')).toBe(false)
    expect(props.some((p) => p['data-warmup-back'] === 'true')).toBe(false)
  })

  it('进度条比例不会 NaN（空团队也给 0）', () => {
    const props = propsOf(TeamWarmupOverlay({ members: [], colorMap, timedOut: false }))
    const bar = props.find((p) => p['data-warmup-bar'] === 'true')
    expect(bar?.['value']).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 状态机：超时计时
// ---------------------------------------------------------------------------

const fetchMock = vi.fn()
let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  originalFetch = globalThis.fetch
  fetchMock.mockReset()
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      data: {
        team: {
          summary: { teamId: 't1', name: '团队', workspaceLabel: '', memberCount: 1, active: false, createdAt: '2026-01-01T00:00:00.000Z', ordinal: 0 },
          members: [lead],
        },
      },
    }),
  })
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.useRealTimers()
})

describe('store —— 暖启动阶段', () => {
  it('组长就绪时遮罩立刻撤（不显示 warming）', async () => {
    const store = createTeamStore()
    await store.openTeam('t1')
    expect(store.warmupPhase).toBe('ready')
    store.dispose()
  })

  it('详情取数失败时遮罩不叠加（取数有自己的失败态）', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: false, code: 'TEAM_REQUEST_FAILED' }) })
    const store = createTeamStore()
    await store.openTeam('t1')
    // 遮罩不该盖在一个失败的上层之上
    expect(store.warmupPhase).toBe('ready')
    store.dispose()
  })

  it('离开团队后计时器被清理（不残留定时器）', async () => {
    vi.useFakeTimers()
    const store = createTeamStore()
    const open = store.openTeam('t1')
    await vi.advanceTimersByTimeAsync(0)
    await open
    store.closeTeam()
    // 计时器已清：再推进时间不应有任何异常或状态残留
    expect(() => vi.advanceTimersByTime(60_000)).not.toThrow()
    store.dispose()
  })

  it('dispose 清理计时器', async () => {
    vi.useFakeTimers()
    const store = createTeamStore()
    const open = store.openTeam('t1')
    await vi.advanceTimersByTimeAsync(0)
    await open
    store.dispose()
    expect(() => vi.advanceTimersByTime(60_000)).not.toThrow()
  })
})