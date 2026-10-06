/**
 * [INPUT]: 依赖 src/index.ts（Host 半）与 src/envelope.ts（信封），用假 Cordis ctx 驱动。
 * [OUTPUT]: 门禁用例——锁住 Host 侧对外行为：键集封闭、宿主不支持时不谎称空列表、成员非法行被丢弃、lead 恒首位。
 * [POS]: 本包的 Host 侧机械门禁；不构造真实 Agent，纯用窄接口假件，故可在 node 环境跑。
 * [PROTOCOL]: 变更时更新此头部，然后检查 src/index.ts
 */

import { describe, expect, it } from 'vitest'

import type { DshTeamMemberRow } from '../src/adapter.js'
import { decodeTeamDetailResponse, decodeTeamListResponse, TeamDecodeError } from '../src/contracts.js'
import { TEAM_DETAIL_PATH, TEAM_LIST_PATH } from '../src/envelope.js'
import { createFactSource, registerRoutes } from '../src/index.js'
import type { TeamFactSource } from '../src/index.js'

/**
 * 假 ctx 的 `get`：复刻 Cordis 的取法——未 inject 的服务返回 undefined（不抛）。
 * 与 proxy-safety.test.ts 的严格代理配对使用：那里验证代理会抛，这里保证业务逻辑读得到。
 */
function withGet(services: Record<string, unknown>): Record<string, unknown> {
  return { ...services, get: (key: string): unknown => services[key] }
}

/** 构造一个最小假 ctx：只提供本插件用到的那两个服务。 */
function fakeCtx(options: {
  rows?: readonly DshTeamMemberRow[]
  membership?: { readonly id: string; readonly name: string } | undefined
  roots?: readonly unknown[]
  withTeams?: boolean
  throwOnList?: boolean
}): unknown {
  const agentTeams = {
    membership: (agent: unknown) => {
      void agent
      return options.withTeams === false ? undefined : options.membership
    },
    listMembers: () => {
      if (options.throwOnList) throw new Error('内部细节不该外泄')
      return options.rows
    },
  }
  return withGet({
    agentTeams: options.withTeams === false ? undefined : agentTeams,
    agents: { roots: () => options.roots ?? [] },
    webServer: { register: () => () => undefined },
  })
}

const rows: readonly DshTeamMemberRow[] = [
  { name: '组长', role: 'lead', status: 'running' },
  { name: '成员乙', role: 'teammate', status: 'inactive' },
  { name: '成员甲', role: 'teammate', status: 'provisioning' },
]

/** 直接跑一个 source，绕开 webServer。 */
const sourceOf = (ctx: unknown): TeamFactSource => createFactSource(ctx as never)

describe('createFactSource — 宿主不支持团队能力时不谎称「没有团队」', () => {
  it('agentTeams 缺席时 list() 返回 null 而非空数组', () => {
    const source = sourceOf(fakeCtx({ withTeams: false }))
    // null = 不支持；[] = 确实没有团队。两者在界面上说不同的话。
    expect(source.list()).toBeNull()
  })

  it('agentTeams 在场但没有团队时返回空数组', () => {
    const source = sourceOf(fakeCtx({ withTeams: true, roots: [], membership: undefined }))
    expect(source.list()).toEqual([])
  })
})

describe('createFactSource — 事实抽取', () => {
  it('lead 会话被投影成一个团队', () => {
    const source = sourceOf(fakeCtx({ roots: ['agent-1'], membership: { id: 'team-1', name: '我的团队' }, rows }))
    const facts = source.list()
    expect(facts).toHaveLength(1)
    expect(facts?.[0]?.id).toBe('team-1')
    expect(facts?.[0]?.members).toHaveLength(3)
  })

  it('没有 lead 的会话不算团队（跳过）', () => {
    const source = sourceOf(fakeCtx({
      roots: ['a'],
      membership: { id: 'team-x', name: 'x' },
      rows: [{ name: '成员', role: 'teammate', status: 'inactive' }],
    }))
    expect(source.list()).toEqual([])
  })

  it('空名字的成员行被丢弃（宁可少一个，也不要无名成员）', () => {
    const source = sourceOf(fakeCtx({
      roots: ['a'],
      membership: { id: 'team-1', name: '团队' },
      rows: [{ name: '', role: 'lead', status: 'running' }, { name: '成员', role: 'teammate', status: 'idle' }],
    }))
    const facts = source.list()
    // lead 行因空名被丢弃 ⇒ 没有 lead ⇒ 该会话不算团队。
    expect(facts).toEqual([])
  })

  it('单个会话取数抛错不影响其它团队', () => {
    const source = sourceOf(fakeCtx({ roots: ['a'], membership: { id: 't', name: 'n' }, rows, throwOnList: true }))
    // listMembers 抛错 ⇒ 该 lead 被跳过，最终没有团队，且异常没冒到调用方。
    expect(source.list()).toEqual([])
  })
})

describe('registerRoutes — 出网前最后一道闸门', () => {
  /** 把注册的 handler 抓出来直接调用。 */
  function capture(
    ctxBase: unknown,
  ): { path: string; handler: (request: Request) => Response | Promise<Response> }[] {
    const captured: { path: string; handler: (request: Request) => Response | Promise<Response> }[] = []
    const ctx = withGet({
      ...(ctxBase as Record<string, unknown>),
      webServer: {
        register: (route: {
          method: string
          path: string
          handler: (request: Request) => Response | Promise<Response>
        }) => {
          captured.push({ path: route.path, handler: route.handler })
          return () => undefined
        },
      },
    })
    registerRoutes(ctx as never, createFactSource(ctx as never))
    return captured
  }

  it('两条路径注册成功且可卸载', () => {
    const ctx = fakeCtx({ roots: ['a'], membership: { id: 't1', name: '团队' }, rows })
    const dispose = registerRoutes(ctx as never, sourceOf(ctx))
    expect(typeof dispose).toBe('function')
    expect(() => dispose()).not.toThrow()
  })

  it('webServer 缺席时安静返回（不崩宿主）', () => {
    const ctx = withGet({ agentTeams: {}, agents: { roots: () => [] } })
    expect(() => registerRoutes(ctx as never, sourceOf(ctx))).not.toThrow()
  })

  it('详情路由缺 teamId 时回 TEAM_RESPONSE_INVALID', async () => {
    const ctx = fakeCtx({ roots: ['a'], membership: { id: 't1', name: '团队' }, rows })
    const routes = capture(ctx)
    const detail = routes.find((route) => route.path === TEAM_DETAIL_PATH)
    expect(detail).toBeDefined()
    const response = await detail!.handler(new Request('http://x/dsh-team/api/v1/local/teams/detail'))
    const body = await response.json()
    expect(body.ok).toBe(false)
    expect(body.code).toBe('TEAM_RESPONSE_INVALID')
  })

  it('列表路由在宿主不支持时回 TEAM_UNSUPPORTED（不是空列表）', async () => {
    const routes = capture(fakeCtx({ withTeams: false }))
    const list = routes.find((route) => route.path === TEAM_LIST_PATH)
    expect(list).toBeDefined()
    const body = await (await list!.handler(new Request('http://x/dsh-team/api/v1/local/teams'))).json()
    // 关键：这里必须是「不支持」，不能是「你还没有团队」的空列表。
    expect(body.ok).toBe(false)
    expect(body.code).toBe('TEAM_UNSUPPORTED')
  })

  it('列表路由产物恰好是 { teams } 键集并可被 Client 解码', async () => {
    const routes = capture(fakeCtx({ roots: ['a'], membership: { id: 't1', name: '团队' }, rows }))
    const list = routes.find((route) => route.path === TEAM_LIST_PATH)
    const response = await list!.handler(new Request('http://x/dsh-team/api/v1/local/teams'))
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json()
    expect(Object.keys(body.data)).toEqual(['teams'])
    expect(decodeTeamListResponse(body.data)).toHaveLength(1)
  })

  it('团队已解散时详情路由回 team: null 而不是报错', async () => {
    const routes = capture(fakeCtx({ roots: ['a'], membership: { id: 't1', name: '团队' }, rows }))
    const detail = routes.find((route) => route.path === TEAM_DETAIL_PATH)
    const body = await (await detail!.handler(
      new Request('http://x/dsh-team/api/v1/local/teams/detail?teamId=不存在'),
    )).json()
    expect(body.ok).toBe(true)
    expect(decodeTeamDetailResponse(body.data)).toEqual({ team: null })
  })
})

describe('出网数据可被 Client 严格解码', () => {
  it('列表路由产物通过 decodeTeamListResponse', async () => {
    const ctx = fakeCtx({ roots: ['a'], membership: { id: 't1', name: '团队' }, rows })
    const source = sourceOf(ctx)
    const { projectTeamList } = await import('../src/project.js')
    const payload = { teams: projectTeamList(source.list() ?? []) }
    expect(() => decodeTeamListResponse(payload)).not.toThrow()
    expect(decodeTeamListResponse(payload)).toHaveLength(1)
  })

  it('详情路由产物通过 decodeTeamDetailResponse，且 lead 恒首位', async () => {
    const ctx = fakeCtx({ roots: ['a'], membership: { id: 't1', name: '团队' }, rows })
    const source = sourceOf(ctx)
    const { projectSummary, projectMember, sortMembers } = await import('../src/project.js')
    const fact = source.find('t1')
    expect(fact).not.toBeNull()
    const payload = {
      team: {
        summary: projectSummary(fact!),
        members: sortMembers(fact!.members).map(projectMember),
      },
    }
    const decoded = decodeTeamDetailResponse(payload)
    expect(decoded.team?.members[0]?.role).toBe('lead')
    expect(decoded.team?.members[0]?.memberId).toBe('组长')
    // 其余成员保持宿主返回的创建顺序，不按字母序重排
    expect(decoded.team?.members.map((m) => m.memberId)).toEqual(['组长', '成员乙', '成员甲'])
  })

  it('未知键会被 Client 判畸形（防宿主多塞字段）', () => {
    expect(() =>
      decodeTeamListResponse({
        teams: [
          {
            teamId: 't',
            name: 'n',
            workspaceLabel: '',
            memberCount: 1,
            active: false,
            createdAt: '2026-01-01T00:00:00.000Z',
            ordinal: 0,
            internalHandle: '不该下发',
          },
        ],
      }),
    ).toThrow(TeamDecodeError)
  })
})