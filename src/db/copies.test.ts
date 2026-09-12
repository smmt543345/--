import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UNSORTED_LOCATION_ID } from '../domain/ids.ts';
import { withDb } from '../testing/harness.ts';
import { createBook } from './books.ts';
import {
  attachCopyDetails,
  createCopy,
  deleteCopy,
  getCopy,
  listCopiesByBook,
  listCopiesByLocation,
  moveCopy,
  setCopyStatus,
  updateCopy,
} from './copies.ts';
import { createLocation } from './locations.ts';
import { loanOut, returnCopy } from './loans.ts';

describe('副本服务', () => {
  it('未指定位置时落到「未分类」（决策 D5）', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id });
      assert.equal(copy.locationId, UNSORTED_LOCATION_ID);
      assert.equal(copy.status, 'on_shelf');
      assert.equal(copy.condition, 'unknown');
    });
  });

  it('指向不存在的书目 / 位置都被拒绝（I1、I2）', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      await assert.rejects(() => createCopy(db, { bookId: '不存在' }), /书目不存在/);
      await assert.rejects(
        () => createCopy(db, { bookId: book.id, locationId: '不存在' }),
        /位置不存在/,
      );
    });
  });

  it('不允许直接创建「借出」状态的副本 —— 状态由借出记录派生', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      await assert.rejects(() => createCopy(db, { bookId: book.id, status: 'lent_out' }), /loanOut/);
    });
  });

  it('更新副本：位置、品相、备注', async () => {
    await withDb(async (db) => {
      const home = await createLocation(db, { name: '家' });
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id });

      await moveCopy(db, copy.id, home.id);
      const updated = await updateCopy(db, copy.id, { condition: 'good', note: '有签名', owner: '老王' });
      assert.equal(updated.locationId, home.id);
      assert.equal(updated.condition, 'good');
      assert.equal(updated.note, '有签名');
      assert.equal(updated.owner, '老王');
    });
  });

  for (const status of ['lost', 'sold'] as const) {
    it(`标记 ${status} 会关闭进行中的借出（I7）`, async () => {
      await withDb(async (db) => {
        const book = await createBook(db, { title: '书' });
        const copy = await createCopy(db, { bookId: book.id });
        await loanOut(db, { copyId: copy.id, borrower: '小王' });

        await setCopyStatus(db, copy.id, status);
        const saved = await getCopy(db, copy.id);
        assert.equal(saved?.status, status);

        const loans = await db.loans.toArray();
        assert.equal(loans.length, 1);
        assert.equal(loans[0]?.status, 'returned');
        assert.ok((loans[0]?.note ?? '').includes('自动关闭'));
      });
    });
  }

  it('正被借出的副本不能改回「在架」（I7）', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id });
      await loanOut(db, { copyId: copy.id, borrower: '小王' });

      await assert.rejects(() => setCopyStatus(db, copy.id, 'on_shelf'), /请先归还/);
      assert.equal((await getCopy(db, copy.id))?.status, 'lent_out', '拒绝后状态必须保持 lent_out');
    });
  });

  it('标记丢失后不能再借出', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id });
      await setCopyStatus(db, copy.id, 'lost');
      await assert.rejects(() => loanOut(db, { copyId: copy.id, borrower: '小王' }), /不能借出/);
    });
  });

  it('删除副本连带删除借阅历史，历史记录不阻塞删除', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id });
      await loanOut(db, { copyId: copy.id, borrower: '小王' });
      await returnCopy(db, { copyId: copy.id });

      const result = await deleteCopy(db, copy.id);
      assert.equal(result.deletedLoans, 1);
      assert.equal(await db.copies.count(), 0);
      assert.equal(await db.loans.count(), 0);
    });
  });

  it('正被借出的副本必须显式确认才能删', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id });
      await loanOut(db, { copyId: copy.id, borrower: '小王' });

      await assert.rejects(() => deleteCopy(db, copy.id), /确认/);
      assert.equal(await db.copies.count(), 1, '拒绝后副本必须还在');

      const result = await deleteCopy(db, copy.id, { confirmLentOut: true });
      assert.equal(result.deletedLoans, 1);
      assert.equal(await db.copies.count(), 0);
    });
  });

  it('listCopiesByBook / attachCopyDetails 给出位置与在借信息', async () => {
    await withDb(async (db) => {
      const home = await createLocation(db, { name: '家' });
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id, locationId: home.id });

      const rows = await listCopiesByBook(db, book.id);
      assert.equal(rows.length, 1);

      const detailed = await attachCopyDetails(db, rows);
      assert.equal(detailed[0]?.locationPath, '家');
      assert.equal(detailed[0]?.locationName, '家');
      assert.equal(detailed[0]?.activeLoan, null);

      await loanOut(db, { copyId: copy.id, borrower: '小王' });
      const withLoan = await attachCopyDetails(db, await listCopiesByBook(db, book.id));
      assert.equal(withLoan[0]?.activeLoan?.borrower, '小王');
    });
  });

  it('listCopiesByLocation 默认子树口径，可关闭', async () => {
    await withDb(async (db) => {
      const home = await createLocation(db, { name: '家' });
      const living = await createLocation(db, { name: '客厅', parentId: home.id });
      const book = await createBook(db, { title: '书' });
      await createCopy(db, { bookId: book.id, locationId: living.id });
      await createCopy(db, { bookId: book.id, locationId: home.id });

      assert.equal((await listCopiesByLocation(db, home.id)).length, 2);
      assert.equal((await listCopiesByLocation(db, home.id, { includeSubtree: false })).length, 1);
    });
  });

  it('空列表不触发多余的数据库扫描', async () => {
    await withDb(async (db) => {
      assert.deepEqual(await attachCopyDetails(db, []), []);
    });
  });
});
