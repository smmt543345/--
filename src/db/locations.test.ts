import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UNSORTED_LOCATION_ID } from '../domain/ids.ts';
import { withDb, withRawDb } from '../testing/harness.ts';
import { createBook } from './books.ts';
import { seedDefaults } from './client.ts';
import { createCopy } from './copies.ts';
import { loanOut } from './loans.ts';
import {
  countLocationDependents,
  createLocation,
  deleteLocation,
  getLocation,
  getLocationTree,
  listLocations,
  moveLocation,
  rebuildLocationPaths,
  updateLocation,
} from './locations.ts';

describe('位置服务', () => {
  it('播种「未分类」，且重复播种不会改数据', async () => {
    await withRawDb(async (db) => {
      await seedDefaults(db);
      const first = await getLocation(db, UNSORTED_LOCATION_ID);
      assert.equal(first?.name, '未分类');
      assert.equal(first?.parentId, null);

      await seedDefaults(db);
      const again = await getLocation(db, UNSORTED_LOCATION_ID);
      assert.deepEqual(again, first, '重复播种不得改动已有记录');
    });
  });

  it('建位置：路径与深度被物化，同级 sortOrder 递增', async () => {
    await withDb(async (db) => {
      const home = await createLocation(db, { name: '家' });
      const living = await createLocation(db, { name: '客厅', parentId: home.id });
      const shelf = await createLocation(db, { name: '白书架A', parentId: living.id });
      const other = await createLocation(db, { name: '卧室', parentId: home.id });

      assert.equal(home.path, '家');
      assert.equal(home.depth, 0);
      assert.equal(home.type, 'home');
      assert.equal(living.path, '家 / 客厅');
      assert.equal(living.depth, 1);
      assert.equal(living.type, 'room');
      assert.equal(shelf.path, '家 / 客厅 / 白书架A');
      assert.equal(shelf.type, 'shelf');
      assert.equal(other.sortOrder, 1, '同级第二个应排在后面');
    });
  });

  it('空名称与不存在的父位置都被拒绝', async () => {
    await withDb(async (db) => {
      await assert.rejects(() => createLocation(db, { name: '   ' }), /名称不能为空/);
      await assert.rejects(() => createLocation(db, { name: '客厅', parentId: '不存在' }), /上级位置不存在/);
    });
  });

  it('改名会级联刷新子孙路径', async () => {
    await withDb(async (db) => {
      const home = await createLocation(db, { name: '家' });
      const living = await createLocation(db, { name: '客厅', parentId: home.id });
      const shelf = await createLocation(db, { name: '书架', parentId: living.id });

      await updateLocation(db, living.id, { name: '起居室' });
      assert.equal((await getLocation(db, shelf.id))?.path, '家 / 起居室 / 书架');
    });
  });

  it('重算路径不改 updatedAt —— 否则会污染导入合并的"后写覆盖"判断', async () => {
    await withDb(async (db) => {
      const home = await createLocation(db, { name: '家' });
      const living = await createLocation(db, { name: '客厅', parentId: home.id });
      const before = await getLocation(db, living.id);

      await updateLocation(db, home.id, { name: '我的家' });
      const after = await getLocation(db, living.id);

      assert.equal(after?.path, '我的家 / 客厅', '路径应已更新');
      assert.equal(after?.updatedAt, before?.updatedAt, '派生字段重算不得改 updatedAt');
    });
  });

  it('rebuildLocationPaths 幂等：第二次必须 0 变化', async () => {
    await withDb(async (db) => {
      const home = await createLocation(db, { name: '家' });
      await createLocation(db, { name: '客厅', parentId: home.id });
      assert.equal(await rebuildLocationPaths(db), 0);
    });
  });

  it('不能把位置移进自己的子树（防环）', async () => {
    await withDb(async (db) => {
      const home = await createLocation(db, { name: '家' });
      const living = await createLocation(db, { name: '客厅', parentId: home.id });
      const shelf = await createLocation(db, { name: '书架', parentId: living.id });

      await assert.rejects(() => moveLocation(db, living.id, shelf.id), /下级/);
      await assert.rejects(() => moveLocation(db, living.id, living.id), /下级/);
    });
  });

  it('移动位置后子孙路径整体重算', async () => {
    await withDb(async (db) => {
      const home = await createLocation(db, { name: '家' });
      const office = await createLocation(db, { name: '书房' });
      const shelf = await createLocation(db, { name: '书架', parentId: home.id });

      await moveLocation(db, shelf.id, office.id);
      assert.equal((await getLocation(db, shelf.id))?.path, '书房 / 书架');
    });
  });

  it('「未分类」不可改名 / 移动 / 删除', async () => {
    await withDb(async (db) => {
      const home = await createLocation(db, { name: '家' });
      await assert.rejects(() => updateLocation(db, UNSORTED_LOCATION_ID, { name: 'X' }), /未分类/);
      await assert.rejects(() => moveLocation(db, UNSORTED_LOCATION_ID, home.id), /未分类/);
      await assert.rejects(() => deleteLocation(db, UNSORTED_LOCATION_ID), /未分类/);
    });
  });

  it('删除有下级的位置必须显式给策略，不允许有默认值', async () => {
    await withDb(async (db) => {
      const home = await createLocation(db, { name: '家' });
      await createLocation(db, { name: '客厅', parentId: home.id });

      await assert.rejects(() => deleteLocation(db, home.id), /必须指定策略/);
      const still = await getLocation(db, home.id);
      assert.notEqual(still, undefined, '拒绝后位置必须还在');
    });
  });

  it('reparent：子位置上移，副本上移；顶层位置的副本落到「未分类」', async () => {
    await withDb(async (db) => {
      const home = await createLocation(db, { name: '家' });
      const living = await createLocation(db, { name: '客厅', parentId: home.id });
      const shelf = await createLocation(db, { name: '书架', parentId: living.id });
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id, locationId: shelf.id });

      await deleteLocation(db, living.id, 'reparent');
      assert.equal((await getLocation(db, shelf.id))?.parentId, home.id);
      assert.equal((await getLocation(db, shelf.id))?.path, '家 / 书架');
      const movedCopy = await db.copies.get(copy.id);
      assert.equal(movedCopy?.locationId, home.id);

      // 顶层位置没有父，副本只能去「未分类」
      await deleteLocation(db, home.id, 'reparent');
      assert.equal((await db.copies.get(copy.id))?.locationId, UNSORTED_LOCATION_ID);
      assert.equal((await getLocation(db, shelf.id))?.parentId, UNSORTED_LOCATION_ID);
    });
  });

  it('cascade：连同下级、副本、借出记录一起删除', async () => {
    await withDb(async (db) => {
      const home = await createLocation(db, { name: '家' });
      const living = await createLocation(db, { name: '客厅', parentId: home.id });
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id, locationId: living.id });
      await loanOut(db, { copyId: copy.id, borrower: '小王' });

      const result = await deleteLocation(db, home.id, 'cascade');
      assert.equal(result.deletedLocations, 2);
      assert.equal(result.deletedCopies, 1);
      assert.equal(result.deletedLoans, 1);
      assert.equal(await db.locations.count(), 1, '只剩「未分类」');
      assert.equal(await db.copies.count(), 0);
      assert.equal(await db.loans.count(), 0);
      assert.equal((await db.books.get(book.id))?.title, '书', '书目本身不该被删');
    });
  });

  it('叶子位置可以不带策略直接删', async () => {
    await withDb(async (db) => {
      const home = await createLocation(db, { name: '家' });
      const living = await createLocation(db, { name: '客厅', parentId: home.id });
      const result = await deleteLocation(db, living.id);
      assert.equal(result.deletedLocations, 1);
      assert.equal(await getLocation(db, living.id), undefined);
    });
  });

  it('countLocationDependents 报出将被波及的下级与副本数', async () => {
    await withDb(async (db) => {
      const home = await createLocation(db, { name: '家' });
      const living = await createLocation(db, { name: '客厅', parentId: home.id });
      const book = await createBook(db, { title: '书' });
      await createCopy(db, { bookId: book.id, locationId: living.id });
      await createCopy(db, { bookId: book.id, locationId: home.id });

      const counts = await countLocationDependents(db, home.id);
      assert.equal(counts.childLocations, 1);
      assert.equal(counts.copies, 2, '子树口径，包含客厅里那本');
    });
  });

  it('listLocations / getLocationTree 给出可用结构', async () => {
    await withDb(async (db) => {
      const home = await createLocation(db, { name: '家' });
      await createLocation(db, { name: '客厅', parentId: home.id });
      await createLocation(db, { name: '卧室', parentId: home.id });

      const rows = await listLocations(db);
      assert.equal(rows.length, 4, '含「未分类」');

      const tree = await getLocationTree(db);
      const roots = tree.map((node) => node.id).sort();
      assert.deepEqual(roots, [UNSORTED_LOCATION_ID, home.id].sort());
      const homeNode = tree.find((node) => node.id === home.id);
      assert.equal(homeNode?.children.length, 2);
    });
  });
});
