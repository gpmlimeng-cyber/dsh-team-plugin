/**
 * [INPUT]: 依赖无（纯逻辑）。数据来源是 Host 半自己投影出的脱敏视图，绝不直接透传会话日志。
 * [OUTPUT]: 本插件唯一的 DTO 真源 + 严格解码内核 + 稳定错误码；供 Host 与 Client 共用。
 * [POS]: 取数契约层。凡是「什么算畸形」的判定只允许出现在本文件，避免多处各写一份键集规则后分叉。
 * [PROTOCOL]: 变更时更新此头部，然后检查 src/index.ts
 *
 * 设计纪律（照搬 dshent 的 local-api-decode 口径）：
 * 1. **键集封闭**：对象键必须恰好匹配白名单，多一个键即判畸形——防止宿主将来多塞字段把内部结构漏到界面。
 * 2. **令牌与路径进不来**：本层不接收任何 token、绝对路径或可执行位置。
 * 3. **失败只交错误码**，绝不 throw 给界面，也绝不把原始响应体回显。
 */

/** 本插件唯一的错误码真源。界面据此映射人话与「下一步」。 */
export const TEAM_ERROR_CODES = [
  /** 取数请求失败（网络/宿主未接线）。可重试。 */
  'TEAM_REQUEST_FAILED',
  /** 响应结构不符合契约。属结构性失败，重试无意义。 */
  'TEAM_RESPONSE_INVALID',
  /** 宿主侧尚无团队能力（agentTeams 未就绪）。 */
  'TEAM_UNSUPPORTED',
] as const

export type TeamErrorCode = (typeof TEAM_ERROR_CODES)[number]

/** 可重试的错误码；终态码不给假重试按钮。 */
export const TEAM_RETRYABLE_CODES: ReadonlySet<TeamErrorCode> = new Set<TeamErrorCode>(['TEAM_REQUEST_FAILED'])

export function isRetryableTeamError(code: TeamErrorCode): boolean {
  return TEAM_RETRYABLE_CODES.has(code)
}

/** 解码失败时抛出的唯一错误类型：只带稳定码，不带原始响应体。 */
export class TeamDecodeError extends Error {
  readonly code: TeamErrorCode

  constructor(code: TeamErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'TeamDecodeError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// 原始守卫（叶子层：无 DTO、无 fetch、无 React）
// ---------------------------------------------------------------------------

/**
 * 判定一个值是否为「恰好由 keys 构成的对象」。
 * null、数组、Date 等一律不算对象——这是最常见的解码漏洞来源。
 */
export function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const actual = Object.keys(value as Record<string, unknown>)
  if (actual.length !== keys.length) return false
  const allowed = new Set(keys)
  return actual.every((key) => allowed.has(key))
}

/** 非空字符串。 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** 长度为 0..max 的字符串（允许空串，用于可选描述类字段）。 */
export function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}

/** 安全整数范围内的计数。 */
export function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** RFC 3339 时间戳（带时区）。 */
export function isRfc3339(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && /(?:Z|[+-]\d{2}:?\d{2})$/.test(value)
}

/** 可空时间戳：键必须在，值可以是 null。 */
export function isNullableRfc3339(value: unknown): value is string | null {
  return value === null || isRfc3339(value)
}

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

/**
 * 成员实例（对齐 AionUi 的 slot 概念）。
 *
 * `memberId` 是**展示与寻址用的稳定标识**：DSH 侧 teammate 以 name 寻址，故这里用 name。
 * 不下发任何会话 id、slot id 或内部句柄——界面不需要，且泄漏它们没有收益。
 */
export interface TeamMemberView {
  /** 成员名（DSH teammate name，团队内唯一且稳定）。 */
  readonly memberId: string
  /** 角色：lead 是唯一的组长，teammate 是普通成员。 */
  readonly role: 'lead' | 'teammate'
  /** 归一化后的展示状态。 */
  readonly status: TeamMemberStatus
  /** 状态的人话描述（由 Host 投影时定稿，界面直接显示，不自己再翻译一遍）。 */
  readonly statusText: string
  /** 待用户确认的数量；0 表示没有。 */
  readonly pendingCount: number
  /** 是否处于启动中（界面据此显示「唤醒中」）。 */
  readonly starting: boolean
}

/** 成员状态。刻意收窄成 5 态，够界面表达又不泄漏运行时细节。 */
export type TeamMemberStatus = 'idle' | 'active' | 'starting' | 'failed' | 'dormant'

export const TEAM_MEMBER_STATUSES: readonly TeamMemberStatus[] = ['idle', 'active', 'starting', 'failed', 'dormant']

/**
 * 团队列表项。
 *
 * 注意：**不含成员数组**——列表页不渲染成员栏，没必要下发。
 * 成员只在进入某个团队详情时单独取（渐进加载）。
 */
export interface TeamSummaryView {
  readonly teamId: string
  readonly name: string
  /** 工作区显示名（目录名），空串表示未选择工作区。 */
  readonly workspaceLabel: string
  /** 成员数（含 lead）。 */
  readonly memberCount: number
  /** 是否已有成员在忙（侧栏可据此显示运行态提示）。 */
  readonly active: boolean
  /** 创建时间（RFC 3339）。 */
  readonly createdAt: string
  /** 排序用权重：最近活跃的排前面。 */
  readonly ordinal: number
}

/** 团队详情：摘要 + 成员列表。 */
export interface TeamDetailView {
  readonly summary: TeamSummaryView
  readonly members: readonly TeamMemberView[]
}

// ---------------------------------------------------------------------------
// 严格解码
// ---------------------------------------------------------------------------

const MEMBER_KEYS = ['memberId', 'role', 'status', 'statusText', 'pendingCount', 'starting'] as const
const SUMMARY_KEYS = ['teamId', 'name', 'workspaceLabel', 'memberCount', 'active', 'createdAt', 'ordinal'] as const

const MEMBER_ID_MAX = 64
const NAME_MAX = 120
const WORKSPACE_LABEL_MAX = 256
const STATUS_TEXT_MAX = 32

function fail(): never {
  throw new TeamDecodeError('TEAM_RESPONSE_INVALID')
}

export function decodeTeamMember(value: unknown): TeamMemberView {
  if (!hasExactKeys(value, MEMBER_KEYS)) fail()
  const record = value as Record<string, unknown>

  if (!isNonEmptyString(record['memberId']) || record['memberId'].length > MEMBER_ID_MAX) fail()
  if (record['role'] !== 'lead' && record['role'] !== 'teammate') fail()
  const status = record['status']
  if (!isNonEmptyString(status) || !TEAM_MEMBER_STATUSES.includes(status as TeamMemberStatus)) fail()
  if (!isBoundedString(record['statusText'], STATUS_TEXT_MAX)) fail()
  if (!isSafeCount(record['pendingCount'])) fail()
  if (typeof record['starting'] !== 'boolean') fail()

  return {
    memberId: record['memberId'],
    role: record['role'],
    status: status as TeamMemberStatus,
    statusText: record['statusText'],
    pendingCount: record['pendingCount'],
    starting: record['starting'],
  }
}

export function decodeTeamSummary(value: unknown): TeamSummaryView {
  if (!hasExactKeys(value, SUMMARY_KEYS)) fail()
  const record = value as Record<string, unknown>

  if (!isNonEmptyString(record['teamId']) || record['teamId'].length > MEMBER_ID_MAX) fail()
  if (!isNonEmptyString(record['name']) || record['name'].length > NAME_MAX) fail()
  if (!isBoundedString(record['workspaceLabel'], WORKSPACE_LABEL_MAX)) fail()
  if (!isSafeCount(record['memberCount'])) fail()
  if (typeof record['active'] !== 'boolean') fail()
  if (!isRfc3339(record['createdAt'])) fail()
  if (!isSafeCount(record['ordinal'])) fail()

  return {
    teamId: record['teamId'],
    name: record['name'],
    workspaceLabel: record['workspaceLabel'],
    memberCount: record['memberCount'],
    active: record['active'],
    createdAt: record['createdAt'],
    ordinal: record['ordinal'],
  }
}

/** 团队列表响应：键恰为 `{ teams }`。 */
export function decodeTeamListResponse(value: unknown): TeamSummaryView[] {
  if (!hasExactKeys(value, ['teams'])) fail()
  const raw = (value as Record<string, unknown>)['teams']
  if (!Array.isArray(raw)) fail()
  return raw.map(decodeTeamSummary)
}

/** 团队详情的 `team` 位：**可为 null**，表示「该团队已不存在」（不是失败）。 */
export type TeamDetailPayload = { readonly team: TeamDetailView | null }

/** 团队详情响应：键恰为 `{ team }`。 */
export function decodeTeamDetailResponse(value: unknown): TeamDetailPayload {
  if (!hasExactKeys(value, ['team'])) fail()
  const team = (value as Record<string, unknown>)['team']
  // null 是合法结果：团队可能刚被解散。
  if (team === null) return { team: null }
  if (!hasExactKeys(team, ['summary', 'members'])) fail()
  const record = team as Record<string, unknown>
  const members = record['members']
  if (!Array.isArray(members)) fail()
  return {
    team: {
      summary: decodeTeamSummary(record['summary']),
      members: members.map(decodeTeamMember),
    },
  }
}
// ---------------------------------------------------------------------------
// 活动（看板）契约
// ---------------------------------------------------------------------------

/**
 * 成员间消息的对外投影。
 *
 * 刻意**不下发**任何宿主内部标识（会话 id、slot id、句柄）：界面按成员名上屏就够了，
 * 多一个字段就多一处泄漏面。
 */
export interface TeamActivityMessageView {
  /** 消息 id（团队内唯一、对外稳定，仅用于 DOM key 与列表定位）。 */
  readonly messageId: string
  readonly from: string
  /** 收件成员名；`user` = 发给用户；`*` = 广播。 */
  readonly to: string
  readonly content: string
  readonly summary: string
  /** 是否系统消息（心跳、空闲通知等）。 */
  readonly system: boolean
  /** 毫秒时间戳。 */
  readonly createdAtMs: number
}

/** 任务的对外投影。 */
export interface TeamActivityTaskView {
  readonly taskId: string
  readonly subject: string
  readonly description: string
  readonly status: string
  /** 负责成员名；空串 = 未指派。 */
  readonly owner: string
  /** 依赖的任务 id（来自 blockedBy）。 */
  readonly blockedBy: readonly string[]
  readonly createdAtMs: number
}

/** 活动响应：键恰为 `{ messages, tasks }`。 */
export interface TeamActivityPayload {
  readonly messages: readonly TeamActivityMessageView[]
  readonly tasks: readonly TeamActivityTaskView[]
}

const MESSAGE_KEYS = ['messageId', 'from', 'to', 'content', 'summary', 'system', 'createdAtMs'] as const
const TASK_KEYS = ['taskId', 'subject', 'description', 'status', 'owner', 'blockedBy', 'createdAtMs'] as const

const MESSAGE_CONTENT_MAX = 8192
const SUMMARY_MAX = 512
const SUBJECT_MAX = 512
const DESCRIPTION_MAX = 8192
const STATUS_MAX = 32
const BLOCKED_BY_MAX = 64

/** 毫秒时间戳：有限非负整数（0 合法，便于测试）。 */
function isTimestampMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function decodeActivityMessage(value: unknown): TeamActivityMessageView {
  if (!hasExactKeys(value, MESSAGE_KEYS)) fail()
  const record = value as Record<string, unknown>

  if (!isNonEmptyString(record['messageId']) || record['messageId'].length > MEMBER_ID_MAX) fail()
  if (!isBoundedString(record['from'], MEMBER_ID_MAX)) fail()
  // `to` 允许空串（未知收件人）与 `*` / `user` 两个特殊值，故只校验长度
  if (!isBoundedString(record['to'], MEMBER_ID_MAX)) fail()
  if (!isBoundedString(record['content'], MESSAGE_CONTENT_MAX)) fail()
  if (!isBoundedString(record['summary'], SUMMARY_MAX)) fail()
  if (typeof record['system'] !== 'boolean') fail()
  if (!isTimestampMs(record['createdAtMs'])) fail()

  return {
    messageId: record['messageId'],
    from: record['from'],
    to: record['to'],
    content: record['content'],
    summary: record['summary'],
    system: record['system'],
    createdAtMs: record['createdAtMs'],
  }
}

export function decodeActivityTask(value: unknown): TeamActivityTaskView {
  if (!hasExactKeys(value, TASK_KEYS)) fail()
  const record = value as Record<string, unknown>

  if (!isNonEmptyString(record['taskId']) || record['taskId'].length > MEMBER_ID_MAX) fail()
  if (!isBoundedString(record['subject'], SUBJECT_MAX)) fail()
  if (!isBoundedString(record['description'], DESCRIPTION_MAX)) fail()
  if (!isBoundedString(record['status'], STATUS_MAX)) fail()
  if (!isBoundedString(record['owner'], MEMBER_ID_MAX)) fail()
  if (!isTimestampMs(record['createdAtMs'])) fail()

  const blockedBy = record['blockedBy']
  if (!Array.isArray(blockedBy)) fail()
  if (blockedBy.length > BLOCKED_BY_MAX) fail()
  for (const id of blockedBy) {
    if (!isNonEmptyString(id) || id.length > MEMBER_ID_MAX) fail()
  }

  return {
    taskId: record['taskId'],
    subject: record['subject'],
    description: record['description'],
    status: record['status'],
    owner: record['owner'],
    blockedBy: [...blockedBy] as string[],
    createdAtMs: record['createdAtMs'],
  }
}

/** 活动响应解码。空数组合法（团队还没活动）。 */
export function decodeTeamActivityResponse(value: unknown): TeamActivityPayload {
  if (!hasExactKeys(value, ['messages', 'tasks'])) fail()
  const record = value as Record<string, unknown>
  const messages = record['messages']
  const tasks = record['tasks']
  if (!Array.isArray(messages)) fail()
  if (!Array.isArray(tasks)) fail()
  return {
    messages: messages.map(decodeActivityMessage),
    tasks: tasks.map(decodeActivityTask),
  }
}
