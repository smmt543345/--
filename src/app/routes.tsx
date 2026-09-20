/**
 * 路由级拆包与空闲预取（04 §11.16）。
 *
 * 七个页面做成 `lazy()` 按需加载：首屏只下载「外壳 + 当前页」，其余分块等浏览器空闲再补拉。
 * 两件事必须同时成立，少一件都是退步：
 * - **首屏快**：入口包里不再装七个页面的代码；
 * - **离线可用**（01 §8 F 行验收：断网仍能打开并检索已有数据）—— 靠空闲预取把其余分块提前
 *   存进 Service Worker 的运行时缓存。**不预取的话，没访问过的页面断网就打不开**。
 *
 * 加载器只此一份（`PAGE_LOADERS`）：`lazy()` 与预取共用，路径不会在两处各写一遍而慢慢走偏。
 */

import { lazy } from 'react';

/**
 * 页面加载器：命名导出的页面 → `lazy()` 要的 `{ default }` 形状。
 * 加页面时在这里加一行，`lazy()` 与预取自动都拿到。
 */
const PAGE_LOADERS = {
  overview: () => import('../features/overview/OverviewPage.tsx').then(({ OverviewPage }) => ({ default: OverviewPage })),
  search: () => import('../features/search/SearchPage.tsx').then(({ SearchPage }) => ({ default: SearchPage })),
  locations: () => import('../features/locations/LocationsPage.tsx').then(({ LocationsPage }) => ({ default: LocationsPage })),
  loans: () => import('../features/loans/LoansPage.tsx').then(({ LoansPage }) => ({ default: LoansPage })),
  settings: () => import('../features/settings/SettingsPage.tsx').then(({ SettingsPage }) => ({ default: SettingsPage })),
  newBook: () => import('../features/books/NewBookPage.tsx').then(({ NewBookPage }) => ({ default: NewBookPage })),
  bookDetail: () => import('../features/books/BookDetailPage.tsx').then(({ BookDetailPage }) => ({ default: BookDetailPage })),
} as const;

export const OverviewPage = lazy(PAGE_LOADERS.overview);
export const SearchPage = lazy(PAGE_LOADERS.search);
export const LocationsPage = lazy(PAGE_LOADERS.locations);
export const LoansPage = lazy(PAGE_LOADERS.loans);
export const SettingsPage = lazy(PAGE_LOADERS.settings);
export const NewBookPage = lazy(PAGE_LOADERS.newBook);
export const BookDetailPage = lazy(PAGE_LOADERS.bookDetail);

/** 省流量模式：`navigator.connection.saveData` 不是标准 TS 成员，这里按形状取。 */
function saveDataOn(): boolean {
  const nav = navigator as Navigator & { connection?: { saveData?: boolean } };
  return nav.connection?.saveData === true;
}

type IdleScheduler = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
};

/**
 * 冷启动竞态（审查意见 #1）：SW 在 `window` 的 load 事件里才注册（`main.tsx`），
 * 而且要等 activate 里的 `clients.claim()` 才接管页面；而本预取在挂载后就排期，很可能抢在它前面。
 * 抢在前面的话，这些分块请求**不经过 SW、不会写进离线缓存**——「把离线能力补回来」就白做一次。
 * 所以：有 SW 但还没接管时先等接管；没有 SW（dev / Tauri / Capacitor）照常预取。
 */
function whenOfflineCacheReady(): Promise<void> {
  const container = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker;
  if (container === undefined || container.controller !== null) return Promise.resolve();
  // `ready` 在压根没有注册时会一直挂着（dev 就是这种），加个上限别把预取永远卡住
  const registered = container.ready.then(() => undefined);
  const giveUp = new Promise<void>((resolve) => setTimeout(resolve, 3000));
  return Promise.race([registered, giveUp]).catch(() => undefined);
}

/**
 * 首屏渲染完成后补拉其余分块（04 §11.16）。
 * - 省流量模式（`saveData`）直接不预取：用户明确说过别浪费流量。
 * - 失败静默：预取只是优化，真要点那个页面时按需加载仍会成功，不该因此报错。
 */
export function prefetchRoutes(): void {
  if (saveDataOn()) return;

  void whenOfflineCacheReady().then(() => {
    const pull = (): void => {
      for (const load of Object.values(PAGE_LOADERS)) {
        void load().catch(() => undefined);
      }
    };

    const scheduler = window as IdleScheduler;
    if (typeof scheduler.requestIdleCallback === 'function') {
      scheduler.requestIdleCallback(pull, { timeout: 3000 });
      return;
    }
    // Safari 到 18 才有 requestIdleCallback：没有就退化成「首屏之后稍等一会儿」
    setTimeout(pull, 1500);
  });
}
