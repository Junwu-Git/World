#!/usr/bin/env node
// 测试入口：依次执行 docs/ 下所有 *-test.js（Node ESM，纯离线断言）。
// 用法：npm test                     —— 跑全部
//       npm test -- --filter memory  —— 只跑文件名包含 memory 的用例
//       npm test -- --list           —— 只列出会跑哪些文件
// 子进程用 inherit 直连终端：管道捕获在某些受限环境（如沙箱）会被拒绝。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = path.join(root, 'docs');

const args = process.argv.slice(2);
const filterIndex = args.indexOf('--filter');
const filter = filterIndex >= 0 ? args[filterIndex + 1] : '';
const listOnly = args.includes('--list');

const files = fs.readdirSync(docsDir)
  .filter(name => name.endsWith('-test.js'))
  .filter(name => !filter || name.includes(filter))
  .sort();

if (files.length === 0) {
  console.error(filter ? `没有匹配 "${filter}" 的测试文件` : 'docs/ 下没有找到 *-test.js');
  process.exit(1);
}

if (listOnly) {
  for (const name of files) console.log(name);
  process.exit(0);
}

const failures = [];
const startedAt = Date.now();

for (const name of files) {
  const file = path.join(docsDir, name);
  const started = Date.now();
  const result = spawnSync(process.execPath, [file], { cwd: root, stdio: 'inherit' });
  const cost = Date.now() - started;

  if (result.status === 0) {
    console.log(`✓ ${name} (${cost}ms)`);
  } else {
    failures.push(name);
    console.log(`✗ ${name} (退出码 ${result.status}, ${cost}ms)`);
  }
}

const total = Date.now() - startedAt;
if (failures.length > 0) {
  console.error(`\n失败 ${failures.length}/${files.length}：${failures.join(', ')}（共 ${total}ms）`);
  process.exit(1);
}
console.log(`\n全部通过：${files.length} 个测试文件（共 ${total}ms）`);
