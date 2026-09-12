/**
 * 不变式检查与修复。规范见 docs/design/02-data-model.md §6。
 *
 * 调用时机：每次导入合并之后、应用启动时。
 * 要求：数据已合规时不产生任何写入（这是导入幂等性的前提，见 03 §8）。
 */

import { UNSORTED_LOCATION_ID } from '../domain/ids.ts';
import { computeLocationPaths } from '../domain/location-path.ts';
import { nowIso, today } from '../domain/time.ts';
import type { Loan, Location } from '../domain/types.ts';
import { rebuildLocationPaths } from './locations.ts';
import type { PocketLibraryDb } from './schema.ts';

export interface RepairReport {
  danglingParentsFixed: number;
  cyclesBroken: number;
  copiesRepointed: number;
  copiesDeleted: number;
  loansDeleted: number;
  duplicateActiveLoansResolved: number;
  copyStatusFixed: number;
  pathsRebuilt: number;
  warnings: string[];
}

const EMPTY_REPORT = (): RepairReport => ({
  danglingParentsFixed: 0,
  cyclesBroken: 0,
  copiesRepointed: 0,
  copiesDeleted: 0,
  loansDeleted: 0,
  duplicateActiveLoansResolved: 0,
  copyStatusFixed: 0,
  pathsRebuilt: 0,
  warnings: [],
});

/** 环检测的迭代上限：每次迭代至少打断一个环，正常数据不可能逼近这个数。 */
const MAX_CYCLE_PASSES = 64;

export async function repairInvariants(db: PocketLibraryDb): Promise<RepairReport> {
  return db.transaction(
    'rw',
    db.locations,
    db.books,
    db.copies,
    db.loans,
    db.settings,
    async () => {
      const report = EMPTY_REPORT();

      /* ---- I4 / I5：位置父子关系 ---- */
      for (let pass = 0; pass < MAX_CYCLE_PASSES; pass++) {
        const locations = await db.locations.toArray();
        const { cycles, dangling } = computeLocationPaths(locations);
        if (cycles.length === 0 && dangling.length === 0) break;

        for (const id of dangling) {
          const location = locations.find((l) => l.id === id);
          if (location === undefined) continue;
          const parentId = id === UNSORTED_LOCATION_ID ? null : UNSORTED_LOCATION_ID;
          await db.locations.put({ ...location, parentId, updatedAt: nowIso() });
          report.danglingParentsFixed += 1;
          report.warnings.push(`位置「${location.name}」的上级位置不存在，已挂到「未分类」`);
        }

        if (cycles.length > 0) {
          // 确定性选择：环内 id 升序第一个，挂到「未分类」，环即被打断
          const victimId = [...cycles].sort()[0] as string;
          const location = locations.find((l) => l.id === victimId);
          if (location !== undefined) {
            const parentId = victimId === UNSORTED_LOCATION_ID ? null : UNSORTED_LOCATION_ID;
            await db.locations.put({ ...location, parentId, updatedAt: nowIso() });
            report.cyclesBroken += 1;
            report.warnings.push(`位置「${location.name}」位于循环引用中，已挂到「未分类」`);
          }
        }
        if (report.danglingParentsFixed === 0 && report.cyclesBroken === 0) break;
      }

      /* ---- I1：副本指向的书目必须存在 ---- */
      const [books, copies] = await Promise.all([db.books.toArray(), db.copies.toArray()]);
      const bookIds = new Set(books.map((b) => b.id));
      const orphanCopies = copies.filter((c) => !bookIds.has(c.bookId));
      for (const copy of orphanCopies) {
        const loans = await db.loans.where('copyId').equals(copy.id).toArray();
        await db.loans.bulkDelete(loans.map((l) => l.id));
        await db.copies.delete(copy.id);
        report.copiesDeleted += 1;
        report.loansDeleted += loans.length;
        report.warnings.push(`副本 ${copy.id} 指向的书目不存在，副本与相关借出记录已删除`);
      }

      /* ---- I2：副本指向的位置必须存在 ---- */
      const locations = await db.locations.toArray();
      const locationIds = new Set(locations.map((l) => l.id));
      const remainingCopies = await db.copies.toArray();
      for (const copy of remainingCopies) {
        if (locationIds.has(copy.locationId)) continue;
        await db.copies.put({ ...copy, locationId: UNSORTED_LOCATION_ID, updatedAt: nowIso() });
        report.copiesRepointed += 1;
        report.warnings.push(`副本 ${copy.id} 的位置不存在，已改为「未分类」`);
      }

      /* ---- I3：借出记录指向的副本必须存在 ---- */
      const copyIds = new Set((await db.copies.toArray()).map((c) => c.id));
      const allLoans = await db.loans.toArray();
      const orphanLoans = allLoans.filter((l) => !copyIds.has(l.copyId));
      await db.loans.bulkDelete(orphanLoans.map((l) => l.id));
      report.loansDeleted += orphanLoans.length;
      for (const loan of orphanLoans) {
        report.warnings.push(`借出记录（借给「${loan.borrower}」）指向的副本不存在，已删除`);
      }

      /* ---- I6：一个副本至多一条 active 借出 ---- */
      const loans = await db.loans.toArray();
      const activeByCopy = new Map<string, Loan[]>();
      for (const loan of loans) {
        if (loan.status !== 'active') continue;
        const bucket = activeByCopy.get(loan.copyId);
        if (bucket === undefined) activeByCopy.set(loan.copyId, [loan]);
        else bucket.push(loan);
      }
      for (const [, group] of activeByCopy) {
        if (group.length <= 1) continue;
        const sorted = [...group].sort((a, b) =>
          a.loanDate === b.loanDate ? a.createdAt.localeCompare(b.createdAt) : a.loanDate.localeCompare(b.loanDate),
        );
        const keeper = sorted[sorted.length - 1] as Loan;
        for (const loan of sorted.slice(0, -1)) {
          await db.loans.put({
            ...loan,
            status: 'returned',
            returnDate: keeper.loanDate,
            note: `${loan.note}${loan.note === '' ? '' : '；'}数据修复：同一副本存在多条进行中的借出，保留最新一条`,
            updatedAt: nowIso(),
          });
          report.duplicateActiveLoansResolved += 1;
          report.warnings.push(`副本 ${loan.copyId} 存在多条进行中的借出，已保留借出日期最新的一条`);
        }
      }

      /* ---- I7：Copy.status 与 active 借出保持一致 ---- */
      const finalCopies = await db.copies.toArray();
      const finalLoans = await db.loans.toArray();
      const hasActive = new Set(finalLoans.filter((l) => l.status === 'active').map((l) => l.copyId));
      for (const copy of finalCopies) {
        const active = hasActive.has(copy.id);
        const stamp = nowIso();

        if ((copy.status === 'lost' || copy.status === 'sold') && active) {
          const loans = finalLoans.filter((l) => l.copyId === copy.id && l.status === 'active');
          for (const loan of loans) {
            await db.loans.put({
              ...loan,
              status: 'returned',
              returnDate: today(),
              note: `${loan.note}${loan.note === '' ? '' : '；'}数据修复：副本已不在手上，借出记录自动关闭`,
              updatedAt: stamp,
            });
            hasActive.delete(copy.id);
            report.warnings.push(`副本 ${copy.id} 已标记为不在手上，其进行中的借出已关闭`);
          }
          continue;
        }

        if (active && copy.status !== 'lent_out') {
          await db.copies.put({ ...copy, status: 'lent_out', updatedAt: stamp });
          report.copyStatusFixed += 1;
        } else if (!active && copy.status === 'lent_out') {
          await db.copies.put({ ...copy, status: 'on_shelf', updatedAt: stamp });
          report.copyStatusFixed += 1;
        }
      }

      /* ---- I8：位置路径与树结构一致 ---- */
      report.pathsRebuilt = await rebuildLocationPaths(db);

      return report;
    },
  );
}

/** 只做检查、不落盘，供"数据体检"入口使用。 */
export async function checkInvariants(db: PocketLibraryDb): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  const [locations, books, copies, loans] = await Promise.all([
    db.locations.toArray(),
    db.books.toArray(),
    db.copies.toArray(),
    db.loans.toArray(),
  ]);

  if (locations.find((l) => l.id === UNSORTED_LOCATION_ID) === undefined) {
    problems.push('缺少「未分类」位置');
  }

  const bookIds = new Set(books.map((b) => b.id));
  const locationIds = new Set(locations.map((l) => l.id));
  const copyIds = new Set(copies.map((c) => c.id));

  for (const copy of copies) {
    if (!bookIds.has(copy.bookId)) problems.push(`副本 ${copy.id} 的书目不存在（I1）`);
    if (!locationIds.has(copy.locationId)) problems.push(`副本 ${copy.id} 的位置不存在（I2）`);
  }
  for (const loan of loans) {
    if (!copyIds.has(loan.copyId)) problems.push(`借出记录 ${loan.id} 的副本不存在（I3）`);
  }

  const { cycles, dangling } = computeLocationPaths(locations as Location[]);
  if (cycles.length > 0) problems.push(`位置存在循环引用：${cycles.join(', ')}（I5）`);
  if (dangling.length > 0) problems.push(`位置的上级不存在：${dangling.join(', ')}（I4）`);

  const activeCount = new Map<string, number>();
  for (const loan of loans) {
    if (loan.status !== 'active') continue;
    activeCount.set(loan.copyId, (activeCount.get(loan.copyId) ?? 0) + 1);
  }
  for (const [copyId, count] of activeCount) {
    if (count > 1) problems.push(`副本 ${copyId} 有 ${count} 条进行中的借出（I6）`);
  }

  for (const copy of copies) {
    const active = (activeCount.get(copy.id) ?? 0) > 0;
    const terminal = copy.status === 'lost' || copy.status === 'sold';
    if (active && copy.status !== 'lent_out') problems.push(`副本 ${copy.id} 有进行中的借出但状态是 ${copy.status}（I7）`);
    if (!active && copy.status === 'lent_out' && !terminal) problems.push(`副本 ${copy.id} 状态是借出但没有进行中的借出（I7）`);
  }

  const computed = computeLocationPaths(locations as Location[]).entries;
  for (const location of locations) {
    const entry = computed.get(location.id);
    if (entry === undefined) continue;
    if (entry.path !== location.path || entry.depth !== location.depth) {
      problems.push(`位置「${location.name}」的路径缓存不一致（I8）`);
    }
  }

  return { ok: problems.length === 0, problems };
}
