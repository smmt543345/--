/**
 * 快照服务。规范见 docs/design/02-data-model.md §9.1、§12。
 *
 * Snapshot 整表唯一写入者（02 §11）；其他 service 不得直接读写快照表，
 * 删除操作经 captureUndo() 在**同一事务内**先写 undo 快照再删。
 *
 * 快照 data 与备份文件 data 段完全一致，复用 buildBackup 同一套序列化路径
 * （02 §12.1），不另造结构。
 */

import { newId } from '../domain/ids.ts';
import { nowIso } from '../domain/time.ts';
import type { Snapshot, SnapshotKind } from '../domain/types.ts';
import { buildBackup } from '../backup/export.ts';
import { rebuildLocationPaths } from './locations.ts';
import { repairInvariants } from './repair.ts';
import {
  AUTO_SNAPSHOT_WRITE_THRESHOLD,
  SETTING_KEYS,
  getSetting,
  resetWriteCounter,
} from './settings.ts';
import type { PocketLibraryDb } from './schema.ts';

/** 自动快照最小间隔（02 §12.3）：距上次 ≥ 1 天才拍。 */
export const AUTO_SNAPSHOT_MIN_INTERVAL_MS = 86_400_000;
/** 滚动保留的 auto/pre-restore 份数（02 §12.3 用户定稿参数）。 */
export const AUTO_SNAPSHOT_RETAIN = 10;

type RestorableKind = Exclude<SnapshotKind, 'undo'>;

/* ------------------------------------------------------------------ *
 * 撤销快照（02 §9.1）
 * ------------------------------------------------------------------ */

/**
 * 删除前捕获受影响记录（02 §9.1）：把将要删除的行**先读出来**存进快照。
 * 一次只挂一份未撤销的 undo —— 新的删除操作顶掉旧的（旧的恢复窗口结束）。
 * **在调用方的事务内运行**；undo 写入不计入写计数器（§12.3）。
 */
export async function captureUndo(
  db: PocketLibraryDb,
  data: Partial<Snapshot['data']>,
  options: { now?: string } = {},
): Promise<Snapshot> {
  const merged = {
    locations: data.locations ?? [],
    books: data.books ?? [],
    copies: data.copies ?? [],
    loans: data.loans ?? [],
    borrowers: data.borrowers ?? [],
  };
  const snapshot: Snapshot = {
    id: newId(),
    kind: 'undo',
    createdAt: options.now ?? nowIso(),
    summary: {
      locations: merged.locations.length,
      books: merged.books.length,
      copies: merged.copies.length,
      loans: merged.loans.length,
      borrowers: merged.borrowers.length,
    },
    data: merged,
  };
  await db.snapshots.where('kind').equals('undo').delete();
  await db.snapshots.put(snapshot);
  return snapshot;
}

/**
 * 撤销恢复 = 按原 id 原样写回记录，随后跑 rebuildLocationPaths()
 * （撤销位置级联删除后，其余位置若在 30 秒内被移动过，物化路径可能已变）。
 * 恢复成功后清理该 undo。返回是否真的撤销了东西。
 */
export async function restoreUndo(db: PocketLibraryDb): Promise<boolean> {
  return db.transaction(
    'rw',
    [db.locations, db.books, db.copies, db.loans, db.borrowers, db.snapshots],
    async () => {
      const undo = await db.snapshots.where('kind').equals('undo').first();
      if (undo === undefined) return false;

      await db.locations.bulkPut(undo.data.locations);
      await db.books.bulkPut(undo.data.books);
      await db.copies.bulkPut(undo.data.copies);
      await db.loans.bulkPut(undo.data.loans);
      await db.borrowers.bulkPut(undo.data.borrowers);
      await db.snapshots.delete(undo.id);
      await rebuildLocationPaths(db);
      return true;
    },
  );
}

/**
 * 过期清理（02 §9.1）：横幅 30 秒超时与启动清理（olderThanMs=0 全清）都走它。
 * `now` 可注入以便测试。返回清理的份数。
 */
export async function expireUndo(
  db: PocketLibraryDb,
  options: { olderThanMs: number },
  now?: string,
): Promise<number> {
  const stamp = now ?? nowIso();
  const cutoff = new Date(Date.parse(stamp) - options.olderThanMs).toISOString();
  const victims = (await db.snapshots.where('kind').equals('undo').toArray()).filter(
    (s) => s.createdAt <= cutoff,
  );
  await db.snapshots.bulkDelete(victims.map((s) => s.id));
  return victims.length;
}

/* ------------------------------------------------------------------ *
 * 自动快照与恢复（02 §12.3 / §12.4）
 * ------------------------------------------------------------------ */

/**
 * 拍一张全库快照（复用 buildBackup 序列化路径，02 §12.1），随后滚动保留
 * 最近 AUTO_SNAPSHOT_RETAIN 份 auto/pre-restore。**在调用方的事务内运行**。
 */
export async function captureSnapshot(
  db: PocketLibraryDb,
  kind: RestorableKind,
  now?: string,
): Promise<Snapshot> {
  const backup = await buildBackup(db);
  const snapshot: Snapshot = {
    id: newId(),
    kind,
    createdAt: now ?? nowIso(),
    summary: backup.counts,
    data: backup.data,
  };
  await db.snapshots.put(snapshot);
  await pruneRestorable(db);
  return snapshot;
}

/** 滚动保留：auto/pre-restore 超出 10 份时删最旧（02 §12.3）。 */
async function pruneRestorable(db: PocketLibraryDb): Promise<void> {
  const restorable = (await db.snapshots.toArray())
    .filter((s) => s.kind !== 'undo')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  const excess = restorable.slice(AUTO_SNAPSHOT_RETAIN);
  if (excess.length > 0) await db.snapshots.bulkDelete(excess.map((s) => s.id));
}

/** 供设置页展示的快照列表（时间 + 各表计数）：不含 undo，按时间倒序（02 §12、04 §11.4）。 */
export async function listSnapshots(db: PocketLibraryDb): Promise<Snapshot[]> {
  return (await db.snapshots.toArray())
    .filter((s) => s.kind !== 'undo')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

/**
 * 自动快照触发（02 §12.3）：计数 ≥ 20 且距上次 ≥ 1 天 → 拍 auto 快照并归零计数器。
 * bumpWriteCounter 只负责排程，本函数在写事务提交后执行（竞态接受，不加锁）。
 */
export async function captureAutoSnapshotIfDue(db: PocketLibraryDb, now?: string): Promise<boolean> {
  const stamp = now ?? nowIso();
  const count = await getSetting<number>(db, SETTING_KEYS.writesSinceSnapshot, 0);
  if (typeof count !== 'number' || count < AUTO_SNAPSHOT_WRITE_THRESHOLD) return false;

  const last = await getSetting<string>(db, SETTING_KEYS.lastAutoSnapshotAt, '');
  if (last !== '' && Date.parse(stamp) - Date.parse(last) < AUTO_SNAPSHOT_MIN_INTERVAL_MS) {
    return false;
  }

  await db.transaction(
    'rw',
    [db.locations, db.books, db.copies, db.loans, db.borrowers, db.snapshots, db.settings],
    async () => {
      await captureSnapshot(db, 'auto', stamp);
      await resetWriteCounter(db, stamp);
    },
  );
  return true;
}

let pendingAutoSnapshotChecks: Promise<void> = Promise.resolve();

/** 排程一次自动快照检查（串行执行）；快照失败不阻塞业务 —— 快照是兜底，不是主路径。 */
export function scheduleAutoSnapshot(db: PocketLibraryDb): void {
  pendingAutoSnapshotChecks = pendingAutoSnapshotChecks
    .then(async () => {
      await captureAutoSnapshotIfDue(db);
    })
    .catch(() => {
      /* 兜底失败保持静默：写操作本身已经成功落盘 */
    });
}

/** 测试用：等待全部已排程的自动快照检查落定（不依赖挂钟）。 */
export function whenAutoSnapshotSettled(): Promise<void> {
  return pendingAutoSnapshotChecks;
}

/**
 * 恢复快照（02 §12.4）：replace 语义 —— 清空五张业务表 + 整体写入快照 data，
 * 写入后跑 rebuildLocationPaths + repairInvariants；settings 与其余快照不动。
 * 恢复前先自动拍 pre-restore 快照（恢复本身允许反悔），并清理当前 undo
 * （§9.1：旧撤销会把已恢复掉的数据写回）。
 * 恢复/撤销的写入不计入写计数器（§12.3）。
 */
export async function restoreSnapshot(db: PocketLibraryDb, snapshotId: string, now?: string): Promise<Snapshot> {
  return db.transaction(
    'rw',
    [db.locations, db.books, db.copies, db.loans, db.borrowers, db.snapshots, db.settings],
    async () => {
      const target = await db.snapshots.get(snapshotId);
      if (target === undefined) throw new Error(`快照不存在：${snapshotId}`);
      if (target.kind === 'undo') throw new Error('undo 快照只用于撤销，不能整体恢复');

      await captureSnapshot(db, 'pre-restore', now);
      await db.snapshots.where('kind').equals('undo').delete();

      await db.loans.clear();
      await db.copies.clear();
      await db.books.clear();
      await db.locations.clear();
      await db.borrowers.clear();
      await db.locations.bulkPut(target.data.locations);
      await db.books.bulkPut(target.data.books);
      await db.copies.bulkPut(target.data.copies);
      await db.loans.bulkPut(target.data.loans);
      await db.borrowers.bulkPut(target.data.borrowers);

      await rebuildLocationPaths(db);
      await repairInvariants(db);
      return target;
    },
  );
}
