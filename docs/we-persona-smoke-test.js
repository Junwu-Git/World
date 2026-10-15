// 冒烟测试：验证用户人设段构建（node docs/we-persona-smoke-test.js）
// 覆盖：buildPersonaSectionText 的空描述/超长截断/{{user}} 占位；buildPersonaSection 的
//       开关门控与读取失败 fail-safe（node 环境无 /scripts/power-user.js）；段落与
//       renderUserName 的衔接（{{user}} → name1）。
//       真实酒馆内 power_user.persona_description / persona_description_position 的
//       实时取值（含 position=NONE 时不注入）需在酒馆内手动验证。
global.window = {};
global.document = { getElementsByTagName: () => [] };
global.SillyTavern = { getContext: () => ({ name1: '扮演者甲', name2: '角色乙' }) };

await import('../world-engine-core.js');
const core = window.WORLD_ENGINE_CORE;

let pass = 0, fail = 0;
function check(name, ok, extra) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || extra === undefined ? '' : ' -> ' + JSON.stringify(extra)}`);
  ok ? pass++ : fail++;
}

// 1) 空描述 → 空段（人设未填时静默不注入）
check('1) 空描述返回空段', core.buildPersonaSectionText('') === '' && core.buildPersonaSectionText('   ') === '' && core.buildPersonaSectionText(null) === '');

// 2) 正常描述 → 含段头、原文与使用说明；保留 {{user}} 占位（由 renderUserName 统一展开）
const seg = core.buildPersonaSectionText('青云宗外门弟子，擅长剑术，与师姐林霜交好。');
check('2) 正常描述成段', seg.startsWith('========== 用户人设（{{user}} 的角色设定）==========')
  && seg.includes('青云宗外门弟子，擅长剑术，与师姐林霜交好。')
  && seg.includes('以本设定为准'), seg);

// 3) 超 4000 字截断（截断标记随段发出，不静默丢内容）
const long = '甲'.repeat(5000);
const longSeg = core.buildPersonaSectionText(long);
check('3) 超长截断', longSeg.includes('甲'.repeat(4000)) && longSeg.includes('…（已截断）') && !longSeg.includes('甲'.repeat(4001)), longSeg.length);

// 4) 开关关闭 → 空段（不读酒馆）
const off = await core.buildPersonaSection(false);
check('4) 开关关闭为空', off === '');

// 5) 开关打开但酒馆脚本模块不可用（node 环境）→ 静默为空，不抛错
let threw = false, on = null;
try { on = await core.buildPersonaSection(true); } catch (e) { threw = true; }
check('5) 读取失败 fail-safe', !threw && on === '');

// 6) getPersonaDescription 读不到时返回 null，不抛错
let pd = 'unset', pdThrew = false;
try { pd = await core.getPersonaDescription(); } catch (e) { pdThrew = true; }
check('6) 人设读取返回 null', !pdThrew && pd === null);

// 7) 段落与 renderUserName 衔接：{{user}} 展开为 name1，其余原样
const expanded = core.renderUserName(core.buildPersonaSectionText('与{{user}}相关的人设'));
check('7) 段落内 {{user}} 展开', expanded.includes('========== 用户人设（扮演者甲 的角色设定）==========') && expanded.includes('与扮演者甲相关的人设') && !expanded.includes('{{user}}'), expanded);

console.log(`\n${fail === 0 ? '全部通过' : '存在失败'}：${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
