/**
 * Dexie schema。规范见 docs/design/02-data-model.md §8。
 *
 * 版本升级纪律（务必遵守）：
 * 1. 已发布过的 version(N) 一个字都不许改 —— 老用户要靠它逐级迁移。
 * 2. 加字段 → 新增 version(N+1)，并在 upgrade() 里补默认值。
 * 3. 删索引/删表先"停止使用"一版，下一版再删。
 */

import Dexie, { type Table } from 'dexie';
import type { Book, Borrower, Copy, Cover, Loan, Location, Setting, Snapshot } from '../domain/types.ts';

/** 当前 schema 版本，导出备份时要写进文件（03 §2）。 */
export const SCHEMA_VERSION = 3;

export const DB_NAME = 'pocket-library';

export class PocketLibraryDb extends Dexie {
  locations!: Table<Location, string>;
  books!: Table<Book, string>;
  copies!: Table<Copy, string>;
  loans!: Table<Loan, string>;
  borrowers!: Table<Borrower, string>;
  covers!: Table<Cover, string>;
  snapshots!: Table<Snapshot, string>;
  settings!: Table<Setting, string>;

  constructor(name: string = DB_NAME) {
    super(name);

    // 注：parentId 为 null 的记录不会进入索引（IndexedDB 不索引 null），
    // 顶层位置的查询在内存里做，见 02 §8。
    this.version(1).stores({
      locations: 'id, parentId, path, type, [parentId+sortOrder]',
      books: 'id, isbn, title, createdAt, updatedAt, *tags',
      copies: 'id, bookId, locationId, status, [bookId+locationId]',
      loans: 'id, copyId, status, dueDate, [copyId+status]',
      settings: 'key',
    });

    // P0-4（schema v2，02 §8）：只加表，不改旧表 —— 无回填。
    this.version(2).stores({
      borrowers: 'id, name',
      snapshots: 'id, kind, createdAt',
    });

    // B4（schema v3，02 §8）：封面照片表（bookId 作主键，一本书一张）。
    this.version(3).stores({
      covers: 'bookId',
    });
  }
}
