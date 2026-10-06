/**
 * [INPUT]: 依赖 `./api.ts`（取数）、`./copy.ts`（文案）、`./state.ts`（外层 store）；依赖官方 UI 原语。
 * [OUTPUT]: 「智能体团队」面板的**纯呈现组件**（无取数、无 store 订阅，可直接函数调用做测试）。
 * [POS]: 渲染层。全部状态经 props 进来，全部文案经 copy.ts 出——本文件不写一个字面量文案。
 * [PROTOCOL]: 变更时更新此头部，然后检查 src/client.tsx
 */

import { createElement, type ReactNode } from 'react'

import { MemberCapsuleBar } from './capsules.js'
import { ActivityBoard, BoardControlBar } from './board.js'
import {
  DEFAULT_ACTIVITY_CONTROLS,
  type ActivityControls,
  type ActivityItem,
  type ActivityLane,
} from './activity.js'
import { TeamViewToggle } from './view-toggle.js'

import type { TeamDetailView, TeamErrorCode, TeamMemberView, TeamSummaryView } from './contracts.js'
import { memberColorValue, type MemberColorMap } from './identity.js'
import { resolveSingleViewMemberId, type TeamViewMode } from './view-mode.js'
import {
  TEAM_DETAIL_BACK,
  TEAM_DETAIL_LOADING,
  TEAM_DETAIL_MISSING_NEXT,
  TEAM_DETAIL_MISSING_TITLE,
  TEAM_EMPTY_HINT,
  TEAM_EMPTY_NEXT,
  TEAM_EMPTY_TITLE,
  TEAM_LIST_CREATE,
  TEAM_LIST_LOADING,
  TEAM_LIST_RETRY,
  TEAM_LIST_SUBTITLE,
  TEAM_LIST_TITLE,
  TEAM_ROW_MEMBERS,
  TEAM_ROW_RUNNING,
  TEAM_SINGLE_NO_MEMBER,
  teamErrorCopy,
  teamErrorRetryable,
} from './copy.js'

/** 列表页状态：四态互斥且穷尽——不出现「既加载中又报错的空壳」。 */
export type TeamListState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly teams: readonly TeamSummaryView[] }
  | { readonly kind: 'failed'; readonly code: TeamErrorCode }

/** 详情页状态。`missing` 单列一态：团队不存在不是错误。 */
export type TeamDetailState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly team: TeamDetailView }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly code: TeamErrorCode }

/** 失败提示块：人话 + 下一步 + 稳定码（收进「技术信息」）+ 真重试。 */
export function TeamErrorNotice(props: {
  readonly code: TeamErrorCode
  readonly onRetry?: (() => void) | undefined
}): ReactNode {
  const copy = teamErrorCopy(props.code)
  const retryable = teamErrorRetryable(props.code)
  return createElement(
    'div',
    { role: 'alert', 'data-team-error': props.code },
    createElement('p', null, copy.title),
    createElement('p', null, copy.next),
    createElement(
      'details',
      null,
      createElement('summary', null, '技术信息'),
      createElement('code', null, props.code),
    ),
    // 只在**真的可重试**且回调在场时画重试；终态不给假按钮。
    retryable && props.onRetry
      ? createElement('button', { type: 'button', onClick: props.onRetry }, TEAM_LIST_RETRY)
      : null,
  )
}

/** 空态：说清「为什么空」和「下一步怎么做」，并给一句可直接照抄的说法。 */
export function TeamEmptyState(): ReactNode {
  return createElement(
    'section',
    { 'data-team-empty': 'true' },
    createElement('h2', null, TEAM_EMPTY_TITLE),
    createElement('p', null, TEAM_EMPTY_NEXT),
    createElement('p', { 'data-team-empty-hint': 'true' }, TEAM_EMPTY_HINT),
  )
}

/** 团队行。活跃时给出「运行中」提示，让用户一眼知道哪个团队在干活。 */
export function TeamRow(props: {
  readonly team: TeamSummaryView
  readonly onOpen: (teamId: string) => void
}): ReactNode {
  const { team } = props
  return createElement(
    'li',
    null,
    createElement(
      'button',
      {
        type: 'button',
        'data-team-row': team.teamId,
        'data-team-active': team.active ? 'true' : 'false',
        onClick: () => props.onOpen(team.teamId),
      },
      createElement('span', { 'data-team-name': 'true' }, team.name),
      createElement('span', { 'data-team-members': 'true' }, TEAM_ROW_MEMBERS(team.memberCount)),
      // 运行中只在真的活跃时出现——不做常驻占位。
      team.active ? createElement('span', { 'data-team-running': 'true' }, TEAM_ROW_RUNNING) : null,
      team.workspaceLabel ? createElement('span', { 'data-team-workspace': 'true' }, team.workspaceLabel) : null,
    ),
  )
}

/** 列表页。 */
export function TeamListView(props: {
  readonly state: TeamListState
  readonly onOpen: (teamId: string) => void
  readonly onRetry: () => void
  /** 有可组队的智能体时才画「新建团队」——没有候选时不给死按钮。 */
  readonly onCreate?: (() => void) | undefined
  readonly hasCandidates?: boolean | undefined
}): ReactNode {
  const { state } = props
  if (state.kind === 'loading') {
    return createElement('div', { role: 'status' }, TEAM_LIST_LOADING)
  }
  if (state.kind === 'failed') {
    return createElement(TeamErrorNotice, { code: state.code, onRetry: props.onRetry })
  }
  if (state.teams.length === 0) {
    return createElement(TeamEmptyState)
  }

  return createElement(
    'section',
    null,
    createElement('h1', null, TEAM_LIST_TITLE),
    createElement('p', null, TEAM_LIST_SUBTITLE),
    // 「新建团队」常驻：用户进这个页面多半就是想建一个，没候选时才不给。
    props.onCreate && props.hasCandidates
      ? createElement(
          'button',
          { type: 'button', 'data-team-create': 'true', onClick: props.onCreate },
          TEAM_LIST_CREATE,
        )
      : null,
    createElement(
      'ul',
      { 'data-team-list': 'true' },
      state.teams.map((team) => createElement(TeamRow, { key: team.teamId, team, onOpen: props.onOpen })),
    ),
  )
}


/**
 * 并行视图：所有成员一列并排。
 *
 * 每列先放成员名字与身份色（E3 阶段对话区留位，E5 起接入消息流）。
 * 成员顺序沿用 Host 给的顺序（组长已在首位），本层不重排。
 */
export function ParallelMemberPanes(props: {
  readonly members: readonly TeamMemberView[]
  readonly colorMap: MemberColorMap
}): ReactNode {
  return createElement(
    'div',
    { 'data-view-panes': 'parallel', 'data-member-count': String(props.members.length) },
    props.members.map((member) =>
      createElement(
        'section',
        {
          key: member.memberId,
          'data-pane': member.memberId,
          'data-pane-role': member.role,
          // 身份色：与胶囊栏同源，保证「谁是谁」在两处完全一致
          style: { '--mc': memberColorValue(props.colorMap, member.memberId) },
        },
        createElement('span', { 'data-pane-name': 'true' }, member.memberId),
      ),
    ),
  )
}

/**
 * 单聊视图：全屏只显示当前选中的成员。
 *
 * `memberId` 为 null 只可能发生在「成员刚被清空」——此时不渲染空壳，直接给空态提示。
 */
export function SingleMemberPane(props: {
  readonly members: readonly TeamMemberView[]
  readonly colorMap: MemberColorMap
  readonly memberId: string | null
}): ReactNode {
  const member = props.members.find((item) => item.memberId === props.memberId)
  if (!member) {
    return createElement('div', { 'data-view-panes': 'single', 'data-pane-empty': 'true' }, TEAM_SINGLE_NO_MEMBER)
  }
  return createElement(
    'div',
    { 'data-view-panes': 'single' },
    createElement(
      'section',
      {
        'data-pane': member.memberId,
        'data-pane-role': member.role,
        style: { '--mc': memberColorValue(props.colorMap, member.memberId) },
      },
      createElement('span', { 'data-pane-name': 'true' }, member.memberId),
    ),
  )
}


/**
 * 活动看板视图（只读）：每成员一列泳道，消息与任务混排在同一时间线上。
 *
 * 泳道与条目全部由 `buildActivityItems` 算好传进来——本组件**不做任何归属/过滤判断**，
 * 避免"渲染层自己再过滤一遍"导致与规则层不一致。
 */
export function ActivityBoardView(props: {
  readonly lanes: readonly ActivityLane[]
  readonly items: readonly ActivityItem[]
  readonly controls: ActivityControls
  readonly memberLanes: readonly ActivityLane[]
  readonly onControlsChange: (next: ActivityControls) => void
  readonly blockerNamesByTaskId?: Readonly<Record<string, readonly string[]>> | undefined
}): ReactNode {
  return createElement(
    'div',
    { 'data-view-panes': 'board' },
    createElement(BoardControlBar, {
      controls: props.controls,
      members: props.memberLanes,
      onChange: props.onControlsChange,
    }),
    createElement(ActivityBoard, {
      lanes: props.lanes,
      items: props.items,
      blockerNamesByTaskId: props.blockerNamesByTaskId,
    }),
  )
}

/** 详情页。 */
export function TeamDetailView(props: {
  readonly state: TeamDetailState
  readonly onBack: () => void
  readonly onRetry: () => void
  /** 当前聚焦成员；null = 未聚焦。 */
  readonly activeMemberId?: string | null | undefined
  /** 成员身份色映射。 */
  readonly colorMap?: MemberColorMap | undefined
  readonly onSelectMember?: ((memberId: string) => void) | undefined
  /** 当前视图模式。 */
  readonly viewMode?: TeamViewMode | undefined
  readonly onViewChange?: ((mode: TeamViewMode) => void) | undefined
  /** 看板：消息与任务（已归属/过滤/排序）。 */
  readonly boardItems?: readonly ActivityItem[] | undefined
  readonly boardLanes?: readonly ActivityLane[] | undefined
  readonly boardMemberLanes?: readonly ActivityLane[] | undefined
  readonly boardControls?: ActivityControls | undefined
  readonly onBoardControlsChange?: ((next: ActivityControls) => void) | undefined
  readonly blockerNamesByTaskId?: Readonly<Record<string, readonly string[]>> | undefined
}): ReactNode {
  const { state } = props
  const back = createElement('button', { type: 'button', 'data-team-back': 'true', onClick: props.onBack }, TEAM_DETAIL_BACK)

  if (state.kind === 'loading') {
    return createElement('div', { role: 'status' }, TEAM_DETAIL_LOADING)
  }
  if (state.kind === 'failed') {
    return createElement('div', null, back, createElement(TeamErrorNotice, { code: state.code, onRetry: props.onRetry }))
  }
  if (state.kind === 'missing') {
    return createElement(
      'section',
      { 'data-team-missing': 'true' },
      createElement('h2', null, TEAM_DETAIL_MISSING_TITLE),
      createElement('p', null, TEAM_DETAIL_MISSING_NEXT),
      back,
    )
  }

  const { team } = state
  return createElement(
    'section',
    { 'data-team-detail': team.summary.teamId },
    createElement(
      'header',
      { 'data-team-header': 'true' },
      createElement('h1', { 'data-team-detail-name': 'true' }, team.summary.name),
      // 视图切换：成员 >1 才有意义；只有一种视图时不渲染死控件。
      team.members.length > 1
        ? createElement(TeamViewToggle, {
            mode: props.viewMode ?? 'parallel',
            onChange: props.onViewChange ?? (() => undefined),
          })
        : null,
    ),
    // 成员胶囊栏：并行/单聊要它（切视图不该让人"选谁"消失）；看板用泳道表达，故不渲染。
    (props.viewMode ?? 'parallel') === 'board'
      ? null
      : createElement(MemberCapsuleBar, {
      members: team.members,
      colorMap: props.colorMap ?? {},
      // 单聊视图下高亮**实际显示**的那个成员（选中成员被移除时已回退组长）
      activeMemberId:
        (props.viewMode ?? 'parallel') === 'single'
          ? resolveSingleViewMemberId(team.members, props.activeMemberId ?? null)
          : props.activeMemberId ?? null,
      onSelect: props.onSelectMember ?? (() => undefined),
    }),
    // 主体布局：看板 / 单聊 / 并行 三选一
    (props.viewMode ?? 'parallel') === 'board'
      ? createElement(ActivityBoardView, {
          lanes: props.boardLanes ?? [],
          items: props.boardItems ?? [],
          controls: props.boardControls ?? DEFAULT_ACTIVITY_CONTROLS,
          memberLanes: props.boardMemberLanes ?? [],
          onControlsChange: props.onBoardControlsChange ?? (() => undefined),
          blockerNamesByTaskId: props.blockerNamesByTaskId,
        })
      : (props.viewMode ?? 'parallel') === 'single'
        ? createElement(SingleMemberPane, {
            members: team.members,
            colorMap: props.colorMap ?? {},
            memberId: resolveSingleViewMemberId(team.members, props.activeMemberId ?? null),
          })
        : createElement(ParallelMemberPanes, { members: team.members, colorMap: props.colorMap ?? {} }),
    team.summary.workspaceLabel
      ? createElement('p', { 'data-team-detail-workspace': 'true' }, team.summary.workspaceLabel)
      : null,
    createElement(
      'ul',
      { 'data-team-members': 'true' },
      // 成员已由 Host 保证 lead 恒首位，这里不再排序。
      team.members.map((member) =>
        createElement(
          'li',
          { key: member.memberId, 'data-team-member': member.memberId, 'data-team-role': member.role },
          createElement('span', { 'data-team-member-name': 'true' }, member.memberId),
          createElement('span', { 'data-team-member-status': 'true' }, member.statusText),
          member.pendingCount > 0
            ? createElement('span', { 'data-team-member-pending': 'true' }, String(member.pendingCount))
            : null,
        ),
      ),
    ),
    back,
  )
}