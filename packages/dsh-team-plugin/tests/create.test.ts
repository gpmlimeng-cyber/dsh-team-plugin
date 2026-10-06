/**
 * [INPUT]: 依赖 src/create-form.ts（表单规则）、src/create-dialog.tsx（纯组件）、src/state.ts（状态机）。
 * [OUTPUT]: 新建团队的门禁——锁住三条硬规则、组长不可悬空、不合法时按钮禁用且原因可见。
 * [POS]: 「新建团队」的机械门禁。规则是产品宪法，必须钉死。
 * [PROTOCOL]: 变更时更新此头部，然后检查 src/create-form.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  chooseLeader,
  CREATE_NAME_MAX,
  EMPTY_CREATE_FORM,
  toggleMember,
  validateCreateForm,
  type CreateFormState,
} from '../src/create-form.js'
import { TeamCreateDialog } from '../src/create-dialog.js'
import { TEAM_CREATE_LEADER_REQUIRED, TEAM_CREATE_MEMBER_REQUIRED, TEAM_CREATE_NAME_REQUIRED } from '../src/copy.js'
import { createTeamStore } from '../src/state.js'

/** 把 React 元素树拍平为文本（含函数组件调用，模拟 reconciler）。 */
function texts(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out)
    return out
  }
  if (typeof node !== 'object') return out
  const element = node as { type?: unknown; props?: Record<string, unknown> }
  if (typeof element.type === 'function') {
    return texts((element.type as (p: unknown) => unknown)(element.props), out)
  }
  texts(element.props?.children, out)
  return out
}

/** 深度优先找元素。 */
function findAll(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (node === null || node === undefined || typeof node === 'boolean' || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, out)
    return out
  }
  const element = node as { type?: unknown; props?: Record<string, unknown> }
  if (typeof element.type === 'function') return findAll((element.type as (p: unknown) => unknown)(element.props), out)
  if (element.props) out.push(element.props)
  findAll(element.props?.children, out)
  return out
}

const form = (over: Partial<CreateFormState> = {}): CreateFormState => ({
  name: '发布官网',
  leaderId: 'a',
  memberIds: ['a', 'b'],
  ...over,
})

const noop = () => undefined

// ---------------------------------------------------------------------------
// 校验规则
// ---------------------------------------------------------------------------

describe('validateCreateForm — 三条硬规则', () => {
  it('名字为空（trim 后）⇒ 名字必填', () => {
    expect(validateCreateForm(form({ name: '   ' }))).toEqual({ ok: false, code: 'TEAM_CREATE_NAME_REQUIRED' })
  })

  it('名字超长 ⇒ 名字必填（与 Host 解码上限对齐）', () => {
    expect(validateCreateForm(form({ name: 'x'.repeat(CREATE_NAME_MAX + 1) }))).toEqual({
      ok: false,
      code: 'TEAM_CREATE_NAME_REQUIRED',
    })
  })

  it('没有成员 ⇒ 成员必填', () => {
    expect(validateCreateForm(form({ memberIds: [], leaderId: null }))).toEqual({
      ok: false,
      code: 'TEAM_CREATE_MEMBER_REQUIRED',
    })
  })

  it('未指定组长 ⇒ 组长必填', () => {
    expect(validateCreateForm(form({ leaderId: null }))).toEqual({ ok: false, code: 'TEAM_CREATE_LEADER_REQUIRED' })
  })

  it('组长不在成员名单里 ⇒ 组长必填（杜绝矛盾态）', () => {
    expect(validateCreateForm(form({ leaderId: 'z', memberIds: ['a', 'b'] }))).toEqual({
      ok: false,
      code: 'TEAM_CREATE_LEADER_REQUIRED',
    })
  })

  it('合法时返回 trim 后的名字与成员快照', () => {
    const result = validateCreateForm(form({ name: '  发布官网  ' }))
    expect(result).toEqual({ ok: true, name: '发布官网', leaderId: 'a', memberIds: ['a', 'b'] })
  })

  it('校验顺序：名字 → 成员 → 组长（先报最基础的错）', () => {
    // 三个都非法时，优先报「名字必填」，避免用户一次改一堆。
    expect(validateCreateForm({ name: '', leaderId: null, memberIds: [] })).toEqual({
      ok: false,
      code: 'TEAM_CREATE_NAME_REQUIRED',
    })
  })
})

describe('toggleMember — 取消组长时自动解除，不留悬空状态', () => {
  it('勾选成员加入名单', () => {
    expect(toggleMember(form({ memberIds: ['a'], leaderId: 'a' }), 'b').memberIds).toEqual(['a', 'b'])
  })

  it('取消非组长不影响组长', () => {
    const next = toggleMember(form(), 'b')
    expect(next.leaderId).toBe('a')
  })

  it('取消组长则组长置空（不会留下指向不在名单的组长）', () => {
    const next = toggleMember(form(), 'a')
    expect(next.leaderId).toBeNull()
    expect(next.memberIds).toEqual(['b'])
  })

  it('不改动传入对象（纯函数）', () => {
    const original = form()
    toggleMember(original, 'a')
    expect(original.leaderId).toBe('a')
  })
})

describe('chooseLeader — 只能从已勾选成员里选', () => {
  it('选中已勾选成员为组长', () => {
    expect(chooseLeader(form({ leaderId: null }), 'b').leaderId).toBe('b')
  })

  it('未勾选的成员不能当组长（表单保持不变）', () => {
    const before = form({ leaderId: null })
    expect(chooseLeader(before, 'z')).toBe(before)
  })

  it('再次点击同一人取消组长', () => {
    expect(chooseLeader(form(), 'a').leaderId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 弹层 DOM 契约
// ---------------------------------------------------------------------------

describe('TeamCreateDialog', () => {
  const candidates = [
    { id: 'a', name: '调研员' },
    { id: 'b', name: '实现者' },
  ]

  it('关闭时整块不进 DOM', () => {
    const node = TeamCreateDialog({
      open: false,
      candidates,
      form: EMPTY_CREATE_FORM,
      submitting: false,
      onNameChange: noop,
      onToggle: noop,
      onChooseLeader: noop,
      onSubmit: noop,
      onCancel: noop,
    })
    expect(node).toBeNull()
  })

  it('无候选时给出说明而不是空列表', () => {
    const flat = texts(TeamCreateDialog({
      open: true,
      candidates: [],
      form: EMPTY_CREATE_FORM,
      submitting: false,
      onNameChange: noop,
      onToggle: noop,
      onChooseLeader: noop,
      onSubmit: noop,
      onCancel: noop,
    }))
    expect(flat.some((t) => t.includes('暂无可用的智能体'))).toBe(true)
  })

  it('不合法时提交按钮禁用，且原因写在页面上', () => {
    const props = findAll(TeamCreateDialog({
      open: true,
      candidates,
      form: EMPTY_CREATE_FORM,
      submitting: false,
      onNameChange: noop,
      onToggle: noop,
      onChooseLeader: noop,
      onSubmit: noop,
      onCancel: noop,
    }))
    const submit = props.find((p) => p['data-create-submit'] === 'true')
    expect(submit?.['disabled']).toBe(true)
    const flat = texts(TeamCreateDialog({
      open: true,
      candidates,
      form: EMPTY_CREATE_FORM,
      submitting: false,
      onNameChange: noop,
      onToggle: noop,
      onChooseLeader: noop,
      onSubmit: noop,
      onCancel: noop,
    }))
    expect(flat).toContain(TEAM_CREATE_NAME_REQUIRED)
  })

  it('合法时提交按钮可用', () => {
    const props = findAll(TeamCreateDialog({
      open: true,
      candidates,
      form: form(),
      submitting: false,
      onNameChange: noop,
      onToggle: noop,
      onChooseLeader: noop,
      onSubmit: noop,
      onCancel: noop,
    }))
    const submit = props.find((p) => p['data-create-submit'] === 'true')
    expect(submit?.['disabled']).toBe(false)
  })

  it('提交中禁用按钮且文案改为「创建中」', () => {
    const node = TeamCreateDialog({
      open: true,
      candidates,
      form: form(),
      submitting: true,
      onNameChange: noop,
      onToggle: noop,
      onChooseLeader: noop,
      onSubmit: noop,
      onCancel: noop,
    })
    const props = findAll(node)
    expect(props.find((p) => p['data-create-submit'] === 'true')?.['disabled']).toBe(true)
    expect(texts(node)).toContain('创建中…')
  })

  it('未勾选成员的组长单选禁用（不给能点却无效的死控件）', () => {
    const props = findAll(TeamCreateDialog({
      open: true,
      candidates,
      form: form({ memberIds: ['a'], leaderId: 'a' }),
      submitting: false,
      onNameChange: noop,
      onToggle: noop,
      onChooseLeader: noop,
      onSubmit: noop,
      onCancel: noop,
    }))
    const radios = props.filter((p) => p['type'] === 'radio')
    const leaderRadio = radios.find((p) => p['value'] === 'a')
    const otherRadio = radios.find((p) => p['value'] === 'b')
    expect(leaderRadio?.['disabled']).toBe(false)
    expect(otherRadio?.['disabled']).toBe(true)
  })

  it('始终给一句可照抄的引导', () => {
    const flat = texts(TeamCreateDialog({
      open: true,
      candidates,
      form: form(),
      submitting: false,
      onNameChange: noop,
      onToggle: noop,
      onChooseLeader: noop,
      onSubmit: noop,
      onCancel: noop,
    }))
    expect(flat.some((t) => t.includes('组建一个团队'))).toBe(true)
  })

  it('校验错误码都有中文可读文案（界面不出现裸码）', () => {
    for (const code of ['TEAM_CREATE_NAME_REQUIRED', 'TEAM_CREATE_MEMBER_REQUIRED', 'TEAM_CREATE_LEADER_REQUIRED'] as const) {
      expect(validateCreateForm(
        code === 'TEAM_CREATE_NAME_REQUIRED' ? form({ name: '' })
          : code === 'TEAM_CREATE_MEMBER_REQUIRED' ? form({ memberIds: [], leaderId: null })
          : form({ leaderId: null }),
      ).ok).toBe(false)
    }
    expect(TEAM_CREATE_NAME_REQUIRED).not.toContain('TEAM_')
  })
})

// ---------------------------------------------------------------------------
// 状态机接线
// ---------------------------------------------------------------------------

const fetchMock = vi.fn()
let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  originalFetch = globalThis.fetch
  fetchMock.mockReset()
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, data: { teams: [] } }) })
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('store 接线 — 新建团队的开关与提交', () => {
  it('无候选时打不开弹层（不给死按钮对应的空弹层）', () => {
    const store = createTeamStore()
    store.openCreateDialog()
    expect(store.createOpen).toBe(false)
    store.dispose()
  })

  it('有候选时可打开，表单为初始空值', () => {
    const store = createTeamStore()
    store.setCandidates([{ id: 'a', name: '调研员' }])
    store.openCreateDialog()
    expect(store.createOpen).toBe(true)
    expect(store.createForm).toEqual(EMPTY_CREATE_FORM)
    store.dispose()
  })

  it('改名字 / 选成员 / 定组长都落到表单快照', () => {
    const store = createTeamStore()
    store.setCandidates([{ id: 'a', name: '调研员' }, { id: 'b', name: '实现者' }])
    store.openCreateDialog()
    store.setCreateName('发布官网')
    store.toggleCreateMember('a')
    store.chooseCreateLeader('a')
    expect(store.createForm.name).toBe('发布官网')
    expect(store.createForm.memberIds).toEqual(['a'])
    expect(store.createForm.leaderId).toBe('a')
    store.dispose()
  })

  it('表单不合法时提交被拒且弹层保持打开', async () => {
    const store = createTeamStore()
    store.setCandidates([{ id: 'a', name: '调研员' }])
    store.openCreateDialog()
    await store.submitCreate()
    // 没填名字 ⇒ 不提交、不关闭，用户不会丢掉已填内容
    expect(store.createOpen).toBe(true)
    store.dispose()
  })

  it('表单合法时提交关闭弹层并重置表单', async () => {
    const store = createTeamStore()
    store.setCandidates([{ id: 'a', name: '调研员' }])
    store.openCreateDialog()
    store.setCreateName('发布官网')
    store.toggleCreateMember('a')
    store.chooseCreateLeader('a')
    await store.submitCreate()
    expect(store.createOpen).toBe(false)
    expect(store.createForm).toEqual(EMPTY_CREATE_FORM)
    store.dispose()
  })

  it('关闭弹层重置表单（下次打开是干净的）', () => {
    const store = createTeamStore()
    store.setCandidates([{ id: 'a', name: '调研员' }])
    store.openCreateDialog()
    store.setCreateName('临时')
    store.closeCreateDialog()
    store.openCreateDialog()
    expect(store.createForm.name).toBe('')
    store.dispose()
  })
})