/**
 * [INPUT]: 依赖 `./view-mode.ts`（模式规则）、`./copy.ts`（文案）；React createElement。
 * [OUTPUT]: 视图切换控件的**纯呈现组件**（无 hook，可直接函数调用测试）。
 * [POS]: E3 的渲染层。模式判定与持久化都在 view-mode.ts，本文件只负责画与传。
 * [PROTOCOL]: 变更时更新此头部，然后检查 src/panel.tsx
 */

import { createElement, type ReactNode } from 'react'

import {
  TEAM_VIEW_BOARD,
  TEAM_VIEW_PARALLEL,
  TEAM_VIEW_SINGLE,
  TEAM_VIEW_TOGGLE_LABEL,
} from './copy.js'
import { TEAM_VIEW_MODES, type TeamViewMode } from './view-mode.js'

/** 模式 → 可见文案。**看板尚未接入**，故本轮只给并行/单聊两个可选项。 */
const VIEW_LABEL: Readonly<Record<TeamViewMode, string>> = {
  parallel: TEAM_VIEW_PARALLEL,
  single: TEAM_VIEW_SINGLE,
  board: TEAM_VIEW_BOARD,
}

/**
 * 视图切换控件。
 *
 * 为什么用按钮组而不是下拉：只有两三个选项且切换极频繁，
 * 平铺的一组按钮比"点开再选"少一次交互。
 *
 * `disabled` 只在**真的只有一种视图可选**时才禁用（成员 ≤1 时单聊无意义）——
 * 不做常态占位的死控件。
 */
export function TeamViewToggle(props: {
  readonly mode: TeamViewMode
  readonly onChange: (mode: TeamViewMode) => void
  /** 可选模式；默认三种全开（E5 起看板已可用）。 */
  readonly available?: readonly TeamViewMode[] | undefined
}): ReactNode {
  const available = props.available ?? (['parallel', 'single', 'board'] as const)
  // 只有一种可选项时控件无意义，整块不渲染（而不是画一个永远点不动的组）。
  if (available.length <= 1) return null

  return createElement(
    'div',
    { role: 'group', 'aria-label': TEAM_VIEW_TOGGLE_LABEL, 'data-view-toggle': 'true' },
    TEAM_VIEW_MODES.filter((mode) => available.includes(mode)).map((mode) =>
      createElement(
        'button',
        {
          key: mode,
          type: 'button',
          // aria-pressed 表达"当前选中"这一状态，比纯样式更可靠
          'aria-pressed': props.mode === mode,
          'data-view-mode': mode,
          onClick: () => props.onChange(mode),
        },
        VIEW_LABEL[mode],
      ),
    ),
  )
}