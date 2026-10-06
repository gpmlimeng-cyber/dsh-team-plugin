/**
 * [INPUT]: 读 package.json 与构建产物 client/client.js。
 * [OUTPUT]: 发布一致性门禁——bundle 的 require 集合必须与 `dsh.client.external` **逐字对应**。
 * [POS]: 本包最关键的发布门禁。缺 external ⇒ 渲染进程静默不激活 ⇒ 只有实机才暴露。
 * [PROTOCOL]: 变更时更新此头部，然后检查 package.json
 *
 * 【为什么需要这道门禁】
 * Client Loader 的 `require(spec)` 只认：平台 seed word / 已物化模块 / 已注册包工厂。
 * seed 表由主进程**按图的 `external` 声明**填充。故：
 *
 *   bundle 写了 require("react")  但  package.json 没声明 external: ["react"]
 *   ⇒ react 不在模块表 ⇒ require 抛错 ⇒ fiber 静默不激活
 *   ⇒ 表现为 `Renderer boot failed ... The client Loader did not provide an error message.`
 *
 * 那个「did not provide an error message」极具迷惑性：它不是缺少错误信息，
 * 而是 **fiber 从未进入 active 状态**，`loader.await()` 本身并未抛错。
 * 单测完全测不到——只有真机渲染进程才会暴露。
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

interface PackageManifest {
  readonly name: string
  readonly exports: Readonly<Record<string, unknown>>
  readonly files: readonly string[]
  readonly dsh?: {
    readonly bundle?: { readonly patch?: string }
    readonly client?: { readonly platform?: string; readonly inject?: readonly string[]; readonly external?: readonly string[] }
  }
}

/** 读取清单；产物不存在时返回 null（构建前跑测试不算失败）。 */
function readManifest(): PackageManifest | null {
  try {
    return JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf8')) as PackageManifest
  } catch {
    return null
  }
}

/** 收集产物里的所有静态 require。 */
function readBundleRequires(): readonly string[] | null {
  try {
    const source = readFileSync(resolve(PACKAGE_ROOT, 'client/client.js'), 'utf8')
    const found = new Set<string>()
    for (const match of source.matchAll(/require\("([^"]+)"\)/g)) {
      const specifier = match[1]
      if (specifier) found.add(specifier)
    }
    return [...found]
  } catch {
    return null
  }
}

describe('发布一致性 —— external 与 bundle 的 require 逐字对应', () => {
  const manifest = readManifest()
  const requires = readBundleRequires()

  it.skipIf(manifest === null)('清单可解析', () => {
    expect(manifest?.name).toBe('dsh-team-plugin')
  })

  it.skipIf(manifest === null)('声明了 dsh.client.external', () => {
    // 这条是本文件存在的理由：没有它，渲染进程静默失败。
    expect(Array.isArray(manifest?.dsh?.client?.external)).toBe(true)
    expect(manifest?.dsh?.client?.external?.length ?? 0).toBeGreaterThan(0)
  })

  it.skipIf(manifest === null || requires === null)(
    'bundle 里的每个 require 都在 external 中（多一个就起不来）',
    () => {
      const external = new Set(manifest!.dsh!.client!.external ?? [])
      const missing = (requires ?? []).filter((specifier) => !external.has(specifier))
      expect(missing).toEqual([])
    },
  )

  it.skipIf(manifest === null || requires === null)(
    'external 里的每个模块都被 bundle 真正用到（少声明是浪费）',
    () => {
      const used = new Set(requires ?? [])
      const unused = (manifest!.dsh!.client!.external ?? []).filter((specifier) => !used.has(specifier))
      expect(unused).toEqual([])
    },
  )
})

describe('发布布局 —— 与官方惯例一致', () => {
  const manifest = readManifest()

  it.skipIf(manifest === null)('client 入口是独立的 ./client/client.js', () => {
    expect(manifest?.exports['./client']).toBe('./client/client.js')
  })

  it.skipIf(manifest === null)('files 同时带 lib、client、src', () => {
    const files = manifest?.files ?? []
    for (const required of ['lib', 'client', 'src', 'cordis.patch.yml']) {
      expect(files).toContain(required)
    }
  })

  it.skipIf(manifest === null)('bundle patch 已声明', () => {
    expect(manifest?.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  })
})

describe('Client bundle 外壳 —— 与官方 Loader 契约一致', () => {
  it('产物存在时，注册调用在最外层且带 Symbol.toStringTag', () => {
    // 未构建时跳过（先跑 build 再跑测试的顺序更常见）
    if (readBundleRequires() === null) return
    const text = readFileSync(resolve(PACKAGE_ROOT, 'client/client.js'), 'utf8')
    expect(text.startsWith('window.__ModuleLoader__.load({')).toBe(true)
    // 这行与官方产物逐字一致；缺它可能被 Loader 判为非法模块
    expect(text).toContain("Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })")
    // 结尾是 `return module.exports } })`，其后可能还有 sourcemap 注释，故不能直接 endsWith
    const withoutMap = text.replace(/\/\/# sourceMappingURL=\S+\s*$/, '')
    expect(withoutMap.trimEnd().endsWith('return module.exports } })')).toBe(true)
  })
})