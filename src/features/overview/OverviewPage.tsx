/**
 * 首页 · 总览（04 §1）。
 *
 * 一屏回答三个问题：我有多少书、谁借走没还、数据备份了没有。
 * 三块内容合并成一次订阅：它们本来就读同一份索引，拆成三个 useLiveQuery
 * 只会在每次写操作后多闪几下。
 *
 * 所有展示文案（书名占位、状态中文、上次导出）都取自 labels.ts，页面不另写一份。
 */

import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { useBootInfo } from '../../app/boot-context.ts';
import { useDb } from '../../app/db-context.ts';
import { bookDisplayTitle, copyStatusTone, describeLastExport } from '../../app/labels.ts';
import { Badge, Banner, Button, Card, EmptyState, PageHeader, Spinner, StatTile, cn } from '../../app/ui.tsx';
import { useLiveQuery } from '../../app/useLiveQuery.ts';
import { listOverdueLoans } from '../../db/loans.ts';
import { SETTING_KEYS, getSetting } from '../../db/settings.ts';
import { getStats, type LibraryStats } from '../../db/stats.ts';
import { daysSince, isTimestampString, toLocalDate, today } from '../../domain/time.ts';
import type { LoanWithBook } from '../../domain/types.ts';

/** 超过这么多天没导出就醒目提醒（01 §3.2 第 3 条）。 */
const EXPORT_REMINDER_DAYS = 14;

interface OverviewSnapshot {
  stats: LibraryStats;
  overdue: LoanWithBook[];
  /** 上次导出的 ISO 时间戳；从未导出为空串 */
  lastExportAt: string;
}

/**
 * 距上次导出过了几天；从未导出或时间戳非法返回 null。
 * 用数字而不是复用 describeLastExport：后者只给「N 天前」这种文案，
 * 判断"该不该醒目提醒"需要的是天数本身。
 */
function exportAgeInDays(iso: string): number | null {
  if (!isTimestampString(iso)) return null;
  // lastExportAt 是 UTC 时间戳，先折成本地日历日再比天数（与 describeLastExport 同口径）
  return daysSince(toLocalDate(new Date(iso)), today());
}

/**
 * 逾期天数。应还日期格式异常时 daysSince 会返回 0 —— 服务层是按字典序判逾期的，
 * 这时说「已逾期」而不是编一个「逾期 0 天」。
 */
function overdueText(dueDate: string): string {
  const days = daysSince(dueDate);
  return days > 0 ? `逾期 ${days} 天` : '已逾期';
}

export function OverviewPage(): ReactNode {
  const db = useDb();
  const { repairWarnings, persisted } = useBootInfo();
  const navigate = useNavigate();

  // 启动体检的告警只在本会话提醒一次，关掉后不再打扰（04 §4）
  const [warningsDismissed, setWarningsDismissed] = useState(false);

  const snapshot = useLiveQuery<OverviewSnapshot | null>(
    async () => {
      const [stats, overdue, lastExportAt] = await Promise.all([
        getStats(db),
        listOverdueLoans(db),
        getSetting<string>(db, SETTING_KEYS.lastExportAt, ''),
      ]);
      return { stats, overdue, lastExportAt };
    },
    [db],
    null,
  );

  const goToSettings = (): void => {
    void navigate('/settings');
  };

  return (
    <div className="space-y-4">
      <PageHeader title="总览" description="藏书概况、逾期提醒与备份状态" />

      {repairWarnings.length > 0 && !warningsDismissed && (
        <Banner tone="amber" onClose={() => setWarningsDismissed(true)}>
          <p className="font-medium">启动体检修复了 {repairWarnings.length} 处数据问题</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {repairWarnings.map((warning, index) => (
              <li key={`${index}-${warning}`}>{warning}</li>
            ))}
          </ul>
        </Banner>
      )}

      {!persisted && (
        <Banner tone="gray">
          <p className="font-medium">这台设备暂未授予「持久化存储」</p>
          <p className="mt-1">
            不影响使用，只是系统在存储紧张时可能会清理本站数据。隔一阵子到「备份与设置」导出一次，就多一层保险。
          </p>
        </Banner>
      )}

      {snapshot === null ? (
        <Spinner label="正在统计藏书…" />
      ) : snapshot.stats.books === 0 && snapshot.stats.copies === 0 ? (
        <EmptyState
          title="还没有书"
          hint="点右上角的「＋ 新增书目」记下第一本。先写书名就行，作者、ISBN 以后可以慢慢补。"
          action={
            <Button variant="primary" onClick={() => void navigate('/books/new')}>
              ＋ 添加第一本
            </Button>
          }
        />
      ) : (
        <OverviewContent snapshot={snapshot} onGoToSettings={goToSettings} />
      )}
    </div>
  );
}

function OverviewContent({
  snapshot,
  onGoToSettings,
}: {
  snapshot: OverviewSnapshot;
  onGoToSettings: () => void;
}): ReactNode {
  const { stats, overdue, lastExportAt } = snapshot;

  const exportAge = exportAgeInDays(lastExportAt);
  const exportStale = exportAge === null || exportAge >= EXPORT_REMINDER_DAYS;

  return (
    <>
      <section aria-label="藏书统计" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <StatTile label="藏书总量" value={stats.books} hint="按书目计，同书多本只算一条" />
        <StatTile label="副本数" value={stats.copies} hint="手上实际有几本" />
        <StatTile label="在架" value={stats.onShelf} tone={copyStatusTone('on_shelf')} />
        <StatTile
          label="借出"
          value={stats.lentOut}
          tone={copyStatusTone('lent_out')}
          hint={`进行中借出 ${stats.activeLoans} 条`}
        />
        <StatTile label="丢失" value={stats.lost} tone={copyStatusTone('lost')} />
        <StatTile label="卖掉" value={stats.sold} tone={copyStatusTone('sold')} />
      </section>

      <section aria-label="逾期未还">
        <h2 className="mb-2 text-sm font-medium text-neutral-700 dark:text-neutral-300">
          逾期未还{overdue.length > 0 ? `（${overdue.length}）` : ''}
        </h2>
        {overdue.length === 0 ? (
          // 不占一块地方：没有逾期就一句话带过
          <p className="text-sm text-neutral-500 dark:text-neutral-400">目前没有逾期的书，都按时着呢。</p>
        ) : (
          <ul className="space-y-2">
            {overdue.map((loan) => (
              <li key={loan.id}>
                <Card>
                  <Link
                    to={`/books/${loan.book.id}`}
                    className="flex min-h-11 items-start justify-between gap-3 p-3 hover:bg-neutral-50 dark:hover:bg-neutral-800/60"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{bookDisplayTitle(loan.book)}</span>
                      <span className="mt-0.5 block text-xs text-neutral-500 dark:text-neutral-400">
                        {loan.borrower} 借走 · 应还 {loan.dueDate}
                      </span>
                      {loan.locationPath !== '' && (
                        <span className="mt-0.5 block text-xs text-neutral-400 dark:text-neutral-500">
                          原位置：{loan.locationPath}
                        </span>
                      )}
                    </span>
                    <Badge tone="red">{overdueText(loan.dueDate)}</Badge>
                  </Link>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Card className={cn('p-3', exportStale && 'border-amber-300 dark:border-amber-800')}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">备份</p>
            <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">
              上次导出：{describeLastExport(lastExportAt)}
            </p>
          </div>
          <Button size="sm" variant={exportStale ? 'primary' : 'secondary'} onClick={onGoToSettings}>
            去导出
          </Button>
        </div>
        {exportStale && (
          <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
            数据只存在这台设备上：浏览器清缓存、系统回收存储都可能把它带走。现在导出一份 JSON，是唯一兜得住的办法。
          </p>
        )}
      </Card>
    </>
  );
}
