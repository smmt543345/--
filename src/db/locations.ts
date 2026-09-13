/**
 * 位置服务。规范见 docs/design/02-data-model.md §2、§4、§9。
 *
 * 唯一允许写 Location.path / depth / type 的地方是 rebuildLocationPaths()。
 */

import { UNSORTED_LOCATION_ID, newId } from '../domain/ids.ts';
import {
  buildTree,
  collectSubtreeIds,
  computeLocationPaths,
  isDescendantOf,
  sortLocations,
} from '../domain/location-path.ts';
import { nowIso } from '../domain/time.ts';
import type { Location, LocationTreeNode } from '../domain/types.ts';
import type { PocketLibraryDb } from './schema.ts';
import { bumpWriteCounter } from './settings.ts';
import { captureUndo } from './snapshots.ts';

export type DeleteLocationStrategy = 'reparent' | 'cascade';

export interface CreateLocationInput {
  name: string;
  parentId?: string | null;
  sortOrder?: number;
}

export interface UpdateLocationInput {
  name?: string;
  sortOrder?: number;
}

export interface DeleteLocationResult {
  deletedLocations: number;
  deletedCopies: number;
  deletedLoans: number;
  /** reparent 策略下被上移的副本数 */
  movedCopies: number;
}

export function isUnsorted(id: string): boolean {
  return id === UNSORTED_LOCATION_ID;
}

export async function listLocations(db: PocketLibraryDb): Promise<Location[]> {
  return sortLocations(await db.locations.toArray());
}

export async function getLocation(db: PocketLibraryDb, id: string): Promise<Location | undefined> {
  return db.locations.get(id);
}

export async function getLocationTree(db: PocketLibraryDb): Promise<LocationTreeNode[]> {
  return buildTree(await db.locations.toArray());
}

export async function getLocationPath(db: PocketLibraryDb, id: string): Promise<string> {
  const location = await db.locations.get(id);
  return location?.path ?? '';
}

async function requireLocation(db: PocketLibraryDb, id: string): Promise<Location> {
  const location = await db.locations.get(id);
  if (location === undefined) throw new Error(`位置不存在：${id}`);
  return location;
}

/**
 * 重算整棵位置树的 path / depth / type。
 *
 * 幂等：同样输入必得同样输出。
 * **刻意不刷新 updatedAt** —— 这些是派生字段，若刷新会把导入合并的
 * "后写覆盖"判断污染掉，也会破坏导入幂等性（03 §8）。
 * 返回实际发生变化的行数。
 */
export async function rebuildLocationPaths(db: PocketLibraryDb): Promise<number> {
  const all = await db.locations.toArray();
  const { entries } = computeLocationPaths(all);
  let changed = 0;
  for (const location of all) {
    const target = entries.get(location.id);
    if (target === undefined) continue;
    if (location.path === target.path && location.depth === target.depth && location.type === target.type) {
      continue;
    }
    await db.locations.put({ ...location, path: target.path, depth: target.depth, type: target.type });
    changed += 1;
  }
  return changed;
}

export async function createLocation(db: PocketLibraryDb, input: CreateLocationInput): Promise<Location> {
  const name = (input.name ?? '').trim();
  if (name === '') throw new Error('位置名称不能为空');

  const parentId = input.parentId ?? null;

  return db.transaction('rw', db.locations, db.settings, async () => {
    let parent: Location | undefined;
    if (parentId !== null) {
      parent = await db.locations.get(parentId);
      if (parent === undefined) throw new Error(`上级位置不存在：${parentId}`);
    }

    const stamp = nowIso();
    const siblings = (await db.locations.toArray()).filter((l) => l.parentId === parentId);
    const sortOrder =
      input.sortOrder ?? (siblings.length === 0 ? 0 : Math.max(...siblings.map((s) => s.sortOrder)) + 1);

    const location: Location = {
      id: newId(),
      parentId,
      name,
      // 派生字段先落占位值，随后由 rebuildLocationPaths 统一物化
      path: parent === undefined ? name : `${parent.path}${' / '}${name}`,
      depth: parent === undefined ? 0 : parent.depth + 1,
      type: 'home',
      sortOrder,
      createdAt: stamp,
      updatedAt: stamp,
    };
    await db.locations.put(location);
    await rebuildLocationPaths(db);
    await bumpWriteCounter(db);
    return (await db.locations.get(location.id)) as Location;
  });
}

export async function updateLocation(
  db: PocketLibraryDb,
  id: string,
  patch: UpdateLocationInput,
): Promise<Location> {
  return db.transaction('rw', db.locations, db.settings, async () => {
    const location = await requireLocation(db, id);

    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (name === '') throw new Error('位置名称不能为空');
      if (isUnsorted(id)) throw new Error('「未分类」不可重命名');
      location.name = name;
    }
    if (patch.sortOrder !== undefined) location.sortOrder = patch.sortOrder;

    location.updatedAt = nowIso();
    await db.locations.put(location);
    await rebuildLocationPaths(db);
    await bumpWriteCounter(db);
    return (await db.locations.get(id)) as Location;
  });
}

/** 移动位置。不能移进自己的子树，否则会造出环（不变式 I5）。 */
export async function moveLocation(
  db: PocketLibraryDb,
  id: string,
  newParentId: string | null,
): Promise<Location> {
  return db.transaction('rw', db.locations, db.settings, async () => {
    if (isUnsorted(id)) throw new Error('「未分类」不可移动');
    const location = await requireLocation(db, id);

    if (newParentId !== null) {
      await requireLocation(db, newParentId);
      const all = await db.locations.toArray();
      if (isDescendantOf(newParentId, id, all)) {
        throw new Error('不能把位置移动到它自己的下级里');
      }
    }

    location.parentId = newParentId;
    location.updatedAt = nowIso();
    await db.locations.put(location);
    await rebuildLocationPaths(db);
    await bumpWriteCounter(db);
    return (await db.locations.get(id)) as Location;
  });
}

export async function countLocationDependents(
  db: PocketLibraryDb,
  id: string,
): Promise<{ childLocations: number; copies: number }> {
  const locations = await db.locations.toArray();
  const subtree = collectSubtreeIds(id, locations);
  const copies = await db.copies.toArray();
  return {
    childLocations: subtree.size - 1,
    copies: copies.filter((c) => subtree.has(c.locationId)).length,
  };
}

/**
 * 删除位置（02 §9）。
 *
 * - 有子位置或副本时**必须显式给出策略**，不允许有默认值。
 * - reparent：子位置与副本上移到父位置（父为顶层时副本落到「未分类」）
 * - cascade：连同子位置、副本及其借出记录一并删除
 */
export async function deleteLocation(
  db: PocketLibraryDb,
  id: string,
  strategy?: DeleteLocationStrategy,
): Promise<DeleteLocationResult> {
  return db.transaction('rw', db.locations, db.copies, db.loans, db.settings, db.snapshots, async () => {
    if (isUnsorted(id)) throw new Error('「未分类」不可删除');
    const location = await requireLocation(db, id);

    const locations = await db.locations.toArray();
    const subtree = collectSubtreeIds(id, locations);
    const copies = await db.copies.toArray();
    const affected = copies.filter((c) => subtree.has(c.locationId));
    const hasDependents = subtree.size > 1 || affected.length > 0;

    if (hasDependents && strategy === undefined) {
      throw new Error(
        `该位置下有 ${subtree.size - 1} 个子位置、${affected.length} 本副本，删除时必须指定策略（reparent 或 cascade）`,
      );
    }

    const result: DeleteLocationResult = {
      deletedLocations: 1,
      deletedCopies: 0,
      deletedLoans: 0,
      movedCopies: 0,
    };

    if (!hasDependents || strategy === 'reparent') {
      const fallback = location.parentId ?? UNSORTED_LOCATION_ID;
      // 子位置与副本都上移到父位置；父为顶层时副本落到「未分类」
      for (const child of locations.filter((l) => l.parentId === id)) {
        await db.locations.put({ ...child, parentId: fallback, updatedAt: nowIso() });
      }
      for (const copy of affected) {
        await db.copies.put({ ...copy, locationId: fallback, updatedAt: nowIso() });
        result.movedCopies += 1;
      }
      await db.locations.delete(id);
      await rebuildLocationPaths(db);
    } else {
      const copyIds = new Set(affected.map((c) => c.id));
      const loans = await db.loans.toArray();
      const victimLoans = loans.filter((l) => copyIds.has(l.copyId));
      // 02 §9.1：级联删除前在同一事务内捕获 undo 快照（子树 + 副本 + 借出）；
      // reparent 分支不产生 undo（没有数据被销毁）
      await captureUndo(db, {
        locations: locations.filter((l) => subtree.has(l.id)),
        copies: affected,
        loans: victimLoans,
      });
      await db.loans.bulkDelete(victimLoans.map((l) => l.id));
      await db.copies.bulkDelete([...copyIds]);
      await db.locations.bulkDelete([...subtree]);
      result.deletedLocations = subtree.size;
      result.deletedCopies = copyIds.size;
      result.deletedLoans = victimLoans.length;
      await rebuildLocationPaths(db);
    }

    await bumpWriteCounter(db);
    return result;
  });
}
