// 远事召回（向量检索）离线测试：node docs/memory-vector-test.js
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const importModule = file => import(pathToFileURL(path.join(root, file)));
const storeMap = new Map();
let injectionContent = '';
let embedCalls = 0;
let rerankCalls = 0;
const keywordVec = text => {
  const count = word => String(text || '').split(word).length - 1;
  return Float32Array.from([count('苹果'), count('香蕉'), count('守卫')]);
};
const chat = [
  { is_user: true, name: '用户', mes: '苹果、香蕉和守卫的近况如何？' },
  { is_user: false, name: '角色', mes: '让我想想那些旧事。' }
];
const context = {
  chat,
  name1: '用户',
  name2: '角色',
  setExtensionPrompt(_name, content) { injectionContent = content; },
  eventSource: { on() {} },
  event_types: {}
};
const settings = {
  engineEnabled: true, injectIntoPrompt: true, searchDepth: 5, maxPerCharacter: 20,
  bigSummaryInjectLimit: 3, smallSummaryInjectLimit: 10, metaSummaryEveryX: 6,
  hideCoveredRawText: true, recentRawRounds: 1, nameBlacklist: '', model: 'test-main',
  vectorEnabled: true, vectorModel: 'test-embed', vectorMinScore: 35, vectorRecallCount: 6,
  vectorRewriteModel: '', vectorRerankModel: ''
};
const sandbox = global;
sandbox.window = sandbox;
Object.assign(sandbox, {
  console, setTimeout, clearTimeout, AbortController, atob, btoa,
  document: { getElementById() { return null; } },
  SillyTavern: { getContext() { return context; } },
  WORLD_ENGINE_STORE: {
    getItem(key) { return storeMap.has(key) ? storeMap.get(key) : null; },
    setItem(key, value) { storeMap.set(key, String(value)); },
    removeItem(key) { storeMap.delete(key); }
  },
  WORLD_ENGINE_CORE: { getChatId() { return 'vector-test'; }, filterDialogue(value) { return value; } },
  WORLD_ENGINE_CHATCACHE: { forScope() { return { afterEvolution() {}, createSnapshot() {} }; } },
  WORLD_ENGINE_UI: { setMemoryEvolvingUI() {}, refresh() {} },
  MEMORY_ENGINE_SETTINGS: { getSettings() { return { ...settings }; } },
  WORLD_ENGINE_API: {
    async callApi() { return '{"intent":"询问三件旧事","queries":["苹果、香蕉、守卫三件事"]}'; },
    async callEmbeddings(texts) {
      embedCalls++;
      return texts.map(keywordVec);
    },
    async callRerank(_query, documents) {
      rerankCalls++;
      return documents.map((_, index) => ({ index, score: 1 - index / 10 })).reverse();
    }
  }
});

for (const filename of ['memory-engine-data.js', 'memory-engine-vector.js', 'memory-engine.js']) {
  await importModule(filename);
}
const VECTOR = sandbox.MEMORY_ENGINE_VECTOR;
const T = VECTOR._test;
const ENGINE = sandbox.MEMORY_ENGINE;
const DATA = sandbox.MEMORY_ENGINE_DATA;

// —— 量化与余弦往返 ——
{
  const vec = Float32Array.from([0.6, 0.8, 0]);
  const restored = T.int8FromBase64(T.base64FromInt8(T.quantize(vec)));
  assert.ok(Math.abs(T.cosineInt8(restored, T.quantize(vec)) - 1) < 1e-6, '量化往返后自相似必须为 1');
  const other = T.quantize(Float32Array.from([0.8, 0.6, 0]));
  const similarity = T.cosineInt8(restored, other);
  assert.ok(similarity > 0.94 && similarity < 1, '量化余弦必须近似真实夹角余弦');
  assert.ok(T.cosineInt8(restored, T.quantize(Float32Array.from([0, 0, 1]))) < 0.01, '正交向量相似度应接近 0');
}

// —— 准备带纪要的状态：d1/d3 被总述归档，d2 未归档 ——
sandbox.MEMORY_ENGINE_TIMELINE = {
  hashText(value) { return `hash:${String(value).length}`; },
  captureRange(start, end) {
    const refs = [];
    for (let layer = start; layer <= end; layer++) {
      refs.push({ chatId: 'vector-test', messageId: `floor-${layer}`, layer, role: 'ai', swipeId: 0, hash: 'stable' });
    }
    return refs;
  },
  digestRefs(refs) { return (refs || []).map(ref => `${ref.chatId}:${ref.messageId}`).join('|'); },
  auditRefs(refs) { return { valid: true, refs, changed: [], missing: [] }; },
  unionRefs(groups) { return (groups || []).flat(); },
  syncHidden() { return Promise.resolve(); }
};
{
  const state = DATA.defaultState();
  const smalls = [
    { id: 'small_000001', startLayer: 1, endLayer: 2, content: '主角在城门买过苹果。', sourceDigest: 'd1', status: 'valid' },
    { id: 'small_000002', startLayer: 3, endLayer: 4, content: '香蕉船队抵达港口。', sourceDigest: 'd2', status: 'valid' },
    { id: 'small_000003', startLayer: 5, endLayer: 6, content: '守卫封锁了北门。', sourceDigest: 'd3', status: 'valid' }
  ];
  state.event_memory.small_summaries = smalls;
  state.event_memory.big_summaries = [{
    id: 'big_000001', startLayer: 1, endLayer: 6, content: 'OV1', level: 1,
    childIds: ['small_000001', 'small_000003'], status: 'valid'
  }];
  state.event_memory.big_summary_cursor = 3;
  DATA.saveState(state);
}

// —— 召回管线：索引 + 重写 + 多路检索 ——
{
  const recall = await VECTOR.recallForGeneration();
  assert.strictEqual(recall.intent, '询问三件旧事', '重写意图必须进入召回结果');
  assert.strictEqual(embedCalls, 2, '首次召回应有两批向量请求（3 条索引 + 1 条查询）');
  assert.strictEqual(recall.items.length, 3, '三条纪要都与查询相交，必须全部过阈值');
  assert.strictEqual(recall.items[0].digest, 'd1', '向量序第一条应为苹果纪要');
  assert.ok(recall.items.every(item => item.score >= 0.35), '全部结果必须达到相似度阈值');
}

// —— 缓存：同查询直接复用，不再发向量请求 ——
{
  await VECTOR.recallForGeneration();
  assert.strictEqual(embedCalls, 2, '缓存命中时不得再发向量请求');
}

// —— rerank：重排生效与失败回退（换查询文本绕开召回缓存）——
{
  chat[0].mes = '苹果、香蕉和守卫的近况如何？请重排。';
  settings.vectorRerankModel = 'test-rerank';
  const ranked = await VECTOR.recallForGeneration();
  assert.strictEqual(rerankCalls, 1);
  assert.strictEqual(ranked.items[0].digest, 'd3', '重排逆序后第一条应为守卫纪要');
  sandbox.WORLD_ENGINE_API.callRerank = async () => { throw new Error('重排服务不可用'); };
  chat[0].mes = '苹果、香蕉和守卫的近况如何？重排失败兜底。';
  const fallback = await VECTOR.recallForGeneration();
  assert.strictEqual(fallback.items[0].digest, 'd1', '重排失败必须回退向量序');
  delete settings.vectorRerankModel;
}

// —— 阈值截断 ——
{
  chat[0].mes = '苹果、香蕉和守卫的近况如何？请用更严的阈值。';
  settings.vectorMinScore = 90;
  const strict = await VECTOR.recallForGeneration();
  assert.strictEqual(strict.items.filter(item => item.score < 0.9).length, 0, '低于阈值的候选不得入选');
  settings.vectorMinScore = 35;
}

// —— 引擎集成：【远事召回】节 + 未整理纪要去重 ——
{
  chat[0].mes = '苹果、香蕉和守卫的近况如何？注入检查。';
  await VECTOR.recallForGeneration();
  ENGINE.applyInjection();
  assert.ok(injectionContent.includes('【远事召回】'), '召回结果必须出现在注入里');
  assert.ok(injectionContent.includes('主角在城门买过苹果。'), '已归档纪要靠召回重新可见');
  assert.ok(injectionContent.includes('守卫封锁了北门。'), '已归档纪要靠召回重新可见');
  assert.strictEqual(injectionContent.split('香蕉船队抵达港口。').length - 1, 1,
    '未整理纪要已在纪要节注入，召回节必须按来源指纹去重');
}

// —— 禁用与未配置：全链路短路 ——
{
  settings.vectorEnabled = false;
  const off = await VECTOR.recallForGeneration();
  assert.strictEqual(off.items.length, 0);
  assert.ok(!ENGINE.applyInjection() || !injectionContent.includes('【远事召回】'), '禁用后注入不得再带召回节');
  settings.vectorEnabled = true;
  settings.vectorModel = '';
  const noModel = await VECTOR.recallForGeneration();
  assert.strictEqual(noModel.items.length, 0, '模型留空时必须短路');
  settings.vectorModel = 'test-embed';
}

console.log('✓ 远事召回测试通过');
