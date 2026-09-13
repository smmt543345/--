/**
 * 列表查询（02 §10.3）测试：S18 / S19。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withDb } from '../testing/harness.ts';
import { createBook } from './books.ts';
import { createCopy } from './copies.ts';
import { createLocation } from './locations.ts';
import { loanOut } from './loans.ts';
import { listAllTags, listRecentBooks } from './listing.ts';

describe('listAllTags（02 §10.3、N1）', () => {
  it('S18 去重；多/单/零标签的库都正确；稳定排序', async () => {
    await withDb(async (db) => {
      assert.deepEqual(await listAllTags(db), [], '空库返回空数组');

      await createBook(db, { title: '甲', tags: ['小说', '历史'] });
      await createBook(db, { title: '乙', tags: ['小说'] });
      await createBook(db, { title: '丙' }); // 无标签
      await createBook(db, { title: '丁', tags: ['诗歌', '小说'] });

      assert.deepEqual(await listAllTags(db), ['历史', '诗歌', '小说']);
    });
  });
});

describe('listRecentBooks（02 §10.3、N2）', () => {
  it('S19 按 createdAt 倒序；limit 截断；副本组合视图完整', async () => {
    await withDb(async (db) => {
      const home = await createLocation(db, { name: '家' });
      const oldest = await createBook(db, { title: '最旧' });
      const middle = await createBook(db, { title: '中间' });
      const newest = await createBook(db, { title: '最新' });
      // 时间戳写死，保证倒序确定（createBook 用真实时钟，同毫秒会并列）
      await db.books.put({ ...oldest, createdAt: '2026-01-01T00:00:00.000Z' });
      await db.books.put({ ...middle, createdAt: '2026-01-02T00:00:00.000Z' });
      await db.books.put({ ...newest, createdAt: '2026-01-03T00:00:00.000Z' });

      const c1 = await createCopy(db, { bookId: newest.id, locationId: home.id });
      await createCopy(db, { bookId: newest.id, locationId: home.id });
      await createCopy(db, { bookId: oldest.id, locationId: home.id });
      await loanOut(db, { copyId: c1.id, borrower: '小王' });

      const recent = await listRecentBooks(db, { limit: 2 });
      assert.deepEqual(recent.map((r) => r.book.id), [newest.id, middle.id], 'createdAt 倒序 + limit 截断');
      assert.equal(recent[0]?.copies.length, 2, '副本组合视图完整');
      assert.equal(recent[0]?.copies[0]?.locationPath, '家');
      assert.equal(recent[0]?.copies[0]?.locationName, '家');
      assert.equal(
        recent[0]?.copies.find((c) => c.id === c1.id)?.activeLoan?.borrower,
        '小王',
        '被借出的副本带 activeLoan',
      );
      assert.equal(recent[1]?.copies.length, 0, '无副本的书也出现在列表里，copies 为空数组');
    });
  });
});
