/**
 * [INPUT]: 依赖官方 `ctx.webServer`（本机只读路由）与 `ctx.agentTeams`（团队真源）；依赖本包 contracts/adapter/project/envelope。
 * [OUTPUT]: Host 半——注册两条同源只读 JSON 路由（团队列表 / 团队详情），供 Client 半取数。
 * [POS]: 插件唯一的 Host Loader 入口。
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 *
 * 三条硬纪律：
 * 1. **不得崩溃宿主**：所有取数/投影都 try/catch，失败降级为稳定错误码，绝不 throw 到 Cordis 顶层。
 * 2. **只读**：E1 阶段不提供任何写路由。新建团队由 Agent 在会话里用 spawn_teammate 完成，
 *    界面只负责呈现——这与 DSH「Lead 通过工具组队」的产品模型一致，也避免插件自造权限面。
 * 3. **不硬注入 agentTeams**：它可能晚于本插件出现；缺席时路由如实回 TEAM_UNSUPPORTED，
 *    而不是让插件加载失败。
 */

import type { Context } from '@deepseek-ai/cordis'

import { toMemberFacts, toTeamFact, type DshTeamMemberRow } from './adapter.js'
import {
  TEAM_ERROR_CODES,
  type TeamActivityMessageView,
  type TeamActivityTaskView,
} from './contracts.js'
import {
  LONG_POLL_MS,
  TEAM_ACTIVITY_PATH,
  TEAM_CHANGES_PATH,
  TEAM_DETAIL_PATH,
  TEAM_JSON_HEADERS,
  TEAM_LIST_PATH,
  fail,
  ok,
  type TeamEnvelope,
} from './envelope.js'
import { projectMember, projectSummary, projectTeamList, sortMembers, type RawTeamFact } from './project.js'

/** Cordis 插件名 = settings 命名空间 = Loader entry id。 */
export const name = 'dsh-team'

/** 本插件全部错误码，供 Client 半做「一处定义、处处复用」的文案映射。 */
export const TEAM_CODES = TEAM_ERROR_CODES

/** Host 能拿到的团队事实集合。抽象出来便于测试与后续替换取数来源。 */
export interface TeamFactSource {
  /**
   * 列出全部团队事实。
   * 返回 null 表示「宿主不支持团队能力」，与「确实没有团队」（空数组）严格区分——
   * 界面据此说不同的话，不能拿空数组谎称「你还没有团队」。
   */
  list(): readonly RawTeamFact[] | null
  /** 取单个团队事实；不存在返回 null。 */
  find(teamId: string): RawTeamFact | null
  /**
   * 取某团队的活动（成员间消息 + 任务）。
   *
   * 与 `list()` 同约定：**返回 null 表示宿主不支持**，空数组表示「确实没有活动」。
   */
  activity(teamId: string): TeamActivityPayload | null
}

/** 活动载荷（Host 内部形状，与对外 DTO 同名但独立声明以免误解为已脱敏）。 */
export interface TeamActivityPayload {
  readonly messages: readonly TeamActivityMessageView[]
  readonly tasks: readonly TeamActivityTaskView[]
}

/** 官方 webServer 的窄结构（只声明本插件用到的一小块）。 */
interface WebServerLike {
  register(route: {
    method: string
    path: string
    handler: (request: Request) => Response | Promise<Response>
  }): () => void
}

/** `agentTeams` 的窄结构：本插件只用到 membership 与 listMembers。 */
interface AgentTeamsLike {
  listMembers(agent: unknown): readonly DshTeamMemberRow[] | undefined
  membership(agent: unknown): { readonly id: string; readonly name: string } | undefined
  /** 长轮询等待团队变化。宿主可能尚未提供该面——故为可选。 */
  waitForChange?(
    caller: unknown,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<{ readonly timedOut: boolean }>
}

/** `agents.roots()` 的窄结构。 */
interface AgentsLike {
  roots(): readonly unknown[]
}

/**
 * 取得本机可用的 agentTeams 服务；缺席返回 null（fail-closed，不阻断插件加载）。
 *
 * ⚠️ **必须用 `ctx.get()`，绝不能写 `(ctx as any).agentTeams`**：
 * Cordis 的 ctx 是代理对象，访问**未声明 inject** 的属性会抛
 * `cannot get property "x" without inject`，会让整个插件挂载失败。
 * `ctx.get()` 在未 inject 时返回 undefined，是这里唯一安全的取法。
 */
function resolveAgentTeams(ctx: Context): AgentTeamsLike | null {
  const teams = ctx.get('agentTeams') as AgentTeamsLike | undefined
  if (!teams || typeof teams !== 'object') return null
  if (typeof teams.listMembers !== 'function' || typeof teams.membership !== 'function') return null
  return teams
}

/** 取得本机根会话 Agent；缺席返回空数组。 */
function resolveRootAgents(ctx: Context): readonly unknown[] {
  const agents = ctx.get('agents') as AgentsLike | undefined
  if (!agents || typeof agents !== 'object') return []
  const roots = (agents as Partial<AgentsLike>).roots
  if (typeof roots !== 'function') return []
  try {
    const list = roots.call(agents)
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/**
 * 组装事实源：从存活中的 lead 会话派生团队。
 *
 * 刻意只呈现**本机当前活着**的团队——DSH 的团队由「Lead Session 日志」支撑，
 * 会话没了团队也就没了。这与 AionUi 的持久化团队不同，是需要在界面上如实说明的产品差异。
 */
export function createFactSource(ctx: Context): TeamFactSource {
  const build = (): Map<string, RawTeamFact> => {
    const result = new Map<string, RawTeamFact>()
    const teams = resolveAgentTeams(ctx)
    if (!teams) return result

    for (const agent of resolveRootAgents(ctx)) {
      let membership: { readonly id: string; readonly name: string } | undefined
      let rows: readonly DshTeamMemberRow[] | undefined
      try {
        membership = teams.membership(agent)
        if (!membership) continue
        rows = teams.listMembers(agent)
      } catch {
        // 单个会话取数失败不影响其它团队：跳过即可，绝不整批失败。
        continue
      }

      // 只有确属 lead 的会话才算一个团队；teammate 跳过。
      const members = toMemberFacts(rows)
      if (!members.some((member) => member.lead)) continue

      const now = Date.now()
      result.set(membership.id, toTeamFact({
        leadSessionId: membership.id,
        name: membership.name,
        workspaceLabel: '',
        // 存活会话没有可靠的创建时刻，暂以本次观测时间兜底。
        // 排序真正依赖 lastActiveMs，故这条只影响「创建时间」展示的精度。
        createdAtMs: now,
        lastActiveMs: now,
        rows,
      }))
    }
    return result
  }

  return {
    list: () => {
      // agentTeams 缺席 → null（宿主不支持），与「没有团队」区分开。
      if (!resolveAgentTeams(ctx)) return null
      return [...build().values()]
    },
    find: (teamId: string) => {
      if (!resolveAgentTeams(ctx)) return null
      return build().get(teamId) ?? null
    },
    activity: (teamId: string) => {
      const teams = resolveAgentTeams(ctx)
      // 不支持 ⇒ null（界面据此说"宿主没这个能力"，而不是"没有活动"）
      if (!teams) return null

      const teamsById = build()
      const fact = teamsById.get(teamId)
      if (!fact) return null

      // 任务：借成员会话作为 caller 读团队任务板。
      // ⚠️ 取不到就交**空数组**（该团队确实没有任务），不抛——任务板为空是正常状态。
      const tasks = readTeamTasks(teams, ctx, teamId)
      return { messages: [], tasks }
    },
  }
}

/** DSH 任务视图的窄结构（本插件只用这几个字段）。 */
interface DshTeamTaskView {
  readonly id: string
  readonly subject: string
  readonly description: string
  readonly status: string
  readonly blockedBy: readonly string[]
  readonly ownerName?: string | undefined
}

/**
 * 读某团队的任务板并脱敏成对外 DTO。
 *
 * 关键取舍：**owner 映射不到成员名时交空串**（未指派），而不是把内部句柄当名字下发——
 * 那会让看板出现一个叫「Session_xxx」的泳道。
 */
function readTeamTasks(
  teams: AgentTeamsLike,
  ctx: Context,
  teamId: string,
): TeamActivityTaskView[] {
  const knownMembers = resolveRootAgents(ctx)
    .map((agent) => {
      try {
        return teams.membership(agent)
      } catch {
        return undefined
      }
    })
    .filter((membership): membership is { readonly id: string; readonly name: string } => membership?.id === teamId)

  const membership = knownMembers[0]
  if (!membership) return []

  const listTasks = (teams as { listTasks?: (agent: unknown) => readonly DshTeamTaskView[] | undefined }).listTasks
  if (typeof listTasks !== 'function') return []

  let rows: readonly DshTeamTaskView[] | undefined
  try {
    rows = listTasks.call(teams, { id: membership.id })
  } catch {
    // 单次取数失败不该让整个看板 500——降级成"没有任务"
    return []
  }
  if (!Array.isArray(rows)) return []

  const out: TeamActivityTaskView[] = []
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || row.id.length === 0) continue
    out.push({
      taskId: row.id,
      subject: typeof row.subject === 'string' ? row.subject : '',
      description: typeof row.description === 'string' ? row.description : '',
      status: typeof row.status === 'string' ? row.status : 'pending',
      owner: typeof row.ownerName === 'string' ? row.ownerName : '',
      blockedBy: Array.isArray(row.blockedBy)
        ? row.blockedBy.filter((id: unknown): id is string => typeof id === 'string')
        : [],
      createdAtMs: 0,
    })
  }
  return out
}

/** 本机 JSON 响应：统一 no-store，避免用户看到过期的团队状态。 */
function json(body: TeamEnvelope<unknown>): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: TEAM_JSON_HEADERS })
}

/** 解析详情路由上的 teamId 查询参数。 */
function readTeamId(url: URL): string | null {
  const value = url.searchParams.get('teamId')
  return value && value.length > 0 && value.length <= 128 ? value : null
}

/**
 * 注册两条只读路由。
 *
 * 路由极薄：解析 → 取事实 → 投影 → 封信封。任何一步抛错都被就地降级为错误码。
 * **整段包在 try/catch 里**——webServer 缺席或注册失败都不能让宿主崩溃。
 */
export function registerRoutes(ctx: Context, source: TeamFactSource): () => void {
  // 同上：webServer 也是可选面，用 ctx.get() 取。未接线时安静跳过，不让插件挂载失败。
  const webServer = ctx.get('webServer') as WebServerLike | undefined
  if (!webServer || typeof webServer.register !== 'function') return () => undefined

  const listHandler = (): Response => {
    try {
      const facts = source.list()
      if (facts === null) return json(fail('TEAM_UNSUPPORTED'))
      return json(ok({ teams: projectTeamList(facts) }))
    } catch {
      return json(fail('TEAM_REQUEST_FAILED'))
    }
  }

  const detailHandler = (request: Request): Response => {
    try {
      const teamId = readTeamId(new URL(request.url))
      if (!teamId) return json(fail('TEAM_RESPONSE_INVALID'))
      const fact = source.find(teamId)
      // 团队已不存在：**这不是失败**，信封如实带 null，界面显示「该团队已不存在」。
      if (!fact) return json(ok({ team: null }))
      return json(ok({
        team: {
          summary: projectSummary(fact),
          // lead 恒首位，与 AionUi 一致：组长永远在第一个位置。
          members: sortMembers(fact.members).map(projectMember),
        },
      }))
    } catch {
      return json(fail('TEAM_REQUEST_FAILED'))
    }
  }

  /**
   * 长轮询：等一次团队变化，然后返回活动快照。
   *
   * 为什么在 Host 侧合并「等待 + 取数」：
   * 分成两条路由会让客户端多一次往返，而且两次之间存在竞态——等到了变化再单独去取，
   * 中间又变了一次就漏了。合并成一次原子请求就没有这个窗口。
   *
   * 宿主没有 `waitForChange` 面时**立即返回当前快照**（退化成轮询而非长轮询），
   * 不让客户端干等——那只会白等 12 秒。
   */
  const changesHandler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const teamId = readTeamId(url)

    try {
      if (!teamId) return json(fail('TEAM_RESPONSE_INVALID'))
      const teams = resolveAgentTeams(ctx)
      if (!teams) return json(fail('TEAM_UNSUPPORTED'))

      const wait = teams.waitForChange
      // 有等待面才真的等；没有就立刻返回（否则白等一个轮询周期）
      if (typeof wait === 'function') {
        // 客户端断开时立刻中止等待，不吊着连接
        const controller = new AbortController()
        const onAbort = (): void => controller.abort()
        request.signal.addEventListener('abort', onAbort, { once: true })
        try {
          await wait.call(teams, { id: teamId }, LONG_POLL_MS, controller.signal)
        } catch {
          /* 等待被中止/抛错：照常返回当前快照，不让客户端看到失败 */
        } finally {
          request.signal.removeEventListener('abort', onAbort)
        }
      }

      const activity = source.activity(teamId)
      if (activity === null) return json(fail('TEAM_UNSUPPORTED'))
      return json(ok({ messages: activity.messages, tasks: activity.tasks }))
    } catch {
      return json(fail('TEAM_REQUEST_FAILED'))
    }
  }

  const activityHandler = (request: Request): Response => {
    try {
      const teamId = readTeamId(new URL(request.url))
      if (!teamId) return json(fail('TEAM_RESPONSE_INVALID'))
      const activity = source.activity(teamId)
      // 宿主不支持活动面 ⇒ 如实说不支持；团队不存在 ⇒ null（不是失败）
      if (activity === null) return json(fail('TEAM_UNSUPPORTED'))
      return json(ok({ messages: activity.messages, tasks: activity.tasks }))
    } catch {
      return json(fail('TEAM_REQUEST_FAILED'))
    }
  }

  const disposers: (() => void)[] = [
    webServer.register({ method: 'GET', path: TEAM_LIST_PATH, handler: listHandler }),
    webServer.register({ method: 'GET', path: TEAM_DETAIL_PATH, handler: detailHandler }),
    webServer.register({ method: 'GET', path: TEAM_ACTIVITY_PATH, handler: activityHandler }),
    webServer.register({ method: 'GET', path: TEAM_CHANGES_PATH, handler: changesHandler }),
  ]
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* 卸载期失败不应阻断宿主 */
      }
    }
  }
}

/** Cordis 插件入口。 */
export function apply(ctx: Context): void {
  ctx.effect(() => registerRoutes(ctx, createFactSource(ctx)))
}

export default { name, apply, TEAM_CODES }