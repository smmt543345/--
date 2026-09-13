import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UNSORTED_LOCATION_ID, newId } from '../domain/ids.ts';
import { withDb } from '../testing/harness.ts';
import { createBook } from './books.ts';
import { createCopy, getCopy } from './copies.ts';
import { putCover } from './covers.ts';
import { createLocation } from './locations.ts';
import { loanOut } from './loans.ts';
import { checkInvariants, repairInvariants } from './repair.ts';
import type { PocketLibraryDb } from './schema.ts';

/** 直接把脏数据写进库，绕过服务层校验 —— 这正是修复通道要处理的输入。 */
async function injectLocation(db: PocketLibraryDb, id: string, parentId: string | null, name = 'X'): Promise<void> {
  const stamp = '2026-01-01T00:00:00.000Z';
  await db.locations.put({
    id,
    parentId,
    name,
    path: '',
    depth: 0,
    type: 'home',
    sortOrder: 0,
    createdAt: stamp,
    updatedAt: stamp,
  });
}

describe('不变式修复通道（02 §6）', () => {
  it('干净的数据上跑一遍：0 变更，且不写坏任何东西', async () => {
    await withDb(async (db) => {
      const home = await createLocation(db, { name: '家' });
      await createLocation(db, { name: '客厅', parentId: home.id });
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id, locationId: home.id });
      await loanOut(db, { copyId: copy.id, borrower: '小王' });

      const report = await repairInvariants(db);
      assert.deepEqual(
        {
          danglingParentsFixed: report.danglingParentsFixed,
          cyclesBroken: report.cyclesBroken,
          copiesRepointed: report.copiesRepointed,
          copiesDeleted: report.copiesDeleted,
          loansDeleted: report.loansDeleted,
          duplicateActiveLoansResolved: report.duplicateActiveLoansResolved,
          copyStatusFixed: report.copyStatusFixed,
          orphanCoversDeleted: report.orphanCoversDeleted,
          pathsRebuilt: report.pathsRebuilt,
        },
        {
          danglingParentsFixed: 0,
          cyclesBroken: 0,
          copiesRepointed: 0,
          copiesDeleted: 0,
          loansDeleted: 0,
          duplicateActiveLoansResolved: 0,
          copyStatusFixed: 0,
          orphanCoversDeleted: 0,
          pathsRebuilt: 0,
        },
        '干净数据不得产生任何写入 —— 这是导入幂等性的前提',
      );
      assert.deepEqual(report.warnings, []);
      assert.equal((await checkInvariants(db)).ok, true);
    });
  });

  it('悬空父节点挂到「未分类」（I4）', async () => {
    await withDb(async (db) => {
      await injectLocation(db, 'orphan', '不存在的父');
      const report = await repairInvariants(db);

      assert.equal(report.danglingParentsFixed, 1);
      assert.equal((await db.locations.get('orphan'))?.parentId, UNSORTED_LOCATION_ID);
      assert.equal((await db.locations.get('orphan'))?.path, '未分类 / X');
    });
  });

  it('循环引用被打断（I5），且有限终止', async () => {
    await withDb(async (db) => {
      await injectLocation(db, 'aaa', 'bbb');
      await injectLocation(db, 'bbb', 'aaa');

      const report = await repairInvariants(db);
      assert.equal(report.cyclesBroken, 1);
      assert.equal((await db.locations.get('aaa'))?.parentId, UNSORTED_LOCATION_ID);

      const after = await checkInvariants(db);
      assert.equal(after.ok, true, `修复后应无问题：${after.problems.join('; ')}`);
    });
  });

  it('副本指向不存在的书目：连同借出记录一起删除（I1）', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id });
      await loanOut(db, { copyId: copy.id, borrower: '小王' });
      await db.books.delete(book.id);

      const report = await repairInvariants(db);
      assert.equal(report.copiesDeleted, 1);
      assert.equal(report.loansDeleted, 1);
      assert.equal(await db.copies.count(), 0);
      assert.equal(await db.loans.count(), 0);
    });
  });

  it('副本位置悬空：改到「未分类」（I2），不删书', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id });
      await db.copies.put({ ...copy, locationId: '不见了' });

      const report = await repairInvariants(db);
      assert.equal(report.copiesRepointed, 1);
      assert.equal(report.copiesDeleted, 0);
      assert.equal((await getCopy(db, copy.id))?.locationId, UNSORTED_LOCATION_ID);
    });
  });

  it('借出记录指向不存在的副本：删除（I3）', async () => {
    await withDb(async (db) => {
      const stamp = '2026-01-01T00:00:00.000Z';
      await db.loans.put({
        id: newId(),
        copyId: '不存在的副本',
        borrower: '小王',
        contact: '',
        loanDate: '2026-01-01',
        dueDate: '',
        returnDate: '',
        status: 'active',
        note: '',
        createdAt: stamp,
        updatedAt: stamp,
      });

      const report = await repairInvariants(db);
      assert.equal(report.loansDeleted, 1);
      assert.equal(await db.loans.count(), 0);
    });
  });

  it('一个副本多条进行中借出：保留最新一条，其余转历史（I6）', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id });

      // 绕过 loanOut 的 I6 守卫，直接造出脏数据
      const stamp = '2026-01-01T00:00:00.000Z';
      const make = (borrower: string, loanDate: string, id: string): void => {
        void db.loans.put({
          id,
          copyId: copy.id,
          borrower,
          contact: '',
          loanDate,
          dueDate: '',
          returnDate: '',
          status: 'active',
          note: '',
          createdAt: stamp,
          updatedAt: stamp,
        });
      };
      make('甲', '2026-01-01', 'loan-old');
      make('乙', '2026-03-01', 'loan-new');
      await db.copies.put({ ...copy, status: 'lent_out' });

      const report = await repairInvariants(db);
      assert.equal(report.duplicateActiveLoansResolved, 1);
      assert.equal((await db.loans.get('loan-new'))?.status, 'active', '保留借出日期最新的那条');
      assert.equal((await db.loans.get('loan-old'))?.status, 'returned');
      assert.equal((await getCopy(db, copy.id))?.status, 'lent_out');
      assert.equal((await checkInvariants(db)).ok, true);
    });
  });

  it('状态漂移被纠正：有在借却是在架 → lent_out（I7）', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id });
      await loanOut(db, { copyId: copy.id, borrower: '小王' });
      await db.copies.put({ ...copy, status: 'on_shelf' });

      const report = await repairInvariants(db);
      assert.equal(report.copyStatusFixed, 1);
      assert.equal((await getCopy(db, copy.id))?.status, 'lent_out');
    });
  });

  it('状态漂移被纠正：标着借出却没有在借 → on_shelf（I7）', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id });
      await db.copies.put({ ...copy, status: 'lent_out' });

      const report = await repairInvariants(db);
      assert.equal(report.copyStatusFixed, 1);
      assert.equal((await getCopy(db, copy.id))?.status, 'on_shelf');
    });
  });

  it('标着丢失却还有在借：借出记录关闭，丢失状态保留', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id });
      await loanOut(db, { copyId: copy.id, borrower: '小王' });
      await db.copies.put({ ...copy, status: 'lost' });

      await repairInvariants(db);
      assert.equal((await getCopy(db, copy.id))?.status, 'lost');
      const loans = await db.loans.toArray();
      assert.equal(loans[0]?.status, 'returned');
      assert.equal((await checkInvariants(db)).ok, true);
    });
  });

  it('路径缓存被重算（I8）', async () => {
    await withDb(async (db) => {
      const home = await createLocation(db, { name: '家' });
      const living = await createLocation(db, { name: '客厅', parentId: home.id });
      await db.locations.put({ ...(await db.locations.get(living.id))!, path: '错的' });

      const report = await repairInvariants(db);
      assert.equal(report.pathsRebuilt, 1);
      assert.equal((await db.locations.get(living.id))?.path, '家 / 客厅');
    });
  });

  it('修复是幂等的：连跑两次，第二次 0 变更', async () => {
    await withDb(async (db) => {
      await injectLocation(db, 'aaa', 'bbb');
      await injectLocation(db, 'bbb', 'aaa');
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id });
      await db.copies.put({ ...copy, locationId: '不见了' });

      await repairInvariants(db);
      const second = await repairInvariants(db);
      assert.equal(second.cyclesBroken, 0);
      assert.equal(second.copiesRepointed, 0);
      assert.equal(second.copyStatusFixed, 0);
      assert.equal(second.pathsRebuilt, 0);
    });
  });

  it('checkInvariants 只报告不落盘', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id });
      await db.copies.put({ ...copy, locationId: '不见了' });

      const before = await db.copies.get(copy.id);
      const result = await checkInvariants(db);
      assert.equal(result.ok, false);
      assert.ok(result.problems.some((p) => p.includes('I2')));
      assert.deepEqual(await db.copies.get(copy.id), before, '检查不得修改数据');
    });
  });

  it('S23 孤儿封面（I10）：封面指向不存在的书目 → 删除并记警告（B4）', async () => {
  it('S24 书目字段形状（I11）：authors 是字符串 → 收敛成数组并记警告（B6）', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '手改坏的书' });
      // 手改备份 / 别处写坏的库会把 authors 写成字符串，界面会在 authors.join 上直接抛错
      await db.books.put({ ...book, authors: '某作者' as unknown as string[], tags: [1, '历史'] as unknown as string[] });

      const check = await checkInvariants(db);
      assert.equal(check.ok, false, '检查阶段就要能看出问题');
      assert.ok(check.problems.some((p) => p.includes('I11')));

      const report = await repairInvariants(db);
      const fixed = await db.books.get(book.id);
      assert.deepEqual(fixed?.authors, ['某作者'], '字符串收敛成单元素数组');
      assert.deepEqual(fixed?.tags, ['历史'], '数组里的非字符串项被剔掉');
      assert.ok(report.warnings.some((w) => w.includes('I11') || w.includes('字符串数组')));
    });
  });

  it('I11 幂等：修正后再跑一遍，0 变更', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      await db.books.put({ ...book, authors: '甲' as unknown as string[] });
      await repairInvariants(db);
      const second = await repairInvariants(db);
      assert.equal(second.warnings.length, 0, '干净数据不得产生警告');
      assert.deepEqual((await db.books.get(book.id))?.authors, ['甲']);
    });
  });


    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      await putCover(db, { bookId: book.id, blob: new Blob([new Uint8Array([1])]), mime: 'image/jpeg' });
      // 快照回滚不动封面表，“书目没了但照片还在”正是这条不变式要兜的情形（02 §3.5）
      await putCover(db, { bookId: '查无此书', blob: new Blob([new Uint8Array([2])]), mime: 'image/jpeg' });

      const check = await checkInvariants(db);
      assert.equal(check.ok, false, '检查阶段就要能看出问题');
      assert.ok(check.problems.some((p) => p.includes('I10')));
      assert.ok(await db.covers.get('查无此书'), '检查不得动数据');

      const report = await repairInvariants(db);
      assert.equal(report.orphanCoversDeleted, 1);
      assert.equal(await db.covers.count(), 1, '只有孤儿那张被删');
      assert.ok(await db.covers.get(book.id), '好书目的封面不能跟着被删');
      assert.ok(
        report.warnings.some((w) => w.includes('查无此书')),
        '删了就必须说清是哪一张，不能静默清理',
      );

      // 数据已合规 → 再跑一次是 0 变更（导入幂等性的前提，03 §8）
      assert.equal((await repairInvariants(db)).orphanCoversDeleted, 0);
    });
  });
});
