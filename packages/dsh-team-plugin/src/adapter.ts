/**
 * [INPUT]: 依赖 `./project.ts` 的 RawMemberFact/RawTeamFact；不依赖 Cordis（DSH 类型以窄结构镜像声明）。
 * [OUTPUT]: DSH `agentTeams` 服务 → 本插件原始事实的**唯一适配器**。
 * [POS]: Host 半的边界层。所有「DSH 的状态怎么翻译成团队事实」的判断只写在这里。
 * [PROTOCOL]: 变更时更新此头部，然后检查 src/index.ts
 *
 * ⚠️ 为什么镜像声明而不 import：
 * 本包不 import 官方 @deepseek-ai/* 的运行期类型（它们不在 peer 依赖里，且形状会随官方升级漂移）。
 * 这里只镜像本插件**实际用到**的那几个字段，用窄结构精确对齐 `agentTeams` 的契约；
 * 宿主真源是 `ctx.agentTeams`，本文件只负责取数与翻译，取不到就交 undefined，绝不臆造。
 */

import type { RawMemberFact, RawTeamFact } from './project.js'

/**
 * DSH 团队成员状态（对齐 `agentTeams.listMembers()` 的 `TeamMemberView.status`）。
 *
 * 官方取值只有四个：running / inactive / provisioning / failed。
 * 本插件额外定义 `dormant`：表示「成员存在但未激活」。
 * 官方没有这个值，故默认不产出——见 `deriveMemberStatus` 的注释。
 */
export type DshMemberStatus = 'running' | 'inactive' | 'provisioning' | 'failed' | 'dormant'

/** `agentTeams.listMembers()` 返回行里，本插件真正用到的窄结构。 */
export interface DshTeamMemberRow {
  readonly name: string
  readonly role: 'lead' | 'teammate'
  readonly status: DshMemberStatus
  readonly diagnostics?: readonly string[]
}

/** `agentTeams.membership()` 里，本插件用到的窄结构。 */
export interface DshTeamMembership {
  readonly id: string
  readonly role: 'lead' | 'teammate'
  readonly name: string
}

/** 待确认的权限条数。官方未在 roster 行里给出，故为可缺省。 */
export interface PendingApprovalFact {
  readonly memberName: string
  readonly count: number
}

/** 官方 roster 行 → 本插件成员事实。 */
export function memberRowToFact(row: DshTeamMemberRow, pendingCount = 0): RawMemberFact {
  return {
    name: row.name,
    lead: row.role === 'lead',
    busy: row.status === 'running',
    starting: row.status === 'provisioning',
    failed: row.status === 'failed',
    dormant: row.status === 'dormant',
    pendingCount: pendingCount >= 0 ? pendingCount : 0,
  }
}

/**
 * 官方 roster 行 → 成员事实（不过滤非法行）。
 *
 * 非法行（空名字）直接丢弃而不是降级成某个默认值——**宁可少一个成员，也不要在界面上
 * 出现一个无名成员**。调用方据此知道真实人数可能少于 `listMembers()` 的长度。
 */
export function toMemberFacts(
  rows: readonly DshTeamMemberRow[] | undefined,
  pending: readonly PendingApprovalFact[] = [],
): RawMemberFact[] {
  if (!Array.isArray(rows)) return []
  const pendingByName = new Map(pending.map((item) => [item.memberName, item.count]))
  return rows
    .filter((row) => typeof row?.name === 'string' && row.name.length > 0)
    .map((row) => memberRowToFact(row, pendingByName.get(row.name) ?? 0))
}

/**
 * 由 lead 会话 id + 成员行组装团队事实。
 *
 * `leadSessionId` 即团队标识：DSH 的 Team 由「Lead Session 日志」支撑，故 lead 会话就是团队本身。
 */
export function toTeamFact(input: {
  readonly leadSessionId: string
  readonly name: string
  readonly workspaceLabel: string
  readonly createdAtMs: number
  readonly lastActiveMs: number
  readonly rows: readonly DshTeamMemberRow[] | undefined
  readonly pending?: readonly PendingApprovalFact[]
}): RawTeamFact {
  return {
    id: input.leadSessionId,
    name: input.name,
    workspaceLabel: input.workspaceLabel,
    createdAtMs: input.createdAtMs,
    lastActiveMs: input.lastActiveMs,
    members: toMemberFacts(input.rows, input.pending ?? []),
  }
}