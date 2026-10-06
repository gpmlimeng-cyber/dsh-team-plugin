/**
 * [INPUT]: 依赖 src/identity.ts（纯函数）与 src/contracts.ts（仅类型）。
 * [OUTPUT]: 身份色门禁——锁死三条规则：组长恒 0、颜色钉死、释放复用；以及存储逐字段校验。
 * [POS]: E2 的机械门禁。这几条是「颜色=成员」心智模型的地基，破坏任一条都是体验事故。
 * [PROTOCOL]: 变更时更新此头部，然后检查 src/identity.ts
 */

import { describe, expect, it } from 'vitest'

import {
  assignMemberColors,
  EMPTY_COLOR_MAP,
  LEADER_COLOR_INDEX,
  MEMBER_COLORS_KEY_PREFIX,
  memberColorValue,
  memberColorsStorageKey,
  parseColorMap,
  reconcileColorMap,
  TEAM_MEMBER_PALETTE,
  writeColorMap,
  type ColorStorage,
} from '../src/identity.js'

const lead = { memberId: '组长', role: 'lead' as const }
const m = (memberId: string) => ({ memberId, role: 'teammate' as const })

/** 假存储：内存 Map，可模拟写入失败。 */
function fakeStorage(initial: Record<string, string> = {}): ColorStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial))
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
  }
}

describe('色板', () => {
  it('索引 0 是品牌色（组长专用）', () => {
    expect(TEAM_MEMBER_PALETTE[LEADER_COLOR_INDEX]).toBe('var(--brand)')
  })

  it('提供 8 种低饱和色，覆盖常见团队规模', () => {
    expect(TEAM_MEMBER_PALETTE.length).toBeGreaterThanOrEqual(8)
  })
})

describe('规则 1：组长恒定色号 0', () => {
  it('只有组长时拿 0', () => {
    expect(assignMemberColors(EMPTY_COLOR_MAP, [lead])).toEqual({ 组长: 0 })
  })

  it('组长在成员列表中间也恒拿 0，且被提到最前不影响', () => {
    const map = assignMemberColors(EMPTY_COLOR_MAP, [m('甲'), m('乙'), lead, m('丙')])
    expect(map['组长']).toBe(0)
  })

  it('没有组长时首位成员拿 1 而非 0（0 是组长的专属色号）', () => {
    const map = assignMemberColors(EMPTY_COLOR_MAP, [m('甲'), m('乙')])
    expect(map['甲']).toBe(1)
    expect(map['乙']).toBe(2)
  })

  it('组长换人后，新组长拿 0', () => {
    const before = assignMemberColors(EMPTY_COLOR_MAP, [lead, m('甲')])
    expect(before['组长']).toBe(0)
    const lead2 = { memberId: '组长2', role: 'lead' as const }
    const after = assignMemberColors(before, [lead2, m('甲')])
    expect(after['组长2']).toBe(0)
  })

  it('组长被移除时，它释放的 0 号不被普通成员占用', () => {
    // 原组长退位后，剩余成员按最小可用号分配；0 仍保留为组长预留位。
    const after = assignMemberColors({ 组长: 0, 甲: 1, 乙: 2 }, [m('甲'), m('乙')])
    expect(after['甲']).toBe(1)
    expect(after['乙']).toBe(2)
    // 没有组长 ⇒ 没有任何成员拿 0（0 是组长专属色号）
    expect(Object.values(after)).not.toContain(0)
  })
})

describe('规则 2：颜色钉死——别人增删都不改变已有成员的颜色', () => {
  it('新增成员不影响老成员', () => {
    const before = assignMemberColors(EMPTY_COLOR_MAP, [lead, m('甲'), m('乙')])
    const after = assignMemberColors(before, [lead, m('甲'), m('乙'), m('丙'), m('丁')])
    expect(after['甲']).toBe(before['甲'])
    expect(after['乙']).toBe(before['乙'])
    expect(after['组长']).toBe(0)
  })

  it('移除成员不影响其余成员（这是最容易被破坏的一条）', () => {
    const before = assignMemberColors(EMPTY_COLOR_MAP, [lead, m('甲'), m('乙'), m('丙')])
    const after = assignMemberColors(before, [lead, m('甲'), m('丙')])
    expect(after['甲']).toBe(before['甲'])
    expect(after['丙']).toBe(before['丙'])
    // 被移除的成员不在映射里（色号被释放）
    expect('乙' in after).toBe(false)
  })

  it('重排（顺序变化）不影响任何成员的颜色', () => {
    const before = assignMemberColors(EMPTY_COLOR_MAP, [lead, m('甲'), m('乙'), m('丙')])
    const after = assignMemberColors(before, [lead, m('丙'), m('甲'), m('乙')])
    expect(after['甲']).toBe(before['甲'])
    expect(after['乙']).toBe(before['乙'])
    expect(after['丙']).toBe(before['丙'])
  })

  it('反复 reconcile 同一份名单，映射保持稳定（不会每刷新一次变一次）', () => {
    const members = [lead, m('甲'), m('乙')]
    let map = assignMemberColors(EMPTY_COLOR_MAP, members)
    const first = { ...map }
    for (let i = 0; i < 5; i += 1) {
      map = assignMemberColors(map, members)
    }
    expect(map).toEqual(first)
  })
})

describe('规则 3：新成员取最小未占用色号，并复用被释放的空档', () => {
  it('新成员补进空档（1,2,3 缺 2 就给 2）', () => {
    const before = { 组长: 0, 甲: 1, 丙: 3 }
    const after = assignMemberColors(before, [lead, m('甲'), m('乙'), m('丙')])
    // 2 是空出来的最小号 → 优先复用，而不是顺延取 4
    expect(after['乙']).toBe(2)
  })

  it('一次性加入时按顺序分配最小可用号', () => {
    const map = assignMemberColors(EMPTY_COLOR_MAP, [lead, m('甲'), m('乙'), m('丙'), m('丁')])
    expect(map['甲']).toBe(1)
    expect(map['乙']).toBe(2)
    expect(map['丙']).toBe(3)
    expect(map['丁']).toBe(4)
  })

  it('成员数超出色板容量时循环复用，但跳过 0（组长专属）', () => {
    const many = Array.from({ length: 12 }, (_, i) => m(`成员${i}`))
    const map = assignMemberColors(EMPTY_COLOR_MAP, [lead, ...many])
    const paletteLength = TEAM_MEMBER_PALETTE.length
    // 循环时仍分配一个合法色号，且 0 只属于组长
    for (const [id, index] of Object.entries(map)) {
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThan(paletteLength)
      if (id !== '组长') expect(index).not.toBe(0)
    }
    // 循环阶段必然出现复用：12 个成员 + 组长 = 13 个，色板只有 8 色
    const indices = many.map((member) => map[member.memberId])
    expect(new Set(indices).size).toBeLessThanOrEqual(paletteLength)
  })
})

describe('memberColorValue — 取色与兜底', () => {
  it('按色号取色板值', () => {
    const map = { 组长: 0, 甲: 1 }
    expect(memberColorValue(map, '组长')).toBe(TEAM_MEMBER_PALETTE[0])
    expect(memberColorValue(map, '甲')).toBe(TEAM_MEMBER_PALETTE[1])
  })

  it('未知成员回退到组长色（不留无色胶囊）', () => {
    expect(memberColorValue({ 组长: 0 }, '不存在')).toBe(TEAM_MEMBER_PALETTE[0])
    expect(memberColorValue({ 组长: 0 }, undefined)).toBe(TEAM_MEMBER_PALETTE[0])
  })

  it('越界色号对色板长度取模，不抛异常', () => {
    expect(memberColorValue({ 甲: 99 }, '甲')).toBe(TEAM_MEMBER_PALETTE[99 % TEAM_MEMBER_PALETTE.length])
  })
})

describe('持久化——逐字段校验，坏数据整条丢弃', () => {
  it('键按 teamId 分键', () => {
    expect(memberColorsStorageKey('t1')).toBe(`${MEMBER_COLORS_KEY_PREFIX}t1`)
    expect(memberColorsStorageKey('t1')).not.toBe(memberColorsStorageKey('t2'))
  })

  it('往返一致', () => {
    const storage = fakeStorage()
    writeColorMap(storage, 't1', { 组长: 0, 甲: 3 })
    expect(parseColorMap(storage.getItem(memberColorsStorageKey('t1')))).toEqual({ 组长: 0, 甲: 3 })
  })

  it('JSON 语法坏 ⇒ 回落空映射，不抛异常', () => {
    expect(parseColorMap('{不是合法 JSON')).toEqual({})
  })

  it('非对象（数组/数字/null）⇒ 回落空映射', () => {
    expect(parseColorMap('[1,2]')).toEqual({})
    expect(parseColorMap('42')).toEqual({})
    expect(parseColorMap('null')).toEqual({})
  })

  it('非法色号字段被逐条剔除，其余保留', () => {
    const parsed = parseColorMap(JSON.stringify({ 组长: 0, 甲: 99, 乙: -1, 丙: 1.5, 丁: 'x', 戊: 2 }))
    expect(parsed).toEqual({ 组长: 0, 戊: 2 })
  })

  it('空键与超长键被丢弃', () => {
    const parsed = parseColorMap(JSON.stringify({ '': 1, ['x'.repeat(65)]: 2, 正常: 3 }))
    expect(parsed).toEqual({ 正常: 3 })
  })

  it('缺值（null）⇒ 空映射', () => {
    expect(parseColorMap(null)).toEqual({})
  })

  it('存储写入失败（配额满）静默降级，不崩', () => {
    const failing: ColorStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }
    expect(() => writeColorMap(failing, 't1', { 甲: 1 })).not.toThrow()
  })
})

describe('reconcileColorMap — 读出后按当前成员增量更新', () => {
  it('按团队分键读取，不同团队互不干扰', () => {
    const storage = fakeStorage()
    writeColorMap(storage, 't1', { 组长: 0, 甲: 1 })
    writeColorMap(storage, 't2', { 组长: 0, 乙: 5 })
    expect(reconcileColorMap(storage, 't1', [lead, m('甲')])['甲']).toBe(1)
    expect(reconcileColorMap(storage, 't2', [lead, m('乙')])['乙']).toBe(5)
  })

  it('新团队从零开始分配', () => {
    const map = reconcileColorMap(fakeStorage(), 't1', [lead, m('甲'), m('乙')])
    expect(map).toEqual({ 组长: 0, 甲: 1, 乙: 2 })
  })

  it('存储为 null（无 localStorage）时退化为纯内存，仍可用', () => {
    const map = reconcileColorMap(null, 't1', [lead, m('甲')])
    expect(map).toEqual({ 组长: 0, 甲: 1 })
  })

  it('存储里是坏数据时重新分配，不带着半坏映射', () => {
    const storage = fakeStorage({ [`${MEMBER_COLORS_KEY_PREFIX}t1`]: '{坏数据' })
    const map = reconcileColorMap(storage, 't1', [lead, m('甲')])
    expect(map).toEqual({ 组长: 0, 甲: 1 })
  })

  it('同名团队重开时颜色保持（跨会话体验一致）', () => {
    const storage = fakeStorage()
    writeColorMap(storage, 't1', { 组长: 0, 甲: 4, 乙: 2 })
    // 关掉再打开：读回同一份存储
    const map = reconcileColorMap(storage, 't1', [lead, m('甲'), m('乙')])
    expect(map['甲']).toBe(4)
    expect(map['乙']).toBe(2)
  })
})