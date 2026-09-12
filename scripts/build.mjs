#!/usr/bin/env node
/**
 * 跨平台构建入口（01 §4）：设置 BUILD_TARGET 后调用 vite build。
 * 不引入 cross-env —— 一个二十行的启动器即可，且少一个依赖（01 §2.1 的判断标准）。
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TARGETS = ['web', 'tauri', 'android'];
const target = process.argv[2];

if (typeof target !== 'string' || !TARGETS.includes(target)) {
  console.error(`用法：node scripts/build.mjs <${TARGETS.join('|')}>`);
  process.exit(2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const viteBin = resolve(root, 'node_modules', 'vite', 'bin', 'vite.js');

const result = spawnSync(process.execPath, [viteBin, 'build'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, BUILD_TARGET: target },
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

// web 构建：把 index.html 复制成 404.html。GitHub Pages 是静态托管，
// 用户刷新 /搜索 这类前端路由时会命中 404——Pages 约定：存在 404.html 时用
// 它当任意未知路径的回退，应用照常从地址里读出路由渲染（04 §8）。
if (target === 'web') {
  const dist = resolve(root, 'dist');
  copyFileSync(resolve(dist, 'index.html'), resolve(dist, '404.html'));
}

process.exit(result.status ?? 1);
