import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withDb } from '../testing/harness.ts';
import { createBook } from './books.ts';
import { createCopy, setCopyStatus } from './copies.ts';
import { createLocation } from './locations.ts';
import { loanOut, returnCopy } from './loans.ts';
import {
  DEFAULT_SETTINGS,
  SETTING_KEYS,
  bumpWriteCounter,
  ensureDefaultSettings,
  getSetting,
  resetSettings,
  resetWriteCounter,
  setSetting,
} from './settings.ts';
import { computeSubtreeCounts, getCopiesByLocation, getDuplicateBooks, getLibraryCounts, getStats } from './stats.ts';

describe('设置（01 §3.3）', () => {
  it('播种缺省值，重复播种不覆盖用户改过的值', async () => {
    await withDb(async (db) => {
      assert.equal(await getSetting(db, SETTING_KEYS.loanPeriodDays, 0), 30);
      await setSetting(db, SETTING_KEYS.loanPeriodDays, 60);

      await ensureDefaultSettings(db);
      assert.equal(await getSetting(db, SETTING_KEYS.loanPeriodDays, 0), 60, '播种不得覆盖已成型的值');
    });
  });

  it('读不存在的键返回调用方给的兜底值，不抛异常', async () => {
    await withDb(async (db) => {
      await db.settings.clear();
      assert.equal(await getSetting(db, SETTING_KEYS.theme, 'system'), 'system');
      assert.equal(await getSetting(db, SETTING_KEYS.writesSinceSnapshot, 0), 0);
    });
  });

  it('写操作计数器递增，重置后归零并记下快照时间', async () => {
    await withDb(async (db) => {
      assert.equal(await bumpWriteCounter(db), 1);
      assert.equal(await bumpWriteCounter(db), 2);

      await resetWriteCounter(db, '2026-09-11T00:00:00.000Z');
      assert.equal(await getSetting(db, SETTING_KEYS.writesSinceSnapshot, -1), 0);
      assert.equal(await getSetting(db, SETTING_KEYS.lastAutoSnapshotAt, ''), '2026-09-11T00:00:00.000Z');
    });
  });

  it('重置清空的是设备状态，保留本机偏好（02 §9）', async () => {
    await withDb(async (db) => {
      await setSetting(db, SETTING_KEYS.theme, 'dark');
      await setSetting(db, SETTING_KEYS.loanPeriodDays, 14);
      await bumpWriteCounter(db);

      await resetSettings(db);
      assert.equal(await getSetting(db, SETTING_KEYS.writesSinceSnapshot, -1), 0);
      assert.equal(await getSetting(db, SETTING_KEYS.theme, ''), 'dark', '主题属于本机偏好');
      assert.equal(await getSetting(db, SETTING_KEYS.loanPeriodDays, 0), 14, '借期不应被重置');
    });
  });

  it('缺省值表里的每个键都写得进去 —— 防止加了键忘了值', async () => {
    await withDb(async (db) => {
      await db.settings.clear();
      await ensureDefaultSettings(db);
      for (const key of Object.values(SETTING_KEYS)) {
        assert.notEqual(
          await db.settings.get(key),
          undefined,
          `设置键 ${key} 缺省值缺失`,
        );
      }
      assert.equal(Object.keys(DEFAULT_SETTINGS).length, Object.values(SETTING_KEYS).length);
    });
  });
});

describe('统计（02 §10.1）', () => {
  it('getLibraryCounts 给出四张表的行数，未分类位置计入', async () => {
    await withDb(async (db) => {
      assert.deepEqual(await getLibraryCounts(db), { locations: 1, books: 0, copies: 0, loans: 0 });

      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id });
      await loanOut(db, { copyId: copy.id, borrower: '小王' });

      assert.deepEqual(await getLibraryCounts(db), { locations: 1, books: 1, copies: 1, loans: 1 });
    });
  });

  it('空库统计全为 0', async () => {
    await withDb(async (db) => {
      assert.deepEqual(await getStats(db, '2026-09-11'), {
        books: 0,
        copies: 0,
        onShelf: 0,
        lentOut: 0,
        lost: 0,
        sold: 0,
        activeLoans: 0,
        overdueLoans: 0,
      });
    });
  });

  it('分状态计数，在借条数与 lent_out 副本数一致（I7）', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      const a = await createCopy(db, { bookId: book.id });
      await createCopy(db, { bookId: book.id });
      const c = await createCopy(db, { bookId: book.id });
      const d = await createCopy(db, { bookId: book.id });
      await loanOut(db, { copyId: a.id, borrower: '甲' });
      await setCopyStatus(db, c.id, 'lost');
      await setCopyStatus(db, d.id, 'sold');

      const stats = await getStats(db, '2026-09-11');
      assert.equal(stats.books, 1);
      assert.equal(stats.copies, 4);
      assert.equal(stats.onShelf, 1);
      assert.equal(stats.lentOut, 1);
      assert.equal(stats.lost, 1);
      assert.equal(stats.sold, 1);
      assert.equal(stats.activeLoans, stats.lentOut);
    });
  });

  it('逾期统计排除无到期日的记录', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      const a = await createCopy(db, { bookId: book.id });
      const b = await createCopy(db, { bookId: book.id });
      await loanOut(db, { copyId: a.id, borrower: '甲', dueDate: '2026-01-01' });
      await loanOut(db, { copyId: b.id, borrower: '乙', dueDate: '' });

      assert.equal((await getStats(db, '2026-06-01')).overdueLoans, 1);
      assert.equal((await getStats(db, '2025-01-01')).overdueLoans, 0, '按参考日期判断');
    });
  });

  it('归还后不再计入在借', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id });
      await loanOut(db, { copyId: copy.id, borrower: '甲' });
      await returnCopy(db, { copyId: copy.id });

      const stats = await getStats(db);
      assert.equal(stats.activeLoans, 0);
      assert.equal(stats.onShelf, 1);
    });
  });

  it('位置统计同时给直接数与子树数', async () => {
    await withDb(async (db) => {
      const home = await createLocation(db, { name: '家' });
      const living = await createLocation(db, { name: '客厅', parentId: home.id });
      const shelf = await createLocation(db, { name: '书架', parentId: living.id });
      const book = await createBook(db, { title: '书' });
      await createCopy(db, { bookId: book.id, locationId: shelf.id });
      await createCopy(db, { bookId: book.id, locationId: living.id });

      const stats = await getCopiesByLocation(db);
      const byId = new Map(stats.map((s) => [s.locationId, s]));
      assert.deepEqual(
        { direct: byId.get(living.id)?.direct, subtree: byId.get(living.id)?.subtree },
        { direct: 1, subtree: 2 },
      );
      assert.equal(byId.get(home.id)?.subtree, 2, '问「家有几本」要算上子孙');
      assert.equal(byId.get(shelf.id)?.subtree, 1);
    });
  });

  it('computeSubtreeCounts 在环上终止且不把错值当事实缓存', () => {
    const counts = computeSubtreeCounts(
      [
        { id: 'x', parentId: 'y' },
        { id: 'y', parentId: 'x' },
        { id: 'z', parentId: null },
      ],
      ['z', 'z'],
    );
    assert.equal(counts.get('z'), 2);
    assert.ok(Number.isFinite(counts.get('x') ?? Number.NaN), '环上必须给出有限值');
  });

  it('重复书目：同 ISBN 分到一组，书名相同但 ISBN 不同的报「疑似」', async () => {
    await withDb(async (db) => {
      // 同一个 ISBN 被建了两次（导入后可能出现）
      const a1 = await createBook(db, { title: '活着', isbn: '9787506365437' });
      const a2 = await createBook(db, { title: '活着', isbn: '978-7-5063-6543-7' });
      // 同名，但两本书的 ISBN 不同 —— 不算真重复，归为「疑似」
      const b1 = await createBook(db, { title: '三体', isbn: '9787536692930' });
      const b2 = await createBook(db, { title: '三体', isbn: '9787020002207' });
      await createBook(db, { title: '无关的书', isbn: '9787111544937' });

      const report = await getDuplicateBooks(db);
      assert.equal(report.byIsbn.length, 1);
      assert.deepEqual(report.byIsbn[0]?.map((x) => x.id).sort(), [a1.id, a2.id].sort());
      assert.equal(report.suspectedByTitle.length, 1, '「活着」那组已有 byIsbn 结论，不应在疑似里再报一次');
      assert.deepEqual(report.suspectedByTitle[0]?.map((x) => x.id).sort(), [b1.id, b2.id].sort());
    });
  });

  it('无 ISBN 的同名书列为「疑似」 —— 中文书缺号常见，让用户自己判断', async () => {
    await withDb(async (db) => {
      await createBook(db, { title: '无号书' });
      await createBook(db, { title: '无号书' });

      const report = await getDuplicateBooks(db);
      assert.deepEqual(report.byIsbn, [], '空 ISBN 不能被当成"同一个 ISBN"');
      assert.equal(report.suspectedByTitle.length, 1);
      assert.equal(report.suspectedByTitle[0]?.length, 2);
    });
  });

  it('没有重复时报告为空数组而不是 undefined', async () => {
    await withDb(async (db) => {
      await createBook(db, { title: '独一无二', isbn: '9787111544937' });
      const report = await getDuplicateBooks(db);
      assert.deepEqual(report.byIsbn, []);
      assert.deepEqual(report.suspectedByTitle, []);
    });
  });
});
