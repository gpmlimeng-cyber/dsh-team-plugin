/**
 * [INPUT]: 依赖 `../contracts.ts` 的 DTO 与错误码；浏览器 `fetch`（同源固定路径）。
 * [OUTPUT]: 浏览器侧唯一网络边界——只发同源固定路径请求，调用方无法注入地址或授权头。
 * [POS]: Client 半的取数出口。业务组件一律经它取数，禁止自己 fetch 或拼 URL。
 * [PROTOCOL]: 变更时更新此头部，然后检查 src/panel.tsx
 *
 * 纪律（照搬 dshent 的 local-api 口径）：
 * - 只认两个固定常量路径，**不接受调用方传入任何 URL 片段**——堵住「拼路径注入」的开口。
 * - 失败只交稳定错误码，**绝不把响应体或异常文本透给界面**。
 * - 响应必须过严格解码；解码失败即 TEAM_RESPONSE_INVALID，不做「尽力解析」。
 */

import {
  decodeTeamActivityResponse,
  decodeTeamDetailResponse,
  decodeTeamListResponse,
  type TeamActivityPayload,
  type TeamDetailView,
  type TeamErrorCode,
  type TeamSummaryView,
} from './contracts.js'
import { TEAM_ACTIVITY_PATH, TEAM_CHANGES_PATH, TEAM_DETAIL_PATH, TEAM_LIST_PATH } from './envelope.js'

/** 取数失败时抛出的唯一错误：只带稳定码。 */
export class TeamApiError extends Error {
  readonly code: TeamErrorCode

  constructor(code: TeamErrorCode) {
    super(code)
    this.name = 'TeamApiError'
    this.code = code
  }
}

/** 信封形状（与 Host 的 `TeamEnvelope` 同形；这里只声明读侧用到的两个分支）。 */
type Envelope<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly code: TeamErrorCode }

function isEnvelope(value: unknown): value is Envelope<unknown> {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record['ok'] === true) return 'data' in record
  if (record['ok'] === false) return typeof record['code'] === 'string'
  return false
}

/**
 * 发一次同源 GET 并解出信封。
 *
 * fetch 本身失败（网络/宿主未就绪）与响应结构非法都归到稳定码，
 * 界面据此决定「要不要给重试按钮」。
 */
async function getEnvelope(path: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(path, {
      method: 'GET',
      headers: { accept: 'application/json' },
      // 同源固定路径，不带凭据：本插件不碰任何令牌。
      credentials: 'omit',
      ...(signal ? { signal } : {}),
    })
  } catch {
    throw new TeamApiError('TEAM_REQUEST_FAILED')
  }

  if (!response.ok) throw new TeamApiError('TEAM_REQUEST_FAILED')

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new TeamApiError('TEAM_RESPONSE_INVALID')
  }
  if (!isEnvelope(payload)) throw new TeamApiError('TEAM_RESPONSE_INVALID')
  if (payload.ok === false) throw new TeamApiError(payload.code)
  return payload.data
}

/**
 * 团队列表。
 *
 * @throws TeamApiError — `TEAM_UNSUPPORTED`（宿主没有团队能力）/ `TEAM_REQUEST_FAILED` / `TEAM_RESPONSE_INVALID`
 */
export async function fetchTeams(signal?: AbortSignal): Promise<TeamSummaryView[]> {
  const data = await getEnvelope(TEAM_LIST_PATH, signal)
  try {
    return decodeTeamListResponse(data)
  } catch {
    throw new TeamApiError('TEAM_RESPONSE_INVALID')
  }
}

/**
 * 团队详情（含成员列表）。
 *
 * @param teamId - 团队 id。**做长度与字符集收窄**后才进 URL，避免把超长或含控制字符的值
 *   拼进查询串。真正的安全边界在 Host 侧，这里只是不制造畸形请求。
 * @returns 团队不存在时返回 null（不是失败——界面显示「该团队已不存在」）。
 */
export async function fetchTeamDetail(teamId: string, signal?: AbortSignal): Promise<TeamDetailView | null> {
  const safeId = teamId.slice(0, 128)
  if (safeId.length === 0) throw new TeamApiError('TEAM_RESPONSE_INVALID')

  const data = await getEnvelope(`${TEAM_DETAIL_PATH}?teamId=${encodeURIComponent(safeId)}`, signal)
  try {
    return decodeTeamDetailResponse(data).team
  } catch {
    throw new TeamApiError('TEAM_RESPONSE_INVALID')
  }
}
/**
 * 取团队活动（成员间消息 + 任务）。
 *
 * @returns 团队不存在时返回 null（界面显示「该团队已不存在」）。
 * @throws TeamApiError — `TEAM_UNSUPPORTED` / `TEAM_REQUEST_FAILED` / `TEAM_RESPONSE_INVALID`
 */
export async function fetchTeamActivity(teamId: string, signal?: AbortSignal): Promise<TeamActivityPayload | null> {
  const safeId = teamId.slice(0, 128)
  if (safeId.length === 0) throw new TeamApiError('TEAM_RESPONSE_INVALID')

  const data = await getEnvelope(`${TEAM_ACTIVITY_PATH}?teamId=${encodeURIComponent(safeId)}`, signal)
  try {
    return decodeTeamActivityResponse(data)
  } catch {
    throw new TeamApiError('TEAM_RESPONSE_INVALID')
  }
}

/**
 * 长轮询一次：等团队变化 + 取活动快照。
 *
 * 与 `fetchTeamActivity` 的区别是**它会挂起**（宿主最长等约 12 秒），
 * 因此只应用于"持续轮询"这一个场景，不要拿它做首屏取数。
 */
export async function waitTeamChanges(teamId: string, signal?: AbortSignal): Promise<TeamActivityPayload | null> {
  const safeId = teamId.slice(0, 128)
  if (safeId.length === 0) throw new TeamApiError('TEAM_RESPONSE_INVALID')

  const data = await getEnvelope(`${TEAM_CHANGES_PATH}?teamId=${encodeURIComponent(safeId)}`, signal)
  try {
    return decodeTeamActivityResponse(data)
  } catch {
    throw new TeamApiError('TEAM_RESPONSE_INVALID')
  }
}
