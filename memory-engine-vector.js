// memory-engine-vector.js — 远事召回子系统：把已滚出注入窗口的纪要建成向量索引，
// 生成前用「查询重写 → 多路向量检索 → 可选重排」召回相关旧事，作为注入的补充节。
// 全链路失败静默降级：任何一步出错都不阻断生成，只留下状态供设置面板查看。
window.MEMORY_ENGINE_VECTOR = (function() {
  const STORE_PREFIX = 'memory_engine_vector_';
  const STORE_VERSION = 1;
  const EMBED_BATCH = 32;
  const CANDIDATE_LIMIT = 24;
  const REWRITE_PROMPT = `你是检索查询规划器。阅读最近一段对话，为「回忆更早剧情」的向量检索规划查询。只输出一个合法 JSON 对象，不要输出任何其他内容：
{"intent": "一段话概括当前场景、在场人物与叙事关注点", "queries": ["查询1", "查询2"]}
queries 最多 4 条，每条不超过 30 个字，各自覆盖不同的检索角度（人物旧事、地点与物件、未了结的事件或悬念、时间线上的关键节点）；不要复述对话原文长句。`;

  // 模块级缓存：索引（digest → int8 向量 + revision）、召回结果、查询缓存。
  let indexCache = null;          // { chatId, model, entries: Map<digest, {q: Int8Array, revision}> }
  let recallAbort = null;         // 在飞召回的 AbortController
  let lastRecall = { items: [], at: 0, intent: '', error: '' };
  let recallCache = { key: '', snapshot: null };
  let indexTimer = null;
  let indexRunning = false;
  let indexStatus = { indexed: 0, total: 0, lastError: '', lastAt: 0 };

  const clean = value => String(value == null ? '' : value).trim();
  const store = () => window.WORLD_ENGINE_STORE;
  const settings = () => window.MEMORY_ENGINE_SETTINGS?.getSettings(true) || {};
  const vectorApi = () => window.WORLD_ENGINE_API;
  const chat = () => { try { return SillyTavern.getContext()?.chat || []; } catch (_) { return []; } };
  const getChatId = () => String(window.WORLD_ENGINE_CORE?.getChatId?.() || 'default');

  function hashText(value) {
    const text = String(value || '');
    if (typeof window.MEMORY_ENGINE_TIMELINE?.hashText === 'function') return window.MEMORY_ENGINE_TIMELINE.hashText(text);
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < text.length; i++) { h1 = (h1 ^ text.charCodeAt(i)) * 16777619 >>> 0; h2 = (h2 + text.charCodeAt(i) * (i + 1)) >>> 0; }
    return `${h1.toString(16)}${h2.toString(16)}`;
  }

  // ─── int8 量化：向量 L2 归一后 ×127 存 Int8Array；量化后余弦直接在整数上算（尺度相消）。 ───
  function quantize(vec) {
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    const ints = new Int8Array(vec.length);
    for (let i = 0; i < vec.length; i++) {
      ints[i] = Math.max(-127, Math.min(127, Math.round(vec[i] / norm * 127)));
    }
    return ints;
  }

  function cosineInt8(a, b) {
    let dot = 0, na = 0, nb = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    if (!na || !nb) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  function base64FromInt8(ints) {
    let binary = '';
    for (let i = 0; i < ints.length; i++) binary += String.fromCharCode(ints[i] + 128);
    return btoa(binary);
  }

  function int8FromBase64(text) {
    const binary = atob(String(text || ''));
    const ints = new Int8Array(binary.length);
    for (let i = 0; i < binary.length; i++) ints[i] = binary.charCodeAt(i) - 128;
    return ints;
  }

  // ─── 索引：全部有效纪要，digest 为键。 ───
  function vectorKey() { return STORE_PREFIX + getChatId(); }

  function loadIndex() {
    if (indexCache && indexCache.chatId === getChatId()) return indexCache;
    let payload = null;
    try {
      const raw = store()?.getItem(vectorKey());
      payload = raw ? JSON.parse(raw) : null;
    } catch (_) { payload = null; }
    const entries = new Map();
    if (payload && payload.version === STORE_VERSION) {
      for (const [digest, entry] of Object.entries(payload.entries || {})) {
        try { entries.set(digest, { q: int8FromBase64(entry.q), revision: Number(entry.revision) || 1 }); } catch (_) {}
      }
    }
    indexCache = { chatId: getChatId(), model: clean(payload?.model), entries };
    return indexCache;
  }

  function saveIndex() {
    if (!indexCache) return;
    const entries = {};
    for (const [digest, entry] of indexCache.entries) entries[digest] = { q: base64FromInt8(entry.q), revision: entry.revision };
    try {
      store()?.setItem(vectorKey(), JSON.stringify({ version: STORE_VERSION, model: indexCache.model, entries }));
    } catch (error) {
      console.warn('[记忆引擎] 向量索引落盘失败（内存索引仍可用）', error);
    }
  }

  function validSummaries(state) {
    const summaries = state?.event_memory?.small_summaries || [];
    return summaries.filter(item => item.status === 'valid' && clean(item.sourceDigest) && clean(item.content));
  }

  // 增量补齐缺漏/变更的纪要向量；force 时全部重嵌。
  async function ensureIndex(state, force) {
    const st = settings();
    const model = clean(st.vectorModel);
    if (!model) throw new Error('未配置向量模型');
    const cache = loadIndex();
    if (cache.model && cache.model !== model) { cache.entries.clear(); cache.model = model; }
    if (!cache.model) cache.model = model;
    const wanted = validSummaries(state);
    const wantedDigests = new Set(wanted.map(item => clean(item.sourceDigest)));
    for (const digest of [...cache.entries.keys()]) {
      if (!wantedDigests.has(digest)) cache.entries.delete(digest);
    }
    const pending = wanted.filter(item => {
      const digest = clean(item.sourceDigest);
      const existing = cache.entries.get(digest);
      return force || !existing || existing.revision !== (Number(item.revision) || 1);
    });
    for (let i = 0; i < pending.length; i += EMBED_BATCH) {
      const batch = pending.slice(i, i + EMBED_BATCH);
      const vectors = await vectorApi().callEmbeddings(batch.map(item => clean(item.content)), recallAbort?.signal, st);
      batch.forEach((item, index) => {
        cache.entries.set(clean(item.sourceDigest), { q: quantize(vectors[index]), revision: Number(item.revision) || 1 });
      });
    }
    indexStatus.indexed = cache.entries.size;
    indexStatus.total = wanted.length;
    saveIndex();
    return cache;
  }

  function scheduleIndexUpdate() {
    clearTimeout(indexTimer);
    indexTimer = setTimeout(() => {
      indexTimer = null;
      if (indexRunning) return;
      const st = settings();
      if (st.vectorEnabled !== true || !clean(st.vectorModel)) return;
      indexRunning = true;
      Promise.resolve(ensureIndex(window.MEMORY_ENGINE_DATA?.loadState?.(), false))
        .catch(error => { indexStatus.lastError = String(error?.message || error); indexStatus.lastAt = Date.now(); })
        .finally(() => { indexRunning = false; });
    }, 2000);
  }

  async function rebuildIndex() {
    indexRunning = true;
    try {
      const state = window.MEMORY_ENGINE_DATA?.loadState?.();
      await ensureIndex(state, true);
      indexStatus.lastError = '';
      indexStatus.lastAt = Date.now();
      return { indexed: indexStatus.indexed, total: indexStatus.total };
    } catch (error) {
      indexStatus.lastError = String(error?.message || error);
      indexStatus.lastAt = Date.now();
      throw error;
    } finally { indexRunning = false; }
  }

  // ─── 查询构造与重写 ───
  function buildRecallQuery() {
    const all = chat();
    let lastUser = '', lastAi = '', lastAiIndex = -1;
    for (let i = all.length - 1; i >= 0; i--) {
      const mes = clean(all[i]?.mes);
      if (!mes) continue;
      if (!lastUser && all[i].is_user) lastUser = mes;
      if (!lastAi && !all[i].is_user) { lastAi = mes; lastAiIndex = i; }
      if (lastUser && lastAi) break;
    }
    const text = [lastUser, lastAi].filter(Boolean).join('\n');
    return { text: text.slice(-1200), floor: Math.max(lastAiIndex, all.length - 1) };
  }

  async function rewriteQueries(query, st) {
    const model = clean(st.vectorRewriteModel) || clean(st.model);
    if (!model) return { intent: '', queries: [query] };
    const raw = await vectorApi().callApi(
      `${REWRITE_PROMPT}\n\n【最近对话】\n${query}`, 600, 0.1, recallAbort?.signal,
      { ...st, model, maxTokens: 600 }
    );
    const text = clean(raw).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const start = text.indexOf('{'), end = text.lastIndexOf('}');
    const parsed = start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) : null;
    const queries = (Array.isArray(parsed?.queries) ? parsed.queries : [])
      .map(item => clean(item)).filter(Boolean).slice(0, 4);
    return { intent: clean(parsed?.intent), queries: queries.length ? queries : [query] };
  }

  // ─── 召回主入口：生成前阻塞调用。 ───
  async function recallForGeneration() {
    const st = settings();
    lastRecall = { items: [], at: Date.now(), intent: '', error: '' };
    if (st.vectorEnabled !== true || !clean(st.vectorModel)) { lastRecall.error = '未启用'; return lastRecall; }
    recallAbort = new AbortController();
    try {
      const { text: query, floor } = buildRecallQuery();
      if (!query) { lastRecall.error = '无可用查询文本'; return lastRecall; }
      const cacheKey = `${getChatId()}|${floor}|${hashText(query)}`;
      if (recallCache.key === cacheKey && recallCache.snapshot) {
        lastRecall = { ...recallCache.snapshot, at: Date.now() };
        return lastRecall;
      }
      const state = window.MEMORY_ENGINE_DATA?.loadState?.();
      await ensureIndex(state, false);
      const cache = loadIndex();
      if (!cache.entries.size) { lastRecall.error = '索引为空'; return lastRecall; }

      let intent = '', queries = [query];
      try {
        const rewritten = await rewriteQueries(query, st);
        intent = rewritten.intent;
        queries = rewritten.queries;
      } catch (error) {
        console.warn('[记忆引擎] 查询重写失败，使用原始对话作查询', error);
      }

      const queryVectors = await vectorApi().callEmbeddings(queries, recallAbort.signal, st);
      const scores = new Map();
      for (const vec of queryVectors) {
        const q = quantize(vec);
        for (const [digest, entry] of cache.entries) {
          const score = cosineInt8(q, entry.q);
          if (score > (scores.get(digest) || 0)) scores.set(digest, score);
        }
      }
      const byDigest = new Map(validSummaries(state).map(item => [clean(item.sourceDigest), item]));
      let candidates = [...scores.entries()]
        .sort((a, b) => b[1] - a[1]).slice(0, CANDIDATE_LIMIT)
        .map(([digest, score]) => ({ digest, score, small: byDigest.get(digest) }))
        .filter(item => item.small);

      // 重排可选：配置了 rerankModel 才调用；失败回退向量序。
      if (clean(st.vectorRerankModel) && candidates.length) {
        try {
          const ranked = await vectorApi().callRerank(
            intent || query, candidates.map(item => item.small.content), recallAbort.signal, st
          );
          candidates = ranked.map(entry => ({
            ...candidates[entry.index],
            score: Number.isFinite(entry.score) ? entry.score : candidates[entry.index].score
          })).filter(item => item.small);
        } catch (error) {
          console.warn('[记忆引擎] 重排失败，按向量相似度排序', error);
        }
      }

      const minScore = (Math.max(1, parseInt(st.vectorMinScore) || 35)) / 100;
      const count = Math.max(1, parseInt(st.vectorRecallCount) || 6);
      const items = candidates
        .filter(item => item.score >= minScore)
        .slice(0, count)
        .map(item => ({
          digest: item.digest,
          score: item.score,
          content: clean(item.small.content),
          timeStart: clean(item.small.timeStart),
          timeEnd: clean(item.small.timeEnd),
          startLayer: Number(item.small.startLayer) || 0,
          endLayer: Number(item.small.endLayer) || 0
        }));
      lastRecall = { items, intent, query, at: Date.now(), error: items.length ? '' : '无高分候选' };
      recallCache = { key: cacheKey, snapshot: { ...lastRecall } };
      indexStatus.lastAt = Date.now();
      indexStatus.lastError = '';
      return lastRecall;
    } catch (error) {
      if (error?.name === 'AbortError') return lastRecall;
      console.warn('[记忆引擎] 远事召回失败（本次注入不含召回节）', error);
      lastRecall.error = String(error?.message || error);
      return lastRecall;
    } finally {
      recallAbort = null;
    }
  }

  function getLastRecall() {
    return lastRecall && lastRecall.items?.length ? { ...lastRecall, items: [...lastRecall.items] } : null;
  }

  function getVectorStatus() {
    const st = settings();
    return {
      enabled: st.vectorEnabled === true && !!clean(st.vectorModel),
      model: clean(st.vectorModel),
      indexed: indexStatus.indexed,
      total: indexStatus.total,
      lastError: indexStatus.lastError || lastRecall?.error || '',
      lastAt: Math.max(indexStatus.lastAt, lastRecall?.at || 0),
      recallCount: lastRecall?.items?.length || 0
    };
  }

  function abortRecall() {
    recallAbort?.abort();
    recallAbort = null;
  }

  return { recallForGeneration, getLastRecall, getVectorStatus, scheduleIndexUpdate, rebuildIndex, abortRecall,
    _test: { quantize, cosineInt8, base64FromInt8, int8FromBase64, buildRecallQuery } };
})();
