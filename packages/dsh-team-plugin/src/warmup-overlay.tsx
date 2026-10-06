/**
 * [INPUT]: 依赖 `./warmup.ts`（判定）、`./identity.ts`（取色）、`./copy.ts`（文案）；React createElement。
 * [OUTPUT]: 暖启动遮罩的**纯呈现组件**（无 hook、无计时器，可直接函数调用测试）。
 * [POS]: E4 的渲染层。阶段判定全部来自 warmup.ts，本文件只负责画。
 * [PROTOCOL]: 变更时更新此头部，然后检查 src/client.tsx
 *
 * 两种形态：
 * - `warming`：磨砂遮罩 + 成员逐个点亮 + 「唤醒中 N/M」+ 进度条
 * - `error`：错误卡片（**组长失败** 与 **超时** 给不同的下一步），带重试与返回
 *
 * `ready` 时**整块返回 null**——不是 opacity:0，是根本不进 DOM。
 */

import { createElement, type ReactNode } from 'react'

import {
  TEAM_WARMUP_ARIA,
  TEAM_WARMUP_BACK,
  TEAM_WARMUP_LEAD_FAILED_NEXT,
  TEAM_WARMUP_LEAD_FAILED_TITLE,
  TEAM_WARMUP_PROGRESS,
  TEAM_WARMUP_RETRY,
  TEAM_WARMUP_TIMEOUT_NEXT,
  TEAM_WARMUP_TIMEOUT_TITLE,
} from './copy.js'
import { memberColorValue, type MemberColorMap } from './identity.js'
import { deriveWarmupPhase, isPendingMember, readyMemberCount, type WarmupErrorKind } from './warmup.js'
import type { TeamMemberView } from './contracts.js'

/** 进度条比例（0~1）。就绪 0 人时给 0，不给 NaN。 */
function progressRatio(ready: number, total: number): number {
  return total <= 0 ? 0 : Math.min(1, Math.max(0, ready / total))
}

/** 错误态卡片。失败原因不同 ⇒ 说的话不同。 */
function WarmupErrorCard(props: {
  readonly kind: WarmupErrorKind
  readonly onRetry?: (() => void) | undefined
  readonly onBack?: (() => void) | undefined
}): ReactNode {
  const isTimeout = props.kind === 'timeout'
  return createElement(
    'div',
    { role: 'alert', 'data-warmup-error': props.kind },
    createElement('h2', null, isTimeout ? TEAM_WARMUP_TIMEOUT_TITLE : TEAM_WARMUP_LEAD_FAILED_TITLE),
    createElement('p', null, isTimeout ? TEAM_WARMUP_TIMEOUT_NEXT : TEAM_WARMUP_LEAD_FAILED_NEXT),
    // 回调缺席时不画死按钮
    props.onRetry
      ? createElement('button', { type: 'button', 'data-warmup-retry': 'true', onClick: props.onRetry }, TEAM_WARMUP_RETRY)
      : null,
    props.onBack
      ? createElement('button', { type: 'button', 'data-warmup-back': 'true', onClick: props.onBack }, TEAM_WARMUP_BACK)
      : null,
  )
}

/**
 * 暖启动遮罩。
 *
 * @param timedOut - 是否已超时。由**调用方**计时传入，本组件不读时钟——纯呈现、可测。
 */
export function TeamWarmupOverlay(props: {
  readonly members: readonly TeamMemberView[]
  readonly colorMap: MemberColorMap
  readonly timedOut: boolean
  readonly onRetry?: (() => void) | undefined
  readonly onBack?: (() => void) | undefined
}): ReactNode {
  const { phase, errorKind } = deriveWarmupPhase(props.members, props.timedOut)

  // 就绪 ⇒ 整块不进 DOM（不是隐藏，是不存在）。
  if (phase === 'ready') return null

  if (phase === 'error' && errorKind) {
    return createElement(WarmupErrorCard, { kind: errorKind, onRetry: props.onRetry, onBack: props.onBack })
  }

  const total = props.members.length
  const ready = readyMemberCount(props.members)
  const ratio = progressRatio(ready, total)

  return createElement(
    'div',
    {
      role: 'status',
      'aria-label': TEAM_WARMUP_ARIA,
      'data-warmup-overlay': 'true',
    },
    // 成员逐个点亮：已就绪的用自身身份色，未就绪的用中性色
    createElement(
      'div',
      { 'data-warmup-avatars': 'true' },
      props.members.map((member) =>
        createElement('span', {
          key: member.memberId,
          'data-warmup-avatar': member.memberId,
          'data-warmup-avatar-lit': isPendingMember(member) ? 'false' : 'true',
          style: {
            background: isPendingMember(member)
              ? 'var(--color-fill-quaternary, #eee)'
              : memberColorValue(props.colorMap, member.memberId),
          },
        }),
      ),
    ),
    createElement('p', { 'data-warmup-progress': 'true' }, TEAM_WARMUP_PROGRESS(ready, total)),
    createElement('progress', { 'data-warmup-bar': 'true', value: ratio, max: 1 }),
  )
}