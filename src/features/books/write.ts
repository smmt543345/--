/**
 * 书目表单的校验、草稿→实体转换与保存流程（04 §5、§6）。
 *
 * 放在 features 而不是页面里：这些规则要能被 `node --test` 直接测（页面 .tsx 跑不了），
 * 也避免「新增」和「编辑」两个入口各写一份校验。
 */

import {
  createBook,
  findBooksByIsbn,
  normalizeTitle,
  updateBook,
  type CreateBookInput,
  type UpdateBookInput,
} from '../../db/books.ts';
import { createCopy } from '../../db/copies.ts';
import type { PocketLibraryDb } from '../../db/schema.ts';
import { SETTING_KEYS, bumpWriteCounter, getSetting, setSetting } from '../../db/settings.ts';
import { captureUndo } from '../../db/snapshots.ts';
import { normalizeIsbn } from '../../domain/isbn.ts';
import { parseList } from '../../domain/text.ts';
import { isDateString } from '../../domain/time.ts';
import { COPY_CONDITIONS } from '../../domain/types.ts';
import type { Book, CopyCondition } from '../../domain/types.ts';

/* ------------------------------------------------------------------ *
 * 草稿
 * ------------------------------------------------------------------ */

export interface BookDraft {
  title: string;
  isbn: string;
  /** 作者是自由文本，保存时按 parseList 切分 */
  authorsRaw: string;
  publisher: string;
  publishDate: string;
  coverUrl: string;
  tagsRaw: string;
  /** 副本落位；默认「未分类」由 db 层兜底，这里留空串表示"用默认" */
  locationId: string;
  condition: CopyCondition;
  owner: string;
  note: string;
  /** 首次保存时一次性创建的副本数。编辑已有书目时不使用（副本在详情页增删） */
  initialCount: number;
}

export const MAX_INITIAL_COUNT = 99;

export const EMPTY_DRAFT: BookDraft = {
  title: '',
  isbn: '',
  authorsRaw: '',
  publisher: '',
  publishDate: '',
  coverUrl: '',
  tagsRaw: '',
  locationId: '',
  // 与 db 层 createCopy 的默认值保持一致（copies.ts:74）
  condition: 'unknown',
  owner: '',
  note: '',
  initialCount: 1,
};

/** 校验草稿。返回可直接展示的中文错误，或 null 表示通过。 */
export function validateDraft(draft: BookDraft): string | null {
  if (draft.title.trim() === '' && draft.isbn.trim() === '') {
    return '书名与 ISBN 至少要填一个（可以先只填书名，之后再补）';
  }
  if (!Number.isInteger(draft.initialCount) || draft.initialCount < 1) {
    return '副本数量至少为 1';
  }
  if (draft.initialCount > MAX_INITIAL_COUNT) {
    return `副本数量最多 ${MAX_INITIAL_COUNT} 本，更多请分批添加`;
  }
  const publishDate = draft.publishDate.trim();
  if (publishDate !== '' && !isDateString(publishDate)) {
    return '出版日期格式应为 YYYY-MM-DD，或留空';
  }
  return null;
}

/**
 * ISBN 的非阻断提示（02 §7.3：无效 ISBN 不阻塞保存，但要告诉用户"你填的没被记录"）。
 * 返回 null 表示不需要提示。
 */
export function isbnNotice(rawIsbn: string): string | null {
  const raw = rawIsbn.trim();
  if (raw === '') return null;
  const result = normalizeIsbn(raw);
  if (result.valid) {
    // 比的是"清洗后的字符"：用户多打了连字符不算改变，ISBN-10 转 ISBN-13 才算
    // （决策 D4），后者要说清楚，免得用户以为存错了
    return result.cleaned === result.isbn13 ? null : `将按 ISBN-13 保存：${result.isbn13}`;
  }
  return `这不是有效的 ISBN（已读作 ${result.cleaned}），保存时该字段会留空，不影响其他信息`;
}

export function draftToBookInput(draft: BookDraft): CreateBookInput {
  return {
    isbn: draft.isbn,
    title: draft.title,
    authors: parseList(draft.authorsRaw),
    publisher: draft.publisher,
    publishDate: draft.publishDate,
    coverUrl: draft.coverUrl,
    tags: parseList(draft.tagsRaw),
  };
}

/**
 * 合并到已有书目时的补丁：**只带非空字段**。
 * 否则用户在表单里没填的文本框会以空串覆盖掉已有数据 —— 合并加副本不该清空元数据。
 */
export function draftToMergePatch(draft: BookDraft): UpdateBookInput {
  const patch: UpdateBookInput = {};
  if (draft.title.trim() !== '') patch.title = draft.title;
  if (draft.publishDate.trim() !== '') patch.publishDate = draft.publishDate;
  if (draft.publisher.trim() !== '') patch.publisher = draft.publisher;
  if (draft.coverUrl.trim() !== '') patch.coverUrl = draft.coverUrl;
  const authors = parseList(draft.authorsRaw);
  if (authors.length > 0) patch.authors = authors;
  const tags = parseList(draft.tagsRaw);
  if (tags.length > 0) patch.tags = tags;
  // isbn 不参与合并：新记录的 ISBN 与命中记录相同才会走到这里
  return patch;
}

export function draftToCopySeed(draft: BookDraft): {
  locationId: string | undefined;
  condition: CopyCondition;
  owner: string;
  note: string;
} {
  return {
    locationId: draft.locationId === '' ? undefined : draft.locationId,
    condition: draft.condition,
    owner: draft.owner,
    note: draft.note,
  };
}

/**
 * 疑似重复（02 §10.3）：书名规范化后相同。
 * **只提示不阻断**——同一本书的不同版本、上下册都可能撞名。
 */
export function suspectedDuplicates(books: readonly Book[], draft: BookDraft): Book[] {
  const key = normalizeTitle(draft.title);
  if (key === '') return [];
  const isbn = normalizeIsbn(draft.isbn).isbn13;
  return books.filter((book) => {
    if (normalizeTitle(book.title) !== key) return false;
    // ISBN 相同的是同一本书，不该被当成"疑似重复"
    return !(isbn !== '' && book.isbn === isbn);
  });
}

/* ------------------------------------------------------------------ *
 * 保存
 * ------------------------------------------------------------------ */

export type SubmitResult =
  | { kind: 'created'; book: Book; copies: number }
  | { kind: 'merged'; book: Book; copies: number }
  | { kind: 'needsIsbnConfirm'; existing: Book[] };

export interface SubmitOptions {
  /** 用户已确认"知道有同 ISBN 的书，仍然新建一条" */
  isbnConfirmed?: boolean;
  /** 用户选择"合并到已有书目"：把新副本挂到它下面 */
  mergeIntoBookId?: string;
}

/**
 * 保存草稿。
 * ISBN 命中已有书目时**返回待确认**而不是抛错：UI 需要给用户「合并 / 仍然新建」两个选项。
 */
export async function submitBook(
  db: PocketLibraryDb,
  draft: BookDraft,
  options: SubmitOptions = {},
): Promise<SubmitResult> {
  const problem = validateDraft(draft);
  if (problem !== null) throw new Error(problem);

  const isbn = normalizeIsbn(draft.isbn).isbn13;
  if (isbn !== '' && options.mergeIntoBookId === undefined && options.isbnConfirmed !== true) {
    const existing = await findBooksByIsbn(db, isbn);
    if (existing.length > 0) return { kind: 'needsIsbnConfirm', existing };
  }

  const seed = draftToCopySeed(draft);
  const merging = options.mergeIntoBookId !== undefined;
  const book = merging
    ? await updateBook(db, options.mergeIntoBookId as string, draftToMergePatch(draft))
    : await createBook(db, draftToBookInput(draft));

  for (let i = 0; i < draft.initialCount; i += 1) {
    await createCopy(db, { bookId: book.id, ...seed });
  }

  return { kind: merging ? 'merged' : 'created', book, copies: draft.initialCount };
}

/* ------------------------------------------------------------------ *
 * 表单记忆（04 §11.2）
 * ------------------------------------------------------------------ */

/** 被记住的三个字段：位置、品相、标签。**其余字段永远不记**（04 §11.2）。 */
export interface DraftPrefs {
  locationId: string;
  condition: CopyCondition;
  tagsRaw: string;
}

/**
 * 保存成功后调用：把这一次的位置/品相/标签写进 settings（设备专属，不进备份 —— 03 §2）。
 * 走到这里说明已经保存成功，所以不必先校验草稿。
 */
export async function rememberDraftPrefs(db: PocketLibraryDb, draft: BookDraft): Promise<void> {
  const prefs: DraftPrefs = {
    locationId: draft.locationId.trim(),
    condition: draft.condition,
    tagsRaw: draft.tagsRaw,
  };
  await setSetting(db, SETTING_KEYS.lastDraftPrefs, prefs);
}

/**
 * 进入新增页时调用：**只回填位置/品相/标签**，其余字段保持草稿原样（04 §11.2）。
 *
 * settings 里的值可能是上一版程序写的（甚至被手工改坏），所以逐字段校验，坏的那项
 * 按「没记过」处理；位置已被删除时也丢弃 —— 否则表单会带着一个不存在的 id，
 * 保存时才在 createCopy 里炸出「位置不存在」，用户完全看不懂。
 */
export async function applyDraftPrefs(db: PocketLibraryDb, draft: BookDraft): Promise<BookDraft> {
  const prefs = readDraftPrefs(await getSetting<unknown>(db, SETTING_KEYS.lastDraftPrefs, null));
  if (prefs === null) return draft;

  let locationId = prefs.locationId;
  if (locationId !== '') {
    const location = await db.locations.get(locationId);
    if (location === undefined) locationId = '';
  }
  return { ...draft, locationId, condition: prefs.condition, tagsRaw: prefs.tagsRaw };
}

/** settings 里的记忆值 → DraftPrefs；一条都没记过（settings 默认值 {}）返回 null。 */
function readDraftPrefs(value: unknown): DraftPrefs | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const condition =
    typeof raw.condition === 'string' ? (COPY_CONDITIONS.find((item) => item === raw.condition) ?? null) : null;
  const locationId = typeof raw.locationId === 'string' ? raw.locationId.trim() : '';
  const tagsRaw = typeof raw.tagsRaw === 'string' ? raw.tagsRaw : '';
  if (condition === null && locationId === '' && tagsRaw === '') return null;
  return { locationId, condition: condition ?? EMPTY_DRAFT.condition, tagsRaw };
}

export interface DeleteBookOptions {
  /** 02 §9：级联删除不可逆，`strategy` 必须在签名里显式传参，不允许作为默认值 */
  strategy: 'cascade';
  /** 副本正被借出时需显式确认 —— 与 deleteCopy 的语义一致 */
  confirmLentOut?: boolean;
}

/**
 * 连副本一起删除书目（02 §9：deleteBook 有副本时拒绝，级联必须显式发生）。
 * 副本正被借出时需 confirmLentOut —— 与 deleteCopy 的语义一致。
 *
 * 02 §9.1：同一事务内先捕获 undo 快照（书目 + 副本 + 借出全量）再删 ——
 * 不委托 deleteCopy（那会按副本维度各拍一份 undo，互相顶掉）。
 */
export async function deleteBookCompletely(
  db: PocketLibraryDb,
  bookId: string,
  options: DeleteBookOptions,
): Promise<{ copies: number; loans: number }> {
  return db.transaction('rw', db.books, db.copies, db.loans, db.snapshots, db.settings, async () => {
    const book = await db.books.get(bookId);
    if (book === undefined) throw new Error(`书目不存在：${bookId}`);

    const copies = await db.copies.where('bookId').equals(bookId).toArray();
    const copyIds = new Set(copies.map((c) => c.id));
    const loans = (await db.loans.toArray()).filter((l) => copyIds.has(l.copyId));

    const active = loans.filter((l) => l.status === 'active');
    if (active.length > 0 && options.confirmLentOut !== true) {
      const who = active[0]?.borrower ?? '';
      throw new Error(`该副本正被「${who}」借出，删除前请确认（confirmLentOut: true）`);
    }

    await captureUndo(db, { books: [book], copies, loans });

    await db.loans.bulkDelete(loans.map((l) => l.id));
    await db.copies.bulkDelete(copies.map((c) => c.id));
    await db.books.delete(bookId);
    await bumpWriteCounter(db);
    return { copies: copies.length, loans: loans.length };
  });
}
