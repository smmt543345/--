/**
 * 借书人候选（02 §5.5）测试：S12–S17。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withDb } from '../testing/harness.ts';
import { createBook } from './books.ts';
import { createCopy, deleteCopy } from './copies.ts';
import { loanOut } from './loans.ts';
import {
  MAX_BORROWERS,
  createBorrower,
  deleteBorrower,
  listBorrowers,
  normalizeBorrowerName,
  updateBorrower,
} from './borrowers.ts';
import { expireUndo } from './snapshots.ts';

describe('借书人候选（02 §5.5）', () => {
  it('normalizeBorrowerName：trim + 折叠连续空白', () => {
    assert.equal(normalizeBorrowerName('  张   三  '), '张 三');
    assert.equal(normalizeBorrowerName('张三'), '张三');
    assert.equal(normalizeBorrowerName('   '), '');
  });

  it('S12 借书人 upsert：同名借出两次只有一条候选；contact 取最新', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      const a = await createCopy(db, { bookId: book.id });
      const b = await createCopy(db, { bookId: book.id });
      await loanOut(db, { copyId: a.id, borrower: ' 张  三 ', contact: '111' });
      await loanOut(db, { copyId: b.id, borrower: '张 三', contact: '222' });

      assert.equal(await db.borrowers.count(), 1);
      const rows = await listBorrowers(db);
      assert.equal(rows[0]?.name, '张 三', '姓名一律存规范化姓名');
      assert.equal(rows[0]?.contact, '222', '重名视为更新联系方式');
    });
  });

  it('S13 借书人超 20 条：最旧 updatedAt 被淘汰', async () => {
    await withDb(async (db) => {
      for (let i = 1; i <= MAX_BORROWERS + 3; i++) {
        const stamp = `2026-09-01T00:00:${String(i).padStart(2, '0')}.000Z`;
        await createBorrower(db, { name: `朋友${i}` }, { now: stamp });
      }

      assert.equal(await db.borrowers.count(), MAX_BORROWERS, '上限 20 条');
      const names = (await listBorrowers(db)).map((b) => b.name);
      assert.equal(names.includes('朋友1'), false, '最旧的 updatedAt 被淘汰');
      assert.equal(names.includes('朋友23'), true);
    });
  });

  it('S14 删借书人候选：历史借出记录的 borrower 字符串不变', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id });
      const loan = await loanOut(db, { copyId: copy.id, borrower: '小王', contact: '111' });

      const candidates = await listBorrowers(db);
      assert.equal(candidates.length, 1, '借出自动积累候选');
      await deleteBorrower(db, (candidates[0] as { id: string }).id);
      assert.equal(await db.borrowers.count(), 0);

      const kept = await db.loans.get(loan.id);
      assert.equal(kept?.borrower, '小王', 'Loan.borrower 是历史快照，不指向候选');
      assert.equal(kept?.contact, '111');
    });
  });

  it('S16 启动清理超期 undo（expireUndo olderThanMs=0）：undo 全清，业务数据不受影响', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id });
      const kept = await createCopy(db, { bookId: book.id });
      await deleteCopy(db, copy.id);
      assert.equal(await db.snapshots.where('kind').equals('undo').count(), 1);

      assert.equal(await expireUndo(db, { olderThanMs: 0 }), 1);
      assert.equal(await db.snapshots.where('kind').equals('undo').count(), 0);
      assert.equal(await db.copies.get(copy.id), undefined, '已删的数据不回魂');
      assert.ok(await db.copies.get(kept.id), '其余业务数据不受影响');
      assert.ok(await db.books.get(book.id));
    });
  });

  it('S17 借书人手动新增重名：按规范化姓名去重，重名视为更新该候选的联系方式', async () => {
    await withDb(async (db) => {
      const first = await createBorrower(
        db,
        { name: '老 王', contact: 'old' },
        { now: '2026-09-01T00:00:01.000Z' },
      );
      // 规范化 = trim + 折叠连续空白：多个空格应当命中同一条候选
      const again = await createBorrower(
        db,
        { name: '  老   王  ', contact: 'new' },
        { now: '2026-09-01T00:00:02.000Z' },
      );

      assert.equal(again.id, first.id, '重名视为更新，不是新建');
      assert.equal(await db.borrowers.count(), 1);
      const row = await db.borrowers.get(first.id);
      assert.equal(row?.name, '老 王');
      assert.equal(row?.contact, 'new');
      assert.equal(row?.updatedAt, '2026-09-01T00:00:02.000Z');
    });
  });

  it('updateBorrower：改名撞上另一条候选时拒绝，避免静默丢行', async () => {
    await withDb(async (db) => {
      const a = await createBorrower(db, { name: '甲' });
      await createBorrower(db, { name: '乙' });

      await assert.rejects(() => updateBorrower(db, a.id, { name: '乙' }), /已存在同名借书人/);
      assert.equal(await db.borrowers.count(), 2, '拒绝后两条候选都在');

      const updated = await updateBorrower(db, a.id, { contact: '新号码' });
      assert.equal(updated.contact, '新号码');
    });
  });
});
