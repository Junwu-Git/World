#!/usr/bin/env node
// 语法检查：对扩展本体与测试脚本逐个执行 `node --check`，不运行代码、不联网。
// 用途是提交前挡住括号/引号这类会让酒馆整页白屏的低级错误。
// 子进程用 inherit 直连终端：管道捕获在某些受限环境（如沙箱）会被拒绝。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.mimosa', '.zcode', '.claude', '.dsh-acl-repair']);
const SCAN_DIRS = new Set(['.', 'docs', 'scripts']);

function collect(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (dir === root && !SCAN_DIRS.has(entry.name)) continue;
      found.push(...collect(path.join(dir, entry.name)));
    } else if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name) && !entry.name.endsWith('.min.js')) {
      found.push(path.join(dir, entry.name));
    }
  }
  return found;
}

const files = collect(root).sort();
let failed = 0;

for (const file of files) {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) {
    failed += 1;
    console.error(`✗ ${rel}（退出码 ${result.status}）`);
  }
}

if (failed > 0) {
  console.error(`\n语法检查失败：${failed}/${files.length} 个文件`);
  process.exit(1);
}
console.log(`语法检查通过：${files.length} 个文件`);
