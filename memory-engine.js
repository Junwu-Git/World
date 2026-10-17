// 记忆引擎运行链：复用世界引擎的 API、过滤、世界书、存档和注入机制。
window.MEMORY_ENGINE = (function() {
  const INJECTION_NAME = 'memory-engine-memory';
  const SENTINEL = '【记忆信息】';
  const DEFAULT_INJECTION_DICE_SIDES = 10000;
  const ENTITY_TYPES = ['organization', 'object', 'ability', 'location'];
  const ENTITY_LABELS = { organization: '组织', object: '物件', ability: '能力', location: '地点' };
  let initialized = false, running = false, backfillRunning = false, reconciling = false;
  let runningLabel = '';
  let abortController = null, autoTimer = null, lastEventKey = '';
  let hiddenSyncPromise = Promise.resolve();
  let vectorRecallPromise = Promise.resolve();
  let lastDebug = { prompt: '', rawResult: '', parsed: null, error: '' };
  let backfillStatus = { running: false, current: 0, total: 0, message: '' };
  let summaryBackfillStatus = { running: false, current: 0, total: 0, message: '' };

  const clone = v => v == null ? v : JSON.parse(JSON.stringify(v));
  const clean = v => String(v == null ? '' : v).trim();
  const unique = list => Array.from(new Set((list || []).map(clean).filter(Boolean)));
  const normalized = v => clean(v).toLocaleLowerCase();
  // 相对时间词不能原样入库：绝对时间缺失时宁可为空，也不让「昨天」这类词随故事推进失效。
  const RELATIVE_TIME_RE = /^(昨晚|昨天|三天前|刚才|不久前|宴会之后)$/;
  // 总述压缩深度上限：1=纪要合并，2=更早总述，3=最早总述。
  const MAX_SUMMARY_LEVEL = 3;
  const SUMMARY_LEVEL_LABELS = { 2: '更早总述', 3: '最早总述' };
  const settings = () => window.MEMORY_ENGINE_SETTINGS?.getSettings(true) || {};
  const data = () => window.MEMORY_ENGINE_DATA;
  const timelineApi = () => window.MEMORY_ENGINE_TIMELINE;
  function setExternalStatus(text, isError) {
    window.__WE_SetExternalStatus?.(text, !!isError);
  }
  function refreshMemoryPanel() {
    window.WORLD_ENGINE_UI?.refresh?.(true);
  }
  function context() { try { return SillyTavern.getContext(); } catch (_) { return null; } }
  const chat = () => context()?.chat || [];
  const currentLayer = () => Math.max(0, chat().length - 1);
  const ignoreFirstLayer = st => st?.firstLayerIsAiOpening !== false;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  function configuredNameBlacklist(st) {
    return new Set(clean(st?.nameBlacklist).split(/\r?\n/).map(normalized).filter(Boolean));
  }

  function nameIsBlacklisted(value, blacklist) {
    const names = Array.isArray(value) ? value : [value];
    return names.some(name => blacklist.has(normalized(name)));
  }

  function rollbackLinkedLayer(layer) {
    const state = data()?.loadState?.();
    if (!state) return false;
    const removed = removeLinkedLayerFromState(state, layer);
    if (!removed.removed) return false;
    data().saveState(replayTimeline(state));
    applyInjection();
    return true;
  }

  // 每条候选记录各掷一次离散骰子，再按指数衰减权重计算优先级。
  // 最新记录权重最高；最旧记录的权重至少为 1 / 骰子面数，因此始终保留非零机会。
  function exponentialMemorySample(items, limit, randomFn = Math.random, diceSides = DEFAULT_INJECTION_DICE_SIDES) {
    const source = Array.isArray(items) ? items : [];
    const take = Math.max(0, Math.min(source.length, parseInt(limit) || 0));
    if (!take || !source.length) return [];
    if (source.length <= take) return source.slice();
    const sides = Math.max(1000, Math.min(10000, parseInt(diceSides) || DEFAULT_INJECTION_DICE_SIDES));
    const scale = Math.max(1, take);
    return source.map((item, index) => {
      const age = source.length - 1 - index;
      const weight = Math.max(1 / sides, Math.exp(-age / scale));
      const roll = Math.max(1, Math.min(sides, Math.floor(Number(randomFn()) * sides) + 1));
      const unit = roll / (sides + 1);
      return { item, index, priority: -Math.log(unit) / weight };
    }).sort((a, b) => a.priority - b.priority)
      .slice(0, take)
      .sort((a, b) => a.index - b.index)
      .map(entry => entry.item);
  }

  function formatMessages(messages, startLayer) {
    const ctx = context();
    const list = messages || [];
    // 走酒馆正则：逐条按用户/AI 输入过一遍酒馆「正则」面板脚本（只跑勾了「Alter Outgoing
    // Prompt」的脚本，与酒馆发给 AI 的处理完全一致），depth 相对本切片末尾。之后 filterConversation
    // 仍会执行本扩展正则。
    const useStRegex = settings().filterUseStRegex === true;
    const core = window.WORLD_ENGINE_CORE;
    return list.map((message, i) => {
      const fallback = message?.is_user ? (ctx?.name1 || '用户') : (ctx?.name2 || '角色');
      const mes = useStRegex && core?.applyStRegex
        ? core.applyStRegex(clean(message?.mes), !!message?.is_user, list.length - 1 - i)
        : clean(message?.mes);
      return `[楼层 ${Number(startLayer || 0) + i}]【${clean(message?.name) || fallback}】\n${mes}`;
    }).filter(Boolean).join('\n\n');
  }

  function recentConversation(rounds) {
    return recentConversationBatch(rounds).conversation;
  }

  function recentConversationBatch(rounds) {
    const all = chat(), count = Math.max(1, parseInt(rounds) || 1) * 2;
    const start = Math.max(ignoreFirstLayer(settings()) ? 1 : 0, all.length - count);
    const end = Math.max(start, all.length - 1);
    return {
      startLayer: start,
      endLayer: end,
      conversation: formatMessages(all.slice(start), start),
      sourceRefs: timelineApi()?.captureRange?.(start, end) || []
    };
  }

  // 『』时间标签是外部约定（模型/世界书写进正文），本引擎只消费。
  // 取批内首个与末个标签作为起止区间；仅一个标签时起止相同。
  function extractStoryTimeRange(text) {
    const found = Array.from(String(text || '').matchAll(/『([^』]*(?:年|月|日|时|刻)[^』]*)』/g));
    const format = value => clean(value.split('丨').slice(0, 3).join(' '));
    if (!found.length) return { start: '', end: '' };
    const start = format(found[0][1]);
    return { start, end: format(found.at(-1)[1]) };
  }

  function extractStoryTime(text) {
    const range = extractStoryTimeRange(text);
    return range.end || range.start;
  }

  // 纪要/总述起止时间的来源优先级：模型字段 → 正文『』标签 → 子条目继承。
  // start 与 end 相同是合法值（单轮次）；时间以文本透传，架空纪年也允许。
  function resolveSummaryTimes(llmStart, llmEnd, conversationText, children) {
    const range = extractStoryTimeRange(conversationText);
    const childStart = (children || []).map(item => clean(item?.timeStart)).find(Boolean) || '';
    const childEnd = (children || []).map(item => clean(item?.timeEnd)).filter(Boolean).at(-1) || '';
    return {
      timeStart: sanitizeTime(llmStart) || range.start || childStart,
      timeEnd: sanitizeTime(llmEnd) || range.end || childEnd
    };
  }

  // 纪要/总述的绝对时间区间：起止不同用「至」连接，否则单值；未知返回空串。
  function formatSummaryTimeRange(item) {
    const start = clean(item?.timeStart), end = clean(item?.timeEnd);
    if (start && end && normalized(start) !== normalized(end)) return `${start} 至 ${end}`;
    return start || end;
  }

  // 参考上下文用绝对时间；无时间回退楼层号（楼层号仅供人工对源，模型无法从中读出时间）。
  function formatSummaryRefLabel(item) {
    return formatSummaryTimeRange(item) || `楼层 ${Number(item?.startLayer) || 0}-${Number(item?.endLayer) || 0}`;
  }

  // 故事内「现在」：聊天末尾能解析到的最新故事时间（y*360+m*30+d 虚算法，与推演阈值同一口径）。
  function latestStoryDayTotal() {
    const nowDay = window.WORLD_ENGINE?.parseLatestStoryDay?.(chat());
    const total = Number(nowDay?.total);
    return Number.isFinite(total) ? total : null;
  }

  // 相对距离前缀只在注入层使用：起止时间与故事内现在都能解析为数字日期时才标注，
  // 架空纪年解析不了就不标（宁缺毋错）。
  function formatRelativeStoryAge(item, nowTotal) {
    const parse = window.WORLD_ENGINE_CORE?.parseStoryDate;
    if (typeof parse !== 'function' || !Number.isFinite(Number(nowTotal))) return '';
    const anchor = parse(clean(item?.timeEnd)) || parse(clean(item?.timeStart));
    if (!anchor || !Number.isFinite(Number(anchor.total))) return '';
    const diff = Number(nowTotal) - Number(anchor.total);
    if (diff < 0) return '';
    if (diff <= 1) return '最近';
    if (diff < 30) return `约 ${Math.round(diff)} 天前`;
    if (diff < 360) return `约 ${Math.round(diff / 30)} 个月前`;
    return `约 ${Math.round(diff / 360)} 年前`;
  }

  // 注入行标注：时间优先，相对前缀叠加在绝对时间前；无时间回退楼层号。
  function formatSummaryLabel(item, nowTotal) {
    const range = formatSummaryTimeRange(item);
    if (!range) return formatSummaryRefLabel(item);
    const relative = formatRelativeStoryAge(item, nowTotal);
    return relative ? `${relative} · ${range}` : range;
  }

  function filterConversation(conversation, st) {
    return window.WORLD_ENGINE_CORE?.filterDialogue?.(
      conversation, { evolveFilterRegex: st.filterRegex || '' }
    ) || conversation;
  }

  function previousRawReference(task, roundCount, st) {
    const count = Math.max(0, parseInt(roundCount) || 0);
    const all = chat();
    const boundary = Number.isFinite(Number(task?.startLayer)) ? Number(task.startLayer) : all.length;
    if (!count || boundary <= 0) return { conversation: '', startLayer: boundary, endLayer: boundary - 1 };
    const aiLayers = all.map((message, index) => (
      index < boundary && !(ignoreFirstLayer(st || settings()) && index === 0) && message && !message.is_user ? index : -1
    )).filter(index => index >= 0).slice(-count);
    if (!aiLayers.length) return { conversation: '', startLayer: boundary, endLayer: boundary - 1 };
    const firstAi = aiLayers[0];
    let start = firstAi;
    for (let index = firstAi - 1; index >= 0; index--) {
      if (all[index] && !all[index].is_user) break;
      start = index;
    }
    const end = aiLayers.at(-1);
    return {
      conversation: formatMessages(all.slice(start, end + 1), start),
      startLayer: start,
      endLayer: end
    };
  }

  function buildTaskReferenceContext(state, task, st) {
    const eventMemory = ensureEventState(state);
    const rawCount = st?.referenceRawRounds === undefined ? 1 : Math.max(0, parseInt(st.referenceRawRounds) || 0);
    const raw = previousRawReference(task, rawCount, st);
    const rawBoundary = raw.conversation
      ? raw.startLayer
      : (Number.isFinite(Number(task?.startLayer)) ? Number(task.startLayer) : Infinity);
    const currentChatId = clean(data()?.getChatId?.());
    const valid = item => item?.status !== 'stale' && item?.status !== 'failed' && clean(item?.content);
    const beforeLayer = (item, layer) => {
      const originChatId = clean(item?.originChatId);
      if (originChatId && currentChatId && originChatId !== currentChatId) return true;
      return Number(item?.endLayer) < layer;
    };
    const smallCount = st?.referenceSmallSummaryCount === undefined
      ? 5 : Math.max(0, parseInt(st.referenceSmallSummaryCount) || 0);
    const bigCount = st?.referenceBigSummaryCount === undefined
      ? 1 : Math.max(0, parseInt(st.referenceBigSummaryCount) || 0);
    const eligibleSmall = eventMemory.small_summaries
      .filter(item => valid(item) && beforeLayer(item, rawBoundary));
    const historySmallSummaries = smallCount ? eligibleSmall.slice(-smallCount) : [];
    const currentChatSmall = historySmallSummaries.find(item => {
      const originChatId = clean(item?.originChatId);
      return !originChatId || !currentChatId || originChatId === currentChatId;
    });
    const bigBoundary = currentChatSmall ? Number(currentChatSmall.startLayer) : rawBoundary;
    const eligibleBig = eventMemory.big_summaries
      .filter(item => valid(item) && beforeLayer(item, bigBoundary));
    const historyBigSummaries = bigCount ? eligibleBig.slice(-bigCount) : [];
    const parts = [];
    if (historyBigSummaries.length) parts.push(`【更早总述】\n${historyBigSummaries.map((item, index) =>
      `${index + 1}. [${formatSummaryRefLabel(item)}] ${clean(item?.content)}`
    ).join('\n')}`);
    if (historySmallSummaries.length) parts.push(`【前置纪要】\n${historySmallSummaries.map((item, index) =>
      `${index + 1}. [${formatSummaryRefLabel(item)}] ${clean(item?.content)}`
    ).join('\n')}`);
    if (raw.conversation) parts.push(`【近期正文】\n${filterConversation(raw.conversation, st)}`);
    return { historyBigSummaries, historySmallSummaries, raw, text: parts.join('\n\n') };
  }

  function buildSmallHistoryContext(state, task) {
    const st = settings();
    const context = buildTaskReferenceContext(state, task, st);
    return {
      historyBigSummaries: context.historyBigSummaries,
      historySmallSummaries: context.historySmallSummaries
    };
  }

  // 既有记忆作对照喂给提取任务：落库去重只认全文字符串，模型换一种措辞就会重复入库，
  // 因此在请求里明示已记录的内容。每人取最近 8 条、最多 8 人，防止长对话把 prompt 撑爆。
  function collectExistingMemories(state) {
    const characters = [];
    for (const character of state.personal_memory || []) {
      const names = unique(character.names || []);
      if (!names.length) continue;
      const records = [];
      for (const memories of Object.values(character.memory || {})) {
        for (const memory of Array.isArray(memories) ? memories : []) {
          const text = clean(memory);
          if (text) records.push(text);
        }
      }
      if (records.length) characters.push({ label: names.join(' / '), records: records.slice(-8) });
    }
    return characters.slice(-8);
  }

  async function buildRequestPrompt(tasks, state, st) {
    const segments = [];
    // 用户人设（酒馆「用户设定」里的 persona 描述）：只读参照，只进人物/实体提取任务
    // （known_by 归属、用户作为知情人物等判定需要知道{{user}}是谁）。人称为空、
    // 用户在酒馆把注入位置设为「不注入」或读取失败时一律为空，不阻断提取。
    if (tasks.memory) {
      try {
        const personaSection = await window.WORLD_ENGINE_CORE?.buildPersonaSection?.() || '';
        if (personaSection) segments.push(personaSection);
      } catch (error) {
        console.error('[记忆引擎] 读取用户人设失败（已隔离）', error);
      }
    }
    const memoryReference = tasks.memory ? buildTaskReferenceContext(state, tasks.memory, st) : null;
    const sharesReference = Boolean(tasks.memory && tasks.small
      && Number(tasks.memory.startLayer) === Number(tasks.small.startLayer)
      && Number(tasks.memory.endLayer) === Number(tasks.small.endLayer));
    const smallReference = tasks.small && !sharesReference
      ? buildTaskReferenceContext(state, tasks.small, st) : null;
    if (tasks.memory) {
      const filtered = filterConversation(tasks.memory.conversation, st);
      let worldbook = '';
      if (st.worldbookEnabled && window.WORLD_ENGINE_WORLDBOOK?.buildPromptSection) {
        worldbook = await window.WORLD_ENGINE_WORLDBOOK.buildPromptSection(filtered, 'memory');
      }
      const user = window.MEMORY_ENGINE_PROMPT.buildUserPrompt({
        currentStoryTime: extractStoryTime(filtered),
        knownPeople: (state.personal_memory || []).map(character => unique(character.names)),
        knownEntities: ENTITY_TYPES.flatMap(type => (state.entity_memory?.[type] || []).map(entity => ({
          type: ENTITY_LABELS[type], name: entity.name, aliases: unique(entity.aliases), description: entity.description,
          history: Array.isArray(entity.history) ? entity.history.slice(-5) : []
        }))),
        knownNpcProfiles: tasks.memory ? (state.npc_profiles || [])
          .filter(profile => clean(profile.location) || clean(profile.condition) || clean(profile.stance))
          .slice(-8).map(profile => ({
            names: unique(profile.names || []),
            location: clean(profile.location),
            condition: clean(profile.condition),
            stance: clean(profile.stance)
          })) : [],
        existingMemories: tasks.memory ? collectExistingMemories(state) : [],
        worldbook,
        referenceContext: memoryReference?.text || '',
        conversation: filtered
      });
      segments.push(`【任务说明】\n${window.MEMORY_ENGINE_PROMPT.TASK_PROMPT || window.MEMORY_ENGINE_PROMPT.SYSTEM_PROMPT}\n\n${user}`);
    }
    if (tasks.small) {
      segments.push(`【任务说明】\n${window.MEMORY_ENGINE_SMALL_SUMMARY_PROMPT.SYSTEM_PROMPT}\n\n${window.MEMORY_ENGINE_SMALL_SUMMARY_PROMPT.buildUserPrompt({
        ...tasks.small,
        currentStoryTime: extractStoryTime(filterConversation(tasks.small.conversation, st)),
        reuseConversation: sharesReference,
        referenceContext: sharesReference && memoryReference?.text
          ? '沿用同一请求前文人物/实体任务中的【只读辅助参考】，不得把其中旧内容写成本段新增事件。'
          : (smallReference?.text || ''),
        conversation: filterConversation(tasks.small.conversation, st)
      })}`);
    }
    if (tasks.big) {
      segments.push(`【任务说明】\n${window.MEMORY_ENGINE_BIG_SUMMARY_PROMPT.SYSTEM_PROMPT}\n\n${window.MEMORY_ENGINE_BIG_SUMMARY_PROMPT.buildUserPrompt({
        ...tasks.big
      })}`);
    }
    const fields = [];
    if (tasks.memory) fields.push(`"personal_memory": [
    {
      "name": ["人物名或别名"],
      "known_by": ["其他知情人物名"],
      "memory": "一条独立的人物主观记忆",
      "time": "这条记忆对应的绝对故事时间或空字符串"
    }
  ]`, `"entity_updates": [
    {
      "type": "organization、object、ability、location 四者之一",
      "name": "实体名称",
      "aliases": ["实体别名"],
      "description": "当前描述或空字符串",
      "event": "一条独立的本批新增重要事件或空字符串",
      "time": "这条事件对应的绝对故事时间或空字符串"
    }
  ]`);
    if (tasks.memory && tasks.memory.kind !== 'world_link') fields.push(`"npc_updates": [
    {
      "names": ["人物名或别名"],
      "location": "所在位置或空字符串",
      "condition": "当前处境或空字符串",
      "stance": "对主角的外在态度或空字符串"
    }
  ]`);
    if (tasks.small) fields.push('"small_summary": "", "time_start": "", "time_end": ""');
    if (tasks.big) fields.push('"big_summary": "", "time_start": "", "time_end": ""');
    const tone = clean(st.tonePrompt);
    const emptyMemory = tasks.memory
      ? '\n\n没有对应内容时分别使用 "personal_memory": [] 和 "entity_updates": []；不得省略字段。'
      : '';
    return `${segments.join('\n\n=====\n\n')}\n\n【统一输出要求】\n只输出一个合法 JSON 对象，不要输出 Markdown、代码围栏或解释。严格按照以下完整结构返回；模板文字替换为实际内容：\n{\n  ${fields.join(',\n  ')}\n}${emptyMemory}${tone ? `\n\n【附加要求】\n${tone}` : ''}`;
  }

  // 思维链剥离：成对标签整段删除；只剩闭合标签说明前面是未完成草稿，丢弃到最后一个闭合标签为止；
  // 只剩开标签说明输出被截断，从开标签起整体作废。
  function stripThinking(text) {
    let value = String(text || '').replace(/<(?:think|thinking)>[\s\S]*?<\/(?:think|thinking)>/gi, '');
    const closes = value.match(/<\/(?:think|thinking)>/gi);
    if (closes?.length) {
      const lastClose = value.toLowerCase().lastIndexOf(closes.at(-1).toLowerCase());
      value = value.slice(lastClose + closes.at(-1).length);
    } else {
      const openMatch = value.match(/<(?:think|thinking)>/i);
      if (openMatch) value = value.slice(0, value.toLowerCase().indexOf(openMatch[0].toLowerCase()));
    }
    return value.trim();
  }

  function normalizeJsonText(text) {
    return String(text || '')
      .replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
      .replace(/,\s*([}\]])/g, '$1');
  }

  // 字符串内部的野引号（如英文对白）补转义：串内引号只有后继是结构性字符才算结束引号。
  // 对已合法的 JSON 是恒等变换。
  function escapeStrayQuotes(text) {
    const source = String(text || '');
    let result = '', inString = false, escaped = false;
    for (let i = 0; i < source.length; i++) {
      const ch = source[i];
      if (!inString) {
        if (ch === '"') inString = true;
        result += ch;
        continue;
      }
      if (escaped) { escaped = false; result += ch; continue; }
      if (ch === '\\') { escaped = true; result += ch; continue; }
      if (ch === '"') {
        let j = i + 1;
        while (j < source.length && /\s/.test(source[j])) j++;
        const next = j < source.length ? source[j] : '';
        if (next === '' || ':,}]'.includes(next)) { inString = false; result += ch; }
        else result += '\\"';
        continue;
      }
      result += ch;
    }
    return result;
  }

  function extractJsonPayload(raw) {
    const text = stripThinking(clean(raw)).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const candidates = [];
    const push = value => { if (value && !candidates.includes(value)) candidates.push(value); };
    push(text.trim());
    const objectStart = text.indexOf('{'), objectEnd = text.lastIndexOf('}');
    const arrayStart = text.indexOf('['), arrayEnd = text.lastIndexOf(']');
    if (arrayStart >= 0 && arrayStart < objectStart && arrayEnd > arrayStart) push(text.slice(arrayStart, arrayEnd + 1));
    else if (objectStart >= 0 && objectEnd > objectStart) push(text.slice(objectStart, objectEnd + 1));
    else if (arrayStart >= 0 && arrayEnd > arrayStart) push(text.slice(arrayStart, arrayEnd + 1));
    for (const candidate of candidates) {
      for (const prepared of [candidate, normalizeJsonText(candidate), escapeStrayQuotes(candidate),
        escapeStrayQuotes(normalizeJsonText(candidate))]) {
        try { return JSON.parse(prepared); } catch (_) { /* 尝试下一级清洗 */ }
      }
    }
    throw new Error('API 返回中没有合法 JSON 对象或数组');
  }

  // 超长条目在限制内就近按句读截断，避免模型超字数时把残句写进记录。
  function clampSentence(value, limit) {
    const text = clean(value);
    if (text.length <= limit) return text;
    const truncated = text.slice(0, limit);
    const cut = Math.max(
      truncated.lastIndexOf('。'), truncated.lastIndexOf('！'), truncated.lastIndexOf('？'),
      truncated.lastIndexOf('；'), truncated.lastIndexOf('，')
    );
    return cut >= Math.ceil(limit / 2) ? truncated.slice(0, cut + 1) : truncated;
  }

  function parseResponse(raw, tasks) {
    const value = extractJsonPayload(raw);
    const nameBlacklist = configuredNameBlacklist(settings());
    // 兼容 0.1.x：旧 API 只返回人物记忆数组。
    const personalValue = tasks.memory ? (Array.isArray(value)
      ? value
      : (value?.personal_memory || value?.memories || value?.memory || value?.data || [])) : [];
    const personalSource = Array.isArray(personalValue)
      ? personalValue
      : (personalValue && typeof personalValue === 'object' ? [personalValue] : []);
    const counts = new Map(), personal = [];
    for (const item of personalSource) {
      if (!item || typeof item !== 'object') continue;
      if (nameIsBlacklisted(item.name, nameBlacklist)) continue;
      const names = unique(Array.isArray(item.name) ? item.name : [item.name]), memory = clampSentence(item.memory, 50);
      if (!names.length || !memory) continue;
      const holder = normalized(names[0]), count = counts.get(holder) || 0;
      if (count >= 3) continue;
      counts.set(holder, count + 1);
      let time = clean(item.time);
      if (RELATIVE_TIME_RE.test(time)) time = '';
      personal.push({
        name: names,
        known_by: unique(Array.isArray(item.known_by) ? item.known_by : [item.known_by])
          .filter(name => !names.some(holderName => normalized(holderName) === normalized(name))),
        memory,
        time
      });
      if (personal.length >= 8) break;
    }
    const entityValue = tasks.memory && !Array.isArray(value) ? value?.entity_updates : [];
    const entitySource = Array.isArray(entityValue)
      ? entityValue
      : (entityValue && typeof entityValue === 'object' ? [entityValue] : []);
    const entities = {};
    for (const type of ENTITY_TYPES) entities[type] = [];
    const perEntityCounts = new Map();
    let entityUpdateCount = 0;
    for (const item of entitySource) {
      if (entityUpdateCount >= 8) break;
      if (!item || typeof item !== 'object') continue;
      const aliases = unique(Array.isArray(item.aliases) ? item.aliases : [item.aliases]);
      if (nameIsBlacklisted([item.name, ...aliases], nameBlacklist)) continue;
      if (!ENTITY_TYPES.includes(item.type)) continue;
      const type = item.type, name = clean(item.name), description = clampSentence(item.description, 200), event = clean(item.event);
      if (!name) continue;
      const cleanAliases = aliases.filter(alias => normalized(alias) !== normalized(name));
      const key = `${type}:${normalized(name)}`, count = perEntityCounts.get(key) || 0;
      if (count >= 3) continue;
      perEntityCounts.set(key, count + 1);
      entities[type].push({ name, aliases: cleanAliases, description, event, time: event ? sanitizeTime(item.time) : '' });
      entityUpdateCount++;
    }
    let smallSummary = '', smallTimeStart = '', smallTimeEnd = '';
    if (tasks.small) {
      smallSummary = Array.isArray(value) ? '' : clean(value?.small_summary);
      smallTimeStart = clampSentence(sanitizeTime(value?.time_start), 40);
      smallTimeEnd = clampSentence(sanitizeTime(value?.time_end), 40);
    }
    let bigSummary = '', bigTimeStart = '', bigTimeEnd = '';
    if (tasks.big) {
      bigSummary = Array.isArray(value) ? '' : clean(value?.big_summary);
      bigTimeStart = clampSentence(sanitizeTime(value?.time_start), 40);
      bigTimeEnd = clampSentence(sanitizeTime(value?.time_end), 40);
    }
    // 人物状态更新：只走普通提取任务；世界联动的合成输入不带 npc_updates。
    const npcs = [];
    if (tasks.memory && tasks.memory.kind !== 'world_link') {
      const npcSource = Array.isArray(value) ? [] : value?.npc_updates;
      const npcList = Array.isArray(npcSource) ? npcSource : (npcSource && typeof npcSource === 'object' ? [npcSource] : []);
      const seenNpc = new Set();
      for (const item of npcList) {
        if (npcs.length >= 6) break;
        if (!item || typeof item !== 'object') continue;
        const names = unique(Array.isArray(item.names) ? item.names : [item.names]);
        if (!names.length || nameIsBlacklisted(names, nameBlacklist)) continue;
        const key = names.map(normalized).sort().join('|');
        if (seenNpc.has(key)) continue;
        seenNpc.add(key);
        npcs.push({
          names,
          location: clampSentence(item.location, 60),
          condition: clampSentence(item.condition, 60),
          stance: clampSentence(item.stance, 60)
        });
      }
    }
    return { personal, entities, npcs, smallSummary, smallTimeStart, smallTimeEnd, bigSummary, bigTimeStart, bigTimeEnd };
  }

  function sanitizeTime(value) {
    const time = clean(value);
    return RELATIVE_TIME_RE.test(time) ? '' : time;
  }

  function nextCharacterId(state) {
    const max = (state.personal_memory || []).reduce((n, character) => {
      const match = /^char_(\d+)$/.exec(clean(character.id));
      return Math.max(n, match ? Number(match[1]) : 0);
    }, 0);
    return `char_${String(max + 1).padStart(6, '0')}`;
  }

  function findCharacter(state, names) {
    const wanted = new Set(unique(names).map(normalized));
    return (state.personal_memory || []).find(character =>
      (character.names || []).some(name => wanted.has(normalized(name))));
  }

  function addKnowledge(index, names, record) {
    for (const name of unique(names)) {
      const key = normalized(name);
      if (!Array.isArray(index[key])) index[key] = [];
      if (!index[key].some(item => item.ownerId === record.ownerId && item.time === record.time && item.memory === record.memory)) {
        index[key].push(clone(record));
      }
    }
  }

  function rebuildKnowledgeIndex(state) {
    const index = {};
    for (const character of state.personal_memory || []) {
      for (const [time, memories] of Object.entries(character.memory || {})) {
        for (const memory of Array.isArray(memories) ? memories : []) {
          addKnowledge(index, character.names, { ownerId: character.id, time, memory });
        }
      }
    }
    state.knowledge_index = index;
  }

  function ensureEntityState(state) {
    if (!state.entity_memory || typeof state.entity_memory !== 'object' || Array.isArray(state.entity_memory)) state.entity_memory = {};
    for (const type of ENTITY_TYPES) {
      if (!Array.isArray(state.entity_memory[type])) state.entity_memory[type] = [];
      for (const entity of state.entity_memory[type]) {
        const name = clean(entity?.name);
        entity.aliases = unique(Array.isArray(entity?.aliases) ? entity.aliases : [entity?.aliases])
          .filter(alias => normalized(alias) !== normalized(name));
      }
    }
    if (!state.entity_index || typeof state.entity_index !== 'object' || Array.isArray(state.entity_index)) state.entity_index = {};
  }

  function nextEntityId(state, type) {
    ensureEntityState(state);
    const prefix = { organization: 'org', object: 'obj', ability: 'ability', location: 'location' }[type];
    const pattern = new RegExp(`^${prefix}_(\\d+)$`);
    const max = state.entity_memory[type].reduce((number, entity) => {
      const match = pattern.exec(clean(entity.id));
      return Math.max(number, match ? Number(match[1]) : 0);
    }, 0);
    return `${prefix}_${String(max + 1).padStart(6, '0')}`;
  }

  function rebuildEntityIndex(state) {
    ensureEntityState(state);
    const index = {};
    for (const type of ENTITY_TYPES) {
      for (const entity of state.entity_memory[type]) {
        if (!clean(entity.id)) entity.id = nextEntityId(state, type);
        const names = unique([entity.name, ...(entity.aliases || [])]);
        for (const name of names) index[`${type}:${normalized(name)}`] = entity.id;
      }
    }
    state.entity_index = index;
  }

  function repairStateIndexes(state, previousState) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return state;
    const oldState = previousState && typeof previousState === 'object' ? previousState : state;
    const oldIndex = clone(oldState.knowledge_index || {});
    const aliasTargets = {};
    const removedAliases = new Set();
    for (const oldPerson of oldState.personal_memory || []) {
      const current = (state.personal_memory || []).find(person => person.id === oldPerson.id);
      if (!current) {
        for (const oldName of oldPerson.names || []) removedAliases.add(normalized(oldName));
        continue;
      }
      for (const oldName of oldPerson.names || []) aliasTargets[normalized(oldName)] = unique(current.names || []);
    }
    rebuildKnowledgeIndex(state);
    const validRecords = new Set();
    for (const person of state.personal_memory || []) {
      for (const [time, memories] of Object.entries(person.memory || {})) {
        for (const memory of Array.isArray(memories) ? memories : []) validRecords.add(`${person.id}\u0000${time}\u0000${memory}`);
      }
    }
    for (const [oldName, records] of Object.entries(oldIndex)) {
      if (removedAliases.has(normalized(oldName))) continue;
      const targets = aliasTargets[normalized(oldName)] || [oldName];
      for (const record of Array.isArray(records) ? records : []) {
        if (!validRecords.has(`${record.ownerId}\u0000${record.time}\u0000${record.memory}`)) continue;
        addKnowledge(state.knowledge_index, targets, record);
      }
    }
    rebuildEntityIndex(state);
    return state;
  }

  function findEntity(state, type, name, aliases) {
    ensureEntityState(state);
    const names = unique([name, ...(aliases || [])]);
    let id = names.map(item => state.entity_index[`${type}:${normalized(item)}`]).find(Boolean);
    let entity = id && state.entity_memory[type].find(item => item.id === id);
    if (!entity) entity = state.entity_memory[type].find(item => {
      const existing = unique([item.name, ...(item.aliases || [])]).map(normalized);
      return names.some(candidate => existing.includes(normalized(candidate)));
    });
    if (entity) {
      if (!clean(entity.id)) entity.id = nextEntityId(state, type);
      for (const candidate of names) state.entity_index[`${type}:${normalized(candidate)}`] = entity.id;
    }
    return entity;
  }

  function mergeEntityMemories(state, groups) {
    ensureEntityState(state);
    if (!Object.keys(state.entity_index).length) rebuildEntityIndex(state);
    const result = { entities: 0, history: 0, descriptions: 0 };
    for (const type of ENTITY_TYPES) {
      for (const item of groups?.[type] || []) {
        let entity = findEntity(state, type, item.name, item.aliases);
        let isNew = false;
        if (!entity) {
          entity = { id: nextEntityId(state, type), name: item.name, aliases: unique(item.aliases), description: '', history: [] };
          state.entity_memory[type].push(entity);
          state.entity_index[`${type}:${normalized(item.name)}`] = entity.id;
          result.entities++;
          isNew = true;
        }
        entity.aliases = unique([...(entity.aliases || []), ...(item.aliases || []),
          normalized(entity.name) === normalized(item.name) ? '' : item.name])
          .filter(alias => normalized(alias) !== normalized(entity.name));
        for (const candidate of [entity.name, ...entity.aliases]) {
          state.entity_index[`${type}:${normalized(candidate)}`] = entity.id;
        }
        if (item.description && entity.description !== item.description) {
          entity.description = item.description;
          if (!isNew) result.descriptions++;
        }
        if (!Array.isArray(entity.history)) entity.history = [];
        if (item.event && !entity.history.some(old => clean(old.time) === clean(item.time) && clean(old.event) === clean(item.event))) {
          entity.history.push({ time: clean(item.time), event: clean(item.event) });
          result.history++;
        }
      }
    }
    return result;
  }

  function mergeMemories(state, items) {
    if (!state.knowledge_index || typeof state.knowledge_index !== 'object') rebuildKnowledgeIndex(state);
    let added = 0;
    for (const item of items) {
      let character = findCharacter(state, item.name);
      if (!character) {
        character = { id: nextCharacterId(state), names: [], memory: {} };
        state.personal_memory.push(character);
      }
      character.names = unique([...(character.names || []), ...item.name]);
      if (!character.memory || typeof character.memory !== 'object' || Array.isArray(character.memory)) character.memory = {};
      const time = item.time || '';
      if (!Array.isArray(character.memory[time])) character.memory[time] = [];
      const exists = Object.values(character.memory).some(list => Array.isArray(list) && list.includes(item.memory));
      if (!exists) { character.memory[time].push(item.memory); added++; }
      const record = { ownerId: character.id, time, memory: item.memory };
      addKnowledge(state.knowledge_index, character.names, record); // 持有者本人自动补入
      for (const knowerName of item.known_by) {
        let knower = findCharacter(state, [knowerName]);
        if (!knower) {
          knower = { id: nextCharacterId(state), names: [knowerName], memory: {} };
          state.personal_memory.push(knower);
        }
        addKnowledge(state.knowledge_index, knower.names, record);
      }
    }
    return added;
  }

  function nextNpcProfileId(state) {
    const max = (state.npc_profiles || []).reduce((number, profile) => {
      const match = /^npc_(\d+)$/.exec(clean(profile.id));
      return Math.max(number, match ? Number(match[1]) : 0);
    }, 0);
    return `npc_${String(max + 1).padStart(6, '0')}`;
  }

  function findNpcProfile(state, names) {
    const wanted = new Set(unique(names).map(normalized));
    return (state.npc_profiles || []).find(profile => (profile.names || []).some(name => wanted.has(normalized(name))));
  }

  // 人物当前状态合并：按 names 找到即逐字段非空覆盖（最新观察优先），找不到新建。
  function mergeNpcProfiles(state, updates) {
    if (!Array.isArray(state.npc_profiles)) state.npc_profiles = [];
    let changed = 0;
    for (const item of updates || []) {
      const names = unique(item?.names);
      if (!names.length) continue;
      let profile = findNpcProfile(state, names);
      if (!profile) {
        profile = { id: nextNpcProfileId(state), names: [], location: '', condition: '', stance: '', sourceDigest: '' };
        state.npc_profiles.push(profile);
        changed++;
      }
      profile.names = unique([...(profile.names || []), ...names]);
      for (const field of ['location', 'condition', 'stance']) {
        const value = clean(item?.[field]);
        if (value && profile[field] !== value) { profile[field] = value; changed++; }
      }
    }
    return changed;
  }

  function replaceKnownByRecords(state, ownerId, records) {
    if (!state || typeof state !== 'object') return state;
    if (!state.knowledge_index || typeof state.knowledge_index !== 'object' || Array.isArray(state.knowledge_index)) state.knowledge_index = {};
    const owner = (state.personal_memory || []).find(character => character.id === ownerId);
    if (!owner) return state;
    for (const [name, indexed] of Object.entries(state.knowledge_index)) {
      state.knowledge_index[name] = (Array.isArray(indexed) ? indexed : []).filter(record => record.ownerId !== ownerId);
      if (!state.knowledge_index[name].length) delete state.knowledge_index[name];
    }
    for (const item of records || []) {
      const time = clean(item?.time), memory = clean(item?.memory ?? item?.content);
      if (!memory) continue;
      const record = { ownerId, time, memory };
      addKnowledge(state.knowledge_index, owner.names, record);
      for (const knowerName of unique(item?.known_by).filter(name => !(owner.names || []).some(alias => normalized(alias) === normalized(name)))) {
        let knower = findCharacter(state, [knowerName]);
        if (!knower) {
          knower = { id: nextCharacterId(state), names: [knowerName], memory: {} };
          state.personal_memory.push(knower);
        }
        addKnowledge(state.knowledge_index, knower.names, record);
      }
    }
    return state;
  }

  function ensureEventState(state) {
    if (!state.event_memory || typeof state.event_memory !== 'object' || Array.isArray(state.event_memory)) state.event_memory = {};
    if (!Array.isArray(state.event_memory.small_summaries)) state.event_memory.small_summaries = [];
    if (!Array.isArray(state.event_memory.big_summaries)) {
      state.event_memory.big_summaries = state.event_memory.big_summary?.content ? [state.event_memory.big_summary] : [];
    }
    // level 1 = 纪要合并的总述；2 = 更早总述；3 = 最早总述。旧数据与非法值一律按 1。
    for (const overview of state.event_memory.big_summaries) {
      overview.level = Number(overview?.level) >= 2 && Number(overview?.level) <= MAX_SUMMARY_LEVEL
        ? Number(overview.level) : 1;
    }
    delete state.event_memory.big_summary;
    if (!Number.isFinite(Number(state.event_memory.big_summary_cursor))) state.event_memory.big_summary_cursor = 0;
    state.event_memory.big_summary_cursor = Math.max(0, Math.min(
      state.event_memory.small_summaries.length, Number(state.event_memory.big_summary_cursor) || 0
    ));
    return state.event_memory;
  }

  function ensureTimelineState(state) {
    if (!state.timeline || typeof state.timeline !== 'object' || Array.isArray(state.timeline)) {
      // MEMORY_ENGINE_DATA.normalizeState normally creates this; the fallback protects tests and partial imports.
      const originChatId = data()?.getChatId?.() || 'default';
      state.timeline = {
        version: 1,
        originChatId,
        root: {
          id: `root:${originChatId}`,
          originChatId,
          createdAt: Date.now(),
          base: {
            personal_memory: clone(state.personal_memory || []),
            knowledge_index: clone(state.knowledge_index || {}),
            entity_memory: clone(state.entity_memory || {}),
            entity_index: clone(state.entity_index || {}),
            round: Math.max(0, Number(state.round) || 0),
            chatLayer: state.chatLayer ?? null
          }
        },
        nodes: []
      };
    }
    if (!Array.isArray(state.timeline.nodes)) state.timeline.nodes = [];
    return state.timeline;
  }

  function nextTimelineNodeId(timeline) {
    const max = (timeline.nodes || []).reduce((number, node) => {
      const match = /^memory_(\d+)$/.exec(clean(node?.id));
      return Math.max(number, match ? Number(match[1]) : 0);
    }, 0);
    return `memory_${String(max + 1).padStart(6, '0')}`;
  }

  function sourceBounds(refs, fallbackLayer) {
    const layers = (refs || []).map(ref => Number(ref?.layer)).filter(Number.isFinite);
    const fallback = Number.isFinite(Number(fallbackLayer)) ? Number(fallbackLayer) : currentLayer();
    return {
      startLayer: layers.length ? Math.min(...layers) : fallback,
      endLayer: layers.length ? Math.max(...layers) : fallback
    };
  }

  function appendTimelineNode(state, extracted, task, options) {
    const timeline = ensureTimelineState(state), api = timelineApi();
    let refs = Array.isArray(task?.sourceRefs) ? clone(task.sourceRefs) : [];
    if (!refs.length && Number.isFinite(Number(task?.startLayer)) && Number.isFinite(Number(task?.endLayer))) {
      refs = api?.captureRange?.(Number(task.startLayer), Number(task.endLayer)) || [];
    }
    // 世界引擎联动等合成输入没有真实聊天正文，用跨聊天唯一的合成来源记录身份。
    if (!refs.length) {
      const originChatId = data()?.getChatId?.() || 'default';
      const layer = Number.isFinite(Number(options?.layer)) ? Number(options.layer) : currentLayer();
      const sourceText = clean(task?.conversation);
      refs = [{
        chatId: originChatId,
        messageId: clean(task?.sourceKey) || `synthetic:${originChatId}:${layer}:${api?.hashText?.(sourceText) || sourceText.length}`,
        layer,
        role: 'synthetic',
        swipeId: 0,
        hash: api?.hashText?.(sourceText) || String(sourceText.length),
        synthetic: true
      }];
    }
    const digest = api?.digestRefs?.(refs) || '';
    const existing = timeline.nodes.find(node => node.sourceDigest && node.sourceDigest === digest && node.status !== 'stale');
    if (existing) return existing;
    const bounds = sourceBounds(refs, options?.layer);
    const node = {
      id: nextTimelineNodeId(timeline),
      kind: task?.kind || 'memory',
      source: task?.kind === 'world_link' ? 'world_engine' : undefined,
      sourceKey: task?.kind === 'world_link' ? clean(task?.sourceKey) : undefined,
      originChatId: data()?.getChatId?.() || 'default',
      startLayer: bounds.startLayer,
      endLayer: bounds.endLayer,
      sourceRefs: refs,
      sourceDigest: digest,
      personal: clone(extracted?.personal || []),
      entities: clone(extracted?.entities || {}),
      npcs: clone(extracted?.npcs || []),
      status: 'valid',
      revision: 1,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    timeline.nodes.push(node);
    return node;
  }

  // 世界联动是一笔带来源标记的独立事务。重 roll 只撤销当前楼层的联动节点、
  // 世界摘要纪要及消费过这些纪要的总述；普通对话记忆和普通纪要始终保留。
  function removeLinkedLayerFromState(state, layer) {
    const numericLayer = Number(layer);
    if (!Number.isFinite(numericLayer)) return { removed: false, sourceKey: '', removedSmallIds: [] };
    const sourceKey = `${data()?.getChatId?.() || 'default'}:${numericLayer}`;
    const timeline = ensureTimelineState(state), eventMemory = ensureEventState(state);
    const matchesNode = node => {
      if (node?.kind !== 'world_link') return false;
      if (clean(node?.sourceKey) === sourceKey) return true;
      if ((node?.sourceRefs || []).some(ref => clean(ref?.messageId) === sourceKey)) return true;
      return !clean(node?.sourceKey) && Number(node?.startLayer) === numericLayer
        && Number(node?.endLayer) === numericLayer;
    };
    const matchesSmall = item => item?.source === 'world_engine' && (
      clean(item?.sourceKey) === sourceKey
      || (!clean(item?.sourceKey) && Number(item?.startLayer) === numericLayer && Number(item?.endLayer) === numericLayer)
    );

    const removedNodes = timeline.nodes.filter(matchesNode);
    const removedSmall = eventMemory.small_summaries.filter(matchesSmall);
    if (!removedNodes.length && !removedSmall.length) {
      return { removed: false, sourceKey, removedSmallIds: [] };
    }

    const removedSmallIds = new Set(removedSmall.map(item => clean(item?.id)).filter(Boolean));
    const affectedBig = eventMemory.big_summaries.filter(item =>
      (item?.childIds || []).some(id => removedSmallIds.has(clean(id)))
    );
    // 被撤销总述所归属的更高层总述逐层级联撤销（不动点），避免上层继续引用不存在的子总述。
    const removedBigIds = new Set(affectedBig.map(item => clean(item?.id)));
    let cascadeGrew = true;
    while (cascadeGrew) {
      cascadeGrew = false;
      for (const overview of eventMemory.big_summaries) {
        const id = clean(overview?.id);
        if (!id || removedBigIds.has(id)) continue;
        if ((overview?.childIds || []).some(childId => removedBigIds.has(clean(childId)))) {
          removedBigIds.add(id);
          cascadeGrew = true;
        }
      }
    }
    const affectedMeta = eventMemory.big_summaries.filter(item => removedBigIds.has(clean(item?.id)));
    const affectedChildIds = new Set([
      ...removedSmallIds,
      ...affectedBig.flatMap(item => item?.childIds || []).map(clean).filter(Boolean)
    ]);
    const firstAffectedIndex = eventMemory.small_summaries.findIndex(item => affectedChildIds.has(clean(item?.id)));

    timeline.nodes = timeline.nodes.filter(node => !matchesNode(node));
    eventMemory.small_summaries = eventMemory.small_summaries.filter(item => !matchesSmall(item));
    eventMemory.big_summaries = eventMemory.big_summaries
      .filter(item => !affectedBig.includes(item) && !affectedMeta.includes(item));
    if (firstAffectedIndex >= 0) {
      eventMemory.big_summary_cursor = Math.min(eventMemory.big_summary_cursor, firstAffectedIndex);
    }
    eventMemory.big_summary_cursor = Math.max(0, Math.min(
      eventMemory.small_summaries.length, Number(eventMemory.big_summary_cursor) || 0
    ));
    return {
      removed: true,
      sourceKey,
      removedNodeIds: removedNodes.map(node => node.id),
      removedSmallIds: [...removedSmallIds],
      removedBigIds: [...affectedBig, ...affectedMeta].map(item => item.id)
    };
  }

  function replayTimeline(state, stopBeforeId) {
    const timeline = ensureTimelineState(state), root = clone(timeline.root?.base || {});
    const derived = {
      personal_memory: clone(root.personal_memory || []),
      knowledge_index: clone(root.knowledge_index || {}),
      entity_memory: clone(root.entity_memory || {}),
      entity_index: clone(root.entity_index || {}),
      npc_profiles: clone(root.npc_profiles || []),
      round: Math.max(0, Number(root.round) || 0),
      chatLayer: root.chatLayer ?? null,
      event_memory: clone(state.event_memory || {}),
      timeline: clone(timeline)
    };
    ensureEntityState(derived);
    for (const node of timeline.nodes) {
      if (stopBeforeId && node.id === stopBeforeId) break;
      if (node.status !== 'valid') continue;
      if (node.kind === 'manual_snapshot' && node.snapshot) {
        derived.personal_memory = clone(node.snapshot.personal_memory || []);
        derived.knowledge_index = clone(node.snapshot.knowledge_index || {});
        derived.entity_memory = clone(node.snapshot.entity_memory || {});
        derived.entity_index = clone(node.snapshot.entity_index || {});
        derived.npc_profiles = clone(node.snapshot.npc_profiles || []);
        derived.round = Math.max(derived.round, Number(node.snapshot.round) || 0);
        derived.chatLayer = node.snapshot.chatLayer ?? derived.chatLayer;
        ensureEntityState(derived);
        continue;
      }
      mergeMemories(derived, clone(node.personal || []));
      mergeEntityMemories(derived, clone(node.entities || {}));
      mergeNpcProfiles(derived, clone(node.npcs || []));
      derived.round += 1;
      if (Number.isFinite(Number(node.endLayer))) derived.chatLayer = Number(node.endLayer);
    }
    repairStateIndexes(derived, derived);
    return derived;
  }

  function commitManualState(nextState, previousState) {
    if (!nextState || !previousState) return nextState;
    const memoryView = state => JSON.stringify({
      personal_memory: state.personal_memory || [],
      knowledge_index: state.knowledge_index || {},
      entity_memory: state.entity_memory || {},
      entity_index: state.entity_index || {},
      npc_profiles: state.npc_profiles || []
    });
    if (memoryView(nextState) === memoryView(previousState)) return nextState;
    const timeline = ensureTimelineState(previousState), api = timelineApi();
    const layer = currentLayer(), originChatId = data()?.getChatId?.() || 'default';
    const snapshot = {
      personal_memory: clone(nextState.personal_memory || []),
      knowledge_index: clone(nextState.knowledge_index || {}),
      entity_memory: clone(nextState.entity_memory || {}),
      entity_index: clone(nextState.entity_index || {}),
      npc_profiles: clone(nextState.npc_profiles || []),
      round: Math.max(0, Number(nextState.round) || 0),
      chatLayer: nextState.chatLayer ?? layer
    };
    const hash = api?.hashText?.(memoryView(nextState)) || String(Date.now());
    timeline.nodes.push({
      id: nextTimelineNodeId(timeline),
      kind: 'manual_snapshot',
      originChatId,
      startLayer: layer,
      endLayer: layer,
      sourceRefs: [{ chatId: originChatId, messageId: `manual:${Date.now()}`, layer, role: 'synthetic', swipeId: 0, hash, synthetic: true }],
      sourceDigest: hash,
      personal: [],
      entities: {},
      snapshot,
      status: 'valid',
      revision: 1,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    nextState.timeline = clone(timeline);
    return nextState;
  }

  // 自动纪要只处理进入当前聊天之后新增的对话。首次见到一个聊天时仅落下
  // 当前楼层基线，不调用 API；从头整理历史记录只允许由批量重填显式触发。
  function initializeSummaryBaseline() {
    const memoryData = data();
    if (!memoryData) return null;
    const state = memoryData.loadState();
    const eventMemory = ensureEventState(state);
    const storedLayer = Number(eventMemory.small_summary_layer);
    // 聊天未就绪（0 条消息）时不落基线：写入 -1 会让后续判断永远视为已初始化。
    const chatLength = chat().length;
    if (chatLength <= 0) return state;
    if (Number.isFinite(storedLayer) && storedLayer >= 0) return state;
    eventMemory.small_summary_layer = chatLength - 1;
    return memoryData.saveState(state);
  }

  function nextSmallSummaryId(eventMemory) {
    const max = (eventMemory.small_summaries || []).reduce((number, item) => {
      const match = /^small_(\d+)$/.exec(clean(item?.id));
      return Math.max(number, match ? Number(match[1]) : 0);
    }, 0);
    return `small_${String(max + 1).padStart(6, '0')}`;
  }

  function nextBigSummaryId(eventMemory) {
    const max = (eventMemory.big_summaries || []).reduce((number, item) => {
      const match = /^big_(\d+)$/.exec(clean(item?.id));
      return Math.max(number, match ? Number(match[1]) : 0);
    }, 0);
    return `big_${String(max + 1).padStart(6, '0')}`;
  }

  async function requestTasks(tasks, options) {
    const st = settings(), state = options?.baseState ? clone(options.baseState) : data().loadState();
    const rawPrompt = await buildRequestPrompt(tasks, state, st);
    // 与 callApi 出口同一展开：{{user}}、<user> → 酒馆设定的 user 名称。
    // 此处展开让调试镜像（lastDebug.prompt）与实际发出的请求字节级一致。
    const renderUserName = window.WORLD_ENGINE_CORE?.renderUserName;
    const prompt = typeof renderUserName === 'function' ? (renderUserName(rawPrompt) || rawPrompt) : rawPrompt;
    lastDebug = { prompt, requestPrompt: prompt, rawResult: '', apiResponse: '', parsed: null, error: '' };
    const retries = Math.max(0, Number(options?.retries ?? st.apiAutoRetries) || 0);
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const raw = await window.WORLD_ENGINE_API.callApi(
          prompt, st.maxTokens, st.temperature, abortController?.signal, st
        );
        lastDebug.rawResult = lastDebug.apiResponse = raw;
        const parsed = parseResponse(raw, tasks);
        lastDebug.parsed = clone(parsed);
        return parsed;
      } catch (error) {
        lastDebug.error = String(error?.message || error);
        if (abortController?.signal?.aborted || attempt >= retries) throw error;
      }
    }
    throw new Error('记忆 API 请求失败');
  }

  async function runTasks(tasks, options) {
    if (running && !options?.allowWhileBackfill) return { skipped: true, reason: 'running' };
    if (!tasks?.memory && !tasks?.small && !tasks?.big) return { skipped: true, reason: 'no_tasks' };
    if (tasks.small && tasks.big) throw new Error('总述必须在纪要落库后独立运行');
    running = true;
    runningLabel = tasks.memory && tasks.small ? '人物、实体与纪要'
      : (tasks.memory ? '人物与实体提取' : (tasks.small ? '纪要' : '总述'));
    const taskLabel = runningLabel;
    abortController = new AbortController();
    setExternalStatus(`正在进行${taskLabel}…`);
    // 顶部状态机会先清理悬浮球运行类，因此最后再按当前引擎面刷新动画状态。
    window.WORLD_ENGINE_UI?.setMemoryEvolvingUI?.(true, runningLabel);
    try {
      const before = options?.baseState ? clone(options.baseState) : data().loadState();
      const extracted = await requestTasks(tasks, { ...options, baseState: before });
      if (options?.saveCheckpoint !== false) data().saveCheckpoint(before);
      const next = clone(before);
      const memorySourceDigest = tasks.memory && Array.isArray(tasks.memory.sourceRefs) && tasks.memory.sourceRefs.length
        ? timelineApi()?.digestRefs?.(tasks.memory.sourceRefs) || '' : '';
      const memoryAlreadyStored = memorySourceDigest && ensureTimelineState(next).nodes.some(node =>
        node.kind === 'memory' && node.status === 'valid' && clean(node.sourceDigest) === memorySourceDigest
      );
      const applyMemory = Boolean(tasks.memory && !memoryAlreadyStored);
      const addedPersonal = applyMemory ? mergeMemories(next, extracted.personal) : 0;
      const entityChanges = applyMemory
        ? mergeEntityMemories(next, extracted.entities)
        : { entities: 0, history: 0, descriptions: 0 };
      const npcChanges = applyMemory ? mergeNpcProfiles(next, extracted.npcs) : 0;
      if (applyMemory) appendTimelineNode(next, extracted, tasks.memory, options);
      const eventMemory = ensureEventState(next);
      let addedSmall = 0, updatedBig = 0;
      if (tasks.small && extracted.smallSummary) {
        const sourceRefs = clone(tasks.small.sourceRefs || timelineApi()?.captureRange?.(tasks.small.startLayer, tasks.small.endLayer) || []);
        const sourceDigest = timelineApi()?.digestRefs?.(sourceRefs) || '';
        const existingSummary = sourceDigest ? eventMemory.small_summaries.find(item =>
          item.status !== 'stale' && clean(item.sourceDigest) === sourceDigest
        ) : null;
        if (!existingSummary) {
          eventMemory.small_summaries.push({
            id: nextSmallSummaryId(eventMemory),
            startLayer: Number(tasks.small.startLayer) || 0,
            endLayer: Number(tasks.small.endLayer) || 0,
            content: extracted.smallSummary,
            ...resolveSummaryTimes(extracted.smallTimeStart, extracted.smallTimeEnd, tasks.small.conversation),
            sourceRefs,
            sourceDigest,
            originChatId: data()?.getChatId?.() || 'default',
            status: 'valid',
            revision: 1
          });
          addedSmall = 1;
        }
        eventMemory.small_summary_layer = Number(tasks.small.endLayer) || 0;
      }
      if (options?.worldDigestMinute?.content) {
        const linked = options.worldDigestMinute;
        eventMemory.small_summaries.push({
          id: nextSmallSummaryId(eventMemory),
          startLayer: Number(linked.layer) || 0,
          endLayer: Number(linked.layer) || 0,
          content: Array.from(clean(linked.content)).slice(0, 200).join(''),
          source: 'world_engine',
          sourceKey: clean(linked.sourceKey),
          status: 'valid',
          revision: 1
        });
        addedSmall += 1;
      }
      if (tasks.big && extracted.bigSummary) {
        const isMeta = Number(tasks.big.level) >= 2;
        eventMemory.big_summaries.push({
          id: nextBigSummaryId(eventMemory),
          startLayer: Number(tasks.big.startLayer) || 0,
          endLayer: Number(tasks.big.endLayer) || 0,
          content: extracted.bigSummary,
          ...resolveSummaryTimes(extracted.bigTimeStart, extracted.bigTimeEnd, '', tasks.big.summaries),
          level: Math.max(1, Number(tasks.big.level) || 1),
          childIds: clone(tasks.big.childIds || []),
          childDigest: clean(tasks.big.childDigest),
          sourceRefs: clone(tasks.big.sourceRefs || []),
          originChatId: data()?.getChatId?.() || 'default',
          status: 'valid',
          revision: 1
        });
        // 游标只记录纪要消费进度；更早总述不消耗纪要，不推进游标。
        if (!isMeta) {
          eventMemory.big_summary_cursor = Math.min(
            eventMemory.small_summaries.length,
            eventMemory.big_summary_cursor + Math.max(1, Number(tasks.big.consumeCount) || 1)
          );
        }
        updatedBig = 1;
      }
      const added = addedPersonal + entityChanges.entities + entityChanges.history + entityChanges.descriptions;
      if (tasks.memory) {
        if (applyMemory) next.round = Math.max(0, Number(next.round) || 0) + 1;
        next.chatLayer = Number.isFinite(Number(options?.layer)) ? Number(options.layer) : currentLayer();
      }
      data().saveState(next);
      if (addedSmall) window.MEMORY_ENGINE_VECTOR?.scheduleIndexUpdate?.();
      window.WORLD_ENGINE_CHATCACHE?.forScope?.('memory')?.afterEvolution?.();
      applyInjection();
      refreshMemoryPanel();
      setExternalStatus(`${taskLabel}完成`);
      return {
        added: added + addedSmall + updatedBig,
        extracted: extracted.personal.length + ENTITY_TYPES.reduce((sum, type) => sum + extracted.entities[type].length, 0),
        addedPersonal,
        entityChanges,
        addedSmall,
        updatedBig,
        state: next
      };
    } catch (error) {
      const stopped = abortController?.signal?.aborted || error?.name === 'AbortError';
      setExternalStatus(stopped ? `${taskLabel}已停止` : `${taskLabel}失败：${error?.message || error}`, !stopped);
      throw error;
    } finally {
      running = false;
      runningLabel = '';
      abortController = null;
      window.WORLD_ENGINE_UI?.setMemoryEvolvingUI?.(false, '');
    }
  }

  async function extractConversation(conversation, options) {
    return runTasks({ memory: {
      conversation,
      sourceRefs: clone(options?.sourceRefs || []),
      startLayer: options?.startLayer,
      endLayer: options?.endLayer,
      sourceKey: options?.sourceKey
    } }, options);
  }

  function countAiSince(layer, st) {
    const anchor = layer !== null && layer !== '' && Number.isFinite(Number(layer)) ? Number(layer) : -1;
    const all = chat(), skipOpening = anchor < 0 && ignoreFirstLayer(st || settings());
    return all.reduce((count, message, index) => count + (
      index > anchor && !(skipOpening && index === 0) && message && !message.is_user ? 1 : 0
    ), 0);
  }

  function getAiBatchAfter(layer, maxAi, endLayer, settingsOverride) {
    const all = chat();
    const anchor = layer !== null && layer !== '' && Number.isFinite(Number(layer)) ? Number(layer) : -1;
    const skipOpening = anchor < 0 && ignoreFirstLayer(settingsOverride || settings());
    const end = endLayer !== undefined && Number.isFinite(Number(endLayer)) ? Number(endLayer) : all.length - 1;
    const aiLayers = all.map((message, index) => (index > anchor && index <= end && !(skipOpening && index === 0) && message && !message.is_user ? index : -1))
      .filter(index => index >= 0).slice(0, Math.max(1, parseInt(maxAi) || 1));
    if (!aiLayers.length) return null;
    const firstAi = aiLayers[0], finish = aiLayers.at(-1);
    const start = firstAi > 0 && all[firstAi - 1]?.is_user ? firstAi - 1 : firstAi;
    return {
      startLayer: start,
      endLayer: finish,
      aiCount: aiLayers.length,
      conversation: formatMessages(all.slice(start, finish + 1), start),
      sourceRefs: timelineApi()?.captureRange?.(start, finish) || []
    };
  }

  function buildBigTask(state, force, thresholdOverride) {
    const st = settings(), eventMemory = ensureEventState(state);
    const allPending = eventMemory.small_summaries.slice(eventMemory.big_summary_cursor);
    const threshold = Math.max(1, parseInt(thresholdOverride ?? st.bigSummaryEveryX) || 5);
    if (!force && allPending.length < threshold) return null;
    if (force && !allPending.length) return null;
    const pending = force ? allPending : allPending.slice(0, threshold);
    const childIds = pending.map(item => item.id);
    const sourceRefs = timelineApi()?.unionRefs?.(pending.map(item => item.sourceRefs || [])) || [];
    return {
      summaries: pending,
      consumeCount: pending.length,
      startLayer: Number(pending[0]?.startLayer) || 0,
      endLayer: Number(pending.at(-1)?.endLayer) || 0,
      childIds,
      childDigest: timelineApi()?.hashText?.(pending.map(item => `${item.id}:${item.revision || 1}:${item.sourceDigest || ''}`).join('|')) || '',
      sourceRefs
    };
  }

  // 未归档总述积压超限后，把保留窗口之外的最旧几条合并成更高一层总述
  // （level 2 = 更早总述，childIds 指向总述；level 3 = 最早总述，childIds 指向更早总述）。
  // 注入侧以「最早总述 + 更早总述 + 最近几条总述」分层呈现，避免老剧情滚出注入窗口后断档。
  function buildCompressionTask(state, force, level = 2) {
    const st = settings(), eventMemory = ensureEventState(state);
    const keepRecent = Math.max(1, parseInt(st.bigSummaryInjectLimit) || 3);
    // 子层级 = 本层级 - 1；被任何有效更高层引用的子层级条目视为已吸收。
    const childLevel = level - 1;
    const absorbedIds = new Set(eventMemory.big_summaries
      .filter(item => item.status === 'valid' && Number(item.level) >= level)
      .flatMap(item => item.childIds || []));
    const pending = eventMemory.big_summaries.filter(item =>
      item.status === 'valid' && Number(item.level) === childLevel && !absorbedIds.has(clean(item.id)));
    const threshold = Math.max(keepRecent + 1, Math.max(2, parseInt(st.metaSummaryEveryX) || 6));
    if (pending.length < threshold && !(force && pending.length > keepRecent)) return null;
    const children = pending.slice(0, Math.max(1, pending.length - keepRecent));
    return {
      level,
      summaries: children,
      startLayer: Number(children[0]?.startLayer) || 0,
      endLayer: Number(children.at(-1)?.endLayer) || 0,
      childIds: children.map(item => item.id),
      childDigest: timelineApi()?.hashText?.(children.map(item => `${item.id}:${item.revision || 1}:${item.sourceDigest || ''}`).join('|')) || '',
      sourceRefs: timelineApi()?.unionRefs?.(children.map(item => item.sourceRefs || [])) || []
    };
  }

  // 从低层到高层找第一个到期的压缩任务。
  function findDueCompressionTask(state, force) {
    for (let level = 2; level <= MAX_SUMMARY_LEVEL; level++) {
      const task = buildCompressionTask(state, force, level);
      if (task) return task;
    }
    return null;
  }

  async function runTasksThenDueBig(tasks, options, bigThresholdOverride) {
    const primary = await runTasks(tasks, options);
    if (primary?.skipped) return primary;
    let result = primary;
    const after = data().loadState();
    const bigTask = buildBigTask(after, false, bigThresholdOverride);
    if (bigTask) {
      const bigResult = await runTasks({ big: bigTask }, {
        ...options,
        baseState: after,
        saveCheckpoint: false,
        // 世界摘要纪要只在 primary 落库一次；这里仅消费待整理纪要生成总述。
        worldDigestMinute: null
      });
      result = {
        ...primary,
        added: Number(primary.added || 0) + Number(bigResult?.updatedBig || 0),
        updatedBig: Number(primary.updatedBig || 0) + Number(bigResult?.updatedBig || 0),
        state: bigResult?.state || primary.state
      };
    }
    // 总述落库后逐层检查更高层压缩是否到期（level 2→3），到期层独立请求合并。
    let metaState = data().loadState();
    for (let level = 2; level <= MAX_SUMMARY_LEVEL; level++) {
      const metaTask = buildCompressionTask(metaState, false, level);
      if (!metaTask) continue;
      const metaResult = await runTasks({ big: metaTask }, {
        ...options, baseState: metaState, saveCheckpoint: false, worldDigestMinute: null
      });
      result = {
        ...result,
        updatedBig: Number(result.updatedBig || 0) + Number(metaResult?.updatedBig || 0),
        state: metaResult?.state || result.state
      };
      metaState = data().loadState();
    }
    return result;
  }

  // 手动向前提取与重新推演共用：读取轮数 = min(配置上限, 基底状态至今的实际 AI 轮数)。
  function getElapsedReadRounds(baseState, maxRounds) {
    const limit = Math.max(1, parseInt(maxRounds) || 1);
    const anchor = baseState?.chatLayer !== null && baseState?.chatLayer !== '' && Number.isFinite(Number(baseState?.chatLayer))
      ? Number(baseState.chatLayer) : -1;
    return Math.max(1, Math.min(countAiSince(anchor), limit));
  }

  async function autoExtract() {
    const st = settings();
    if (st.engineEnabled === false || running || backfillRunning || reconciling) return;
    // 历史正文修复必须等本轮 AI 回复完成后才请求 API；手动提取模式也照常修复历史。
    await reconcileHistory();
    if (st.evolveMode !== 'auto') return;
    const state = data().loadState();
    // 提取目标是最老的缺口轮而不是最新一轮：某轮失败后，后续事件会从缺口继续补齐，
    // 不会让中间楼层永久漏出记忆链。人物/实体与纪要同轮配对，与手动提取同一口径。
    const batch = findOldestMissingBatch(state);
    const bigTask = buildBigTask(state, false);
    const metaTask = findDueCompressionTask(state, false);
    if (!batch) {
      if (!bigTask && !metaTask) return;
      const result = await runTasks({ big: bigTask || metaTask }, { baseState: state });
      const latest = data().loadState();
      if (buildBigTask(latest, false) || findDueCompressionTask(latest, false)) {
        clearTimeout(autoTimer);
        autoTimer = setTimeout(() => autoExtract().catch(error => console.error('[记忆引擎] 自动总述补进度失败', error)), 0);
      }
      return result;
    }
    const result = await runTasksThenDueBig({ memory: batch, small: batch }, { layer: batch.endLayer, baseState: state });
    const after = data().loadState();
    if (findOldestMissingBatch(after) || buildBigTask(after, false) || findDueCompressionTask(after, false)) {
      clearTimeout(autoTimer);
      autoTimer = setTimeout(() => autoExtract().catch(error => console.error('[记忆引擎] 自动纪要补进度失败', error)), 0);
    }
    return result;
  }

  // 人物/实体节点与纪要任一缺失即视为待提取（世界联动节点不计入覆盖，与手动提取口径一致）。
  function isMemoryBatchCovered(batch, timeline, eventMemory) {
    const digest = timelineApi()?.digestRefs?.(batch.sourceRefs || []) || '';
    if (!digest) return false;
    const hasNode = timeline.nodes.some(node =>
      node.kind === 'memory' && node.status === 'valid' && clean(node.sourceDigest) === digest
    );
    const hasSummary = eventMemory.small_summaries.some(summary =>
      summary.status !== 'stale' && clean(summary.sourceDigest) === digest
    );
    return hasNode && hasSummary;
  }

  // 从最老的缺口轮开始扫描。
  function findOldestMissingBatch(state) {
    const timeline = ensureTimelineState(state), eventMemory = ensureEventState(state);
    // 「首楼为 AI 开场白」关闭后第 0 层按普通对话参与提取；它排在已处理游标之前，
    // 常规的前向扫描永远够不到，这里单独核对其覆盖情况，没提取过就作为缺口返回。
    if (!ignoreFirstLayer(settings())) {
      const openingBatch = getAiBatchAfter(-1, 1);
      if (openingBatch && !isMemoryBatchCovered(openingBatch, timeline, eventMemory)) return openingBatch;
    }
    const memoryLayer = state.chatLayer !== null && state.chatLayer !== '' && Number.isFinite(Number(state.chatLayer))
      ? Number(state.chatLayer) : null;
    const summaryLayer = eventMemory.small_summary_layer !== null && eventMemory.small_summary_layer !== ''
      && Number.isFinite(Number(eventMemory.small_summary_layer)) ? Number(eventMemory.small_summary_layer) : null;
    const hasTrackedSummaries = eventMemory.small_summaries.some(summary =>
      Array.isArray(summary.sourceRefs) && summary.sourceRefs.length
    );
    // 新聊天首次建立纪要基线时，人物游标尚为空；此时沿用纪要基线，避免误把整段旧聊天当成待处理。
    // 若已经存在带正文来源的纪要，则从头寻找尚缺人物实体的最早一轮，补齐两条链。
    let anchor = memoryLayer === null ? (hasTrackedSummaries ? -1 : (summaryLayer ?? -1))
      : (summaryLayer === null ? memoryLayer : Math.min(memoryLayer, summaryLayer));
    while (true) {
      const candidate = getAiBatchAfter(anchor, 1);
      if (!candidate) return null;
      if (isMemoryBatchCovered(candidate, timeline, eventMemory)) {
        anchor = candidate.endLayer;
        continue;
      }
      return candidate;
    }
  }

  async function manualExtract() {
    const st = settings();
    if (st.engineEnabled === false) throw new Error('记忆引擎已关闭');
    const state = data().loadState();
    const batch = findOldestMissingBatch(state);
    if (!batch) throw new Error('当前没有尚未提取的新一轮正文');
    return runTasksThenDueBig({ memory: batch, small: batch }, {
      ...batch, layer: batch.endLayer, baseState: state
    });
  }

  async function manualReextract() {
    const st = settings();
    if (st.engineEnabled === false) throw new Error('记忆引擎已关闭');
    if (running || backfillRunning || reconciling) throw new Error('已有记忆任务正在运行');
    const current = data().loadState();
    const timeline = ensureTimelineState(current);
    const latestNode = timeline.nodes.slice().reverse().find(node => node.kind === 'memory' && node.status === 'valid');
    if (latestNode) {
      const eventMemory = ensureEventState(current);
      const sourceDigest = clean(latestNode.sourceDigest)
        || timelineApi()?.digestRefs?.(latestNode.sourceRefs || []) || '';
      const pairedSummary = sourceDigest ? eventMemory.small_summaries.find(summary => {
        const digest = clean(summary.sourceDigest)
          || timelineApi()?.digestRefs?.(summary.sourceRefs || []) || '';
        return summary.status === 'valid' && digest === sourceDigest;
      }) : null;
      const taskLabel = '人物、实体与纪要重新推演';
      running = true;
      runningLabel = taskLabel;
      abortController = new AbortController();
      setExternalStatus(`正在进行${taskLabel}…`);
      window.WORLD_ENGINE_UI?.setMemoryEvolvingUI?.(true, runningLabel);
      let repaired;
      try {
        latestNode.status = 'stale';
        if (pairedSummary) pairedSummary.status = 'stale';
        data().saveState(current);
        repaired = await repairMemoryAndSmall(latestNode.id, pairedSummary?.id);
        if (!repaired) throw new Error('最新一轮人物、实体与纪要未能重新提取');
        setExternalStatus(`${taskLabel}完成`);
      } catch (error) {
        // 请求失败或用户停止时恢复旧节点，不能把一次未完成的重新推演留成 stale。
        const rollback = data().loadState();
        const rollbackNode = ensureTimelineState(rollback).nodes.find(node => node.id === latestNode.id);
        const rollbackSummary = pairedSummary
          ? ensureEventState(rollback).small_summaries.find(summary => summary.id === pairedSummary.id)
          : null;
        if (rollbackNode?.status === 'stale') rollbackNode.status = 'valid';
        if (rollbackSummary?.status === 'stale') rollbackSummary.status = 'valid';
        data().saveState(rollback);
        applyInjection();
        const stopped = abortController?.signal?.aborted || error?.name === 'AbortError';
        setExternalStatus(stopped ? `${taskLabel}已停止` : `${taskLabel}失败：${error?.message || error}`, !stopped);
        throw error;
      } finally {
        running = false;
        runningLabel = '';
        abortController = null;
        window.WORLD_ENGINE_UI?.setMemoryEvolvingUI?.(false, '');
      }

      // 与原动作一致：重做受本轮纪要影响的既有总述，并在仍满足阈值时继续生成总述。
      const reconciliation = await reconcileHistory();
      const afterReconcile = data().loadState();
      const dueBigTask = buildBigTask(afterReconcile, false);
      const bigResult = dueBigTask
        ? await runTasks({ big: dueBigTask }, { baseState: afterReconcile, saveCheckpoint: false })
        : null;
      const updated = Math.max(1, Number(repaired?.updated || 0));
      return {
        added: updated + Number(reconciliation?.repairedCount || 0) + Number(bigResult?.updatedBig || 0),
        extracted: Number(repaired?.extracted || 0),
        updatedBig: Number(reconciliation?.updatedBig || 0) + Number(bigResult?.updatedBig || 0),
        replacedNodeId: latestNode.id,
        replacedSummaryId: pairedSummary?.id || null,
        state: bigResult?.state || data().loadState()
      };
    }
    // 旧数据尚未产生时间链节点时，保留一次兼容回退；新节点产生后不再依赖 checkpoint。
    const checkpoint = data().loadCheckpoint();
    if (!checkpoint) throw new Error('没有可用于重新推演的记忆存档点');
    const readRounds = getElapsedReadRounds(checkpoint, st.manualReadRounds);
    const batch = recentConversationBatch(readRounds);
    return runTasksThenDueBig({ memory: batch, small: batch }, {
      ...batch, layer: currentLayer(), baseState: checkpoint
    });
  }

  async function manualSmallSummary() {
    const st = settings();
    if (st.engineEnabled === false) throw new Error('记忆引擎已关闭');
    const state = data().loadState(), eventMemory = ensureEventState(state);
    const batch = getAiBatchAfter(eventMemory.small_summary_layer, Math.max(1, parseInt(st.smallSummaryEveryX) || 5));
    if (!batch) throw new Error('当前状态之后没有可总结的新对话');
    return runTasksThenDueBig({ small: batch }, { baseState: state });
  }

  async function manualBigSummary() {
    const st = settings();
    if (st.engineEnabled === false) throw new Error('记忆引擎已关闭');
    const state = data().loadState();
    const bigTask = buildBigTask(state, true);
    const metaTask = findDueCompressionTask(state, true);
    if (!bigTask && !metaTask) throw new Error('当前没有尚未并入总述的纪要');
    let result = null;
    if (bigTask) result = await runTasks({ big: bigTask }, { baseState: state });
    // 总述落库后顺带合并到期的更高层总述（逐层），让手动入口与自动链保持同一进度。
    let metaState = data().loadState();
    for (let level = 2; level <= MAX_SUMMARY_LEVEL; level++) {
      const dueMeta = buildCompressionTask(metaState, true, level);
      if (!dueMeta) continue;
      const metaResult = await runTasks({ big: dueMeta }, { baseState: metaState });
      result = {
        ...(result || { added: 0, extracted: 0 }),
        updatedBig: Number(result?.updatedBig || 0) + Number(metaResult?.updatedBig || 0),
        state: metaResult.state
      };
      metaState = data().loadState();
    }
    return result;
  }

  function newHistoryAuditReport() {
    return { changedLayers: new Set(), deletedLayers: new Set() };
  }

  function collectHistoryAudit(report, audit) {
    if (!report || !audit) return;
    for (const item of audit.changed || []) {
      const layer = Number(item?.before?.layer ?? item?.after?.layer);
      if (Number.isFinite(layer)) report.changedLayers.add(layer);
    }
    for (const ref of audit.missing || []) {
      const layer = Number(ref?.layer);
      if (Number.isFinite(layer)) report.deletedLayers.add(layer);
    }
  }

  // 楼层数字会在删楼后整体前移。来源引用可以用稳定消息 ID 判断哪些旧楼
  // 消失了，但纪要进度仍是数字游标，必须同步减去游标之前被删的楼层数。
  // 否则新对话要先“追平”删除前的楼层号，期间不会再生成纪要。
  function rewindSummaryCursorForDeletedLayers(state, report) {
    const deleted = [...(report?.deletedLayers || [])].filter(Number.isFinite);
    if (!deleted.length) return false;
    const eventMemory = ensureEventState(state);
    if (eventMemory.small_summary_layer === null || eventMemory.small_summary_layer === ''
      || !Number.isFinite(Number(eventMemory.small_summary_layer))) return false;
    const anchor = Number(eventMemory.small_summary_layer);
    const removedBeforeCursor = deleted.filter(layer => layer <= anchor).length;
    if (!removedBeforeCursor) return false;
    eventMemory.small_summary_layer = Math.max(-1, anchor - removedBeforeCursor);
    return true;
  }

  function formatHistoryLayers(layers) {
    const values = [...(layers || [])].filter(Number.isFinite).sort((a, b) => a - b);
    return values.length ? `第 ${values.join('、')} 楼` : '';
  }

  function historyAuditMessage(report, phase, error) {
    const changed = formatHistoryLayers(report?.changedLayers);
    const deleted = formatHistoryLayers(report?.deletedLayers);
    const subjects = [changed ? `${changed}正文已修改` : '', deleted ? `${deleted}已删除` : ''].filter(Boolean);
    if (!subjects.length) {
      if (phase === 'failed') return `历史记忆修复失败：旧记忆已停止注入，本次使用原始正文。原因：${error?.message || error}`;
      return phase === 'success' ? '历史记忆对账完成' : '正在核对历史楼层与记忆链…';
    }
    const subject = subjects.join('；');
    if (phase === 'detected') return `检测到${subject}，正在重建相关记忆、纪要与总述…`;
    if (phase === 'success') return `${subject}：相关记忆、纪要与总述已更新，本次注入采用新正文。`;
    return `${subject}：历史记忆修复失败，旧记忆已停止注入，本次使用原始正文。原因：${error?.message || error}`;
  }

  function auditStoredSources(state, report) {
    const api = timelineApi(), timeline = ensureTimelineState(state), eventMemory = ensureEventState(state);
    let changed = false;
    const refreshValidRefs = (record, audit) => {
      if (!audit?.valid || audit.inherited || audit.synthetic || !Array.isArray(audit.refs)) return;
      const oldLayers = (record.sourceRefs || []).map(ref => Number(ref.layer)).join(',');
      const newLayers = audit.refs.map(ref => Number(ref.layer)).join(',');
      if (oldLayers === newLayers) return;
      record.sourceRefs = clone(audit.refs);
      const bounds = sourceBounds(audit.refs, record.endLayer);
      record.startLayer = bounds.startLayer;
      record.endLayer = bounds.endLayer;
      changed = true;
    };
    for (const node of timeline.nodes) {
      if (!Array.isArray(node.sourceRefs) || !node.sourceRefs.length) continue;
      const audit = api?.auditRefs?.(node.sourceRefs);
      collectHistoryAudit(report, audit);
      refreshValidRefs(node, audit);
      const nextStatus = audit?.valid ? 'valid' : 'stale';
      if (node.status !== nextStatus) { node.status = nextStatus; changed = true; }
    }
    for (const summary of eventMemory.small_summaries) {
      if (!Array.isArray(summary.sourceRefs) || !summary.sourceRefs.length) continue; // 旧版手工/迁移纪要保持封存。
      const audit = api?.auditRefs?.(summary.sourceRefs);
      collectHistoryAudit(report, audit);
      refreshValidRefs(summary, audit);
      const nextStatus = audit?.valid ? 'valid' : 'stale';
      if (summary.status !== nextStatus) { summary.status = nextStatus; changed = true; }
    }
    for (const overview of eventMemory.big_summaries) {
      if (!Array.isArray(overview.childIds) || !overview.childIds.length) continue;
      // 更早层总述（level ≥ 2）的子节点是总述；普通总述的子节点是纪要。校验公式一致。
      const pool = Number(overview.level) >= 2 ? eventMemory.big_summaries : eventMemory.small_summaries;
      const children = overview.childIds.map(id => pool.find(item => item.id === id)).filter(Boolean);
      const digest = api?.hashText?.(children.map(item => `${item.id}:${item.revision || 1}:${item.sourceDigest || ''}`).join('|')) || '';
      const valid = children.length === overview.childIds.length
        && children.every(item => item.status === 'valid')
        && digest === clean(overview.childDigest);
      const nextStatus = valid ? 'valid' : 'stale';
      if (overview.status !== nextStatus) { overview.status = nextStatus; changed = true; }
    }
    return changed;
  }

  async function repairMemoryNode(nodeId) {
    let state = data().loadState(), timeline = ensureTimelineState(state);
    let node = timeline.nodes.find(item => item.id === nodeId);
    if (!node || node.status !== 'stale') return false;
    const api = timelineApi(), audit = api?.auditRefs?.(node.sourceRefs);
    if (!audit?.refs?.length) {
      timeline.nodes = timeline.nodes.filter(item => item.id !== nodeId);
      data().saveState(replayTimeline(state));
      return true;
    }
    const base = replayTimeline(state, nodeId);
    const conversation = api?.refsToConversation?.(node.sourceRefs) || '';
    if (!conversation) return false;
    const repairBounds = sourceBounds(audit.refs, node.endLayer);
    const extracted = await requestTasks({ memory: {
      conversation,
      startLayer: repairBounds.startLayer,
      endLayer: repairBounds.endLayer
    } }, { baseState: base });

    state = data().loadState();
    timeline = ensureTimelineState(state);
    node = timeline.nodes.find(item => item.id === nodeId);
    if (!node) return false;
    const bounds = sourceBounds(audit.refs, node.endLayer);
    node.sourceRefs = clone(audit.refs);
    node.sourceDigest = api?.digestRefs?.(audit.refs) || '';
    node.startLayer = bounds.startLayer;
    node.endLayer = bounds.endLayer;
    node.personal = clone(extracted.personal || []);
    node.entities = clone(extracted.entities || {});
    node.npcs = clone(extracted.npcs || []);
    node.status = 'valid';
    node.revision = Math.max(1, Number(node.revision) || 1) + 1;
    node.updatedAt = Date.now();
    data().saveState(replayTimeline(state));
    refreshMemoryPanel();
    return true;
  }

  // 日常提取固定为一轮后，同轮人物/实体节点与纪要拥有相同来源。
  // 历史变化时也联合请求，保持新增与修复使用同一个最小事务单元。
  async function repairMemoryAndSmall(nodeId, summaryId) {
    let state = data().loadState(), timeline = ensureTimelineState(state), eventMemory = ensureEventState(state);
    let node = timeline.nodes.find(item => item.id === nodeId);
    let summary = summaryId ? eventMemory.small_summaries.find(item => item.id === summaryId) : null;
    if (!node || node.status !== 'stale' || (summaryId && (!summary || summary.status !== 'stale'))) return false;

    const api = timelineApi();
    const nodeAudit = api?.auditRefs?.(node.sourceRefs);
    const summaryAudit = summary ? api?.auditRefs?.(summary.sourceRefs) : nodeAudit;
    if (!nodeAudit?.refs?.length || !summaryAudit?.refs?.length) return false;
    const nodeDigest = api?.digestRefs?.(nodeAudit.refs) || '';
    const summaryDigest = api?.digestRefs?.(summaryAudit.refs) || '';
    if (!nodeDigest || nodeDigest !== summaryDigest) return false;

    const conversation = api?.refsToConversation?.(node.sourceRefs) || '';
    if (!conversation) return false;
    const bounds = sourceBounds(nodeAudit.refs, node.endLayer);
    const base = replayTimeline(state, nodeId);
    const extracted = await requestTasks({
      memory: {
        startLayer: bounds.startLayer,
        endLayer: bounds.endLayer,
        conversation
      },
      small: {
        startLayer: bounds.startLayer,
        endLayer: bounds.endLayer,
        conversation
      }
    }, { baseState: base });
    if (!clean(extracted.smallSummary)) {
      throw new Error('API 未返回纪要，已保留重新推演前的记录');
    }

    state = data().loadState();
    timeline = ensureTimelineState(state);
    eventMemory = ensureEventState(state);
    node = timeline.nodes.find(item => item.id === nodeId);
    summary = summaryId ? eventMemory.small_summaries.find(item => item.id === summaryId) : null;
    if (!node || (summaryId && !summary)) return false;

    node.sourceRefs = clone(nodeAudit.refs);
    node.sourceDigest = nodeDigest;
    node.startLayer = bounds.startLayer;
    node.endLayer = bounds.endLayer;
    node.personal = clone(extracted.personal || []);
    node.entities = clone(extracted.entities || {});
    node.npcs = clone(extracted.npcs || []);
    node.status = 'valid';
    node.revision = Math.max(1, Number(node.revision) || 1) + 1;
    node.updatedAt = Date.now();

    const times = resolveSummaryTimes(extracted.smallTimeStart, extracted.smallTimeEnd, conversation);
    if (!summary) {
      summary = {
        id: nextSmallSummaryId(eventMemory),
        startLayer: bounds.startLayer,
        endLayer: bounds.endLayer,
        sourceRefs: clone(summaryAudit.refs),
        sourceDigest: summaryDigest,
        content: extracted.smallSummary,
        ...times,
        originChatId: data()?.getChatId?.() || 'default',
        status: 'valid',
        revision: 1
      };
      eventMemory.small_summaries.push(summary);
      eventMemory.small_summary_layer = Math.max(Number(eventMemory.small_summary_layer) || 0, bounds.endLayer);
    } else {
      summary.startLayer = bounds.startLayer;
      summary.endLayer = bounds.endLayer;
      summary.sourceRefs = clone(summaryAudit.refs);
      summary.sourceDigest = summaryDigest;
      summary.content = extracted.smallSummary;
      summary.timeStart = times.timeStart;
      summary.timeEnd = times.timeEnd;
      summary.status = 'valid';
      summary.revision = Math.max(1, Number(summary.revision) || 1) + 1;
    }
    data().saveState(replayTimeline(state));
    window.MEMORY_ENGINE_VECTOR?.scheduleIndexUpdate?.();
    refreshMemoryPanel();
    const extractedCount = (extracted.personal || []).length
      + ENTITY_TYPES.reduce((sum, type) => sum + (extracted.entities?.[type] || []).length, 0);
    return { repaired: true, extracted: extractedCount, updated: extractedCount + 1 };
  }

  async function repairSmallSummary(summaryId) {
    let state = data().loadState(), eventMemory = ensureEventState(state);
    let summary = eventMemory.small_summaries.find(item => item.id === summaryId);
    if (!summary || summary.status !== 'stale') return false;
    const api = timelineApi(), audit = api?.auditRefs?.(summary.sourceRefs);
    if (!audit?.refs?.length) {
      const index = eventMemory.small_summaries.findIndex(item => item.id === summaryId);
      if (index >= 0) {
        eventMemory.small_summaries.splice(index, 1);
        if (index < eventMemory.big_summary_cursor) eventMemory.big_summary_cursor--;
      }
      data().saveState(state);
      return true;
    }
    const conversation = api?.refsToConversation?.(summary.sourceRefs) || '';
    if (!conversation) return false;
    const bounds = sourceBounds(audit.refs, summary.endLayer);
    const extracted = await requestTasks({ small: {
      startLayer: bounds.startLayer,
      endLayer: bounds.endLayer,
      conversation
    } }, { baseState: state });

    state = data().loadState();
    eventMemory = ensureEventState(state);
    summary = eventMemory.small_summaries.find(item => item.id === summaryId);
    if (!summary) return false;
    summary.startLayer = bounds.startLayer;
    summary.endLayer = bounds.endLayer;
    summary.sourceRefs = clone(audit.refs);
    summary.sourceDigest = api?.digestRefs?.(audit.refs) || '';
    summary.content = extracted.smallSummary;
    const repairedTimes = resolveSummaryTimes(extracted.smallTimeStart, extracted.smallTimeEnd, conversation);
    summary.timeStart = repairedTimes.timeStart;
    summary.timeEnd = repairedTimes.timeEnd;
    summary.status = 'valid';
    summary.revision = Math.max(1, Number(summary.revision) || 1) + 1;
    data().saveState(state);
    window.MEMORY_ENGINE_VECTOR?.scheduleIndexUpdate?.();
    refreshMemoryPanel();
    return true;
  }

  async function repairBigSummary(overviewId) {
    let state = data().loadState(), eventMemory = ensureEventState(state);
    let overview = eventMemory.big_summaries.find(item => item.id === overviewId);
    if (!overview || overview.status !== 'stale') return false;
    // 更早层总述（level ≥ 2）从总述池取子节点，普通总述从纪要池取；重提取请求保持对应层级。
    const isMeta = Number(overview.level) >= 2;
    const pool = isMeta ? eventMemory.big_summaries : eventMemory.small_summaries;
    const children = (overview.childIds || []).map(id => pool.find(item => item.id === id)).filter(Boolean);
    if (!children.length) {
      eventMemory.big_summaries = eventMemory.big_summaries.filter(item => item.id !== overviewId);
      data().saveState(state);
      return true;
    }
    if (children.some(item => item.status !== 'valid')) return false;
    const api = timelineApi();
    const extracted = await requestTasks({ big: { summaries: children, level: isMeta ? 2 : 1 } }, { baseState: state });

    state = data().loadState();
    eventMemory = ensureEventState(state);
    overview = eventMemory.big_summaries.find(item => item.id === overviewId);
    if (!overview) return false;
    overview.content = extracted.bigSummary;
    const overviewTimes = resolveSummaryTimes(extracted.bigTimeStart, extracted.bigTimeEnd, '', children);
    overview.timeStart = overviewTimes.timeStart;
    overview.timeEnd = overviewTimes.timeEnd;
    overview.childIds = children.map(item => item.id);
    overview.startLayer = Number(children[0]?.startLayer) || 0;
    overview.endLayer = Number(children.at(-1)?.endLayer) || 0;
    overview.sourceRefs = api?.unionRefs?.(children.map(item => item.sourceRefs || [])) || [];
    overview.childDigest = api?.hashText?.(children.map(item => `${item.id}:${item.revision || 1}:${item.sourceDigest || ''}`).join('|')) || '';
    overview.status = 'valid';
    overview.revision = Math.max(1, Number(overview.revision) || 1) + 1;
    data().saveState(state);
    refreshMemoryPanel();
    return true;
  }

  async function reconcileHistory() {
    if (reconciling || running || backfillRunning || settings().engineEnabled === false) return { skipped: true };
    reconciling = true;
    let announced = false;
    let repairedCount = 0, updatedBig = 0;
    const auditReport = newHistoryAuditReport();
    try {
      let state = data().loadState();
      // 一旦来源失效，立即从 Root 重放并排除 stale 节点；即使后续 API
      // 修复失败，旧人物/实体贡献也不会继续进入注入。
      const sourcesChanged = auditStoredSources(state, auditReport);
      const summaryCursorChanged = rewindSummaryCursorForDeletedLayers(state, auditReport);
      if (sourcesChanged || summaryCursorChanged) {
        state = replayTimeline(state);
        data().saveState(state);
      }
      const timeline = ensureTimelineState(state), eventMemory = ensureEventState(state);
      const needsRepair = timeline.nodes.some(node => node.status === 'stale')
        || eventMemory.small_summaries.some(item => item.status === 'stale')
        || eventMemory.big_summaries.some(item => item.status === 'stale');
      if (!needsRepair) {
        applyInjection();
        return { repaired: false };
      }
      runningLabel = '历史记忆对账';
      abortController = new AbortController();
      setExternalStatus(historyAuditMessage(auditReport, 'detected'));
      window.WORLD_ENGINE_UI?.setMemoryEvolvingUI?.(true, runningLabel);
      announced = true;

      for (const node of ensureTimelineState(data().loadState()).nodes.slice()) {
        if (node.status !== 'stale') continue;
        const current = data().loadState();
        const currentEvent = ensureEventState(current);
        const nodeSourceDigest = clean(node.sourceDigest)
          || timelineApi()?.digestRefs?.(node.sourceRefs || []) || '';
        const pairedSummary = nodeSourceDigest ? currentEvent.small_summaries.find(summary => {
          if (summary.status !== 'stale') return false;
          const summaryDigest = clean(summary.sourceDigest)
            || timelineApi()?.digestRefs?.(summary.sourceRefs || []) || '';
          return summaryDigest === nodeSourceDigest;
        }) : null;
        const repairedTogether = pairedSummary
          ? await repairMemoryAndSmall(node.id, pairedSummary.id)
          : false;
        if (repairedTogether) repairedCount += Math.max(1, Number(repairedTogether.updated || 0));
        else if (await repairMemoryNode(node.id)) repairedCount += 1;
      }
      state = data().loadState();
      auditStoredSources(state);
      data().saveState(state);
      for (const summary of ensureEventState(data().loadState()).small_summaries.slice()) {
        if (summary.status === 'stale' && await repairSmallSummary(summary.id)) repairedCount += 1;
      }
      state = data().loadState();
      auditStoredSources(state);
      data().saveState(state);
      for (const overview of ensureEventState(data().loadState()).big_summaries.slice()) {
        if (overview.status === 'stale' && await repairBigSummary(overview.id)) {
          repairedCount += 1;
          updatedBig += 1;
        }
      }
      state = data().loadState();
      auditStoredSources(state);
      data().saveState(state);
      const finalTimeline = ensureTimelineState(state), finalEventMemory = ensureEventState(state);
      const unresolved = finalTimeline.nodes.some(node => node.status === 'stale')
        || finalEventMemory.small_summaries.some(item => item.status === 'stale')
        || finalEventMemory.big_summaries.some(item => item.status === 'stale');
      if (unresolved) throw new Error('仍有相关记忆或纪要未能重建');
      applyInjection();
      setExternalStatus(historyAuditMessage(auditReport, 'success'));
      return { repaired: true, repairedCount, updatedBig };
    } catch (error) {
      const state = data().loadState();
      auditStoredSources(state, auditReport);
      data().saveState(replayTimeline(state));
      applyInjection(); // 失效摘要不注入，正文会恢复，避免信息洞。
      setExternalStatus(historyAuditMessage(auditReport, 'failed', error), true);
      throw error;
    } finally {
      reconciling = false;
      runningLabel = '';
      abortController = null;
      if (announced) window.WORLD_ENGINE_UI?.setMemoryEvolvingUI?.(false, '');
    }
  }

  function abort() {
    backfillRunning = false;
    abortController?.abort();
    window.MEMORY_ENGINE_VECTOR?.abortRecall?.();
  }

  function clearInjection() {
    const ctx = context();
    if (typeof ctx?.setExtensionPrompt === 'function') ctx.setExtensionPrompt(INJECTION_NAME, '', 1, 1);
    else if (typeof ctx?.unregisterInjection === 'function') ctx.unregisterInjection(INJECTION_NAME);
  }

  function registerInjection(content) {
    const ctx = context();
    if (typeof ctx?.setExtensionPrompt === 'function') ctx.setExtensionPrompt(INJECTION_NAME, content, 1, 1);
    else if (typeof ctx?.registerInjection === 'function') {
      ctx.unregisterInjection?.(INJECTION_NAME);
      ctx.registerInjection(INJECTION_NAME, content, { position: 1, depth: 1, role: 'system' });
    }
  }

  async function prepareHistoryForGeneration() {
    if (settings().engineEnabled === false) return { invalidated: false };
    const auditReport = newHistoryAuditReport();
    let state = data().loadState();
    const sourcesChanged = auditStoredSources(state, auditReport);
    const summaryCursorChanged = rewindSummaryCursorForDeletedLayers(state, auditReport);
    if (sourcesChanged || summaryCursorChanged) {
      state = replayTimeline(state);
      data().saveState(state);
    }
    // 远事召回：生成前阻塞完成（酒馆会 await 生成拦截器 → 此处），失败静默无节。
    vectorRecallPromise = Promise.resolve(window.MEMORY_ENGINE_VECTOR?.recallForGeneration?.())
      .catch(error => console.warn('[记忆引擎] 远事召回失败（已隔离）', error));
    await vectorRecallPromise;
    // stale 纪要/总述不会再注入；其来源正文（例如第 3、4 楼）会从隐藏集合移除。
    applyInjection();
    await hiddenSyncPromise;
    return { invalidated: sourcesChanged || summaryCursorChanged };
  }

  function selectHiddenMessageIds(coveredRefs, currentChatId, recentMessageIds) {
    const recent = recentMessageIds instanceof Set ? recentMessageIds : new Set(recentMessageIds || []);
    return new Set((coveredRefs || [])
      .filter(ref => clean(ref?.chatId) === clean(currentChatId))
      .map(ref => clean(ref?.messageId))
      .filter(messageId => messageId && !recent.has(messageId)));
  }

  function recentRawRoundMessageIds(messages, roundCount, st, api) {
    const source = Array.isArray(messages) ? messages : [];
    const take = Math.max(0, parseInt(roundCount) || 0);
    if (!source.length || !take) return new Set();
    const opening = ignoreFirstLayer(st);
    const aiLayers = source.map((message, index) => (
      !message?.is_user && !(opening && index === 0) ? index : -1
    )).filter(index => index >= 0);
    const start = aiLayers.length > take ? aiLayers[aiLayers.length - take - 1] + 1 : 0;
    return new Set(source.slice(start)
      .map(message => clean(api?.ensureMessageId?.(message)))
      .filter(Boolean));
  }

  function syncHiddenMessages(messageIds, label) {
    try {
      hiddenSyncPromise = Promise.resolve(timelineApi()?.syncHidden?.(messageIds))
        .catch(error => console.warn(`[记忆引擎] ${label}`, error));
    } catch (error) {
      console.warn(`[记忆引擎] ${label}`, error);
      hiddenSyncPromise = Promise.resolve();
    }
    return hiddenSyncPromise;
  }

  function applyInjection(options) {
    const st = settings();
    if (st.engineEnabled === false || st.injectIntoPrompt === false) {
      clearInjection();
      syncHiddenMessages(new Set(), '恢复正文失败');
      return '';
    }
    const state = (options?.isReroll && data().loadCheckpoint()) || data().loadState();
    ensureEntityState(state);
    const eventMemory = ensureEventState(state);
    const hasPeople = Boolean(state?.personal_memory?.length);
    const hasEntities = ENTITY_TYPES.some(type => state.entity_memory[type].length);
    const hasNpcs = Boolean(state?.npc_profiles?.length);
    const hasEvents = Boolean(eventMemory.big_summaries.length || eventMemory.small_summaries.length);
    if (!hasPeople && !hasEntities && !hasNpcs && !hasEvents) {
      clearInjection();
      syncHiddenMessages(new Set(), '恢复正文失败');
      return '';
    }
    if (!state.knowledge_index || !Object.keys(state.knowledge_index).length) rebuildKnowledgeIndex(state);
    const scan = chat().slice(-Math.max(1, parseInt(st.searchDepth) || 5)).map(message => clean(message?.mes)).join('\n');
    const appearsInScan = name => {
      if (!name) return false;
      return new RegExp(String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u').test(scan);
    };
    const matched = (state.personal_memory || []).filter(character => (character.names || []).some(appearsInScan));
    const matchedEntities = ENTITY_TYPES.flatMap(type => state.entity_memory[type]
      .filter(entity => unique([entity.name, ...(entity.aliases || [])]).some(appearsInScan))
      .map(entity => ({ type, entity })));
    const sections = [], globalSeen = new Set(), limit = Math.max(1, parseInt(st.maxPerCharacter) || 20);
    const bigLimit = Math.max(1, parseInt(st.bigSummaryInjectLimit) || 3);
    // 故事内「现在」只解析一次，供各注入行的相对距离前缀使用。
    const nowTotal = latestStoryDayTotal();
    const validBig = eventMemory.big_summaries.filter(item => item.status !== 'stale' && item.status !== 'failed');
    const higherChildIds = new Set(validBig.filter(item => Number(item.level) >= 2).flatMap(item => item.childIds || []));
    // 被更高层总述吸收的总述不再逐条注入，由上层总述代表。
    const activeBig = validBig.filter(item => Number(item.level) < 2 && !higherChildIds.has(clean(item.id)));
    const recentBig = activeBig.slice(-bigLimit);
    // 更早层按级别分节（最高层在前），每层排除被更高层吸收的条目、只注入最近几条。
    const injectedHigher = [];
    for (let level = MAX_SUMMARY_LEVEL; level >= 2; level--) {
      const absorbedHere = new Set(validBig.filter(item => Number(item.level) > level).flatMap(item => item.childIds || []));
      const items = validBig.filter(item => Number(item.level) === level && !absorbedHere.has(clean(item.id))).slice(-bigLimit);
      if (!items.length) continue;
      injectedHigher.push(...items);
      sections.push(`【${SUMMARY_LEVEL_LABELS[level] || '更早总述'}】\n${items.map(item =>
        `- [${formatSummaryLabel(item, nowTotal)}] ${item.content}`
      ).join('\n')}`);
    }
    if (recentBig.length) {
      sections.push(`【故事总述】\n${recentBig.map(item =>
        `- [${formatSummaryLabel(item, nowTotal)}] ${item.content}`
      ).join('\n')}`);
    }
    // 纪要是否已整理必须看全部有效总述的传递覆盖（更早总述 → 总述 → 纪要），且不限于本次注入的几条；
    // 否则旧总述退出注入窗口后其子纪要会重新被注入。
    const validBigById = new Map(validBig.map(item => [item.id, item]));
    const coveredChildIds = new Set();
    for (const overview of validBig) {
      const walk = node => {
        for (const childId of node.childIds || []) {
          if (coveredChildIds.has(childId)) continue;
          coveredChildIds.add(childId);
          const child = validBigById.get(childId);
          if (child) walk(child);
        }
      };
      walk(overview);
    }
    const hasStructuredOverview = eventMemory.big_summaries.some(item => Array.isArray(item.childIds) && item.childIds.length);
    const smallLimit = Math.max(1, parseInt(st.smallSummaryInjectLimit) || 10);
    const pendingSmall = eventMemory.small_summaries.filter((item, index) => {
      if (item.status === 'stale' || item.status === 'failed') return false;
      // 新结构按 childIds 精确判断；旧数据没有 childIds 时继续兼容游标。
      if (hasStructuredOverview) return !coveredChildIds.has(item.id);
      return index >= eventMemory.big_summary_cursor;
    }).slice(-smallLimit);
    if (pendingSmall.length) {
      sections.push(`【近期事件纪要】\n${pendingSmall.map(item =>
        `- [${formatSummaryLabel(item, nowTotal)}] ${item.content}`
      ).join('\n')}`);
    }
    for (const character of matched) {
      const records = [];
      for (const name of character.names || []) records.push(...(state.knowledge_index[normalized(name)] || []));
      const candidates = records.filter(record => {
        const key = `${record.ownerId}\u0000${record.time}\u0000${record.memory}`;
        return !globalSeen.has(key);
      }).filter((record, index, list) => list.findIndex(other =>
        other.ownerId === record.ownerId && other.time === record.time && other.memory === record.memory
      ) === index);
      const selected = exponentialMemorySample(candidates, limit, Math.random, st.injectionDiceSides);
      selected.forEach(record => globalSeen.add(`${record.ownerId}\u0000${record.time}\u0000${record.memory}`));
      if (selected.length) sections.push(`【${character.names?.[0] || character.id}】\n` +
        selected.map(record => `- [${record.time || '时间未明'}] ${record.memory}`).join('\n'));
    }
    // 人物当前状态：最近楼层出现名字才注入；只注入可观察字段，空档案不出行细节。
    const matchedNpcs = (state.npc_profiles || []).filter(profile => (profile.names || []).some(appearsInScan));
    if (matchedNpcs.length) {
      sections.push(`【人物当前状态】\n${matchedNpcs.map(profile => {
        const label = clean(profile.names?.[0]) || profile.id;
        const aliases = (profile.names || []).slice(1).map(clean).filter(Boolean).join(' / ');
        const parts = [
          clean(profile.location) ? `位置：${clean(profile.location)}` : '',
          clean(profile.condition) ? `处境：${clean(profile.condition)}` : '',
          clean(profile.stance) ? `态度：${clean(profile.stance)}` : ''
        ].filter(Boolean);
        return `- ${label}${aliases ? `（${aliases}）` : ''}：${parts.length ? parts.join('；') : '暂无可靠观察'}`;
      }).join('\n')}`);
    }
    if (matchedEntities.length) {
      const entitySections = matchedEntities.map(({ type, entity }) => {
        const lines = [`【${ENTITY_LABELS[type]}：${entity.name}】`, entity.description];
        const history = exponentialMemorySample(
          Array.isArray(entity.history) ? entity.history : [], limit, Math.random, st.injectionDiceSides
        );
        if (history.length) lines.push(...history.map(entry => `- [${entry.time || '时间未明'}] ${entry.event}`));
        return lines.filter(Boolean).join('\n');
      });
      sections.push(`【相关世界实体】\n${entitySections.join('\n\n')}`);
    }
    // 远事召回：向量检索到的旧纪要（生成前预计算）；与本次注入的未整理纪要按来源指纹去重。
    const recall = window.MEMORY_ENGINE_VECTOR?.getLastRecall?.();
    if (recall?.items?.length) {
      const injectedDigests = new Set(pendingSmall.map(item => clean(item.sourceDigest)));
      const recallItems = recall.items.filter(item => clean(item.digest) && !injectedDigests.has(clean(item.digest)));
      if (recallItems.length) {
        sections.push(`【远事召回】\n${recallItems.map(item =>
          `- [${formatSummaryLabel(item, nowTotal)}] ${clean(item.content)}`
        ).join('\n')}`);
      }
    }
    const coveredRefs = timelineApi()?.unionRefs?.([
      ...injectedHigher.map(item => item.sourceRefs || []),
      ...recentBig.map(item => item.sourceRefs || []),
      ...pendingSmall.map(item => item.sourceRefs || [])
    ]) || [];
    const api = timelineApi();
    const coveredMessageIds = (() => {
      if (st.hideCoveredRawText === false) return new Set();
      const keepRawRounds = st.recentRawRounds === undefined
        ? 1 : Math.max(0, parseInt(st.recentRawRounds) || 0);
      const recentMessageIds = recentRawRoundMessageIds(chat(), keepRawRounds, st, api);
      return selectHiddenMessageIds(coveredRefs, data()?.getChatId?.(), recentMessageIds);
    })();
    syncHiddenMessages(coveredMessageIds, '同步正文覆盖失败');
    if (!sections.length) { clearInjection(); return ''; }
    const content = `${SENTINEL}\n事件总结记录对话中已经发生的剧情；人物条目是当前场景人物持有或明确知晓的主观记忆，允许彼此矛盾；实体条目记录相关组织、物件、能力与地点的当前描述和本地历史。\n以上全部内容是仅供你参考的私密记忆简报：严禁在回复中复述或逐条引用，也不要向用户提及这些记录的存在。\n\n${sections.join('\n\n')}`;
    registerInjection(content);
    return content;
  }

  function buildWorldEngineContext(worldState) {
    const st = settings();
    if (st.engineEnabled === false || st.injectIntoWorldEngine !== true || !worldState) return '';
    const state = data().loadState();
    ensureEntityState(state);
    if (!state.knowledge_index || !Object.keys(state.knowledge_index).length) rebuildKnowledgeIndex(state);
    const scan = JSON.stringify(worldState);
    const appears = name => name && scan.includes(String(name));
    const limit = Math.max(1, parseInt(st.worldEngineMemoryLimit) || 5);
    const sections = [], seenRecords = new Set();
    for (const character of state.personal_memory || []) {
      if (!(character.names || []).some(appears)) continue;
      const records = [];
      for (const name of character.names || []) records.push(...(state.knowledge_index[normalized(name)] || []));
      const candidates = records.filter(record => {
        const key = `${record.ownerId}\u0000${record.time}\u0000${record.memory}`;
        if (seenRecords.has(key)) return false;
        return true;
      }).filter((record, index, list) => list.findIndex(other =>
        other.ownerId === record.ownerId && other.time === record.time && other.memory === record.memory
      ) === index);
      const selected = exponentialMemorySample(candidates, limit, Math.random, st.injectionDiceSides);
      selected.forEach(record => seenRecords.add(`${record.ownerId}\u0000${record.time}\u0000${record.memory}`));
      if (selected.length) sections.push(`【人物：${character.names?.[0] || character.id}】\n` +
        selected.map(record => `- [${record.time || '时间未明'}] ${record.memory}`).join('\n'));
    }
    for (const type of ENTITY_TYPES) {
      for (const entity of state.entity_memory[type] || []) {
        if (!unique([entity.name, ...(entity.aliases || [])]).some(appears)) continue;
        const lines = [`【${ENTITY_LABELS[type]}：${entity.name}】`];
        if (entity.description) lines.push(entity.description);
        lines.push(...exponentialMemorySample(
          Array.isArray(entity.history) ? entity.history : [], limit, Math.random, st.injectionDiceSides
        )
          .map(entry => `- [${entry.time || '时间未明'}] ${entry.event}`));
        sections.push(lines.join('\n'));
      }
    }
    // 命中世界状态的人物附带当前状态，供推演判断在场与态度。
    for (const profile of state.npc_profiles || []) {
      if (!(profile.names || []).some(appears)) continue;
      const parts = [
        clean(profile.location) ? `位置：${clean(profile.location)}` : '',
        clean(profile.condition) ? `处境：${clean(profile.condition)}` : '',
        clean(profile.stance) ? `态度：${clean(profile.stance)}` : ''
      ].filter(Boolean);
      if (parts.length) sections.push(`【人物状态：${clean(profile.names?.[0]) || profile.id}】\n${parts.join('；')}`);
    }
    if (!sections.length) return '';
    return `【记忆引擎提供的相关人物与实体信息】\n以下信息只用于辅助世界推演；不包含纪要或总述。\n\n${sections.join('\n\n')}`;
  }

  async function ingestWorldEvolution(payload) {
    const worldSettings = window.WORLD_ENGINE_API?.getSettings?.(true) || {};
    if (worldSettings.memoryLinkEnabled !== true && payload?.force !== true) return { skipped: true, reason: 'disabled' };
    const st = settings();
    if (st.engineEnabled === false) throw new Error('记忆引擎已关闭，无法执行世界联动');
    if (backfillRunning) throw new Error('记忆引擎正在批量重填，暂不能执行世界联动');
    const layer = Number.isFinite(Number(payload?.layer)) ? Number(payload.layer) : currentLayer();
    // 普通记忆提取先开始时，等待它完整落库；不得并发读取同一基底后互相覆盖。
    const deadline = Date.now() + Math.max(10000, Number(st.apiTimeoutMs) || 120000);
    while (running && Date.now() < deadline) await delay(100);
    if (running) throw new Error('等待当前记忆任务结束超时');
    if (payload?.replace === true) rollbackLinkedLayer(layer);

    const digest = clean(payload?.worldDigest);
    if (!digest) return { skipped: true, reason: 'empty_digest' };
    const sourceKey = `${data().getChatId()}:${layer}`;
    const worldInfo = payload?.worldUpdate && typeof payload.worldUpdate === 'object'
      ? JSON.stringify(payload.worldUpdate, null, 2)
      : digest;
    const attemptBase = data().loadState();
    try {
      const result = await runTasksThenDueBig({
        memory: {
          conversation: `【世界引擎本轮返回】\n${worldInfo}\n\n以上是客观世界信息。只更新其中明确支持的人物认知与世界实体，不得猜测任何人物知晓未公开信息。`,
          sourceKey,
          startLayer: layer,
          endLayer: layer,
          kind: 'world_link'
        }
      }, {
        layer,
        baseState: attemptBase,
        saveCheckpoint: false,
        worldDigestMinute: { layer, sourceKey, content: digest }
      });
      return result;
    } catch (error) {
      // 联动失败只撤销本次联动尝试；同楼层已完成的普通记忆提取仍应保留。
      data().saveState(attemptBase);
      applyInjection();
      throw error;
    }
  }

  // 断点续填进度：记在记忆状态里，与重填成果同生共死（回档/换聊天自动跟随）。
  function loadBackfillProgress() {
    const progress = data().loadState()?.backfill_progress;
    return progress && typeof progress === 'object' ? progress : {};
  }
  function saveBackfillProgress(kind, value) {
    const current = data().loadState();
    const progress = current.backfill_progress && typeof current.backfill_progress === 'object' ? { ...current.backfill_progress } : {};
    if (value) progress[kind] = {
      nextLayer: Math.max(0, parseInt(value.nextLayer) || 0),
      endLayer: Math.max(0, parseInt(value.endLayer) || 0),
      // 记下当时的「首楼为 AI 开场白」取值：开关变更说明填充范围变了，旧断点作废。
      opening: value.opening === true
    };
    else delete progress[kind];
    data().saveState({ ...current, backfill_progress: progress });
  }

  function setBackfillStatus(current, total, message) {
    backfillStatus = { running: backfillRunning, current, total, message: message || '' };
    const element = document.getElementById('we-memory-person-backfill-status');
    if (element) element.textContent = backfillStatus.message;
  }

  function setSummaryBackfillStatus(current, total, message) {
    summaryBackfillStatus = { running: backfillRunning, current, total, message: message || '' };
    const element = document.getElementById('we-memory-summary-backfill-status');
    if (element) element.textContent = summaryBackfillStatus.message;
  }

  async function backfill() {
    if (backfillRunning || running) return;
    const st = settings(), all = chat();
    if (st.engineEnabled === false) throw new Error('记忆引擎已关闭');
    const configuredEnd = Math.max(0, parseInt(st.backfillEndLayer) || 0);
    const end = Math.min(all.length - 1, configuredEnd || all.length - 1);
    const opening = ignoreFirstLayer(st);
    const aiLayers = all.map((message, index) => (!message?.is_user && index <= end && !(opening && index === 0) ? index : -1)).filter(i => i >= 0);
    const size = Math.max(1, parseInt(st.backfillBatchSize) || 5);
    // 断点续填：上次失败或中止留下的进度接着跑，已入库的成果不再清掉。
    // 「首楼为 AI 开场白」开关与断点记录不一致时视为填充范围变更，旧断点作废、整库重建。
    const personProgress = loadBackfillProgress().person;
    const resumeFrom = Number(personProgress?.nextLayer);
    const resuming = Number.isFinite(resumeFrom) && resumeFrom > 0 && personProgress.opening === opening;
    const batches = [];
    for (let i = 0; i < aiLayers.length; i += size) {
      const layers = resuming ? aiLayers.slice(i, i + size).filter(l => l >= resumeFrom) : aiLayers.slice(i, i + size);
      if (layers.length) batches.push(layers);
    }
    if (!batches.length) {
      if (resuming) { saveBackfillProgress('person', null); setBackfillStatus(0, 0, '没有可续填的 AI 楼层，进度已清除'); }
      else setBackfillStatus(0, 0, '没有可重填的 AI 楼层');
      return;
    }
    backfillRunning = true;
    try {
      if (resuming) {
        setBackfillStatus(0, batches.length, `检测到上次进度，从第 ${resumeFrom} 楼继续`);
      } else {
        window.WORLD_ENGINE_CHATCACHE?.forScope?.('memory')?.createSnapshot?.('记忆重填前自动备份');
        const original = data().loadState();
        data().saveCheckpoint(original);
        data().saveState({
          ...original,
          personal_memory: [],
          knowledge_index: {},
          entity_memory: { organization: [], object: [], ability: [], location: [] },
          entity_index: {},
          round: 0,
          chatLayer: null,
          timeline: null
        });
      }
      for (let i = 0; i < batches.length && backfillRunning; i++) {
        const layers = batches[i], start = Math.max(0, layers[0] - 1), finish = layers.at(-1);
        setBackfillStatus(i, batches.length, `正在重填 ${i + 1} / ${batches.length}`);
        try {
          await extractConversation(formatMessages(all.slice(start, finish + 1), start), {
            startLayer: start,
            endLayer: finish,
            sourceRefs: timelineApi()?.captureRange?.(start, finish) || [],
            layer: finish, retries: st.backfillRetries, saveCheckpoint: true, allowWhileBackfill: true
          });
          saveBackfillProgress('person', { nextLayer: finish + 1, endLayer: end, opening });
        } catch (error) {
          if (abortController?.signal?.aborted || error?.name === 'AbortError') throw error;
          // 整批请求失败时降级为逐轮提取；单轮仍失败才中止——跳过楼层继续会造成静默缺口。
          setBackfillStatus(i, batches.length, `第 ${i + 1} 批失败，降级为逐轮重填`);
          for (const layer of layers) {
            if (!backfillRunning) break;
            const roundStart = all[layer - 1]?.is_user ? layer - 1 : layer;
            try {
              await extractConversation(formatMessages(all.slice(roundStart, layer + 1), roundStart), {
                startLayer: roundStart,
                endLayer: layer,
                sourceRefs: timelineApi()?.captureRange?.(roundStart, layer) || [],
                layer, retries: st.backfillRetries, saveCheckpoint: true, allowWhileBackfill: true
              });
              saveBackfillProgress('person', { nextLayer: layer + 1, endLayer: end, opening });
            } catch (roundError) {
              if (abortController?.signal?.aborted || roundError?.name === 'AbortError') throw roundError;
              throw new Error(`第 ${layer} 楼逐轮重填仍失败：${roundError?.message || roundError}`);
            }
          }
        }
      }
      if (!backfillRunning) { setBackfillStatus(backfillStatus.current, batches.length, '记忆重填已停止，进度已保留，再次开始将继续'); return; }
      saveBackfillProgress('person', null);
      setBackfillStatus(batches.length, batches.length, '记忆重填完成');
    } catch (error) {
      const aborted = abortController?.signal?.aborted || error?.name === 'AbortError';
      const stuck = loadBackfillProgress().person?.nextLayer;
      setBackfillStatus(backfillStatus.current, batches.length, aborted
        ? `记忆重填已停止${stuck ? `，已填到第 ${stuck} 楼` : ''}，再次开始将继续`
        : `重填失败：${error?.message || error}${stuck ? `（已填到第 ${stuck} 楼，再次开始将继续）` : ''}`);
      throw error;
    } finally { backfillRunning = false; backfillStatus.running = false; applyInjection(); }
  }

  async function backfillSummaries() {
    if (backfillRunning || running) return;
    const st = settings(), all = chat();
    if (st.engineEnabled === false) throw new Error('记忆引擎已关闭');
    const configuredEnd = Math.max(0, parseInt(st.backfillEndLayer) || 0);
    const end = Math.min(all.length - 1, configuredEnd || all.length - 1);
    const opening = ignoreFirstLayer(st);
    const aiLayers = all.map((message, index) => (!message?.is_user && index <= end && !(opening && index === 0) ? index : -1)).filter(index => index >= 0);
    const size = Math.max(1, parseInt(st.summaryBackfillSmallEveryX) || 5);
    // 断点续填：与人物/实体重填同一套进度标记，两类互不干扰；开关变更同样作废旧断点。
    const summaryProgress = loadBackfillProgress().summary;
    const resumeFrom = Number(summaryProgress?.nextLayer);
    const resuming = Number.isFinite(resumeFrom) && resumeFrom > 0 && summaryProgress.opening === opening;
    const batches = [];
    for (let i = 0; i < aiLayers.length; i += size) {
      const layers = resuming ? aiLayers.slice(i, i + size).filter(l => l >= resumeFrom) : aiLayers.slice(i, i + size);
      if (layers.length) batches.push(layers);
    }
    if (!batches.length) {
      if (resuming) { saveBackfillProgress('summary', null); setSummaryBackfillStatus(0, 0, '没有可续填的 AI 楼层，进度已清除'); }
      else setSummaryBackfillStatus(0, 0, '没有可重填的 AI 楼层');
      return;
    }
    backfillRunning = true;
    try {
      if (resuming) {
        setSummaryBackfillStatus(0, batches.length, `检测到上次进度，从第 ${resumeFrom} 楼继续`);
      } else {
        window.WORLD_ENGINE_CHATCACHE?.forScope?.('memory')?.createSnapshot?.('纪要与总述重填前自动备份');
        const original = data().loadState();
        data().saveCheckpoint(original);
        data().saveState({
          ...original,
          event_memory: { small_summaries: [], big_summaries: [], small_summary_layer: null, big_summary_cursor: 0 }
        });
      }
      for (let i = 0; i < batches.length && backfillRunning; i++) {
        const layers = batches[i], firstAi = layers[0], finish = layers.at(-1);
        const start = firstAi > 0 && all[firstAi - 1]?.is_user ? firstAi - 1 : firstAi;
        const smallTask = {
          startLayer: start,
          endLayer: finish,
          conversation: formatMessages(all.slice(start, finish + 1), start),
          sourceRefs: timelineApi()?.captureRange?.(start, finish) || []
        };
        setSummaryBackfillStatus(i, batches.length, `正在重填纪要与总述 ${i + 1} / ${batches.length}`);
        try {
          await runTasksThenDueBig({ small: smallTask }, {
            baseState: data().loadState(), retries: st.backfillRetries, saveCheckpoint: true, allowWhileBackfill: true
          }, st.summaryBackfillBigEveryX);
          saveBackfillProgress('summary', { nextLayer: finish + 1, endLayer: end, opening });
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          // 整批纪要失败时降级为逐轮总结；单轮仍失败才中止并报告卡住的楼层。
          setSummaryBackfillStatus(i, batches.length, `第 ${i + 1} 批失败，降级为逐轮纪要`);
          for (const layer of layers) {
            if (!backfillRunning) break;
            const roundStart = all[layer - 1]?.is_user ? layer - 1 : layer;
            const roundTask = {
              startLayer: roundStart,
              endLayer: layer,
              conversation: formatMessages(all.slice(roundStart, layer + 1), roundStart),
              sourceRefs: timelineApi()?.captureRange?.(roundStart, layer) || []
            };
            try {
              await runTasksThenDueBig({ small: roundTask }, {
                baseState: data().loadState(), retries: st.backfillRetries, saveCheckpoint: true, allowWhileBackfill: true
              }, st.summaryBackfillBigEveryX);
              saveBackfillProgress('summary', { nextLayer: layer + 1, endLayer: end, opening });
            } catch (roundError) {
              if (roundError?.name === 'AbortError') throw roundError;
              throw new Error(`第 ${layer} 楼逐轮纪要仍失败：${roundError?.message || roundError}`);
            }
          }
        }
      }
      if (!backfillRunning) { setSummaryBackfillStatus(summaryBackfillStatus.current, batches.length, '纪要与总述重填已停止，进度已保留，再次开始将继续'); return; }
      saveBackfillProgress('summary', null);
      setSummaryBackfillStatus(batches.length, batches.length, '纪要与总述重填完成');
    } catch (error) {
      const aborted = error?.name === 'AbortError';
      const stuck = loadBackfillProgress().summary?.nextLayer;
      setSummaryBackfillStatus(summaryBackfillStatus.current, batches.length, aborted
        ? `纪要与总述重填已停止${stuck ? `，已填到第 ${stuck} 楼` : ''}，再次开始将继续`
        : `纪要与总述重填失败：${error?.message || error}${stuck ? `（已填到第 ${stuck} 楼，再次开始将继续）` : ''}`);
      throw error;
    } finally { backfillRunning = false; summaryBackfillStatus.running = false; applyInjection(); }
  }

  function stopBackfill() {
    backfillRunning = false;
    abortController?.abort();
    setBackfillStatus(backfillStatus.current, backfillStatus.total, '正在停止…');
    setSummaryBackfillStatus(summaryBackfillStatus.current, summaryBackfillStatus.total, '正在停止…');
  }

  // 清除断点进度：下次两类重填都从初始层整库重来（成果本身不动）。
  function resetBackfillProgress() {
    if (backfillRunning) throw new Error('重填正在进行，请先停止');
    saveBackfillProgress('person', null);
    saveBackfillProgress('summary', null);
    setBackfillStatus(0, 0, '进度已清除，下次开始将从初始层重填');
    setSummaryBackfillStatus(0, 0, '进度已清除，下次开始将从初始层重填');
  }

  function onMessageReceived() {
    const key = `${currentLayer()}:${clean(chat().at(-1)?.mes).slice(-80)}`;
    if (key === lastEventKey) return;
    lastEventKey = key;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => autoExtract().catch(error => console.error('[记忆引擎] 自动提取失败', error)), 1500);
  }

  function schedulePreparation(delayMs = 50) {
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => prepareHistoryForGeneration()
      .catch(error => console.error('[记忆引擎] 历史摘要撤旧失败', error)), delayMs);
  }

  function guardEvent(label, handler) {
    if (typeof window.WORLD_ENGINE_GUARD_EVENT === 'function') {
      return window.WORLD_ENGINE_GUARD_EVENT('记忆引擎', label, handler);
    }
    return function(...args) {
      try {
        const result = handler(...args);
        if (result && typeof result.then === 'function') {
          return result.catch(error => console.error(`[记忆引擎] ${label}事件处理失败`, error));
        }
        return result;
      }
      catch (error) { console.error(`[记忆引擎] ${label}事件处理失败`, error); }
    };
  }

  function init() {
    if (initialized) return;
    initialized = true;
    initializeSummaryBaseline();
    const ctx = context(), types = ctx?.event_types || {};
    if (ctx?.eventSource) {
      ctx.eventSource.on(types.GENERATION_ENDED || types.MESSAGE_RECEIVED || 'message_received', guardEvent('生成完成', onMessageReceived));
      ctx.eventSource.on(types.CHAT_LOADED || 'chat_loaded', guardEvent('聊天加载', () => {
        clearTimeout(autoTimer);
        abortController?.abort();
        lastEventKey = '';
        initializeSummaryBaseline();
        window.MEMORY_ENGINE_VECTOR?.scheduleIndexUpdate?.();
        schedulePreparation(100);
      }));
      ctx.eventSource.on(types.MESSAGE_SWIPED || 'message_swiped', guardEvent('滑动重生成', () => {
        clearTimeout(autoTimer);
        abortController?.abort();
        if (!rollbackLinkedLayer(currentLayer())) applyInjection({ isReroll: true });
        schedulePreparation(50);
      }));
      ctx.eventSource.on(types.MESSAGE_DELETED || 'message_deleted', guardEvent('删除消息', () => {
        clearTimeout(autoTimer);
        abortController?.abort();
        lastEventKey = '';
        schedulePreparation(50);
      }));
      ctx.eventSource.on(types.GENERATION_STARTED || 'generation_started', guardEvent('生成开始', (type, _opts, dryRun) => {
        if (!dryRun) applyInjection({ isReroll: type === 'swipe' || type === 'regenerate' });
      }));
    }
    try { applyInjection(); }
    catch (error) { console.error('[记忆引擎] 首次注入失败', error); }
  }

  return {
    init, applyInjection, buildWorldEngineContext, ingestWorldEvolution, manualExtract, manualReextract, extractNow: manualExtract,
    reconcileHistory, prepareHistoryForGeneration, replayTimeline, commitManualState,
    manualSmallSummary, manualBigSummary,
    backfill, backfillSummaries, stopBackfill, abort, resetBackfillProgress,
    repairStateIndexes, replaceKnownByRecords,
    getLastDebug: () => clone(lastDebug), getBackfillStatus: () => clone(backfillStatus),
    getSummaryBackfillStatus: () => clone(summaryBackfillStatus),
    getBackfillProgress: () => clone(loadBackfillProgress()),
    getRunningLabel: () => runningLabel,
    isRunning: () => running || backfillRunning || reconciling,
    _test: {
      exponentialMemorySample, rollbackLinkedLayer, removeLinkedLayerFromState, rewindSummaryCursorForDeletedLayers,
      buildSmallHistoryContext, buildTaskReferenceContext, previousRawReference,
      parseResponse, selectHiddenMessageIds, recentRawRoundMessageIds,
      stripThinking, normalizeJsonText, escapeStrayQuotes, extractJsonPayload, clampSentence,
      buildMetaTask: buildCompressionTask, buildCompressionTask, findDueCompressionTask, findOldestMissingBatch,
      getAiBatchAfter, isMemoryBatchCovered, ignoreFirstLayer, mergeNpcProfiles, findNpcProfile,
      extractStoryTimeRange, resolveSummaryTimes, formatSummaryTimeRange, formatSummaryRefLabel,
      formatRelativeStoryAge, formatSummaryLabel
    }
  };
})();
