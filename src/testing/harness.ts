/**
 * 测试脚手架：每个用例一套独立的假 IndexedDB，互不串味。
 */

import 'fake-indexeddb/auto';
import { freshDbName, seedDefaults } from '../db/client.ts';
import { PocketLibraryDb } from '../db/schema.ts';

/**
 * 建库 → 跑用例 → 关库删库。
 * 所有涉及数据库的测试都必须走这个入口，避免用例之间互相污染。
 */
export async function withDb<T>(fn: (db: PocketLibraryDb) => Promise<T>): Promise<T> {
  const db = new PocketLibraryDb(freshDbName());
  await db.open();
  await seedDefaults(db);
  try {
    return await fn(db);
  } finally {
    db.close();
    await db.delete();
  }
}

/** 空库（不播种），用于测试播种逻辑本身。 */
export async function withRawDb<T>(fn: (db: PocketLibraryDb) => Promise<T>): Promise<T> {
  const db = new PocketLibraryDb(freshDbName('pocket-library-raw'));
  await db.open();
  try {
    return await fn(db);
  } finally {
    db.close();
    await db.delete();
  }
}

export interface DbDump {
  locations: unknown[];
  books: unknown[];
  copies: unknown[];
  loans: unknown[];
  settings: unknown[];
}

/** 全库快照（按 id 排序），用于断言"这次操作没有动过数据库"。 */
export async function dump(db: PocketLibraryDb): Promise<DbDump> {
  const byId = <T extends { id: string }>(rows: T[]): T[] => rows.sort((a, b) => a.id.localeCompare(b.id));
  const [locations, books, copies, loans, settings] = await Promise.all([
    db.locations.toArray(),
    db.books.toArray(),
    db.copies.toArray(),
    db.loans.toArray(),
    db.settings.toArray(),
  ]);
  return {
    locations: byId(locations),
    books: byId(books),
    copies: byId(copies),
    loans: byId(loans),
    settings: settings.sort((a, b) => a.key.localeCompare(b.key)),
  };
}

/** 深拷贝一层快照，便于"操作前 / 操作后"比对。 */
export function snapshot(d: DbDump): string {
  return JSON.stringify(d);
}
