/**
 * 删除撤销横幅（04 §6、02 §9.1）：常驻底部、跨页面，挂在 AppShell 上。
 * 不靠删除入口逐个通知：删除 service 在同一事务里先写 kind='undo' 的快照（02 §9.1），
 * 这里直接订阅那张表 —— 新一次删除顶掉旧快照（captureUndo 先删旧行），id 一变倒计时自动重来。
 */

import { useEffect, useState, type ReactNode } from 'react';

import { expireUndo, restoreUndo } from '../db/snapshots.ts';
import { useDb } from './db-context.ts';
import { describeUndo } from './labels.ts';
import { Button } from './ui.tsx';
import { useAsyncAction, useLiveQuery } from './useLiveQuery.ts';

/** 撤销窗口（02 §9.1）：删除后 30 秒内可撤销。 */
export const UNDO_WINDOW_MS = 30_000;
export function UndoBanner(): ReactNode {
  const db = useDb();
  const action = useAsyncAction();
  const undo = useLiveQuery(async () => (await db.snapshots.where('kind').equals('undo').first()) ?? null, [db], null);
  const [remainingMs, setRemainingMs] = useState(UNDO_WINDOW_MS);
  useEffect(() => {
    if (undo === null) return undefined;
    const deadline = Date.parse(undo.createdAt) + UNDO_WINDOW_MS;
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = (): void => {
      const left = Math.max(0, deadline - Date.now());
      setRemainingMs(left);
      if (left > 0) return;
      // 倒计时走完＝放弃这次撤销：清掉 undo 快照（liveQuery 随即收起横幅）
      if (timer !== null) clearInterval(timer);
      void expireUndo(db, { olderThanMs: UNDO_WINDOW_MS });
    };
    timer = setInterval(tick, 500);
    tick();
    return () => { if (timer !== null) clearInterval(timer); };
  }, [db, undo]);

  // 没有待撤销的删除就不占位置（关闭＝清掉快照，订阅随即把横幅收回去，不需要额外的本地标记）
  if (undo === null) return null;

  // 关闭＝放弃这次撤销：立刻清掉快照，不留到过期（02 §9.1）
  const close = (): void => { void expireUndo(db, { olderThanMs: 0 }); };

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-16 z-40 flex justify-center px-3 sm:bottom-6 sm:justify-end sm:px-6">
      <div role="status" className="pointer-events-auto w-full max-w-sm rounded-xl border border-neutral-200/80 bg-white p-3 shadow-lg shadow-neutral-950/10 dark:border-neutral-700 dark:bg-neutral-900">
        <div className="flex items-start gap-3">
          <p className="min-w-0 flex-1 text-sm font-medium text-neutral-900 dark:text-neutral-100">
            <span className="block truncate">{describeUndo(undo)}</span>
            <span className="mt-0.5 block text-xs font-normal text-neutral-500 dark:text-neutral-400">{Math.ceil(remainingMs / 1000)} 秒内可以撤销，过期后无法还原。</span>
          </p>
          <Button size="sm" variant="primary" disabled={action.pending} onClick={() => { void action.run(() => restoreUndo(db).then(() => undefined)); }}>{action.pending ? '恢复中…' : '撤销'}</Button>
          <button type="button" onClick={close} aria-label="关闭撤销提示" className="-mt-0.5 rounded px-1.5 py-0.5 text-lg leading-none text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200">×</button>
        </div>
        {action.error !== null && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{action.error}</p>}
      </div>
    </div>
  );
}
