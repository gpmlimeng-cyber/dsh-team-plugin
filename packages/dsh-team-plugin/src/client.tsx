/**
 * [INPUT]: 依赖官方 `ctx.slots`（插槽注册）与 React `useSyncExternalStore`；依赖本包 state/panel/copy。
 * [OUTPUT]: Client 半——在 `sidebar.panellist` 注册「智能体团队」入口，并在 `main` 注册同名面板。
 * [POS]: Client 组合根。本文件只做「接线」：注册座位、订阅 store、把快照喂给纯组件。
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 *
 * 落点（照搬 dshent 资料库那套已验证的形状，不发明字段）：
 * - `sidebar.panellist`：options 走 metadata `{ name, id, order, label }`，图标走第二个参数。
 *   **没有** `title`/`icon` 字段——官方实物如此。
 * - `main`：`key` 与上面 `id` 取自**同一个常量**，同名是结构性的，不可能漂移。
 * - 两处座位共享**同一个** store 实例，故「列表状态」在两处视图之间不会各持一份。
 */

import { createElement, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'

import { TeamCreateDialog } from './create-dialog.js'
import { TEAM_ENTRY_LABEL } from './copy.js'
import { TeamDetailView, TeamListView } from './panel.js'
import { TeamWarmupOverlay } from './warmup-overlay.js'
import { createTeamStore, type TeamStore } from './state.js'
import type { TeamViewMode } from './view-mode.js'
import type { ActivityControls } from './activity.js'

/** 侧栏入口 id 与 main 面板 key 共用的**唯一**常量。 */
export const TEAM_ENTRY_ID = 'team'

/** 侧栏排序：官方实测 plugins=0 / schedules=10，本入口取 20 排在其后。 */
export const TEAM_ENTRY_ORDER = 20

/** 侧栏图标：纯装饰，官方高亮由 ownerProps 的 `active` 负责，本层不重复画。 */
function TeamIcon(props: { readonly size?: number | undefined; readonly active?: boolean | undefined }): ReactNode {
  void props.active
  const size = props.size ?? 18
  return createElement(
    'svg',
    { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
    createElement('circle', { cx: 9, cy: 8, r: 3, stroke: 'currentColor', strokeWidth: 1.6 }),
    createElement('circle', { cx: 17, cy: 10, r: 2.4, stroke: 'currentColor', strokeWidth: 1.6 }),
    createElement('path', {
      d: 'M3.5 19c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6',
      stroke: 'currentColor',
      strokeWidth: 1.6,
      strokeLinecap: 'round',
    }),
    createElement('path', {
      d: 'M16 15.2c2.4.2 4.1 1.6 4.5 3.8',
      stroke: 'currentColor',
      strokeWidth: 1.6,
      strokeLinecap: 'round',
    }),
  )
}

/** `sidebar.panellist` 的注册选项工厂。 */
export function teamPanelOptions(): Readonly<Record<string, unknown>> {
  return {
    name: 'sidebar.panellist',
    id: TEAM_ENTRY_ID,
    order: TEAM_ENTRY_ORDER,
    label: TEAM_ENTRY_LABEL,
  }
}

/** `main` 的注册选项工厂：`key` 与上面的 `id` 同一个常量。 */
export function teamMainOptions(store: TeamStore): Readonly<Record<string, unknown>> {
  return {
    name: 'main',
    key: TEAM_ENTRY_ID,
    inject: () => ({ store }),
  }
}

/**
 * 面板主体（带 hook 的薄壳）：订阅 store，按当前视图渲染纯组件。
 *
 * 拆成「壳（有 hook，只做接线）」与「纯组件（无 hook，可直接函数调用）」是为了可测性——
 * 纯组件能直接断言 DOM 结构，不需要渲染测试环境。
 */
export function TeamPanel(props: { readonly store: TeamStore }): ReactNode {
  const { store } = props
  const list = useSyncExternalStore(store.subscribe, () => store.list)
  const detail = useSyncExternalStore(store.subscribe, () => store.detail)
  const selectedTeamId = useSyncExternalStore(store.subscribe, () => store.selectedTeamId)
  const activeMemberId = useSyncExternalStore(store.subscribe, () => store.activeMemberId)
  const colorMap = useSyncExternalStore(store.subscribe, () => store.colorMap)
  const viewMode = useSyncExternalStore(store.subscribe, () => store.viewMode)
  const warmupPhase = useSyncExternalStore(store.subscribe, () => store.warmupPhase)
  const boardItems = useSyncExternalStore(store.subscribe, () => store.boardItems)
  const boardLanes = useSyncExternalStore(store.subscribe, () => store.boardLanes)
  const boardMemberLanes = useSyncExternalStore(store.subscribe, () => store.boardMemberLanes)
  const boardControls = useSyncExternalStore(store.subscribe, () => store.boardControls)
  const blockerNames = useSyncExternalStore(store.subscribe, () => store.blockerNamesByTaskId)
  const createOpen = useSyncExternalStore(store.subscribe, () => store.createOpen)
  const createForm = useSyncExternalStore(store.subscribe, () => store.createForm)
  const createSubmitting = useSyncExternalStore(store.subscribe, () => store.createSubmitting)
  const candidates = useSyncExternalStore(store.subscribe, () => store.candidates)

  // 首屏取一次列表。挂在空依赖上：只进详情时由 openTeam 负责取数，不重复拉列表。
  useEffect(() => {
    void store.refreshList()
    return () => store.dispose()
  }, [store])

  const openTeam = useMemo(() => (teamId: string) => void store.openTeam(teamId), [store])
  const back = useMemo(() => () => store.closeTeam(), [store])
  const retry = useMemo(() => () => void store.retry(), [store])

  const selectMember = useMemo(() => (memberId: string) => store.selectMember(memberId), [store])
  const setViewMode = useMemo(() => (mode: TeamViewMode) => store.setViewMode(mode), [store])
  const setBoardControls = useMemo(
    (next: ActivityControls) => store.setBoardControls(next),
    [store],
  )
  const openCreate = useMemo(() => () => store.openCreateDialog(), [store])
  const closeCreate = useMemo(() => () => store.closeCreateDialog(), [store])
  const setName = useMemo(() => (name: string) => store.setCreateName(name), [store])
  const toggleMember = useMemo(() => (id: string) => store.toggleCreateMember(id), [store])
  const chooseLeader = useMemo(() => (id: string) => store.chooseCreateLeader(id), [store])
  const submitCreate = useMemo(() => () => void store.submitCreate(), [store])

  // 有选中即进详情（详情态自持四态），否则显示列表 + 新建入口。
  const body =
    selectedTeamId !== null
      ? createElement(TeamDetailView, {
          state: detail,
          onBack: back,
          onRetry: retry,
          activeMemberId,
          colorMap,
          onSelectMember: selectMember,
          viewMode,
          onViewChange: setViewMode,
          boardItems,
          boardLanes,
          boardMemberLanes,
          boardControls,
          onBoardControlsChange: setBoardControls,
          blockerNamesByTaskId: blockerNames,
        })
      : createElement(TeamListView, {
          state: list,
          onOpen: openTeam,
          onRetry: retry,
          onCreate: openCreate,
          hasCandidates: candidates.length > 0,
        })

  // 暖启动遮罩只在「详情已就绪且成员列表已知」时可能渲染；
  // 判定全在 warmup.ts，这里不重复判。
  const detailMembers =
    detail.kind === 'ready'
      ? createElement(TeamWarmupOverlay, {
          members: detail.team.members,
          colorMap,
          timedOut: warmupPhase === 'error',
          onRetry: retry,
          onBack: back,
        })
      : null

  return createElement(
    'div',
    { 'data-team-panel': 'true' },
    body,
    detailMembers,
    createElement(TeamCreateDialog, {
      open: createOpen,
      candidates,
      form: createForm,
      submitting: createSubmitting,
      onNameChange: setName,
      onToggle: toggleMember,
      onChooseLeader: chooseLeader,
      onSubmit: submitCreate,
      onCancel: closeCreate,
    }),
  )
}

/** 座位占用者：官方 inject 面把 store 交进来。 */
function TeamPanelOccupant(props: unknown): ReactNode {
  const injected = (props as { readonly store?: TeamStore } | undefined)?.store
  // store 缺席时不画任何东西——不渲染半成品，也不给死按钮。
  if (!injected) return null
  return createElement(TeamPanel, { store: injected })
}

/** Cordis Client 入口。 */
export function apply(ctx: Context): void {
  // ⚠️ 必须用 ctx.get()：Cordis 的 ctx 是代理，直接访问未 inject 的属性会抛
  // `cannot get property "slots" without inject`，导致插件挂载失败。
  const slots = ctx.get('slots') as {
    inject(name: string, register: () => unknown): unknown
    register(options: Readonly<Record<string, unknown>>, component: (props: never) => ReactNode): unknown
  } | undefined
  if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return

  // **一个** store 实例同时喂给两处座位，避免两个视图各持一份状态。
  const store = createTeamStore()

  ctx.slots.inject('sidebar.panellist', () => slots.register(teamPanelOptions(), TeamIcon as never))
  ctx.slots.inject('main', () => slots.register(teamMainOptions(store), TeamPanelOccupant as never))
}

export default { apply }