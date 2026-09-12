/**
 * 路由表（04 §1）。
 *
 * 用 basename = Vite 的 BASE_URL：web 构建部署在 GitHub Pages 子路径
 * （/pocket-library/）下，写死 '/' 会让所有导航链接跳错地方。
 */

import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom';

import { AppShell } from './AppShell.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { BookDetailPage } from '../features/books/BookDetailPage.tsx';
import { NewBookPage } from '../features/books/NewBookPage.tsx';
import { LoansPage } from '../features/loans/LoansPage.tsx';
import { LocationsPage } from '../features/locations/LocationsPage.tsx';
import { OverviewPage } from '../features/overview/OverviewPage.tsx';
import { SearchPage } from '../features/search/SearchPage.tsx';
import { SettingsPage } from '../features/settings/SettingsPage.tsx';

/**
 * 详情页按 id 强制重挂载：同路由从 A 切到 B 时 React 会复用组件实例，
 * 编辑草稿、打开的对话框会原样带到下一本书上。key 让它们随 id 一起重置。
 */
function BookDetailRoute(): ReactNode {
  const { id } = useParams<{ id: string }>();
  return <BookDetailPage key={id ?? ''} />;
}

export function App(): ReactNode {
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
