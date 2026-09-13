/**
 * 借出表单（04 §11.3、§11.7）：书目详情页的借出弹窗与「快速借出」的第三步共用同一个组件。
 *
 * 三件事在这里收口，两个入口不各写一份：
 * - 借书人 = 自由文本 + 历史候选下拉（聚焦时展示，选中一起填入姓名与联系方式，§11.3）；
 * - 应还日期默认按设置里的借期推算（`defaultDueDateFor`，§11.7）；
 * - 校验与写入复用 `features/loans/write.ts` 的 `validateLoanDraft` / `lendCopy`，不另造一套（§11.7）。
 *
 * 打开时预检一次进行中的借出：liveQuery 的结果可能落后于别的标签页，先探一次，
 * 免得用户填完一整屏才被 service 拒绝（service 仍然会再挡一次）。
 */

import { useEffect, useState, type ReactNode } from 'react';

import { useDb } from '../../app/db-context.ts';
import { Button, InlineError, TextField } from '../../app/ui.tsx';
import { useLiveQuery } from '../../app/useLiveQuery.ts';
import { listBorrowers } from '../../db/borrowers.ts';
import { getActiveLoanForCopy } from '../../db/loans.ts';
import { today } from '../../domain/time.ts';
import type { Borrower } from '../../domain/types.ts';
import { defaultDueDateFor, emptyLoanDraft, validateLoanDraft, type LoanDraft } from '../loans/write.ts';

/** 候选最多显示多少条（04 §11.3）：20 条够点，再多靠打字收窄。 */
const MAX_CANDIDATES = 20;
const NO_BORROWERS: readonly Borrower[] = [];

/**
 * 借书人字段（04 §11.3）：自由文本 + 候选下拉。
 * 候选列表内联展开而不是浮层：弹窗自己会滚动，浮层在滚动容器里会被裁切，也容易盖住下一个字段。
 */
function BorrowerField({ value, onChange, onPick, disabled }: {
  value: string;
  onChange: (name: string) => void;
  onPick: (borrower: Borrower) => void;
  disabled: boolean;
}): ReactNode {
  const db = useDb();
  const [open, setOpen] = useState(false);
  const borrowers = useLiveQuery(() => listBorrowers(db), [db], NO_BORROWERS);

  const needle = value.trim().toLowerCase();
  const candidates = borrowers
    .filter((borrower) => needle === '' || borrower.name.toLowerCase().includes(needle))
    .slice(0, MAX_CANDIDATES);

  return (
    // onBlur 挂在整块上（React 的 onBlur 是冒泡的 focusout）：Tab 到候选按钮时列表不会先关掉
    <div onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
      <TextField
        label="借书人"
        value={value}
        onValueChange={onChange}
        onFocus={() => setOpen(true)}
        disabled={disabled}
        autoComplete="off"
        hint="必填；下拉里是以前借过的人，选一个就把联系方式一起填上"
      />
      {open && candidates.length > 0 && (
        <ul className="mt-1 max-h-56 divide-y divide-neutral-200 overflow-y-auto rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-700">
          {candidates.map((borrower) => (
            <li key={borrower.id}>
              {/* onMouseDown 阻止默认：否则输入框先失焦，列表在 click 之前就被收起来 */}
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => { onPick(borrower); setOpen(false); }}
                className="flex min-h-11 w-full items-center justify-between gap-2 px-3 text-left text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800"
              >
                <span className="truncate text-neutral-800 dark:text-neutral-100">{borrower.name}</span>
                {borrower.contact !== '' && (
                  <span className="shrink-0 text-xs text-neutral-400 dark:text-neutral-500">{borrower.contact}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface BorrowFormProps {
  /** 要借出的副本 id */
  copyId: string;
  /** 打开时显示的一行上下文（位置 / 书名），省略则不占位 */
  context?: ReactNode;
  submitLabel?: string;
  /** 写操作状态由调用方持有：对话框关闭时它要清错误 */
  pending: boolean;
  error: string | null;
  onSubmit: (draft: LoanDraft) => void;
  onCancel: () => void;
}

export function BorrowForm({ copyId, context, submitLabel = '确认借出', pending, error, onSubmit, onCancel }: BorrowFormProps): ReactNode {
  const db = useDb();
  const [draft, setDraft] = useState<LoanDraft>(() => emptyLoanDraft());
  const [problem, setProblem] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // 应还日期按设置里的借期推算（§11.7）；取不到就留空＝不设到期日
    void defaultDueDateFor(db, today()).then(
      (due) => { if (!cancelled) setDraft((prev) => (prev.dueDate === '' ? { ...prev, dueDate: due } : prev)); },
      () => undefined,
    );
    void getActiveLoanForCopy(db, copyId).then(
      (loan) => { if (!cancelled && loan !== undefined) setConflict(`该副本已经借给「${loan.borrower}」，请先归还再借出`); },
      () => undefined,
    );
    return () => { cancelled = true; };
  }, [db, copyId]);

  function submit(): void {
    const issue = validateLoanDraft(draft);
    if (issue !== null) { setProblem(issue); return; }
    setProblem(null);
    onSubmit(draft);
  }

  const message = problem ?? conflict ?? error;

  return (
    <>
      {context}
      <BorrowerField
        value={draft.borrower}
        disabled={pending}
        onChange={(borrower) => setDraft({ ...draft, borrower })}
        onPick={(borrower) => setDraft({ ...draft, borrower: borrower.name, contact: borrower.contact })}
      />
      <TextField label="联系方式" value={draft.contact} onValueChange={(contact) => setDraft({ ...draft, contact })} hint="手机号 / 微信 / 邮箱，可以留空" />
      <TextField label="借出日期" type="date" value={draft.loanDate} onValueChange={(loanDate) => setDraft({ ...draft, loanDate })} />
      <TextField
        label="应还日期"
        type="date"
        value={draft.dueDate}
        onValueChange={(dueDate) => setDraft({ ...draft, dueDate })}
        hint="默认按设置里的借期推算；留空表示不设到期日"
      />
      {message !== null && <InlineError>{message}</InlineError>}
      <div className="flex flex-wrap justify-end gap-2 pt-1">
        <Button onClick={onCancel} disabled={pending}>取消</Button>
        <Button variant="primary" onClick={submit} disabled={pending}>{pending ? '处理中…' : submitLabel}</Button>
      </div>
    </>
  );
}
