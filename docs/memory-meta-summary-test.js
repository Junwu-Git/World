// 更早总述（二级总述）离线测试：node docs/memory-meta-summary-test.js
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const importModule = file => import(pathToFileURL(path.join(root, file)));
const storeMap = new Map();
const calls = [];
let injectionContent = '';
const settings = {
  engineEnabled: true,
  firstLayerIsAiOpening: true,
  evolveMode: 'auto',
  bigSummaryEveryX: 5,
  bigSummaryInjectLimit: 3,
  metaSummaryEveryX: 6,
  smallSummaryInjectLimit: 10,
  hideCoveredRawText: true,
  recentRawRounds: 1,
  referenceRawRounds: 0,
  referenceSmallSummaryCount: 0,
  referenceBigSummaryCount: 0,
  injectIntoPrompt: true,
  injectIntoWorldEngine: false,
  searchDepth: 5,
  maxPerCharacter: 20,
  maxTokens: 2000,
  temperature: 0.2,
  nameBlacklist: '',
  apiAutoRetries: 0,
  filterRegex: ''
};
const context = {
  chat: [],
  name1: '用户',
  name2: '角色',
  setExtensionPrompt(_name, content) { injectionContent = content; },
  eventSource: { on() {} },
  event_types: {}
};
const sandbox = global;
sandbox.window = sandbox;
Object.assign(sandbox, {
  console, setTimeout, clearTimeout, AbortController,
  document: { getElementById() { return null; } },
  SillyTavern: { getContext() { return context; } },
  WORLD_ENGINE_STORE: {
    getItem(key) { return storeMap.has(key) ? storeMap.get(key) : null; },
    setItem(key, value) { storeMap.set(key, String(value)); },
    removeItem(key) { storeMap.delete(key); }
  },
  WORLD_ENGINE_CORE: { getChatId() { return 'meta-test'; }, filterDialogue(value) { return value; } },
  WORLD_ENGINE_CHATCACHE: { forScope() { return { afterEvolution() {}, createSnapshot() {} }; } },
  WORLD_ENGINE_UI: { setMemoryEvolvingUI() {}, refresh() {} },
  MEMORY_ENGINE_SETTINGS: { getSettings() { return { ...settings }; } },
  WORLD_ENGINE_API: {
    async callApi(prompt) {
      calls.push(prompt);
      return JSON.stringify({ big_summary: 'META-OV：更早阶段的合并总览。' });
    }
  }
});

for (const filename of [
  'memory-engine-data.js',
  'memory-engine-prompt.js',
  'memory-engine-small-summary-prompt.js',
  'memory-engine-big-summary-prompt.js',
  'memory-engine.js'
]) {
  await importModule(filename);
}
const ENGINE = sandbox.MEMORY_ENGINE;
const T = ENGINE._test;

sandbox.MEMORY_ENGINE_TIMELINE = {
  hashText(value) { return `hash:${String(value).length}`; },
  captureRange(start, end) {
    const refs = [];
    for (let layer = start; layer <= end; layer++) {
      refs.push({ chatId: 'meta-test', messageId: `floor-${layer}`, layer, role: 'ai', swipeId: 0, hash: 'stable' });
    }
    return refs;
  },
  digestRefs(refs) { return (refs || []).map(ref => `${ref.chatId}:${ref.messageId}`).join('|'); },
  auditRefs(refs) { return { valid: true, refs, changed: [], missing: [] }; },
  unionRefs(groups) { return (groups || []).flat(); },
  syncHidden() { return Promise.resolve(); },
  refsToConversation(refs) { return (refs || []).map(ref => `[楼层 ${ref.layer}] 正文`).join('\n\n'); }
};

function makeState(overviewCount, smallsPerOverview = 5) {
  const state = sandbox.MEMORY_ENGINE_DATA.defaultState();
  const smalls = [];
  for (let i = 0; i < overviewCount * smallsPerOverview; i++) {
    smalls.push({
      id: `small_${String(i + 1).padStart(6, '0')}`,
      startLayer: i * 2 + 1, endLayer: i * 2 + 2,
      content: `minute-${i + 1}`, status: 'valid'
    });
  }
  const overviews = [];
  for (let i = 0; i < overviewCount; i++) {
    overviews.push({
      id: `big_${String(i + 1).padStart(6, '0')}`,
      startLayer: i * smallsPerOverview * 2 + 1,
      endLayer: (i + 1) * smallsPerOverview * 2,
      content: `OV${i + 1}`,
      timeStart: `2049年9月${i * 5 + 1}日`,
      timeEnd: `2049年9月${i * 5 + 5}日`,
      childIds: smalls.slice(i * smallsPerOverview, (i + 1) * smallsPerOverview).map(item => item.id),
      originChatId: 'meta-test', status: 'valid', revision: 1
    });
  }
  state.event_memory.small_summaries = smalls;
  state.event_memory.big_summaries = overviews;
  state.event_memory.big_summary_cursor = smalls.length;
  return state;
}

// —— 触发阈值与保留窗口 ——
{
  const due = T.buildMetaTask(makeState(7), false);
  assert.ok(due, '未合并总述达到阈值（6）必须触发更早总述');
  assert.strictEqual(due.level, 2);
  assert.deepStrictEqual(due.childIds, ['big_000001', 'big_000002', 'big_000003', 'big_000004'],
    '只合并保留窗口之外的最旧总述，最近 3 条保持逐条注入');
  const below = T.buildMetaTask(makeState(5), false);
  assert.strictEqual(below, null, '低于阈值时不得触发');
  const forced = T.buildMetaTask(makeState(5), true);
  assert.deepStrictEqual(forced.childIds, ['big_000001', 'big_000002'],
    '强制触发时仍必须保留最近 3 条总述');
}

// —— runTasks 落库：level 2 入库、游标不动（经手动总述入口强制触发）——
{
  const state = makeState(7);
  sandbox.MEMORY_ENGINE_DATA.saveState(state);
  const result = await ENGINE.manualBigSummary();
  assert.strictEqual(result.updatedBig, 1);
  const after = sandbox.MEMORY_ENGINE_DATA.loadState();
  assert.strictEqual(after.event_memory.big_summaries.length, 8);
  const metaEntry = after.event_memory.big_summaries.at(-1);
  assert.strictEqual(metaEntry.level, 2, '合并产物必须带 level 2 落库');
  assert.strictEqual(metaEntry.content, 'META-OV：更早阶段的合并总览。');
  assert.deepStrictEqual(metaEntry.childIds, ['big_000001', 'big_000002', 'big_000003', 'big_000004']);
  assert.strictEqual(metaEntry.timeStart, '2049年9月1日', '更早总述必须从最旧子总述继承起始时间');
  assert.strictEqual(metaEntry.timeEnd, '2049年9月20日', '更早总述必须从最新子总述继承结束时间');
  assert.strictEqual(after.event_memory.big_summary_cursor, 35, '更早总述不消耗纪要，游标必须保持不变');
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].includes('【待合并的既有总述】'), '合并请求必须使用总述输入节标题');
  assert.ok(calls[0].includes('[2049年9月1日 至 2049年9月5日] OV1'), '合并请求的输入行必须携带各总述的时间标注');
  assert.ok(calls[0].includes('OV1') && calls[0].includes('OV4'), '请求必须携带被合并的总述正文');
  assert.ok(!calls[0].includes('OV5'), '保留窗口内的总述不得进入合并请求');
}

// —— 注入：两级总述 + 传递覆盖 ——
{
  ENGINE.applyInjection();
  assert.ok(injectionContent.includes('【更早总述】'), '存在 level 2 总述时必须出现更早总述节');
  assert.ok(injectionContent.includes('[2049年9月1日 至 2049年9月20日] META-OV'),
    '更早总述注入行必须携带继承的时间区间标注');
  assert.ok(injectionContent.includes('OV5') && injectionContent.includes('OV6') && injectionContent.includes('OV7'),
    '保留窗口内的最近总述必须逐条注入');
  assert.ok(!injectionContent.includes('OV1') && !injectionContent.includes('OV4'),
    '被更早总述吸收的总述不得再逐条注入');
  assert.ok(!injectionContent.includes('minute-'), '被任意层级总述覆盖的纪要不得重新注入');

  const expanded = makeState(7);
  expanded.event_memory.small_summaries.push({
    id: 'small_000099', startLayer: 101, endLayer: 102, content: 'minute-pending', status: 'valid'
  });
  sandbox.MEMORY_ENGINE_DATA.saveState(expanded);
  ENGINE.applyInjection();
  assert.ok(injectionContent.includes('minute-pending'), '真正未整理的纪要必须继续注入');
  sandbox.MEMORY_ENGINE_DATA.saveState(makeState(7));
}

// —— 纪要注入条数上限 ——
{
  const state = sandbox.MEMORY_ENGINE_DATA.defaultState();
  state.event_memory.small_summaries = Array.from({ length: 15 }, (_, index) => ({
    id: `small_${String(index + 1).padStart(6, '0')}`,
    startLayer: index * 2 + 1, endLayer: index * 2 + 2,
    content: `minute-${index + 1}`, status: 'valid'
  }));
  sandbox.MEMORY_ENGINE_DATA.saveState(state);
  settings.smallSummaryInjectLimit = 3;
  ENGINE.applyInjection();
  assert.ok(injectionContent.includes('minute-15') && injectionContent.includes('minute-13'),
    '纪要上限内应注入最新几条');
  assert.ok(!injectionContent.includes('minute-12'), '超过上限的未整理纪要不得注入');
  settings.smallSummaryInjectLimit = 10;
}

// —— 世界联动回滚的级联撤销 ——
{
  const state = sandbox.MEMORY_ENGINE_DATA.defaultState();
  state.event_memory.small_summaries = [{
    id: 'small_000001', startLayer: 5, endLayer: 5, content: '联动纪要',
    source: 'world_engine', sourceKey: 'meta-test:5', status: 'valid'
  }];
  state.event_memory.big_summaries = [
    { id: 'big_000001', startLayer: 5, endLayer: 5, content: 'OV1', level: 1, childIds: ['small_000001'], status: 'valid' },
    { id: 'big_000002', startLayer: 5, endLayer: 5, content: 'META-OV', level: 2, childIds: ['big_000001'], status: 'valid' }
  ];
  sandbox.MEMORY_ENGINE_DATA.saveState(state);
  const loaded = sandbox.MEMORY_ENGINE_DATA.loadState();
  const rolledBack = T.removeLinkedLayerFromState(loaded, 5);
  assert.strictEqual(rolledBack.removed, true);
  sandbox.MEMORY_ENGINE_DATA.saveState(ENGINE.replayTimeline(loaded));
  const after = sandbox.MEMORY_ENGINE_DATA.loadState();
  assert.strictEqual(after.event_memory.small_summaries.length, 0, '联动纪要必须撤销');
  assert.strictEqual(after.event_memory.big_summaries.length, 0,
    '被撤销总述所属的更早总述必须级联撤销，不得残留悬空引用');
}

// —— normalizeState 的 level 兼容 ——
{
  const legacy = sandbox.MEMORY_ENGINE_DATA.defaultState();
  legacy.event_memory.big_summaries = [
    { id: 'big_000001', startLayer: 1, endLayer: 2, content: '旧总述', childIds: [], status: 'valid' },
    { id: 'big_000002', startLayer: 3, endLayer: 4, content: '二级总述', level: 2, childIds: ['big_000001'], status: 'valid' }
  ];
  sandbox.MEMORY_ENGINE_DATA.saveState(legacy);
  const loaded = sandbox.MEMORY_ENGINE_DATA.loadState();
  assert.strictEqual(loaded.event_memory.big_summaries[0].level, 1, '无 level 的旧总述必须按 level 1 兼容');
  assert.strictEqual(loaded.event_memory.big_summaries[1].level, 2, 'level 2 必须在落盘往返后保留');
}

// —— L3：最早总述（二级压缩）——
{
  const state = sandbox.MEMORY_ENGINE_DATA.defaultState();
  state.event_memory.big_summaries = Array.from({ length: 7 }, (_, index) => ({
    id: `big_${String(index + 1).padStart(6, '0')}`,
    startLayer: index * 10 + 1, endLayer: index * 10 + 10,
    content: `L2-${index + 1}`, level: 2,
    childIds: [], status: 'valid'
  }));
  sandbox.MEMORY_ENGINE_DATA.saveState(state);
  const l3Task = T.buildCompressionTask(sandbox.MEMORY_ENGINE_DATA.loadState(), false, 3);
  assert.ok(l3Task, 'L2 积压到阈值必须触发最早总述');
  assert.strictEqual(l3Task.level, 3);
  assert.deepStrictEqual(l3Task.childIds, ['big_000001', 'big_000002', 'big_000003', 'big_000004'],
    '只合并保留窗口之外的最旧 L2');
  assert.strictEqual(T.buildCompressionTask(sandbox.MEMORY_ENGINE_DATA.loadState(), false, 2), null,
    '没有 L1 积压时不得触发 L2 合并');
  await ENGINE.manualBigSummary();
  const after = sandbox.MEMORY_ENGINE_DATA.loadState();
  assert.strictEqual(after.event_memory.big_summaries.length, 8);
  const l3Entry = after.event_memory.big_summaries.at(-1);
  assert.strictEqual(l3Entry.level, 3, '合并产物必须带 level 3 落库');
  ENGINE.applyInjection();
  const l3Index = injectionContent.indexOf('【最早总述】');
  const l2Index = injectionContent.indexOf('【更早总述】');
  assert.ok(l3Index >= 0 && l2Index > l3Index, '最早总述必须出现在更早总述之前');
  assert.ok(!injectionContent.includes('L2-1') && !injectionContent.includes('L2-4'),
    '被 L3 吸收的 L2 不得逐条注入');
  assert.ok(injectionContent.includes('L2-5') && injectionContent.includes('L2-7'),
    '保留窗口内的 L2 逐条注入');

  // 全链级联：撤 L1 → 引用它的 L2 → 引用 L2 的 L3 一并撤销
  const cascadeState = sandbox.MEMORY_ENGINE_DATA.defaultState();
  cascadeState.event_memory.small_summaries = [{
    id: 'small_000001', startLayer: 5, endLayer: 5, content: '联动纪要',
    source: 'world_engine', sourceKey: 'meta-test:5', status: 'valid'
  }];
  cascadeState.event_memory.big_summaries = [
    { id: 'big_000001', startLayer: 5, endLayer: 5, content: 'OV1', level: 1, childIds: ['small_000001'], status: 'valid' },
    { id: 'big_000002', startLayer: 5, endLayer: 5, content: 'L2', level: 2, childIds: ['big_000001'], status: 'valid' },
    { id: 'big_000003', startLayer: 5, endLayer: 5, content: 'L3', level: 3, childIds: ['big_000002'], status: 'valid' }
  ];
  sandbox.MEMORY_ENGINE_DATA.saveState(cascadeState);
  const cascadeLoaded = sandbox.MEMORY_ENGINE_DATA.loadState();
  assert.strictEqual(T.removeLinkedLayerFromState(cascadeLoaded, 5).removed, true);
  sandbox.MEMORY_ENGINE_DATA.saveState(ENGINE.replayTimeline(cascadeLoaded));
  assert.strictEqual(sandbox.MEMORY_ENGINE_DATA.loadState().event_memory.big_summaries.length, 0,
    'L1 撤销必须沿 L2→L3 全链级联');
}

console.log('✓ 更早总述测试通过');
