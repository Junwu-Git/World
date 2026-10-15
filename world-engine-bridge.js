// world-engine-bridge.js — 外部数据源桥（柏宝书 / SP·数据库，单选）
//
// 把一个外部插件的记忆数据以只读方式喂给世界推演 prompt（作为推演时的世界事实参照）。
// 两个数据源互斥单选：一次推演只会注入其中一个，绝不叠加。
// 隔离铁律（与 choice/RUBY 的桥接同款）：不 import 对方源码、不写对方任何状态、
// 任何环节失败一律静默返回空串——外部插件不存在或异常时世界推演完全不受影响。
//
// 数据面：
// 1. 柏宝书（ST-BaiBai-Book）：globalThis.STBaiBaiBook 公开读取 API v1（只返回深拷贝 DTO）。
//    等待就绪用 window 'st-baibai-book:ready' 事件；coverage.complete===false 时标注记忆有缺口。
// 2. SP·数据库（shujuku / 龙血玄黄·数据库）：window.AutoCardUpdaterAPI 公开 API。
//    首选 exportTableAsJson()（同步、无运行时门控）：{ sheet_xxx: { name, content: (string|null)[][] } }，
//    content[0] 是表头、content[1:] 是数据行。兜底再扫世界书总结条目
//    （总结条目N / 重要人物条目N / TavernDB-ACU-OutlineTable，RUBY reader.js 同款正则）。
//
// 加载顺序：本模块在共用底座阶段加载（store/core/api 之后），推演与设置 UI 均可引用。
window.WORLD_ENGINE_BRIDGE = (function() {
  const BAIBAIBOOK_MAX_CHARS = 12000;   // 柏宝书快照注入上限（防 prompt 膨胀）
  const BAIBAIBOOK_HISTORY_MAX_CHARS = 8000; // 柏宝书历史摘要注入上限（摘要与快照分开限，互不挤占）
  const SHUJUKU_MAX_CHARS = 12000;      // 数据库表格注入上限
  const SHUJUKU_MAX_ROWS_PER_SHEET = 60;
  const SHUJUKU_MAX_SHEETS = 12;

  // 桥读取失败只警告一次：外部插件未安装/异常时每次推演都会走到这些 catch，
  // 逐次 warn 会刷屏（隔离本身已保证返回空串、不阻断推演）。与 core.applyStRegex
  // 的 _stRegexWarned 同款抑制。
  let _bridgeWarned = false;
  function warnBridgeOnce(scope, error) {
    if (_bridgeWarned) return;
    _bridgeWarned = true;
    console.warn(`[世界引擎][桥] ${scope}失败（已隔离，后续不再提示）:`, error && error.message ? error.message : error);
  }

  // ---------- 柏宝书（STBaiBaiBook） ----------
  function baibaibookApi() {
    try {
      const api = globalThis.STBaiBaiBook;
      return (api && typeof api.getSnapshot === 'function') ? api : null;
    } catch (e) { return null; }
  }

  // 当前是否选择了柏宝书作为桥接数据源（单选设置；旧版双开关残留也认）
  function baibaibookEnabled() {
    try {
      const api = window.WORLD_ENGINE_API;
      const s = api && api.getSettings ? api.getSettings() : {};
      if (s.bridgeSource === 'baibaibook') return true;
      if (s.bridgeSource && s.bridgeSource !== 'baibaibook') return false; // 明确选了别的源
      return s.bridgeBaibaibookEnabled === true; // 旧版双开关残留
    } catch (e) { return false; }
  }

  function baibaibookAffinityLabel(v, labels) {
    if (v == null) return '';
    const key = String(v);
    return Object.prototype.hasOwnProperty.call(labels, key) ? labels[key] : '';
  }

  const AFFINITY_INNER = { '-2': '强烈反感', '-1': '不喜欢', '0': '无明显好恶', '1': '好感', '2': '感情深厚' };
  const AFFINITY_OUTER = { '-2': '明显敌对', '-1': '冷淡疏远', '0': '不明显亲近或排斥', '1': '友善亲近', '2': '明显亲近' };

  // 把快照 DTO 渲染成给推演模型看的紧凑文本（板块字段参照 RUBY reader.js，apiVersion 1）
  function renderBaibaibookSnapshot(s) {
    if (!s || typeof s !== 'object') return '';
    const lines = [];

    if (s.coverage && s.coverage.complete === false &&
        Array.isArray(s.coverage.missingAiFloors) && s.coverage.missingAiFloors.length > 0) {
      lines.push(`⚠️ 记忆不完整：缺失AI楼层 ${s.coverage.missingAiFloors.join('、')}`);
    }

    if (s.state) {
      const parts = [];
      if (s.state.time) parts.push(`时间: ${s.state.time}`);
      if (s.state.location) parts.push(`地点: ${s.state.location}`);
      if (Array.isArray(s.state.locationPath) && s.state.locationPath.length > 0) parts.push(`位置: ${s.state.locationPath.join(' > ')}`);
      if (parts.length) lines.push(`【当前状态】\n${parts.join('；')}`);
    }

    if (s.protagonist) {
      const p = s.protagonist;
      const parts = [];
      if (p.gender) parts.push(`性别: ${p.gender}`);
      if (p.identity) parts.push(`身份: ${p.identity}`);
      if (p.appearance) parts.push(`外貌: ${p.appearance}`);
      if (p.outfit) parts.push(`穿着: ${p.outfit}`);
      if (p.condition) parts.push(`状态: ${p.condition}`);
      if (parts.length) lines.push(`【主角】\n${parts.join('；')}`);
    }

    if (Array.isArray(s.npcs) && s.npcs.length > 0) {
      lines.push('【登场人物】');
      for (const npc of s.npcs) {
        const parts = [];
        if (npc.name) parts.push(npc.name);
        if (npc.identity) parts.push(`身份: ${npc.identity}`);
        if (npc.appearance) parts.push(`外貌: ${npc.appearance}`);
        if (npc.outfit) parts.push(`穿着: ${npc.outfit}`);
        if (npc.condition) parts.push(`状态: ${npc.condition}`);
        if (npc.personality) parts.push(`性格: ${npc.personality}`);
        const inner = baibaibookAffinityLabel(npc.affinityInner, AFFINITY_INNER);
        const outer = baibaibookAffinityLabel(npc.affinityOuter, AFFINITY_OUTER);
        if (inner) parts.push(`内心好感: ${inner}`);
        if (outer) parts.push(`外在态度: ${outer}`);
        if (npc.affinityNote) parts.push(`好感说明: ${npc.affinityNote}`);
        if (parts.length > 1) lines.push(`  - ${parts.join('；')}`);
      }
    }

    if (Array.isArray(s.items) && s.items.length > 0) {
      lines.push('【物品清单】');
      for (const item of s.items) {
        const parts = [];
        if (item.name) parts.push(item.name);
        if (item.description) parts.push(`描述: ${item.description}`);
        if (item.location) parts.push(`位置: ${item.location}`);
        if (item.quantity !== undefined && item.quantity !== null) parts.push(`数量: ${item.quantity}`);
        if (item.status) parts.push(`状态: ${item.status}`);
        if (parts.length > 1) lines.push(`  - ${parts.join('；')}`);
      }
    }

    if (Array.isArray(s.itemLog) && s.itemLog.length > 0) {
      lines.push('【物品变动日志】');
      for (const log of s.itemLog.slice(-20)) {
        const parts = [];
        if (log.action) parts.push(log.action);
        if (log.item) parts.push(log.item);
        if (log.detail) parts.push(log.detail);
        if (log.floor !== undefined && log.floor !== null) parts.push(`楼层: ${log.floor}`);
        if (parts.length) lines.push(`  - ${parts.join('；')}`);
      }
    }

    if (Array.isArray(s.plans) && s.plans.length > 0) {
      lines.push('【计划与悬念】');
      for (const plan of s.plans) {
        const parts = [];
        if (plan.title) parts.push(plan.title);
        if (plan.description) parts.push(plan.description);
        if (plan.status) parts.push(`状态: ${plan.status}`);
        if (parts.length) lines.push(`  - ${parts.join('；')}`);
      }
    }

    if (Array.isArray(s.scenes) && s.scenes.length > 0) {
      lines.push('【场景】');
      for (const scene of s.scenes) {
        const parts = [];
        if (scene.name) parts.push(scene.name);
        if (scene.path) parts.push(`路径: ${scene.path}`);
        if (scene.description) parts.push(scene.description);
        if (parts.length) lines.push(`  - ${parts.join('；')}`);
      }
    }

    if (Array.isArray(s.lifeDetails) && s.lifeDetails.length > 0) {
      lines.push('【生活档案】');
      for (const detail of s.lifeDetails) {
        const parts = [];
        if (detail.subject) parts.push(detail.subject === 'user' ? '主角' : detail.subject);
        if (detail.text) parts.push(detail.text);
        if (Array.isArray(detail.topics) && detail.topics.length > 0) parts.push(`话题: ${detail.topics.join('、')}`);
        if (parts.length) lines.push(`  - ${parts.join('；')}`);
      }
    }

    if (s.vars && typeof s.vars === 'object' && Object.keys(s.vars).length > 0) {
      lines.push('【自定义变量】');
      for (const [key, value] of Object.entries(s.vars)) {
        const v = (value !== null && typeof value === 'object') ? JSON.stringify(value) : String(value);
        lines.push(`  ${key}: ${v}`);
      }
    }

    return lines.join('\n').trim();
  }

  // 柏宝书历史剧情摘要：优先注入口径 getInjectedHistory()（与柏宝书正常记忆注入同一套
  // 节点选择，自动跳过滑动窗口内仍发全文的摘要），降级 getHistory()（全部历史，截止最新楼）。
  function getBaibaibookHistoryText() {
    const api = baibaibookApi();
    if (!api) return '';
    try {
      if (typeof api.getInjectedHistory === 'function') {
        const injected = api.getInjectedHistory();
        if (injected && injected.relativeText) return String(injected.relativeText);
      }
      const ctx = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) ? SillyTavern.getContext() : null;
      const len = (ctx && Array.isArray(ctx.chat)) ? ctx.chat.length : 0;
      if (len > 0 && typeof api.getHistory === 'function') {
        const hist = api.getHistory({ before: len });
        if (hist && hist.relativeText) return String(hist.relativeText);
      }
    } catch (e) {
      warnBridgeOnce('读取柏宝书历史摘要', e);
    }
    return '';
  }

  function clamp(text, max) {
    if (!text) return '';
    return text.length > max ? text.slice(0, max) + '\n…（已截断）' : text;
  }

  // 柏宝书历史剧情摘要（独立出口）：拼接在推演 prompt 的「近期对话」正前方——
  // 摘要覆盖窗口起点之前的剧情，与近期对话时间连续，贴合摆放让模型把两者读成一条完整时间线
  //（中间隔大块 JSON 会切断叙事流）。异常与未接入一律静默空串。
  function getBaibaibookHistoryBlock() {
    if (!baibaibookEnabled()) return '';
    try {
      const history = clamp(getBaibaibookHistoryText(), BAIBAIBOOK_HISTORY_MAX_CHARS);
      return history ? `【历史剧情摘要】\n${history}` : '';
    } catch (e) {
      warnBridgeOnce('读取柏宝书历史摘要', e);
      return '';
    }
  }

  // 柏宝书当前状态快照（独立出口）：留在「外部数据源」分段原位——它是现状事实参照，
  // 与时间线无关。异常与未接入一律静默空串。
  function getBaibaibookSnapshotBlock() {
    if (!baibaibookEnabled()) return '';
    try {
      const snapshot = clamp(renderBaibaibookSnapshot(baibaibookApi().getSnapshot()), BAIBAIBOOK_MAX_CHARS);
      return snapshot ? `【当前状态快照】\n${snapshot}` : '';
    } catch (e) {
      warnBridgeOnce('读取柏宝书快照', e);
      return '';
    }
  }

  // 兼容旧调用（诊断/测试）：两块按原顺序拼回
  function getBaibaibookText() {
    const parts = [];
    const history = getBaibaibookHistoryBlock();
    if (history) parts.push(history);
    const snapshot = getBaibaibookSnapshotBlock();
    if (snapshot) parts.push(snapshot);
    return parts.join('\n\n');
  }

  // ---------- SP·数据库（AutoCardUpdaterAPI） ----------
  function shujukuApi() {
    try {
      const api = window.AutoCardUpdaterAPI;
      return (api && typeof api === 'object') ? api : null;
    } catch (e) { return null; }
  }

  function cellText(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/\s+/g, ' ').trim();
  }

  // 把一张表渲染成「表头: a | b | c」+ 数据行文本；空表/无表头返回 ''
  function renderSheet(sheet) {
    const content = sheet && Array.isArray(sheet.content) ? sheet.content : [];
    if (content.length < 1) return '';
    const headers = (content[0] || []).map(cellText);
    if (!headers.some(Boolean)) return '';
    const name = cellText(sheet.name) || '未命名表';
    const lines = [`〔${name}〕`];
    lines.push('  ' + headers.join(' | '));
    const rows = content.slice(1, 1 + SHUJUKU_MAX_ROWS_PER_SHEET);
    let rowCount = 0;
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      const cells = row.map(cellText);
      if (!cells.some(Boolean)) continue;
      lines.push('  ' + cells.join(' | '));
      rowCount++;
    }
    const totalRows = content.length - 1;
    if (totalRows > SHUJUKU_MAX_ROWS_PER_SHEET) {
      lines.push(`  …（共 ${totalRows} 行，仅展示前 ${SHUJUKU_MAX_ROWS_PER_SHEET} 行）`);
    }
    return rowCount > 0 || totalRows > 0 ? lines.join('\n') : '';
  }

  // 首选路径：exportTableAsJson() 同步导出全部表格
  function getShujukuTableText() {
    const api = shujukuApi();
    if (!api || typeof api.exportTableAsJson !== 'function') return '';
    try {
      const tableData = api.exportTableAsJson();
      if (!tableData || typeof tableData !== 'object') return '';
      const blocks = [];
      for (const key of Object.keys(tableData)) {
        if (!/^sheet_/.test(key)) continue;
        if (blocks.length >= SHUJUKU_MAX_SHEETS) break;
        const rendered = renderSheet(tableData[key]);
        if (rendered) blocks.push(rendered);
      }
      if (!blocks.length) return '';
      const text = blocks.join('\n\n');
      return text.length > SHUJUKU_MAX_CHARS
        ? text.slice(0, SHUJUKU_MAX_CHARS) + '\n…（已截断）'
        : text;
    } catch (e) {
      warnBridgeOnce('读取数据库表格', e);
      return '';
    }
  }

  // 数据库已处理到的最后消息索引（消息上出现 TavernDB_ACU_* 字段即被处理过；照抄 RUBY reader.js）
  function getShujukuBoundary() {
    try {
      const ctx = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) ? SillyTavern.getContext() : null;
      const chat = ctx && Array.isArray(ctx.chat) ? ctx.chat : [];
      for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (m && typeof m === 'object' && Object.keys(m).some(k => String(k).startsWith('TavernDB_ACU_'))) return i;
      }
    } catch (e) {}
    return -1;
  }

  const SHUJUKU_SUMMARY_RE = /^总结条目(\d+)$/;
  const SHUJUKU_PERSON_RE = /^重要人物条目(\d+)$/;
  const SHUJUKU_OUTLINE_RE = /^TavernDB-ACU-OutlineTable$/;

  // 兜底路径：数据库把可读总结写进世界书条目时直接取用（RUBY reader.js 同款规则）
  async function getShujukuWorldbookText() {
    if (getShujukuBoundary() < 0) return '';
    try {
      const ctx = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) ? SillyTavern.getContext() : null;
      if (!ctx || typeof ctx.loadWorldInfo !== 'function') return '';
      const bookNames = [];
      if (Array.isArray(ctx.world_names)) {
        for (const name of ctx.world_names) if (name && bookNames.indexOf(name) < 0) bookNames.push(name);
      }
      if (!bookNames.length) return '';

      const summaryRows = [], personRows = [];
      let outline = '';
      for (const bookName of bookNames) {
        let data = null;
        try { data = await ctx.loadWorldInfo(bookName); } catch (e) { continue; }
        if (!data || !data.entries) continue;
        for (const entry of Object.values(data.entries)) {
          const comment = String(entry && entry.comment || '');
          let m = comment.match(SHUJUKU_SUMMARY_RE);
          if (m) { summaryRows.push({ idx: parseInt(m[1], 10), content: String(entry.content || '').trim() }); continue; }
          m = comment.match(SHUJUKU_PERSON_RE);
          if (m) { personRows.push({ idx: parseInt(m[1], 10), content: String(entry.content || '').trim() }); continue; }
          if (SHUJUKU_OUTLINE_RE.test(comment)) outline = String(entry.content || '').trim();
        }
      }
      if (!summaryRows.length && !personRows.length && !outline) return '';

      const sections = [];
      if (summaryRows.length) {
        summaryRows.sort((a, b) => a.idx - b.idx);
        sections.push(`【数据库总结表】\n${summaryRows.map(r => r.content).join('\n')}`);
      }
      if (personRows.length) {
        personRows.sort((a, b) => a.idx - b.idx);
        sections.push(`【数据库重要人物】\n${personRows.map(r => r.content).join('\n')}`);
      }
      if (outline) sections.push(`【数据库剧情大纲】\n${outline}`);
      const text = sections.join('\n\n');
      return text.length > SHUJUKU_MAX_CHARS
        ? text.slice(0, SHUJUKU_MAX_CHARS) + '\n…（已截断）'
        : text;
    } catch (e) {
      warnBridgeOnce('读取数据库世界书条目', e);
      return '';
    }
  }

  // 表格导出为空时才回退世界书总结（两者是同一份数据的两种视图，不重复注入）
  async function getShujukuText() {
    const tableText = getShujukuTableText();
    if (tableText) return tableText;
    return await getShujukuWorldbookText();
  }

  // ---------- 汇总入口（evolution 调用） ----------
  // 单选：一次只接入一个外部数据源，绝不叠加注入。
  // 两个出口：
  //   buildBridgeSection   ——「外部数据源」主段（快照/表格等现状事实），仍在原位；
  //   buildHistorySection  ——历史剧情摘要，evolution 把它拼在「近期对话」正前方（时间连续）。
  // 未接入/读取失败一律返回 ''（不占分段）。
  const BRIDGE_SOURCES = ['off', 'baibaibook', 'shujuku'];

  function resolveBridgeSource() {
    try {
      const api = window.WORLD_ENGINE_API;
      const s = api && api.getSettings ? api.getSettings() : {};
      // 单选字段；若存有旧版双开关残留（3.1.0 早期双复选框版），迁移成单选值
      return BRIDGE_SOURCES.indexOf(s.bridgeSource) >= 0 ? s.bridgeSource
        : (s.bridgeBaibaibookEnabled === true ? 'baibaibook'
          : s.bridgeShujukuEnabled === true ? 'shujuku' : 'off');
    } catch (e) { return 'off'; }
  }

  async function buildBridgeSection() {
    const source = resolveBridgeSource();
    if (source === 'off') return '';

    let block = '';
    let label = '';
    if (source === 'baibaibook') {
      label = '柏宝书记忆快照（第三方插件，只读参照）';
      block = getBaibaibookSnapshotBlock();
    } else if (source === 'shujuku') {
      label = 'SP·数据库表格快照（第三方插件，只读参照）';
      block = await getShujukuText();
    }
    if (!block) return '';

    return `========== 外部数据源（第三方插件记忆） ==========
以下内容来自已接入的第三方记忆插件，是世界状态的重要参照：推演时应与其保持一致，不得凭空改写其中的人物、物品与事实；若与世界状态冲突，以正文剧情与外部数据为准更新世界状态。

■ ${label}
${block}`;
  }

  // 历史剧情摘要段：独立于主段，evolution 拼在「近期对话」正前方（时间连续）。
  // 仅柏宝书提供此类数据；其余数据源返回空串。
  function buildHistorySection() {
    if (resolveBridgeSource() !== 'baibaibook') return '';
    return getBaibaibookHistoryBlock();
  }

  return {
    BRIDGE_SOURCES,
    buildBridgeSection,
    buildHistorySection,
    getBaibaibookText,
    getShujukuText,
    getShujukuBoundary
  };
})();
