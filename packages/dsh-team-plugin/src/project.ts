/**
 * [INPUT]: 依赖 `./contracts.ts` 的 DTO 与错误码；不依赖 Cordis，也不依赖 DSH 运行时。
 * [OUTPUT]: 宿主真实团队状态 → 对外 DTO 的**唯一投影真源**（纯函数，可单测）。
 * [POS]: Host 半的数据整形层。所有「状态怎么翻译成界面词」「谁算忙」的口径只允许写在这里。
 * [PROTOCOL]: 变更时更新此头部，然后检查 src/index.ts
 */

import type { TeamMemberStatus, TeamMemberView, TeamSummaryView } from './contracts.js'

/**
 * 宿主的原始成员事实。
 *
 * 这是本插件对「DSH 团队成员」的**唯一认知**：name 唯一、lead 唯一、其余为队友。
 * 刻意不引入手柄/会话 id——界面用不到，且多一个字段就多一处泄漏面。
 */
export interface RawMemberFact {
  readonly name: string
  readonly lead: boolean
  /** 是否有正在进行的回合。 */
  readonly busy: boolean
  /** 是否正在启动/唤醒。 */
  readonly starting: boolean
  /** 是否已失败。 */
  readonly failed: boolean
  /** 休眠（Dormant）：成员存在但未激活。 */
  readonly dormant: boolean
  /** 待用户确认的数量。 */
  readonly pendingCount: number
}

/** 宿主的原始团队事实。 */
export interface RawTeamFact {
  /** 团队标识。取 lead 会话 id，团队内稳定。 */
  readonly id: string
  readonly name: string
  /** 工作区显示名（已由 Host 取绝对路径的 basename，不下发绝对路径）。 */
  readonly workspaceLabel: string
  readonly createdAtMs: number
  readonly lastActiveMs: number
  readonly members: readonly RawMemberFact[]
}

/** 状态词表：**唯一**一份。界面直接用 Host 给的词，不再自己翻译（避免两处措辞不一致）。 */
const STATUS_TEXT: Readonly<Record<TeamMemberStatus, string>> = {
  idle: '空闲',
  active: '工作中',
  starting: '唤醒中',
  failed: '启动失败',
  dormant: '休眠',
}

/**
 * 由原始事实派生成员状态。
 *
 * 判定顺序即优先级：**失败 > 启动中 > 忙 > 休眠 > 空闲**。
 * 失败排最前，因为「启动失败」是需要用户立刻看见并处理的状态。
 */
export function deriveMemberStatus(fact: RawMemberFact): TeamMemberStatus {
  if (fact.failed) return 'failed'
  if (fact.starting) return 'starting'
  if (fact.busy) return 'active'
  if (fact.dormant) return 'dormant'
  return 'idle'
}

/** 单个成员事实 → 对外 DTO。 */
export function projectMember(fact: RawMemberFact): TeamMemberView {
  const status = deriveMemberStatus(fact)
  return {
    memberId: fact.name,
    role: fact.lead ? 'lead' : 'teammate',
    status,
    statusText: STATUS_TEXT[status],
    pendingCount: fact.pendingCount,
    starting: fact.starting,
  }
}

/**
 * 成员排序：**lead 恒首位**，其余**保持传入顺序**。
 *
 * 为什么不用字母序：宿主 `listMembers()` 明确按「创建顺序」返回行，而字母序会毁掉用户的编排意图
 * （先建的成员本就该排前面）。而且中文名的 `localeCompare` 走 ICU 笔画序（实测「成员乙」排在
 * 「成员甲」前），既不符合直觉又依赖运行时 ICU 版本，跨机器可能不一致。
 *
 * 因此这里只做一件事：把 lead 提到最前，其余原序保留。数组 sort 稳定 ⇒ 同输入必同输出。
 */
export function sortMembers(facts: readonly RawMemberFact[]): RawMemberFact[] {
  const lead = facts.find((fact) => fact.lead)
  if (!lead) return [...facts]
  const rest = facts.filter((fact) => !fact.lead)
  return [lead, ...rest]
}

/** 团队是否「有活动」：任一成员忙碌或启动中。 */
export function isTeamActive(facts: readonly RawMemberFact[]): boolean {
  return facts.some((fact) => fact.busy || fact.starting)
}

/** 排序权重：最近活跃的排前面。用毫秒时间戳直接比较，避免引入额外状态。 */
export function ordinalOf(fact: RawTeamFact): number {
  return Math.max(fact.lastActiveMs, fact.createdAtMs)
}

/** 团队事实 → 列表 DTO。 */
export function projectSummary(fact: RawTeamFact): TeamSummaryView {
  return {
    teamId: fact.id,
    name: fact.name,
    workspaceLabel: fact.workspaceLabel,
    memberCount: fact.members.length,
    active: isTeamActive(fact.members),
    createdAt: new Date(fact.createdAtMs).toISOString(),
    ordinal: ordinalOf(fact),
  }
}

/**
 * 团队列表 → DTO 列表，按 ordinal 降序（最近活跃在前）。
 *
 * 同 ordinal 时**按传入顺序**兜底，不做字母序——理由同 `sortMembers`：
 * 字母序会依赖 ICU 版本，且与「最近活跃优先」的真实意图无关。
 * 传入顺序稳定 ⇒ 输出稳定，不会闪烁。
 */
export function projectTeamList(facts: readonly RawTeamFact[]): TeamSummaryView[] {
  return facts
    .map(projectSummary)
    .map((summary, index) => ({ summary, index }))
    .sort((a, b) =>
      b.summary.ordinal !== a.summary.ordinal ? b.summary.ordinal - a.summary.ordinal : a.index - b.index,
    )
    .map((entry) => entry.summary)
}