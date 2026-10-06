/**
 * [INPUT]: 依赖 `./contracts.ts`（仅错误码类型）。无 React、无存储、无 DOM。
 * [OUTPUT]: 活动看板的**唯一真源**：看板数据模型 + 泳道归属规则 + 过滤/排序（纯函数，可单测）。
 * [POS]: E5 的规则层。泳道逻辑是纯函数——可完整测试，不引渲染环境。
 * [PROTOCOL]: 变更时更新此头部，然后检查 src/board.tsx
 *
 * 【看板是什么】每成员一条泳道（列），把「成员间的消息」与「任务」混排在同一条时间线上，
 * 让用户一眼纵览全局——这是并行对话视图做不到的事。
 *
 * 【泳道归属规则 —— 核心不变量：一个条目都不许丢】
 * - 消息 → 落在**收件人**的泳道
 * - 广播消息（发给全员）没有单一收件人 → 落在**发送者**的泳道
 * - 任务 → 落在 **owner（负责人）**的泳道
 * - 无法归属（发给用户 / 指向已移除的成员 / 未指派）→ **fallback 泳道**
 *
 * 最后一条最容易被忽略：如果没有 fallback，发给用户的消息或未指派的任务就会**凭空消失**，
 * 用户会以为系统丢数据。
 *
 * 移植自 AionUi（Apache-2.0）：`renderer/pages/team/activity/activityTypes.ts`
 */

/** fallback 泳道 id（无法归属的条目落这里）。 */
export const ACTIVITY_FALLBACK_LANE = '__activity_fallback__'

/** 「用户」这个合成身份（发给用户的消息不是发给某个成员的）。 */
export const ACTIVITY_USER_IDENTITY = 'user'

/** 广播目标标记。 */
export const ACTIVITY_BROADCAST_TARGET = '*'

/** 排序方向。`desc` = 新→旧（默认，与 AionUi 一致）。 */
export type ActivitySortDirection = 'desc' | 'asc'

/** 内容过滤。 */
export type ActivityContentFilter = 'all' | 'messages' | 'tasks'

/** 成员间消息（对外投影，不含任何宿主内部标识）。 */
export interface ActivityMessage {
  readonly id: string
  /** 发送者成员名。 */
  readonly from: string
  /** 收件者成员名；`user` = 发给用户；`*` = 广播。 */
  readonly to: string
  readonly content: string
  readonly summary: string
  /** 系统消息（心跳、空闲通知等），默认隐藏。 */
  readonly system: boolean
  readonly createdAt: number
}

/** 任务卡（对外投影）。 */
export interface ActivityTask {
  readonly id: string
  readonly subject: string
  readonly description: string
  readonly status: string
  /** 负责人成员名；空串 = 未指派。 */
  readonly owner: string
  /** 依赖的任务 id 列表（来自 blockedBy）。 */
  readonly blockedBy: readonly string[]
  readonly createdAt: number
}

/** 一条统一的活动条目：消息或任务。 */
export type ActivityItem =
  | { readonly kind: 'message'; readonly id: string; readonly laneId: string; readonly createdAt: number; readonly message: ActivityMessage }
  | { readonly kind: 'task'; readonly id: string; readonly laneId: string; readonly createdAt: number; readonly task: ActivityTask }

/** 泳道（列）。 */
export interface ActivityLane {
  readonly laneId: string
  readonly name: string
  readonly color: string
  readonly isFallback: boolean
}

// ---------------------------------------------------------------------------
// 归属规则
// ---------------------------------------------------------------------------

/** 消息是否广播。 */
export function isBroadcastMessage(message: ActivityMessage): boolean {
  return message.to === ACTIVITY_BROADCAST_TARGET
}

/**
 * 消息落在哪条泳道：收件人；广播则是发送者；无法归属则 fallback。
 *
 * @param knownMembers - 队伍里真实存在的成员 id 集合
 */
export function resolveMessageLane(message: ActivityMessage, knownMembers: ReadonlySet<string>): string {
  const target = isBroadcastMessage(message) ? message.from : message.to
  if (target && target !== ACTIVITY_USER_IDENTITY && knownMembers.has(target)) {
    return target
  }
  return ACTIVITY_FALLBACK_LANE
}

/** 任务落在哪条泳道：owner；未指派或指向已移除成员则 fallback。 */
export function resolveTaskLane(task: ActivityTask, knownMembers: ReadonlySet<string>): string {
  const owner = task.owner
  if (owner && owner !== ACTIVITY_USER_IDENTITY && knownMembers.has(owner)) {
    return owner
  }
  return ACTIVITY_FALLBACK_LANE
}

/** 消息 → 条目。 */
export function messageToItem(message: ActivityMessage, knownMembers: ReadonlySet<string>): ActivityItem {
  return {
    kind: 'message',
    id: message.id,
    laneId: resolveMessageLane(message, knownMembers),
    createdAt: message.createdAt,
    message,
  }
}

/** 任务 → 条目。 */
export function taskToItem(task: ActivityTask, knownMembers: ReadonlySet<string>): ActivityItem {
  return {
    kind: 'task',
    id: task.id,
    laneId: resolveTaskLane(task, knownMembers),
    createdAt: task.createdAt,
    task,
  }
}

/**
 * 合并消息与任务，按时间排序。
 *
 * 同时间时**按 id 兜底**保证确定性——否则同刻到达的两条会随机换位，用户会以为界面在闪。
 */
export function sortActivityItems(items: readonly ActivityItem[], direction: ActivitySortDirection): ActivityItem[] {
  const factor = direction === 'asc' ? 1 : -1
  return [...items].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return (a.createdAt - b.createdAt) * factor
    return a.id < b.id ? -factor : a.id > b.id ? factor : 0
  })
}

/** 是否为终态任务（默认隐藏）。 */
export function isTerminalTaskStatus(status: string): boolean {
  return status === 'completed' || status === 'deleted'
}

// ---------------------------------------------------------------------------
// 过滤
// ---------------------------------------------------------------------------

/** 控制条的全部状态。 */
export interface ActivityControls {
  readonly sortDirection: ActivitySortDirection
  readonly contentFilter: ActivityContentFilter
  /** 选中的成员 id；空 = 全员。 */
  readonly selectedMembers: readonly string[]
  readonly showSystemMessages: boolean
  readonly showTerminalTasks: boolean
}

export const DEFAULT_ACTIVITY_CONTROLS: ActivityControls = {
  sortDirection: 'desc',
  contentFilter: 'all',
  selectedMembers: [],
  // 默认收起噪音：系统消息与已完成任务是绝大多数场景不需要的
  showSystemMessages: false,
  showTerminalTasks: false,
}

/**
 * 应用控制条过滤。
 *
 * 顺序无讲究，但**每条都独立**：某个判据不通过就淘汰，不做"攒够条件再淘汰"。
 */
export function filterActivityItems(
  items: readonly ActivityItem[],
  controls: ActivityControls,
): ActivityItem[] {
  const selected = new Set(controls.selectedMembers)
  return items.filter((item) => {
    if (controls.contentFilter === 'messages' && item.kind !== 'message') return false
    if (controls.contentFilter === 'tasks' && item.kind !== 'task') return false
    if (item.kind === 'message' && !controls.showSystemMessages && item.message.system) return false
    if (item.kind === 'task' && !controls.showTerminalTasks && isTerminalTaskStatus(item.task.status)) return false
    // 选中成员为空 = 全员；选中后 fallback 泳道也要能被单独筛出
    if (selected.size > 0 && !selected.has(item.laneId)) return false
    return true
  })
}

/** 一次性做完：归属 → 合并 → 排序 → 过滤。 */
export function buildActivityItems(input: {
  readonly messages: readonly ActivityMessage[]
  readonly tasks: readonly ActivityTask[]
  readonly knownMembers: ReadonlySet<string>
  readonly controls: ActivityControls
}): ActivityItem[] {
  const merged: ActivityItem[] = [
    ...input.messages.map((message) => messageToItem(message, input.knownMembers)),
    ...input.tasks.map((task) => taskToItem(task, input.knownMembers)),
  ]
  return sortActivityItems(filterActivityItems(merged, input.controls), input.controls.sortDirection)
}

/**
 * 该不该**画出** fallback 泳道。
 *
 * 规则：**过滤后确实有条目落在 fallback** 才画。否则看板右侧会出现一列空的"未分配"，
 * 让人以为系统有数据没显示出来。
 */
export function shouldShowFallbackLane(items: readonly ActivityItem[]): boolean {
  return items.some((item) => item.laneId === ACTIVITY_FALLBACK_LANE)
}

/**
 * 构造泳道列表（成员列 + 可选 fallback 列）。
 *
 * @param memberLanes - 成员泳道（调用方给，已按选中状态过滤）
 * @param items - **已过滤**的条目，用于决定 fallback 要不要画
 */
export function buildLanes(
  memberLanes: readonly ActivityLane[],
  items: readonly ActivityItem[],
): ActivityLane[] {
  if (!shouldShowFallbackLane(items)) return [...memberLanes]
  return [
    ...memberLanes,
    { laneId: ACTIVITY_FALLBACK_LANE, name: '未分配 / 外部', color: 'var(--color-text-tertiary, #888)', isFallback: true },
  ]
}
// ---------------------------------------------------------------------------
// Host DTO → 看板模型
// ---------------------------------------------------------------------------

/**
 * 把 Host 的对外 DTO 翻译成看板内部模型。
 *
 * 这是**唯一**的翻译口：时间戳单位转换（ms → 数字直接用）、任务状态字段名对齐等
 * 都只在这里发生一次，下游不必知道 Host 的形状。
 *
 * 系统消息的判定：Host 已给出 `system` 布尔量，本层直接采信——
 * **不在前端用消息文案猜**（猜错会把正常消息藏起来）。
 */
export function toActivityMessages(
  views: readonly {
    readonly messageId: string
    readonly from: string
    readonly to: string
    readonly content: string
    readonly system: boolean
    readonly createdAtMs: number
  }[],
): ActivityMessage[] {
  return views.map((view) => ({
    id: view.messageId,
    from: view.from,
    to: view.to,
    content: view.content,
    summary: '',
    system: view.system,
    createdAt: view.createdAtMs,
  }))
}

export function toActivityTasks(
  views: readonly {
    readonly taskId: string
    readonly subject: string
    readonly description: string
    readonly status: string
    readonly owner: string
    readonly blockedBy: readonly string[]
    readonly createdAtMs: number
  }[],
): ActivityTask[] {
  return views.map((view) => ({
    id: view.taskId,
    subject: view.subject,
    description: view.description,
    status: view.status,
    owner: view.owner,
    blockedBy: [...view.blockedBy],
    createdAt: view.createdAtMs,
  }))
}

/**
 * 解析任务的依赖**成员名**。
 *
 * 只用**已加载**的任务建索引：没加载到的依赖就不显示名字（前端整段不出现依赖标签），
 * 而不是去拉全量任务或显示「未知」。这与 AionUi 的懒加载思路一致，只是更保守——
 * 首屏不该为了一个依赖标签去把整个任务板拉下来。
 */
export function resolveBlockerNames(
  tasks: readonly ActivityTask[],
): Record<string, readonly string[]> {
  const subjectById = new Map(tasks.map((task) => [task.id, task]))
  const byOwner = new Map(tasks.map((task) => [task.id, task.owner]))

  const result: Record<string, readonly string[]> = {}
  for (const task of tasks) {
    if (task.blockedBy.length === 0) continue

    const names: string[] = []
    for (const blockerId of task.blockedBy) {
      const blocker = subjectById.get(blockerId)
      // 依赖任务未加载 ⇒ 跳过（不猜）
      if (!blocker) continue
      // 优先用负责人名；没有负责人时退回任务标题——至少让人知道"在等什么"
      const label = byOwner.get(blockerId) || blocker.subject
      if (label && label.length > 0) names.push(label)
    }
    if (names.length > 0) result[task.id] = names
  }
  return result
}
