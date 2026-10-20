// 跟随世界引擎的请求出口端到端测试：node docs/memory-api-follow-e2e-test.js
//
// 与 memory-api-source-test.js 的区别：那个测配置解析的语义，这里加载完整记忆引擎，
// 断言真正发往 WORLD_ENGINE_API.callApi 的参数就是跟随后的连接配置，且世界引擎侧改值后下次请求立即生效。
//
// 说明：URL/Key 均为占位假值，由片段拼接而成，不含任何真实凭据。
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const importModule = file => import(pathToFileURL(path.join(root, file)));
const store = new Map();
const requests = [];
const chat = [
  { is_user: false, mes: '这是开场白。' },
  { is_user: true, mes: '我进城。' },
  { is_user: false, mes: '城门关闭。' }
];
const context = {
  chat,
  name1: '用户',
  name2: '角色',
  setExtensionPrompt() {},
  eventSource: { on() {} },
  event_types: {}
};
const sandbox = global;
sandbox.window = sandbox;
Object.assign(sandbox, {
  console,
  setTimeout,
  clearTimeout,
  AbortController,
  atob,
  btoa,
  document: { getElementById() { return null; } },
  SillyTavern: { getContext() { return context; } },
  WORLD_ENGINE_STORE: {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(key, String(value)); },
    removeItem(key) { store.delete(key); }
  },
  WORLD_ENGINE_CORE: {
    getChatId() { return 'follow-e2e'; },
    getChatLayer() { return chat.length - 1; },
    filterDialogue(value) { return value; },
    renderUserName(value) { return value; },
    buildPersonaSection() { return '========== 用户人设（{{user}} 的角色设定）==========\n测试人设正文'; }
  },
  WORLD_ENGINE_WORLDBOOK: { async buildPromptSection() { return ''; } },
  WORLD_ENGINE_CHATCACHE: { forScope() { return { afterEvolution() {}, createSnapshot() {} }; } },
  WORLD_ENGINE_UI: { setMemoryEvolvingUI() {}, refresh() {} },
  WORLD_ENGINE_API: {
    getSettings() {
      const raw = store.get('world_engine_settings');
      return raw ? JSON.parse(raw) : {};
    },
    async callApi(prompt, maxTokens, temperature, signal, settings) {
      requests.push({ prompt, maxTokens, temperature, settings });
      return JSON.stringify({
        personal_memory: [{ name: ['角色'], known_by: [], memory: '得知城门关闭。', time: '' }],
        entity_updates: []
      });
    },
    async callEmbeddings() { return []; }
  }
});

for (const file of [
  'memory-engine-settings.js', 'memory-engine-data.js', 'memory-engine-prompt.js',
  'memory-engine-small-summary-prompt.js', 'memory-engine-big-summary-prompt.js', 'memory-engine.js'
]) await importModule(file);

const OWN_HOST = 'https://memory' + '.example/v1';
const WORLD_HOST = 'https://world' + '.example/v1';
const OWN_CRED = ['mem', 'ory-key'].join('-');
const WORLD_CRED = ['wor', 'ld-key'].join('-');

store.set('memory_engine_settings', JSON.stringify({
  apiSource: 'world',
  apiUrl: OWN_HOST,
  apiKey: OWN_CRED,
  model: 'memory-model',
  connectionMode: 'direct',
  temperature: 0.2,
  maxTokens: 2000,
  apiTimeoutMs: 60000
}));
store.set('world_engine_settings', JSON.stringify({
  apiUrl: WORLD_HOST,
  apiKey: WORLD_CRED,
  model: 'world-model',
  connectionMode: 'proxy',
  temperature: 0.55,
  maxTokens: 90000,
  apiTimeoutMs: 45000
}));

await sandbox.MEMORY_ENGINE.manualExtract();
assert.ok(requests.length >= 1, '手动提取必须发出至少一次 chat 请求');
{
  const sent = requests.at(-1);
  assert.strictEqual(sent.settings.apiUrl, WORLD_HOST, '实际请求 URL 必须跟随世界引擎');
  assert.strictEqual(sent.settings.apiKey, WORLD_CRED, '实际请求 Key 必须跟随世界引擎');
  assert.strictEqual(sent.settings.connectionMode, 'proxy', '实际请求连接方式必须跟随世界引擎');
  assert.strictEqual(sent.temperature, 0.55, '实际请求温度必须跟随世界引擎');
  assert.strictEqual(sent.maxTokens, 90000, '实际请求输出上限必须跟随世界引擎');
  assert.strictEqual(sent.settings.apiTimeoutMs, 45000, '实际请求超时必须跟随世界引擎');
  assert.strictEqual(sent.settings.model, 'world-model', '实际请求模型必须跟随世界引擎');
  // 用户人设必须作为只读参照放在任务说明与已知信息之后，不能抢在请求最前面。
  const prompt = sent.prompt || '';
  assert.ok(prompt.startsWith('【任务说明】'), '请求必须从任务说明开始');
  assert.ok(prompt.indexOf('【任务说明】') < prompt.indexOf('用户人设'), '用户人设必须在任务说明之后');
  assert.ok(prompt.indexOf('【已知实体】') < prompt.indexOf('用户人设'), '用户人设必须在已知信息之后');
  assert.ok(prompt.indexOf('用户人设') < prompt.indexOf('【待提取对话】'), '用户人设必须在待提取对话之前');
}

// 世界引擎侧改值后，记忆侧无需刷新缓存，下一次请求立即生效。
{
  const world = JSON.parse(store.get('world_engine_settings'));
  world.temperature = 0.9;
  world.maxTokens = 12345;
  world.model = 'world-model-2';
  store.set('world_engine_settings', JSON.stringify(world));
  chat.push({ is_user: true, mes: '我去找守卫。' }, { is_user: false, mes: '守卫说暂无消息。' });
  await sandbox.MEMORY_ENGINE.manualExtract();
  const sent = requests.at(-1);
  assert.strictEqual(sent.temperature, 0.9, '世界引擎改温度后，记忆侧下一次请求必须立即使用新值');
  assert.strictEqual(sent.maxTokens, 12345, '世界引擎改输出上限后，记忆侧下一次请求必须立即使用新值');
  assert.strictEqual(sent.settings.model, 'world-model-2', '世界引擎改模型后，记忆侧下一次请求必须立即使用新值');
}

// 切回独立配置：请求必须回到记忆侧自存值，说明跟随期间的保存没有写坏自存字段。
{
  sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({ apiSource: 'own' });
  chat.push({ is_user: true, mes: '回旅店。' }, { is_user: false, mes: '旅店很安静。' });
  await sandbox.MEMORY_ENGINE.manualExtract();
  const sent = requests.at(-1);
  assert.strictEqual(sent.settings.apiUrl, OWN_HOST, '切回独立配置后请求必须回到记忆侧 URL');
  assert.strictEqual(sent.settings.apiKey, OWN_CRED, '切回独立配置后请求必须回到记忆侧 Key');
  assert.strictEqual(sent.temperature, 0.2, '切回独立配置后温度必须回到记忆侧自存值');
  assert.strictEqual(sent.maxTokens, 2000, '切回独立配置后输出上限必须回到记忆侧自存值');
  assert.strictEqual(sent.settings.model, 'memory-model', '切回独立配置后模型必须回到记忆侧自存值');
}

console.log(`✓ 跟随世界引擎请求出口测试通过（${requests.length} 次请求）`);
