/**
 * 快速借出（04 §11.7）：借出页「＋ 快速借出」打开的三步弹窗 —— 选书 → 选在架副本 → 填借出信息，
 * 不再需要跳去详情页。第三步复用 BorrowForm（与详情页同一个借出表单），校验与写入也走同一套 service。
 */

import { useState, type ReactNode } from 'react';

import { useDb } from '../../app/db-context.ts';
import { useDebounced } from '../../app/hooks.ts';
import { COPY_CONDITION_LABELS, authorsText, bookDisplayTitle, locationPathText } from '../../app/labels.ts';
import { Badge, Button, EmptyState, Modal, Spinner, TextField } from '../../app/ui.tsx';
import { useAsyncAction, useLiveQuery } from '../../app/useLiveQuery.ts';
import { getBookDetail, searchBooks } from '../../db/books.ts';
import type { Book, BookDetail, BookSearchResult, CopyWithLocation } from '../../domain/types.ts';
import { BorrowForm } from '../books/BorrowForm.tsx';
import { describeNoShelfCopies, splitOnShelf } from './quick-lend.ts';
import { lendCopy, type LoanDraft } from './write.ts';

/** 迷你搜索一次列多少本：弹窗里放不下更多，超了用关键词收窄。 */
const SEARCH_LIMIT = 8;
const NO_RESULTS: readonly BookSearchResult[] = [];

const ROW_CLASS =
  'flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border border-neutral-200 px-3 py-2 text-left hover:border-neutral-400 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:border-neutral-600 dark:hover:bg-neutral-800';

type Step = 1 | 2 | 3;

/** 第二步：选在架副本（04 §11.7）；没有在架副本时给空态与「换一本书」。 */
function CopyStep({ detail, onPick, onBack }: {
  detail: BookDetail | null | undefined;
  onPick: (copy: CopyWithLocation) => void;
  onBack: () => void;
}): ReactNode {
  if (detail === undefined) return <Spinner label="正在读取副本…" />;
  // null = 书在这一步缩水没了（别的标签页刚删掉）
  if (detail === null) {
    return <EmptyState title="这本书已经不在了" hint="它可能刚被删掉。换一本再借。" action={<Button onClick={onBack}>换一本书</Button>} />;
  }
  if (detail.copies.length === 0) {
    return <EmptyState title="这本书还没有副本" hint="先去书目详情页加一本，或者换一本书。" action={<Button onClick={onBack}>换一本书</Button>} />;
  }
  const { onShelf, offShelf, offShelfText } = splitOnShelf(detail.copies);
  if (onShelf.length === 0) {
    return (
      <EmptyState
        title={describeNoShelfCopies(offShelf.length)}
        hint={`${offShelfText}。归还请到借出页操作，归还后这本就能借了；也可以换一本书。`}
        action={<Button onClick={onBack}>换一本书</Button>}
      />
    );
  }
  return (
    <ul className="space-y-2">
      {onShelf.map((copy) => (
        <li key={copy.id}>
          <button type="button" onClick={() => onPick(copy)} className={ROW_CLASS}>
            <span className="truncate text-sm text-neutral-800 dark:text-neutral-100">{locationPathText(copy.locationPath)}</span>
            <span className="shrink-0 text-xs text-neutral-400 dark:text-neutral-500">{COPY_CONDITION_LABELS[copy.condition]}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function QuickLendDialog({ open, onClose }: { open: boolean; onClose: () => void }): ReactNode {
  const db = useDb();
  const action = useAsyncAction();
  const [step, setStep] = useState<Step>(1);
  const [keyword, setKeyword] = useState('');
  const [book, setBook] = useState<Book | null>(null);
  const [copy, setCopy] = useState<CopyWithLocation | null>(null);
  const settledKeyword = useDebounced(keyword, 200);

  // 关着的时候不订阅、不查询：弹窗不开就没有数据要读
  const results = useLiveQuery<readonly BookSearchResult[]>(
    async () => (open ? searchBooks(db, { keyword: settledKeyword, limit: SEARCH_LIMIT }) : NO_RESULTS),
    [db, open, settledKeyword],
    NO_RESULTS,
  );
  const bookId = book?.id ?? null;
  const detail = useLiveQuery<BookDetail | null | undefined>(
    async () => (!open || bookId === null ? undefined : (await getBookDetail(db, bookId)) ?? null),
    [db, open, bookId],
    undefined,
  );

  /** 关掉就复位：下次打开从第一步开始，不带上次的关键词与选中。 */
  function close(): void {
    setStep(1);
    setKeyword('');
    setBook(null);
    setCopy(null);
    action.clearError();
    onClose();
  }

  function submit(draft: LoanDraft): void {
    const target = copy;
    if (target === null) return;
    void action.run(async () => {
      await lendCopy(db, { copyId: target.id, ...draft });
      close();
    });
  }

  return (
    <Modal
      open={open}
      title={`快速借出 · 第 ${step} 步 / 共 3 步`}
      onClose={close}
      footer={
        step === 3 ? undefined : (
          <>
            {step === 2 && <Button onClick={() => setStep(1)} disabled={action.pending}>换一本书</Button>}
            <Button onClick={close} disabled={action.pending}>取消</Button>
          </>
        )
      }
    >
      {step === 1 && (
        <>
          <TextField
            label="找书"
            type="search"
            value={keyword}
            onValueChange={setKeyword}
            placeholder="书名 / 作者 / ISBN"
            autoFocus
            hint="输入关键词，或直接从下面选一本"
          />
          {results.length === 0 ? (
            <EmptyState title="没找到这本书" hint="换个关键词试试，或者先去新增书目把它录进来。" />
          ) : (
            <ul className="space-y-2">
              {results.map((result) => {
                const shelfCount = result.copies.filter((item) => item.status === 'on_shelf').length;
                return (
                  <li key={result.book.id}>
                    <button
                      type="button"
                      onClick={() => { setBook(result.book); setStep(2); }}
                      className={ROW_CLASS}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-neutral-800 dark:text-neutral-100">{bookDisplayTitle(result.book)}</span>
                        <span className="mt-0.5 block truncate text-xs text-neutral-500 dark:text-neutral-400">{authorsText(result.book.authors)}</span>
                      </span>
                      <Badge tone={shelfCount > 0 ? 'green' : 'gray'}>{shelfCount} 本在架</Badge>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {step === 2 && (
        <CopyStep detail={detail} onBack={() => setStep(1)} onPick={(next) => { setCopy(next); setStep(3); }} />
      )}

      {step === 3 && copy !== null && (
        <BorrowForm
          copyId={copy.id}
          context={
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {book === null ? '' : `《${bookDisplayTitle(book)}》· `}
              {locationPathText(copy.locationPath)}
            </p>
          }
          pending={action.pending}
          error={action.error}
          onSubmit={submit}
          onCancel={close}
        />
      )}
    </Modal>
  );
}
