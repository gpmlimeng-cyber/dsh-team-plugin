/**
 * [INPUT]: 依赖 `./contracts.ts`（DTO 与错误码）。
 * [OUTPUT]: 路由层的**唯一响应封装**——成功只交 DTO，失败只交稳定码，绝不回显原始异常。
 * [POS]: 出网前的最后一道闸门。界面永远拿不到 Host 的内部错误文本或堆栈。
 * [PROTOCOL]: 变更时更新此头部，然后检查 src/index.ts
 */

/** 统一响应信封。键集封闭：只有 `ok` 与两分支之一。 */
export type TeamEnvelope<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly code: string }

export const TEAM_LOCAL_PREFIX = '/dsh-team/api/v1/local'

export const TEAM_LIST_PATH = `${TEAM_LOCAL_PREFIX}/teams`
export const TEAM_DETAIL_PATH = `${TEAM_LOCAL_PREFIX}/teams/detail`
export const TEAM_ACTIVITY_PATH = `${TEAM_LOCAL_PREFIX}/teams/activity`
/**
 * 长轮询「等变化」路由。
 *
 * 一次请求完成「等变化 + 取活动」两件事，省掉客户端两次往返。
 * 必须与 TEAM_ACTIVITY_PATH 分开：活动是快照（立即返回），这个是等待（可挂起）。
 */
export const TEAM_CHANGES_PATH = `${TEAM_LOCAL_PREFIX}/teams/changes`

/** Host 侧长轮询时长。
 *
 * ⚠️ 下限 10 秒是被官方 `waitForChange` 定的（"from ten seconds through one hour"），
 * 低于 10 秒会被宿主拒。故这个值不能为了"更实时"而调小。
 */
export const LONG_POLL_MS = 12_000
export const LONG_POLL_MIN_MS = 10_000
export const LONG_POLL_MAX_MS = 60_000
/**
 * 两轮轮询之间的**最小间隔**。
 *
 * 防的是「宿主秒回」时循环退化成忙循环——那会占满事件循环、把界面卡死。
 * 取 1s：既挡住忙循环，又不至于让刷新变得明显迟钝。
 */
export const POLL_MIN_GAP_MS = 1_000

/** 组装成功信封。 */
export function ok<T>(data: T): TeamEnvelope<T> {
  return { ok: true, data }
}

/** 组装失败信封。**只接码，不接错误对象**——防止异常消息漏到界面。 */
export function fail(code: string): TeamEnvelope<never> {
  return { ok: false, code }
}

/** 响应头：禁止任何缓存，避免用户看到过期的团队状态。 */
export const TEAM_JSON_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}