import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ui = fs.readFileSync(path.join(root, 'world-engine-ui.js'), 'utf8');
const ball = fs.readFileSync(path.join(root, 'world-engine-ui-ball.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const world = fs.readFileSync(path.join(root, 'world-engine.js'), 'utf8');

// 悬浮球已拆分到独立模块，右下角入口的运行状态与动效类在 ball 模块里。
assert.match(
  ball,
  /targetActive\s*=\s*Boolean\(callEngineFace\(target,\s*'isRunning'/,
  '右下角入口必须读取另一引擎的运行状态'
);
assert.match(
  ball,
  /classList\.toggle\('we-sat-engine-running',\s*targetActive\)/,
  '右下角入口必须随另一引擎状态切换运行动效类'
);
assert.match(
  css,
  /we-sat-target-memory\.we-sat-engine-running::before/,
  '记忆引擎入口必须有独立运行动效'
);
assert.match(
  css,
  /we-sat-target-world\.we-sat-engine-running::after/,
  '世界引擎入口必须有独立运行动效'
);

// 完成状态文案在提示词超预算时有裁剪变体，锚定状态字符串本身而非 setStatus 字面量。
const worldComplete = world.indexOf("'世界推演完成'");
const worldUiStop = world.indexOf('ui.setEvolvingUI(false)', worldComplete);
const worldUiRefresh = world.indexOf('ui.refresh(true)', worldComplete);
const memoryLinkStart = world.indexOf('await window.MEMORY_ENGINE?.ingestWorldEvolution?.');
assert.ok(worldComplete >= 0 && worldUiStop > worldComplete && worldUiRefresh > worldUiStop,
  '世界 API 完成后必须先停止世界动效并刷新世界界面');
assert.ok(memoryLinkStart > worldUiRefresh,
  '记忆联动必须在世界动效停止且界面刷新之后才开始');

console.log('engine switch animation tests passed');
