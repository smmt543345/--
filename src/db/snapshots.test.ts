/**
 * 删除撤销（02 §9.1）测试：S1–S6。
 *
 * 时间全部注入/派生自数据自身，不依赖挂钟。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withDb } from '../testing/harness.ts';
import type { Snapshot } from '../domain/types.ts';
import type { PocketLibraryDb } from './schema.ts';
import { createBook } from './books.ts';
import { createCopy, deleteCopy } from './copies.ts';
import { putCover } from './covers.ts';
import { createLocation, deleteLocation } from './locations.ts';
import { loanOut } from './loans.ts';
import { expireUndo, restoreUndo } from './snapshots.ts';
import { deleteBookCompletely } from '../features/books/write.ts';

async function undoOf(db: PocketLibraryDb): Promise<Snapshot | undefined> {
  return db.snapshots.where('kind').equals('undo').first();
}

function jpeg(...bytes: number[]): Blob {
  return new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });
}

async function bytesOf(blob: Blob): Promise<number[]> {
  return [...new Uint8Array(await blob.arrayBuffer())];
}

describe('删除撤销（02 §9.1）', () => {
  it('S1 删副本 → 撤销：副本与其借出记录按原 id 恢复；undo 快照被清理', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id });
      const loan = await loanOut(db, { copyId: copy.id, borrower: '小王' });
      // 删除前一刻的真实状态（借出后副本已变 lent_out）——撤销要原样回到这个状态
      const before = await db.copies.get(copy.id);

      await deleteCopy(db, copy.id, { confirmLentOut: true });
      assert.equal(await db.copies.get(copy.id), undefined, '删除已生效');

      const undo = await undoOf(db);
      assert.ok(undo, '删除必须挂 undo 快照');
      assert.equal(undo.data.copies.length, 1);
      assert.equal(undo.data.copies[0]?.id, copy.id);
      assert.equal(undo.data.loans.length, 1);
      assert.equal(undo.data.loans[0]?.id, loan.id);

      assert.equal(await restoreUndo(db), true);
      assert.deepEqual(await db.copies.get(copy.id), before, '按原 id 原样写回');
      assert.deepEqual(await db.loans.get(loan.id), loan, '借出记录同 id 恢复');
      assert.equal(await db.snapshots.where('kind').equals('undo').count(), 0, '撤销后 undo 清理');
    });
  });

  it('S2 删书目·级联 → 撤销：书目 + 副本 + 借出全恢复；原 id 不变', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      const a = await createCopy(db, { bookId: book.id });
      await createCopy(db, { bookId: book.id });
      const loan = await loanOut(db, { copyId: a.id, borrower: '小王' });

      const removed = await deleteBookCompletely(db, book.id, { strategy: 'cascade', confirmLentOut: true });
      assert.equal(removed.copies, 2);
      assert.equal(removed.loans, 1);
      assert.equal(await db.books.get(book.id), undefined);

      const undo = await undoOf(db);
      assert.ok(undo);
      assert.equal(undo.data.books.length, 1, '书目本身也进 undo');
      assert.equal(undo.data.books[0]?.id, book.id);
      assert.equal(undo.data.copies.length, 2);
      assert.equal(undo.data.loans.length, 1);

      await restoreUndo(db);
      assert.deepEqual(await db.books.get(book.id), book);
      assert.equal(await db.copies.count(), 2);
      assert.deepEqual(await db.loans.get(loan.id), loan);
      assert.equal(await db.snapshots.where('kind').equals('undo').count(), 0);
    });
  });

  it('S3 删位置·级联 → 撤销：子树 + 副本 + 借出全恢复；路径重建后正确', async () => {
    await withDb(async (db) => {
      const home = await createLocation(db, { name: '家' });
      const living = await createLocation(db, { name: '客厅', parentId: home.id });
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id, locationId: living.id });
      await loanOut(db, { copyId: copy.id, borrower: '小王' });
      // 删除前一刻的真实状态（借出后副本已变 lent_out）——撤销要原样回到这个状态
      const before = await db.copies.get(copy.id);

      await deleteLocation(db, home.id, 'cascade');
      assert.equal(await db.locations.get(home.id), undefined);

      const undo = await undoOf(db);
      assert.ok(undo);
      assert.equal(undo.data.locations.length, 2, '被删子树全部捕获');

      await restoreUndo(db);
      assert.equal((await db.locations.get(home.id))?.path, '家');
      assert.equal((await db.locations.get(living.id))?.path, '家 / 客厅', '路径重建后正确');
      assert.deepEqual(await db.copies.get(copy.id), before, '副本原样恢复（含借出状态）');
      assert.equal(await db.loans.count(), 1);
    });
  });

  it('S4 删位置·上移（reparent）：不产生 undo，也不顶掉已有的 undo', async () => {
    await withDb(async (db) => {
      // 先制造一份已存在的 undo（删副本），验证 reparent 不碰它
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id });
      await deleteCopy(db, copy.id);
      const before = await undoOf(db);
      assert.ok(before);

      const home = await createLocation(db, { name: '家' });
      await createLocation(db, { name: '客厅', parentId: home.id });
      await deleteLocation(db, home.id, 'reparent');

      const after = await undoOf(db);
      assert.equal(await db.snapshots.where('kind').equals('undo').count(), 1);
      assert.equal(after?.id, before.id, 'reparent 不产生 undo，也不顶掉已有的');
    });
  });

  it('S5 第二次删除顶掉第一次的 undo：只能撤销最新一次', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      const a = await createCopy(db, { bookId: book.id });
      const b = await createCopy(db, { bookId: book.id });

      await deleteCopy(db, a.id);
      const first = await undoOf(db);
      assert.ok(first);
      await deleteCopy(db, b.id);

      const undos = await db.snapshots.where('kind').equals('undo').toArray();
      assert.equal(undos.length, 1, '一次只挂一份未撤销的 undo');
      assert.notEqual(undos[0]?.id, first.id, '旧 undo 被销毁');
      assert.equal(undos[0]?.data.copies[0]?.id, b.id);

      await restoreUndo(db);
      assert.ok(await db.copies.get(b.id), '最新一次删除可以撤销');
      assert.equal(await db.copies.get(a.id), undefined, '旧删除的恢复窗口已结束');
    });
  });

  it('S6 撤销超时清理：expireUndo 注入 now，30 秒内可撤销、超时即清', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id });
      await loanOut(db, { copyId: copy.id, borrower: '小王' });
      await deleteCopy(db, copy.id, { confirmLentOut: true });

      const undo = await undoOf(db);
      assert.ok(undo);
      // 用 undo 自己的 createdAt 起算，不依赖挂钟
      const early = new Date(Date.parse(undo.createdAt) + 29_000).toISOString();
      assert.equal(await expireUndo(db, { olderThanMs: 30_000 }, early), 0, '29 秒内仍可撤销');
      assert.ok(await undoOf(db));

      const late = new Date(Date.parse(undo.createdAt) + 31_000).toISOString();
      assert.equal(await expireUndo(db, { olderThanMs: 30_000 }, late), 1, '超时后清理');
      assert.equal(await db.snapshots.where('kind').equals('undo').count(), 0);
      assert.equal(await db.copies.get(copy.id), undefined, '数据仍是删除后状态');
    });
  });

  it('S21 删书目·级联 → 撤销（B4）：封面随 undo 快照一并恢复（blob 字节一致）', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      await createCopy(db, { bookId: book.id });
      await putCover(db, { bookId: book.id, blob: jpeg(3, 1, 4, 1, 5), mime: 'image/jpeg' });

      await deleteBookCompletely(db, book.id, { strategy: 'cascade' });
      assert.equal(await db.covers.count(), 0, '书目没了，封面跟着删（02 §9）');

      const undo = await undoOf(db);
      assert.ok(undo);
      assert.equal(undo.data.covers?.length, 1, 'undo 快照要带上被删书目那张照片（02 §12.1）');
      assert.equal(undo.data.covers?.[0]?.bookId, book.id);

      await restoreUndo(db);
      const restored = await db.covers.get(book.id);
      assert.ok(restored, '撤销后封面必须回来');
      assert.deepEqual(await bytesOf(restored.blob), [3, 1, 4, 1, 5], '照片按字节原样写回，不是重压一遍');
      assert.equal(restored.mime, 'image/jpeg');
    });
  });

  it('删副本的 undo 不带封面段：没有数据被销毁，不该顺手清掉别人的照片', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      await putCover(db, { bookId: book.id, blob: jpeg(9), mime: 'image/jpeg' });
      const copy = await createCopy(db, { bookId: book.id });
      await deleteCopy(db, copy.id);

      const undo = await undoOf(db);
      assert.equal(undo?.data.covers, undefined);
      await restoreUndo(db);
      const kept = await db.covers.get(book.id);
      assert.ok(kept, '封面不该被删副本的撤销带上或带走');
      assert.deepEqual(await bytesOf(kept.blob), [9]);
    });
  });
});
