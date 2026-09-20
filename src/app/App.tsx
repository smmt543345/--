/**
 * 路由表（04 §1）。
 *
 * 用 basename = Vite 的 BASE_URL：web 构建部署在 GitHub Pages 子路径
 * （/pocket-library/）下，写死 '/' 会让所有导航链接跳错地方。
 *
 * 页面代码按路由拆包（04 §11.16）：这里只引 `routes.tsx` 给的 lazy 组件，
 * 具体路径与空闲预取都在那一个文件里，别在这里再写一遍 import。
 */

import { useEffect, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom';

import { AppShell } from './AppShell.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import {
  BookDetailPage,
  LoansPage,
  LocationsPage,
  NewBookPage,
  OverviewPage,
  SearchPage,
  SettingsPage,
  prefetchRoutes,
} from './routes.tsx';

/**
 * 详情页按 id 强制重挂载：同路由从 A 切到 B 时 React 会复用组件实例，
 * 编辑草稿、打开的对话框会原样带到下一本书上。key 让它们随 id 一起重置。
 */
function BookDetailRoute(): ReactNode {
  const { id } = useParams<{ id: string }>();
  return <BookDetailPage key={id ?? ''} />;
}

export function App(): ReactNode {
  // 首屏渲染完成后补拉其余分块（04 §11.16）：既保住首屏体积，也保住断网可用。
  // StrictMode 下开发模式会跑两次，预取本身幂等（动态 import 有缓存），无副作用。
  useEffect(() => {
    prefetchRoutes();
  }, []);

  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <ErrorBoundary>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<OverviewPage />} />
            <Route path="search" element={<SearchPage />} />
            <Route path="locations" element={<LocationsPage />} />
            <Route path="loans" element={<LoansPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="books/new" element={<NewBookPage />} />
            <Route path="books/:id" element={<BookDetailRoute />} />
            {/* 拼错或旧链接：回首页，而不是空白页 */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </ErrorBoundary>
    </BrowserRouter>
  );
}
