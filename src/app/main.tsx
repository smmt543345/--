/**
 * 应用入口（04 §4、§8）。index.html 里 <script> 指的就是这个文件。
 * 这里只做三件事：引样式、挂载 React、出错时在页面上留下一句话。
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './index.css';
import { Root } from './Root.tsx';
import { BUILD_TARGET } from '../platform/build-target.ts';

// PWA 只在 web 构建注册（01 §4）：Tauri/Capacitor 里 Service Worker 没有意义，
// 还会让资源缓存难以调试。注册是尽力而为——失败不影响应用本身。
if (import.meta.env.PROD && BUILD_TARGET === 'web') {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .catch(() => undefined);
  });
}

const container = document.getElementById('root');
if (container === null) {
  throw new Error('页面缺少 #root 容器，无法挂载应用');
}

createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
