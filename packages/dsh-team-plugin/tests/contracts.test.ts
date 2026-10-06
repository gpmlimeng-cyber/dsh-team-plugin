/**
 * [INPUT]: 依赖 src/contracts.ts 与 src/project.ts（纯逻辑，无网络无 React）。
 * [OUTPUT]: 门禁用例——锁住「界面体验所依赖的口径」：键集封闭、状态派生优先级、lead 恒首位。
 * [POS]: 本包的机械门禁；改动投影或解码规则时必须先改这里的期望。
 * [PROTOCOL]: 变更时更新此头部，然后检查 src/project.ts
 */

import { describe, expect, it } from 'vitest'

import {
  TeamDecodeError,
  decodeTeamDetailResponse,
  decodeTeamListResponse,
  decodeTeamMember,
  decodeTeamSummary,
  hasExactKeys,
  isRetryableTeamError,
  TEAM_ERROR_CODES,
} from '../src/contracts.js'
import {
  deriveMemberStatus,
  isTeamActive,
  projectMember,
  projectTeamList,
  sortMembers,
  type RawMemberFact,
  type RawTeamFact,
} from '../src/project.js'

const member = (over: Partial<RawMemberFact> = {}): RawMemberFact => ({
  name: '成员A',
  lead: false,
  busy: false,
  starting: false,
  failed: false,
  dormant: false,
  pendingCount: 0,
  ...over,
})

const team = (over: Partial<RawTeamFact> = {}): RawTeamFact => ({
  id: 't1',
  name: '我的团队',
  workspaceLabel: 'project',
  createdAtMs: Date.parse('2026-01-01T00:00:00.000Z'),
  lastActiveMs: Date.parse('2026-01-02T00:00:00.000Z'),
  members: [member({ name: '组长', lead: true }), member({ name: '成员A' })],
  ...over,
})

describe('hasExactKeys — 键集封闭是本层的安全底线', () => {
  it('恰好匹配时为真', () => {
    expect(hasExactKeys({ a: 1, b: 2 }, ['a', 'b'])).toBe(true)
  })

  it('多出一个键即判假（防宿主把内部字段漏给界面）', () => {
    expect(hasExactKeys({ a: 1, b: 2, secret: 3 }, ['a', 'b'])).toBe(false)
  })

  it('少一个键即判假', () => {
    expect(hasExactKeys({ a: 1 }, ['a', 'b'])).toBe(false)
  })

  it('null / 数组 / 原始值都不是对象', () => {
    expect(hasExactKeys(null, [])).toBe(false)
    expect(hasExactKeys([], [])).toBe(false)
    expect(hasExactKeys('x', [])).toBe(false)
  })
})

describe('deriveMemberStatus — 失败优先于一切', () => {
  it('失败盖过启动中与忙碌（用户必须先看见失败）', () => {
    expect(deriveMemberStatus(member({ failed: true, starting: true, busy: true }))).toBe('failed')
  })

  it('启动中盖过忙碌', () => {
    expect(deriveMemberStatus(member({ starting: true, busy: true }))).toBe('starting')
  })

  it('忙碌优先于休眠', () => {
    expect(deriveMemberStatus(member({ busy: true, dormant: true }))).toBe('active')
  })

  it('全静默即空闲', () => {
    expect(deriveMemberStatus(member())).toBe('idle')
  })
})

describe('projectMember — 对外 DTO 不泄漏内部句柄', () => {
  it('角色与状态词由 Host 定稿', () => {
    const view = projectMember(member({ name: '组长', lead: true, busy: true }))
    expect(view.role).toBe('lead')
    expect(view.status).toBe('active')
    expect(view.statusText).toBe('工作中')
    expect(view.memberId).toBe('组长')
  })

  it('启动中时 starting 与状态自洽（界面据此显示「唤醒中」）', () => {
    const view = projectMember(member({ starting: true }))
    expect(view.starting).toBe(true)
    expect(view.status).toBe('starting')
  })

  it('成员 DTO 的键集恰好六个', () => {
    expect(Object.keys(projectMember(member())).sort()).toEqual([
      'memberId',
      'pendingCount',
      'role',
      'starting',
      'status',
      'statusText',
    ])
  })
})

describe('sortMembers — lead 恒首位，其余保持宿主返回顺序', () => {
  it('无论传入顺序如何，lead 都在第一个', () => {
    const sorted = sortMembers([member({ name: '成员Z' }), member({ name: '组长', lead: true }), member({ name: '成员A' })])
    expect(sorted[0]?.lead).toBe(true)
    expect(sorted[0]?.name).toBe('组长')
  })

  it('非 lead 保持传入顺序（宿主按创建序返回，字母序会毁掉编排意图）', () => {
    const sorted = sortMembers([member({ name: '成员C' }), member({ name: '组长', lead: true }), member({ name: '成员A' })])
    expect(sorted.map((m) => m.name)).toEqual(['组长', '成员C', '成员A'])
  })

  it('无 lead 时原样返回（不排序、不丢成员）', () => {
    const sorted = sortMembers([member({ name: '乙' }), member({ name: '甲' })])
    expect(sorted.map((m) => m.name)).toEqual(['乙', '甲'])
  })
})

describe('projectTeamList — 最近活跃的排前面且顺序确定', () => {
  it('按 ordinal 降序', () => {
    // ordinal 取 max(lastActive, createdAt)，故两个样本的三个时间都必须落在同一量级内比较。
    const base = Date.parse('2026-01-01T00:00:00.000Z')
    const older = team({ id: 'old', createdAtMs: base, lastActiveMs: base + 1_000 })
    const newer = team({ id: 'new', createdAtMs: base, lastActiveMs: base + 9_000 })
    expect(projectTeamList([older, newer]).map((t) => t.teamId)).toEqual(['new', 'old'])
  })

  it('同 ordinal 时保持传入顺序（不依赖 ICU 字母序，跨机器一致）', () => {
    const a = team({ id: 'aaa' })
    const b = team({ id: 'bbb' })
    expect(projectTeamList([a, b]).map((t) => t.teamId)).toEqual(['aaa', 'bbb'])
    expect(projectTeamList([b, a]).map((t) => t.teamId)).toEqual(['bbb', 'aaa'])
  })

  it('memberCount 计入 lead', () => {
    expect(projectTeamList([team()])[0]?.memberCount).toBe(2)
  })

  it('任一成员忙即视为团队活跃', () => {
    expect(projectTeamList([team({ members: [member({ lead: true })] })])[0]?.active).toBe(false)
    expect(projectTeamList([team({ members: [member({ busy: true })] })])[0]?.active).toBe(true)
  })
})

describe('isTeamActive', () => {
  it('空团队不活跃', () => {
    expect(isTeamActive([])).toBe(false)
  })
})

describe('严格解码 — 畸形输入一律 TEAM_RESPONSE_INVALID', () => {
  it('成员缺字段判畸形', () => {
    expect(() => decodeTeamMember({ memberId: 'a' })).toThrow(TeamDecodeError)
  })

  it('成员多出未知字段判畸形', () => {
    expect(() =>
      decodeTeamMember({
        memberId: 'a',
        role: 'lead',
        status: 'idle',
        statusText: '空闲',
        pendingCount: 0,
        starting: false,
        leaked: '不该出现',
      }),
    ).toThrow(TeamDecodeError)
  })

  it('非法状态枚举判畸形', () => {
    expect(() =>
      decodeTeamMember({
        memberId: 'a',
        role: 'lead',
        status: 'confused',
        statusText: '?',
        pendingCount: 0,
        starting: false,
      }),
    ).toThrow(TeamDecodeError)
  })

  it('负数计数判畸形', () => {
    expect(() =>
      decodeTeamMember({
        memberId: 'a',
        role: 'lead',
        status: 'idle',
        statusText: '空闲',
        pendingCount: -1,
        starting: false,
      }),
    ).toThrow(TeamDecodeError)
  })

  it('非法时间戳判畸形', () => {
    expect(() =>
      decodeTeamSummary({
        teamId: 't',
        name: 'n',
        workspaceLabel: '',
        memberCount: 1,
        active: false,
        createdAt: '2026/01/01',
        ordinal: 0,
      }),
    ).toThrow(TeamDecodeError)
  })

  it('列表响应键集封闭', () => {
    expect(decodeTeamListResponse({ teams: [] })).toEqual([])
    expect(() => decodeTeamListResponse({ teams: [], extra: 1 })).toThrow(TeamDecodeError)
  })

  it('详情响应解出摘要与成员', () => {
    const detail = decodeTeamDetailResponse({
      team: {
        summary: {
          teamId: 't1',
          name: '团队',
          workspaceLabel: 'proj',
          memberCount: 1,
          active: false,
          createdAt: '2026-01-01T00:00:00.000Z',
          ordinal: 0,
        },
        members: [
          {
            memberId: '组长',
            role: 'lead',
            status: 'idle',
            statusText: '空闲',
            pendingCount: 0,
            starting: false,
          },
        ],
      },
    })
    expect(detail.team?.summary.teamId).toBe('t1')
    expect(detail.team?.members).toHaveLength(1)
  })

  it('详情 team 位可为 null（团队已解散，不是失败）', () => {
    expect(decodeTeamDetailResponse({ team: null })).toEqual({ team: null })
  })
})

describe('错误码契约', () => {
  it('失败可重试、契约错误为终态（不给假重试）', () => {
    expect(isRetryableTeamError('TEAM_REQUEST_FAILED')).toBe(true)
    expect(isRetryableTeamError('TEAM_RESPONSE_INVALID')).toBe(false)
    expect(isRetryableTeamError('TEAM_UNSUPPORTED')).toBe(false)
  })

  it('错误码集合稳定', () => {
    expect([...TEAM_ERROR_CODES]).toEqual(['TEAM_REQUEST_FAILED', 'TEAM_RESPONSE_INVALID', 'TEAM_UNSUPPORTED'])
  })
})