/**
 * 书目服务。规范见 docs/design/02-data-model.md §3、§7.3、§9、§10.2。
 */

import { newId } from '../domain/ids.ts';
import { toIsbn13 } from '../domain/isbn.ts';
import { collectSubtreeIds } from '../domain/location-path.ts';
import { nowIso } from '../domain/time.ts';
import type { Book, BookDetail, BookSearchResult, Copy, CopyStatus, MatchField } from '../domain/types.ts';
import { attachCopyDetails } from './copies.ts';
import type { PocketLibraryDb } from './schema.ts';
import { bumpWriteCounter } from './settings.ts';

export interface CreateBookInput {
  isbn?: string;
  title?: string;
  authors?: string[];
  publisher?: string;
  publishDate?: string;
  coverUrl?: string;
  tags?: string[];
}

export type UpdateBookInput = Partial<CreateBookInput>;

export interface SearchBooksOptions {
  keyword?: string;
  /** 命中该位置**及其所有子位置**（子树口径，与统计一致） */
  locationId?: string;
  status?: CopyStatus;
  tag?: string;
  limit?: number;
}

/**
 * 书名规范化，用于「疑似重复」检测：去空格与标点、转小写。
 *
 * 标点写成显式清单而不是 `\p{P}`：前者能开口子，后者一律抹平。
 * 开口子的是**有意义的字符**：`#` 与 `+`（「C#」「C++」被抹平就撞成同一本「C」）。
 * 除它俩之外，ASCII 与全角两套标点都要覆盖 —— 中文书的题名多半直接照抄自书店页面，
 * 全角/半角混用是常态（《活着》（余华）与《活着》(余华) 必须认成同一本），
 * 书名号《》、日文中点 `・` 也在常见形态里，漏掉它们等于让检测对最常见的输入失效。
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .replace(/[·・•:：;；,，.。．、…\-－—_()（）[\]【】〔〕［］｛｝《》〈〉「」『』"'“”‘’!！?？/~|=&%*<>@\\～〜／｜＝＆％＊＜＞＠＼]/g, '');
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const text = cleanString(item);
    if (text === '' || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

export async function getBook(db: PocketLibraryDb, id: string): Promise<Book | undefined> {
  return db.books.get(id);
}

/**
 * 按 ISBN 查已有书目。isbn 会被规范化，空/无效一律返回 undefined
 * ——空串不参与查重，否则所有无 ISBN 的书会互相碰撞（02 §7.3）。
 */
export async function findBookByIsbn(db: PocketLibraryDb, isbn: string): Promise<Book | undefined> {
  const normalized = toIsbn13(isbn);
  if (normalized === '') return undefined;
  return db.books.where('isbn').equals(normalized).first();
}

/** 同一个 ISBN 存在多条书目记录（导入后可能出现），需要能查出来。 */
export async function findBooksByIsbn(db: PocketLibraryDb, isbn: string): Promise<Book[]> {
  const normalized = toIsbn13(isbn);
  if (normalized === '') return [];
  return db.books.where('isbn').equals(normalized).toArray();
}

export async function createBook(db: PocketLibraryDb, input: CreateBookInput): Promise<Book> {
  return db.transaction('rw', db.books, db.settings, async () => {
    const stamp = nowIso();
    const book: Book = {
      id: newId(),
      isbn: toIsbn13(input.isbn ?? ''),
      title: cleanString(input.title),
      authors: cleanList(input.authors),
      publisher: cleanString(input.publisher),
      publishDate: cleanString(input.publishDate),
      coverUrl: cleanString(input.coverUrl),
      tags: cleanList(input.tags),
      createdAt: stamp,
      updatedAt: stamp,
    };
    await db.books.put(book);
    await bumpWriteCounter(db);
    return book;
  });
}

export async function updateBook(db: PocketLibraryDb, id: string, patch: UpdateBookInput): Promise<Book> {
  return db.transaction('rw', db.books, db.settings, async () => {
    const book = await db.books.get(id);
    if (book === undefined) throw new Error(`书目不存在：${id}`);

    if (patch.isbn !== undefined) book.isbn = toIsbn13(patch.isbn);
    if (patch.title !== undefined) book.title = cleanString(patch.title);
    if (patch.authors !== undefined) book.authors = cleanList(patch.authors);
    if (patch.publisher !== undefined) book.publisher = cleanString(patch.publisher);
    if (patch.publishDate !== undefined) book.publishDate = cleanString(patch.publishDate);
    if (patch.coverUrl !== undefined) book.coverUrl = cleanString(patch.coverUrl);
    if (patch.tags !== undefined) book.tags = cleanList(patch.tags);

    book.updatedAt = nowIso();
    await db.books.put(book);
    await bumpWriteCounter(db);
    return book;
  });
}

/**
 * 删除书目（02 §9）：有副本时**拒绝**，必须先删除或转移副本。
 * 刻意不提供级联参数 —— 级联删掉的是实体书，不该由一个默认值决定。
 */
export async function deleteBook(db: PocketLibraryDb, id: string): Promise<void> {
  await db.transaction('rw', db.books, db.copies, db.settings, async () => {
    const book = await db.books.get(id);
    if (book === undefined) throw new Error(`书目不存在：${id}`);

    const copies = await db.copies.where('bookId').equals(id).count();
    if (copies > 0) {
      throw new Error(`该书目还有 ${copies} 本副本，请先删除或转移副本`);
    }
    await db.books.delete(id);
    await bumpWriteCounter(db);
  });
}

export async function listBooks(db: PocketLibraryDb): Promise<Book[]> {
  const books = await db.books.toArray();
  return books.sort((a, b) => a.title.localeCompare(b.title, 'zh'));
}

export async function getBookDetail(db: PocketLibraryDb, id: string): Promise<BookDetail | undefined> {
  const book = await db.books.get(id);
  if (book === undefined) return undefined;

  const copies = await db.copies.where('bookId').equals(id).toArray();
  const withLocation = await attachCopyDetails(db, copies);

  const copyIds = new Set(copies.map((c) => c.id));
  const loans = (await db.loans.toArray())
    .filter((l) => copyIds.has(l.copyId))
    .sort((a, b) =>
      a.loanDate === b.loanDate ? b.createdAt.localeCompare(a.createdAt) : b.loanDate.localeCompare(a.loanDate),
    );

  return { book, copies: withLocation, loans };
}

function matchBook(book: Book, keyword: string): MatchField[] {
  const needle = keyword.trim().toLowerCase();
  if (needle === '') return [];
  const matched: MatchField[] = [];
  if (book.title.toLowerCase().includes(needle)) matched.push('title');
  if (book.authors.some((a) => a.toLowerCase().includes(needle))) matched.push('author');
  if (book.isbn.includes(needle)) matched.push('isbn');
  if (book.tags.some((t) => t.toLowerCase().includes(needle))) matched.push('tag');
  if (book.publisher.toLowerCase().includes(needle)) matched.push('publisher');
  return matched;
}

/**
 * 搜索（02 §10.2）。
 *
 * 实现方式是全表读进内存过滤：藏书量在千级，IndexedDB 的 filter 更慢，
 * 且跨表（副本、位置）本来就要在内存里 join。阀值与升级路径见文档。
 */
export async function searchBooks(
  db: PocketLibraryDb,
  options: SearchBooksOptions = {},
): Promise<BookSearchResult[]> {
  const keyword = (options.keyword ?? '').trim();
  const hasBookFilter = keyword !== '';
  // tag 是书目维度的条件，只影响「要不要走筛选分支」；位置与状态是副本维度的条件。
  const hasCopyFilter = options.locationId !== undefined || options.status !== undefined || options.tag !== undefined;
  const needsCopyMatch = options.locationId !== undefined || options.status !== undefined;
  if (!hasBookFilter && !hasCopyFilter) {
    const books = await listBooks(db);
    const copies = await db.copies.toArray();
    const detailed = await attachCopyDetails(db, copies);
    const byBook = new Map<string, typeof detailed>();
    for (const copy of detailed) {
      const bucket = byBook.get(copy.bookId);
      if (bucket === undefined) byBook.set(copy.bookId, [copy]);
      else bucket.push(copy);
    }
    const results: BookSearchResult[] = books.map((book) => ({
      book,
      copies: byBook.get(book.id) ?? [],
      matched: [],
    }));
    // 没有筛选条件时也照样受 limit 约束 —— limit 是结果条数上限，与「筛没筛」无关（02 §10.2）。
    return options.limit === undefined ? results : results.slice(0, options.limit);
  }

  const [books, copies, locations] = await Promise.all([
    db.books.toArray(),
    db.copies.toArray(),
    db.locations.toArray(),
  ]);

  let locationIds: Set<string> | null = null;
  if (options.locationId !== undefined) {
    locationIds = collectSubtreeIds(options.locationId, locations);
  }

  const detailed = await attachCopyDetails(db, copies);
  const byBook = new Map<string, typeof detailed>();
  for (const copy of detailed) {
    const bucket = byBook.get(copy.bookId);
    if (bucket === undefined) byBook.set(copy.bookId, [copy]);
    else bucket.push(copy);
  }

  const results: BookSearchResult[] = [];
  for (const book of books) {
    const matched = matchBook(book, keyword);
    let bookCopies = byBook.get(book.id) ?? [];

    if (locationIds !== null) bookCopies = bookCopies.filter((c) => locationIds.has(c.locationId));
    if (options.status !== undefined) bookCopies = bookCopies.filter((c) => c.status === options.status);
    if (options.tag !== undefined) {
      const tag = options.tag.trim().toLowerCase();
      if (tag !== '' && !book.tags.some((t) => t.toLowerCase() === tag)) continue;
    }

    if (hasBookFilter && matched.length === 0) continue;
    // 所有条件同时生效（AND）：有副本维度的条件时，"客厅里没有这本书"就不该出现在结果里。
    // 只有 tag 时保持宽松 —— 允许「有标签但一本实体都没有」的书出现，标签是书目维度的条件。
    if (needsCopyMatch && bookCopies.length === 0) continue;

    results.push({ book, copies: bookCopies, matched });
  }

  results.sort((a, b) => a.book.title.localeCompare(b.book.title, 'zh'));
  return options.limit === undefined ? results : results.slice(0, options.limit);
}

/** 某书目下的副本数（按状态），供详情页与删除确认使用。 */
export async function countCopiesByStatus(
  db: PocketLibraryDb,
  bookId: string,
): Promise<Record<CopyStatus, number>> {
  const copies: Copy[] = await db.copies.where('bookId').equals(bookId).toArray();
  const counts: Record<CopyStatus, number> = { on_shelf: 0, lent_out: 0, lost: 0, sold: 0 };
  for (const copy of copies) counts[copy.status] += 1;
  return counts;
}
