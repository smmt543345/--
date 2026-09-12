/**
 * 掌上图书馆 Service Worker（阶段 F，01 §4、04 §8）。
 *
 * 手写、零依赖（与 D8「依赖尽量少」一致）。只在 web 构建注册；
 * Tauri/Capacitor 里没有它（main.tsx 里按 BUILD_TARGET 把关）。
 *
 * 策略：
 * - 页面（navigate）网络优先，失败退回缓存 —— 每次上线都拿到新版本，断网时打底。
 * - 构建产物缓存优先 —— 文件名带内容哈希，命中即不可变，二次访问秒开、断网可用。
 * - activate 时清掉旧版本缓存名。
 *
 * 注意：本文件是纯 JS（不进 Vite 编译），改缓存策略时记得同步 bump 缓存名前缀版本。
 */
const CACHE_PREFIX = 'pocket-library-v1';
const SHELL_CACHE = `${CACHE_PREFIX}-shell`; // 页面文档
const ASSET_CACHE = `${CACHE_PREFIX}-assets`; // 带哈希的 js/css/字体等

self.addEventListener('install', () => {
  // 新 SW 一装上就接管，不等旧标签页关掉
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith('pocket-library-') && key !== SHELL_CACHE && key !== ASSET_CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // 外域（封面图、字体 CDN）不拦

  if (request.mode === 'navigate') {
    // 页面：网络优先，断网退回缓存（先精确匹配，再退到首页）
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          const cache = await caches.open(SHELL_CACHE);
          await cache.put(request, response.clone());
          return response;
        } catch {
          const cached = (await caches.match(request)) ?? (await caches.match('.'));
          if (cached !== undefined) return cached;
          return new Response('离线了，而且这台设备上还没有缓存。联网打开一次后即可离线使用。', {
            status: 503,
            statusText: 'Offline',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        }
      })(),
    );
    return;
  }

  // 静态资源：缓存优先，未命中回网络并顺手缓存
  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached !== undefined) return cached;
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(ASSET_CACHE);
          await cache.put(request, response.clone());
        }
        return response;
      } catch {
        return new Response('', { status: 504, statusText: 'Offline' });
      }
    })(),
  );
});
