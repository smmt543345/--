/**
 * 借出页（04 §1 `/loans`）：**在借**（含逾期）与**历史**两个区块。
 *
 * 本页不新建借出：借出必须指明是哪一本副本，而副本只在书目详情页可见，
 * 借出入口放这里只会多一次跳转。本页做两件事——把该催的还催出来，把还过的记下来。
 *
 * 归还走 features/loans/write.ts 的 `returnLoan`（它挡日期格式），不直接调 db 层的
 * `returnCopy`：页面不重复 service 已经做过的校验。写操作一律经 useAsyncAction，
 * service 抛的中文原样展示（04 §3）。
 */

import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { useDb } from '../../app/db-context.ts';
import { authorsText, bookDisplayTitle, LOAN_STATUS_LABELS } from '../../app/labels.ts';
import {
  Badge,
  Banner,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  InlineError,
  PageHeader,
  Spinner,
  StatTile,
  TextField,
  cn,
} from '../../app/ui.tsx';
import { useAsyncAction, useLiveQuery } from '../../app/useLiveQuery.ts';
import { attachLoanDetails, listActiveLoans, listLoanHistory, listOverdueLoans } from '../../db/loans.ts';
import { daysSince, isOverdue, today } from '../../domain/time.ts';
import type { LoanWithBook } from '../../domain/types.ts';
import { returnLoan } from './write.ts';

/** 历史每次多显示这么多条：一次铺开几百条记录在手机上没法用。 */
const HISTORY_PAGE_SIZE = 10;

/**
 * 在借记录的排序：逾期的排最前（要催的），其余按应还日期升序。
 * 未设到期日的排最后 —— 它既不急也不该冒充"最急"。
 */
function sortActiveLoans(rows: readonly LoanWithBook[]): LoanWithBook[] {
  return [...rows].sort((a, b) => {
    const aOverdue = isOverdue(a.dueDate);
    const bOverdue = isOverdue(b.dueDate);
    if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
    if (a.dueDate !== '' && b.dueDate !== '' && a.dueDate !== b.dueDate) {
      return a.dueDate < b.dueDate ? -1 : 1;
    }
    if (a.dueDate === '' && b.dueDate !== '') return 1;
    if (a.dueDate !== '' && b.dueDate === '') return -1;
    return b.loanDate.localeCompare(a.loanDate);
  });
}

function MetaItem({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-neutral-400 dark:text-neutral-500">{label}</dt>
      <dd className="truncate text-neutral-800 dark:text-neutral-200">{value}</dd>
    </div>
  );
}

export function LoansPage(): ReactNode {
  const db = useDb();
  const navigate = useNavigate();
  const action = useAsyncAction();

  const [historyLimit, setHistoryLimit] = useState(HISTORY_PAGE_SIZE);
  const [returnTarget, setReturnTarget] = useState<LoanWithBook | null>(null);
  const [returnDate, setReturnDate] = useState(() => today());

  const active = useLiveQuery<LoanWithBook[] | null>(async () => sortActiveLoans(await listActiveLoans(db)), [db], null);
  const overdue = useLiveQuery<LoanWithBook[] | null>(async () => listOverdueLoans(db), [db], null);
  const history = useLiveQuery<LoanWithBook[] | null>(
    // 在借的已经在上面那一块里了，历史只放已归还的，避免同一条记录出现两次
    async () => attachLoanDetails(db, (await listLoanHistory(db)).filter((loan) => loan.status === 'returned')),
    [db],
    null,
  );

  // 首次查询结果到达前不画空态：否则会先闪一下"还没有借出记录"，看起来像丢数据
  if (active === null || overdue === null || history === null) {
    return <Spinner label="正在翻借出记录…" />;
  }

  const maxOverdueDays = overdue.reduce((max, loan) => Math.max(max, daysSince(loan.dueDate)), 0);
  const visibleHistory = history.slice(0, historyLimit);
  const nothingAtAll = active.length === 0 && history.length === 0;

  function openReturn(loan: LoanWithBook): void {
    action.clearError();
    setReturnTarget(loan);
    setReturnDate(today());
  }

  function closeReturn(): void {
    setReturnTarget(null);
    action.clearError();
  }

  function confirmReturn(): void {
    const target = returnTarget;
    if (target === null) return;
    void action.run(async () => {
      // 空串＝今天还的（db 层默认），用户改了就按改的记
      await returnLoan(db, target.copyId, returnDate);
      // 只在成功后关闭；失败留在对话框里显示人话
      setReturnTarget(null);
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader title="借出" description="谁借走了、什么时候该还，都记在这里。" />

      {nothingAtAll ? (
        <EmptyState
          title="还没有借出记录"
          hint="去书目详情页把某本副本借出去，这里就会记下来。"
          action={
            <Button variant="primary" onClick={() => navigate('/search')}>
              去找一本书
            </Button>
          }
        />
      ) : (
        <>
          <section className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <StatTile label="在借" value={active.length} />
              <StatTile
                label="逾期"
                value={overdue.length}
                tone={overdue.length > 0 ? 'amber' : 'gray'}
                hint={overdue.length > 0 ? `最久 ${maxOverdueDays} 天` : '没有逾期'}
              />
            </div>

            {overdue.length > 0 && (
              <Banner tone="amber">
                有 {overdue.length} 本已逾期，最久的一本逾期 {maxOverdueDays} 天。
              </Banner>
            )}

            <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">在借（{active.length}）</h2>

            {active.length === 0 ? (
              <p className="rounded-xl border border-dashed border-neutral-300 px-4 py-6 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
                当前没有在借出去的书。
              </p>
            ) : (
              active.map((loan) => {
                const overdueDays = isOverdue(loan.dueDate) ? daysSince(loan.dueDate) : 0;
                return (
                  <Card
                    key={loan.id}
                    className={cn('p-3', overdueDays > 0 && 'border-amber-300 dark:border-amber-800')}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                        {bookDisplayTitle(loan.book)}
                      </span>
                      {overdueDays > 0 && <Badge tone="amber">逾期 {overdueDays} 天</Badge>}
                    </div>
                    <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                      {authorsText(loan.book.authors)}
                      {loan.locationPath === '' ? '' : ` · ${loan.locationPath}`}
                    </p>

                    <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                      <MetaItem label="借书人" value={loan.borrower} />
                      {/* 联系方式有才显示：没有的时候写"未填"只是噪音 */}
                      {loan.contact !== '' && <MetaItem label="联系方式" value={loan.contact} />}
                      <MetaItem label="借出日期" value={loan.loanDate} />
                      <MetaItem label="应还日期" value={loan.dueDate === '' ? '未设' : loan.dueDate} />
                    </dl>

                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button variant="primary" onClick={() => openReturn(loan)}>
                        归还
                      </Button>
                      <Button onClick={() => navigate(`/books/${loan.book.id}`)}>查看书目</Button>
                    </div>
                  </Card>
                );
              })
            )}
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">历史（{history.length}）</h2>

            {history.length === 0 ? (
              <p className="rounded-xl border border-dashed border-neutral-300 px-4 py-6 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
                还没有归还过。归还之后，记录会留在这里。
              </p>
            ) : (
              <>
                {visibleHistory.map((loan) => (
                  <Card key={loan.id} className="p-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                        {bookDisplayTitle(loan.book)}
                      </span>
                      <Badge tone="gray">{LOAN_STATUS_LABELS[loan.status]}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                      借给 {loan.borrower}
                      {loan.contact === '' ? '' : `（${loan.contact}）`}
                    </p>
                    <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                      {loan.loanDate} 借出 · {loan.returnDate === '' ? '未归还' : `${loan.returnDate} 归还`}
                      {loan.dueDate === '' ? '' : ` · 应还 ${loan.dueDate}`}
                    </p>
                    <div className="mt-2">
                      <Button size="sm" onClick={() => navigate(`/books/${loan.book.id}`)}>
                        查看书目
                      </Button>
                    </div>
                  </Card>
                ))}

                {history.length > visibleHistory.length ? (
                  <Button className="w-full" onClick={() => setHistoryLimit((current) => current + HISTORY_PAGE_SIZE)}>
                    显示更多（还有 {history.length - visibleHistory.length} 条）
                  </Button>
                ) : (
                  history.length > HISTORY_PAGE_SIZE && (
                    <p className="text-center text-xs text-neutral-400 dark:text-neutral-500">
                      已显示全部 {history.length} 条
                    </p>
                  )
                )}
              </>
            )}
          </section>
        </>
      )}

      {/* 对话框开着的时候错误显示在对话框里，不在页面上重复一遍 */}
      {action.error !== null && returnTarget === null && <InlineError>{action.error}</InlineError>}

      <ConfirmDialog
        open={returnTarget !== null}
        title="确认归还"
        tone="primary"
        confirmLabel="确认归还"
        pending={action.pending}
        error={action.error}
        message={
          returnTarget === null ? null : (
            <>
              《{bookDisplayTitle(returnTarget.book)}》借给了「{returnTarget.borrower}」，确认已收回？
            </>
          )
        }
        onCancel={closeReturn}
        onConfirm={confirmReturn}
      >
        <TextField
          label="归还日期"
          type="date"
          value={returnDate}
          onValueChange={setReturnDate}
          hint="默认今天；留空也表示今天还的"
        />
      </ConfirmDialog>
    </div>
  );
}
