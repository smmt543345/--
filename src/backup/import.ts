/**
 * 导入合并。规范见 docs/design/03-backup-and-merge.md §4、§5、§6、§7、§8。
 *
 * 三条铁律：
 * 1. 全程一个事务，任一步抛错整体回滚 —— 宁可没导入，也不能留半套数据。
 * 2. 导入绝不静默丢数据：任何跳过都要进摘要的警告列表。
 * 3. 导入幂等：同一个文件导入两次，第二次必须 0 变更。
 */

import { UNSORTED_LOCATION_ID } from '../domain/ids.ts';
import { nowIso } from '../domain/time.ts';
import type { Book, Copy, Loan, Location } from '../domain/types.ts';
import { unsortedLocation } from '../db/client.ts';
import { rebuildLocationPaths } from '../db/locations.ts';
import { getActiveLoanForCopy } from '../db/loans.ts';
import { repairInvariants } from '../db/repair.ts';
import type { PocketLibraryDb } from '../db/schema.ts';
import { bumpWriteCounterBy } from '../db/settings.ts';
import { mergeBorrowers } from './merge-borrowers.ts';
import {
  createWarningCollector,
  deepEqual,
  mergeRecord,
  parseBackup,
  type BackupFile,
  type ImportMode,
  type ImportOptions,
  type ImportSummary,
} from './format.ts';

/** 空事务回滚信号：预览 = 「完整跑一遍然后整体回滚」（03 §7）。 */
const DRY_RUN_SIGNAL = { dryRun: true } as const;

function emptySummary(mode: ImportMode, dryRun: boolean): ImportSummary {
  return {
    mode,
    dryRun,
    locations: { inserted: 0, updated: 0, reparented: 0, conflictingNames: [] },
    books: { inserted: 0, updated: 0, mergedByIsbn: 0 },
    copies: { inserted: 0, updated: 0, skipped: 0, relocated: 0 },
    loans: { inserted: 0, updated: 0, skipped: 0, conflicts: 0 },
    borrowers: { inserted: 0, updated: 0 },
    warnings: [],
    durationMs: 0,
  };
}

/* ------------------------------------------------------------------ *
 * 位置（03 §4.1）
 * ------------------------------------------------------------------ */

async function mergeLocations(
  db: PocketLibraryDb,
  incoming: readonly Location[],
  summary: ImportSummary,
  warn: (message: string) => void,
): Promise<void> {
  const priorByName = new Map<string, string[]>();
  for (const location of await db.locations.toArray()) {
    const bucket = priorByName.get(location.name);
    if (bucket === undefined) priorByName.set(location.name, [location.id]);
    else bucket.push(location.id);
  }

  for (const location of incoming) {
    const forced = location.id === UNSORTED_LOCATION_ID ? { ...location, parentId: null } : location;
    const local = await db.locations.get(location.id);

    if (local === undefined) {
      await db.locations.put(forced);
      summary.locations.inserted += 1;
    } else {
      const { record } = mergeRecord(local, forced);
      const normalized = record.id === UNSORTED_LOCATION_ID ? { ...record, parentId: null } : record;
      if (!deepEqual(normalized, local)) {
        await db.locations.put(normalized);
        summary.locations.updated += 1;
      }
    }

    if (location.id !== UNSORTED_LOCATION_ID) {
      const ids = priorByName.get(location.name) ?? [];
      if (ids.some((id) => id !== location.id) && !summary.locations.conflictingNames.includes(location.name)) {
        summary.locations.conflictingNames.push(location.name);
      }
    }
  }

  // 必须等全部插入之后再判断父节点，因为父节点可能排在数组后面
  for (const location of incoming) {
    const current = await db.locations.get(location.id);
    if (current === undefined) continue;
    if (current.parentId === null || current.parentId === UNSORTED_LOCATION_ID) continue;
    if ((await db.locations.get(current.parentId)) !== undefined) continue;

    await db.locations.put({ ...current, parentId: UNSORTED_LOCATION_ID, updatedAt: nowIso() });
    summary.locations.reparented += 1;
    warn(`位置「${current.name}」的上级位置在本地不存在，已挂到「未分类」`);
  }
}

/* ------------------------------------------------------------------ *
 * 书目（03 §4.2）：两遍 —— 先按 id，再按 ISBN
 * ------------------------------------------------------------------ */

async function mergeBooks(
  db: PocketLibraryDb,
  incoming: readonly Book[],
  summary: ImportSummary,
): Promise<Map<string, string>> {
  const idRemap = new Map<string, string>();
  const unresolved: Book[] = [];

  for (const book of incoming) {
    const local = await db.books.get(book.id);
    if (local === undefined) {
      unresolved.push(book);
      continue;
    }
    const { record, changed } = mergeRecord(local, book, ['tags']);
    if (changed) {
      await db.books.put(record);
      summary.books.updated += 1;
    }
    idRemap.set(book.id, local.id);
  }

  for (const book of unresolved) {
    if (book.isbn !== '') {
      const existing = await db.books.where('isbn').equals(book.isbn).first();
      if (existing !== undefined) {
        const { record, changed } = mergeRecord(existing, book, ['tags']);
        if (changed) {
          await db.books.put(record);
          summary.books.updated += 1;
        }
        // 关键：把传入方的书目 id 重指向本地那条，否则它的副本会指向被丢弃的记录
        idRemap.set(book.id, existing.id);
        summary.books.mergedByIsbn += 1;
        continue;
      }
    }
    await db.books.put(book);
    summary.books.inserted += 1;
    idRemap.set(book.id, book.id);
  }

  return idRemap;
}

/* ------------------------------------------------------------------ *
 * 副本（03 §4.3）
 * ------------------------------------------------------------------ */

async function mergeCopies(
  db: PocketLibraryDb,
  incoming: readonly Copy[],
  idRemap: ReadonlyMap<string, string>,
  summary: ImportSummary,
  warn: (message: string) => void,
): Promise<void> {
  for (const copy of incoming) {
    const targetBookId = idRemap.get(copy.bookId) ?? copy.bookId;
    if ((await db.books.get(targetBookId)) === undefined) {
      summary.copies.skipped += 1;
      warn(`副本 ${copy.id} 指向的书目 ${copy.bookId} 在本地与文件中都不存在，已跳过（无法确定这是哪本书）`);
      continue;
    }

    const locationOk = (await db.locations.get(copy.locationId)) !== undefined;
    const resolvedLocationId = locationOk ? copy.locationId : UNSORTED_LOCATION_ID;
    if (!locationOk) {
      summary.copies.relocated += 1;
      warn(`副本 ${copy.id} 的位置不存在，已改为「未分类」`);
    }

    const local = await db.copies.get(copy.id);
    if (local === undefined) {
      await db.copies.put({ ...copy, bookId: targetBookId, locationId: resolvedLocationId });
      summary.copies.inserted += 1;
      continue;
    }

    const { record } = mergeRecord(local, copy);
    const normalized: Copy = {
      ...record,
      bookId: targetBookId,
      locationId: (await db.locations.get(record.locationId)) === undefined ? UNSORTED_LOCATION_ID : record.locationId,
    };
    if (!deepEqual(normalized, local)) {
      await db.copies.put(normalized);
      summary.copies.updated += 1;
    }
  }
}

/* ------------------------------------------------------------------ *
 * 借出（03 §4.4、§5.2）：本地优先
 * ------------------------------------------------------------------ */

async function mergeLoans(
  db: PocketLibraryDb,
  incoming: readonly Loan[],
  summary: ImportSummary,
  warn: (message: string) => void,
): Promise<void> {
  for (const loan of incoming) {
    const local = await db.loans.get(loan.id);
    if (local !== undefined) {
      const { record, changed } = mergeRecord(local, loan);
      if (changed) {
        await db.loans.put(record);
        summary.loans.updated += 1;
      }
      continue;
    }

    const copy = await db.copies.get(loan.copyId);
    if (copy === undefined) {
      summary.loans.skipped += 1;
      warn(`借出记录（借给「${loan.borrower}」）指向的副本不存在，已跳过`);
      continue;
    }

    // 历史记录永远安全，直接插入
    if (loan.status !== 'active') {
      await db.loans.put(loan);
      summary.loans.inserted += 1;
      continue;
    }

    const existingActive = await getActiveLoanForCopy(db, loan.copyId);
    if (existingActive === undefined) {
      await db.loans.put(loan);
      summary.loans.inserted += 1;
      continue;
    }

    // 冲突：本地那条保持 active，传入这条转历史（决策 D6）
    const book = await db.books.get(copy.bookId);
    const title = book === undefined || book.title === '' ? '(未命名)' : book.title;
    const note = loan.note === '' ? '导入冲突：与本地借出记录重叠' : `${loan.note}；导入冲突：与本地借出记录重叠`;
    await db.loans.put({
      ...loan,
      status: 'returned',
      returnDate: existingActive.loanDate,
      note,
      updatedAt: nowIso(),
    });
    summary.loans.inserted += 1;
    summary.loans.conflicts += 1;
    warn(
      `《${title}》的导入借出记录与本地冲突：本地仍借给「${existingActive.borrower}」，` +
        `导入的这条（借给「${loan.borrower}」）已转为已归还`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function executeImport(
  db: PocketLibraryDb,
  backup: BackupFile,
  mode: ImportMode,
  dryRun: boolean,
  parseWarnings: readonly string[],
): Promise<ImportSummary> {
  const started = Date.now();
  const warnings = createWarningCollector(parseWarnings);
  const summary = emptySummary(mode, dryRun);

  const body = async (): Promise<void> => {
    if (mode === 'replace') {
      // 03 §6 / 02 §9.1：整体替换业务表前先清理当前 undo 快照 ——
      // 否则 30 秒窗口内的旧撤销会把已替换掉的数据写回来，语义混乱
      await db.snapshots.where('kind').equals('undo').delete();
      await db.loans.clear();
      await db.copies.clear();
      await db.books.clear();
      await db.locations.clear();
      await db.borrowers.clear();
    }

    // 「未分类」是所有位置的兜底，导入前必须存在（02 §7.2）
    if ((await db.locations.get(UNSORTED_LOCATION_ID)) === undefined) {
      await db.locations.put(unsortedLocation());
    }

    await mergeLocations(db, backup.data.locations, summary, warnings.add);
    const idRemap = await mergeBooks(db, backup.data.books, summary);
    await mergeCopies(db, backup.data.copies, idRemap, summary, warnings.add);
    await mergeLoans(db, backup.data.loans, summary, warnings.add);
    await mergeBorrowers(db, backup.data.borrowers, summary);

    // 修复通道：重建路径 + 全部不变式
    const repair = await repairInvariants(db);
    for (const message of repair.warnings) warnings.add(message);

    if (!dryRun) {
      // 02 §12.3：applyImport 按实际变更条数（写进业务表的行数）计入写计数器；
      // preview 不计（事务整体回滚）
      const changed =
        summary.locations.inserted +
        summary.locations.updated +
        summary.books.inserted +
        summary.books.updated +
        summary.copies.inserted +
        summary.copies.updated +
        summary.loans.inserted +
        summary.loans.updated +
        summary.borrowers.inserted +
        summary.borrowers.updated;
      await bumpWriteCounterBy(db, changed);
    }

    if (dryRun) throw DRY_RUN_SIGNAL;
  };

  try {
    await db.transaction(
      'rw',
      [db.locations, db.books, db.copies, db.loans, db.borrowers, db.snapshots, db.settings],
      body,
    );
  } catch (error) {
    if (error !== DRY_RUN_SIGNAL) throw error;
  }

  summary.warnings = warnings.list();
  summary.durationMs = Date.now() - started;
  return summary;
}

/** 预览：完整跑一遍，然后整体回滚。数据库不会有任何变化（03 §7）。 */
export async function previewImport(
  db: PocketLibraryDb,
  backup: BackupFile,
  options: ImportOptions = {},
): Promise<ImportSummary> {
  return executeImport(db, backup, options.mode ?? 'merge', true, options.parseWarnings ?? []);
}

/** 实际执行。同一个文件连导两次，第二次必须全 0 变更（03 §8）。 */
export async function applyImport(
  db: PocketLibraryDb,
  backup: BackupFile,
  options: ImportOptions = {},
): Promise<ImportSummary> {
  return executeImport(db, backup, options.mode ?? 'merge', false, options.parseWarnings ?? []);
}

export type ImportTextResult = { ok: false; error: string } | { ok: true; summary: ImportSummary };

export interface ImportTextOptions extends ImportOptions {
  dryRun?: boolean;
}

/** 一步到位：解析文本 → （预览 | 执行）。解析失败不抛异常。 */
export async function importFromText(
  db: PocketLibraryDb,
  text: string,
  options: ImportTextOptions = {},
): Promise<ImportTextResult> {
  const parsed = parseBackup(text);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const merged: ImportOptions = { ...options, parseWarnings: parsed.warnings };
  const summary = options.dryRun === true ? await previewImport(db, parsed.backup, merged) : await applyImport(db, parsed.backup, merged);
  return { ok: true, summary };
}

/** 显式维护一次位置路径（导入后已自动调用，此处供 UI 的"数据体检"使用）。 */
export async function refreshLocationPaths(db: PocketLibraryDb): Promise<number> {
  return rebuildLocationPaths(db);
}
