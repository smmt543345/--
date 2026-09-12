#!/usr/bin/env node
/**
 * 本地预览服务器（web 构建专用，零依赖）。
 *
 * 为什么不用 `vite preview`：web 构建的 base 是 `/pocket-library/`（GitHub Pages
 * 子路径，01 §4），而 vite preview 把 dist 直接摊在根路径 `/` 上——页面靠 SPA
 * 回退还能打开，但 `/pocket-library/assets/*`、`sw.js`、`manifest.webmanifest`
 * 全部会回退成 index.html，应用实际跑不起来，PWA 也装不上。
 *
 * 本脚本把 `/pocket-library/*` 正确映射到 dist 里的文件，其余路径做 SPA 回退，
 * 行为与 GitHub Pages 的静态托管一致。部署到 Pages 后这份脚本就不再需要。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist');
// 与 vite.config.ts 的 web base 保持一致（Q3：SMMT543345/新作）
const BASE = '/新作/';
const PORT = 4173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const INDEX = 'index.html';

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': status === 200 && body !== INDEX ? 'public, max-age=3600' : 'no-cache',
  });
  res.end(body);
}

/** 把请求路径映射到 dist 内文件；越界或不存在返回 null（走 SPA 回退）。 */
async function resolveFile(pathname) {
  let rel = pathname;
  if (rel === BASE || rel === BASE.slice(0, -1)) rel = '';
  else if (rel.startsWith(BASE)) rel = rel.slice(BASE.length);
  else return { missing: true }; // 不在 base 下：交给根路径重定向处理

  if (rel === '') rel = INDEX;
  const file = resolve(DIST, rel);
  // 防越界：规范化后必须还在 dist 里
  if (file !== DIST && !file.startsWith(DIST + sep)) return { missing: true };
  try {
    const body = await readFile(file);
    return { body, type: MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' };
  } catch {
    return { missing: true };
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  // 浏览器会把 /新作/ 按百分号编码发来，先解码再比较；Location 头必须回 ASCII（Node 拒绝裸中文）
  let pathname = url.pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    // 非法编码的请求保持原样，交给下面的路径判断处理
  }
  // 根路径直接跳进 base，与部署后的真实入口一致
  if (!pathname.startsWith(BASE)) {
    res.writeHead(302, { Location: encodeURI(BASE) });
    res.end();
    return;
  }
  const found = await resolveFile(pathname);
  if (!found.missing) {
    send(res, 200, found.body, found.type);
    return;
  }
  // SPA 回退：/pocket-library/search 这类前端路由 → index.html
  try {
    const html = await readFile(join(DIST, INDEX));
    send(res, 200, html, MIME['.html']);
  } catch {
    send(res, 404, 'dist 目录不存在，先跑 npm run build:web', 'text/plain; charset=utf-8');
  }
}).listen(PORT, () => {
  console.log(`掌上图书馆（web 构建）已在运行：`);
  console.log(`  http://localhost:${PORT}${BASE}`);
  console.log('按 Ctrl+C 停止。');
});
