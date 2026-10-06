/**
 * [INPUT]: 依赖 `./activity.ts`（数据模型与规则）、`./copy.ts`（文案）；React createElement。
 * [OUTPUT]: 活动看板的**纯呈现组件**：控制条 + 泳道布局 + 消息卡 + 任务卡（无 hook，可直接函数调用测试）。
 * [POS]: E5 的渲染层。归属/过滤/排序全在 activity.ts，本文件只负责画。
 * [PROTOCOL]: 变更时更新此头部，然后检查 src/client.tsx
 */

import { createElement, type ReactNode } from 'react'

import {
  ACTIVITY_BROADCAST_TARGET,
  type ActivityContentFilter,
  type ActivityControls,
  type ActivityItem,
  type ActivityLane,
  type ActivityMessage,
  type ActivitySortDirection,
  type ActivityTask,
} from './activity.js'
import {
  TEAM_BOARD_BROADCAST,
  TEAM_BOARD_EMPTY,
  TEAM_BOARD_EMPTY_NEXT,
  TEAM_BOARD_FILTER_ALL,
  TEAM_BOARD_FILTER_LABEL,
  TEAM_BOARD_FILTER_MESSAGES,
  TEAM_BOARD_FILTER_TASKS,
  TEAM_BOARD_MEMBERS_LABEL,
  TEAM_BOARD_SHOW_SYSTEM,
  TEAM_BOARD_SHOW_TERMINAL,
  TEAM_BOARD_SORT_ASC,
  TEAM_BOARD_SORT_DESC,
  TEAM_BOARD_SORT_LABEL,
  TEAM_BOARD_SYSTEM,
  TEAM_TASK_BLOCKED_BY,
  TEAM_TASK_UNASSIGNED,
} from './copy.js'

// ---------------------------------------------------------------------------
// 控制条
// ---------------------------------------------------------------------------

function SortToggle(props: {
  readonly value: ActivitySortDirection
  readonly onChange: (value: ActivitySortDirection) => void
}): ReactNode {
  return createElement(
    'div',
    { role: 'group', 'aria-label': TEAM_BOARD_SORT_LABEL, 'data-board-sort': 'true' },
    createElement(
      'button',
      {
        type: 'button',
        'aria-pressed': props.value === 'desc',
        'data-sort': 'desc',
        onClick: () => props.onChange('desc'),
      },
      TEAM_BOARD_SORT_DESC,
    ),
    createElement(
      'button',
      {
        type: 'button',
        'aria-pressed': props.value === 'asc',
        'data-sort': 'asc',
        onClick: () => props.onChange('asc'),
      },
      TEAM_BOARD_SORT_ASC,
    ),
  )
}

function FilterToggle(props: {
  readonly value: ActivityContentFilter
  readonly onChange: (value: ActivityContentFilter) => void
}): ReactNode {
  const options: readonly { value: ActivityContentFilter; label: string }[] = [
    { value: 'all', label: TEAM_BOARD_FILTER_ALL },
    { value: 'messages', label: TEAM_BOARD_FILTER_MESSAGES },
    { value: 'tasks', label: TEAM_BOARD_FILTER_TASKS },
  ]
  return createElement(
    'div',
    { role: 'group', 'aria-label': TEAM_BOARD_FILTER_LABEL, 'data-board-filter': 'true' },
    options.map((option) =>
      createElement(
        'button',
        {
          key: option.value,
          type: 'button',
          'aria-pressed': props.value === option.value,
          'data-filter': option.value,
          onClick: () => props.onChange(option.value),
        },
        option.label,
      ),
    ),
  )
}

function MemberFilter(props: {
  readonly members: readonly ActivityLane[]
  readonly selected: readonly string[]
  readonly onChange: (next: readonly string[]) => void
}): ReactNode {
  const selectedSet = new Set(props.selected)
  return createElement(
    'div',
    { role: 'group', 'aria-label': TEAM_BOARD_MEMBERS_LABEL, 'data-board-members': 'true' },
    props.members.map((lane) =>
      createElement(
        'button',
        {
          key: lane.laneId,
          type: 'button',
          // 空选中 = 全员，故无一项被按下时全部都呈"未按下"
          'aria-pressed': selectedSet.has(lane.laneId),
          'data-member-filter': lane.laneId,
          onClick: () => {
            const next = new Set(selectedSet)
            if (next.has(lane.laneId)) next.delete(lane.laneId)
            else next.add(lane.laneId)
            props.onChange([...next])
          },
        },
        lane.name,
      ),
    ),
  )
}

/** 看板控制条：排序 / 内容过滤 / 成员筛选 / 两个噪音开关。 */
export function BoardControlBar(props: {
  readonly controls: ActivityControls
  readonly members: readonly ActivityLane[]
  readonly onChange: (next: ActivityControls) => void
}): ReactNode {
  const patch = (partial: Partial<ActivityControls>): void => props.onChange({ ...props.controls, ...partial })
  return createElement(
    'div',
    { 'data-board-controls': 'true' },
    createElement(SortToggle, { value: props.controls.sortDirection, onChange: (sortDirection) => patch({ sortDirection }) }),
    createElement(FilterToggle, { value: props.controls.contentFilter, onChange: (contentFilter) => patch({ contentFilter }) }),
    // 成员筛选只有一位成员时无意义——不做占位
    props.members.length > 1
      ? createElement(MemberFilter, {
          members: props.members,
          selected: props.controls.selectedMembers,
          onChange: (selectedMembers) => patch({ selectedMembers }),
        })
      : null,
    createElement(
      'button',
      {
        type: 'button',
        'aria-pressed': props.controls.showSystemMessages,
        'data-toggle': 'system',
        onClick: () => patch({ showSystemMessages: !props.controls.showSystemMessages }),
      },
      TEAM_BOARD_SHOW_SYSTEM,
    ),
    createElement(
      'button',
      {
        type: 'button',
        'aria-pressed': props.controls.showTerminalTasks,
        'data-toggle': 'terminal',
        onClick: () => patch({ showTerminalTasks: !props.controls.showTerminalTasks }),
      },
      TEAM_BOARD_SHOW_TERMINAL,
    ),
  )
}

// ---------------------------------------------------------------------------
// 卡片
// ---------------------------------------------------------------------------

/** 消息卡。广播有独立标记——用户需要知道这条是"我对所有人说"。 */
export function MessageCard(props: { readonly message: ActivityMessage }): ReactNode {
  const { message } = props
  const broadcast = message.to === ACTIVITY_BROADCAST_TARGET
  return createElement(
    'article',
    { 'data-card': `message:${message.id}`, 'data-card-system': message.system ? 'true' : 'false' },
    createElement('span', { 'data-msg-from': 'true' }, message.from),
    broadcast ? createElement('span', { 'data-msg-broadcast': 'true' }, TEAM_BOARD_BROADCAST) : null,
    createElement('p', { 'data-msg-content': 'true' }, message.system ? TEAM_BOARD_SYSTEM : message.content),
  )
}

/**
 * 任务卡。
 *
 * `blockedByNames` 是**已解析的**依赖成员名——解析逻辑在数据层（懒加载），
 * 本组件只负责把名字显示出来。查不到依赖时整段不出现，不显示「等待：未知」。
 */
export function TaskCard(props: {
  readonly task: ActivityTask
  readonly blockedByNames?: readonly string[] | undefined
}): ReactNode {
  const { task } = props
  const blockerNames = (props.blockedByNames ?? []).filter((name) => name.length > 0)
  return createElement(
    'article',
    { 'data-card': `task:${task.id}`, 'data-task-status': task.status },
    createElement('h4', { 'data-task-subject': 'true' }, task.subject),
    task.owner
      ? createElement('span', { 'data-task-owner': 'true' }, task.owner)
      : createElement('span', { 'data-task-owner': 'true', 'data-task-unassigned': 'true' }, TEAM_TASK_UNASSIGNED),
    // 有依赖才显示依赖；没有就不占位
    blockerNames.length > 0
      ? createElement('span', { 'data-task-blocked-by': 'true' }, TEAM_TASK_BLOCKED_BY(blockerNames))
      : null,
  )
}

/** 一条活动条目 → 对应卡片。 */
export function ActivityCard(props: {
  readonly item: ActivityItem
  readonly blockedByNames?: readonly string[] | undefined
}): ReactNode {
  if (props.item.kind === 'message') return createElement(MessageCard, { message: props.item.message })
  return createElement(TaskCard, { task: props.item.task, blockedByNames: props.blockedByNames })
}

// ---------------------------------------------------------------------------
// 看板
// ---------------------------------------------------------------------------

/**
 * 泳道看板：每条泳道一列。
 *
 * 空态是**整块**空态（过滤后一条都不剩），不是"一列一列都空"——
 * 后者看起来像坏了。
 */
export function ActivityBoard(props: {
  readonly lanes: readonly ActivityLane[]
  readonly items: readonly ActivityItem[]
  readonly blockerNamesByTaskId?: Readonly<Record<string, readonly string[]>> | undefined
}): ReactNode {
  if (props.items.length === 0) {
    return createElement(
      'div',
      { 'data-board-empty': 'true' },
      createElement('p', null, TEAM_BOARD_EMPTY),
      createElement('p', null, TEAM_BOARD_EMPTY_NEXT),
    )
  }

  const byLane = new Map<string, ActivityItem[]>()
  for (const item of props.items) {
    const bucket = byLane.get(item.laneId)
    if (bucket) bucket.push(item)
    else byLane.set(item.laneId, [item])
  }

  return createElement(
    'div',
    { 'data-board': 'true', 'data-lane-count': String(props.lanes.length) },
    props.lanes.map((lane) => {
      const laneItems = byLane.get(lane.laneId) ?? []
      return createElement(
        'section',
        {
          key: lane.laneId,
          'data-lane': lane.laneId,
          'data-lane-fallback': lane.isFallback ? 'true' : 'false',
          'data-lane-count': String(laneItems.length),
          style: { '--mc': lane.color },
          'aria-label': lane.name,
        },
        createElement('h3', { 'data-lane-name': 'true' }, lane.name),
        // 每条泳道内部仍是纵向时间线
        ...laneItems.map((item) =>
          createElement(ActivityCard, {
            key: `${item.kind}:${item.id}`,
            item,
            blockedByNames: props.blockerNamesByTaskId?.[item.id],
          }),
        ),
      )
    }),
  )
}