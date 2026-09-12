/**
 * 书目表单的校验、草稿→实体转换与保存流程（04 §5、§6）。
 *
 * 放在 features 而不是页面里：这些规则要能被 `node --test` 直接测（页面 .tsx 跑不了），
 * 也避免「新增」和「编辑」两个入口各写一份校验。
 */

import {
  createBook,
  deleteBook,
  findBooksByIsbn,
  normalizeTitle,
  updateBook,
  type CreateBookInput,
  type UpdateBookInput,
} from '../../db/books.ts';
import { createCopy, deleteCopy, listCopiesByBook } from '../../db/copies.ts';
import type { PocketLibraryDb } from '../../db/schema.ts';
import { normalizeIsbn } from '../../domain/isbn.ts';
import { parseList } from '../../domain/text.ts';
import { isDateString } from '../../domain/time.ts';
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

export interface DeleteBookOptions {
  /** 02 §9：级联删除不可逆，`strategy` 必须在签名里显式传参，不允许作为默认值 */
  strategy: 'cascade';
  /** 副本正被借出时需显式确认 —— 与 deleteCopy 的语义一致 */
  confirmLentOut?: boolean;
}

/**
 * 连副本一起删除书目（02 §9：deleteBook 有副本时拒绝，级联必须显式发生）。
 * 副本正被借出时需 confirmLentOut —— 与 deleteCopy 的语义一致。
 */
export async function deleteBookCompletely(
  db: PocketLibraryDb,
  bookId: string,
  options: DeleteBookOptions,
): Promise<{ copies: number; loans: number }> {
  const copies = await listCopiesByBook(db, bookId);
  let loans = 0;
  for (const copy of copies) {
    const result = await deleteCopy(db, copy.id, options);
    loans += result.deletedLoans;
  }
  await deleteBook(db, bookId);
  return { copies: copies.length, loans };
}
