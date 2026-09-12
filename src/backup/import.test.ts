import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UNSORTED_LOCATION_ID, newId } from '../domain/ids.ts';
import type { Book, Copy, Loan, Location } from '../domain/types.ts';
import { createBook } from '../db/books.ts';
import { createCopy, getCopy } from '../db/copies.ts';
import { createLocation } from '../db/locations.ts';
import { loanOut, returnCopy } from '../db/loans.ts';
import { checkInvariants } from '../db/repair.ts';
import type { PocketLibraryDb } from '../db/schema.ts';
import { dump, snapshot, withDb, withRawDb } from '../testing/harness.ts';
import { buildBackup, exportToJson } from './export.ts';
import { parseBackup, type BackupFile, type ImportSummary } from './format.ts';
import { applyImport, importFromText, previewImport } from './import.ts';

/**
 * 时间戳全部写死，不用 nowIso()：
 * 合并规则是"后写覆盖"，靠真实时间差会让用例随运行时刻漂移。
 */
const STAMP = '2026-01-01T00:00:00.000Z';
const LATER = '2026-06-01T00:00:00.000Z';

/* 手工造备份内容：模拟"朋友那台机器"导出的文件 */

function loc(id: string, parentId: string | null, name: string, updatedAt = STAMP): Location {
  return {
    id,
    parentId,
    name,
    path: '',
    depth: 0,
    type: 'home',
    sortOrder: 0,
    createdAt: STAMP,
    updatedAt,
  };
}

function book(id: string, title: string, isbn = '', updatedAt = STAMP, tags: string[] = []): Book {
  return {
    id,
    isbn,
    title,
    authors: [],
    publisher: '',
    publishDate: '',
    coverUrl: '',
    tags,
    createdAt: STAMP,
    updatedAt,
  };
}

function copy(id: string, bookId: string, locationId: string, updatedAt = STAMP): Copy {
  return {
    id,
    bookId,
    locationId,
    status: 'on_shelf',
    condition: 'unknown',
    owner: '',
    note: '',
    createdAt: STAMP,
    updatedAt,
  };
}

function loan(id: string, copyId: string, borrower: string, extra: Partial<Loan> = {}): Loan {
  return {
    id,
    copyId,
    borrower,
    contact: '',
    loanDate: '2026-01-01',
    dueDate: '',
    returnDate: '',
    status: 'active',
    note: '',
    createdAt: STAMP,
    updatedAt: STAMP,
    ...extra,
  };
}

interface FileData {
  locations?: Location[];
  books?: Book[];
  copies?: Copy[];
  loans?: Loan[];
}

function fileOf(data: FileData, top: Record<string, unknown> = {}): BackupFile {
  const text = JSON.stringify({
    format: 'pocket-library-backup',
    formatVersion: 1,
    schemaVersion: 1,
    exportedAt: STAMP,
    deviceName: '朋友的手机',
    counts: { locations: 0, books: 0, copies: 0, loans: 0 },
    data: { locations: [], books: [], copies: [], loans: [], ...data },
    ...top,
  });
  return parseOk(text);
}

function parseOk(text: string): BackupFile {
  const parsed = parseBackup(text);
  if (!parsed.ok) throw new Error(`备份文本本应解析成功：${parsed.error}`);
  return parsed.backup;
}

/** 只看计数，忽略 warnings / durationMs。 */
function counts(summary: ImportSummary): Record<string, unknown> {
  return { locations: summary.locations, books: summary.books, copies: summary.copies, loans: summary.loans };
}

const NOTHING_CHANGED = {
  locations: { inserted: 0, updated: 0, reparented: 0, conflictingNames: [] },
  books: { inserted: 0, updated: 0, mergedByIsbn: 0 },
  copies: { inserted: 0, updated: 0, skipped: 0, relocated: 0 },
  loans: { inserted: 0, updated: 0, skipped: 0, conflicts: 0 },
};

describe('导入：字段级合并规则（03 §5.1）', () => {
  it('同一本书两处各有一本：书目合成一条，两本实体书各自保留', async () => {
    const isbn = '9787111544937';
    const myId = newId();
    const friendId = newId();

    await withDb(async (target) => {
      await target.books.put(book(myId, '深入理解计算机系统', isbn, STAMP));
      await createCopy(target, { bookId: myId });

      const summary = await applyImport(
        target,
        fileOf({
          books: [book(friendId, '深入理解计算机系统（第3版）', isbn, LATER)],
          copies: [copy('friend-copy', friendId, UNSORTED_LOCATION_ID)],
        }),
      );

      assert.equal(await target.books.count(), 1, '同一 ISBN 必须合成一条书目');
      assert.equal(await target.copies.count(), 2, '两本实体书必须各自保留');
      assert.equal(summary.books.mergedByIsbn, 1);
      assert.equal(summary.books.inserted, 0);
      assert.equal(await target.books.get(friendId), undefined, '对方的书目记录不得作为第二条留下');

      for (const row of await target.copies.toArray()) {
        assert.equal(row.bookId, myId, '两条副本都要指向本地那条书目');
      }
      assert.equal((await target.books.get(myId))?.title, '深入理解计算机系统（第3版）', '对方改过，以对方为准');
      assert.equal((await target.books.get(myId))?.createdAt, STAMP, 'createdAt 取较早者');
    });
  });

  it('对方没改过的记录不会被覆盖', async () => {
    const id = newId();
    await withDb(async (target) => {
      await target.books.put(book(id, '本地书名', '', LATER));

      const summary = await applyImport(target, fileOf({ books: [book(id, '对方旧书名', '', STAMP)] }));
      assert.equal((await target.books.get(id))?.title, '本地书名');
      assert.equal(summary.books.updated, 0);
    });
  });

  it('标签取并集 —— 导入绝不能让人丢标签', async () => {
    const id = newId();
    await withDb(async (target) => {
      await target.books.put(book(id, '书', '', STAMP, ['计算机']));

      const summary = await applyImport(target, fileOf({ books: [book(id, '书', '', STAMP, ['教材'])] }));
      const tags = (await target.books.get(id))?.tags ?? [];
      assert.deepEqual([...tags].sort(), ['教材', '计算机'].sort());
      assert.equal(summary.books.updated, 1);
    });
  });

  it('导入不会删除本地独有的数据（合并 ≠ 覆盖）', async () => {
    await withDb(async (target) => {
      const mine = newId();
      await target.books.put(book(mine, '只有我有的书', '9787536692930'));
      await createCopy(target, { bookId: mine });

      await applyImport(target, fileOf({ books: [book('friend-book', '朋友的书', '9787020002207')] }));

      assert.equal(await target.books.count(), 2);
      assert.notEqual(await target.books.get(mine), undefined);
    });
  });

  it('覆盖模式先清空本地数据（所以 UI 必须先提醒导出备份）', async () => {
    const mine = newId();
    await withDb(async (target) => {
      await target.books.put(book(mine, '本地书'));
      await createCopy(target, { bookId: mine });

      await applyImport(target, fileOf({ books: [book('friend-book', '朋友的书')] }), { mode: 'replace' });

      assert.equal(await target.books.count(), 1);
      assert.equal(await target.books.get(mine), undefined, '本地数据应被清掉');
      assert.equal(await target.copies.count(), 0);
      assert.notEqual(await target.locations.get(UNSORTED_LOCATION_ID), undefined, '清空后必须重新播种「未分类」');
    });
  });
});

describe('导入：位置的兜底规则（03 §4.1）', () => {
  it('副本位置在本地和文件里都不存在 → 改为「未分类」并说明原因', async () => {
    await withDb(async (target) => {
      const summary = await applyImport(
        target,
        fileOf({
          books: [book('friend-book', '书')],
          copies: [copy('friend-copy', 'friend-book', '查无此位置')],
        }),
      );

      assert.equal(summary.copies.relocated, 1);
      assert.equal((await target.copies.get('friend-copy'))?.locationId, UNSORTED_LOCATION_ID);
      assert.ok(summary.warnings.some((w) => w.includes('未分类')), '必须说明去了哪儿，不能静默改');
    });
  });

  it('上级位置在本地不存在 → 挂到「未分类」并提示', async () => {
    await withDb(async (target) => {
      const summary = await applyImport(target, fileOf({ locations: [loc('shelf', '不存在的上级家', '白书架A')] }));

      assert.equal(summary.locations.reparented, 1);
      assert.equal((await target.locations.get('shelf'))?.parentId, UNSORTED_LOCATION_ID);
      assert.ok(summary.warnings.some((w) => w.includes('白书架A')));
    });
  });

  it('父节点在数组里排后面也能正确挂上（不能只扫一遍就下结论）', async () => {
    await withDb(async (target) => {
      const summary = await applyImport(
        target,
        fileOf({ locations: [loc('child', 'parent', '第1层'), loc('parent', null, '白书架A')] }),
      );

      assert.equal(summary.locations.reparented, 0, '父节点就在文件里，不该被当成孤儿');
      assert.equal((await target.locations.get('child'))?.parentId, 'parent');
      assert.equal((await target.locations.get('child'))?.path, '白书架A / 第1层');
    });
  });

  it('文件里的位置成环（A→B→A）不挂死：环被打断并留下警告（T8）', async () => {
    await withDb(async (target) => {
      const summary = await applyImport(
        target,
        fileOf({ locations: [loc('a', 'b', '甲'), loc('b', 'a', '乙')] }),
      );

      // 打断环靠的是「把环里某一条挂到未分类」，不能靠丢数据，所以两条都得留下。
      const a = await target.locations.get('a');
      const b = await target.locations.get('b');
      assert.ok(a !== undefined && b !== undefined, '环里的位置不能消失');
      assert.equal(a.parentId, UNSORTED_LOCATION_ID);
      assert.equal(b.parentId, 'a');
      assert.equal(a.path, '未分类 / 甲');
      assert.equal(b.path, '未分类 / 甲 / 乙');
      assert.ok(
        summary.warnings.some((w) => w.includes('循环引用')),
        '环被打断了就必须告诉用户，否则用户看到的位置层级是凭空变的',
      );
    });
  });

  it('文件里的「未分类」不会被改成别的父节点', async () => {
    await withDb(async (target) => {
      await applyImport(target, fileOf({ locations: [loc(UNSORTED_LOCATION_ID, '某个位置', '未分类')] }));
      assert.equal((await target.locations.get(UNSORTED_LOCATION_ID))?.parentId, null);
    });
  });

  it('同名位置记为「名字冲突」，交给用户事后处理，不擅自合并', async () => {
    await withDb(async (target) => {
      await createLocation(target, { name: '客厅' });
      const summary = await applyImport(target, fileOf({ locations: [loc('theirs', null, '客厅')] }));

      assert.deepEqual(summary.locations.conflictingNames, ['客厅']);
      assert.equal(await target.locations.count(), 3, '「未分类」+ 我的客厅 + 对方的客厅');
    });
  });
});

describe('导入：借出记录（03 §5.2、决策 D6）', () => {
  it('历史记录直接插入', async () => {
    await withDb(async (target) => {
      const summary = await applyImport(
        target,
        fileOf({
          books: [book('friend-book', '书')],
          copies: [copy('c1', 'friend-book', UNSORTED_LOCATION_ID)],
          loans: [loan('old-loan', 'c1', '小王', { status: 'returned', returnDate: '2026-02-01' })],
        }),
      );

      assert.equal(summary.loans.inserted, 1);
      assert.equal(summary.loans.conflicts, 0);
      assert.equal((await target.loans.get('old-loan'))?.status, 'returned');
    });
  });

  it('同一本书两边都借出去了：本地保持借出，对方那条转已归还并说明原因', async () => {
    const bkId = newId();
    const cpId = newId();
    await withDb(async (target) => {
      await target.books.put(book(bkId, '活着'));
      await target.copies.put(copy(cpId, bkId, UNSORTED_LOCATION_ID));
      await loanOut(target, { copyId: cpId, borrower: '我借给了小王', loanDate: '2026-01-05' });

      const summary = await applyImport(
        target,
        fileOf({
          books: [book(bkId, '活着')],
          copies: [copy(cpId, bkId, UNSORTED_LOCATION_ID)],
          loans: [loan('friend-loan', cpId, '小李', { loanDate: '2026-02-01' })],
        }),
      );

      const friendLoan = await target.loans.get('friend-loan');
      assert.equal(summary.loans.conflicts, 1);
      assert.equal(friendLoan?.status, 'returned', '冲突的导入记录转历史，不删除');
      assert.equal(friendLoan?.returnDate, '2026-01-05');
      assert.ok((friendLoan?.note ?? '').includes('导入冲突'));
      assert.equal((await getCopy(target, cpId))?.status, 'lent_out', '本地借出记录仍然有效');
      assert.equal((await target.loans.toArray()).filter((l) => l.status === 'active').length, 1);
      assert.ok(summary.warnings.some((w) => w.includes('活着') && w.includes('小王')));
    });
  });

  it('副本不存在时跳过借出记录并说明，不留孤儿数据', async () => {
    await withDb(async (target) => {
      const summary = await applyImport(target, fileOf({ loans: [loan('orphan-loan', '查无此副本', '小王')] }));
      assert.equal(summary.loans.skipped, 1);
      assert.equal(await target.loans.count(), 0);
      assert.ok(summary.warnings.some((w) => w.includes('小王')));
    });
  });
});

describe('导入：空库导入完整备份（03 §10 T1）', () => {
  it('空库导入完整备份：四张表计数与文件一致，「未分类」存在', async () => {
    const file = fileOf({
      locations: [loc('home', null, '家'), loc('shelf', 'home', '白书架')],
      books: [book('b1', '活着', '9787020002207')],
      copies: [copy('c1', 'b1', 'shelf'), copy('c2', 'b1', 'home')],
      loans: [loan('l1', 'c1', '小王')],
    });

    // 真正的空库：连「未分类」都没有，靠导入自己补上（§4.1）
    await withRawDb(async (target) => {
      const summary = await applyImport(target, file);

      assert.equal(summary.locations.inserted, 2);
      assert.equal(summary.books.inserted, 1);
      assert.equal(summary.copies.inserted, 2);
      assert.equal(summary.loans.inserted, 1);

      assert.equal(await target.locations.count(), 3, '两条位置 + 补种出来的「未分类」');
      assert.equal(await target.books.count(), 1);
      assert.equal(await target.copies.count(), 2);
      assert.equal(await target.loans.count(), 1);
      assert.notEqual(await target.locations.get(UNSORTED_LOCATION_ID), undefined, '导入必须自己保证「未分类」存在');
    });
  });
});

describe('导入：手改过的备份文件（03 §3.1、T10）', () => {
  it('缺字段的文件照样能导入：补默认值，并把补了哪条哪个字段写进摘要', async () => {
    await withDb(async (target) => {
      const result = await importFromText(
        target,
        JSON.stringify({
          format: 'pocket-library-backup',
          formatVersion: 1,
          schemaVersion: 1,
          exportedAt: STAMP,
          deviceName: '朋友的手机',
          counts: { locations: 0, books: 0, copies: 0, loans: 0 },
          data: { books: [{ id: 'friend-book', title: '活着' }] },
        }),
      );

      assert.equal(result.ok, true, '手改过的文件不该被拒之门外（宽进）');
      if (!result.ok) return;

      const imported = await target.books.get('friend-book');
      assert.equal(imported?.title, '活着');
      assert.equal(imported?.publisher, '');
      assert.deepEqual(imported?.tags, []);
      assert.equal(result.summary.books.inserted, 1);

      // 解析阶段的警告必须并入摘要 —— 否则 UI 只拿到「成功导入 1 条」，
      // 用户永远不知道有字段被补成了空值。
      for (const expected of ['缺少字段 publisher', '缺少字段 tags', 'createdAt 缺失或不是时间戳']) {
        assert.ok(
          result.summary.warnings.some((w) => w.includes(expected)),
          `补了默认值就必须让用户看得见，缺少提示「${expected}」`,
        );
      }
    });
  });
});

describe('导入：幂等与原子性（03 §7、§8）', () => {
  it('同一个文件连导两次，第二次必须一个字都不改', async () => {
    await withDb(async (target) => {
      await withDb(async (source) => {
        const home = await createLocation(source, { name: '家' });
        const shelf = await createLocation(source, { name: '书架', parentId: home.id });
        const bk = await createBookWith(source, '书', '9787111544937');
        const cp = await createCopy(source, { bookId: bk, locationId: shelf.id });

        await loanOut(source, { copyId: cp.id, borrower: '小王' });
        await returnCopy(source, { copyId: cp.id, returnDate: '2026-01-20' });
        await loanOut(source, { copyId: cp.id, borrower: '小李' });
        await createCopy(source, { bookId: bk, locationId: UNSORTED_LOCATION_ID });

        const file = await buildBackup(source);
        const first = await applyImport(target, file);
        assert.equal(first.books.inserted, 1);
        assert.equal(first.copies.inserted, 2);
        assert.equal(first.loans.inserted, 2);
        assert.equal(first.copies.skipped, 0);

        const before = snapshot(await dump(target));
        const second = await applyImport(target, file);

        assert.deepEqual(counts(second), NOTHING_CHANGED, '第二次导入不得产生任何写入');
        assert.equal(snapshot(await dump(target)), before, '数据库内容必须逐字节一致');
        assert.deepEqual(second.warnings, []);
      });
    });
  });

  it('导出再导入自己不改变任何东西（幂等性的另一半）', async () => {
    await withDb(async (db) => {
      const home = await createLocation(db, { name: '家' });
      const bk = await createBookWith(db, '书', '9787506365437');
      const cp = await createCopy(db, { bookId: bk, locationId: home.id });
      await loanOut(db, { copyId: cp.id, borrower: '小王' });

      const before = snapshot(await dump(db));
      await applyImport(db, parseOk(await exportToJson(db)));
      assert.equal(snapshot(await dump(db)), before);
    });
  });

  it('预览：完整跑一遍再回滚，数据库纹丝不动', async () => {
    await withDb(async (target) => {
      const before = snapshot(await dump(target));
      const summary = await previewImport(target, fileOf({ books: [book('friend-book', '朋友的书')] }));

      assert.equal(summary.dryRun, true);
      assert.equal(summary.books.inserted, 1, '预览要给出真实的变更数量');
      assert.equal(snapshot(await dump(target)), before, '预览不得留下任何痕迹');
      assert.equal(await target.books.count(), 0);
    });
  });

  it('中途出错整体回滚：宁可没导入，也不留半套数据', async () => {
    const mine = newId();
    await withDb(async (target) => {
      await target.books.put(book(mine, '本地书'));
      await createCopy(target, { bookId: mine });
      const before = snapshot(await dump(target));

      const broken = fileOf({
        books: [book('friend-book', '朋友的书')],
        copies: [copy('friend-copy', 'friend-book', UNSORTED_LOCATION_ID)],
      });
      // 绕过清洗层，模拟合并途中出现意料之外的数据
      const hostile = { ...broken, data: { ...broken.data, copies: [null] } } as unknown as BackupFile;

      await assert.rejects(() => applyImport(target, hostile));
      assert.equal(snapshot(await dump(target)), before, '失败的导入必须完全回滚');
    });
  });

  it('importFromText 对坏文件返回错误而不是抛异常', async () => {
    await withDb(async (db) => {
      const result = await importFromText(db, '这不是 JSON');
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.error, /不是合法的 JSON/);
    });
  });

  it('importFromText 的 dryRun 选项走预览分支', async () => {
    await withDb(async (db) => {
      const result = await importFromText(db, JSON.stringify({
        format: 'pocket-library-backup',
        formatVersion: 1,
        schemaVersion: 1,
        exportedAt: STAMP,
        data: { books: [book('b1', '书')] },
      }), { dryRun: true });

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.summary.dryRun, true);
      assert.equal(await db.books.count(), 0);
    });
  });

  it('导入后不变式全部成立 —— 脏数据在入口就被兜住', async () => {
    await withDb(async (target) => {
      await applyImport(
        target,
        fileOf({
          locations: [loc('orphan', '不存在的上级', '游离架')],
          books: [book('friend-book', '书')],
          copies: [copy('c1', 'friend-book', '查无此位置'), copy('c2', '查无此书', '查无此位置')],
          loans: [loan('l1', 'c1', '小王')],
        }),
      );

      const check = await checkInvariants(target);
      assert.equal(check.ok, true, check.problems.join('; '));
    });
  });
});

/** createBook 用的是真实时间，这里只关心「有没有变」，不关心具体值。 */
async function createBookWith(db: PocketLibraryDb, title: string, isbn: string): Promise<string> {
  return (await createBook(db, { title, isbn })).id;
}
