import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * 构建分流（01 §4）：
 *   web（默认） → PWA 启用、base = /--/（GitHub Pages：SMMT543345/--，Q3 已定）
 *   tauri       → PWA 关闭、base = /
 *   android     → PWA 关闭、base = /
 * 开发服务器一律用 base = '/'，否则本地要访问 /--/ 才能打开。
 *
 * PWA 插件属阶段 F，此处只留分支位置。
 */

type BuildTarget = 'web' | 'tauri' | 'android';

const BASE_BY_TARGET: Record<BuildTarget, string> = {
  // Q3 已定：GitHub Pages 仓库 SMMT543345/-- → 站点路径 /--/
  web: '/--/',
  tauri: '/',
  android: '/',
};

function resolveTarget(): BuildTarget {
  const raw = process.env.BUILD_TARGET;
  if (raw === 'tauri' || raw === 'android') return raw;
  return 'web';
}

export default defineConfig(({ command }) => {
  const target = resolveTarget();
  const isDev = command === 'serve';

  return {
    base: isDev ? '/' : BASE_BY_TARGET[target],
    // 构建目标注入到客户端（src/platform/build-target.ts）：
    // Service Worker 只在 web 构建注册（01 §4）
    define: { __BUILD_TARGET__: JSON.stringify(target) },
    plugins: [react(), tailwindcss()],
    build: {
      outDir: 'dist',
      target: 'es2022',
      emptyOutDir: true,
      // 桌面与安卓包内的资源不走 HTTP 缓存，sourcemap 便于真机排查
      sourcemap: !isDev && target !== 'web',
    },
    server: {
      port: 5173,
      strictPort: false,
    },
  };
});
