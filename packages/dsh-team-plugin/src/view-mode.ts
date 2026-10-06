/**
 * [INPUT]: 依赖 `./identity.ts` 的 `ColorStorage`/`resolveBrowserStorage`（复用同一存储口）。无 React、无 DOM。
 * [OUTPUT]: 团队视图模式的**唯一真源**：模式枚举 + 按团队记忆的持久化 + 读回时的收窄校验。
 * [POS]: E3 的规则层。视图模式是「团队整体属性」，故按 teamId 分键存，各团队各记各的。
 * [PROTOCOL]: 变更时更新此头部，然后检查 src/panel.tsx
 *
 * 三个模式（与 AionUi 一致）：
 * - `parallel`：所有成员并排（**默认**）——纵览全员。
 * - `single`：全屏只跟一个成员——成员多时被压窄时用。
 * - `board`：「消息 & 任务」活动看板——E5 接入，E3 先留位。
 *
 * ⚠️ 两个视图**共享同一份选中态**（当前聚焦成员）。这是刻意的：
 * 用户在并行视图点了某个成员，切到单聊时应当还是那个人——视图是呈现方式，
 * 不是导航，两套状态会让用户在切换时"丢掉"自己刚才选的人。
 *
 * 移植自 AionUi（Apache-2.0）：`renderer/pages/team/hooks/useTeamViewMode.ts`
 */

import { type ColorStorage, resolveBrowserStorage } from './identity.js'

/** 视图模式。 */
export type TeamViewMode = 'parallel' | 'single' | 'board'

/** 全部合法模式（读回校验的白名单）。 */
export const TEAM_VIEW_MODES: readonly TeamViewMode[] = ['parallel', 'single', 'board']

/** 默认模式：并行。上游也用 parallel 作默认。 */
export const DEFAULT_VIEW_MODE: TeamViewMode = 'parallel'

/** localStorage 键前缀，**按 teamId 分键**。 */
export const VIEW_MODE_KEY_PREFIX = 'dsh-team.view-mode.'

export function viewModeStorageKey(teamId: string): string {
  return `${VIEW_MODE_KEY_PREFIX}${teamId}`
}

/**
 * 收窄校验：只认三个合法值，其余一律回默认。
 *
 * 存储可能被手改、被旧版本写入、或干脆是空的——**任何异常都回落到并行**，
 * 绝不把一个界面不认识的值渲染出去。
 */
export function parseViewMode(raw: string | null): TeamViewMode {
  if (raw === 'single') return 'single'
  if (raw === 'board') return 'board'
  // 其它一切（含历史遗留值、空串、null）都回默认。
  return DEFAULT_VIEW_MODE
}

/** 读某团队记忆的视图模式。 */
export function readViewMode(storage: ColorStorage | null, teamId: string): TeamViewMode {
  if (!storage) return DEFAULT_VIEW_MODE
  try {
    return parseViewMode(storage.getItem(viewModeStorageKey(teamId)))
  } catch {
    return DEFAULT_VIEW_MODE
  }
}

/** 写视图模式。**存储不可用时静默降级**——本次会话内仍一致，跨会话记忆失效。 */
export function writeViewMode(storage: ColorStorage | null, teamId: string, mode: TeamViewMode): void {
  if (!storage) return
  try {
    storage.setItem(viewModeStorageKey(teamId), mode)
  } catch {
    /* 配额满 / 无痕模式：视图仍在内存生效 */
  }
}

/** 是否属于「成员并排/全屏」这类需要成员列表的视图（board 不需要）。 */
export function isMemberView(mode: TeamViewMode): boolean {
  return mode === 'parallel' || mode === 'single'
}

/**
 * 单聊视图下应该显示哪个成员。
 *
 * 规则：选中成员不在队里 ⇒ **回退组长**（上游同款）。
 * 这条很重要——否则成员被移除后单聊会变成空白，用户以为页面坏了。
 */
export function resolveSingleViewMemberId(
  members: readonly { readonly memberId: string; readonly role: 'lead' | 'teammate' }[],
  activeMemberId: string | null,
): string | null {
  if (members.length === 0) return null
  if (activeMemberId !== null && members.some((member) => member.memberId === activeMemberId)) {
    return activeMemberId
  }
  const lead = members.find((member) => member.role === 'lead')
  return lead?.memberId ?? members[0]?.memberId ?? null
}

/** 宿主存储口的惰性解析（与身份色共用同一个口）。 */
export function resolveViewStorage(): ColorStorage | null {
  return resolveBrowserStorage()
}