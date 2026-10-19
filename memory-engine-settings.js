// memory-engine-settings.js — 记忆引擎独立设置（只复用 API/调度等实现，不共享配置值）
window.MEMORY_ENGINE_SETTINGS = (function() {
  const STORAGE_KEY = 'memory_engine_settings';
  const VERSION = '1.6.0';
  // API 连接配置来源：'own'=记忆引擎独立配置（默认，旧行为）；
  // 'world'=跟随世界引擎，apiUrl/apiKey/connectionMode/temperature/maxTokens/apiTimeoutMs 取世界引擎设置，
  // 模型仍由记忆侧独立选择。向量端点（vectorApiUrl/vectorApiKey）永远独立，不跟随。
  const API_SOURCES = Object.freeze(['own', 'world']);
  // 跟随世界引擎时被覆盖的字段；保存侧同样跳过这些字段，避免旧值覆盖世界引擎配置的展示。
  const API_FOLLOW_FIELDS = Object.freeze([
    'apiUrl', 'apiKey', 'connectionMode', 'temperature', 'maxTokens', 'apiTimeoutMs'
  ]);
  const DEFAULTS = Object.freeze({
    apiSource: 'own',
    apiUrl: '',
    apiKey: '',
    model: 'gpt-3.5-turbo',
    connectionMode: 'direct',
    temperature: 0.2,
    maxTokens: 65000,
    apiTimeoutMs: 120000,
    engineEnabled: true,
    firstLayerIsAiOpening: true,
    evolveMode: 'auto',
    evolveEveryX: 1,
    evolveReadRounds: 1,
    manualReadRounds: 1,
    smallSummaryEveryX: 1,
    bigSummaryEveryX: 5,
    bigSummaryInjectLimit: 3,
    // 未归档纪要注入条数上限；更早的纪要保持正文可见，不做隐藏。
    smallSummaryInjectLimit: 10,
    // 未归档总述积压到该数量后，把最旧的若干条合并成更早总述。
    metaSummaryEveryX: 6,
    hideCoveredRawText: true,
    recentRawRounds: 1,
    referenceRawRounds: 1,
    referenceSmallSummaryCount: 5,
    referenceBigSummaryCount: 1,
    injectIntoPrompt: true,
    injectIntoWorldEngine: false,
    worldEngineMemoryLimit: 5,
    searchDepth: 5,
    maxPerCharacter: 20,
    injectionDiceSides: 10000,
    apiAutoRetries: 1,
    nameBlacklist: '',
    filterRegex: '',
    filterUseStRegex: false,
    tonePrompt: '',
    worldbookEnabled: false,
    worldbookTrigger: false,
    worldbookEjsRender: false,
    syncToChat: false,
    autoBackup: false,
    backfillBatchSize: 5,
    summaryBackfillSmallEveryX: 5,
    summaryBackfillBigEveryX: 5,
    backfillRetries: 2,
    backfillEndLayer: 0,
    // 向量召回：远事纪要检索。Model 留空＝功能不启用；端点留空由主 apiUrl 推导；仅直连。
    vectorEnabled: false,
    vectorApiUrl: '',
    vectorApiKey: '',
    vectorModel: '',
    vectorRewriteModel: '',
    vectorRerankUrl: '',
    vectorRerankKey: '',
    vectorRerankModel: '',
    vectorRecallCount: 6,
    vectorMinScore: 35
  });

  let cached = null;

  // 日常记忆以一轮为最小可重放单元：人物/实体与纪要同轮联合提取。
  // 这里同时覆盖旧存档和 UI 传入值，避免历史设置中的 X 继续生效。
  function normalizeSettings(value) {
    const merged = { ...DEFAULTS, ...(value || {}) };
    const savedMaxTokens = Math.max(1, parseInt(merged.maxTokens) || 65000);
    return {
      ...merged,
      // 旧版部分预设把输出上限保存成 4096；升级后自动迁移，避免继续截断 API 返回。
      maxTokens: savedMaxTokens === 4096 ? 65000 : savedMaxTokens,
      apiSource: API_SOURCES.includes(merged.apiSource) ? merged.apiSource : 'own',
      evolveEveryX: 1,
      evolveReadRounds: 1,
      manualReadRounds: 1,
      smallSummaryEveryX: 1,
      smallSummaryInjectLimit: Math.max(1, parseInt(merged.smallSummaryInjectLimit) || 10),
      metaSummaryEveryX: Math.max(2, parseInt(merged.metaSummaryEveryX) || 6),
      vectorRecallCount: Math.max(1, parseInt(merged.vectorRecallCount) || 6),
      vectorMinScore: Math.min(95, Math.max(1, parseInt(merged.vectorMinScore) || 35)),
      recentRawRounds: Math.max(0, parseInt(merged.recentRawRounds) || 0),
      referenceRawRounds: Math.max(0, parseInt(merged.referenceRawRounds) || 0),
      referenceSmallSummaryCount: Math.max(0, parseInt(merged.referenceSmallSummaryCount) || 0),
      referenceBigSummaryCount: Math.max(0, parseInt(merged.referenceBigSummaryCount) || 0)
    };
  }

  function readStored() {
    try {
      const raw = window.WORLD_ENGINE_STORE?.getItem(STORAGE_KEY);
      if (!raw) {
        // test 分支早期版本曾把 memory* 字段误放进 world_engine_settings；仅首次读取时迁移。
        const worldRaw = window.WORLD_ENGINE_STORE?.getItem('world_engine_settings');
        const world = worldRaw ? JSON.parse(worldRaw) : {};
        const migrated = {
          evolveMode: world.memoryEvolveMode,
          evolveEveryX: world.memoryEvolveEveryX,
          evolveReadRounds: world.memoryEvolveReadRounds,
          manualReadRounds: world.memoryManualReadRounds,
          injectIntoPrompt: world.memoryInjectIntoPrompt,
          searchDepth: world.memorySearchDepth,
          maxPerCharacter: world.memoryMaxPerCharacter,
          worldbookEnabled: world.memoryWorldbookEnabled,
          backfillBatchSize: world.memoryBackfillBatchSize,
          backfillRetries: world.memoryBackfillRetries,
          backfillEndLayer: world.memoryBackfillEndLayer
        };
        const clean = Object.fromEntries(Object.entries(migrated).filter(([, value]) => value !== undefined));
        if (Object.keys(clean).length) return clean;
      }
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      console.warn('[记忆引擎] 读取设置失败，使用默认值', error);
      return {};
    }
  }

  function getSettings(forceRefresh) {
    if (forceRefresh) cached = null;
    if (!cached) cached = normalizeSettings(readStored());
    return { ...cached };
  }

  function saveSettings(next) {
    cached = normalizeSettings(next);
    window.WORLD_ENGINE_STORE?.setItem(STORAGE_KEY, JSON.stringify(cached));
    return { ...cached };
  }

  function patchSettings(patch) {
    return saveSettings({ ...getSettings(true), ...(patch || {}) });
  }

  // 生效的 API 连接配置：跟随世界引擎时，被跟随字段整体取世界引擎当前值（缺失字段回退记忆侧已存值，
  // 保证世界引擎未配置时不至于把 URL/Key 清空）；模型与向量端点始终来自记忆侧。
  // 跟随模式下必须每次重读：用户随时可能在世界引擎侧改连接配置，缓存会让记忆引擎继续用旧值。
  // 默认强刷记忆侧设置；世界引擎侧 getSettings(true) 本身即强刷。
  // sourceOverride 供 UI 在「已切换但尚未保存」时按屏幕上选中的来源取配置，
  // 否则下拉选跟随、还没点保存就获取模型列表，会仍按已存的 own 配置发请求。
  function getApiSettings(forceRefresh = true, sourceOverride) {
    const own = getSettings(forceRefresh);
    const source = API_SOURCES.includes(sourceOverride) ? sourceOverride : own.apiSource;
    if (source !== 'world') return own;
    const world = window.WORLD_ENGINE_API?.getSettings?.(true) || {};
    const merged = { ...own };
    for (const field of API_FOLLOW_FIELDS) {
      const value = world[field];
      if (value !== undefined && value !== null && value !== '') merged[field] = value;
    }
    if (merged.maxTokens !== undefined && merged.maxTokens !== null) {
      merged.maxTokens = Math.max(1, parseInt(merged.maxTokens) || 65000);
    }
    return merged;
  }

  return {
    STORAGE_KEY,
    VERSION,
    DEFAULTS,
    API_SOURCES,
    API_FOLLOW_FIELDS,
    getSettings,
    getApiSettings,
    saveSettings,
    patchSettings
  };
})();
