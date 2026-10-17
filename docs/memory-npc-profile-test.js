// 人物状态档案离线测试：node docs/memory-npc-profile-test.js
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const importModule = file => import(pathToFileURL(path.join(root, file)));
const storeMap = new Map();
let injectionContent = '';
const chat = [
  { is_user: false, name: '角色', mes: '开场白。' },
  { is_user: true, name: '用户', mes: '走向城门。' },
  { is_user: false, name: '角色', mes: '守卫队长老陈拦住去路，正押送一名俘虏前往北塔。' }
];
const context = {
  chat,
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
  WORLD_ENGINE_CORE: { getChatId() { return 'npc-test'; }, filterDialogue(value) { return value; } },
  WORLD_ENGINE_CHATCACHE: { forScope() { return { afterEvolution() {}, createSnapshot() {} }; } },
  WORLD_ENGINE_UI: { setMemoryEvolvingUI() {}, refresh() {} },
  MEMORY_ENGINE_SETTINGS: { getSettings() { return { engineEnabled: true, injectIntoPrompt: true, searchDepth: 5, maxPerCharacter: 20, bigSummaryInjectLimit: 3, smallSummaryInjectLimit: 10, metaSummaryEveryX: 6, hideCoveredRawText: true, recentRawRounds: 1, nameBlacklist: '忽略人物' }; } },
  WORLD_ENGINE_API: {}
});

for (const filename of ['memory-engine-data.js', 'memory-engine-prompt.js', 'memory-engine.js']) {
  await importModule(filename);
}
const ENGINE = sandbox.MEMORY_ENGINE;
const T = ENGINE._test;
const DATA = sandbox.MEMORY_ENGINE_DATA;

// —— parseResponse：清洗、上限、黑名单、世界联动抑制 ——
{
  const parsed = T.parseResponse(JSON.stringify({
    npc_updates: [
      { names: ['老陈', '守卫队长'], location: '城门', condition: '押送俘虏前往北塔', stance: '警惕且不悦' },
      { names: ['忽略人物'], location: '不应出现', condition: '', stance: '' },
      { names: [], location: '无名称不入库', condition: '', stance: '' }
    ]
  }), { memory: {} });
  assert.strictEqual(parsed.npcs.length, 1, '无名与黑名单条目必须被丢弃');
  assert.deepStrictEqual(parsed.npcs[0].names, ['老陈', '守卫队长']);
  assert.strictEqual(parsed.npcs[0].location, '城门');
  const linked = T.parseResponse(JSON.stringify({
    npc_updates: [{ names: ['老陈'], location: '联动误报', condition: '', stance: '' }]
  }), { memory: { kind: 'world_link' } });
  assert.strictEqual(linked.npcs.length, 0, '世界联动任务不得产生人物状态');
}

// —— merge：按名覆盖、新建、别名累积 ——
{
  const state = DATA.defaultState();
  T.mergeNpcProfiles(state, [{ names: ['老陈'], location: '城门', condition: '', stance: '' }]);
  T.mergeNpcProfiles(state, [{ names: ['老陈', '陈队长'], condition: '在北塔' }]);
  assert.strictEqual(state.npc_profiles.length, 1, '同名人物必须合并到同一档案');
  assert.deepStrictEqual(state.npc_profiles[0].names, ['老陈', '陈队长'], '别名必须累积');
  assert.strictEqual(state.npc_profiles[0].location, '城门', '未提供的字段必须保留旧值');
  assert.strictEqual(state.npc_profiles[0].condition, '在北塔');
  assert.ok(state.npc_profiles[0].id.startsWith('npc_'));
}

// —— 时间链整合：节点 npcs 重放 + 旧档兼容 ——
{
  const state = DATA.defaultState();
  state.npc_profiles = [];
  sandbox.MEMORY_ENGINE_DATA.saveState(state);
  sandbox.MEMORY_ENGINE_TIMELINE = {
    hashText() { return 'hash'; },
    captureRange(start, end) {
      const refs = [];
      for (let layer = start; layer <= end; layer++) {
        refs.push({ chatId: 'npc-test', messageId: `floor-${layer}`, layer, role: 'ai', swipeId: 0, hash: 'stable' });
      }
      return refs;
    },
    digestRefs(refs) { return (refs || []).map(ref => `${ref.chatId}:${ref.messageId}`).join('|'); },
    auditRefs(refs) { return { valid: true, refs, changed: [], missing: [] }; },
    unionRefs(groups) { return (groups || []).flat(); },
    syncHidden() { return Promise.resolve(); },
    refsToConversation(refs) { return (refs || []).map(ref => `[楼层 ${ref.layer}] 正文`).join('\n\n'); }
  };
  const node = {
    id: 'memory_000001', kind: 'memory', status: 'valid', revision: 1,
    startLayer: 2, endLayer: 2,
    sourceRefs: sandbox.MEMORY_ENGINE_TIMELINE.captureRange(2, 2), sourceDigest: 'd1',
    personal: [], entities: {},
    npcs: [{ names: ['老陈'], location: '北塔', condition: '审讯俘虏', stance: '冷漠' }]
  };
  const withNode = DATA.loadState();
  withNode.timeline.nodes.push(node);
  DATA.saveState(withNode);
  const replayed = ENGINE.replayTimeline(DATA.loadState());
  assert.strictEqual(replayed.npc_profiles.length, 1, '时间链节点必须重放出人物状态');
  assert.strictEqual(replayed.npc_profiles[0].condition, '审讯俘虏');
  DATA.saveState(replayed);
}

// —— 注入：按最近楼层名字扫描命中 ——
{
  ENGINE.applyInjection();
  assert.ok(injectionContent.includes('【人物当前状态】'), '命中名字时必须出现人物状态节');
  assert.ok(injectionContent.includes('老陈'), '状态行必须带人物名');
  assert.ok(injectionContent.includes('位置：北塔') && injectionContent.includes('处境：审讯俘虏'),
    '位置与处境必须注入');

  const empty = DATA.defaultState();
  empty.npc_profiles = [{ id: 'npc_000001', names: ['无关人物'], location: '远处', condition: '', stance: '' }];
  DATA.saveState(empty);
  ENGINE.applyInjection();
  assert.ok(!injectionContent.includes('【人物当前状态】'), '最近楼层未出现的人物不得注入状态');
}

// —— 手动快照兼容 ——
{
  const state = DATA.loadState();
  state.npc_profiles = [{ id: 'npc_000001', names: ['老陈'], location: '城门', condition: '', stance: '' }];
  DATA.saveState(state);
  // previous 与 next 仅人物状态不同：快照必须因此创建并封存状态档案。
  const previous = DATA.loadState();
  previous.npc_profiles = [];
  const snapshotState = ENGINE.commitManualState(DATA.loadState(), previous);
  const timeline = snapshotState.timeline;
  const snapshotNode = timeline.nodes[timeline.nodes.length - 1];
  assert.strictEqual(snapshotNode?.kind, 'manual_snapshot', '人物状态变化必须触发手动快照');
  assert.deepStrictEqual(snapshotNode.snapshot.npc_profiles[0].names, ['老陈'],
    '手动快照必须封存人物状态');
}

console.log('✓ 人物状态档案测试通过');
