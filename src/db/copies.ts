/**
 * 副本服务。规范见 docs/design/02-data-model.md §4、§6（I1/I2/I6/I7）、§9。
 *
 * Copy.status 的写法有严格边界：
 * - 'lent_out' 只能由借出记录派生（loans.ts），此处不接受
 * - 'lost' / 'sold' 是终态，可直接设置，但会连带关闭进行中的借出（I7）
 */

import { UNSORTED_LOCATION_ID, newId } from '../domain/ids.ts';
import { collectSubtreeIds } from '../domain/location-path.ts';
import { nowIso, today } from '../domain/time.ts';
import type { Copy, CopyCondition, CopyStatus, CopyWithLocation, Loan } from '../domain/types.ts';
import type { PocketLibraryDb } from './schema.ts';
import { bumpWriteCounter } from './settings.ts';
import { captureUndo } from './snapshots.ts';

/** 可被手工设置的副本终态/常态（不含 lent_out）。 */
export const MANUAL_COPY_STATUSES = ['on_shelf', 'lost', 'sold'] as const;
export type ManualCopyStatus = (typeof MANUAL_COPY_STATUSES)[number];

export interface CreateCopyInput {
  bookId: string;
  locationId?: string;
  status?: CopyStatus;
  condition?: CopyCondition;
  owner?: string;
  note?: string;
}

export interface UpdateCopyInput {
  locationId?: string;
  condition?: CopyCondition;
  owner?: string;
  note?: string;
}

export interface DeleteCopyResult {
  deletedLoans: number;
}

async function requireBookExists(db: PocketLibraryDb, bookId: string): Promise<void> {
  const book = await db.books.get(bookId);
  if (book === undefined) throw new Error(`书目不存在：${bookId}`);
}

async function requireLocationExists(db: PocketLibraryDb, locationId: string): Promise<void> {
  const location = await db.locations.get(locationId);
  if (location === undefined) throw new Error(`位置不存在：${locationId}`);
}

export async function getCopy(db: PocketLibraryDb, id: string): Promise<Copy | undefined> {
  return db.copies.get(id);
}

export async function createCopy(db: PocketLibraryDb, input: CreateCopyInput): Promise<Copy> {
  return db.transaction('rw', db.books, db.copies, db.locations, db.settings, async () => {
    // I1：副本必须指向存在的书目
    await requireBookExists(db, input.bookId);

    // I2：位置必填；未指定时落到「未分类」
    const locationId = input.locationId ?? UNSORTED_LOCATION_ID;
    await requireLocationExists(db, locationId);

    const status = input.status ?? 'on_shelf';
    if (status === 'lent_out') {
      throw new Error('「借出」状态由借出记录派生，请使用 loanOut()');
    }

    const stamp = nowIso();
    const copy: Copy = {
      id: newId(),
      bookId: input.bookId,
      locationId,
      status,
      condition: input.condition ?? 'unknown',
      owner: (input.owner ?? '').trim(),
      note: (input.note ?? '').trim(),
      createdAt: stamp,
      updatedAt: stamp,
    };
    await db.copies.put(copy);
    await bumpWriteCounter(db);
    return copy;
  });
}

export async function updateCopy(db: PocketLibraryDb, id: string, patch: UpdateCopyInput): Promise<Copy> {
  return db.transaction('rw', db.copies, db.locations, db.settings, async () => {
    const copy = await db.copies.get(id);
    if (copy === undefined) throw new Error(`副本不存在：${id}`);

    if (patch.locationId !== undefined) {
      await requireLocationExists(db, patch.locationId);
      copy.locationId = patch.locationId;
    }
    if (patch.condition !== undefined) copy.condition = patch.condition;
    if (patch.owner !== undefined) copy.owner = patch.owner.trim();
    if (patch.note !== undefined) copy.note = patch.note.trim();

    copy.updatedAt = nowIso();
    await db.copies.put(copy);
    await bumpWriteCounter(db);
    return copy;
  });
}

export async function moveCopy(db: PocketLibraryDb, id: string, locationId: string): Promise<Copy> {
  return updateCopy(db, id, { locationId });
}

/**
 * 设置副本状态。丢失/卖掉时按 I7 关闭进行中的借出：
 * 书都不在手上了，借出记录必须终结，否则会一直挂在"逾期"里。
 */
export async function setCopyStatus(
  db: PocketLibraryDb,
  id: string,
  status: ManualCopyStatus,
): Promise<Copy> {
  return db.transaction('rw', db.copies, db.loans, db.settings, async () => {
    const copy = await db.copies.get(id);
    if (copy === undefined) throw new Error(`副本不存在：${id}`);

    // I7：正被借出的副本不能改回「在架」——lent_out 与 active 借出必须恒等，
    // 改回在架的唯一路径是归还（loans.returnCopy）。
    if (status === 'on_shelf') {
      const active = await db.loans.where('[copyId+status]').equals([id, 'active']).toArray();
      if (active.length > 0) {
        throw new Error('该副本正被借出，不能改为「在架」；请先归还');
      }
    }

    const stamp = nowIso();
    copy.status = status;
    copy.updatedAt = stamp;
    await db.copies.put(copy);

    if (status === 'lost' || status === 'sold') {
      const active = await db.loans.where('[copyId+status]').equals([id, 'active']).toArray();
      for (const loan of active) {
        await db.loans.put({
          ...loan,
          status: 'returned',
          returnDate: today(),
          note: `${loan.note}${loan.note === '' ? '' : '；'}副本已标记为${status === 'lost' ? '丢失' : '已售出'}，借出记录自动关闭`,
          updatedAt: stamp,
        });
      }
    }

    await bumpWriteCounter(db);
    return copy;
  });
}

/**
 * 删除副本（02 §9）：连带删除其全部借出记录。
 * 正被借出时必须显式确认。
 */
export async function deleteCopy(
  db: PocketLibraryDb,
  id: string,
  options: { confirmLentOut?: boolean } = {},
): Promise<DeleteCopyResult> {
  return db.transaction('rw', db.copies, db.loans, db.settings, db.snapshots, async () => {
    const copy = await db.copies.get(id);
    if (copy === undefined) throw new Error(`副本不存在：${id}`);

    const loans = await db.loans.where('copyId').equals(id).toArray();
    const active = loans.filter((l) => l.status === 'active');
    if (active.length > 0 && options.confirmLentOut !== true) {
      const who = (active[0] as Loan).borrower;
      throw new Error(`该副本正被「${who}」借出，删除前请确认（confirmLentOut: true）`);
    }

    // 02 §9.1：删除前在同一事务内捕获 undo 快照（副本 + 其全部借出记录）
    await captureUndo(db, { copies: [copy], loans });

    await db.loans.bulkDelete(loans.map((l) => l.id));
    await db.copies.delete(id);
    await bumpWriteCounter(db);
    return { deletedLoans: loans.length };
  });
}

export async function listCopiesByBook(db: PocketLibraryDb, bookId: string): Promise<Copy[]> {
  return db.copies.where('bookId').equals(bookId).toArray();
}

/** 按位置查副本；includeSubtree 默认为 true（与统计口径一致，见 02 §10.1）。 */
export async function listCopiesByLocation(
  db: PocketLibraryDb,
  locationId: string,
  options: { includeSubtree?: boolean } = {},
): Promise<CopyWithLocation[]> {
  const includeSubtree = options.includeSubtree ?? true;
  const locations = await db.locations.toArray();
  const ids = includeSubtree
    ? collectSubtreeIds(locationId, locations)
    : new Set<string>([locationId]);
  const copies = (await db.copies.toArray()).filter((c) => ids.has(c.locationId));
  return attachCopyDetails(db, copies);
}

/** 给副本补上位置路径与进行中的借出，UI 直接可用（02 §10.2）。 */
export async function attachCopyDetails(
  db: PocketLibraryDb,
  copies: readonly Copy[],
): Promise<CopyWithLocation[]> {
  if (copies.length === 0) return [];
  const [locations, activeLoans] = await Promise.all([
    db.locations.toArray(),
    db.loans.where('status').equals('active').toArray(),
  ]);
  const locationById = new Map(locations.map((l) => [l.id, l]));
  const loanByCopy = new Map(activeLoans.map((l) => [l.copyId, l]));

  return copies.map((copy) => {
    const location = locationById.get(copy.locationId);
    return {
      ...copy,
      locationPath: location?.path ?? '',
      locationName: location?.name ?? '',
      activeLoan: loanByCopy.get(copy.id) ?? null,
    };
  });
}
