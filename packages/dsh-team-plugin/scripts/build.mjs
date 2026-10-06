/**
 * [INPUT]: 依赖 esbuild 与 TypeScript CLI；外部化 `@deepseek-ai/*` 全部 peer（由目标 profile 提供）
 * [OUTPUT]: lib/index.js（Host ESM）、lib/client.js（lazy-CJS Client）、lib/types/**（声明）+ sourcemap
 * [POS]: 本插件的发布构建器。
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 *
 * 两半的差异是刻意的：
 * - **Host 半**是普通 ESM（`format: 'esm'`），直接被 Cordis Loader 挂载。
 * - **Client 半**必须是**懒加载 CJS**：官方 Client Loader 用 `window.__ModuleLoader__.load()`
 *   求值，返回 `require → module.exports`。故用 banner/footer 包一层工厂，内部再 `require('./client-entry')`。
 *
 * 纪律：`@deepseek-ai/*` 一律 external，绝不打进包里——它们必须由宿主提供，
 * 否则会出现两份官方单例（这是 DSH 插件最常见的事故）。
 */

import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const { build } = await import('esbuild')

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LIB_ROOT = resolve(PACKAGE_ROOT, 'lib')
// Client 产物独立目录（照 dshmarket 惯例：./client/client.js）
const CLIENT_ROOT = resolve(PACKAGE_ROOT, 'client')
const CLIENT_MODULE_ID = 'dsh-team-plugin'

/** 全部官方 peer：必须由宿主解析，本包一份都不打进去。 */
const EXTERNALS = ['@deepseek-ai/cordis', '@deepseek-ai/schemastery', 'react', 'react-dom', 'react/jsx-runtime']

await rm(LIB_ROOT, { force: true, recursive: true })
await mkdir(LIB_ROOT, { recursive: true })
await rm(CLIENT_ROOT, { force: true, recursive: true })
await mkdir(CLIENT_ROOT, { recursive: true })

/**
 * 跑 tsc 生成声明。
 *
 * 优先用本包 node_modules 里的 tsc；没有则回退到 PATH 上的 tsc。
 * **不用 `pnpm exec`**——它要求一个已装好的 workspace，在 CI 容器与本地裸目录下都会失败，
 * 而声明生成只是本地一步，不值得为它引入包管理器依赖。
 */
async function emitDeclarations() {
  const candidates = [
    resolve(PACKAGE_ROOT, 'node_modules/typescript/bin/tsc'),
    ...(process.env.NODE_PATH ? [resolve(process.env.NODE_PATH, 'typescript/bin/tsc')] : []),
  ].filter((path) => existsSync(path))

  const viaNode = candidates.find((path) => path.endsWith('.js') === false)
  if (viaNode) {
    await execFile(process.execPath, [viaNode, '-p', 'tsconfig.json'], { cwd: PACKAGE_ROOT, stdio: 'inherit' })
    return
  }

  // 最后回退：PATH 上的 tsc。
  await execFile('tsc', ['-p', 'tsconfig.json'], { cwd: PACKAGE_ROOT, stdio: 'inherit' })
}

await emitDeclarations()

// Host 半：Cordis Loader 直接消费。
await build({
  absWorkingDir: PACKAGE_ROOT,
  bundle: true,
  entryPoints: ['src/index.ts'],
  external: EXTERNALS,
  format: 'esm',
  outfile: 'lib/index.js',
  platform: 'node',
  sourcemap: true,
  target: 'node22',
})

// Client 半：官方 loader 的工厂契约 —— 传进来一个 require，交出去 module.exports。
await build({
  absWorkingDir: PACKAGE_ROOT,
  banner: {
    js: `window.__ModuleLoader__.load({ id: '${CLIENT_MODULE_ID}', factory: (require) => {\n\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });`,
  },
  bundle: true,
  entryPoints: ['src/client.tsx'],
  external: EXTERNALS,
  footer: { js: 'return module.exports } })' },
  format: 'cjs',
  outfile: 'client/client.js',
  platform: 'browser',
  sourcemap: true,
  target: ['chrome120', 'safari17'],
})

console.log('dsh-team-plugin 构建完成 → lib/ + client/')