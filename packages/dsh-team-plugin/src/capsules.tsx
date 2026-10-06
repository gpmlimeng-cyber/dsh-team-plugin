/**
 * [INPUT]: 依赖 `./identity.ts`（取色规则）、`./copy.ts`（文案）；React createElement。
 * [OUTPUT]: 成员胶囊栏的**纯呈现组件**——横向成员胶囊 + 状态点 + 身份色（无 hook，可直接函数调用测试）。
 * [POS]: E2 的渲染层。全部取色经 identity.ts，全部文案经 copy.ts，本文件不写死规则与字面量。
 * [PROTOCOL]: 变更时更新此头部，然后检查 src/panel.tsx
 *
 * 交互口径（与 AionUi 对齐）：
 * - **组长恒在首位且不可移除**（拖拽/删除都不作用于他）。
 * - hover 才出现移除按钮，平时不占位、不杂乱。
 * - 选中态明显：身份色描边 + 底色加深。
 * - 失败成员一眼可见：状态点用警示色 + 状态词（不只靠颜色区分——色弱用户也要能分辨）。
 */

import { createElement, type ReactNode } from 'react'

import type { TeamMemberStatus, TeamMemberView } from './contracts.js'
import {
  MEMBER_SELECTED_MIX,
  MEMBER_SOFT_MIX,
  memberColorValue,
  type MemberColorMap,
} from './identity.js'
import { TEAM_MEMBER_REMOVE_LABEL, TEAM_MEMBER_LEADER_BADGE, TEAM_PENDING_LABEL } from './copy.js'

/** 状态点颜色：语义色而非成员色——避免与身份色混淆。 */
const STATUS_DOT_COLOR: Readonly<Record<TeamMemberStatus, string>> = {
  idle: 'var(--color-text-tertiary, #888)',
  active: 'var(--color-text-success, #3a9)',
  starting: 'var(--color-text-warning, #c93)',
  failed: 'var(--color-text-error, #d55)',
  dormant: 'var(--color-text-quaternary, #aaa)',
}

/** 单个成员胶囊。 */
export function MemberCapsule(props: {
  readonly member: TeamMemberView
  readonly colorMap: MemberColorMap
  readonly active: boolean
  readonly onSelect: (memberId: string) => void
  readonly onRemove?: ((memberId: string) => void) | undefined
}): ReactNode {
  const { member } = props
  const color = memberColorValue(props.colorMap, member.memberId)
  const isLeader = member.role === 'lead'

  return createElement(
    'div',
    {
      // 整块可点 = 点击胶囊切到该成员（与 AionUi 一致：点胶囊即切换）
      role: 'tab',
      tabIndex: 0,
      'aria-selected': props.active,
      'data-member-capsule': member.memberId,
      'data-member-role': member.role,
      'data-member-active': props.active ? 'true' : 'false',
      style: {
        // 身份色以 CSS 变量下发，样式表统一用 var(--mc) 派生浅底/描边
        '--mc': color,
        background: `color-mix(in srgb, ${color} ${props.active ? MEMBER_SELECTED_MIX : MEMBER_SOFT_MIX}, var(--bg-base, #fff))`,
        borderColor: props.active ? color : 'transparent',
      },
      onClick: () => props.onSelect(member.memberId),
      onKeyDown: (event: { key: string }) => {
        // 键盘可达：Enter / Space 等同点击
        if (event.key === 'Enter' || event.key === ' ') props.onSelect(member.memberId)
      },
    },
    // 状态点：色 + 词双编码（不只靠颜色）
    createElement('span', {
      'data-member-status-dot': member.status,
      'aria-hidden': true,
      style: { background: STATUS_DOT_COLOR[member.status] },
    }),
    // 身份色落在名字上——这是「一眼分清谁是谁」的主承载
    createElement(
      'span',
      { 'data-member-name': 'true', style: { color } },
      member.memberId,
    ),
    isLeader ? createElement('span', { 'data-member-leader-badge': 'true' }, TEAM_MEMBER_LEADER_BADGE) : null,
    createElement('span', { 'data-member-status-text': 'true' }, member.statusText),
    // 待确认角标：有才画，不做常驻占位
    member.pendingCount > 0
      ? createElement('span', { 'data-member-pending': 'true', title: TEAM_PENDING_LABEL }, String(member.pendingCount))
      : null,
    // 组长不可移除；移除回调缺席时也不给死按钮
    !isLeader && props.onRemove
      ? createElement('button', {
          type: 'button',
          'data-member-remove': member.memberId,
          'aria-label': `${TEAM_MEMBER_REMOVE_LABEL}：${member.memberId}`,
          onClick: (event: { stopPropagation: () => void }) => {
            event.stopPropagation()
            props.onRemove?.(member.memberId)
          },
        })
      : null,
  )
}

/**
 * 成员胶囊栏。
 *
 * 只在成员数 > 1 时渲染——单成员团队不需要"选谁"的胶囊栏。
 */
export function MemberCapsuleBar(props: {
  readonly members: readonly TeamMemberView[]
  readonly colorMap: MemberColorMap
  readonly activeMemberId: string | null
  readonly onSelect: (memberId: string) => void
  readonly onRemove?: ((memberId: string) => void) | undefined
}): ReactNode {
  // 组长恒首位由 Host 保证（见 project.sortMembers），本层不再排序。
  if (props.members.length <= 1) return null

  return createElement(
    'div',
    { role: 'tablist', 'aria-label': '团队成员', 'data-member-bar': 'true' },
    props.members.map((member) =>
      createElement(MemberCapsule, {
        key: member.memberId,
        member,
        colorMap: props.colorMap,
        active: member.memberId === props.activeMemberId,
        onSelect: props.onSelect,
        onRemove: props.onRemove,
      }),
    ),
  )
}