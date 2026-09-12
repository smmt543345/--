/**
 * 启动序列（04 §4），顺序不可调换。
 */

import { openDb } from '../db/client.ts';
import { repairInvariants } from '../db/repair.ts';
import type { PocketLibraryDb } from '../db/schema.ts';
import { requestPersistentStorage } from '../platform/storage.ts';

export interface BootstrapResult {
  db: PocketLibraryDb;
  /** 启动体检修掉的问题（02 §6：导入后、启动时各跑一次），非空时首页横幅提示 */
  repairWarnings: string[];
  /** 持久化存储是否被授予；未授予不影响使用，只是数据可能被系统清理 */
  persisted: boolean;
}

export async function bootstrapApp(): Promise<BootstrapResult> {
  const persisted = await requestPersistentStorage();
  const db = await openDb();
  const report = await repairInvariants(db);
  return { db, repairWarnings: report.warnings, persisted };
}
