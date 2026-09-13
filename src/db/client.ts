/**
 * 数据库实例的创建、播种与清空。
 */

import { UNSORTED_LOCATION_ID, UNSORTED_LOCATION_NAME } from '../domain/ids.ts';
import { nowIso } from '../domain/time.ts';
import type { Location } from '../domain/types.ts';
import { DB_NAME, PocketLibraryDb } from './schema.ts';
import { ensureDefaultSettings, resetSettings } from './settings.ts';

export function createDb(name: string = DB_NAME): PocketLibraryDb {
  return new PocketLibraryDb(name);
}

/** 「未分类」的播种行。sortOrder = -1，保证它排在同层第一位。 */
export function unsortedLocation(stamp: string = nowIso()): Location {
  return {
    id: UNSORTED_LOCATION_ID,
    parentId: null,
    name: UNSORTED_LOCATION_NAME,
    path: UNSORTED_LOCATION_NAME,
    depth: 0,
    type: 'home',
    sortOrder: -1,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

/**
 * 幂等播种：确保「未分类」位置与缺省 settings 存在。
 * 已存在的行不覆盖（否则每次启动都会把用户数据改掉）。
 */
export async function seedDefaults(db: PocketLibraryDb): Promise<void> {
  await db.transaction('rw', db.locations, db.settings, async () => {
    const existing = await db.locations.get(UNSORTED_LOCATION_ID);
    if (existing === undefined) {
      await db.locations.put(unsortedLocation());
    }
    await ensureDefaultSettings(db);
  });
}

export async function openDb(name: string = DB_NAME): Promise<PocketLibraryDb> {
  const db = createDb(name);
  await db.open();
  await seedDefaults(db);
  return db;
}

/**
 * 清空数据（02 §9）：删除六张业务表（locations/books/copies/loans/borrowers/covers）
 * 全部记录，**保留** settings（主题、AI 配置、表单记忆等本机偏好）与快照表（清空后仍可用
 * 快照恢复，04 §11.4），并重新播种「未分类」。
 */
export async function clearAllData(db: PocketLibraryDb): Promise<void> {
  await db.transaction(
    'rw',
    [db.locations, db.books, db.copies, db.loans, db.borrowers, db.covers, db.settings],
    async () => {
      await db.loans.clear();
      await db.copies.clear();
      await db.books.clear();
      await db.locations.clear();
      await db.borrowers.clear();
      await db.covers.clear();
      await resetSettings(db);
      await db.locations.put(unsortedLocation());
    },
  );
}

/**
 * 仅打开一个无副作用的空库（测试用）：不播种、不清空。
 */
export function freshDbName(prefix = 'pocket-library-test'): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${suffix}`;
}
