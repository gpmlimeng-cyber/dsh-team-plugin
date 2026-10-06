/**
 * [INPUT]: 依赖 `./create-form.ts`（表单规则）、`./copy.ts`（文案）；React createElement。
 * [OUTPUT]: 新建团队弹层的**纯呈现组件**（无 hook，可直接函数调用做测试）。
 * [POS]: 「新建团队」的渲染层。全部规则来自 create-form，全部文案来自 copy。
 * [PROTOCOL]: 变更时更新此头部，然后检查 src/client.tsx
 */

import { createElement, type ReactNode } from 'react'

import {
  CREATE_DIALOG,
  CREATE_DIALOG_HINT,
  chooseLeader,
  createValidationCopy,
  toggleMember,
  validateCreateForm,
  type CreateCandidate,
  type CreateFormState,
} from './create-form.js'

/** 一行候选成员。组长用单选（radio），普通成员用多选（checkbox）。 */
function CandidateRow(props: {
  readonly candidate: CreateCandidate
  readonly form: CreateFormState
  readonly onToggle: (memberId: string) => void
  readonly onChooseLeader: (memberId: string) => void
}): ReactNode {
  const { candidate, form } = props
  const checked = form.memberIds.includes(candidate.id)
  const isLeader = form.leaderId === candidate.id

  return createElement(
    'li',
    { 'data-create-candidate': candidate.id },
    createElement('label', null, candidate.name),
    // 组长单选：只在**已勾选**的成员里可点，杜绝「组长不在名单里」的矛盾态。
    createElement('input', {
      type: 'radio',
      name: 'create-team-leader',
      value: candidate.id,
      checked: isLeader,
      // 未勾选时组长单选不可用——不给能点却无效的死控件。
      disabled: !checked,
      'aria-label': `设为组长：${candidate.name}`,
      onChange: () => props.onChooseLeader(candidate.id),
    }),
    createElement('input', {
      type: 'checkbox',
      value: candidate.id,
      checked,
      'aria-label': `选择成员：${candidate.name}`,
      onChange: () => props.onToggle(candidate.id),
    }),
  )
}

/**
 * 新建团队弹层。
 *
 * **不静默拒绝提交**：不合法时按钮为 disabled，并把原因写在页面上（`aria-describedby` 指过去），
 * 而不是在用户点下去后才弹一条错误。
 */
export function TeamCreateDialog(props: {
  readonly open: boolean
  readonly candidates: readonly CreateCandidate[]
  readonly form: CreateFormState
  readonly submitting: boolean
  readonly onNameChange: (name: string) => void
  readonly onToggle: (memberId: string) => void
  readonly onChooseLeader: (memberId: string) => void
  readonly onSubmit: () => void
  readonly onCancel: () => void
}): ReactNode {
  if (!props.open) return null

  const validation = validateCreateForm(props.form)
  const canSubmit = validation.ok && !props.submitting
  const reasonText = validation.ok ? null : createValidationCopy(validation.code)
  const hintId = 'create-team-reason'
  const noCandidates = props.candidates.length === 0

  return createElement(
    'div',
    { role: 'dialog', 'aria-modal': true, 'aria-label': CREATE_DIALOG.title, 'data-create-dialog': 'true' },
    createElement('h2', null, CREATE_DIALOG.title),

    createElement('label', { htmlFor: 'create-team-name' }, CREATE_DIALOG.nameLabel),
    createElement('input', {
      id: 'create-team-name',
      type: 'text',
      value: props.form.name,
      placeholder: CREATE_DIALOG.namePlaceholder,
      'aria-describedby': reasonText ? hintId : undefined,
      onChange: (event: { target: { value: string } }) => props.onNameChange(event.target.value),
    }),

    // 可见的资格说明，而不是把规则藏进文档。
    createElement('p', { 'data-create-leader-hint': 'true' }, CREATE_DIALOG.leaderLabel),

    noCandidates
      ? createElement('p', { 'data-create-empty': 'true' }, CREATE_DIALOG.empty)
      : createElement(
          'ul',
          { 'data-create-candidates': 'true' },
          props.candidates.map((candidate) =>
            createElement(CandidateRow, {
              key: candidate.id,
              candidate,
              form: props.form,
              onToggle: props.onToggle,
              onChooseLeader: props.onChooseLeader,
            }),
          ),
        ),

    createElement('p', { 'data-create-hint': 'true' }, CREATE_DIALOG_HINT),

    // 不合法原因**写在页面上**，与被描述的控件用 aria-describedby 关联。
    reasonText ? createElement('p', { id: hintId, role: 'alert' }, reasonText) : null,

    createElement(
      'button',
      {
        type: 'button',
        'data-create-submit': 'true',
        disabled: !canSubmit,
        onClick: props.onSubmit,
      },
      props.submitting ? CREATE_DIALOG.submitting : CREATE_DIALOG.submit,
    ),
    createElement('button', { type: 'button', 'data-create-cancel': 'true', onClick: props.onCancel }, CREATE_DIALOG.cancel),
  )
}

export { toggleMember, chooseLeader, validateCreateForm }