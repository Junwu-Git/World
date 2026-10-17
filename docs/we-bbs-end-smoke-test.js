// 冒烟测试：<bbs_end> 时间标签配对 + 思维链剥离 + 点分隔日期
//   node docs/we-bbs-end-smoke-test.js
// 覆盖：思维链裸提及劫持（①）、<think_nya~> 等自定义思维链剥离（②）、点分隔日期（③）、
//       跨午夜取结束时刻、多标签倒序配对、无日期标签对退让、未闭合思维链、旧格式回归。
//
// parseBaiBaiEndDay 在下面按实现同构复刻（不动态执行源码），并在启动时做「源码漂移校验」：
// 逐条断言 world-engine.js 里确实存在本测试所依赖的正则与配对结构，实现改了而测试没跟上会直接报错。
import fs from 'node:fs';

global.window = {};
global.document = { getElementsByTagName: () => [] };

await import('../world-engine-core.js');
const core = window.WORLD_ENGINE_CORE;

// ===== 源码漂移校验：实现里的关键片段必须存在 =====
const src = fs.readFileSync(new URL('../world-engine.js', import.meta.url), 'utf8');
const driftChecks = [
  ['思维链剥离正则', '/<(think(?:ing)?)[^>]*>[\\s\\S]*?<\\/\\1[^>]*>/gi'],
  ['开标签正则', '/<bbs_end\\b[^>]*>/gi'],
  ['闭标签正则', '/<\\/bbs_end\\s*>/gi'],
  ['日期正则（含点分隔）', '/(\\d{4})\\s*[/\\-年.]\\s*(\\d{1,2})\\s*[/\\-月.]\\s*(\\d{1,2})/'],
  ['闭标签倒序配对', 'for (let k = closes.length - 1; k >= 0 && !dm; k--)'],
  ['HTML 注释剥离', ".replace(/<!--[\\s\\S]*?-->/g, ' ')"]
];
let driftOk = true;
for (const [label, frag] of driftChecks) {
  const ok = src.includes(frag);
  if (!ok) { driftOk = false; console.error(`源码漂移校验失败：world-engine.js 里找不到「${label}」片段 -> ${frag}`); }
}
if (!driftOk) { console.error('\n实现已变更，请同步更新本测试。'); process.exit(1); }
console.log('源码漂移校验：PASS（实现与测试同构）\n');

// ===== 与 world-engine.js 同构的实现 =====
const thinkRe = /<(think(?:ing)?)[^>]*>[\s\S]*?<\/\1[^>]*>/gi;
const openRe = /<bbs_end\b[^>]*>/gi;
const closeRe = /<\/bbs_end\s*>/gi;
const dateRe = /(\d{4})\s*[/\-年.]\s*(\d{1,2})\s*[/\-月.]\s*(\d{1,2})/;
function parseBaiBaiEndDay(chat) {
  for (let i = (Array.isArray(chat) ? chat.length : 0) - 1; i >= 0; i--) {
    const m = chat[i];
    if (!m || m.is_user || m.is_system) continue;
    const text = String(m.mes || '')
      .replace(thinkRe, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ');
    const closes = Array.from(text.matchAll(closeRe));
    if (!closes.length) continue;
    let inner = null, dm = null;
    for (let k = closes.length - 1; k >= 0 && !dm; k--) {
      const opens = Array.from(text.slice(0, closes[k].index).matchAll(openRe));
      if (!opens.length) continue;
      const open = opens[opens.length - 1];
      const body = text.slice(open.index + open[0].length, closes[k].index);
      dm = body.match(dateRe);
      if (dm) inner = body;
    }
    if (!inner) continue;
    const year = parseInt(dm[1], 10);
    const month = parseInt(dm[2], 10);
    const day = parseInt(dm[3], 10);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) continue;
    const rest = inner.slice(dm.index + dm[0].length);
    const clockM = rest.match(/(\d{1,2}\s*[:：]\s*\d{2}|凌晨|清晨|早晨|上午|中午|下午|傍晚|黄昏|晚上|深夜|午夜|子夜|黎明|拂晓)/);
    return { year, month, day, total: year * 360 + month * 30 + day, floor: i, source: 'baibai-tag', clock: clockM ? clockM[1].replace(/\s+/g, '') : null };
  }
  return null;
}

const tagOf = (text) => parseBaiBaiEndDay([{ mes: text }]);
const total = (y, m, d) => y * 360 + m * 30 + d;

let allPass = true;
const check = (label, cond, extra) => {
  console.log(`${label}:`, cond ? 'PASS' : `FAIL ${extra === undefined ? '' : JSON.stringify(extra)}`);
  if (!cond) allPass = false;
};

// ===== ① 思维链裸提及不再劫持配对（用户实测形态）=====
const bareMention = '<think_nya~>\n锚点<bbs_start>和<bbs_end>不能忘！\n</think_nya~>\n<game>\n<bbs_start>第四纪元7482/8/15 08:05</bbs_start>\n正文……\n<bbs_end>第四纪元7482/8/15 08:12</bbs_end>\n</game>';
let r = tagOf(bareMention);
check('1) 思维链裸提及 → 取结束时刻 08:12',
  !!r && r.year === 7482 && r.month === 8 && r.day === 15 && r.clock === '08:12', r);

// ===== ② 跨午夜：必须取结束日（次日），不是开始日 =====
const crossMidnight = '<think_nya~>\n锚点<bbs_start>和<bbs_end>喵\n</think_nya~>\n<game>\n<bbs_start>2071/10/1 23:50</bbs_start>\n正文……\n<bbs_end>2071/10/2 00:05</bbs_end>\n</game>';
r = tagOf(crossMidnight);
check('2) 跨午夜 → 取次日 2071/10/2 00:05',
  !!r && r.year === 2071 && r.month === 10 && r.day === 2 && r.clock === '00:05', r);

// ===== ③ 思维链里完整无日期标签对 → 不再把整楼判成「有标签无日期」而跳过 =====
const noDatePairInCot = '<think_nya~>\n格式是 <bbs_end>时间</bbs_end> 这样喵\n</think_nya~>\n<game>\n<bbs_start>第四纪元7482/8/15 08:05</bbs_start>\n正文……\n<bbs_end>第四纪元7482/8/15 08:12</bbs_end>\n</game>';
r = tagOf(noDatePairInCot);
check('3) 思维链无日期标签对 → 仍取真实结束时刻',
  !!r && r.day === 15 && r.clock === '08:12', r);

// ===== ④ 思维链里复述旧日期 → 不入选 =====
const cotOldDate = '<think_nya~>\n上一轮是 <bbs_end>第四纪元7482/8/14 23:00</bbs_end>，这轮推进\n</think_nya~>\n<game>\n<bbs_start>第四纪元7482/8/15 08:05</bbs_start>\n正文……\n<bbs_end>第四纪元7482/8/15 08:12</bbs_end>\n</game>';
r = tagOf(cotOldDate);
check('4) 思维链旧日期 → 取正文结束时刻 8/15 08:12',
  !!r && r.day === 15 && r.clock === '08:12', r);

// ===== ⑤ 点分隔日期（JSONPatch 写法）=====
r = tagOf('<game>\n<bbs_start>第四纪元7482.8.15 08:05</bbs_start>\n正文……\n<bbs_end>第四纪元7482.8.15 08:12</bbs_end>\n</game>');
check('5) 点分隔 7482.8.15 → 能识别', !!r && r.year === 7482 && r.month === 8 && r.day === 15, r);

// ===== ⑥ 旧格式回归：无思维链污染 =====
r = tagOf('<game>\n<bbs_start>2024/7/15 15:00</bbs_start>\n正文……\n<bbs_end>2024/7/15 15:15</bbs_end>\n</game>');
check('6) 旧格式 2024/7/15 15:15 → 取结束时刻', !!r && r.year === 2024 && r.day === 15 && r.clock === '15:15', r);

// ===== ⑦ 未闭合思维链（AI 输出被截断）=====
const unclosed = '<think_nya~>\n锚点<bbs_start>和<bbs_end>\n<game>\n<bbs_start>第四纪元7482/8/15 08:05</bbs_start>\n正文……\n<bbs_end>第四纪元7482/8/15 08:12</bbs_end>\n</game>';
r = tagOf(unclosed);
check('7) 未闭合思维链 → 仍取 08:12（按闭标签倒序配对）', !!r && r.clock === '08:12', r);

// ===== ⑧ 最后那对无日期 → 退到前一对有日期的 =====
r = tagOf('<game>\n<bbs_start>第四纪元7482/8/15 08:05</bbs_start>\n<bbs_end>第四纪元7482/8/15 08:12</bbs_end>\n<bbs_end>待定</bbs_end>\n</game>');
check('8) 末尾无日期标签对 → 退到 08:12', !!r && r.clock === '08:12', r);

// ===== ⑨ 整楼无有效日期 → 返回 null（交给正文回退路径）=====
check('9) 无日期 → null', parseBaiBaiEndDay([{ mes: '<think_nya~>\n锚点<bbs_start>和<bbs_end>\n</think_nya~>\n今天天气不错。' }]) === null);

// ===== ⑩ 楼层跳过：用户楼 / 系统楼 =====
check('10) 用户楼与系统楼不参与标签解析',
  parseBaiBaiEndDay([
    { mes: '<bbs_end>2020/1/1 00:00</bbs_end>', is_user: true },
    { mes: '<bbs_end>2021/1/1 00:00</bbs_end>', is_system: true }
  ]) === null);

// ===== ⑪ 从聊天末尾往前扫：取最新一楼的标签 =====
r = parseBaiBaiEndDay([
  { mes: '<bbs_end>2024/7/15 10:00</bbs_end>' },
  { mes: '用户发言', is_user: true },
  { mes: '<bbs_end>2024/7/16 07:45</bbs_end>' }
]);
check('11) 多楼取最新一楼（2024/7/16 07:45）', !!r && r.day === 16 && r.clock === '07:45', r);

// ===== ⑫ 思维链剥离覆盖变体（core.parseStoryDate）=====
for (const v of ['<think>', '<thinking>', '<think_nya~>', '<think-nya>', '<think_cot>']) {
  const close = v.replace('<', '</');
  const res = core.parseStoryDate(`${v}旧时间 2046年10月3日${close}现在是2049年10月3日`);
  check(`12) 思维链变体 ${v} 被剥离`, !!res && res.candidateCount === 1 && res.year === 2049, res);
}

// ===== ⑬ 思维链剥离不误伤正文 =====
const notCot = '他think了一下，2049年10月3日出发。';
check('13) 普通文本含 think 字样不受影响', !!core.parseStoryDate(notCot) && core.parseStoryDate(notCot).year === 2049);

// ===== ⑭ 真实形态回归（用户活跃聊天楼 3 的标签结构）=====
const realLike = '<think_nya~>\n喵呜~\n- 字数必须超过1000字，不能偷懒，还要加上完整的时间锚点<bbs_start>和<bbs_end>！\n好啦，本喵的爪爪已经准备好了，马上开写喵！\n</think_nya~>\n<game>\n<bbs_start>第四纪元7482/8/15 08:05</bbs_start>\n' + '正文'.repeat(900) + '\n<bbs_end>第四纪元7482/8/15 08:12</bbs_end>\n</game>\n<StatusPlaceHolderImpl/>';
r = tagOf(realLike);
check('14) 真实形态（裸提及 + 长正文）→ 08:12', !!r && r.clock === '08:12' && r.total === total(7482, 8, 15), r);

console.log(allPass ? '\nALL PASS' : '\nSOME FAILED');
