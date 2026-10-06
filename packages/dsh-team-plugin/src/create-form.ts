/**
 * [INPUT]: 依赖 `./copy.ts` 取文案（不直接写字面量）。无 React、无 fetch。
 * [OUTPUT]: 新建团队弹窗的**表单状态机 + 校验规则**（纯逻辑，可单测）。
 * [POS]: Client 半「新建团队」的规则真源。校验口径只允许写在这里，组件只负责渲染。
 * [PROTOCOL]: 变更时更新此头部，然后检查 src/create-dialog.tsx
 *
 * 为什么单独成文件：校验规则（必须选成员 / 必须指定且只能指定一个组长 / 名字必填）
 * 是产品宪法，不能埋在 JSX 里。这里导出纯函数，便于把「哪些情况不许提交」钉死成用例。
 */

import {
  TEAM_CREATE_NAME_LABEL,
  TEAM_CREATE_NAME_PLACEHOLDER,
  TEAM_CREATE_NAME_REQUIRED,
  TEAM_CREATE_LEADER_REQUIRED,
  TEAM_CREATE_MEMBER_REQUIRED,
  TEAM_CREATE_NO_AVAILABLE,
  TEAM_CREATE_PREFILL_PLACEHOLDER,
  TEAM_CREATE_SUBMIT,
  TEAM_CREATE_TITLE,
  TEAM_CREATE_SUBMITTING,
  TEAM_CREATE_CANCEL,
  TEAM_CREATE_LEADER_HINT,
} from './copy.js'

/** 可选成员（尚未加入团队的智能体）。 */
export interface CreateCandidate {
  readonly id: string
  readonly name: string
}

export interface CreateFormState {
  readonly name: string
  readonly leaderId: string | null
  readonly memberIds: readonly string[]
}

export const EMPTY_CREATE_FORM: CreateFormState = { name: '', leaderId: null, memberIds: [] }

/** 团队名长度上限（与 Host 解码侧 `NAME_MAX` 对齐，超长会被 Host 判畸形）。 */
export const CREATE_NAME_MAX = 120

/** 校验结果的两种形态：要么给错，要么给可提交的载荷。 */
export type CreateValidation =
  | { readonly ok: false; readonly code: CreateErrorCode }
  | { readonly ok: true; readonly name: string; readonly leaderId: string; readonly memberIds: readonly string[] }

export type CreateErrorCode = 'TEAM_CREATE_NAME_REQUIRED' | 'TEAM_CREATE_MEMBER_REQUIRED' | 'TEAM_CREATE_LEADER_REQUIRED'

const VALIDATION_COPY: Readonly<Record<CreateErrorCode, string>> = {
  TEAM_CREATE_NAME_REQUIRED: TEAM_CREATE_NAME_REQUIRED,
  TEAM_CREATE_MEMBER_REQUIRED: TEAM_CREATE_MEMBER_REQUIRED,
  TEAM_CREATE_LEADER_REQUIRED: TEAM_CREATE_LEADER_REQUIRED,
}

export function createValidationCopy(code: CreateErrorCode): string {
  return VALIDATION_COPY[code]
}

/**
 * 表单是否合法。
 *
 * 三条硬规则（与 AionUi 一致，但更严一档：AionUi 允许「先选组长再选成员」，
 * 这里要求**组长必须在成员名单里**，否则组长本人不会被纳入团队，语义会矛盾）：
 * 1. 团队名非空（trim 后）
 * 2. 至少一名成员
 * 3. 恰好一名组长，且该组长在成员名单内
 */
export function validateCreateForm(form: CreateFormState): CreateValidation {
  const name = form.name.trim()
  if (name.length === 0 || name.length > CREATE_NAME_MAX) {
    return { ok: false, code: 'TEAM_CREATE_NAME_REQUIRED' }
  }
  if (form.memberIds.length === 0) {
    return { ok: false, code: 'TEAM_CREATE_MEMBER_REQUIRED' }
  }
  if (form.leaderId === null || !form.memberIds.includes(form.leaderId)) {
    return { ok: false, code: 'TEAM_CREATE_LEADER_REQUIRED' }
  }
  return { ok: true, name, leaderId: form.leaderId, memberIds: [...form.memberIds] }
}

/** 切换成员勾选：组长若被取消，自动解除组长（不留悬空状态）。 */
export function toggleMember(form: CreateFormState, memberId: string): CreateFormState {
  const selected = form.memberIds.includes(memberId)
  const memberIds = selected ? form.memberIds.filter((id) => id !== memberId) : [...form.memberIds, memberId]
  const leaderId = selected && form.leaderId === memberId ? null : form.leaderId
  return { ...form, memberIds, leaderId }
}

/** 指定组长。**只能从已勾选的成员里选**，故不会出现"组长不在名单里"的矛盾态。 */
export function chooseLeader(form: CreateFormState, memberId: string): CreateFormState {
  if (!form.memberIds.includes(memberId)) return form
  return { ...form, leaderId: form.leaderId === memberId ? null : memberId }
}

/** 弹层静态文案（集中在此，组件不写字面量）。 */
export const CREATE_DIALOG = {
  title: TEAM_CREATE_TITLE,
  nameLabel: TEAM_CREATE_NAME_LABEL,
  namePlaceholder: TEAM_CREATE_NAME_PLACEHOLDER,
  /** 组长区标题。 */
  leaderLabel: TEAM_CREATE_LEADER_HINT,
  submit: TEAM_CREATE_SUBMIT,
  submitting: TEAM_CREATE_SUBMITTING,
  empty: TEAM_CREATE_NO_AVAILABLE,
  cancel: TEAM_CREATE_CANCEL,
} as const

/**
 * 「不会用」时的引导。
 *
 * 与空态同理：不假装用户能凭空想出团队配置，直接给一句可以照抄的说法。
 */
export const CREATE_DIALOG_HINT = TEAM_CREATE_PREFILL_PLACEHOLDER