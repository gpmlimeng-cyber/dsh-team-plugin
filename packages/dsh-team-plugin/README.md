<!--
[INPUT]: 依赖官方 Harness 的插件扩展点（slot / webServer / agentTeams）
[OUTPUT]: 面向使用者的安装与能力说明
[POS]: npm 包详情页与插件内置 README
[PROTOCOL]: 变更时更新此头部，然后检查 src/index.ts
-->

# dsh-team-plugin · 智能体团队

让多个智能体分工协作，共同完成一件事。

本插件把 **AionUi**（[iOfficeAI/AionUi](https://github.com/iOfficeAI/AionUi)）的团队体验移植到
DeepSeek Harness：成员胶囊栏、身份色、并行/单聊视图、活动看板、暖启动遮罩。

## 安装

```sh
dsh plugin --profile web add --ignore-scripts dsh-team-plugin@latest
# 或 DSH Desktop
dsh plugin --profile desktop add --ignore-scripts dsh-team-plugin@latest
```

安装后重启对应 profile。侧栏会出现「**智能体团队**」入口。

## 怎么用

1. **组队**：在会话里直接对组长说，例如
   > 组建一个团队：一人负责调研，一人负责实现，一人负责测试。

2. **看团队**：侧栏点「智能体团队」，列表里会出现这个团队；点进去看成员与状态。

3. **干活**：在会话里给组长描述目标，由它分派给成员。

## 当前进度（E1）

| 能力 | 状态 |
|---|---|
| 侧栏入口 + 团队列表 + 团队详情 | ✅ E1 |
| 新建团队弹窗（三条硬规则校验） | ✅ E1 |
| 成员胶囊栏 + 身份色（颜色钉死） | ✅ E2 |
| 状态点（色 + 词双编码）+ 待确认角标 | ✅ E2 |
| 并行 / 单聊切换（共享选中态、按团队记忆） | ✅ E3 |
| 暖启动遮罩（组长就绪即撤 + 超时兜底） | ✅ E4 |
| 活动看板（泳道 + 消息卡/任务卡混排） | ✅ E5 |
| 任务依赖标签（`blocked_by`） | ✅ E5 |
| 看板控制条（排序/过滤/成员筛选/噪音开关） | ✅ E5 |
| 看板视图切换（第三种视图） | ✅ E5 |
| 活动取数路由（Host）+ 严格解码 | ✅ E6 |
| 任务板接入真实数据 + 依赖名解析 | ✅ E6 |
| 长轮询自动刷新（`waitForChange`，带最小间隔与失败退避） | ✅ E7 |

## 当前限制（如实说明）

- **成员间消息（mailbox）暂为空**：宿主 DSH 未提供"读取成员间消息"的服务面，
  故看板目前只有**任务**有数据。泳道、广播、fallback 等规则已全部实现并测试，
  一旦宿主提供消息面，只需在 Host 侧填上数据源即可，界面无需改动。
- **团队是「活」的**：DSH 的团队由组长会话支撑，会话结束团队就没了；AionUi 的团队持久化在本地。

## 与 AionUi 的已知差异

- **团队是「活」的**：DSH 的团队由组长会话支撑，会话结束团队就没了；AionUi 的团队持久化在本地。
- **成员是 DSH 会话**：状态语义相近，但运行时生命周期模型不同。

界面在需要时会如实说明这些差异，不静默降级。

## 安装注意事项（实机踩过的坑）

### ⚠️ 铁律一：取服务一律用 `ctx.get()`，绝不用 `(ctx as any).xxx`

Cordis 的 `ctx` 是 **Proxy**：访问未在 `inject` 数组里声明的属性会**直接抛错**：

```
cannot get property "webServer" without inject
```

这会让插件条目变成 `fiberPhase: failed`——**代码全对、单测全绿，只有实机挂载失败**。
本插件第一版就踩了这个坑：`as unknown as` 强转骗过了 TypeScript，运行时照样抛。

正确写法：

```ts
// ✓ 可选面：用 ctx.get()，未 inject 时得到 undefined，安全降级
const webServer = ctx.get('webServer') as WebServerLike | undefined
if (!webServer) return () => undefined
```

`tests/proxy-safety.test.ts` 用真代理语义守住这条；改这块代码前先看那个文件。

### ⚠️ 铁律二：必须登记进 `dsh.profile.bundles`

DSH 的 Loader **只看 `package.json` 里 `dsh.profile.bundles` 数组中列出的包**。
仅把包放进 `node_modules` 或只写 `dependencies` 都**不会**被加载——实机表现是
启动时弹「部分插件加载失败」，条目 `status: absent`。

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": { "dsh-team-plugin": "file:/path/to/dsh-team-plugin" },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dshent-plugin",
        "dsh-team-plugin"      // ← 必须在这里
      ]
    }
  }
}
```

⚠️ **web 与 desktop 两个 profile 都要改**，只改一个会出现
「桌面正常、网页报错」（反之亦然）——它们是各自独立的 profile。

### ⚠️ 铁律三：进入恢复模式会把插件踢出 `bundles`

某个插件加载失败时，DSH 的恢复模式会**自动把它从 `dsh.profile.bundles` 里移除**
（并可能写入 `desktopDeselectedBundles` 拉黑名单）。于是：

- 你修好了代码，重新加回 `bundles`，**必须退出恢复模式再启动**，否则又被踢掉；
- 判断当前是否被踢：`node -e "console.log(require('./package.json').dsh.profile.bundles)"` 里有没有它。

验证是否真的挂上（不要靠猜，直接查 Loader）：

```
dsh plugin list   →  dsh-team-plugin 的 fiberPhase 应为 active
                    failed = Host 半挂了；absent = 压根没被扫描
```

### ⭐ 铁律四：bundle 的每个外部依赖都必须声明 `dsh.client.external`

Client Loader 的 `require(spec)` 只认三类：**平台 seed word**、**已物化模块**、**已注册的包工厂**。
而 seed 表是主进程**根据图的 `external` 声明**填充的——所以：

> bundle 里写了 `require("react")`，但 `package.json` 没声明 `"external": ["react"]`
> ⇒ `react` 不在模块表 ⇒ require 抛 `missed the module table` ⇒ **fiber 起不来**
> ⇒ 表现为 `Renderer boot failed ... The client Loader did not provide an error message.`

（那个「did not provide an error message」是因为 fiber 静默未激活，`loader.await()` 并未抛错。）

```jsonc
"dsh": {
  "client": {
    "platform": "web",
    "external": ["react"],     // ← 与 bundle 里 require 的模块逐字对应
    "inject": ["@deepseek-ai/dsh-client-ui-layout"]
  }
}
```

**核对方法**：产物里 `grep -o 'require("[^"]*")'` 的结果必须与 `external` 一一对应，多一个少一个都起不来。

### 📐 发布布局必须照官方惯例

Client 产物放在 **`./client/client.js`**（不是 `./lib/client.js`），且 `files` 要同时带
`client` 与 `src`。参照本机已正常运行的 `dshmarket`：

```jsonc
{
  "exports": {
    "./client": "./client/client.js",   // ← 独立 client 目录
    ".": { "default": "./lib/index.js" }
  },
  "files": ["lib", "client", "src", "cordis.patch.yml"]
}
```

bundle 外壳要与官方逐字对齐（`Symbol.toStringTag` 那行也要有）：

```js
window.__ModuleLoader__.load({ id: '<name>', factory: (require) => {
  var module = { exports: {} };
  var exports = module.exports;
  Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
  /* ...bundle... */
  return module.exports } })
```

### 卸载

从对应 profile 的 `bundles` 数组移除该行，并删除 `node_modules/dsh-team-plugin`。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

## 许可证

本插件为独立实现。体验设计参考 AionUi（Apache-2.0）与 AionCore（Apache-2.0）。