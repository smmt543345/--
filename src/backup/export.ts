/**
 * 导出。规范见 docs/design/03-backup-and-merge.md §3.2。
 *
 * 导出的序列化路径与自动快照完全相同：只此一份实现，不另造第二套。
 */

import { SCHEMA_VERSION } from '../db/schema.ts';
import { SETTING_KEYS, getSetting, setSetting } from '../db/settings.ts';
import type { PocketLibraryDb } from '../db/schema.ts';
import { nowIso } from '../domain/time.ts';
import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION, serializeBackup, type BackupFile } from './format.ts';

export interface ExportOptions {
  /** 不传则取本机设置里的 deviceName */
  deviceName?: string;
}

/** 从数据层生成一份备份对象（不落盘；落盘由 platform 层决定）。 */
export async function buildBackup(db: PocketLibraryDb, options: ExportOptions = {}): Promise<BackupFile> {
  // 一次性读取四张表；不引入第二套序列化
  const [locations, books, copies, loans] = await Promise.all([
    db.locations.toArray(),
    db.books.toArray(),
    db.copies.toArray(),
    db.loans.toArray(),
  ]);

  const deviceName = options.deviceName ?? (await getSetting<string>(db, SETTING_KEYS.deviceName, ''));

  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: nowIso(),
    deviceName,
    counts: {
      locations: locations.length,
      books: books.length,
      copies: copies.length,
      loans: loans.length,
    },
    data: { locations, books, copies, loans },
  };
}

/** 生成可直接写文件的 JSON 文本。 */
export async function exportToJson(db: PocketLibraryDb, options: ExportOptions = {}): Promise<string> {
  return serializeBackup(await buildBackup(db, options));
}

/** 手动导出后记录时间，供首页「上次导出：N 天前」提示使用。 */
export async function markExported(db: PocketLibraryDb): Promise<void> {
  await setSetting(db, SETTING_KEYS.lastExportAt, nowIso());
}

export function backupFileName(at: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
  return `pocket-library-${stamp}.json`;
}
