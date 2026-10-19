# 记忆引擎 API 配置来源（跟随世界引擎）

## 背景

世界引擎与记忆引擎共用同一套 API 请求实现（`world-engine-api.js` 的 `callApi`/`callEmbeddings`/`callRerank`），
但连接配置值各自独立存储：世界引擎读 `world_engine_settings`，记忆引擎读 `memory_engine_settings`，
设置页也是两个独立表单。两边用同一家 API 时，用户要在两个面板重复填写
URL / Key / 连接方式 / 温度 / 最大输出 token / 请求超时共 6 组字段。

原设计有意保持两套配置隔离（见 `world-engine-api.js:3` 的注释：
「请求实现可以被两个引擎复用，但覆盖配置绝不能以世界引擎设置补缺」），
目的是允许世界推演与记忆提取走不同供应商。本次改动保留这一能力，只是把「共用」变成可选项。

## 方案

记忆引擎设置（常用 → 记忆引擎 API）新增「API 配置来源」单选：

- `own`（默认）：独立配置，旧行为完全不变。
- `world`：跟随世界引擎。

跟随模式下被覆盖的字段（`memory-engine-settings.js` 的 `API_FOLLOW_FIELDS`）：
`apiUrl`、`apiKey`、`connectionMode`、`temperature`、`maxTokens`、`apiTimeoutMs`。

不跟随的字段：
- `model`：记忆提取与推演的 prompt 结构不同，模型经常需要分别选（如记忆侧用长上下文模型）。
- 向量子系统全部端点配置：`vectorApiUrl`、`vectorApiKey`、`vectorRerankUrl`、`vectorRerankKey`。
  向量端点可能指向另一家供应商（如专用 embedding 服务），且用户明确要求不跟随。

## 生效配置解析

`MEMORY_ENGINE_SETTINGS.getApiSettings()` 返回本次请求实际使用的连接配置：

- `own`：直接返回记忆侧设置。
- `world`：以记忆侧设置为底，逐字段覆盖为世界引擎当前值；世界引擎侧该字段为空时
  保留记忆侧已存值（避免世界引擎未配置时把 URL/Key 清成空）。
- 每次调用都强刷两侧缓存（`getSettings(true)` + `WORLD_ENGINE_API.getSettings(true)`）：
  用户随时可能在世界引擎侧改配置，缓存会让记忆引擎继续用旧值。

## 请求出口改动

| 位置 | 改动 |
| --- | --- |
| `memory-engine.js` `requestTasks` | `callApi` 的覆盖参数由 `settings()` 改为 `apiSettings()` |
| `memory-engine.js` `ingestWorldEvolution` | 等待超时的 `apiTimeoutMs` 取 `apiSettings()` |
| `memory-engine-vector.js` `rewriteQueries` | 查询重写的连接参数取 `apiSettings()`（model 仍由 `vectorRewriteModel`/`model` 决定） |
| `memory-engine-vector.js` 索引/检索/重排 | 仍用记忆侧 `settings()`，向量端点保持独立 |

## UI 行为

- 来源下拉 `#we-memory-api-source`，切换时立即隐藏/恢复被跟随字段组（`syncApiSourceAvailability`），
  不等保存。
- 跟随模式下被跟随字段**整组隐藏**（连接方式、URL、Key、温度与输出上限、超时），只留来源下拉、
  模型选择与「获取列表」；隐藏字段里保留的仍是记忆侧自存值，不展示世界引擎的值。
- 隐藏后由一行只读状态摘要说明当前实际连接：连接方式 · URL · Key 是否已配置 ·
  模型上限 · 超时；世界引擎未配置 URL 时提示去世界引擎设置填写。
- 保存时：`apiSource` 写入新值，被跟随字段原样写回记忆侧自存值（不是世界引擎的值），
  这样切回 `own` 时恢复的是用户自己的配置。
- 「获取列表」按钮：跟随模式用 `getApiSettings(true, 'world')` 直接拉世界引擎的模型列表，
  且不得把记忆侧的旧值 `patchSettings` 回写。第二个参数是「来源覆盖」：下拉已切到跟随、
  尚未点保存时，按屏幕上的选择发请求，而不是按已存的 `own` 配置。

## 向量端点留空时的推导

设置页写明向量端点 URL/Key「留空由主 API 推导 / 复用」；跟随模式下「主 API」即世界引擎，
所以 `memory-engine-vector.js` 的 `vectorSettings()` 在 `apiSource === 'world'` 时：

- `vectorApiUrl` 留空 → 用生效配置（世界引擎）的 `apiUrl` 推导 `/embeddings`；Key 留空同理回退其 `apiKey`。
- 显式配置了 `vectorApiUrl`/`vectorApiKey` → 完全按记忆侧独立值，不跟随。
- 连接方式与超时**不**跟随：向量端点仅支持直连，跟随世界引擎的 `proxy` 会让整条召回链路直接报错；
  超时也沿用记忆侧，避免独立向量供应商被世界引擎的超时绑死。

## 兼容性

- 新字段默认 `own`，老用户升级后行为不变。
- `readStored()` 的既有迁移逻辑（test 分支曾把 `memory*` 字段误存进 `world_engine_settings`）不受影响。
- 跟随字段的保存跳过只在 UI 保存分支生效；`patchSettings` 本身仍可写入任意字段（诊断/调试需要）。

## 测试

`docs/memory-api-source-test.js`（`node docs/memory-api-source-test.js`）：
加载线上 `memory-engine-settings.js`，通过 `WORLD_ENGINE_STORE` 提供两侧配置，覆盖

1. `own` 模式自存配置原样生效；
2. `world` 模式六个跟随字段取世界引擎、model 与向量端点保持记忆侧；
3. 世界引擎字段为空时回退记忆侧已存值；
4. 非法 `apiSource` 归一为 `own`；
5. 保存侧语义（跟随时保留自存字段，切回 `own` 恢复）；
6. 请求出口与查询重写的连接参数语义；
7. 来源覆盖参数（下拉切换未保存时按屏幕选择取配置）；
8. 向量端点留空时的推导来源（跟随世界引擎 / 显式独立端点两种情况）；
9. UI 源码接线断言（来源下拉、整组隐藏、保存分支、获取列表分支、向量区提示）。

`docs/memory-api-follow-e2e-test.js`（`node docs/memory-api-follow-e2e-test.js`）：
加载完整记忆引擎并手动提取，断言真正发往 `callApi` 的 URL/Key/连接方式/温度/输出上限/超时
就是跟随后的值、世界引擎侧改值后下一次请求立即生效、切回 `own` 后回到记忆侧自存值。

## 已知限制

- 跟随模式下被跟随字段全部隐藏，用户无法在记忆侧看到或微调温度/输出上限/超时，
  需要到世界引擎设置里改——这是刻意的，避免两处配置看起来可改实际不生效。
- 向量端点为空时由主 API URL 推导 `/embeddings`，跟随模式下推导用的是世界引擎的 URL
  （见上文「向量端点留空时的推导」）：同供应商场景属合理行为，但意味着向量端点会
  在 URL/Key 推导层面间接受跟随影响；需要完全独立时把向量端点与 Key 都填上即可。
