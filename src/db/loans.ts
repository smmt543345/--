/**
 * 借出服务。规范见 docs/design/02-data-model.md §5、§6（I6/I7）。
 *
 * 两个关键不变式在这里被强制：
 * - I6：一个副本至多一条 active 借出
 * - I7：Copy.status === 'lent_out' ⟺ 该副本存在 active 借出（lost/sold 除外）
 */

import { newId } from '../domain/ids.ts';
import { defaultDueDate, nowIso, today } from '../domain/time.ts';
import type { Copy, Loan, LoanWithBook } from '../domain/types.ts';
import type { PocketLibraryDb } from './schema.ts';
import { SETTING_KEYS, bumpWriteCounter, getSetting } from './settings.ts';
import { upsertBorrowerInTx } from './borrowers.ts';

export interface LoanOutInput {
  copyId: string;
  borrower: string;
  contact?: string;
  loanDate?: string;
  /** 不传则按 settings.loanPeriodDays 自动推算；传空串表示不设到期日 */
  dueDate?: string;
  note?: string;
}

export interface ReturnCopyInput {
  copyId: string;
  returnDate?: string;
  note?: string;
}

export async function getActiveLoanForCopy(db: PocketLibraryDb, copyId: string): Promise<Loan | undefined> {
  const rows = await db.loans.where('[copyId+status]').equals([copyId, 'active']).toArray();
  return rows[0];
}

async function requireCopy(db: PocketLibraryDb, copyId: string): Promise<Copy> {
  const copy = await db.copies.get(copyId);
  if (copy === undefined) throw new Error(`副本不存在：${copyId}`);
  return copy;
}

export async function loanOut(db: PocketLibraryDb, input: LoanOutInput): Promise<Loan> {
  const borrower = (input.borrower ?? '').trim();
  if (borrower === '') throw new Error('借书人不能为空');

  return db.transaction('rw', db.copies, db.loans, db.settings, db.borrowers, async () => {
    const copy = await requireCopy(db, input.copyId);
    if (copy.status === 'lost' || copy.status === 'sold') {
      throw new Error(`副本当前状态为「${copy.status}」，不能借出`);
    }

    const conflict = await getActiveLoanForCopy(db, copy.id);
    if (conflict !== undefined) {
      throw new Error(`该副本已借给「${conflict.borrower}」，请先归还再借出`);
    }

    const loanDate = input.loanDate ?? today();
    let dueDate = input.dueDate;
    if (dueDate === undefined) {
      const period = await getSetting<number>(db, SETTING_KEYS.loanPeriodDays, 30);
      dueDate = defaultDueDate(loanDate, typeof period === 'number' && period > 0 ? period : 30);
    }

    const stamp = nowIso();
    const loan: Loan = {
      id: newId(),
      copyId: copy.id,
      borrower,
      contact: (input.contact ?? '').trim(),
      loanDate,
      dueDate,
      returnDate: '',
      status: 'active',
      note: (input.note ?? '').trim(),
      createdAt: stamp,
      updatedAt: stamp,
    };
    await db.loans.put(loan);

    // I7：状态由借出记录派生，不手工设置
    await db.copies.put({ ...copy, status: 'lent_out', updatedAt: stamp });
    // 02 §5.5：借出成功后 upsert 借书人候选（按规范化姓名去重）
    await upsertBorrowerInTx(db, { name: borrower, contact: loan.contact }, stamp);
    await bumpWriteCounter(db);
    return loan;
  });
}

export async function returnCopy(db: PocketLibraryDb, input: ReturnCopyInput): Promise<Loan> {
  return db.transaction('rw', db.copies, db.loans, db.settings, async () => {
    const copy = await requireCopy(db, input.copyId);
    const loan = await getActiveLoanForCopy(db, copy.id);
    if (loan === undefined) throw new Error('该副本当前没有进行中的借出记录');

    const stamp = nowIso();
    const returned: Loan = {
      ...loan,
      returnDate: input.returnDate ?? today(),
      status: 'returned',
      note: input.note === undefined ? loan.note : `${loan.note}${loan.note === '' ? '' : '；'}${input.note}`,
      updatedAt: stamp,
    };
    await db.loans.put(returned);

    if (copy.status !== 'lost' && copy.status !== 'sold') {
      await db.copies.put({ ...copy, status: 'on_shelf', updatedAt: stamp });
    }
    await bumpWriteCounter(db);
    return returned;
  });
}

export async function listActiveLoans(db: PocketLibraryDb): Promise<LoanWithBook[]> {
  const loans = await db.loans.where('status').equals('active').toArray();
  return attachLoanDetails(db, loans);
}

export async function listOverdueLoans(
  db: PocketLibraryDb,
  reference: string = today(),
): Promise<LoanWithBook[]> {
  const loans = await db.loans.where('status').equals('active').toArray();
  const overdue = loans.filter((l) => l.dueDate !== '' && l.dueDate < reference);
  return attachLoanDetails(db, overdue);
}

/** 按副本或书目取借阅历史，按借出日期倒序。 */
export async function listLoanHistory(
  db: PocketLibraryDb,
  filter: { copyId?: string; bookId?: string } = {},
): Promise<Loan[]> {
  let loans: Loan[];
  if (filter.copyId !== undefined) {
    loans = await db.loans.where('copyId').equals(filter.copyId).toArray();
  } else if (filter.bookId !== undefined) {
    const copies = await db.copies.where('bookId').equals(filter.bookId).toArray();
    const ids = new Set(copies.map((c) => c.id));
    loans = (await db.loans.toArray()).filter((l) => ids.has(l.copyId));
  } else {
    loans = await db.loans.toArray();
  }
  return loans.sort((a, b) => (a.loanDate === b.loanDate ? a.createdAt.localeCompare(b.createdAt) : b.loanDate.localeCompare(a.loanDate)));
}

/** 给借出记录补上书目/副本/位置信息，供 UI 直接展示。 */
export async function attachLoanDetails(db: PocketLibraryDb, loans: readonly Loan[]): Promise<LoanWithBook[]> {
  if (loans.length === 0) return [];
  const [books, copies, locations] = await Promise.all([
    db.books.toArray(),
    db.copies.toArray(),
    db.locations.toArray(),
  ]);
  const bookById = new Map(books.map((b) => [b.id, b]));
  const copyById = new Map(copies.map((c) => [c.id, c]));
  const pathById = new Map(locations.map((l) => [l.id, l.path]));

  const result: LoanWithBook[] = [];
  for (const loan of loans) {
    const copy = copyById.get(loan.copyId);
    if (copy === undefined) continue;
    const book = bookById.get(copy.bookId);
    if (book === undefined) continue;
    result.push({ ...loan, book, copy, locationPath: pathById.get(copy.locationId) ?? '' });
  }
  return result;
}
