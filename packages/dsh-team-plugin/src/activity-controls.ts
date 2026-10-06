/**
 * [INPUT]: 依赖 `./activity.ts` 的控制条类型与默认；依赖 `./identity.ts` 的存储口。
 * [OUTPUT]: 看板控制条的**按团队持久化**：写入 + 逐字段校验读回（读时剪除失效成员）。
 * [POS]: E5 的持久化层。控制条是「团队整体属性」，故按 teamId 分键存。
 * [PROTOCOL]: 变更时更新此头部，然后检查 src/board.tsx
 *
 * 为什么逐字段校验：存储会被手改、被旧版本写坏、被别的脚本污染。
 * **每个字段独立回落默认**——存坏的排序不该连带把筛选也重置。
 * 另外读回时要**剪除已不在队里的成员**，否则筛选面板会留着查不到人的幽灵选项。
 *
 * 移植自 AionUi（Apache-2.0）：`renderer/pages/team/hooks/useTeamActivityControls.ts`
 */

import {
  DEFAULT_ACTIVITY_CONTROLS,
  type ActivityContentFilter,
  type ActivityControls,
  type ActivitySortDirection,
} from './activity.js'
import { type ColorStorage } from './identity.js'

export const ACTIVITY_CONTROLS_KEY_PREFIX = 'dsh-team.activity-controls.'

export function activityControlsStorageKey(teamId: string): string {
  return `${ACTIVITY_CONTROLS_KEY_PREFIX}${teamId}`
}

const SORT_VALUES: ReadonlySet<string> = new Set<ActivitySortDirection>(['desc', 'asc'])
const FILTER_VALUES: ReadonlySet<string> = new Set<ActivityContentFilter>(['all', 'messages', 'tasks'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 逐字段解析，**每字段独立回落默认**。
 *
 * @param validMembers - 当前仍在队的成员 id（含 fallback）；用于剪除失效筛选项。
 *   传 null 表示跳过剪除（如调用方还没取到成员）。
 */
export function parseActivityControls(
  raw: string | null,
  validMembers: ReadonlySet<string> | null = null,
): ActivityControls {
  if (!raw) return DEFAULT_ACTIVITY_CONTROLS

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return DEFAULT_ACTIVITY_CONTROLS
  }
  if (!isRecord(parsed)) return DEFAULT_ACTIVITY_CONTROLS

  const sort = parsed['sortDirection']
  const filter = parsed['contentFilter']
  const selectedRaw = parsed['selectedMembers']
  const showSystem = parsed['showSystemMessages']
  const showTerminal = parsed['showTerminalTasks']

  const selected = Array.isArray(selectedRaw)
    ? selectedRaw.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : []

  return {
    sortDirection: typeof sort === 'string' && SORT_VALUES.has(sort) ? (sort as ActivitySortDirection) : DEFAULT_ACTIVITY_CONTROLS.sortDirection,
    contentFilter: typeof filter === 'string' && FILTER_VALUES.has(filter) ? (filter as ActivityContentFilter) : DEFAULT_ACTIVITY_CONTROLS.contentFilter,
    // 剪除已移除的成员；剪空 = 全员（安全默认）
    selectedMembers: validMembers === null ? selected : selected.filter((id) => validMembers.has(id)),
    showSystemMessages: typeof showSystem === 'boolean' ? showSystem : DEFAULT_ACTIVITY_CONTROLS.showSystemMessages,
    showTerminalTasks: typeof showTerminal === 'boolean' ? showTerminal : DEFAULT_ACTIVITY_CONTROLS.showTerminalTasks,
  }
}

/** 写控制条。存储不可用时静默降级为仅内存。 */
export function writeActivityControls(
  storage: ColorStorage | null,
  teamId: string,
  controls: ActivityControls,
): void {
  if (!storage) return
  try {
    storage.setItem(activityControlsStorageKey(teamId), JSON.stringify(controls))
  } catch {
    /* 配额满 / 无痕模式：本次会话内仍一致 */
  }
}

/** 读控制条（读时按当前成员剪除失效选项）。 */
export function readActivityControls(
  storage: ColorStorage | null,
  teamId: string,
  validMembers: ReadonlySet<string> | null = null,
): ActivityControls {
  if (!storage) return DEFAULT_ACTIVITY_CONTROLS
  try {
    return parseActivityControls(storage.getItem(activityControlsStorageKey(teamId)), validMembers)
  } catch {
    return DEFAULT_ACTIVITY_CONTROLS
  }
}