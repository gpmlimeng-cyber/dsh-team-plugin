/**
 * [INPUT]: 依赖 `./api.ts`（取数）与 `./panel.tsx` 的状态类型（仅类型）。无 React。
 * [OUTPUT]: 面板状态机——非 React 外部 store，产出 `TeamListState` / `TeamDetailState` 四态快照。
 * [POS]: Client 半的数据层。组件只订阅快照，不自己发请求、不自己判错误。
 * [PROTOCOL]: 变更时更新此头部，然后检查 src/client.tsx
 *
 * 三条纪律：
 * 1. **绝不用未知状态去渲染**：一次请求未成功过就不出 ready 态，宁可显示加载中也不显示空列表。
 * 2. **在途请求独占**：后发先至作废，切团队时中止上一条，避免慢响应覆盖新选择。
 * 3. **失败保码不吞**：只交稳定码，界面据此决定是否给重试。
 */

import { fetchTeamActivity, fetchTeamDetail, fetchTeams, TeamApiError, waitTeamChanges } from './api.js'
import {
  buildActivityItems,
  buildLanes,
  DEFAULT_ACTIVITY_CONTROLS,
  resolveBlockerNames,
  toActivityMessages,
  toActivityTasks,
  type ActivityControls,
  type ActivityItem,
  type ActivityLane,
  type ActivityMessage,
  type ActivityTask,
} from './activity.js'
import { readActivityControls, writeActivityControls } from './activity-controls.js'
import { LONG_POLL_MS, POLL_MIN_GAP_MS } from './envelope.js'
import { deriveWarmupPhase, WARMUP_TIMEOUT_MS, type WarmupErrorKind, type WarmupPhase } from './warmup.js'
import {
  readViewMode,
  writeViewMode,
  DEFAULT_VIEW_MODE,
  type TeamViewMode,
} from './view-mode.js'
import {
  memberColorValue,
  reconcileColorMap,
  resolveBrowserStorage,
  writeColorMap,
  EMPTY_COLOR_MAP,
  type ColorStorage,
  type MemberColorMap,
} from './identity.js'
import type { TeamErrorCode, TeamSummaryView } from './contracts.js'
import {
  chooseLeader,
  EMPTY_CREATE_FORM,
  toggleMember,
  validateCreateForm,
  type CreateCandidate,
  type CreateFormState,
} from './create-form.js'
import type { TeamDetailState, TeamListState } from './panel.js'

/** 空列表是**引用稳定的常量**——可安全喂给 useSyncExternalStore 而不会因身份变化触发多余重渲染。 */
export const TEAM_LIST_EMPTY: TeamListState = { kind: 'ready', teams: [] }

export interface TeamStore {
  /** 当前列表快照。 */
  readonly list: TeamListState
  /** 当前选中的团队 id（null = 未选中）。 */
  readonly selectedTeamId: string | null
  /** 团队内当前聚焦的成员 id（null = 未聚焦）。 */
  readonly activeMemberId: string | null
  /** 成员身份色映射（按团队持久化）。 */
  readonly colorMap: MemberColorMap
  /** 当前视图模式（按团队记忆）。 */
  readonly viewMode: TeamViewMode
  /** 看板控制条。 */
  readonly boardControls: ActivityControls
  /** 看板条目（已归属/过滤/排序）。 */
  readonly boardItems: readonly ActivityItem[]
  /** 看板泳道（成员列 + 可选 fallback 列）。 */
  readonly boardLanes: readonly ActivityLane[]
  /** 仅成员列（控制条的筛选项用它，不含 fallback）。 */
  readonly boardMemberLanes: readonly ActivityLane[]
  /** 任务依赖的显示名（按 taskId 索引；解析不到则无该键）。 */
  readonly blockerNamesByTaskId: Readonly<Record<string, readonly string[]>>
  /** 更新看板控制条。 */
  setBoardControls(next: ActivityControls): void
  /** 注入看板原始数据（消息/任务）；由组合根在取到后调用。 */
  setBoardData(data: { messages: readonly ActivityMessage[]; tasks: readonly ActivityTask[] }): void
  /** 暖启动阶段。 */
  readonly warmupPhase: WarmupPhase
  /** 暖启动失败原因（仅 error 态有值）。 */
  readonly warmupErrorKind: WarmupErrorKind | null
  /** 当前详情快照。 */
  readonly detail: TeamDetailState
  /** 订阅变化，返回退订器。 */
  subscribe(listener: () => void): () => void
  /** 拉取团队列表。 */
  refreshList(): Promise<void>
  /** 选中某团队并拉详情。 */
  openTeam(teamId: string): Promise<void>
  /** 聚焦某个成员。 */
  selectMember(memberId: string | null): void
  /** 切换视图模式（按团队持久化）。 */
  setViewMode(mode: TeamViewMode): void
  /** 关闭详情，回到列表。 */
  closeTeam(): void
  /** 重试当前场景（列表或详情）。 */
  retry(): Promise<void>
  // --- 新建团队（E1）---
  /** 弹层是否打开。 */
  readonly createOpen: boolean
  /** 可选成员（尚未组队的智能体）。 */
  readonly candidates: readonly CreateCandidate[]
  /** 弹层表单当前值。 */
  readonly createForm: CreateFormState
  /** 提交中（在途不可连点）。 */
  readonly createSubmitting: boolean
  openCreateDialog(): void
  closeCreateDialog(): void
  setCreateName(name: string): void
  toggleCreateMember(memberId: string): void
  chooseCreateLeader(memberId: string): void
  submitCreate(): Promise<void>
  /** 由组合根注入候选来源。 */
  setCandidates(next: readonly CreateCandidate[]): void
  /** 释放：在途请求中止。 */
  dispose(): void
}

function toErrorCode(error: unknown): TeamErrorCode {
  if (error instanceof TeamApiError) return error.code
  // 非预期异常一律归到「取数失败」，绝不把异常文本外泄给界面。
  return 'TEAM_REQUEST_FAILED'
}

export function createTeamStore(): TeamStore {
  let list: TeamListState = { kind: 'loading' }
  let detail: TeamDetailState = { kind: 'loading' }
  let selectedTeamId: string | null = null
  let activeMemberId: string | null = null
  let colorMap: MemberColorMap = EMPTY_COLOR_MAP
  let viewMode: TeamViewMode = DEFAULT_VIEW_MODE
  /** 暖启动是否已超时——由下面的计时器改，判定逻辑在 warmup.ts。 */
  let warmupTimedOut = false
  let boardControls: ActivityControls = DEFAULT_ACTIVITY_CONTROLS
  /** 看板原始数据，由组合根注入；未取到时为空数组（看板显示空态，不谎称有数据）。 */
  let boardMessages: readonly ActivityMessage[] = []
  let boardTasks: readonly ActivityTask[] = []
  /** 超时计时器句柄。进入团队时起，撤遮罩/卸载时清。 */
  let warmupTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * 起一次超时计时。
   *
   * 超时只是**兜底**：组长正常就绪时遮罩早就撤了，这个计时器会被 clear 掉。
   * 它防的是「宿主信号迟到 / 事件丢失」导致无限转圈。
   */
  const startWarmupTimer = (): void => {
    clearWarmupTimer()
    warmupTimedOut = false
    warmupTimer = setTimeout(() => {
      warmupTimedOut = true
      emit()
    }, WARMUP_TIMEOUT_MS)
  }

  const clearWarmupTimer = (): void => {
    if (warmupTimer !== undefined) {
      clearTimeout(warmupTimer)
      warmupTimer = undefined
    }
  }

  /**
   * 派生看板条目与泳道（**唯一**判定口）。
   *
   * 归属 → 过滤 → 排序 → 决定要不要画 fallback 列，全在 activity.ts 里；
   * 本层只负责把「当前成员」喂进去。
   */
  const currentBoard = (): { items: ActivityItem[]; lanes: ActivityLane[]; memberLanes: ActivityLane[] } => {
    const members = detail.kind === 'ready' ? detail.team.members : []
    const knownMembers = new Set(members.map((member) => member.memberId))

    // 泳道用**身份色**——与胶囊栏、对话列同源，全局"谁是谁"一致。
    const memberLanes: ActivityLane[] = members.map((member) => ({
      laneId: member.memberId,
      name: member.memberId,
      color: memberColorValue(colorMap, member.memberId),
      isFallback: false,
    }))

    const items = buildActivityItems({
      messages: boardMessages,
      tasks: boardTasks,
      knownMembers,
      controls: boardControls,
    })
    return { items, lanes: buildLanes(memberLanes, items), memberLanes }
  }

  /**
   * 由当前详情快照派生暖启动阶段（**唯一**判定口）。
   * 详情不在 ready 态时一律 ready——遮罩不该盖在一个已经失败的取数之上（那有自己的失败态）。
   */
  const currentWarmup = (): { phase: WarmupPhase; errorKind: WarmupErrorKind | null } => {
    if (detail.kind !== 'ready') return { phase: 'ready', errorKind: null }
    return deriveWarmupPhase(detail.team.members, warmupTimedOut)
  }
  /** 存储口惰性解析一次；宿主没有 localStorage 时为 null，颜色与视图退化为纯内存。 */
  const storage: ColorStorage | null = resolveBrowserStorage()

  let listController: AbortController | undefined
  let detailController: AbortController | undefined
  let activityController: AbortController | undefined
  let activityEpoch = 0
  /** 轮询循环的停止标记：置 true 后循环会自行退出（不靠 abort，更可靠）。 */
  let pollingStopped = false
  /** 退避定时器句柄；停止轮询时要清掉，否则关闭后仍在等。 */
  let pollingTimer: ReturnType<typeof setTimeout> | undefined
  /** 自增代号：只有代号仍是当前值的响应才允许落状态（后发先至作废）。 */
  let listEpoch = 0
  let detailEpoch = 0
  let disposed = false

  const listeners = new Set<() => void>()
  const emit = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        /* 单个订阅者抛错不应阻断其它订阅者，更不应崩宿主 */
      }
    }
  }

  const refreshList = async (): Promise<void> => {
    if (disposed) return
    listController?.abort()
    const controller = new AbortController()
    listController = controller
    const epoch = ++listEpoch

    // 只在**尚无任何成功读数**时才显示加载中；已有数据时保持旧内容并允许后台更新，
    // 避免每次刷新都把列表清空闪烁一下。
    if (list.kind !== 'ready') list = { kind: 'loading' }
    emit()

    try {
      const teams = await fetchTeams(controller.signal)
      if (disposed || epoch !== listEpoch) return
      list = teams.length === 0 ? TEAM_LIST_EMPTY : { kind: 'ready', teams }
    } catch (error) {
      if (disposed || epoch !== listEpoch) return
      list = { kind: 'failed', code: toErrorCode(error) }
    }
    emit()
  }

  const openTeam = async (teamId: string): Promise<void> => {
    if (disposed) return
    detailController?.abort()
    const controller = new AbortController()
    detailController = controller
    const epoch = ++detailEpoch
    selectedTeamId = teamId
    detail = { kind: 'loading' }
    // 进入团队 ⇒ 起暖启动超时兜底。
    startWarmupTimer()
    emit()

    try {
      const team = await fetchTeamDetail(teamId, controller.signal)
      if (disposed || epoch !== detailEpoch) return
      // 团队不存在单列一态，**不是失败**——界面要说不同的话。
      if (team === null) {
        detail = { kind: 'missing' }
        colorMap = EMPTY_COLOR_MAP
        activeMemberId = null
        viewMode = readViewMode(storage, teamId)
      } else {
        detail = { kind: 'ready', team }
        // 身份色：读出上一版映射并按当前成员增量更新（这一步实现「钉死」与「释放复用」），随后落盘。
        const nextMap = reconcileColorMap(storage, teamId, team.members)
        colorMap = nextMap
        if (storage) writeColorMap(storage, teamId, nextMap)
        // 默认聚焦组长（与 AionUi 一致：进入团队先跟组长说话）
        const leadMember = team.members.find((member) => member.role === 'lead')
        activeMemberId = leadMember?.memberId ?? team.members[0]?.memberId ?? null
        // 视图模式按团队记忆读回——各团队各记各的。
        viewMode = readViewMode(storage, teamId)
        // 控制条同样按团队记忆；读回时剪除已不在队的筛选选项。
        boardControls = readActivityControls(storage, teamId, new Set(team.members.map((m) => m.memberId)))
        // 组长已就绪 ⇒ 遮罩已撤 ⇒ 超时兜底不再需要，清掉计时器。
        if (deriveWarmupPhase(team.members, false).phase === 'ready') clearWarmupTimer()
        // 活动：先取一次快照（首屏立即有内容），再进入长轮询保持新鲜。
        void refreshActivity(teamId).then(() => startPolling(teamId))
      }
    } catch (error) {
      if (disposed || epoch !== detailEpoch) return
      detail = { kind: 'failed', code: toErrorCode(error) }
    }
    emit()
  }

  /**
   * 拉取团队活动（消息 + 任务）。
   *
   * 失败**不抛给界面**：活动取不到不该让整个详情页失败——退化成"没有活动"，
   * 用户仍能看成员列表与对话。错误留在日志里，不伪造数据。
   */
  const refreshActivity = async (teamId: string): Promise<void> => {
    if (disposed) return
    activityController?.abort()
    const controller = new AbortController()
    activityController = controller
    const epoch = ++activityEpoch

    try {
      const payload = await fetchTeamActivity(teamId, controller.signal)
      if (disposed || epoch !== activityEpoch) return
      // null = 团队已不存在：清空即可，详情页有自己的一态
      boardMessages = payload === null ? [] : toActivityMessages(payload.messages)
      boardTasks = payload === null ? [] : toActivityTasks(payload.tasks)
    } catch {
      if (disposed || epoch !== activityEpoch) return
      // 降级成空：界面显示空态，而不是整页报错
      boardMessages = []
      boardTasks = []
    }
    emit()
  }

  /**
   * 持续轮询：等变化 → 取数据 → 再等。
   *
   * 四条纪律：
   * 1. **不重叠**：下一次等待只在本次返回后发起，故不会堆积请求。
   * 2. **有下限**：每轮之间**至少**隔一个短间隔才再发。
   *    缺这条会出真事故：若宿主「秒回」（无等待面、或立即超时），循环就变成
   *    不间断的微任务忙循环——占满事件循环、把界面卡死。
   * 3. **可停**：`pollingStopped` 置位后循环立即退出；换团队时先停旧的再起新的。
   * 4. **失败退避**：连续失败时进一步拉长间隔，避免宿主不可用时把 CPU 打满。
   */
  const startPolling = (teamId: string): void => {
    pollingStopped = true // 先停掉上一个循环
    pollingStopped = false

    let failures = 0
    const loop = async (): Promise<void> => {
      while (!pollingStopped && !disposed) {
        // 成功路径也要等——这是纪律 2 的关键，缺它会忙循环。
        const waitMs = failures > 0
          ? Math.min(failures * LONG_POLL_MS, LONG_POLL_MS * 5)
          : POLL_MIN_GAP_MS
        await delay(waitMs, () => pollingStopped)
        if (pollingStopped || disposed) return

        activityController?.abort()
        const controller = new AbortController()
        activityController = controller

        try {
          const payload = await waitTeamChanges(teamId, controller.signal)
          if (pollingStopped || disposed) return
          failures = 0
          boardMessages = payload === null ? [] : toActivityMessages(payload.messages)
          boardTasks = payload === null ? [] : toActivityTasks(payload.tasks)
          emit()
        } catch {
          if (pollingStopped || disposed) return
          failures += 1
          // 失败不 emit：界面保持旧数据，不闪错误态
        }
      }
    }
    void loop()
  }

  /** 可被中止的延迟。轮询退避时用它，让停止能立刻生效而不是干等。 */
  function delay(ms: number, stopped: () => boolean): Promise<void> {
    return new Promise<void>((resolve) => {
      if (stopped()) return resolve()
      const timer = setTimeout(() => resolve(), ms)
      pollingTimer = timer
    })
  }

  const closeTeam = (): void => {
    detailController?.abort()
    detailController = undefined
    clearWarmupTimer()
    detailEpoch += 1
    selectedTeamId = null
    activeMemberId = null
    colorMap = EMPTY_COLOR_MAP
    viewMode = DEFAULT_VIEW_MODE
    boardControls = DEFAULT_ACTIVITY_CONTROLS
    boardMessages = []
    boardTasks = []
    activityEpoch += 1
    pollingStopped = true
    if (pollingTimer !== undefined) {
      clearTimeout(pollingTimer)
      pollingTimer = undefined
    }
    detail = { kind: 'loading' }
    emit()
  }

  const retry = async (): Promise<void> => {
    if (selectedTeamId !== null) return openTeam(selectedTeamId)
    return refreshList()
  }

  // --- 新建团队 ---
  let createOpen = false
  let createForm: CreateFormState = EMPTY_CREATE_FORM
  let createSubmitting = false
  /** 候选来源由宿主注入（Client 组合根传入）；缺席时不做任何假选择。 */
  let candidates: readonly CreateCandidate[] = []

  const setCreateForm = (next: CreateFormState): void => {
    createForm = next
    emit()
  }

  const openCreateDialog = (): void => {
    if (candidates.length === 0) return
    createOpen = true
    createForm = EMPTY_CREATE_FORM
    createSubmitting = false
    emit()
  }

  const closeCreateDialog = (): void => {
    createOpen = false
    createForm = EMPTY_CREATE_FORM
    emit()
  }

  const submitCreate = async (): Promise<void> => {
    // 在途不可连点，也不允许用不合法表单提交。
    if (createSubmitting) return
    const validation = validateCreateForm(createForm)
    if (!validation.ok) return
    // 真正的组队动作由 Agent 在会话里用 spawn_teammate 完成（见 README「怎么用」）；
    // 插件侧只关闭弹层并刷新列表，**不自造写路由**。
    createSubmitting = true
    emit()
    createOpen = false
    createForm = EMPTY_CREATE_FORM
    createSubmitting = false
    await refreshList()
  }

  return {
    get list() {
      return list
    },
    get selectedTeamId() {
      return selectedTeamId
    },
    get activeMemberId() {
      return activeMemberId
    },
    get colorMap() {
      return colorMap
    },
    get viewMode() {
      return viewMode
    },
    get boardControls() {
      return boardControls
    },
    get boardItems() {
      return currentBoard().items
    },
    get boardLanes() {
      return currentBoard().lanes
    },
    get boardMemberLanes() {
      return currentBoard().memberLanes
    },
    get blockerNamesByTaskId(): Readonly<Record<string, readonly string[]>> {
      return resolveBlockerNames(boardTasks)
    },
    setBoardControls: (next: ActivityControls): void => {
      boardControls = next
      writeActivityControls(storage, selectedTeamId ?? '', next)
      emit()
    },
    setBoardData: (data: { messages: readonly ActivityMessage[]; tasks: readonly ActivityTask[] }): void => {
      boardMessages = data.messages
      boardTasks = data.tasks
      emit()
    },
    get warmupPhase() {
      return currentWarmup().phase
    },
    get warmupErrorKind() {
      return currentWarmup().errorKind
    },
    setViewMode: (mode: TeamViewMode): void => {
      // ⚠️ 刻意**不动** activeMemberId：两视图共享同一份选中态。
      // 用户在并行视图选了某人，切单聊时应当还是那个人。
      viewMode = mode
      writeViewMode(storage, selectedTeamId ?? '', mode)
      emit()
    },
    selectMember: (memberId: string | null): void => {
      activeMemberId = memberId
      emit()
    },
    get detail() {
      return detail
    },
    get createOpen() {
      return createOpen
    },
    get createForm() {
      return createForm
    },
    get createSubmitting() {
      return createSubmitting
    },
    get candidates() {
      return candidates
    },
    /** 由组合根注入候选来源（宿主可用的智能体）。 */
    setCandidates(next: readonly CreateCandidate[]): void {
      candidates = [...next]
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    refreshList,
    openTeam,
    closeTeam,
    retry,
    openCreateDialog,
    closeCreateDialog,
    setCreateName: (name: string) => setCreateForm({ ...createForm, name }),
    toggleCreateMember: (memberId: string) => setCreateForm(toggleMember(createForm, memberId)),
    chooseCreateLeader: (memberId: string) => setCreateForm(chooseLeader(createForm, memberId)),
    submitCreate,
    dispose(): void {
      disposed = true
      listController?.abort()
      detailController?.abort()
      activityController?.abort()
      pollingStopped = true
      if (pollingTimer !== undefined) clearTimeout(pollingTimer)
      clearWarmupTimer()
      listeners.clear()
    },
  }
}

/** 取一次列表用于首屏预热（不进 store，只给调用方一个判断依据）。 */
export async function peekTeams(): Promise<readonly TeamSummaryView[] | null> {
  try {
    return await fetchTeams()
  } catch {
    return null
  }
}