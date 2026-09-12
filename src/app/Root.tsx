/**
 * 启动外壳：跑 bootstrapApp()，成功才挂载应用（04 §4）。
 *
 * 启动失败（隐私模式、IndexedDB 不可用）时给一段纯静态说明，而不是白屏——
 * 白屏对用户等于"应用坏了"，连去设置页导出的入口都没有。
 */

import { useEffect, useState, type ReactNode } from 'react';

import { App } from './App.tsx';
import { BootContext } from './boot-context.ts';
import { DbContext } from './db-context.ts';
import { bootstrapApp, type BootstrapResult } from './startup.ts';

type BootState =
  | { status: 'loading' }
  | { status: 'ready'; boot: BootstrapResult }
  | { status: 'failed'; message: string };

function BootMessage({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-3 p-6">
      <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">{title}</h1>
      <div className="text-sm text-neutral-600 dark:text-neutral-400">{children}</div>
    </div>
  );
}

export function Root(): ReactNode {
  const [state, setState] = useState<BootState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    bootstrapApp().then(
      (boot) => {
        if (!cancelled) setState({ status: 'ready', boot });
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({ status: 'failed', message: error instanceof Error ? error.message : String(error) });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === 'loading') {
    return <BootMessage title="正在打开书库…">首次打开会做一次数据体检，稍等一下。</BootMessage>;
  }

  if (state.status === 'failed') {
    return (
      <BootMessage title="书库打不开">
        <p>
          浏览器没让我们访问本机数据库。常见原因是**无痕/隐私模式**，或者站点存储被禁用。
        </p>
        <p className="mt-2">换成普通窗口再试一次；若仍然不行，请检查浏览器设置里是否允许本站保存数据。</p>
        <p className="mt-3 rounded-lg bg-neutral-100 px-3 py-2 font-mono text-xs break-all text-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
          {state.message}
        </p>
      </BootMessage>
    );
  }

  const { db, repairWarnings, persisted } = state.boot;
  return (
    <DbContext.Provider value={db}>
      <BootContext.Provider value={{ repairWarnings, persisted }}>
        <App />
      </BootContext.Provider>
    </DbContext.Provider>
  );
}
