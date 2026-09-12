import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withDb } from '../testing/harness.ts';
import { createBook } from './books.ts';
import { createCopy, getCopy, setCopyStatus } from './copies.ts';
import { createLocation } from './locations.ts';
import {
  getActiveLoanForCopy,
  listActiveLoans,
  listLoanHistory,
  listOverdueLoans,
  loanOut,
  returnCopy,
} from './loans.ts';
import { SETTING_KEYS, setSetting } from './settings.ts';

describe('借出服务', () => {
  it('借出后副本状态变成 lent_out（I7）', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id });

      const loan = await loanOut(db, { copyId: copy.id, borrower: '  小王  ', loanDate: '2026-01-01' });
      assert.equal(loan.status, 'active');
      assert.equal(loan.borrower, '小王', '借书人应去空格');
      assert.equal(loan.returnDate, '');
      assert.equal((await getCopy(db, copy.id))?.status, 'lent_out');
    });
  });

  it('应还日期按设置的借期自动推算，也可手填或留空', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      const a = await createCopy(db, { bookId: book.id });
      const b = await createCopy(db, { bookId: book.id });
      const c = await createCopy(db, { bookId: book.id });

      const auto = await loanOut(db, { copyId: a.id, borrower: '甲', loanDate: '2026-01-01' });
      assert.equal(auto.dueDate, '2026-01-31', '默认借期 30 天');

      const manual = await loanOut(db, { copyId: b.id, borrower: '乙', dueDate: '2026-03-01' });
      assert.equal(manual.dueDate, '2026-03-01');

      const none = await loanOut(db, { copyId: c.id, borrower: '丙', dueDate: '' });
      assert.equal(none.dueDate, '', '空串表示不设到期日');
    });
  });

  it('自定义借期生效', async () => {
    await withDb(async (db) => {
      await setSetting(db, SETTING_KEYS.loanPeriodDays, 14);
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id });
      const loan = await loanOut(db, { copyId: copy.id, borrower: '甲', loanDate: '2026-01-01' });
      assert.equal(loan.dueDate, '2026-01-15');
    });
  });

  it('借书人为空被拒绝', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id });
      await assert.rejects(() => loanOut(db, { copyId: copy.id, borrower: '   ' }), /借书人不能为空/);
    });
  });

  it('同一副本不能有两条进行中的借出（I6）', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id });
      await loanOut(db, { copyId: copy.id, borrower: '小王' });

      await assert.rejects(
        () => loanOut(db, { copyId: copy.id, borrower: '小李' }),
        /请先归还再借出/,
      );
      assert.equal(await db.loans.count(), 1, '拒绝后不得留下第二条记录');
    });
  });

  it('归还后副本回到在架，可以再借给别人', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id });
      const first = await loanOut(db, { copyId: copy.id, borrower: '小王', loanDate: '2026-01-01' });

      const returned = await returnCopy(db, { copyId: copy.id, returnDate: '2026-01-20' });
      assert.equal(returned.id, first.id, '归还的是同一条记录，不是新建一条');
      assert.equal(returned.status, 'returned');
      assert.equal(returned.returnDate, '2026-01-20');
      assert.equal((await getCopy(db, copy.id))?.status, 'on_shelf');
      assert.equal(await getActiveLoanForCopy(db, copy.id), undefined);

      const second = await loanOut(db, { copyId: copy.id, borrower: '小李', loanDate: '2026-02-01' });
      assert.notEqual(second.id, first.id);
      assert.equal(await db.loans.count(), 2, '历史记录必须保留');
    });
  });

  it('没有进行中的借出时归还会报错，而不是静默成功', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id });
      await assert.rejects(() => returnCopy(db, { copyId: copy.id }), /没有进行中的借出/);
    });
  });

  it('丢失的书归还时不会把状态改回在架（书不在手上）', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id });
      await loanOut(db, { copyId: copy.id, borrower: '小王' });
      await setCopyStatus(db, copy.id, 'lost');

      const active = await getActiveLoanForCopy(db, copy.id);
      assert.equal(active, undefined, '标记丢失时借出记录已被关闭');
      assert.equal((await getCopy(db, copy.id))?.status, 'lost');
    });
  });

  it('逾期列表只认有到期日且已过期的进行中记录', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      const soon = await createCopy(db, { bookId: book.id });
      const late = await createCopy(db, { bookId: book.id });
      const noDue = await createCopy(db, { bookId: book.id });

      await loanOut(db, { copyId: soon.id, borrower: '甲', dueDate: '2026-12-01' });
      await loanOut(db, { copyId: late.id, borrower: '乙', dueDate: '2026-01-01' });
      await loanOut(db, { copyId: noDue.id, borrower: '丙', dueDate: '' });

      const overdue = await listOverdueLoans(db, '2026-06-01');
      assert.deepEqual(overdue.map((l) => l.borrower), ['乙']);
      assert.equal((await listActiveLoans(db)).length, 3, '未到期的不算逾期，但仍是在借');
    });
  });

  it('已归还的记录不出现在在借 / 逾期列表里', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id });
      await loanOut(db, { copyId: copy.id, borrower: '甲', dueDate: '2026-01-01' });
      await returnCopy(db, { copyId: copy.id, returnDate: '2026-06-01' });

      assert.equal((await listActiveLoans(db)).length, 0);
      assert.equal((await listOverdueLoans(db, '2026-06-01')).length, 0);
    });
  });

  it('在借列表带上书名、副本与位置，UI 不用自己联表', async () => {
    await withDb(async (db) => {
      const home = await createLocation(db, { name: '家' });
      const book = await createBook(db, { title: '活着', authors: ['余华'] });
      const copy = await createCopy(db, { bookId: book.id, locationId: home.id });
      await loanOut(db, { copyId: copy.id, borrower: '小王' });

      const active = await listActiveLoans(db);
      assert.equal(active.length, 1);
      assert.equal(active[0]?.book.title, '活着');
      assert.equal(active[0]?.copy.id, copy.id);
      assert.equal(active[0]?.locationPath, '家');
    });
  });

  it('借阅历史按借出日期倒序，可按副本或按书目查', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id });

      await loanOut(db, { copyId: copy.id, borrower: '甲', loanDate: '2026-01-01' });
      await returnCopy(db, { copyId: copy.id, returnDate: '2026-01-10' });
      await loanOut(db, { copyId: copy.id, borrower: '乙', loanDate: '2026-03-01' });

      const byCopy = await listLoanHistory(db, { copyId: copy.id });
      assert.deepEqual(byCopy.map((l) => l.borrower), ['乙', '甲']);

      const byBook = await listLoanHistory(db, { bookId: book.id });
      assert.deepEqual(byBook.map((l) => l.borrower), ['乙', '甲']);

      assert.equal((await listLoanHistory(db)).length, 2);
    });
  });
});
