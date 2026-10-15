// 多引擎故障边界离线测试：node docs/sandbox-engine-isolation-test.js
// 用假 DOM 驱动 world-engine.js 本体的 script 加载器（Node ESM import 本体 IIFE），
// 保留原断言语义：
//   1) evolution 模块加载后契约缺失（模拟执行崩溃但 onload 仍触发）+ UI.buildInputButton 抛错
//      → 世界组降级，但 finally 边界仍启动记忆引擎且只 init 一次；
//   2) WORLD_ENGINE_GUARD_EVENT 同步/异步异常只记故障不外抛；
//   3) ChatCache 必须自行订阅 CHAT_LOADED（不依赖入口代订）。
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const importModule = file => import(pathToFileURL(path.join(root, file)));
const realConsole = console;   // 后续用例会替换 global.console，末尾的失败输出要用真身

// ── 1) 世界模块崩溃不阻塞记忆引擎 ──
async function testExecutionCrashDoesNotBlockMemory() {
  let memoryInitCount = 0;
  const errors = [];
  const sandbox = global;
  sandbox.window = sandbox;
  sandbox.console = { log() {}, warn() {}, error(...args) { errors.push(args); } };
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.fetch = async () => ({ ok: false });
  sandbox.setInterval = () => 0;

  const install = filename => {
    const APIs = {
      'world-engine-store.js': ['WORLD_ENGINE_STORE', { hydrate: async () => {}, getItem() { return null; }, setItem() {} }],
      'world-engine-core.js': ['WORLD_ENGINE_CORE', { getChatId() { return 'test'; }, loadState() { return {}; } }],
      'world-engine-api.js': ['WORLD_ENGINE_API', { callApi: async () => '' }],
      'world-engine-bridge.js': ['WORLD_ENGINE_BRIDGE', { buildBridgeSection: async () => '', buildHistorySection: async () => '' }],
      'world-engine-worldbook.js': ['WORLD_ENGINE_WORLDBOOK', { buildPromptSection: async () => '' }],
      'world-engine-chatcache.js': ['WORLD_ENGINE_CHATCACHE', { init() {} }],
      'world-engine-inject-inspector.js': ['WORLD_ENGINE_INJECT_INSPECTOR', { init() {} }],
      'world-engine-preset.js': ['WORLD_ENGINE_PRESET', { getActivePreset() { return null; } }],
      'world-engine-rules-loader.js': ['WORLD_ENGINE_RULES', { loadRules: async () => ({ count: 0 }) }],
      'world-engine-ledger.js': ['WORLD_ENGINE_LEDGER', { recordChanges() {} }],
      // 故意不暴露 WORLD_ENGINE_EVOLUTION：模拟脚本执行期崩溃但 script.onload 仍触发。
      'world-engine-evolution.js': null,
      'world-engine-inject.js': ['WORLD_ENGINE_INJECT', { buildContext() { return ''; } }],
      'memory-engine-settings.js': ['MEMORY_ENGINE_SETTINGS', { getSettings() { return {}; }, patchSettings() {} }],
      'memory-engine-data.js': ['MEMORY_ENGINE_DATA', { loadState() { return { personal_memory: [] }; }, saveState() {} }],
      'memory-engine-timeline.js': ['MEMORY_ENGINE_TIMELINE', { captureRange() { return []; }, auditRefs() { return { valid: true, refs: [] }; }, syncHidden() {} }],
      'memory-engine-prompt.js': ['MEMORY_ENGINE_PROMPT', { buildUserPrompt() { return ''; } }],
      'memory-engine-small-summary-prompt.js': ['MEMORY_ENGINE_SMALL_SUMMARY_PROMPT', { buildUserPrompt() { return ''; } }],
      'memory-engine-big-summary-prompt.js': ['MEMORY_ENGINE_BIG_SUMMARY_PROMPT', { buildUserPrompt() { return ''; } }],
      'memory-engine.js': ['MEMORY_ENGINE', {
        init() { memoryInitCount++; }, applyInjection() {}, abort() {}, isRunning() { return false; }
      }],
      'world-engine-diag.js': ['WORLD_ENGINE_DIAG', { collect() { return {}; }, download() {} }],
      'world-engine-ui.js': ['WORLD_ENGINE_UI', {
        buildPanel() {},
        // 再注入一个世界降级 UI 错误，验证 finally 边界仍会启动记忆。
        buildInputButton() { throw new Error('simulated world UI failure'); },
        refresh() {}
      }]
    };
    const entry = APIs[filename];
    if (entry) sandbox[entry[0]] = entry[1];
  };

  sandbox.document = {
    readyState: 'complete',
    addEventListener() {},
    getElementsByTagName() { return [{ src: 'https://example.test/world-engine.js' }]; },
    createElement() { return {}; },
    head: {
      appendChild(script) {
        install(script.src.split('/').pop());
        queueMicrotask(() => script.onload());
      }
    }
  };

  // import 本体：IIFE 立刻跑 init()，经假 DOM 逐个「加载」上面的桩并走到 finally。
  await importModule('world-engine.js');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.strictEqual(memoryInitCount, 1, '世界模块/界面失败后，记忆引擎仍应独立初始化一次');
  assert.ok(errors.some(args => String(args[0]).includes('接口契约不完整') || String(args[0]).includes('模块加载失败')),
    '世界接口契约缺失应被明确记录');
  sandbox.WORLD_ENGINE_GUARD_EVENT_KEPT = sandbox.WORLD_ENGINE_GUARD_EVENT;
}

// ── 2) 共用事件故障边界 ──
async function testSharedEventGuardHandlesSyncAndAsyncErrors() {
  const guard = global.WORLD_ENGINE_GUARD_EVENT_KEPT;
  assert.strictEqual(typeof guard, 'function', '本体加载后必须暴露共用事件故障边界');
  const errors = [];
  global.console = { log() {}, warn() {}, error(...args) { errors.push(args); } };
  assert.doesNotThrow(() => guard('测试引擎', '同步', () => { throw new Error('sync'); })());
  await assert.doesNotReject(() => guard('测试引擎', '异步', async () => { throw new Error('async'); })());
  assert.strictEqual(errors.length, 2, '同步与异步异常都必须被记录且不外抛');
}

// ── 3) ChatCache 自行订阅 CHAT_LOADED ──
async function testChatCacheOwnsChatLifecycle() {
  const listeners = new Map();
  const context = {
    chatId: null,
    event_types: { CHAT_LOADED: 'chat_loaded' },
    eventSource: { on(name, handler) { listeners.set(name, handler); } }
  };
  global.window = global;
  global.console = { log() {}, warn() {}, error() {} };
  global.setTimeout = setTimeout;
  global.clearTimeout = clearTimeout;
  global.SillyTavern = { getContext() { return context; } };
  global.WORLD_ENGINE_STORE = { setSyncSink() {}, getItem() { return null; }, setItem() {}, removeItem() {} };
  global.WORLD_ENGINE_GUARD_EVENT = (_engine, _event, handler) => handler;
  await importModule('world-engine-chatcache.js');
  global.WORLD_ENGINE_CHATCACHE.init();
  assert.strictEqual(typeof listeners.get('chat_loaded'), 'function', 'ChatCache 必须自行订阅 CHAT_LOADED');
  assert.throws(() => global.WORLD_ENGINE_CHATCACHE.forScope('unknown-engine'), /未知聊天缓存 scope/);
}

(async () => {
  await testExecutionCrashDoesNotBlockMemory();
  await testSharedEventGuardHandlesSyncAndAsyncErrors();
  await testChatCacheOwnsChatLifecycle();
  realConsole.log('✓ 多引擎故障隔离测试通过');
})().catch(error => {
  realConsole.error(error);
  process.exitCode = 1;
});
