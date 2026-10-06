/**
 * [INPUT]: 依赖 `../contracts.ts` 的错误码（仅类型）。无 React、无 fetch。
 * [OUTPUT]: 员工可见文案的唯一真源：人话 + 「下一步」+ 可重试判定。
 * [POS]: 界面文案的唯一出口。任何一处直接写裸码或另写一套措辞都算违规。
 * [PROTOCOL]: 变更时更新此头部，然后检查 src/panel.tsx
 *
 * 纪律：界面上**不得出现**任何 `TEAM_` 裸码；技术信息只进「技术信息」折叠区。
 * 每条错误必须同时给出「发生了什么」与「用户能做什么」，否则等于把问题甩给用户。
 */

import { isRetryableTeamError, type TeamErrorCode } from './contracts.js'

export interface TeamErrorCopy {
  /** 人话：发生了什么。 */
  readonly title: string
  /** 下一步：用户现在该做什么。 */
  readonly next: string
  /** 是否可重试（决定是否画「重试」按钮）。 */
  readonly retryable: boolean
}

const COPY: Readonly<Record<TeamErrorCode, TeamErrorCopy>> = {
  TEAM_REQUEST_FAILED: {
    title: '没能取到团队信息',
    next: '检查连接后重试；若持续失败，请重启客户端后再试。',
    retryable: true,
  },
  TEAM_RESPONSE_INVALID: {
    title: '返回的数据无法识别',
    next: '这通常意味着客户端与插件版本不匹配。请更新插件后重试。',
    retryable: false,
  },
  TEAM_UNSUPPORTED: {
    title: '当前宿主未启用团队能力',
    next: '请升级客户端到支持智能体团队的版本。',
    retryable: false,
  },
}

/** 取某错误码的文案；未知码走兜底（终态、不给假重试）。 */
export function teamErrorCopy(code: TeamErrorCode): TeamErrorCopy {
  return COPY[code] ?? { title: '出了点问题', next: '请稍后重试。', retryable: false }
}

/** 可重试判定走契约层的单一真源，不在界面另写一份。 */
export function teamErrorRetryable(code: TeamErrorCode): boolean {
  return isRetryableTeamError(code) && (COPY[code]?.retryable ?? false)
}

// ---------------------------------------------------------------------------
// 界面固定文案
// ---------------------------------------------------------------------------

export const TEAM_ENTRY_LABEL = '智能体团队'
export const TEAM_ENTRY_ICON_ALT = '智能体团队'

export const TEAM_LIST_TITLE = '智能体团队'
export const TEAM_LIST_SUBTITLE = '让多个智能体分工协作，共同完成一件事。'

export const TEAM_EMPTY_TITLE = '还没有团队'
export const TEAM_EMPTY_NEXT = '在会话里让组长组建团队，组建后就会出现在这里。'
export const TEAM_EMPTY_HINT = '例如：「组建一个团队：一人负责调研，一人负责实现，一人负责测试。」'

export const TEAM_LIST_LOADING = '正在加载团队…'
export const TEAM_LIST_RETRY = '重试'
export const TEAM_LIST_CREATE = '新建团队'

/** 成员胶囊栏 */
export const TEAM_MEMBER_LEADER_BADGE = '组长'
export const TEAM_MEMBER_REMOVE_LABEL = '移出团队'
export const TEAM_PENDING_LABEL = '待你确认'

/** 视图切换 */
export const TEAM_VIEW_PARALLEL = '并行'
export const TEAM_VIEW_SINGLE = '单聊'
export const TEAM_VIEW_BOARD = '看板'
export const TEAM_VIEW_TOGGLE_LABEL = '视图'
export const TEAM_SINGLE_NO_MEMBER = '暂无可显示的成员。'

/** 暖启动遮罩 */
export const TEAM_WARMUP_PROGRESS = (ready: number, total: number): string => `唤醒中 ${ready}/${total}`
export const TEAM_WARMUP_LEAD_FAILED_TITLE = '组长未能启动'
export const TEAM_WARMUP_LEAD_FAILED_NEXT = '请检查组长所用的模型是否可用，或返回团队列表稍后重试。'
export const TEAM_WARMUP_TIMEOUT_TITLE = '准备超时'
export const TEAM_WARMUP_TIMEOUT_NEXT = '团队启动耗时过长。请重试；若反复超时，请返回团队列表。'
export const TEAM_WARMUP_RETRY = '重试'
export const TEAM_WARMUP_BACK = '返回团队列表'
export const TEAM_WARMUP_ARIA = '正在准备团队'

/** 团队行 */
export const TEAM_ROW_MEMBERS = (count: number): string => `${count} 位成员`
export const TEAM_ROW_RUNNING = '运行中'

/** 详情页 */
export const TEAM_DETAIL_LOADING = '正在加载团队…'
export const TEAM_DETAIL_MISSING_TITLE = '该团队已不存在'
export const TEAM_DETAIL_MISSING_NEXT = '它可能已被解散。返回列表查看其它团队。'
export const TEAM_DETAIL_BACK = '返回团队列表'

/** 新建团队弹层 */
export const TEAM_CREATE_TITLE = '新建团队'
export const TEAM_CREATE_NAME_LABEL = '团队名称'
export const TEAM_CREATE_NAME_PLACEHOLDER = '例如：发布官网 v2'
export const TEAM_CREATE_NAME_REQUIRED = '请填写团队名称。'
export const TEAM_CREATE_MEMBER_REQUIRED = '请至少选择一名成员。'
export const TEAM_CREATE_LEADER_REQUIRED = '请指定一名组长，且组长需要在成员名单里。'
export const TEAM_CREATE_NO_AVAILABLE = '暂无可用的智能体。请先在会话中创建智能体，或让组长按需组队。'
export const TEAM_CREATE_SUBMIT = '创建团队'
export const TEAM_CREATE_SUBMITTING = '创建中…'
export const TEAM_CREATE_CANCEL = '取消'
export const TEAM_CREATE_LEADER_HINT = '组长负责理解你的目标并协调团队。'
export const TEAM_CREATE_WORKSPACE_HINT = '团队将在当前工作区中协作。'

/**
 * 空态引导：给一句**可以照抄**的说法。
 *
 * 与 AionUi「告诉 Leader」同一思路——不给死说明，直接把用户会说的话摆出来。
 */
export const TEAM_CREATE_PREFILL_PLACEHOLDER = '组建一个团队：一人负责调研，一人负责实现，一人负责测试。'
/** 活动看板 */
export const TEAM_BOARD_TITLE = '活动看板'
export const TEAM_BOARD_EMPTY = '这个团队还没有活动。'
export const TEAM_BOARD_EMPTY_NEXT = '在会话里给组长描述你的目标，成员之间的往来会显示在这里。'
export const TEAM_BOARD_FALLBACK_LANE = '未分配 / 外部'

/** 控制条 */
export const TEAM_BOARD_SORT_LABEL = '排序'
export const TEAM_BOARD_FILTER_LABEL = '内容'
export const TEAM_BOARD_MEMBERS_LABEL = '成员'
export const TEAM_BOARD_SHOW_SYSTEM = '显示系统消息'
export const TEAM_BOARD_SHOW_TERMINAL = '显示已完成任务'

export const TEAM_BOARD_SORT_DESC = '新→旧'
export const TEAM_BOARD_SORT_ASC = '旧→新'
export const TEAM_BOARD_FILTER_ALL = '全部'
export const TEAM_BOARD_FILTER_MESSAGES = '仅消息'
export const TEAM_BOARD_FILTER_TASKS = '仅任务'

/** 任务卡 */
export const TEAM_TASK_BLOCKED_BY = (names: readonly string[]): string => `等待：${names.join('、')}`
export const TEAM_TASK_UNASSIGNED = '未指派'
export const TEAM_BOARD_SYSTEM = '系统消息'
export const TEAM_BOARD_BROADCAST = '→ 所有人'
export const TEAM_TASK_SYSTEM = '系统消息'
