// 冒烟测试：验证 core.filterDialogue 的酒馆正则开关行为（node docs/we-filter-smoke-test.js）
// 覆盖：开关关闭=旧行为；酒馆模块缺失=静默降级只跑本地正则且仅警告一次；stRegexReady 就绪查询；
//       /pat/flags 字面量。（真实酒馆引擎的命中行为需在酒馆内手动验证）
global.window = {};
// 无匹配 script 标签 → 预加载器找不到 regex/engine.js → _stRegexModule 保持 null（模拟模块未就绪）
global.document = { getElementsByTagName: () => [] };

await import('../world-engine-core.js');
await new Promise(resolve => setTimeout(resolve, 50));   // 等预加载器跑完（此处应无模块加载）
const core = window.WORLD_ENGINE_CORE;

const settings = { evolveFilterRegex: '<details>[\\s\\S]*?</details>' };
const text = '前文<details>秘密</details>后文';

const r1 = core.filterDialogue(text, settings);
console.log('1) 关闭开关:', JSON.stringify(r1), r1 === '前文后文' ? 'PASS' : 'FAIL');

// 开关开启但酒馆模块未就绪：酒馆步骤原样返回（仅警告一次），本地正则照常生效
const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => warnings.push(args.join(' '));
const r2 = core.filterDialogue(text, { filterUseStRegex: true, evolveFilterRegex: settings.evolveFilterRegex });
const r2b = core.filterDialogue(text, { filterUseStRegex: true, evolveFilterRegex: settings.evolveFilterRegex });
console.warn = originalWarn;
const ok2 = r2 === '前文后文' && r2b === '前文后文' && warnings.length === 1;
console.log('2) 模块缺失降级:', JSON.stringify(r2), ok2 ? 'PASS' : 'FAIL 警告次数=' + warnings.length);

// 开关开启且本地正则留空：无模块时原样返回，不抛错
const r3 = core.filterDialogue(text, { filterUseStRegex: true }, null, { isUser: false, depth: 0 });
console.log('3) 空正则无模块:', JSON.stringify(r3), r3 === text ? 'PASS' : 'FAIL');

// /pattern/flags 字面量（本地正则）不受影响
const r4 = core.filterDialogue('x<details>a</details>y', { evolveFilterRegex: '/<details>[\\s\\S]*?<\\/details>/g' });
console.log('4) 字面量写法:', JSON.stringify(r4), r4 === 'xy' ? 'PASS' : 'FAIL');

// 就绪查询在无模块时安全返回
console.log('5) 就绪查询:', core.stRegexReady() === false ? 'PASS' : 'FAIL');
