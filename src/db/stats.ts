/**
 * 统计。规范见 docs/design/02-data-model.md §10.1。
 */

import { today } from '../domain/time.ts';
import type { Book, CopyStatus } from '../domain/types.ts';
import { normalizeTitle } from './books.ts';
import type { PocketLibraryDb } from './schema.ts';

export interface LibraryStats {
  books: number;
  copies: number;
  onShelf: number;
  lentOut: number;
  lost: number;
  sold: number;
  /** 进行中的借出条数；应与 lentOut 恒等（不等即 I7 违规） */
  activeLoans: number;
  /** 进行中且已过应还日期的条数 */
  overdueLoans: number;
}

export interface LocationStat {
  locationId: string;
  name: string;
  path: string;
  depth: number;
  /** 直接放在该位置的副本数 */
  direct: number;
  /** 含所有子位置的副本数（UI 默认显示这个） */
  subtree: number;
}

export interface DuplicateReport {
  /** 同一 ISBN 存在多条书目记录 —— 导入后可能出现，必须能查到 */
  byIsbn: Book[][];
  /** 书名规范化后相同（且 ISBN 不同）的书目，标为「疑似重复」 */
  suspectedByTitle: Book[][];
}

/**
 * 每个位置的子树副本数（含自身）。
 * 后序遍历 + 记忆化；遇环返回 0 且不缓存，保证脏数据下也能终止。
 */
export function computeSubtreeCounts(
  locations: readonly { id: string; parentId: string | null }[],
  copyLocationIds: readonly string[],
): Map<string, number> {
  const direct = new Map<string, number>();
  for (const locationId of copyLocationIds) {
    direct.set(locationId, (direct.get(locationId) ?? 0) + 1);
  }

  const children = new Map<string | null, string[]>();
  for (const location of locations) {
    const bucket = children.get(location.parentId);
    if (bucket === undefined) children.set(location.parentId, [location.id]);
    else bucket.push(location.id);
  }

  const memo = new Map<string, number>();
  const visiting = new Set<string>();

  const visit = (id: string): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0; // 环保护：不缓存，避免把错误值固化成"事实"

    visiting.add(id);
    let total = direct.get(id) ?? 0;
    for (const child of children.get(id) ?? []) total += visit(child);
    visiting.delete(id);
    memo.set(id, total);
    return total;
  };

  for (const location of locations) visit(location.id);
  return memo;
}

export async function getStats(db: PocketLibraryDb, reference: string = today()): Promise<LibraryStats> {
  const [books, copies, loans] = await Promise.all([
    db.books.count(),
    db.copies.toArray(),
    db.loans.toArray(),
  ]);

  const byStatus: Record<CopyStatus, number> = { on_shelf: 0, lent_out: 0, lost: 0, sold: 0 };
  for (const copy of copies) byStatus[copy.status] += 1;

  const active = loans.filter((l) => l.status === 'active');
  const overdue = active.filter((l) => l.dueDate !== '' && l.dueDate < reference);

  return {
    books,
    copies: copies.length,
    onShelf: byStatus.on_shelf,
    lentOut: byStatus.lent_out,
    lost: byStatus.lost,
    sold: byStatus.sold,
    activeLoans: active.length,
    overdueLoans: overdue.length,
  };
}

/**
 * 四张业务表的行数。供备份/设置页的「当前数据量」展示与破坏性操作确认文案使用
 * （04 §6：数量一律从实际查询取，不猜）。
 */
export interface LibraryCounts {
  locations: number;
  books: number;
  copies: number;
  loans: number;
}

export async function getLibraryCounts(db: PocketLibraryDb): Promise<LibraryCounts> {
  const [locations, books, copies, loans] = await Promise.all([
    db.locations.count(),
    db.books.count(),
    db.copies.count(),
    db.loans.count(),
  ]);
  return { locations, books, copies, loans };
}

/**
 * 各位置藏书量。两种口径都给：
 * - direct：直接放在该位置的副本
 * - subtree：含所有子位置（用户问"客厅有多少本书"时指的是这个）
 */
export async function getCopiesByLocation(db: PocketLibraryDb): Promise<LocationStat[]> {
  const [locations, copies] = await Promise.all([db.locations.toArray(), db.copies.toArray()]);
  const subtree = computeSubtreeCounts(
    locations.map((l) => ({ id: l.id, parentId: l.parentId })),
    copies.map((c) => c.locationId),
  );

  const directCount = new Map<string, number>();
  for (const copy of copies) directCount.set(copy.locationId, (directCount.get(copy.locationId) ?? 0) + 1);

  return locations
    .map((location) => ({
      locationId: location.id,
      name: location.name,
      path: location.path,
      depth: location.depth,
      direct: directCount.get(location.id) ?? 0,
      subtree: subtree.get(location.id) ?? 0,
    }))
    .sort((a, b) => a.path.localeCompare(b.path, 'zh'));
}

export async function getDuplicateBooks(db: PocketLibraryDb): Promise<DuplicateReport> {
  const books = await db.books.toArray();

  const groupBy = (keyOf: (book: Book) => string): Map<string, Book[]> => {
    const groups = new Map<string, Book[]>();
    for (const book of books) {
      const key = keyOf(book);
      if (key === '') continue;
      const bucket = groups.get(key);
      if (bucket === undefined) groups.set(key, [book]);
      else bucket.push(book);
    }
    return groups;
  };

  const pick = (groups: Map<string, Book[]>): Book[][] =>
    [...groups.values()].filter((group) => group.length > 1).sort((a, b) => b.length - a.length);

  const byIsbn = pick(groupBy((book) => book.isbn));

  // 同一 ISBN 的分组已经报告过，书名分组里排除掉，避免同一批书报两次
  const suspectedByTitle = pick(groupBy((book) => normalizeTitle(book.title))).filter((group) => {
    const isbns = new Set(group.map((b) => b.isbn).filter((i) => i !== ''));
    // 组内所有书共享同一个非空 ISBN → 属于 byIsbn 的范畴
    return !(isbns.size === 1 && group.every((b) => b.isbn !== ''));
  });

  return { byIsbn, suspectedByTitle };
}
