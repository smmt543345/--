/**
 * 列表查询。规范见 docs/design/02-data-model.md §10.3。
 *
 * 搜索页与首页的两个数据入口，组合视图一次拼好，不让 UI 自己联表。
 */

import type { Book, CopyWithLocation } from '../domain/types.ts';
import { attachCopyDetails } from './copies.ts';
import type { PocketLibraryDb } from './schema.ts';

/**
 * 全库去重标签（N1，04 §11.5）：取 books 表 `*tags` multiEntry 索引的
 * distinct 键，稳定排序（localeCompare('zh')）。空库返回 []。
 */
export async function listAllTags(db: PocketLibraryDb): Promise<string[]> {
  const keys = await db.books.orderBy('tags').keys();
  const distinct = new Set<string>();
  for (const key of keys) {
    if (typeof key === 'string' && key !== '') distinct.add(key);
  }
  return [...distinct].sort((a, b) => a.localeCompare(b, 'zh'));
}

export interface RecentBookEntry {
  book: Book;
  copies: CopyWithLocation[];
}

/**
 * 最近录入的书目（N2，04 §11.6）：按 createdAt 倒序，limit 截断，
 * 返回与搜索相同的副本组合视图（02 §10.2）。
 */
export async function listRecentBooks(
  db: PocketLibraryDb,
  options: { limit: number },
): Promise<RecentBookEntry[]> {
  const books = (await db.books.toArray()).sort((a, b) =>
    b.createdAt === a.createdAt ? a.id.localeCompare(b.id) : b.createdAt.localeCompare(a.createdAt),
  );
  const picked = books.slice(0, options.limit);
  if (picked.length === 0) return [];

  const pickedIds = new Set(picked.map((b) => b.id));
  const copies = (await db.copies.toArray()).filter((c) => pickedIds.has(c.bookId));
  const detailed = await attachCopyDetails(db, copies);

  const byBook = new Map<string, CopyWithLocation[]>();
  for (const copy of detailed) {
    const bucket = byBook.get(copy.bookId);
    if (bucket === undefined) byBook.set(copy.bookId, [copy]);
    else bucket.push(copy);
  }

  return picked.map((book) => ({ book, copies: byBook.get(book.id) ?? [] }));
}
