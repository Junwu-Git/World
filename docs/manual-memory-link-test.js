// 手动世界→记忆联动入口静态回归测试：node docs/manual-memory-link-test.js
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const world = fs.readFileSync(path.join(root, 'world-engine.js'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'world-engine-ui.js'), 'utf8');

assert.ok(world.includes('async function manualMemoryLink()'));
assert.ok(world.includes('window.MEMORY_ENGINE?.ingestWorldEvolution?.({'));
assert.ok(world.includes('replace: true'));
assert.ok(world.includes('force: true'));
assert.ok(world.includes('window.WORLD_ENGINE = { applyInjection') && world.includes('manualMemoryLink,'),
  '手动联动入口必须经 window.WORLD_ENGINE 导出');
assert.ok(ui.includes('id="we-memory-link-now"'));
assert.ok(ui.includes('window.WORLD_ENGINE?.manualMemoryLink?.()'));

console.log('manual memory link tests passed');
