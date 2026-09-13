/**
 * 借书人候选服务。规范见 docs/design/02-data-model.md §5.5、§11。
 *
 * 关键规则：
 * - 无外键：Loan.borrower 是借出那一刻的历史字符串快照，不指向 Borrower ——
 *   删除候选不影响任何借出记录。
 * - 查重键 = 规范化姓名（trim + 折叠连续空白）：重名视为更新该候选的联系方式。
 * - 上限 20 条，超出按 updatedAt 淘汰最旧（候选是"最近常联系的人"，不是通讯录）。
 * - 本表唯一写入者（§11）：本 service、loans.ts（loanOut 自动 upsert）、
 *   导入经 merge-borrowers.ts 委托本 service。
 */

import { newId } from '../domain/ids.ts';
import { nowIso } from '../domain/time.ts';
import type { Borrower } from '../domain/types.ts';
import type { PocketLibraryDb } from './schema.ts';
import { bumpWriteCounter } from './settings.ts';

/** 候选上限（02 §5.5）。 */
export const MAX_BORROWERS = 20;

export interface BorrowerInput {
  name: string;
  contact?: string;
}

export interface BorrowerPatch {
  name?: string;
  contact?: string;
}

/** 规范化姓名：trim + 折叠连续空白（02 §5.5）。 */
export function normalizeBorrowerName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** 按 updatedAt 倒序（04 §11.3 候选下拉的展示顺序）。 */
export async function listBorrowers(db: PocketLibraryDb): Promise<Borrower[]> {
  const all = await db.borrowers.toArray();
  return all.sort((a, b) =>
    a.updatedAt === b.updatedAt
      ? a.name.localeCompare(b.name, 'zh')
      : b.updatedAt.localeCompare(a.updatedAt),
  );
}

async function requireBorrower(db: PocketLibraryDb, id: string): Promise<Borrower> {
  const row = await db.borrowers.get(id);
  if (row === undefined) throw new Error(`借书人不存在：${id}`);
  return row;
}

/** 手动新增（02 §5.5）：按规范化姓名去重，重名视为更新该候选的联系方式。 */
export async function createBorrower(
  db: PocketLibraryDb,
  input: BorrowerInput,
  options: { now?: string } = {},
): Promise<Borrower> {
  return db.transaction('rw', db.borrowers, db.settings, async () => {
    const row = await upsertBorrowerInTx(db, input, options.now ?? nowIso());
    await bumpWriteCounter(db);
    return row;
  });
}

export async function updateBorrower(
  db: PocketLibraryDb,
  id: string,
  patch: BorrowerPatch,
  options: { now?: string } = {},
): Promise<Borrower> {
  return db.transaction('rw', db.borrowers, db.settings, async () => {
    const row = await requireBorrower(db, id);

    if (patch.name !== undefined) {
      const name = normalizeBorrowerName(patch.name);
      if (name === '') throw new Error('借书人姓名不能为空');
      // 改名撞上另一条候选：拒绝而不是静默合并 —— 静默合并会丢掉一条候选
      const clash = await db.borrowers.where('name').equals(name).first();
      if (clash !== undefined && clash.id !== id) {
        throw new Error(`已存在同名借书人「${name}」，请直接更新那条候选`);
      }
      row.name = name;
    }
    if (patch.contact !== undefined) row.contact = patch.contact.trim();

    row.updatedAt = options.now ?? nowIso();
    await db.borrowers.put(row);
    await bumpWriteCounter(db);
    return row;
  });
}

/** 删候选不影响任何借出记录（02 §5.5）。 */
export async function deleteBorrower(db: PocketLibraryDb, id: string): Promise<void> {
  await db.transaction('rw', db.borrowers, db.settings, async () => {
    await requireBorrower(db, id);
    await db.borrowers.delete(id);
    await bumpWriteCounter(db);
  });
}

/**
 * 按规范化姓名 upsert（02 §5.5）：不存在则插入，存在则更新 contact 与 updatedAt。
 *
 * **在调用方的事务内运行**，供 loanOut 与 createBorrower 复用；不 bump 计数器 ——
 * 一次业务操作一次计数，由外层决定（loanOut 的 upsert 是借出操作的一部分）。
 */
export async function upsertBorrowerInTx(
  db: PocketLibraryDb,
  input: BorrowerInput,
  stamp: string = nowIso(),
): Promise<Borrower> {
  const name = normalizeBorrowerName(input.name);
  if (name === '') throw new Error('借书人姓名不能为空');
  const contact = (input.contact ?? '').trim();

  const existing = await db.borrowers.where('name').equals(name).first();
  if (existing === undefined) {
    const row: Borrower = { id: newId(), name, contact, createdAt: stamp, updatedAt: stamp };
    await db.borrowers.put(row);
    await enforceBorrowerCapInTx(db);
    return row;
  }

  const row: Borrower = { ...existing, contact, updatedAt: stamp };
  await db.borrowers.put(row);
  return row;
}

/** 按 id 写入（供 merge-borrowers 在导入事务内委托写入，03 §4.5）。调用方须已在事务内。 */
export async function putBorrowerInTx(db: PocketLibraryDb, row: Borrower): Promise<void> {
  await db.borrowers.put(row);
}

/** 上限检查（02 §5.5）：超出 20 条时按 updatedAt 淘汰最旧。调用方须已在事务内。 */
export async function enforceBorrowerCapInTx(db: PocketLibraryDb): Promise<void> {
  const all = await db.borrowers.toArray();
  if (all.length <= MAX_BORROWERS) return;
  all.sort((a, b) =>
    a.updatedAt === b.updatedAt
      ? a.createdAt.localeCompare(b.createdAt)
      : a.updatedAt.localeCompare(b.updatedAt),
  );
  const excess = all.slice(0, all.length - MAX_BORROWERS);
  await db.borrowers.bulkDelete(excess.map((b) => b.id));
}
