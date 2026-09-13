/**
 * 应用外壳（04 §2）：导航 + 全局「＋ 新增书目」+ 内容区。
 *
 * 窄屏底部标签栏、宽屏左侧边栏，读的是同一份 NAV_ITEMS。
 */

import type { ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router-dom';

import { NAV_ITEMS } from './nav.tsx';
import { buttonClass, cn } from './ui.tsx';
import { UndoBanner } from './UndoBanner.tsx';

const ICON_URL = `${import.meta.env.BASE_URL}icons/icon-192.png`;

/** 侧边栏项：宽屏用，带文字说明。激活态左侧一道朱线，像书页边的朱笔标记。 */
function SidebarLink({ to, label, hint, icon }: (typeof NAV_ITEMS)[number]): ReactNode {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) =>
        cn(
          'relative flex items-start gap-3 rounded-xl px-3 py-2 text-sm transition-colors',
          isActive
            ? 'bg-blue-600/[0.08] font-medium text-blue-800 ring-1 ring-inset ring-blue-600/15 dark:bg-blue-400/10 dark:text-blue-200 dark:ring-blue-400/20'
            : 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800',
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span aria-hidden="true" className="absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-full bg-red-600 dark:bg-red-500" />
          )}
          <span className="mt-0.5 shrink-0">{icon}</span>
          <span className="min-w-0">
            <span className="block">{label}</span>
            <span className="mt-0.5 block text-xs text-neutral-400 dark:text-neutral-500">{hint}</span>
          </span>
        </>
      )}
    </NavLink>
  );
}

/** 底部标签项：窄屏用，只有图标与短名。激活态顶部一道朱线。 */
function TabLink({ to, label, icon }: (typeof NAV_ITEMS)[number]): ReactNode {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) =>
        cn(
          'relative flex min-h-14 flex-1 flex-col items-center justify-center gap-1 px-1 text-[11px] transition-colors',
          isActive ? 'text-blue-800 dark:text-blue-200' : 'text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200',
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span aria-hidden="true" className="absolute inset-x-3 top-0 h-[3px] rounded-b-full bg-red-600 dark:bg-red-500" />
          )}
          {icon}
          <span className="truncate">{label}</span>
        </>
      )}
    </NavLink>
  );
}

export function AppShell(): ReactNode {
  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <div className="mx-auto flex w-full max-w-6xl">
        {/* 宽屏侧边栏 */}
        <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-neutral-200/70 bg-white/80 px-3 py-4 sm:flex dark:border-neutral-800/70 dark:bg-neutral-900/80">
          <div className="mb-4 flex items-center gap-2.5 px-2">
            <img src={ICON_URL} alt="" className="h-9 w-9 rounded-lg shadow-sm" />
            <div className="min-w-0">
              <p className="truncate text-base font-semibold">掌上图书馆</p>
              <p className="mt-0.5 truncate text-xs text-neutral-400 dark:text-neutral-500">数据只存在这台设备上</p>
            </div>
          </div>
          <NavLink to="/books/new" className={buttonClass({ variant: 'primary', className: 'mb-3' })}>
            ＋ 新增书目
          </NavLink>
          <nav className="flex flex-col gap-1" aria-label="主导航">
            {NAV_ITEMS.map((item) => (
              <SidebarLink key={item.to} {...item} />
            ))}
          </nav>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* 窄屏顶栏 */}
          <header className="sticky top-0 z-30 flex items-center justify-between gap-2 border-b border-neutral-200/70 bg-white/90 px-3 py-2 backdrop-blur sm:hidden dark:border-neutral-800/70 dark:bg-neutral-900/90">
            <span className="flex items-center gap-2 text-sm font-semibold">
              <img src={ICON_URL} alt="" className="h-6 w-6 rounded-md" />
              掌上图书馆
            </span>
            <NavLink to="/books/new" className={buttonClass({ variant: 'primary', size: 'sm' })}>
              ＋ 新增书目
            </NavLink>
          </header>

          {/* pb-20：给窄屏底部标签栏留出空间，否则最后一行内容被挡住 */}
          <main className="min-w-0 flex-1 px-4 py-6 pb-24 sm:px-6 sm:py-8">
            <Outlet />
          </main>
        </div>
      </div>

      {/* 窄屏底部标签栏 */}
      <nav
        className="fixed inset-x-0 bottom-0 z-30 flex border-t border-neutral-200/70 bg-white/90 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden dark:border-neutral-800/70 dark:bg-neutral-900/90"
        aria-label="主导航"
      >
        {NAV_ITEMS.map((item) => (
          <TabLink key={item.to} {...item} />
        ))}
      </nav>

      {/* 删除撤销横幅（04 §6）：挂在外壳上，切页面也一直在（§11.4） */}
      <UndoBanner />
    </div>
  );
}
