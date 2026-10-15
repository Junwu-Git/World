// 冒烟测试：验证 core.parseStoryDate 的通用正文日期提取（node docs/we-story-date-smoke-test.js）
// 覆盖：阿拉伯/中文数字年月日、全角字符、分隔符混用、号/日、初九/二十日；
//       仅月日（10月3日）年份继承同楼更早完整日期；正文多日期按「当前时间」语义选取
//       （当下线索加分、回溯线索扣分、同分取靠后）；思维链剥离；非法月日/仅年月/无年份 → null；
//       时刻（HH:MM / 深夜）提取。真实酒馆内 parseLatestStoryDay 的楼层遍历需手动验证。
global.window = {};
global.document = { getElementsByTagName: () => [] };

await import('../world-engine-core.js');
const core = window.WORLD_ENGINE_CORE;

const one = (text) => core.parseStoryDate(text);
const expect = (label, got, year, month, day, source, clock) => {
  const ok = got && got.year === year && got.month === month && got.day === day
    && (source === undefined || got.source === source)
    && (clock === undefined || got.clock === clock)
    && got.total === year * 360 + month * 30 + day;
  console.log(`${label}:`, JSON.stringify(got), ok ? 'PASS' : 'FAIL');
  return ok;
};

let allPass = true;
const check = (label, cond) => { console.log(`${label}:`, cond ? 'PASS' : 'FAIL'); if (!cond) allPass = false; };

// —— 格式识别 ——
expect('1) 2049/10/3', one('时间是2049/10/3。'), 2049, 10, 3, 'text');
expect('2) 2049-10-03', one('2049-10-03，清晨。'), 2049, 10, 3, 'text');
expect('3) 2049年10月3日', one('2049年10月3日'), 2049, 10, 3, 'text');
expect('4) 2049年10月3号', one('2049年10月3号'), 2049, 10, 3, 'text');
expect('5) 2049年十月三日', one('2049年十月三日'), 2049, 10, 3, 'text');
expect('6) 二〇二五年十月三日', one('二〇二五年十月三日'), 2025, 10, 3, 'text');
expect('7) 全角２０４９／１０／３', one('全角日期２０４９／１０／３在此'), 2049, 10, 3, 'text');
expect('8) 分隔符混用2049年10/3', one('2049年10/3'), 2049, 10, 3, 'text');
expect('9) 2049.10.3', one('2049.10.3'), 2049, 10, 3, 'text');
expect('10) 2049年10月二十日', one('2049年10月二十日'), 2049, 10, 20, 'text');
expect('11) 2049年10月初九', one('2049年10月初九'), 2049, 10, 9, 'text');
expect('12) 2049年10月31日', one('2049年10月31日'), 2049, 10, 31, 'text');

// —— 仅月日：年份继承同楼更靠前的完整日期 ——
expect('13) 10月3日继承同年份', one('故事从2049年1月1日开始。10月3日，他们抵达王都。'), 2049, 10, 3, 'text-md');
check('14) 仅月日无年份可继承 → null', one('10月3日，晴。') === null);
check('15) 仅月日在完整日期之前 → 不猜年份', one('10月3日之前，2049年1月1日什么都还没发生。') !== null && one('10月3日之前，2049年1月1日什么都还没发生。').year === 2049);

// —— 正文多日期 ——
expect('16) 当下线索胜过靠后的回溯日期', one('今天是2049年10月3日。回想起三年前的2046年10月3日，一切都不同了。'), 2049, 10, 3);
expect('17) 无线索同分取靠后', one('2046年10月3日他们相遇。此后风雨不断。2049年1月1日，新纪元开启。'), 2049, 1, 1);
expect('18) 唯一日期即使带回溯线索也返回', one('三年前的2046年10月3日，他离开了故乡，此后再未回来。'), 2046, 10, 3);
expect('19) 如今+十年前', one('如今已是2050年3月1日。而十年前，2040年3月1日的那场大雪依然刻骨铭心。'), 2050, 3, 1);

// —— 噪声与时刻 ——
expect('20) 剥离思维链里的旧日期', one('<think>回忆里那是2046年10月3日</think>现在是2049年10月3日深夜'), 2049, 10, 3, 'text', '深夜');
expect('21) HH:MM 时刻', one('2049/10/3 23:30，一切归于沉寂。'), 2049, 10, 3, 'text', '23:30');
expect('22) HTML 注释里的日期不算', one('<!-- 旧稿：2040年1月1日 -->2049年10月3日'), 2049, 10, 3);

// —— 拒绝误识别 ——
check('23) 非法月日 → null', one('2049年13月40日') === null);
check('24) 仅年月无日 → null', one('2049年10月，秋天来了') === null);
check('25) 五年期数字年份不匹配', one('12049年10月3日') === null);
check('26) 纯文本无日期 → null', one('今天天气不错，我们出发吧。') === null);
check('27) 空/非字符串 → null', one('') === null && one(null) === null && one(undefined) === null);

// —— 未来线索（明天/后天/计划）不当作当前时间 ——
expect('28) 明天是10月4日不抢当前日期', one('今天是2049年10月3日。他们说明天是10月4日出发。'), 2049, 10, 3);
check('29) 全文只有未来日期 → 仍返回唯一候选', (() => { const r = one('明天是2049年10月4日。'); return !!r && r.month === 10 && r.day === 4; })());

console.log(allPass ? 'ALL PASS' : 'SOME FAILED');
