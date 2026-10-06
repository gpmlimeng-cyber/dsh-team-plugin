/**
 * [INPUT]: 依赖 `./contracts.ts` 的 `TeamMemberView`（仅类型）。无 React、无计时器、无 DOM。
 * [OUTPUT]: 暖启动的**唯一判定真源**：三阶段状态机 + 撤遮罩闸门 + 超时兜底（纯函数，可单测）。
 * [POS]: E4 的规则层。暖启动判定必须可测——它是用户对团队功能"第一印象"的来源。
 * [PROTOCOL]: 变更时更新此头部，然后检查 src/warmup.tsx
 *
 * 【为什么需要它】进入团队时后端要拉起各成员运行时 + 注入协作环境。
 * 这段时间如果**静默禁用**若干操作，用户只觉得"卡了一下"，还会去做无效操作。
 *
 * 【最关键的一条：撤遮罩闸门 = 组长就绪，不等全员】
 * 若等全员就绪，一个成员起不来就会**卡死整个团队**——用户会以为产品坏了。
 * 组长一好就撤遮罩：用户进团队第一件事是跟组长说目标，组长一好就能开工。
 * 某个成员起不来，只在它自己的胶囊上显示"启动失败·可重试"，**不阻塞**其他成员。
 *
 * 移植自 AionUi（Apache-2.0）：`renderer/pages/team/hooks/useTeamWarmup.ts` + `components/TeamWarmupOverlay.tsx`
 */

import type { TeamMemberView } from './contracts.js'

/** 暖启动三阶段。`ready` 表示遮罩已撤。 */
export type WarmupPhase = 'warming' | 'ready' | 'error'

/** 触发**失败态**的两种原因（区别对待：超时给不同的下一步）。 */
export type WarmupErrorKind = 'lead_failed' | 'timeout'

/** 默认超时（毫秒）。与 AionUi 同量级；宿主信号迟到时不至于无限转圈。 */
export const WARMUP_TIMEOUT_MS = 20_000

/** 成员是否处于「尚未就绪」。 */
export function isPendingMember(member: TeamMemberView): boolean {
  return member.status === 'starting' || member.starting
}

/** 已就绪成员数（进度文案用）。 */
export function readyMemberCount(members: readonly TeamMemberView[]): number {
  return members.filter((member) => !isPendingMember(member)).length
}

/** 组长（取第一个 lead；没有则 null——团队总有组长，但类型上允许缺）。 */
export function findLead(members: readonly TeamMemberView[]): TeamMemberView | null {
  return members.find((member) => member.role === 'lead') ?? null
}

/**
 * 由成员列表派生暖启动阶段——**核心判定，纯函数**。
 *
 * 判定顺序（顺序本身是产品决策）：
 * 1. 没有任何成员（还没取到 / 团队已空）⇒ 仍在 warming（不假装就绪）。
 * 2. **组长失败** ⇒ `error`（`lead_failed`）：用户没法开工，必须让用户处理。
 * 3. **组长还在启动** ⇒ `warming`。
 * 4. 组长就绪 ⇒ **`ready`**，其余成员起没起来**一律不管**。
 * 5. 组长时间未就绪且已超时 ⇒ `error`（`timeout`）。
 *
 * @param members - 当前成员列表
 * @param timedOut - 是否已超过超时时限（由调用方计时，不由本函数读时钟——便于测试）
 */
export function deriveWarmupPhase(
  members: readonly TeamMemberView[],
  timedOut: boolean,
): { phase: WarmupPhase; errorKind: WarmupErrorKind | null } {
  if (members.length === 0) {
    // 成员还没到齐：遮罩留着，但**不算失败**（可能是加载中）。
    return { phase: 'warming', errorKind: null }
  }

  const lead = findLead(members)
  // 无组长：无法用组长做闸门，退化为「全员就绪」判定，避免永远卡在遮罩下。
  if (!lead) {
    const allReady = members.every((member) => !isPendingMember(member))
    if (allReady) return { phase: 'ready', errorKind: null }
    if (timedOut) return { phase: 'error', errorKind: 'timeout' }
    return { phase: 'warming', errorKind: null }
  }

  if (lead.status === 'failed') return { phase: 'error', errorKind: 'lead_failed' }
  if (isPendingMember(lead)) {
    // 组长还在启动：到点仍未就绪才判超时，不无限转圈。
    return timedOut
      ? { phase: 'error', errorKind: 'timeout' }
      : { phase: 'warming', errorKind: null }
  }

  // 组长就绪即撤遮罩——不管其它成员。
  return { phase: 'ready', errorKind: null }
}

/** 失败成员的 id 列表（用于在它们自己的胶囊上标红，而不是遮全局）。 */
export function failedMemberIds(members: readonly TeamMemberView[]): string[] {
  return members.filter((member) => member.status === 'failed').map((member) => member.memberId)
}

/**
 * 遮罩期间的禁用清单。
 *
 * **允许**：切视图、切成员、滚动——这些都不依赖成员就绪。
 * **禁止**：发消息（遮罩盖住输入区，天然禁用）。
 *
 * 之所以显式列出来：让"能不能点"有唯一判据，而不是各处 if 各自决定。
 */
export const WARMUP_BLOCKED_ACTIONS = ['send_message', 'add_member', 'remove_member', 'rename_member'] as const
export type WarmupBlockedAction = (typeof WARMUP_BLOCKED_ACTIONS)[number]

export function isBlockedDuringWarmup(phase: WarmupPhase, action: WarmupBlockedAction): boolean {
  // 遮罩期间一律禁用这四类动作。参数 `action` 目前未参与判定——保留它是为了让调用方
  // 能问「这个动作此刻能不能做」，将来若有动作豁免（如同视图切换）不必改调用点。
  void action
  return phase === 'warming'
}