import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UNSORTED_LOCATION_ID } from '../domain/ids.ts';
import { withDb } from '../testing/harness.ts';
import {
  countCopiesByStatus,
  createBook,
  deleteBook,
  findBookByIsbn,
  findBooksByIsbn,
  getBookDetail,
  listBooks,
  normalizeTitle,
  searchBooks,
  updateBook,
} from './books.ts';
import { createCopy } from './copies.ts';
import { createLocation } from './locations.ts';
import { loanOut } from './loans.ts';
import type { PocketLibraryDb } from './schema.ts';

describe('书目服务', () => {
  it('创建时规范化 ISBN，去重并整理数组字段', async () => {
    const book = await withDb((db) =>
      createBook(db, {
        title: '  深入理解计算机系统  ',
        isbn: '978-7-111-54493-7',
        authors: ['Randal', ' Randal ', '', 'Bryant'],
        tags: ['计算机', '计算机', ' 教材 '],
      }),
    );
    assert.equal(book.title, '深入理解计算机系统');
    assert.equal(book.isbn, '9787111544937');
    assert.deepEqual(book.authors, ['Randal', 'Bryant'], '作者去重且去空');
    assert.deepEqual(book.tags, ['计算机', '教材']);
  });

  it('非法 ISBN 存为空串，不阻塞保存（中文书元数据本就不全）', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '无号书', isbn: '乱码' });
      assert.equal(book.isbn, '');
      const saved = await db.books.get(book.id);
      assert.equal(saved?.title, '无号书');
    });
  });

  it('空 ISBN 之间不互相查重 —— 否则所有无号书会撞成一本', async () => {
    await withDb(async (db) => {
      const first = await createBook(db, { title: '甲' });
      const second = await createBook(db, { title: '乙' });
      assert.notEqual(first.id, second.id);
      assert.equal(await findBookByIsbn(db, ''), undefined);
      assert.equal(await findBookByIsbn(db, '乱码'), undefined);
      assert.equal(await db.books.count(), 2);
    });
  });

  it('按 ISBN 查得到，ISBN-10 与 ISBN-13 落到同一条', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书', isbn: '0-306-40615-2' });
      assert.equal(book.isbn, '9780306406157');
      assert.equal((await findBookByIsbn(db, '9780306406157'))?.id, book.id);
      assert.equal((await findBookByIsbn(db, '0-306-40615-2'))?.id, book.id);
    });
  });

  it('同一 ISBN 存在多条记录时能全部查出来（导入后可能出现）', async () => {
    await withDb(async (db) => {
      const a = await createBook(db, { title: '甲版', isbn: '9787111544937' });
      const b = await createBook(db, { title: '乙版', isbn: '9787111544937' });
      const found = await findBooksByIsbn(db, '9787111544937');
      assert.deepEqual(found.map((x) => x.id).sort(), [a.id, b.id].sort());
    });
  });

  it('更新书目：只改传入字段，updatedAt 前进', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '旧名', publisher: '某社' });
      const updated = await updateBook(db, book.id, { title: '新名' });
      assert.equal(updated.title, '新名');
      assert.equal(updated.publisher, '某社', '未传字段不得被清空');
      assert.ok(updated.updatedAt >= book.updatedAt);
    });
  });

  it('有副本时拒绝删除书目，且不发散 —— 缺省就是不能删实体书', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id });
      await assert.rejects(() => deleteBook(db, book.id), /还有 1 本副本/);

      await db.copies.delete(copy.id);
      await deleteBook(db, book.id);
      assert.equal(await db.books.count(), 0);
    });
  });

  it('listBooks 按书名排序', async () => {
    await withDb(async (db) => {
      await createBook(db, { title: 'C 书' });
      await createBook(db, { title: 'A 书' });
      await createBook(db, { title: 'B 书' });
      const titles = (await listBooks(db)).map((b) => b.title);
      assert.deepEqual(titles, ['A 书', 'B 书', 'C 书']);
    });
  });

  it('getBookDetail 同时给出副本（带位置与在借状态）与借阅历史', async () => {
    await withDb(async (db) => {
      const home = await createLocation(db, { name: '家' });
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id, locationId: home.id });
      await loanOut(db, { copyId: copy.id, borrower: '小王', loanDate: '2026-01-01' });

      const detail = await getBookDetail(db, book.id);
      assert.equal(detail?.copies.length, 1);
      assert.equal(detail?.copies[0]?.locationPath, '家');
      assert.equal(detail?.copies[0]?.activeLoan?.borrower, '小王');
      assert.equal(detail?.loans.length, 1);
    });
  });

  it('countCopiesByStatus 分状态计数', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      const a = await createCopy(db, { bookId: book.id });
      await createCopy(db, { bookId: book.id });
      await loanOut(db, { copyId: a.id, borrower: '小王' });

      const counts = await countCopiesByStatus(db, book.id);
      assert.deepEqual(counts, { on_shelf: 1, lent_out: 1, lost: 0, sold: 0 });
    });
  });

  it('normalizeTitle 抹平空格与标点，用于疑似重复判断', () => {
    assert.equal(normalizeTitle('深入理解 计算机系统'), normalizeTitle('深入理解计算机系统'));
    assert.equal(normalizeTitle('《活着》（余华）'), normalizeTitle('活着余华'));
    // 全角标点、日文中点同样要抹平：中文书的题名常照抄自书店页面，全角半角混用是常态
    assert.equal(normalizeTitle('哈利・波特～与魔法石．'), normalizeTitle('哈利波特与魔法石'));
    assert.equal(normalizeTitle('书名／副题'), normalizeTitle('书名副题'));
    // 但 # 与 + 是有意义的字符，不能被当标点抹掉（否则「C# 入门」会撞上「C 入门」）
    assert.notEqual(normalizeTitle('C# 入门经典'), normalizeTitle('C 入门经典'));
    assert.notEqual(normalizeTitle('C++ Primer'), normalizeTitle('C Primer'));
  });
});

describe('搜索（02 §10.2）', () => {
  async function seed(db: PocketLibraryDb): Promise<void> {
    const home = await createLocation(db, { name: '家' });
    const office = await createLocation(db, { name: '书房', parentId: home.id });
    const shelf = await createLocation(db, { name: '书架', parentId: office.id });

    const csapp = await createBook(db, {
      title: '深入理解计算机系统',
      authors: ['Bryant'],
      isbn: '9787111544937',
      tags: ['计算机'],
    });
    const novel = await createBook(db, { title: '活着', authors: ['余华'], tags: ['小说'] });

    await createCopy(db, { bookId: csapp.id, locationId: shelf.id });
    await createCopy(db, { bookId: csapp.id, locationId: UNSORTED_LOCATION_ID });
    await createCopy(db, { bookId: novel.id, locationId: home.id });
  }

  it('空条件返回全部书目', async () => {
    await withDb(async (db) => {
      await seed(db);
      const results = await searchBooks(db);
      assert.equal(results.length, 2);
      assert.equal(results.every((r) => r.matched.length === 0), true);
    });
  });

  it('关键词命中书名 / 作者 / ISBN / 标签 / 出版社，并标出命中的字段', async () => {
    await withDb(async (db) => {
      await seed(db);
      assert.deepEqual((await searchBooks(db, { keyword: '计算机' }))[0]?.matched, ['title', 'tag']);
      assert.deepEqual((await searchBooks(db, { keyword: '余华' }))[0]?.matched, ['author']);
      assert.deepEqual((await searchBooks(db, { keyword: '9787111544937' }))[0]?.matched, ['isbn']);
      assert.equal((await searchBooks(db, { keyword: '不存在的词' })).length, 0);
    });
  });

  it('按位置筛选是子树口径 —— 问"书房有几本"要算上书架', async () => {
    await withDb(async (db) => {
      await seed(db);
      const office = (await listLocationsByName(db, '书房')).id;
      const results = await searchBooks(db, { locationId: office });
      assert.equal(results.length, 1);
      assert.equal(results[0]?.book.title, '深入理解计算机系统');
      assert.equal(results[0]?.copies.length, 1, '只应保留落在该子树的副本');
    });
  });

  it('按状态筛选只返回真有该状态副本的书', async () => {
    await withDb(async (db) => {
      await seed(db);
      assert.equal((await searchBooks(db, { status: 'lent_out' })).length, 0);

      const loaned = (await searchBooks(db, { keyword: '活着' }))[0];
      await loanOut(db, { copyId: loaned?.copies[0]?.id ?? '', borrower: '小王' });

      const results = await searchBooks(db, { status: 'lent_out' });
      assert.deepEqual(results.map((r) => r.book.title), ['活着']);
    });
  });

  it('按标签筛选', async () => {
    await withDb(async (db) => {
      await seed(db);
      const results = await searchBooks(db, { tag: '小说' });
      assert.deepEqual(results.map((r) => r.book.title), ['活着']);
      assert.equal((await searchBooks(db, { tag: '不存在的标签' })).length, 0);
    });
  });

  it('标签与位置/状态同时给定时仍是 AND —— 标签不能把不在该子树里的书放进来', async () => {
    await withDb(async (db) => {
      await seed(db);
      const home = (await listLocationsByName(db, '家')).id;
      const shelf = (await listLocationsByName(db, '书架')).id;

      // 「活着」带「小说」标签，但它的副本在家，不在书架子树里。
      assert.deepEqual(await searchBooks(db, { locationId: shelf, tag: '小说' }), []);
      assert.deepEqual(
        (await searchBooks(db, { locationId: home, tag: '小说' })).map((r) => r.book.title),
        ['活着'],
      );
      // 状态同样是副本维度的条件：一本副本都没借出去，就不该被标签放进来。
      assert.deepEqual(await searchBooks(db, { status: 'lent_out', tag: '小说' }), []);

      // 只有标签时保持宽松：有标签、但一本实体都没有的书也要列出来（标签是书目维度的条件）。
      const wishlist = await createBook(db, { title: '还没买到的书', tags: ['小说'] });
      const tagged = await searchBooks(db, { tag: '小说' });
      assert.equal(tagged.length, 2);
      assert.equal(tagged.find((r) => r.book.id === wishlist.id)?.copies.length, 0);
    });
  });

  it('limit 生效', async () => {
    await withDb(async (db) => {
      await seed(db);
      assert.equal((await searchBooks(db, { limit: 1 })).length, 1);
    });
  });
});

async function listLocationsByName(db: PocketLibraryDb, name: string): Promise<{ id: string }> {
  const rows = await db.locations.toArray();
  const found = rows.find((row) => row.name === name);
  assert.notEqual(found, undefined, `位置「${name}」应存在`);
  return { id: (found as { id: string }).id };
}
