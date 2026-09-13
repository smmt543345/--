/**
 * 快照区（04 §11.4）：最近快照时间 + 快照列表（时间 + 各表计数）+ 恢复（二次确认）。
 *
 * 恢复是 replace 语义（02 §12.4）：覆盖当前全部藏书数据；恢复前会自动拍一张
 * pre-restore 快照，所以"恢复错了"本身也还能再退回来。settings 与其余快照不动。
 */

import { useState, type ReactNode } from 'react';

import { useDb } from '../../app/db-context.ts';
import { NoSnapshotsArt } from '../../app/illustrations.tsx';
import { formatDateTime, snapshotCountsText } from '../../app/labels.ts';
import { Badge, Button, Card, ConfirmDialog, EmptyState, InlineError } from '../../app/ui.tsx';
import { SkeletonBlock } from '../../app/Skeleton.tsx';
import { useAsyncAction, useLiveQuery } from '../../app/useLiveQuery.ts';
import { SETTING_KEYS, getSetting } from '../../db/settings.ts';
import { listSnapshots, restoreSnapshot } from '../../db/snapshots.ts';
import type { Snapshot, SnapshotKind } from '../../domain/types.ts';

const KIND_LABELS: Record<SnapshotKind, string> = {
  auto: '自动',
  'pre-restore': '恢复前',
  undo: '撤销',
};

export function SnapshotSection(): ReactNode {
  const db = useDb();
  const action = useAsyncAction();
  const [target, setTarget] = useState<Snapshot | null>(null);

  const data = useLiveQuery(
    async () => {
      const [snapshots, lastAutoSnapshotAt] = await Promise.all([
        listSnapshots(db),
        getSetting<string>(db, SETTING_KEYS.lastAutoSnapshotAt, ''),
      ]);
      return { snapshots, lastAutoSnapshotAt };
    },
    [db],
    null,
  );

  if (data === null) {
    return (
      <Card className="space-y-3 p-4">
        <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">快照</h2>
        <div className="space-y-2" role="status" aria-busy="true" aria-live="polite">
          <span className="sr-only">正在读取快照…</span>
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="flex items-center justify-between gap-3 rounded-lg border border-neutral-200 p-2 dark:border-neutral-800">
              <SkeletonBlock className="h-4 w-40" />
              <SkeletonBlock className="h-6 w-16 rounded-full" />
            </div>
          ))}
        </div>
      </Card>
    );
  }

  return (
    <Card className="space-y-3 p-4">
      <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">快照</h2>
      <p className="text-sm text-neutral-600 dark:text-neutral-300">
        每累计 20 次改动、且距上次 ≥ 1 天，自动拍一张全库快照，保留最近 10 份。删错东西或改乱之后，可以整体恢复到某个时间点。
      </p>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        最近快照：{data.lastAutoSnapshotAt === '' ? '还没有' : formatDateTime(data.lastAutoSnapshotAt)}
      </p>

      {data.snapshots.length === 0 ? (
        <EmptyState
          illustration={<NoSnapshotsArt />}
          title="还没有快照" hint="改动的次数攒够、且距上次超过一天后，这里会自动出现第一张。" />
      ) : (
        <ul className="space-y-2">
          {data.snapshots.map((snap) => (
            <li
              key={snap.id}
              className="flex animate-fade-rise flex-wrap items-center justify-between gap-2 rounded-lg border border-neutral-200 px-3 py-2 dark:border-neutral-800"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-neutral-800 dark:text-neutral-100">{formatDateTime(snap.createdAt)}</span>
                  <Badge tone="gray">{KIND_LABELS[snap.kind]}</Badge>
                </div>
                <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">{snapshotCountsText(snap.summary)}</p>
              </div>
              <Button
                size="sm"
                onClick={() => {
                  action.clearError();
                  setTarget(snap);
                }}
              >
                恢复
              </Button>
            </li>
          ))}
        </ul>
      )}

      {action.error !== null && target === null && <InlineError>{action.error}</InlineError>}

      <ConfirmDialog
        open={target !== null}
        title="恢复快照"
        confirmLabel="恢复"
        pending={action.pending}
        error={action.error}
        message={
          target === null ? null : (
            <p>
              将用 {formatDateTime(target.createdAt)} 的快照（{snapshotCountsText(target.summary)}）覆盖当前全部藏书数据。
              恢复前会自动再拍一张当前状态——恢复本身也可以反悔。主题与设置不受影响。
            </p>
          )
        }
        onCancel={() => setTarget(null)}
        onConfirm={() => {
          const snap = target;
          if (snap === null) return;
          void action.run(async () => {
            await restoreSnapshot(db, snap.id);
            setTarget(null);
          });
        }}
      />
    </Card>
  );
}
