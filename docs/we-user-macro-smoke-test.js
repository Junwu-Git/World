// 冒烟测试：验证 core.renderUserName 的用户宏展开（node docs/we-user-macro-smoke-test.js）
// 覆盖：{{user}}、<user>/<USER>（酒馆遗留宏，见 macros.js evaluateMacros preEnvMacros）展开为
//       name1；大小写不敏感；其他宏（{{char}} 等）不受影响；非字符串原样返回；幂等；
//       name2/角色名回退与无酒馆环境时的默认值。
//       真实酒馆内 ctx.name1 的实时取值需在酒馆内手动验证。
global.window = {};
global.document = { getElementsByTagName: () => [] };
global.SillyTavern = { getContext: () => ({ name1: '扮演者甲', name2: '角色乙' }) };

await import('../world-engine-core.js');
const core = window.WORLD_ENGINE_CORE;

const r1 = core.renderUserName('不得凭空定位 {{user}}；');
console.log('1) {{user}} 花括号宏:', JSON.stringify(r1), r1 === '不得凭空定位 扮演者甲；' ? 'PASS' : 'FAIL');

const r2 = core.renderUserName('<user>的房间 <USER>的道具');
console.log('2) <user> 遗留宏(大小写):', JSON.stringify(r2), r2 === '扮演者甲的房间 扮演者甲的道具' ? 'PASS' : 'FAIL');

const r3 = core.renderUserName('{{USER}}与{{User}}和{{user}}');
console.log('3) 花括号宏大小写:', JSON.stringify(r3), r3 === '扮演者甲与扮演者甲和扮演者甲' ? 'PASS' : 'FAIL');

const r4 = core.renderUserName('{{char}}与{{random}}原样保留');
console.log('4) 其他宏不受影响:', JSON.stringify(r4), r4 === '{{char}}与{{random}}原样保留' ? 'PASS' : 'FAIL');

const r5 = core.renderUserName(null);
console.log('5) 非字符串原样返回:', r5 === null ? 'PASS' : 'FAIL');

const once = core.renderUserName('{{user}}和<user>');
const twice = core.renderUserName(once);
console.log('6) 幂等(二次替换无变化):', once === twice && twice === '扮演者甲和扮演者甲' ? 'PASS' : 'FAIL');

// 无 name1 时回退 name2
global.SillyTavern = { getContext: () => ({ name2: '角色乙' }) };
const r7 = core.renderUserName('{{user}}');
console.log('7) name1 缺失回退 name2:', JSON.stringify(r7), r7 === '角色乙' ? 'PASS' : 'FAIL');

// 无酒馆环境时静默回退默认名，不抛错
global.SillyTavern = { getContext: () => { throw new Error('no ctx'); } };
let r8 = null, threw = false;
try { r8 = core.renderUserName('{{user}}'); } catch (e) { threw = true; }
console.log('8) 无酒馆环境默认名:', JSON.stringify(r8), !threw && r8 === '用户' ? 'PASS' : 'FAIL');
