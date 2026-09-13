/**
 * 键值配置。规范见 docs/design/01-architecture.md §3.3。
 *
 * settings 表不进备份文件（03 §2）：里面是设备专属状态。
 */

import type { PocketLibraryDb } from './schema.ts';
import { nowIso } from '../domain/time.ts';
import type { Setting } from '../domain/types.ts';

export const SETTING_KEYS = {
  /** 上次自动快照时间（ISO 时间戳） */
  lastAutoSnapshotAt: 'lastAutoSnapshotAt',
  /** 距上次快照的写操作次数 */
  writesSinceSnapshot: 'writesSinceSnapshot',
  /** 上次手动导出时间（ISO 时间戳） */
  lastExportAt: 'lastExportAt',
  /** 默认借期（天） */
  loanPeriodDays: 'loanPeriodDays',
  /** 滚动保留的快照份数 */
  snapshotRetainCount: 'snapshotRetainCount',
  /** 本机名称，仅写进备份文件用于展示 */
  deviceName: 'deviceName',
  /** 界面主题，属于"本机偏好"，清空数据时保留 */
  theme: 'theme',
  /** AI 接口地址（OpenAI 兼容，05 §3.1） */
  aiBaseUrl: 'aiBaseUrl',
  /** AI 密钥（只存本机，不进备份） */
  aiApiKey: 'aiApiKey',
  /** AI 模型名 */
  aiModel: 'aiModel',
  /** 新增表单记忆：上次保存时的位置/品相/标签（04 §11.2，设备专属，不进备份） */
  lastDraftPrefs: 'lastDraftPrefs',
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

export const DEFAULT_SETTINGS: Record<string, unknown> = {
  [SETTING_KEYS.lastAutoSnapshotAt]: '',
  [SETTING_KEYS.writesSinceSnapshot]: 0,
  [SETTING_KEYS.lastExportAt]: '',
  [SETTING_KEYS.loanPeriodDays]: 30,
  [SETTING_KEYS.snapshotRetainCount]: 5,
  [SETTING_KEYS.deviceName]: '',
  [SETTING_KEYS.theme]: 'system',
  [SETTING_KEYS.aiBaseUrl]: 'https://api.openai.com/v1',
  [SETTING_KEYS.aiApiKey]: '',
  [SETTING_KEYS.aiModel]: 'gpt-4o-mini',
  [SETTING_KEYS.lastDraftPrefs]: {},
};

/** 清空数据时要重置的键（其余本机偏好保留）。见 02 §9。 */
export const RESETTABLE_SETTING_KEYS: SettingKey[] = [
  SETTING_KEYS.lastAutoSnapshotAt,
  SETTING_KEYS.writesSinceSnapshot,
  SETTING_KEYS.lastExportAt,
];

export async function getSetting<T>(db: PocketLibraryDb, key: SettingKey, fallback: T): Promise<T> {
  const row = await db.settings.get(key);
  return row === undefined ? fallback : (row.value as T);
}

export async function setSetting(db: PocketLibraryDb, key: SettingKey, value: unknown): Promise<void> {
  const row: Setting = { key, value, updatedAt: nowIso() };
  await db.settings.put(row);
}

/** 播种缺省的 settings 行（已存在的不覆盖）。 */
export async function ensureDefaultSettings(db: PocketLibraryDb): Promise<void> {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    const existing = await db.settings.get(key);
    if (existing === undefined) {
      await db.settings.put({ key, value, updatedAt: nowIso() });
    }
  }
}

export async function resetSettings(db: PocketLibraryDb): Promise<void> {
  for (const key of RESETTABLE_SETTING_KEYS) {
    const value = DEFAULT_SETTINGS[key];
    await db.settings.put({ key, value, updatedAt: nowIso() });
  }
}

/**
 * 写操作计数器（01 §3.3）。所有 service 写操作在**同一个事务内**调用它，
 * 供自动快照判断是否需要落盘。
 *
 * 闭环（02 §12.3）：计数达到阈值后，在**写事务提交之后**由快照 service 异步拍
 * auto 快照并归零。这里只负责排程 —— 用动态 import 避免 settings ↔ snapshots 循环依赖。
 */
export const AUTO_SNAPSHOT_WRITE_THRESHOLD = 20;

async function scheduleAutoSnapshotCheck(db: PocketLibraryDb): Promise<void> {
  const { scheduleAutoSnapshot } = await import('./snapshots.ts');
  scheduleAutoSnapshot(db);
}

export async function bumpWriteCounter(db: PocketLibraryDb): Promise<number> {
  const current = await getSetting<number>(db, SETTING_KEYS.writesSinceSnapshot, 0);
  const next = (typeof current === 'number' ? current : 0) + 1;
  await setSetting(db, SETTING_KEYS.writesSinceSnapshot, next);
  if (next >= AUTO_SNAPSHOT_WRITE_THRESHOLD) {
    void scheduleAutoSnapshotCheck(db);
  }
  return next;
}

/** 按条数计（02 §12.3）：applyImport 按实际变更条数（写进业务表的行数）计入。 */
export async function bumpWriteCounterBy(db: PocketLibraryDb, count: number): Promise<void> {
  if (!Number.isInteger(count) || count <= 0) return;
  const current = await getSetting<number>(db, SETTING_KEYS.writesSinceSnapshot, 0);
  const next = (typeof current === 'number' ? current : 0) + count;
  await setSetting(db, SETTING_KEYS.writesSinceSnapshot, next);
  if (next >= AUTO_SNAPSHOT_WRITE_THRESHOLD) {
    void scheduleAutoSnapshotCheck(db);
  }
}

export async function resetWriteCounter(db: PocketLibraryDb, snapshotAt: string = nowIso()): Promise<void> {
  await setSetting(db, SETTING_KEYS.writesSinceSnapshot, 0);
  await setSetting(db, SETTING_KEYS.lastAutoSnapshotAt, snapshotAt);
}
