// 记忆 JSON 容错离线测试：node docs/memory-json-resilience-test.js
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const importModule = file => import(pathToFileURL(path.join(root, file)));
const sandbox = global;
sandbox.window = sandbox;
Object.assign(sandbox, {
  console, setTimeout, clearTimeout, AbortController,
  document: { getElementById() { return null; } },
  SillyTavern: { getContext() { return null; } },
  WORLD_ENGINE_STORE: { getItem: () => null, setItem() {}, removeItem() {} },
  WORLD_ENGINE_CORE: {},
  MEMORY_ENGINE_SETTINGS: { getSettings: () => ({}) },
  WORLD_ENGINE_UI: {},
  WORLD_ENGINE_API: {}
});

for (const filename of ['memory-engine.js']) {
  await importModule(filename);
}
const T = sandbox.MEMORY_ENGINE._test;

// —— 思维链剥离 ——
assert.strictEqual(T.stripThinking('<think>草稿 {"a":1}</think>{"ok":true}'), '{"ok":true}',
  '成对思维链标签应整段删除');
assert.strictEqual(T.stripThinking('前言<THINK>草稿</THINK>结果'), '前言结果',
  '思维链剥离必须大小写不敏感');
assert.strictEqual(T.stripThinking('<thinking>未闭合的草稿 {"broken'), '',
  '只有开标签说明输出被截断，应整体作废');
assert.strictEqual(T.stripThinking('</think> {"after":1}'), '{"after":1}',
  '缺开标签时应丢弃最后一个闭合标签之前的全部内容');
assert.strictEqual(T.stripThinking('<think>一</think>中<think>二</think>尾'), '中尾',
  '多段思维链应全部删除并保留之间的正文');

// —— 标点归一与野引号 ——
assert.strictEqual(T.normalizeJsonText('{“a”: “x”,}'), '{"a": "x"}',
  '智能引号应归一为直引号，尾随逗号应删除');
const good = '{"a":"he said \\"hi\\", ok","b":[1,2]}';
assert.strictEqual(T.escapeStrayQuotes(good), good, '对合法 JSON 必须是恒等变换');
const repaired = T.escapeStrayQuotes('{"a":"he said "hi" loudly"}');
assert.deepStrictEqual(JSON.parse(repaired), { a: 'he said "hi" loudly' },
  '对白中的野引号必须补转义后可解析');

// —— parseResponse 端到端 ——
const payload = {
  personal_memory: [{ name: ['甲'], known_by: ['乙'], memory: '甲知晓秘密。', time: '2005年10月1日' }],
  entity_updates: []
};
const wrapped = '<think>让我分析这段对话。\n{"fake": "誤"}\n</think>\n' + JSON.stringify(payload);
assert.deepStrictEqual(T.parseResponse(wrapped, { memory: {} }).personal[0].memory, '甲知晓秘密。',
  '思维链包裹的合法 JSON 必须正常提取');

const smartified = JSON.stringify(payload).replace(/"/g, '“');
assert.deepStrictEqual(T.parseResponse(smartified, { memory: {} }).personal[0].known_by, ['乙'],
  '智能引号充当 JSON 结构时必须在清洗后解析');

const stray = '{"personal_memory":[{"name":["甲"],"known_by":[],"memory":"甲说 "你好" 之后离开。","time":""}],"entity_updates":[]}';
assert.strictEqual(T.parseResponse(stray, { memory: {} }).personal[0].memory, '甲说 "你好" 之后离开。',
  '对白野引号必须修复而不是解析失败');

const trailing = '{"personal_memory":[{"name":["甲"],"known_by":[],"memory":"记忆内容。","time":""},],"entity_updates":[],}';
assert.strictEqual(T.parseResponse(trailing, { memory: {} }).personal[0].memory, '记忆内容。',
  '尾随逗号必须在清洗后解析');

const legacy = JSON.stringify([{ name: ['甲'], memory: '旧格式记忆。', time: '' }]);
assert.strictEqual(T.parseResponse(legacy, { memory: {} }).personal[0].memory, '旧格式记忆。',
  '旧版纯数组返回必须继续兼容');

assert.throws(() => T.parseResponse('抱歉，我无法完成这个任务。', { memory: {} }), /没有合法 JSON/,
  '没有任何 JSON 时必须抛错走重试');

// —— 长度二次防御 ——
const punctuated = '甲'.repeat(49) + '。' + '乙'.repeat(10);
const clamped = T.parseResponse(JSON.stringify({
  personal_memory: [{ name: ['甲'], known_by: [], memory: punctuated, time: '' }]
}), { memory: {} }).personal[0].memory;
assert.strictEqual(clamped.length, 50, '超长记忆必须截断到 50 字以内');
assert.ok(clamped.endsWith('。'), '截断应优先落在句读上');

const hardCut = T.parseResponse(JSON.stringify({
  personal_memory: [{ name: ['甲'], known_by: [], memory: '甲'.repeat(60), time: '' }]
}), { memory: {} }).personal[0].memory;
assert.strictEqual(hardCut, '甲'.repeat(50), '无句读时按上限硬截');

const longDescription = T.parseResponse(JSON.stringify({
  entity_updates: [{ type: 'object', name: '物件', description: '描'.repeat(250), event: '', time: '' }]
}), { memory: {} }).entities.object[0].description;
assert.strictEqual(longDescription.length, 200, '实体描述必须截断到 200 字以内');

console.log('✓ 记忆 JSON 容错测试通过');
