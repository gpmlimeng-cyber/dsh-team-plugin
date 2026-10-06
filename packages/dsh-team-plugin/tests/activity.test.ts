/**
 * [INPUT]: 依赖 src/activity.ts（归属规则）、src/activity-controls.ts（持久化）、src/board.tsx（纯组件）、src/state.ts。
 * [OUTPUT]: E5 门禁——锁死：**一个条目都不许丢**、fallback 列按需出现、控制条逐字段校验、依赖标签。
 * [POS]: E5 机械门禁。泳道规则错一条，用户就会以为系统丢数据。
 * [PROTOCOL]: 变更时更新此头部，然后检查 src/activity.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ACTIVITY_BROADCAST_TARGET,
  ACTIVITY_FALLBACK_LANE,
  ACTIVITY_USER_IDENTITY,
  buildActivityItems,
  buildLanes,
  DEFAULT_ACTIVITY_CONTROLS,
  filterActivityItems,
  isBroadcastMessage,
  isTerminalTaskStatus,
  resolveMessageLane,
  resolveTaskLane,
  shouldShowFallbackLane,
  sortActivityItems,
  type ActivityControls,
  type ActivityLane,
  type ActivityMessage,
  type ActivityTask,
} from '../src/activity.js'
import {
  activityControlsStorageKey,
  ACTIVITY_CONTROLS_KEY_PREFIX,
  parseActivityControls,
  readActivityControls,
  writeActivityControls,
} from '../src/activity-controls.js'
import { ActivityBoard, BoardControlBar, MessageCard, TaskCard } from '../src/board.js'
import { TEAM_BOARD_EMPTY, TEAM_TASK_BLOCKED_BY, TEAM_TASK_UNASSIGNED } from '../src/copy.js'
import type { ColorStorage } from '../src/identity.js'

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
  if (typeof element.type === 'function') return texts((element.type as (p: unknown) => unknown)(element.props), out)
  texts(element.props?.children, out)
  return out
}

function propsOf(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (node === null || node === undefined || typeof node === 'boolean' || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) propsOf(child, out)
    return out
  }
  const element = node as { type?: unknown; props?: Record<string, unknown> }
  if (typeof element.type === 'function') return propsOf((element.type as (p: unknown) => unknown)(element.props), out)
  if (element.props) out.push(element.props)
  propsOf(element.props?.children, out)
  return out
}

const known = new Set(['组长', '甲', '乙'])

const msg = (over: Partial<ActivityMessage> = {}): ActivityMessage => ({
  id: 'm1',
  from: '组长',
  to: '甲',
  content: '你好',
  summary: '',
  system: false,
  createdAt: 1000,
  ...over,
})

const task = (over: Partial<ActivityTask> = {}): ActivityTask => ({
  id: 't1',
  subject: '写代码',
  description: '',
  status: 'pending',
  owner: '甲',
  blockedBy: [],
  createdAt: 2000,
  ...over,
})

// ---------------------------------------------------------------------------
// 泳道归属 —— 核心
// ---------------------------------------------------------------------------

describe('resolveMessageLane —— 消息落收件人泳道', () => {
  it('普通消息落在收件人', () => {
    expect(resolveMessageLane(msg({ to: '甲' }), known)).toBe('甲')
  })

  it('广播消息落在**发送者**（没有单一收件人）', () => {
    expect(isBroadcastMessage(msg({ to: ACTIVITY_BROADCAST_TARGET, from: '组长' }))).toBe(true)
    expect(resolveMessageLane(msg({ to: ACTIVITY_BROADCAST_TARGET, from: '组长' }), known)).toBe('组长')
  })

  it('发给用户 ⇒ fallback（不是发给成员的）', () => {
    expect(resolveMessageLane(msg({ to: ACTIVITY_USER_IDENTITY }), known)).toBe(ACTIVITY_FALLBACK_LANE)
  })

  it('收件人已移除 ⇒ fallback（不丢条目）', () => {
    expect(resolveMessageLane(msg({ to: '已移除的人' }), known)).toBe(ACTIVITY_FALLBACK_LANE)
  })

  it('收件人为空 ⇒ fallback', () => {
    expect(resolveMessageLane(msg({ to: '' }), known)).toBe(ACTIVITY_FALLBACK_LANE)
  })
})

describe('resolveTaskLane —— 任务落负责人泳道', () => {
  it('落在 owner', () => {
    expect(resolveTaskLane(task({ owner: '乙' }), known)).toBe('乙')
  })

  it('未指派 ⇒ fallback', () => {
    expect(resolveTaskLane(task({ owner: '' }), known)).toBe(ACTIVITY_FALLBACK_LANE)
  })

  it('owner 已移除 ⇒ fallback', () => {
    expect(resolveTaskLane(task({ owner: '已移除' }), known)).toBe(ACTIVITY_FALLBACK_LANE)
  })
})

describe('fallback 泳道 —— 保证不丢条目', () => {
  it('过滤后有条目落在 fallback 才画这一列', () => {
    const items = buildActivityItems({
      messages: [msg({ to: ACTIVITY_USER_IDENTITY })],
      tasks: [],
      knownMembers: known,
      controls: DEFAULT_ACTIVITY_CONTROLS,
    })
    expect(shouldShowFallbackLane(items)).toBe(true)
  })

  it('全部有条目都有归属时**不画空列**（否则像有数据没显示）', () => {
    const items = buildActivityItems({
      messages: [msg({ to: '甲' })],
      tasks: [task({ owner: '乙' })],
      knownMembers: known,
      controls: DEFAULT_ACTIVITY_CONTROLS,
    })
    expect(shouldShowFallbackLane(items)).toBe(false)
  })

  it('buildLanes 只在需要时追加 fallback 列，且追加在最后', () => {
    const memberLanes: ActivityLane[] = [
      { laneId: '组长', name: '组长', color: '#000', isFallback: false },
    ]
    const withFallback = buildLanes(memberLanes, [
      { kind: 'message', id: 'm', laneId: ACTIVITY_FALLBACK_LANE, createdAt: 1, message: msg() },
    ])
    expect(withFallback).toHaveLength(2)
    expect(withFallback[1]?.isFallback).toBe(true)

    const without = buildLanes(memberLanes, [
      { kind: 'message', id: 'm', laneId: '组长', createdAt: 1, message: msg({ to: '组长' }) },
    ])
    expect(without).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 排序
// ---------------------------------------------------------------------------

describe('sortActivityItems —— 确定性排序', () => {
  const a = { kind: 'message' as const, id: 'a', laneId: 'x', createdAt: 100, message: msg() }
  const b = { kind: 'task' as const, id: 'b', laneId: 'x', createdAt: 200, task: task() }

  it('desc = 新→旧（默认）', () => {
    expect(sortActivityItems([a, b], 'desc').map((i) => i.id)).toEqual(['b', 'a'])
  })

  it('asc = 旧→新', () => {
    expect(sortActivityItems([a, b], 'asc').map((i) => i.id)).toEqual(['a', 'b'])
  })

  it('同时间按 id 兜底，保证不闪（同刻到达的两条不会随机换位）', () => {
    const a2 = { ...a, createdAt: 100 }
    const b2 = { ...b, createdAt: 100 }
    const first = sortActivityItems([a2, b2], 'desc').map((i) => i.id)
    const second = sortActivityItems([b2, a2], 'desc').map((i) => i.id)
    expect(first).toEqual(second)
  })

  it('不改动入参数组', () => {
    const input = [a, b]
    sortActivityItems(input, 'asc')
    expect(input.map((i) => i.id)).toEqual(['a', 'b'])
  })
})

// ---------------------------------------------------------------------------
// 过滤
// ---------------------------------------------------------------------------

describe('filterActivityItems —— 默认收起噪音', () => {
  const messages = [msg({ id: 'm1' }), msg({ id: 'm2', system: true })]
  const tasks = [task({ id: 't1' }), task({ id: 't2', status: 'completed' }), task({ id: 't3', status: 'deleted' })]

  it('默认隐藏系统消息与终态任务', () => {
    const items = buildActivityItems({ messages, tasks, knownMembers: known, controls: DEFAULT_ACTIVITY_CONTROLS })
    const ids = items.map((i) => i.id)
    expect(ids).toContain('m1')
    expect(ids).not.toContain('m2')
    expect(ids).not.toContain('t2')
    expect(ids).not.toContain('t3')
  })

  it('打开开关后可见', () => {
    const controls: ActivityControls = { ...DEFAULT_ACTIVITY_CONTROLS, showSystemMessages: true, showTerminalTasks: true }
    const items = buildActivityItems({ messages, tasks, knownMembers: known, controls })
    const ids = items.map((i) => i.id)
    expect(ids).toContain('m2')
    expect(ids).toContain('t2')
    expect(ids).toContain('t3')
  })

  it('内容过滤：仅消息 / 仅任务', () => {
    const onlyMessages = buildActivityItems({
      messages, tasks, knownMembers: known,
      controls: { ...DEFAULT_ACTIVITY_CONTROLS, contentFilter: 'messages' },
    })
    expect(onlyMessages.every((i) => i.kind === 'message')).toBe(true)

    const onlyTasks = buildActivityItems({
      messages, tasks, knownMembers: known,
      controls: { ...DEFAULT_ACTIVITY_CONTROLS, contentFilter: 'tasks' },
    })
    expect(onlyTasks.every((i) => i.kind === 'task')).toBe(true)
  })

  it('成员筛选：选中即只看它，空 = 全员', () => {
    const onlyLead = buildActivityItems({
      messages: [msg({ id: 'm1', to: '组长' }), msg({ id: 'm2', to: '甲' })],
      tasks: [],
      knownMembers: known,
      controls: { ...DEFAULT_ACTIVITY_CONTROLS, selectedMembers: ['组长'] },
    })
    expect(onlyLead.map((i) => i.id)).toEqual(['m1'])

    const all = buildActivityItems({
      messages: [msg({ id: 'm1', to: '组长' }), msg({ id: 'm2', to: '甲' })],
      tasks: [],
      knownMembers: known,
      controls: { ...DEFAULT_ACTIVITY_CONTROLS, selectedMembers: [] },
    })
    expect(all).toHaveLength(2)
  })

  it('isTerminalTaskStatus 只认 completed / deleted', () => {
    expect(isTerminalTaskStatus('completed')).toBe(true)
    expect(isTerminalTaskStatus('deleted')).toBe(true)
    expect(isTerminalTaskStatus('in_progress')).toBe(false)
  })

  it('filterActivityItems 不改动入参数组', () => {
    const items = buildActivityItems({ messages, tasks, knownMembers: known, controls: DEFAULT_ACTIVITY_CONTROLS })
    const snapshot = items.map((i) => i.id)
    filterActivityItems(items, { ...DEFAULT_ACTIVITY_CONTROLS, contentFilter: 'tasks' })
    expect(items.map((i) => i.id)).toEqual(snapshot)
  })
})

// ---------------------------------------------------------------------------
// 控制条持久化
// ---------------------------------------------------------------------------

function fakeStorage(initial: Record<string, string> = {}): ColorStorage {
  const map = new Map(Object.entries(initial))
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) }
}

describe('控制条持久化 —— 逐字段校验', () => {
  it('键按 teamId 分键', () => {
    expect(activityControlsStorageKey('t1')).toBe(`${ACTIVITY_CONTROLS_KEY_PREFIX}t1`)
  })

  it('往返一致', () => {
    const storage = fakeStorage()
    const controls: ActivityControls = {
      sortDirection: 'asc',
      contentFilter: 'tasks',
      selectedMembers: ['组长'],
      showSystemMessages: true,
      showTerminalTasks: false,
    }
    writeActivityControls(storage, 't1', controls)
    expect(readActivityControls(storage, 't1')).toEqual(controls)
  })

  it('语法坏 ⇒ 回落默认', () => {
    expect(parseActivityControls('{坏')).toEqual(DEFAULT_ACTIVITY_CONTROLS)
    expect(parseActivityControls(null)).toEqual(DEFAULT_ACTIVITY_CONTROLS)
    expect(parseActivityControls('[1,2]')).toEqual(DEFAULT_ACTIVITY_CONTROLS)
  })

  it('非法枚举 ⇒ 该字段回落默认，其余保留', () => {
    const parsed = parseActivityControls(JSON.stringify({
      sortDirection: '乱写',
      contentFilter: 'tasks',
      selectedMembers: ['组长'],
      showSystemMessages: 'yes',
      showTerminalTasks: true,
    }))
    expect(parsed.sortDirection).toBe('desc') // 非法 → 默认
    expect(parsed.contentFilter).toBe('tasks') // 合法 → 保留
    expect(parsed.showSystemMessages).toBe(false) // 类型错 → 默认
    expect(parsed.showTerminalTasks).toBe(true) // 合法 → 保留
  })

  it('读回时剪除已移除的成员（不留幽灵筛选项）', () => {
    const raw = JSON.stringify({ selectedMembers: ['组长', '已走的人'] })
    const parsed = parseActivityControls(raw, new Set(['组长', '甲']))
    expect(parsed.selectedMembers).toEqual(['组长'])
  })

  it('剪空 ⇒ 全员（安全默认）', () => {
    const raw = JSON.stringify({ selectedMembers: ['已走的人'] })
    expect(parseActivityControls(raw, new Set(['组长'])).selectedMembers).toEqual([])
  })

  it('非字符串成员被剔除', () => {
    const raw = JSON.stringify({ selectedMembers: ['组长', 42, null] })
    expect(parseActivityControls(raw).selectedMembers).toEqual(['组长'])
  })

  it('存储不可用时读默认、写静默降级', () => {
    expect(readActivityControls(null, 't1')).toEqual(DEFAULT_ACTIVITY_CONTROLS)
    expect(() => writeActivityControls(null, 't1', DEFAULT_ACTIVITY_CONTROLS)).not.toThrow()
  })

  it('写入抛异常不崩', () => {
    const failing: ColorStorage = { getItem: () => null, setItem: () => { throw new Error('Quota') } }
    expect(() => writeActivityControls(failing, 't1', DEFAULT_ACTIVITY_CONTROLS)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

describe('卡片', () => {
  it('广播消息有独立标记', () => {
    const props = propsOf(MessageCard({ message: msg({ to: ACTIVITY_BROADCAST_TARGET }) }))
    expect(props.some((p) => p['data-msg-broadcast'] === 'true')).toBe(true)
  })

  it('系统消息正文用固定词，不把内部消息内容直接上屏', () => {
    const flat = texts(MessageCard({ message: msg({ system: true, content: '内部细节' }) }))
    expect(flat).toContain('系统消息')
    expect(flat).not.toContain('内部细节')
  })

  it('任务卡显示负责人', () => {
    expect(texts(TaskCard({ task: task({ owner: '甲' }) }))).toContain('甲')
  })

  it('未指派任务显示「未指派」而不是留空', () => {
    expect(texts(TaskCard({ task: task({ owner: '' }) }))).toContain(TEAM_TASK_UNASSIGNED)
  })

  it('有依赖才显示依赖标签', () => {
    const withDeps = texts(TaskCard({ task: task(), blockedByNames: ['调研员'] }))
    expect(withDeps).toContain(TEAM_TASK_BLOCKED_BY(['调研员']))

    const noDeps = texts(TaskCard({ task: task(), blockedByNames: [] }))
    expect(noDeps.some((t) => t.includes('等待'))).toBe(false)
  })

  it('依赖名解析不出来 ⇒ 整段不出现（不显示「等待：未知」）', () => {
    const flat = texts(TaskCard({ task: task(), blockedByNames: undefined }))
    expect(flat.some((t) => t.includes('等待'))).toBe(false)
  })
})

describe('ActivityBoard', () => {
  const lane = (laneId: string): ActivityLane => ({ laneId, name: laneId, color: '#000', isFallback: false })

  it('过滤后为空 ⇒ 整块空态（不是一列列空着）', () => {
    const flat = texts(ActivityBoard({ lanes: [lane('甲')], items: [] }))
    expect(flat).toContain(TEAM_BOARD_EMPTY)
  })

  it('每条泳道一列，带名字与身份色变量', () => {
    const props = propsOf(ActivityBoard({
      lanes: [lane('甲'), lane('乙')],
      items: [
        { kind: 'message', id: 'm1', laneId: '甲', createdAt: 1, message: msg({ id: 'm1', to: '甲' }) },
        { kind: 'task', id: 't1', laneId: '乙', createdAt: 2, task: task({ id: 't1', owner: '乙' }) },
      ],
    }))
    expect(props.some((p) => p['data-board'] === 'true')).toBe(true)
    const laneProps = props.filter((p) => typeof p['data-lane'] === 'string')
    expect(laneProps).toHaveLength(2)
    const style = laneProps.find((p) => p['data-lane'] === '甲')?.['style'] as Record<string, string>
    expect(style['--mc']).toBeTruthy()
  })

  it('fallback 列带标记', () => {
    const props = propsOf(ActivityBoard({
      lanes: [{ laneId: ACTIVITY_FALLBACK_LANE, name: '未分配', color: '#888', isFallback: true }],
      items: [
        { kind: 'message', id: 'm1', laneId: ACTIVITY_FALLBACK_LANE, createdAt: 1, message: msg({ id: 'm1', to: ACTIVITY_USER_IDENTITY }) },
      ],
    }))
    expect(props.some((p) => p['data-lane-fallback'] === 'true')).toBe(true)
  })
})

describe('BoardControlBar', () => {
  const lanes: ActivityLane[] = [
    { laneId: '组长', name: '组长', color: '#000', isFallback: false },
    { laneId: '甲', name: '甲', color: '#111', isFallback: false },
  ]

  it('当前排序与过滤呈按下态', () => {
    const props = propsOf(BoardControlBar({
      controls: { ...DEFAULT_ACTIVITY_CONTROLS, sortDirection: 'asc', contentFilter: 'tasks' },
      members: lanes,
      onChange: () => undefined,
    }))
    expect(props.find((p) => p['data-sort'] === 'asc')?.['aria-pressed']).toBe(true)
    expect(props.find((p) => p['data-filter'] === 'tasks')?.['aria-pressed']).toBe(true)
  })

  it('点击排序回调带目标值', () => {
    const next: ActivityControls[] = []
    const props = propsOf(BoardControlBar({
      controls: DEFAULT_ACTIVITY_CONTROLS,
      members: lanes,
      onChange: (n) => next.push(n),
    }))
    ;(props.find((p) => p['data-sort'] === 'asc')?.['onClick'] as () => void)()
    expect(next[0]?.sortDirection).toBe('asc')
  })

  it('点击成员筛选可增可删', () => {
    const next: ActivityControls[] = []
    const props = propsOf(BoardControlBar({
      controls: { ...DEFAULT_ACTIVITY_CONTROLS, selectedMembers: ['组长'] },
      members: lanes,
      onChange: (n) => next.push(n),
    }))
    // 点已选的组长 ⇒ 取消
    ;(props.find((p) => p['data-member-filter'] === '组长')?.['onClick'] as () => void)()
    expect(next[0]?.selectedMembers).toEqual([])
  })

  it('两个噪音开关可切', () => {
    const next: ActivityControls[] = []
    const props = propsOf(BoardControlBar({
      controls: DEFAULT_ACTIVITY_CONTROLS,
      members: lanes,
      onChange: (n) => next.push(n),
    }))
    ;(props.find((p) => p['data-toggle'] === 'system')?.['onClick'] as () => void)()
    ;(props.find((p) => p['data-toggle'] === 'terminal')?.['onClick'] as () => void)()
    expect(next[0]?.showSystemMessages).toBe(true)
    expect(next[1]?.showTerminalTasks).toBe(true)
  })

  it('只有一位成员时不渲染成员筛选（无意义的单选项）', () => {
    const props = propsOf(BoardControlBar({
      controls: DEFAULT_ACTIVITY_CONTROLS,
      members: [lanes[0]!],
      onChange: () => undefined,
    }))
    expect(props.some((p) => p['data-board-members'] === 'true')).toBe(false)
  })
})