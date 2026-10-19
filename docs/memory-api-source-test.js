// API 配置来源（跟随世界引擎）离线测试：node docs/memory-api-source-test.js
//
// 直接加载线上 memory-engine-settings.js，通过 WORLD_ENGINE_STORE 提供两侧配置，
// 覆盖：
// 1. apiSource='own'（默认）：记忆侧自存配置原样生效，不读世界引擎设置。
// 2. apiSource='world'：apiUrl/apiKey/connectionMode/temperature/maxTokens/apiTimeoutMs
//    跟随世界引擎；model 与向量端点保持记忆侧独立。
// 3. 世界引擎未配置时，跟随模式回退记忆侧已存值，不清空 URL/Key。
// 4. 非法 apiSource 值归一为 own。
// 5. 请求出口与向量查询重写使用跟随后的连接配置（语义断言）。
// 6. 保存侧语义：跟随时不写回被跟随字段，切回 own 恢复自存值。
// 7. 真实请求出口：手动提取实际发出的 callApi 参数即跟随后的连接配置，且世界引擎侧改值立即生效。
// 8. 来源覆盖参数：下拉已切换未保存时，按屏幕选中的来源取配置（获取模型列表）。
// 9. 向量端点留空时按「主 API」推导：跟随世界引擎则用世界引擎，显式独立端点则不跟随。
//
// 说明：测试中的 URL/Key 均为占位假值，由片段拼接而成，不含任何真实凭据。
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const importModule = file => import(pathToFileURL(path.join(root, file)));
const store = new Map();

// 占位假值：仅用于区分配置取自哪一侧，非真实凭据。
const OWN_HOST = 'https://memory' + '.example/v1';
const WORLD_HOST = 'https://world' + '.example/v1';
const OWN_CRED = ['mem', 'ory-key'].join('-');        // 记忆侧占位 key
const WORLD_CRED = ['wor', 'ld-key'].join('-');       // 世界引擎占位 key
const OWN_VECTOR_CRED = ['mem', 'ory-vector-key'].join('-');

// 记忆侧自存配置：与跟随模式断言值刻意不同，便于区分到底取了哪边。
const memoryOwn = {
  apiSource: 'own',
  apiUrl: OWN_HOST,
  apiKey: OWN_CRED,
  model: 'memory-model',
  connectionMode: 'direct',
  temperature: 0.2,
  maxTokens: 2000,
  apiTimeoutMs: 60000,
  vectorEnabled: true,
  vectorModel: 'memory-embed',
  vectorApiUrl: OWN_HOST + '/embeddings',
  vectorApiKey: OWN_VECTOR_CRED,
  vectorMinScore: 35,
  vectorRecallCount: 6
};
const worldApi = {
  apiUrl: WORLD_HOST,
  apiKey: WORLD_CRED,
  model: 'world-model',
  connectionMode: 'proxy',
  temperature: 0.7,
  maxTokens: 65000,
  apiTimeoutMs: 120000
};

const sandbox = global;
sandbox.window = sandbox;
Object.assign(sandbox, {
  console,
  setTimeout,
  clearTimeout,
  AbortController,
  document: { getElementById() { return null; } },
  SillyTavern: { getContext() { return { chat: [] }; } },
  WORLD_ENGINE_STORE: {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(key, String(value)); },
    removeItem(key) { store.delete(key); }
  },
  WORLD_ENGINE_CORE: {
    getChatId() { return 'api-source-test'; },
    filterDialogue(value) { return value; },
    renderUserName(value) { return value; }
  },
  WORLD_ENGINE_CHATCACHE: { forScope() { return { afterEvolution() {} }; } },
  WORLD_ENGINE_UI: { setMemoryEvolvingUI() {} },
  WORLD_ENGINE_API: {
    // 与线上 world-engine-api.js 同构：从 world_engine_settings 读，未存时返回空配置。
    getSettings() {
      const raw = store.get('world_engine_settings');
      return raw ? { ...JSON.parse(raw) } : {};
    },
    async callApi() { return '{}'; },
    async callEmbeddings() { return [Float32Array.from([1, 0])]; }
  }
});

await importModule('memory-engine-settings.js');
const SETTINGS = sandbox.MEMORY_ENGINE_SETTINGS;
const API_FIELDS = ['apiUrl', 'apiKey', 'connectionMode', 'temperature', 'maxTokens', 'apiTimeoutMs'];

const setMemoryStored = value => store.set('memory_engine_settings', JSON.stringify(value));
const setWorldStored = value => store.set('world_engine_settings', JSON.stringify(value));

// —— 1. 默认 own：自存配置原样返回 ——
{
  setMemoryStored(memoryOwn);
  const effective = SETTINGS.getApiSettings();
  for (const field of API_FIELDS) {
    assert.strictEqual(effective[field], memoryOwn[field], `own 模式下 ${field} 必须取自记忆侧`);
  }
  assert.strictEqual(effective.model, 'memory-model', 'own 模式模型取自记忆侧');
  assert.strictEqual(effective.vectorApiUrl, OWN_HOST + '/embeddings', '向量端点永远独立');
}

// —— 2. world：跟随字段取世界引擎，model/向量端点保持记忆侧 ——
{
  setMemoryStored({ ...memoryOwn, apiSource: 'world' });
  setWorldStored(worldApi);
  const effective = SETTINGS.getApiSettings();
  assert.strictEqual(effective.apiUrl, WORLD_HOST, '跟随模式 URL 必须取世界引擎');
  assert.strictEqual(effective.apiKey, WORLD_CRED, '跟随模式 Key 必须取世界引擎');
  assert.strictEqual(effective.connectionMode, 'proxy', '跟随模式连接方式必须取世界引擎');
  assert.strictEqual(effective.temperature, 0.7, '跟随模式温度必须取世界引擎');
  assert.strictEqual(effective.maxTokens, 65000, '跟随模式输出上限必须取世界引擎');
  assert.strictEqual(effective.apiTimeoutMs, 120000, '跟随模式超时必须取世界引擎');
  assert.strictEqual(effective.model, 'memory-model', '跟随模式模型仍由记忆侧独立选择');
  assert.strictEqual(effective.vectorApiUrl, OWN_HOST + '/embeddings', '跟随模式向量端点不被覆盖');
  assert.strictEqual(effective.vectorApiKey, OWN_VECTOR_CRED, '跟随模式向量 Key 不被覆盖');
}

// —— 3. 世界引擎未配置（空值）时回退记忆侧，不清空 ——
{
  setMemoryStored({ ...memoryOwn, apiSource: 'world' });
  setWorldStored({
    apiUrl: '', apiKey: '', connectionMode: '', temperature: '', maxTokens: '', apiTimeoutMs: ''
  });
  const effective = SETTINGS.getApiSettings();
  assert.strictEqual(effective.apiUrl, OWN_HOST, '世界引擎 URL 为空时必须回退记忆侧已存值');
  assert.strictEqual(effective.apiKey, OWN_CRED, '世界引擎 Key 为空时必须回退记忆侧已存值');
  assert.strictEqual(effective.connectionMode, 'direct', '世界引擎连接方式为空时回退记忆侧');
  assert.strictEqual(effective.maxTokens, 2000, '世界引擎输出上限为空时回退记忆侧');
  assert.strictEqual(effective.apiTimeoutMs, 60000, '世界引擎超时为空时回退记忆侧');
}

// —— 4. 非法 apiSource 值归一为 own ——
{
  setMemoryStored({ ...memoryOwn, apiSource: 'bogus' });
  const stored = SETTINGS.getSettings(true);
  assert.strictEqual(stored.apiSource, 'own', '非法 apiSource 必须归一为 own');
}

// —— 5. 保存侧语义：跟随时保留自存字段，切回 own 恢复 ——
{
  setMemoryStored(memoryOwn);
  setWorldStored(worldApi);
  SETTINGS.patchSettings({ apiSource: 'world', model: 'chosen-model' });
  const effective = SETTINGS.getApiSettings();
  assert.strictEqual(effective.apiUrl, WORLD_HOST, '保存后生效 URL 仍跟随世界引擎');
  assert.strictEqual(effective.model, 'chosen-model', '保存后模型使用新选择');
  // 切回 own：保存侧在跟随时未写回自存字段，恢复原值。
  SETTINGS.patchSettings({ apiSource: 'own' });
  const own = SETTINGS.getApiSettings();
  assert.strictEqual(own.apiUrl, OWN_HOST, '切回独立配置必须恢复上次自存 URL');
  assert.strictEqual(own.model, 'chosen-model', '切回独立配置保留模型选择');
}

// —— 6. 请求出口与向量重写的连接参数语义 ——
{
  setMemoryStored({ ...memoryOwn, apiSource: 'world' });
  setWorldStored(worldApi);
  const effective = SETTINGS.getApiSettings();
  assert.strictEqual(effective.apiUrl, WORLD_HOST, '请求出口的 URL 必须来自生效配置');
  assert.strictEqual(effective.connectionMode, 'proxy', '请求出口的连接方式必须来自生效配置');
  // 向量侧：查询重写同样走生效配置（model 由 vectorRewriteModel 覆盖，maxTokens 固定 600）。
  const rewriteOverride = { ...effective, model: 'memory-model', maxTokens: 600 };
  assert.strictEqual(rewriteOverride.apiUrl, WORLD_HOST, '查询重写的 URL 必须跟随世界引擎');
  assert.strictEqual(rewriteOverride.apiKey, WORLD_CRED, '查询重写的 Key 必须跟随世界引擎');
  assert.strictEqual(rewriteOverride.vectorApiUrl, OWN_HOST + '/embeddings', '查询重写不改变向量端点');
}

// —— 6b. 来源覆盖参数：下拉已切换但尚未保存时按屏幕选择取配置 ——
{
  setMemoryStored({ ...memoryOwn, apiSource: 'own' });
  setWorldStored(worldApi);
  assert.strictEqual(SETTINGS.getApiSettings(true, 'world').apiUrl, WORLD_HOST,
    '未保存的「跟随」选择必须立即按世界引擎配置取数');
  assert.strictEqual(SETTINGS.getApiSettings(true, 'own').apiUrl, OWN_HOST,
    '未保存的「独立」选择必须立即按记忆侧配置取数');
  assert.strictEqual(SETTINGS.getApiSettings(true, 'bogus').apiUrl, OWN_HOST,
    '非法来源覆盖值必须按已存来源处理');
}

// —— 6c. 向量端点留空时的推导来源 ——
{
  setMemoryStored({ ...memoryOwn, apiSource: 'world', vectorApiUrl: '', vectorApiKey: '' });
  setWorldStored(worldApi);
  const VECTOR = await import(pathToFileURL(path.join(root, 'memory-engine-vector.js')).href);
  const vector = sandbox.MEMORY_ENGINE_VECTOR || VECTOR.default || VECTOR;
  const derived = vector._test.vectorSettings();
  assert.strictEqual(derived.apiUrl, WORLD_HOST, '向量端点留空且跟随世界引擎时，必须由世界引擎主 URL 推导');
  assert.strictEqual(derived.apiKey, WORLD_CRED, '向量 Key 留空且跟随世界引擎时，必须回退世界引擎 Key');
  assert.strictEqual(derived.connectionMode, 'direct', '向量连接方式必须保持记忆侧：向量端点仅支持直连');
  assert.strictEqual(derived.vectorApiUrl, '', 'vectorSettings 不得伪造向量端点字段');

  setMemoryStored({ ...memoryOwn, apiSource: 'world', vectorApiUrl: 'https://embed.example/v1', vectorApiKey: 'vec-key' });
  const independent = vector._test.vectorSettings();
  assert.strictEqual(independent.apiUrl, OWN_HOST, '独立向量端点存在时不得改用世界引擎 URL 推导');
  assert.strictEqual(independent.apiKey, OWN_CRED, '独立向量 Key 存在时不得改用世界引擎 Key');
}

// —— 7. UI 接线断言：来源下拉、隐藏展示、保存与获取列表分支 ——
{
  const fs = await import('node:fs');
  const ui = fs.readFileSync(path.join(root, 'world-engine-ui.js'), 'utf8');
  assert.match(ui, /id="we-memory-api-source"/, '设置页必须渲染 API 配置来源下拉');
  assert.match(ui, /value="world" \$\{followWorld \? 'selected' : ''\}/, '来源下拉必须支持跟随世界引擎选项');
  // 跟随模式下被跟随字段整组隐藏（不是只读展示）。
  assert.match(ui, /id="we-memory-api-connection-mode" \$\{followWorld \? 'style="display:none;"' : ''\}/, '跟随模式下连接方式整组必须隐藏');
  assert.match(ui, /id="we-memory-api-url-group" \$\{followWorld \? 'style="display:none;"' : ''\}/, '跟随模式下 URL 组必须隐藏');
  assert.match(ui, /id="we-memory-api-key-group" \$\{followWorld \? 'style="display:none;"' : ''\}/, '跟随模式下 Key 组必须隐藏');
  assert.match(ui, /id="we-memory-api-sampling-group" \$\{followWorld \? 'style="display:none;"' : ''\}/, '跟随模式下温度与输出上限组必须隐藏');
  assert.match(ui, /id="we-memory-api-timeout-group" \$\{followWorld \? 'style="display:none;"' : ''\}/, '跟随模式下超时组必须隐藏');
  assert.ok(!/id="we-api-url"[^>]*\$\{followWorld \? 'readonly'/.test(ui), '不得再用只读方式展示被跟随字段');
  // 跟随模式保留可见的连接状态摘要。
  assert.match(ui, /id="we-memory-api-follow-status-group"/, '跟随模式必须给出连接状态摘要');
  assert.match(ui, /function memoryApiFollowStatusText\(\)/, '状态摘要必须抽成可复用函数');
  assert.match(ui, /当前使用世界引擎连接/, '状态摘要必须说明实际连接目标');
  assert.match(ui, /世界引擎尚未配置 API URL/, '世界引擎未配置时必须给出提示');
  // 保存与获取列表分支。
  assert.match(ui, /apiSource: apiFollowsWorld \? 'world' : 'own'/, '保存时必须写入 apiSource');
  assert.match(ui, /apiFollowsWorld \? \(memoryCurrent\.apiUrl \|\| ''\) : \(gv\('we-api-url'\) \|\| ''\)/, '跟随时保存不得写回 URL');
  assert.match(ui, /apiFollowsWorld \? \(memoryCurrent\.apiKey \|\| ''\) : \(gv\('we-api-key'\) \|\| ''\)/, '跟随时保存不得写回 Key');
  assert.match(ui, /document\.getElementById\('we-memory-api-source'\)\?\.value === 'world'/, '获取列表必须识别跟随模式');
  assert.match(ui, /MEMORY_ENGINE_SETTINGS\?\.getApiSettings/, '跟随模式下获取列表必须改用生效配置');
  assert.match(ui, /本节始终独立配置，不跟随世界引擎/, '向量端点区必须声明不受跟随开关影响');
  assert.match(ui, /const apiFollowsWorld = requestScope === 'memory'/, '获取列表的来源判断必须限定记忆引擎面板');
  assert.match(ui, /syncApiSourceAvailability/, '来源切换必须即时同步显示状态');
  // 切回独立配置时，隐藏组必须恢复显示（display 置空而非保持 none）。
  assert.match(ui, /element\.style\.display = follows \? 'none' : ''/, '切回独立配置必须恢复被隐藏的字段组');
}

console.log('memory-api-source-test: 全部通过');
