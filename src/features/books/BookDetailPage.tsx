/**
 * 书目详情页（04 §1 `/books/:id`）：一本书的元数据、副本、借出记录都在这一页。
 *
 * 三处边界值得写下来（都是设计文档定的，不是这里临时决定的）：
 * - `Copy.status = 'lent_out'` 是**派生值**（02 §4）：状态选择器只列
 *   `MANUAL_COPY_STATUSES`，借出/归还只能走 `lendCopy` / `returnLoan`。
 * - 标为 `lost`/`sold` 会连带关闭进行中的借出（02 §6 I7），所以那一排按钮的
 *   hint 必须把后果说清楚。
 * - 删除是不可逆的（02 §9）：确认文案里的数量全部来自 `detail` 的真实数据，
 *   副本正被借出时还要用户勾一次显式确认，勾完才把 `confirmLentOut: true` 传下去。
 */

import { useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { useDb } from '../../app/db-context.ts';
import {
  COPY_CONDITION_LABELS,
  COPY_STATUS_LABELS,
  LOAN_STATUS_LABELS,
  authorsText,
  bookDisplayTitle,
  copyStatusTone,
  formatDateTime,
  locationPathText,
} from '../../app/labels.ts';
import {
  Badge,
  Banner,
  Button,
  Card,
  ChoiceGroup,
  ConfirmDialog,
  EmptyState,
  InlineError,
  Modal,
  PageHeader,
  SelectField,
  Spinner,
  TextAreaField,
  TextField,
  type ChoiceOption,
  type SelectOption,
} from '../../app/ui.tsx';
import { useAsyncAction, useLiveQuery } from '../../app/useLiveQuery.ts';
import { findBooksByIsbn, getBookDetail, updateBook } from '../../db/books.ts';
import {
  MANUAL_COPY_STATUSES,
  createCopy,
  deleteCopy,
  moveCopy,
  setCopyStatus,
  updateCopy,
} from '../../db/copies.ts';
import { getActiveLoanForCopy } from '../../db/loans.ts';
import { listLocations } from '../../db/locations.ts';
import { UNSORTED_LOCATION_ID } from '../../domain/ids.ts';
import { normalizeIsbn } from '../../domain/isbn.ts';
import { parsePositiveInt } from '../../domain/text.ts';
import { today } from '../../domain/time.ts';
import { COPY_CONDITIONS, TERMINAL_COPY_STATUSES } from '../../domain/types.ts';
import type {
  BookDetail,
  CopyCondition,
  CopyStatus,
  CopyWithLocation,
  Location,
} from '../../domain/types.ts';
import {
  EMPTY_DRAFT,
  MAX_INITIAL_COUNT,
  deleteBookCompletely,
  draftToBookInput,
  isbnNotice,
  validateDraft,
  type BookDraft,
} from './write.ts';
import {
  defaultDueDateFor,
  emptyLoanDraft,
  lendCopy,
  returnLoan,
  validateLoanDraft,
  type LoanDraft,
} from '../loans/write.ts';

/* ------------------------------------------------------------------ *
 * 选项清单：直接用 types.ts 的 as const 清单渲染，不另抄一份（04 §5）
 * ------------------------------------------------------------------ */

const CONDITION_OPTIONS: readonly ChoiceOption<CopyCondition>[] = COPY_CONDITIONS.map((value) => ({
  value,
  label: COPY_CONDITION_LABELS[value],
}));

/**
 * 手工可设的状态。**没有 `lent_out`** —— 它是借出记录的派生值（02 §4）。
 * 类型标成 CopyStatus 是为了让 `value={copy.status}` 能原样传进来：
 * 副本正被借出时，没有任何一个按钮会高亮，上面那枚状态徽章已经说明了一切。
 */
const STATUS_OPTIONS: readonly ChoiceOption<CopyStatus>[] = MANUAL_COPY_STATUSES.map((value) => ({
  value,
  label: COPY_STATUS_LABELS[value],
}));

function MetaRow({ label, value }: { label: string; value: ReactNode }): ReactNode {
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0 text-neutral-500 dark:text-neutral-400">{label}</dt>
      <dd className="min-w-0 flex-1 text-neutral-800 dark:text-neutral-200">{value}</dd>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 副本卡片
 * ------------------------------------------------------------------ */

interface CopyCardProps {
  copy: CopyWithLocation;
  locationOptions: readonly SelectOption[];
  /** 副本上的写操作正在飞：卡片上的控件一律禁用，避免连点两次发两次写 */
  busy: boolean;
  onMove: (copy: CopyWithLocation, locationId: string) => void;
  onCondition: (copy: CopyWithLocation, condition: CopyCondition) => void;
  onStatus: (copy: CopyWithLocation, status: CopyStatus) => void;
  onLend: (copy: CopyWithLocation) => void;
  onReturn: (copy: CopyWithLocation) => void;
  onDelete: (copy: CopyWithLocation) => void;
}

function CopyCard({
  copy,
  locationOptions,
  busy,
  onMove,
  onCondition,
  onStatus,
  onLend,
  onReturn,
  onDelete,
}: CopyCardProps): ReactNode {
  const loan = copy.activeLoan;
  // lost / sold 是终态（02 §4）：不能借出，所以那一排里直接不给这个按钮
  const terminal = TERMINAL_COPY_STATUSES.some((value) => value === copy.status);
  // 副本正被借出时摘掉「在架」：改回在架的唯一路径是归还（02 §6 I7）。
  // service 层（setCopyStatus）也会拒绝，这里只是不让用户撞上那道拒绝
  const statusOptions =
    loan === null ? STATUS_OPTIONS : STATUS_OPTIONS.filter((option) => option.value !== 'on_shelf');
  const statusHint =
    copy.status === 'lent_out'
      ? '「借出」由借出记录派生，不在这里选。标为丢失/卖掉会自动结束进行中的借出记录（记为今天归还）。'
      : '丢失/卖掉后这本不再参与借出。若它正被借出，借出记录会自动结束（记为今天归还）。';

  return (
    <Card className="space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={copyStatusTone(copy.status)}>{COPY_STATUS_LABELS[copy.status]}</Badge>
        <Badge>{COPY_CONDITION_LABELS[copy.condition]}</Badge>
        <span className="min-w-0 flex-1 truncate text-sm text-neutral-600 dark:text-neutral-300">
          {locationPathText(copy.locationPath)}
        </span>
      </div>

      {copy.owner !== '' && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">所有者：{copy.owner}</p>
      )}
      {copy.note !== '' && <p className="text-xs text-neutral-500 dark:text-neutral-400">备注：{copy.note}</p>}

      {loan !== null && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
          借给「{loan.borrower}」· {loan.loanDate} 借出 ·{' '}
          {loan.dueDate === '' ? '未设应还日期' : `应还 ${loan.dueDate}`}
          {loan.contact === '' ? '' : ` · ${loan.contact}`}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {loan === null && !terminal && (
          <Button variant="primary" onClick={() => onLend(copy)}>
            借出
          </Button>
        )}
        {loan !== null && (
          <Button variant="primary" onClick={() => onReturn(copy)}>
            归还
          </Button>
        )}
        <Button variant="danger" onClick={() => onDelete(copy)} disabled={busy}>
          删除副本
        </Button>
      </div>

      <SelectField
        label="位置"
        value={copy.locationId}
        options={locationOptions}
        onValueChange={(value) => onMove(copy, value)}
        disabled={busy}
      />
      <ChoiceGroup
        label="品相"
        value={copy.condition}
        options={CONDITION_OPTIONS}
        onChange={(value) => onCondition(copy, value)}
        disabled={busy}
      />
      <ChoiceGroup
        label="状态"
        value={copy.status}
        options={statusOptions}
        onChange={(value) => onStatus(copy, value)}
        hint={statusHint}
        disabled={busy}
      />
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * 页面
 * ------------------------------------------------------------------ */

export function BookDetailPage(): ReactNode {
  const db = useDb();
  const navigate = useNavigate();
  const params = useParams<{ id: string }>();
  // 路由参数在 noUncheckedIndexedAccess 下是 string | undefined；空串查不到书，
  // 会走下面的"这本书不在库里"分支，不会白屏
  const bookId = params.id ?? '';

  const bookAction = useAsyncAction(); // 书目本身：保存编辑、删除整本
  const copyAction = useAsyncAction(); // 副本卡片上的即时改动：位置 / 品相 / 状态
  const dialogAction = useAsyncAction(); // 对话框里的写操作：借出 / 归还 / 删副本 / 加副本

  // null = 还没拿到第一份结果；undefined = 查过了，没有这本书
  const detail = useLiveQuery<BookDetail | null | undefined>(
    async () => getBookDetail(db, bookId),
    [bookId, db],
    null,
  );
  const locations = useLiveQuery<Location[]>(async () => listLocations(db), [db], []);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<BookDraft>(EMPTY_DRAFT);
  const [formError, setFormError] = useState<string | null>(null);
  const [coverFailedUrl, setCoverFailedUrl] = useState('');
  // 编辑保存时的同 ISBN 提示：第一次点保存先提示，用户知情后再点一次才真的写（与新增入口同一口径）
  const [isbnConflictNotice, setIsbnConflictNotice] = useState<string | null>(null);

  const [addCopyOpen, setAddCopyOpen] = useState(false);
  const [addCount, setAddCount] = useState('1');
  const [addLocationId, setAddLocationId] = useState<string>(UNSORTED_LOCATION_ID);
  const [addCondition, setAddCondition] = useState<CopyCondition>('unknown');
  const [addOwner, setAddOwner] = useState('');
  const [addNote, setAddNote] = useState('');
  const [addError, setAddError] = useState<string | null>(null);

  const [lendTarget, setLendTarget] = useState<CopyWithLocation | null>(null);
  // 借出对话框当前的目标。预检 Promise 回来时对话框可能已换成另一本副本，
  // 回调里要拿它比对，别把 A 的检查结果显示在 B 的对话框上
  const lendTargetRef = useRef<CopyWithLocation | null>(null);
  const [lendDraft, setLendDraft] = useState<LoanDraft>(() => emptyLoanDraft());
  const [lendError, setLendError] = useState<string | null>(null);

  const [returnTarget, setReturnTarget] = useState<CopyWithLocation | null>(null);
  const [returnDate, setReturnDate] = useState(() => today());

  const [deleteCopyTarget, setDeleteCopyTarget] = useState<CopyWithLocation | null>(null);
  const [deleteCopyAck, setDeleteCopyAck] = useState(false);
  const [deleteCopyError, setDeleteCopyError] = useState<string | null>(null);

  const [deleteBookOpen, setDeleteBookOpen] = useState(false);
  const [deleteBookAck, setDeleteBookAck] = useState(false);
  const [deleteBookError, setDeleteBookError] = useState<string | null>(null);

  if (detail === null) {
    return <Spinner label="正在打开这本书…" />;
  }

  if (detail === undefined) {
    return (
      <EmptyState
        title="这本书不在库里"
        hint="它可能已经被删除，或者这条链接里的编号不对。"
        action={
          <Button variant="primary" onClick={() => navigate('/search')}>
            回搜索页
          </Button>
        }
      />
    );
  }

  const { book, copies, loans } = detail;
  const locationOptions: SelectOption[] = locations.map((location) => ({
    value: location.id,
    label: locationPathText(location.path),
  }));
  const borrowedCopies = copies.filter((copy) => copy.activeLoan !== null);
  const borrowers = [
    ...new Set(borrowedCopies.map((copy) => copy.activeLoan?.borrower ?? '（未知借书人）')),
  ];
  // 封面加载失败就换掉，不留破图；换了 coverUrl 之后自然重试
  const coverVisible = book.coverUrl !== '' && coverFailedUrl !== book.coverUrl;
  const loanCountOf = (copyId: string): number => loans.filter((loan) => loan.copyId === copyId).length;

  /* ---------------- 书目元数据 ---------------- */

  function startEdit(): void {
    bookAction.clearError();
    setFormError(null);
    setIsbnConflictNotice(null);
    setDraft({
      ...EMPTY_DRAFT,
      title: book.title,
      isbn: book.isbn,
      authorsRaw: book.authors.join('，'),
      publisher: book.publisher,
      publishDate: book.publishDate,
      coverUrl: book.coverUrl,
      tagsRaw: book.tags.join('，'),
    });
    setEditing(true);
  }

  function cancelEdit(): void {
    setEditing(false);
    setFormError(null);
    setIsbnConflictNotice(null);
    bookAction.clearError();
  }

  function saveEdit(): void {
    const problem = validateDraft(draft);
    if (problem !== null) {
      setFormError(problem);
      return;
    }
    setFormError(null);
    void bookAction.run(async () => {
      // 编辑是"整体覆盖"语义：清空某个字段就该真的清掉，所以传全量而不是 mergePatch
      const isbn = normalizeIsbn(draft.isbn).isbn13;
      if (isbn !== '' && isbnConflictNotice === null) {
        // 新增入口对同 ISBN 有「合并/仍然新建」确认，编辑入口保持同一口径：
        // 第一次点保存先提示，用户知情后再点一次才真的写下去
        const others = await findBooksByIsbn(db, isbn);
        const other = others.find((existing) => existing.id !== bookId);
        if (other !== undefined) {
          setIsbnConflictNotice(
            `已经有一本同样 ISBN 的书：《${bookDisplayTitle(other)}》。确定这是不同版本，再点一次「保存」即可；想并成一本，请取消编辑，去那本书的详情页添加副本。`,
          );
          return;
        }
      }
      await updateBook(db, bookId, draftToBookInput(draft));
      setEditing(false);
    });
  }

  /* ---------------- 副本上的即时改动 ---------------- */

  function moveTo(copy: CopyWithLocation, locationId: string): void {
    if (locationId === copy.locationId) return;
    void copyAction.run(async () => {
      await moveCopy(db, copy.id, locationId);
    });
  }

  function changeCondition(copy: CopyWithLocation, condition: CopyCondition): void {
    if (condition === copy.condition) return;
    void copyAction.run(async () => {
      await updateCopy(db, copy.id, { condition });
    });
  }

  function changeStatus(copy: CopyWithLocation, status: CopyStatus): void {
    // 选项里本来就没有 lent_out，这里再收窄一次，交给 setCopyStatus 的也是穷尽后的类型
    if (status === 'lent_out' || status === copy.status) return;
    void copyAction.run(async () => {
      await setCopyStatus(db, copy.id, status);
    });
  }

  /* ---------------- 借出 / 归还 ---------------- */

  function openLend(copy: CopyWithLocation): void {
    dialogAction.clearError();
    setLendError(null);
    setLendTarget(copy);
    lendTargetRef.current = copy;
    const fresh = emptyLoanDraft();
    setLendDraft(fresh);

    // 应还日期按设置里的借期推算（共享原件，页面不自己算 30 天）；取不到就留空＝不设
    void defaultDueDateFor(db, fresh.loanDate).then(
      (due) => {
        if (lendTargetRef.current?.id !== copy.id) return; // 对话框已换成另一本副本
        setLendDraft((previous) => (previous.dueDate === '' ? { ...previous, dueDate: due } : previous));
      },
      () => undefined,
    );

    // liveQuery 的结果可能落后于别的标签页：先探一次进行中的借出，
    // 免得用户填完一整屏表单才被 service 拒绝（service 仍然会再挡一次）
    void getActiveLoanForCopy(db, copy.id).then(
      (active) => {
        if (lendTargetRef.current?.id !== copy.id) return; // 对话框已换成另一本副本
        if (active !== undefined) setLendError(`该副本已经借给「${active.borrower}」，请先归还再借出`);
      },
      () => undefined,
    );
  }

  function closeLend(): void {
    lendTargetRef.current = null;
    setLendTarget(null);
    setLendError(null);
    dialogAction.clearError();
  }

  function confirmLend(): void {
    const target = lendTarget;
    if (target === null) return;
    const problem = validateLoanDraft(lendDraft);
    if (problem !== null) {
      setLendError(problem);
      return;
    }
    setLendError(null);
    void dialogAction.run(async () => {
      // dueDate 传空串＝不设到期日（db 层区分 undefined 与空串）
      await lendCopy(db, { copyId: target.id, ...lendDraft });
      lendTargetRef.current = null;
      setLendTarget(null);
    });
  }

  function openReturn(copy: CopyWithLocation): void {
    dialogAction.clearError();
    setReturnTarget(copy);
    setReturnDate(today());
  }

  function closeReturn(): void {
    setReturnTarget(null);
    dialogAction.clearError();
  }

  function confirmReturn(): void {
    const target = returnTarget;
    if (target === null) return;
    void dialogAction.run(async () => {
      await returnLoan(db, target.id, returnDate);
      setReturnTarget(null);
    });
  }

  /* ---------------- 删除副本 ---------------- */

  function openDeleteCopy(copy: CopyWithLocation): void {
    dialogAction.clearError();
    setDeleteCopyError(null);
    setDeleteCopyAck(false);
    setDeleteCopyTarget(copy);
  }

  function closeDeleteCopy(): void {
    setDeleteCopyTarget(null);
    setDeleteCopyAck(false);
    setDeleteCopyError(null);
    dialogAction.clearError();
  }

  function confirmDeleteCopy(): void {
    const target = deleteCopyTarget;
    if (target === null) return;
    if (target.activeLoan !== null && !deleteCopyAck) {
      setDeleteCopyError('请先勾选上面的确认项');
      return;
    }
    setDeleteCopyError(null);
    void dialogAction.run(async () => {
      await deleteCopy(db, target.id, { confirmLentOut: deleteCopyAck });
      setDeleteCopyTarget(null);
    });
  }

  /* ---------------- 新增副本 ---------------- */

  function openAddCopy(): void {
    dialogAction.clearError();
    setAddError(null);
    setAddCount('1');
    setAddLocationId(UNSORTED_LOCATION_ID);
    setAddCondition('unknown');
    setAddOwner('');
    setAddNote('');
    setAddCopyOpen(true);
  }

  function closeAddCopy(): void {
    setAddCopyOpen(false);
    setAddError(null);
    dialogAction.clearError();
  }

  function confirmAddCopy(): void {
    const count = parsePositiveInt(addCount);
    if (count === null) {
      setAddError('数量要是 1 以上的整数');
      return;
    }
    if (count > MAX_INITIAL_COUNT) {
      setAddError(`一次最多添加 ${MAX_INITIAL_COUNT} 本，更多请分批添加`);
      return;
    }
    setAddError(null);
    void dialogAction.run(async () => {
      for (let index = 0; index < count; index += 1) {
        await createCopy(db, {
          bookId,
          locationId: addLocationId,
          condition: addCondition,
          owner: addOwner,
          note: addNote,
        });
      }
      setAddCopyOpen(false);
    });
  }

  /* ---------------- 删除整本书 ---------------- */

  function openDeleteBook(): void {
    bookAction.clearError();
    setDeleteBookError(null);
    setDeleteBookAck(false);
    setDeleteBookOpen(true);
  }

  function closeDeleteBook(): void {
    setDeleteBookOpen(false);
    setDeleteBookAck(false);
    setDeleteBookError(null);
    bookAction.clearError();
  }

  function confirmDeleteBook(): void {
    if (borrowedCopies.length > 0 && !deleteBookAck) {
      setDeleteBookError('请先勾选上面的确认项');
      return;
    }
    setDeleteBookError(null);
    void bookAction.run(async () => {
      await deleteBookCompletely(db, bookId, { strategy: 'cascade', confirmLentOut: deleteBookAck });
      // 连书都没了，留在详情页只会看到"这本书不在库里"
      navigate('/search', { replace: true });
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={bookDisplayTitle(book)}
        description={`${authorsText(book.authors)}${book.isbn === '' ? '' : ` · ISBN ${book.isbn}`}`}
        actions={
          editing ? undefined : (
            <>
              <Button onClick={startEdit}>编辑</Button>
              <Button variant="danger" onClick={openDeleteBook}>
                删除这本书
              </Button>
            </>
          )
        }
      />

      {editing ? (
        <Card className="space-y-3 p-4">
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">编辑书目信息</h2>
          <TextField
            label="书名"
            value={draft.title}
            onValueChange={(value) => setDraft({ ...draft, title: value })}
            hint="可以先留空，之后再补"
          />
          <TextField
            label="ISBN"
            value={draft.isbn}
            onValueChange={(value) => {
              setDraft({ ...draft, isbn: value });
              setIsbnConflictNotice(null);
            }}
            hint={isbnNotice(draft.isbn) ?? '可以留空'}
          />
          <TextField
            label="作者"
            value={draft.authorsRaw}
            onValueChange={(value) => setDraft({ ...draft, authorsRaw: value })}
            hint="多个作者用逗号或顿号分开"
          />
          <TextField
            label="出版社"
            value={draft.publisher}
            onValueChange={(value) => setDraft({ ...draft, publisher: value })}
          />
          <TextField
            label="出版日期"
            value={draft.publishDate}
            onValueChange={(value) => setDraft({ ...draft, publishDate: value })}
            hint="YYYY-MM-DD；不确定就留空"
          />
          <TextField
            label="封面图 URL"
            value={draft.coverUrl}
            onValueChange={(value) => setDraft({ ...draft, coverUrl: value })}
            hint="网络图片地址，可以留空"
          />
          <TextField
            label="标签"
            value={draft.tagsRaw}
            onValueChange={(value) => setDraft({ ...draft, tagsRaw: value })}
            hint="多个标签用逗号或顿号分开"
          />
          {isbnConflictNotice !== null && (
            <Banner tone="amber" onClose={() => setIsbnConflictNotice(null)}>
              {isbnConflictNotice}
            </Banner>
          )}
          {(formError ?? bookAction.error) !== null && <InlineError>{formError ?? bookAction.error}</InlineError>}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={saveEdit} disabled={bookAction.pending}>
              {bookAction.pending ? '保存中…' : '保存'}
            </Button>
            <Button onClick={cancelEdit} disabled={bookAction.pending}>
              取消
            </Button>
          </div>
        </Card>
      ) : (
        <Card className="space-y-3 p-4">
          <div className="flex gap-4">
            {coverVisible && (
              <img
                src={book.coverUrl}
                alt={`${bookDisplayTitle(book)} 的封面`}
                onError={() => setCoverFailedUrl(book.coverUrl)}
                className="h-36 w-24 shrink-0 rounded-lg border border-neutral-200 object-cover dark:border-neutral-800"
              />
            )}
            <dl className="min-w-0 flex-1 space-y-1.5 text-sm">
              <MetaRow label="作者" value={authorsText(book.authors)} />
              <MetaRow label="ISBN" value={book.isbn === '' ? '未填' : book.isbn} />
              <MetaRow label="出版社" value={book.publisher === '' ? '未填' : book.publisher} />
              <MetaRow label="出版日期" value={book.publishDate === '' ? '未填' : book.publishDate} />
            </dl>
          </div>

          <div>
            <p className="mb-1 text-xs text-neutral-400 dark:text-neutral-500">标签</p>
            {book.tags.length === 0 ? (
              <p className="text-sm text-neutral-500 dark:text-neutral-400">没有标签</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {book.tags.map((tag) => (
                  <Badge key={tag}>{tag}</Badge>
                ))}
              </div>
            )}
          </div>

          <p className="text-xs text-neutral-400 dark:text-neutral-500">
            创建于 {formatDateTime(book.createdAt) || '未知'} · 更新于 {formatDateTime(book.updatedAt) || '未知'}
          </p>
        </Card>
      )}

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">副本（{copies.length}）</h2>
          <Button variant="primary" onClick={openAddCopy}>
            ＋ 添加副本
          </Button>
        </div>

        {copyAction.error !== null && (
          <Banner tone="red" onClose={copyAction.clearError}>
            {copyAction.error}
          </Banner>
        )}

        {copies.length === 0 ? (
          <EmptyState title="还没有副本" hint="点上面的「＋ 添加副本」添加一本。" />
        ) : (
          copies.map((copy) => (
            <CopyCard
              key={copy.id}
              copy={copy}
              locationOptions={locationOptions}
              busy={copyAction.pending}
              onMove={moveTo}
              onCondition={changeCondition}
              onStatus={changeStatus}
              onLend={openLend}
              onReturn={openReturn}
              onDelete={openDeleteCopy}
            />
          ))
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
          借出记录（{loans.length}）
        </h2>

        {loans.length === 0 ? (
          <EmptyState title="这本书还没有借出记录" hint="在某本副本上点「借出」，记录就会出现在这里。" />
        ) : (
          loans.map((loan) => {
            const copy = copies.find((item) => item.id === loan.copyId);
            return (
              <Card key={loan.id} className="p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                    借给 {loan.borrower}
                  </span>
                  <Badge tone={loan.status === 'active' ? 'amber' : 'gray'}>{LOAN_STATUS_LABELS[loan.status]}</Badge>
                </div>
                <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                  {loan.loanDate} 借出 · {loan.returnDate === '' ? '未归还' : `${loan.returnDate} 归还`}
                  {loan.dueDate === '' ? '' : ` · 应还 ${loan.dueDate}`}
                  {copy === undefined ? '' : ` · ${locationPathText(copy.locationPath)}`}
                </p>
                {loan.contact !== '' && (
                  <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">联系方式：{loan.contact}</p>
                )}
              </Card>
            );
          })
        )}
      </section>

      <Modal
        open={lendTarget !== null}
        title="借出这本副本"
        onClose={closeLend}
        footer={
          <>
            <Button onClick={closeLend} disabled={dialogAction.pending}>
              取消
            </Button>
            <Button variant="primary" onClick={confirmLend} disabled={dialogAction.pending}>
              {dialogAction.pending ? '处理中…' : '确认借出'}
            </Button>
          </>
        }
      >
        {lendTarget !== null && (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            位置：{locationPathText(lendTarget.locationPath)}
          </p>
        )}
        <TextField
          label="借书人"
          value={lendDraft.borrower}
          onValueChange={(value) => setLendDraft({ ...lendDraft, borrower: value })}
          hint="必填"
        />
        <TextField
          label="联系方式"
          value={lendDraft.contact}
          onValueChange={(value) => setLendDraft({ ...lendDraft, contact: value })}
          hint="手机号 / 微信 / 邮箱，可以留空"
        />
        <TextField
          label="借出日期"
          type="date"
          value={lendDraft.loanDate}
          onValueChange={(value) => setLendDraft({ ...lendDraft, loanDate: value })}
        />
        <TextField
          label="应还日期"
          type="date"
          value={lendDraft.dueDate}
          onValueChange={(value) => setLendDraft({ ...lendDraft, dueDate: value })}
          hint="默认按设置里的借期推算；留空表示不设到期日"
        />
        {(lendError ?? dialogAction.error) !== null && <InlineError>{lendError ?? dialogAction.error}</InlineError>}
      </Modal>

      <ConfirmDialog
        open={returnTarget !== null}
        title="确认归还"
        tone="primary"
        confirmLabel="确认归还"
        pending={dialogAction.pending}
        error={dialogAction.error}
        message={
          returnTarget === null ? null : (
            <>
              这本副本借给了「{returnTarget.activeLoan?.borrower ?? '（未知借书人）'}」，确认已收回？
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

      <ConfirmDialog
        open={deleteCopyTarget !== null}
        title="删除副本"
        confirmLabel="删除副本"
        pending={dialogAction.pending}
        error={deleteCopyError ?? dialogAction.error}
        message={
          deleteCopyTarget === null ? null : (
            <>
              将删除这本副本（{locationPathText(deleteCopyTarget.locationPath)}）和它的{' '}
              {loanCountOf(deleteCopyTarget.id)} 条借出记录，无法撤销。
              {deleteCopyTarget.activeLoan !== null && (
                <span className="mt-2 block">
                  该副本正被「{deleteCopyTarget.activeLoan.borrower}」借出，那条进行中的借出记录会一起删掉。
                </span>
              )}
            </>
          )
        }
        onCancel={closeDeleteCopy}
        onConfirm={confirmDeleteCopy}
      >
        {deleteCopyTarget !== null && deleteCopyTarget.activeLoan !== null && (
          <label className="flex min-h-11 items-start gap-2 text-sm text-neutral-700 dark:text-neutral-300">
            <input
              type="checkbox"
              className="mt-0.5 h-5 w-5 accent-red-600"
              checked={deleteCopyAck}
              onChange={(event) => setDeleteCopyAck(event.target.checked)}
            />
            <span>我确认：该副本正被「{deleteCopyTarget.activeLoan.borrower}」借出，仍要删除。</span>
          </label>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={deleteBookOpen}
        title="删除这本书"
        confirmLabel="删除整本"
        pending={bookAction.pending}
        error={deleteBookError ?? bookAction.error}
        message={
          <>
            <p>
              将删除《{bookDisplayTitle(book)}》，以及它的 {copies.length} 本副本和这 {loans.length} 条借出记录。
            </p>
            {borrowedCopies.length > 0 && (
              <p className="mt-2">
                其中 {borrowedCopies.length} 本正被借出（{borrowers.join('、')}）。
              </p>
            )}
            <p className="mt-2">副本与借出记录会一并消失，无法撤销。</p>
          </>
        }
        onCancel={closeDeleteBook}
        onConfirm={confirmDeleteBook}
      >
        {borrowedCopies.length > 0 && (
          <label className="flex min-h-11 items-start gap-2 text-sm text-neutral-700 dark:text-neutral-300">
            <input
              type="checkbox"
              className="mt-0.5 h-5 w-5 accent-red-600"
              checked={deleteBookAck}
              onChange={(event) => setDeleteBookAck(event.target.checked)}
            />
            <span>
              我确认：这 {borrowedCopies.length} 本正被借出（{borrowers.join('、')}），仍要连同借出记录一起删除。
            </span>
          </label>
        )}
      </ConfirmDialog>

      <Modal
        open={addCopyOpen}
        title="添加副本"
        onClose={closeAddCopy}
        footer={
          <>
            <Button onClick={closeAddCopy} disabled={dialogAction.pending}>
              取消
            </Button>
            <Button variant="primary" onClick={confirmAddCopy} disabled={dialogAction.pending}>
              {dialogAction.pending ? '添加中…' : '添加'}
            </Button>
          </>
        }
      >
        <TextField
          label="数量"
          type="number"
          min={1}
          max={MAX_INITIAL_COUNT}
          value={addCount}
          onValueChange={setAddCount}
          hint={`一次最多 ${MAX_INITIAL_COUNT} 本`}
        />
        <SelectField label="位置" value={addLocationId} options={locationOptions} onValueChange={setAddLocationId} />
        <ChoiceGroup
          label="品相"
          value={addCondition}
          options={CONDITION_OPTIONS}
          onChange={setAddCondition}
        />
        <TextField
          label="所有者"
          value={addOwner}
          onValueChange={setAddOwner}
          hint="朋友合库时用来区分「我的」「老张的」，可以留空"
        />
        <TextAreaField label="备注" value={addNote} onValueChange={setAddNote} hint="可以留空" />
        {(addError ?? dialogAction.error) !== null && <InlineError>{addError ?? dialogAction.error}</InlineError>}
      </Modal>
    </div>
  );
}
