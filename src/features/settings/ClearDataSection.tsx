/**
 * 清空数据区（04 §6 的破坏性操作口径）。
 *
 * 从 SettingsPage 整块迁出（01 §5.8）：那一页长期在 500 行硬上限之上，这是其中一块
 * 自带状态、动作与二次确认的完整单元 —— 与 BorrowerSection / SnapshotSection 同一做法。
 *
 * 危险操作的三条照旧：先弹确认、确认文案里要有**真实数量**（`counts` 由调用方查好传入，
 * 不在这里重查一遍）、勾选确认项才允许执行。
 */

import { useState, type ReactNode } from 'react';

import { useDb } from '../../app/db-context.ts';
import { Button, Card, ConfirmDialog } from '../../app/ui.tsx';
import { useAsyncAction } from '../../app/useLiveQuery.ts';
import { clearAllData } from '../../db/client.ts';
import type { LibraryCounts } from '../../db/stats.ts';
import { describeClearAllData } from './write.ts';

export interface ClearDataSectionProps {
  /** 当前库存量：确认文案与按钮可用性都靠它（null = 还在统计） */
  counts: LibraryCounts | null;
}

export function ClearDataSection({ counts }: ClearDataSectionProps): ReactNode {
  const db = useDb();
  const action = useAsyncAction();
  const [open, setOpen] = useState(false);
  const [ack, setAck] = useState(false);
  const [ackError, setAckError] = useState<string | null>(null);

  function start(): void {
    action.clearError();
    setAckError(null);
    setAck(false);
    setOpen(true);
  }

  function confirm(): void {
    if (!ack) {
      setAckError('请先勾选上面的确认项');
      return;
    }
    setAckError(null);
    void action.run(async () => {
      await clearAllData(db);
      setOpen(false);
      setAck(false);
    });
  }

  return (
    <>
      <Card className="space-y-3 p-4">
        <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">清空数据</h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-300">
          删除本机全部书目、副本、位置、借书人与借出记录。动手前请先导出备份；万一删错了，也可以用上方「快照」区恢复到之前的状态。主题与设备名会保留。
        </p>
        <Button variant="danger" onClick={start} disabled={counts === null}>
          清空全部数据…
        </Button>
      </Card>

      <ConfirmDialog
        open={open}
        title="清空全部数据"
        confirmLabel="清空"
        pending={action.pending}
        error={ackError ?? action.error}
        message={<p>{counts === null ? '' : describeClearAllData(counts)}</p>}
        onCancel={() => {
          setOpen(false);
          setAck(false);
          setAckError(null);
          action.clearError();
        }}
        onConfirm={confirm}
      >
        <label className="flex min-h-11 items-start gap-2 text-sm text-neutral-700 dark:text-neutral-300">
          <input
            type="checkbox"
            className="mt-0.5 h-5 w-5 accent-red-600"
            checked={ack}
            onChange={(event) => setAck(event.target.checked)}
          />
          <span>我确认：先导出过备份，或确定这些数据不再需要。</span>
        </label>
      </ConfirmDialog>
    </>
  );
}
