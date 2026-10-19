# 世界引擎 · 本地开发环境

SillyTavern 第三方扩展「世界引擎」的开发脚手架。这里的东西**不随扩展发布**：酒馆只加载 `manifest.json` 声明的
`world-engine.js` 与 `style.css`，`package.json`、`eslint.config.mjs`、`scripts/`、`types/` 只服务于本机开发。

## 环境要求

- Node.js ≥ 20（本仓库在 v24.19.0 上验证）
- npm（默认走 `https://registry.npmmirror.com/`，无需额外配置）

## 首次安装

```powershell
npm install
```

依赖只有 ESLint 与 Node 全局变量表，装在仓库内的 `node_modules/`（已 gitignore）。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run check` | 语法检查 + ESLint，提交前至少跑这个 |
| `npm run check:syntax` | 对根目录、`docs/`、`scripts/` 的 `.js/.mjs` 逐个执行 `node --check` |
| `npm run lint` | ESLint 全量检查（当前基线：0 error，14 warning） |
| `npm run lint:fix` | 自动修复可修复项 |
| `npm test` | 依次运行 `docs/*-test.js` |
| `npm test -- --filter memory` | 只跑文件名含 `memory` 的用例 |
| `npm test -- --list` | 只列出会跑的测试文件 |
| `npm run verify` | `check` + `test`，发布前的完整门禁 |

## 目录与加载顺序

```
manifest.json            # 酒馆识别扩展：入口 js、generate_interceptor、样式
world-engine.js          # 唯一入口：脚本按顺序动态注入，随后绑定事件
world-engine-store.js    # ┐
world-engine-core.js     # │ SHARED_MODULES：先加载、供两套引擎共用
world-engine-api.js      # │
world-engine-bridge.js   # │
world-engine-worldbook.js# │
world-engine-chatcache.js# │
world-engine-inject-inspector.js
world-engine-preset.js   # ┐ world 引擎组
world-engine-rules-loader.js
world-engine-ledger.js
world-engine-evolution.js
world-engine-inject.js
memory-engine-*.js       # ┐ memory 引擎组（settings/data/timeline/vector/prompt/summary/engine）
world-engine-ui-ball.js  # ┐ UI 组
world-engine-diag.js     # │
world-engine-ui.js       # │ 面板、设置、列表渲染
style.css
docs/                    # 说明文档与离线测试（*-test.js）
scripts/                 # 开发脚本（不进入浏览器）
types/globals.d.ts       # 仅编辑器用的全局声明
```

- 每个模块都是 IIFE，把接口挂到 `window.*`（如 `window.WORLD_ENGINE_CORE`）。入口会按
  `SHARED_CONTRACTS` / `ENGINE_MODULE_GROUPS[].contracts` 校验必需方法，缺方法会直接报错，因此新增或改名接口时
  要同步更新 `world-engine.js` 里的清单与契约。
- 新增一个模块 = 新建文件 + 加入对应清单 + 在 `window.*` 上导出契约方法 + 在 `docs/` 加一条 `*-test.js`。
- `package.json` 标记了 `"type": "module"`，`docs/` 下的测试用 ESM 直接跑；浏览器侧文件仍是经典脚本，
  两部分互不影响。

## 编辑器

- `jsconfig.json` + `types/globals.d.ts`：为 `SillyTavern`、`toastr`、`$` 等运行时全局提供补全，不做类型检查
  （`checkJs: false`）。接入新的酒馆全局时，先在 `types/globals.d.ts` 声明，再在 `eslint.config.mjs` 的
  `tavernGlobals` 里登记，避免 `no-undef` 误报。
- `.editorconfig`：UTF-8、LF、2 空格缩进。仓库 `core.autocrlf=true`，工作区检出为 CRLF 属正常现象，提交时
  由 git 统一成 LF。

## 调试

- 改完代码刷新酒馆页面即可；部分面板改动只需重开「扩展设置」。
- `window.__WORLD_ENGINE_LOADED__`：入口是否已执行的幂等标记。
- `window.WORLD_ENGINE_ERROR_LOG.list()`：最近 50 条被隔离的引擎异常（含堆栈）。
- `window.WORLD_ENGINE_DIAG.collect()` / `.download()`：导出诊断包，排查用户环境问题。
- 每个引擎的 `WORLD_ENGINE_GUARD_EVENT` 会把事件处理器的同步异常与 Promise rejection 收进错误日志，不会打断聊天。

## 测试约定

`docs/*-test.js` 是 Node ESM 脚本，纯离线断言：用 `fs` 读源码做静态断言，或用假的 `window`/`document`/`global`
加载模块后验证行为。命名以 `-test.js` 结尾即会被 `npm test` 收录；需要真实 API 或酒馆内行为的验证请写进
`docs/*.md` 的手工步骤，不要放进自动测试。

## ESLint 基线说明

- 只启用当前代码已整体满足的格式规则（引号、分号、空格等），**没有**开启缩进/对齐检查：一次性重排 1.1 MB
  既有代码没有收益，缩进交给编辑器的 `.editorconfig`。
- `no-unused-vars`、`no-redeclare` 是 warning：模块常为“跨模块约定”保留未用变量，事件处理器里也重用
  `var scope`。清理这些 warning 是独立任务，不阻断 `npm run verify`。
- 当前 14 条 warning 集中在 `world-engine-ui.js`（`dashNum`、`oldText`、6 处 `scope/s` 重定义）、
  `memory-engine.js`、`world-engine-inject.js`、`world-engine-preset.js`。

## 发布检查

1. `npm run verify` 全绿。
2. 同步版本号：`manifest.json` 的 `version` 与 `package.json` 的 `version`。
3. 更新 `manifest.json` 的 `description`（酒馆扩展列表直接展示这段长文案）。
4. 只提交扩展运行所需的文件；`node_modules/`、`.npm-cache/`、`.dsh-acl-repair/`、`.mimosa/` 已被忽略。
