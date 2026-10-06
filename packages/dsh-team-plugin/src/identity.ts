/**
 * [INPUT]: 依赖 `./contracts.ts` 的 `TeamMemberView`（仅类型）。无 React、无存储、无 DOM。
 * [OUTPUT]: 成员身份色的**唯一真源**：色板 + 增量分配算法 + 按团队持久化存取（纯函数 + 薄存储层）。
 * [POS]: E2 的规则层。界面上任何一处取成员颜色都必须经这里，不允许各写各的取色。
 * [PROTOCOL]: 变更时更新此头部，然后检查 src/panel.tsx
 *
 * 【为什么要有身份色】多成员并行时，用户看着并排的多列对话 / 多条消息，分不清
 * 「这条到底是哪一个成员发的」。一套低饱和色贯穿「胶囊名字 / 消息气泡 / 看板泳道」三处即可解决。
 *
 * 【三条不可让步的规则】——它们共同维持「颜色 = 成员」这个心智模型：
 *   1. 组长恒定色号 0（品牌色）。
 *   2. **已分配的颜色钉死**：别人增删/重排都不改变某个成员已有的颜色。
 *      若颜色会漂移，用户建立不起这个心智模型，整个设计就塌了。
 *   3. 新成员取「未占用的最小非 0 色号」，优先复用被移除成员释放的空档。
 *
 * 【相对 AionUi 的唯一改动】上游以 `slot_id` 作成员实例键；DSH 的 teammate 以 **name** 寻址，
 * 故本实现用 `memberId`（= name）。算法语义逐条保持一致。
 *
 * 移植自 AionUi（Apache-2.0）：`renderer/pages/team/identity/teamMemberColors.ts`
 */

/**
 * 身份色板：低饱和的邻近色系。**索引 0 固定给组长**（走主题品牌色）。
 *
 * 取低饱和是有意的：颜色只作「身份标识」，不做整格彩底，避免界面花掉。
 */
export const TEAM_MEMBER_PALETTE = [
  'var(--brand)', // 0 = 组长（品牌色）
  '#5c9ea4', // 雾青
  '#b58a5e', // 暖褐
  '#9481bf', // 藕紫
  '#c07d97', // 豆沙玫
  '#6ba07e', // 灰绿
  '#4f8ac9', // 雾蓝
  '#c99a4b', // 琥珀
] as const

/** 组长恒定色号。 */
export const LEADER_COLOR_INDEX = 0

/** 取色所需的最小成员信息。 */
export interface ColorableMember {
  readonly memberId: string
  readonly role: 'lead' | 'teammate'
}

/** 成员 id → 色号。 */
export type MemberColorMap = Readonly<Record<string, number>>

/** 空映射：**引用稳定的常量**，可安全用作 store 初值。 */
export const EMPTY_COLOR_MAP: MemberColorMap = Object.freeze({})

/**
 * 增量分配成员色号：给定上一版映射与当前成员列表，返回新映射。
 *
 * 纯函数、无副作用——便于单测，也便于在没有 DOM 的地方复算。
 */
export function assignMemberColors(prev: MemberColorMap, members: readonly ColorableMember[]): MemberColorMap {
  const next: Record<string, number> = {}
  const used = new Set<number>()
  const paletteLength = TEAM_MEMBER_PALETTE.length

  // 规则 1：组长恒定色号 0。
  const leader = members.find((member) => member.role === 'lead')
  if (leader) {
    next[leader.memberId] = LEADER_COLOR_INDEX
    used.add(LEADER_COLOR_INDEX)
  }

  // 规则 2：已分配过的成员沿用原色号（钉死）——别人怎么增删都不影响他。
  for (const member of members) {
    if (member.memberId in next) continue
    const previous = prev[member.memberId]
    if (previous !== undefined) {
      next[member.memberId] = previous
      used.add(previous)
    }
  }

  // 规则 3：新成员取「未占用的最小非 0 色号」；色板占满后循环复用（跳过 0）。
  let cursor = 1
  const nextFreeIndex = (): number => {
    // 仍有非 0 空档：返回最小的未占用色号。
    if (used.size < paletteLength - 1) {
      let index = 1
      while (used.has(index)) index += 1
      return index
    }
    // 色板已满：循环复用（跳过 0，它属于组长）。
    const index = cursor % paletteLength || 1
    cursor += 1
    return index
  }

  for (const member of members) {
    if (member.memberId in next) continue
    const index = nextFreeIndex()
    next[member.memberId] = index
    used.add(index)
  }

  return next
}

/**
 * 取某成员的颜色 CSS 值。
 *
 * 未知成员回退到组长色——安全兜底（宁可和组长同色，也不要一个没有颜色的裸胶囊）。
 */
export function memberColorValue(colorMap: MemberColorMap, memberId: string | undefined): string {
  // 注意写法：不能写 `memberId && colorMap[memberId]` —— 那样 `index` 会被推成
  // `'' | number | undefined`（空串也进了类型），后面取模就编译不过。这里显式判空。
  const found = memberId === undefined || memberId === '' ? undefined : colorMap[memberId]
  const index: number = found ?? LEADER_COLOR_INDEX
  const color = TEAM_MEMBER_PALETTE[index % TEAM_MEMBER_PALETTE.length]
  return color ?? (TEAM_MEMBER_PALETTE[LEADER_COLOR_INDEX] as string)
}

/** 浅底色：在底色上按比例混入成员色，用于胶囊底。深浅由浏览器 `color-mix` 计算。 */
export const MEMBER_SOFT_MIX = '8%'
/** 选中态深一点的底色比例。 */
export const MEMBER_SELECTED_MIX = '16%'

// ---------------------------------------------------------------------------
// 持久化（按团队分键，与 AionUi 同款 key 形状）
// ---------------------------------------------------------------------------

/** localStorage 键前缀。**按 teamId 分键**——不同团队各记各的颜色映射。 */
export const MEMBER_COLORS_KEY_PREFIX = 'dsh-team.member-colors.'

export function memberColorsStorageKey(teamId: string): string {
  return `${MEMBER_COLORS_KEY_PREFIX}${teamId}`
}

/** 极简存储口，便于测试与降级（宿主无 localStorage 时可换实现）。 */
export interface ColorStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function isValidIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < TEAM_MEMBER_PALETTE.length
}

/**
 * 读取并**逐字段**校验已存映射。
 *
 * 为什么不直接 `JSON.parse` 后就信：存储可能被手改、被旧版本写坏、被别的脚本污染。
 * 任何一条记录不合法就**整条丢弃**（回落空映射），绝不带着半个坏映射进内存——
 * 坏映射会让某个成员突然变颜色，比全丢更糟。
 */
export function parseColorMap(raw: string | null): MemberColorMap {
  if (!raw) return EMPTY_COLOR_MAP
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return EMPTY_COLOR_MAP
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return EMPTY_COLOR_MAP

  const result: Record<string, number> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key.length === 0 || key.length > 64) continue
    if (!isValidIndex(value)) continue
    result[key] = value
  }
  return result
}

/** 把映射写成存储。**存储不可用时静默降级**为纯内存（颜色仍在本次会话内一致）。 */
export function writeColorMap(storage: ColorStorage, teamId: string, map: MemberColorMap): void {
  try {
    storage.setItem(memberColorsStorageKey(teamId), JSON.stringify(map))
  } catch {
    /* 配额满或隐私模式禁用：颜色退化为仅本次会话内保持，功能不受影响 */
  }
}

/**
 * 宿主存储口的惰性解析。
 *
 * 浏览器没有 `localStorage` 时（SSR / 测试 / 隐私模式）返回 null，调用方据此走纯内存。
 */
export function resolveBrowserStorage(): ColorStorage | null {
  try {
    const candidate = (globalThis as { localStorage?: ColorStorage }).localStorage
    if (!candidate || typeof candidate.getItem !== 'function' || typeof candidate.setItem !== 'function') {
      return null
    }
    return candidate
  } catch {
    // Safari 无痕模式访问 localStorage 会直接抛异常
    return null
  }
}

/**
 * 读出映射并按当前成员**增量更新**（这一步同时实现「钉死」与「释放复用」）。
 *
 * @returns 新映射；调用方负责落盘（`writeColorMap`）。
 */
export function reconcileColorMap(
  storage: ColorStorage | null,
  teamId: string,
  members: readonly ColorableMember[],
): MemberColorMap {
  const previous = storage ? parseColorMap(storage.getItem(memberColorsStorageKey(teamId))) : EMPTY_COLOR_MAP
  return assignMemberColors(previous, members)
}