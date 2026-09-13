import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SCHEMA_VERSION } from '../db/schema.ts';
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  createWarningCollector,
  deepEqual,
  parseBackup,
  serializeBackup,
  unionSorted,
  type BackupData,
  type BackupFile,
} from './format.ts';

const STAMP = '2026-01-01T00:00:00.000Z';

/** 造一份最小可用的备份文本；data 段可局部覆盖。 */
function backupText(
  data: Partial<BackupData> = {},
  top: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: STAMP,
    deviceName: '测试机',
    counts: { locations: 0, books: 0, copies: 0, loans: 0 },
    data: { locations: [], books: [], copies: [], loans: [], ...data },
    ...top,
  });
}

function parseOk(text: string): BackupFile {
  const result = parseBackup(text);
  if (!result.ok) throw new Error(`备份文本本应解析成功：${result.error}`);
  return result.backup;
}

describe('备份文件解析（03 §3）', () => {
  it('解析失败返回错误说明，绝不抛异常', () => {
    for (const text of ['', '{', '不是 JSON', '[]', 'null', '"字符串"', '123']) {
      const result = parseBackup(text);
      assert.equal(result.ok, false, `输入 ${JSON.stringify(text)} 不应解析成功`);
      assert.equal(typeof (result as { error: string }).error, 'string');
    }
  });

  it('拒绝非本 App 的 JSON', () => {
    const result = parseBackup(JSON.stringify({ format: '别的备份', formatVersion: 1, schemaVersion: 1 }));
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /不是掌上图书馆/);
  });

  it('格式版本或数据版本比本机新时拒绝导入，而不是猜着读', () => {
    const newerFormat = parseBackup(backupText({}, { formatVersion: BACKUP_FORMAT_VERSION + 1 }));
    assert.equal(newerFormat.ok, false);
    assert.match((newerFormat as { error: string }).error, /请先升级 App/);

    const newerSchema = parseBackup(backupText({}, { schemaVersion: SCHEMA_VERSION + 1 }));
    assert.equal(newerSchema.ok, false);
    assert.match((newerSchema as { error: string }).error, /请先升级 App/);
  });

  it('缺版本号 / 缺数据段都被拒绝', () => {
    assert.equal(parseBackup(backupText({}, { formatVersion: undefined })).ok, false);
    assert.equal(parseBackup(backupText({}, { schemaVersion: undefined })).ok, false);
    assert.equal(parseBackup(backupText({}, { data: null })).ok, false);
  });

  it('清洗：未知字段一律丢弃，只保留显式清单里的字段（宽进严出）', () => {
    const backup = parseOk(
      backupText({
        books: [
          {
            id: 'b1',
            title: '书',
            isbn: '9787111544937',
            authors: ['甲'],
            tags: ['t'],
            未知字段: '不该留下',
          } as never,
        ],
      }),
    );
    const book = backup.data.books[0];
    assert.deepEqual(Object.keys(book ?? {}).sort(), [
      'authors',
      'coverUrl',
      'createdAt',
      'id',
      'isbn',
      'publishDate',
      'publisher',
      'tags',
      'title',
      'updatedAt',
    ]);
  });

  it('清洗：缺 id / 缺 bookId 的记录被丢弃并留下警告，而不是静默消失', () => {
    const result = parseBackup(
      backupText({
        books: [{ title: '没有 id 的书' } as never],
        copies: [{ id: 'c1', bookId: '', locationId: 'x' } as never],
      }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.backup.data.books.length, 0);
    assert.equal(result.backup.data.copies.length, 0);
    assert.ok(result.warnings.some((w) => w.includes('书目记录缺少 id')));
    assert.ok(result.warnings.some((w) => w.includes('缺少 bookId')));
  });

  it('清洗：非法枚举值回落到安全默认值', () => {
    const backup = parseOk(
      backupText({
        copies: [
          {
            id: 'c1',
            bookId: 'b1',
            locationId: 'l1',
            status: '在半空',
            condition: '崭新',
          } as never,
        ],
      }),
    );
    assert.equal(backup.data.copies[0]?.status, 'on_shelf');
    assert.equal(backup.data.copies[0]?.condition, 'unknown');
  });

  it('清洗：日期字段不合法就留空（坏日期会毁掉逾期判断）', () => {
    const backup = parseOk(
      backupText({
        loans: [
          {
            id: 'l1',
            copyId: 'c1',
            borrower: '小王',
            loanDate: '2026-02-30',
            dueDate: '昨天',
            returnDate: '',
            status: 'active',
          } as never,
        ],
      }),
    );
    const loan = backup.data.loans[0];
    assert.equal(loan?.loanDate, '');
    assert.equal(loan?.dueDate, '');
    assert.equal(loan?.status, 'active');
  });

  it('清洗：缺字段一律补默认值，并且逐字段留下警告（T10）', () => {
    const result = parseBackup(
      backupText({
        books: [{ id: 'b1', title: '书' } as never],
        copies: [{ id: 'c1', bookId: 'b1' } as never],
        loans: [{ id: 'l1', copyId: 'c1' } as never],
      }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const bk = result.backup.data.books[0];
    assert.equal(bk?.createdAt, STAMP);
    assert.equal(bk?.updatedAt, STAMP);
    assert.equal(bk?.publisher, '');
    assert.equal(bk?.isbn, '');
    assert.deepEqual(bk?.tags, []);
    assert.deepEqual(bk?.authors, []);
    assert.equal(result.backup.data.copies[0]?.status, 'on_shelf');
    assert.equal(result.backup.data.loans[0]?.borrower, '');

    // 03 §3.1 / §7：补了默认值就必须说清「哪一条、哪个字段、补成了什么」，
    // 手改过文件的用户否则无从得知自己写的内容被静默改名。
    for (const expected of [
      '书目 b1 缺少字段 publisher，已按空串导入',
      '书目 b1 缺少字段 tags，已按空数组导入',
      '书目 b1 缺少字段 authors，已按空数组导入',
      '书目 b1 的 createdAt 缺失或不是时间戳',
      '书目 b1 的 updatedAt 缺失或不是时间戳',
      '副本 c1 缺少字段 owner，已按空串导入',
      '副本 c1 缺少字段 status，已按默认值（on_shelf）导入',
      '借出记录 l1 缺少字段 borrower，已按空串导入',
      '借出记录 l1 缺少字段 loanDate，已按空日期导入',
    ]) {
      assert.ok(result.warnings.some((w) => w.includes(expected)), `缺少提示：${expected}`);
    }
  });

  it('字段齐全的记录不产生任何提示 —— 警告列表不能被正常文件刷屏', () => {
    const location: BackupData['locations'][number] = {
      id: 'l1', parentId: null, name: '家', path: '家', depth: 0, type: 'home', sortOrder: 0,
      createdAt: STAMP, updatedAt: STAMP,
    };
    const book: BackupData['books'][number] = {
      id: 'b1', isbn: '9787020002207', title: '活着', authors: ['余华'], publisher: '作家出版社',
      publishDate: '2012-08', coverUrl: '', tags: ['小说'], createdAt: STAMP, updatedAt: STAMP,
    };
    const copy: BackupData['copies'][number] = {
      id: 'c1', bookId: 'b1', locationId: 'l1', status: 'on_shelf', condition: 'good',
      owner: '', note: '', createdAt: STAMP, updatedAt: STAMP,
    };
    const loan: BackupData['loans'][number] = {
      id: 'x1', copyId: 'c1', borrower: '小王', contact: '', loanDate: '2026-01-01', dueDate: '',
      returnDate: '', status: 'active', note: '', createdAt: STAMP, updatedAt: STAMP,
    };

    const result = parseBackup(
      backupText({ locations: [location], books: [book], copies: [copy], loans: [loan] }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.warnings, []);
  });

  it('声明的 counts 与内容不符时警告，但以内容为准', () => {
    const result = parseBackup(
      backupText({ books: [{ id: 'b1', title: '书' } as never] }, { counts: { locations: 0, books: 99, copies: 0, loans: 0 } }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.backup.data.books.length, 1);
    assert.ok(result.warnings.some((w) => w.includes('books') && w.includes('99')));
    assert.deepEqual(result.backup.counts, { locations: 0, books: 1, copies: 0, loans: 0, borrowers: 0, covers: 0 });
  });

  it('缺失的数据段按空列表处理并警告', () => {
    const result = parseBackup(backupText({ locations: undefined as never }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.backup.data.locations, []);
    assert.ok(result.warnings.some((w) => w.includes('缺少 locations')));
  });

  it('封面段：老文件没有 covers 段 → 视为空数组且不警告（03 §3.1）', () => {
    const result = parseBackup(backupText({}));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.backup.data.covers, []);
    assert.equal(result.backup.counts.covers, 0);
    assert.deepEqual(result.warnings, [], '缺 covers 段是早期版本文件的正常形态，不是损坏');
  });

  it('封面段：只留显式字段；缺 bookId 或缺图片数据的记录丢弃并说清原因', () => {
    const result = parseBackup(
      backupText({
        covers: [
          {
            bookId: 'b1',
            mime: 'image/jpeg',
            dataUrl: 'data:image/jpeg;base64,AQID',
            createdAt: STAMP,
            updatedAt: STAMP,
            未知字段: '不该留下',
          } as never,
          { mime: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,AQID' } as never,
          // 图片本身就是这条记录的全部内容，没有「默认值」可补 —— 宁可报告也不造假图（§3.1）
          { bookId: 'b3', dataUrl: '这不是 data URL' } as never,
        ],
      }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(result.backup.data.covers.length, 1);
    const cover = result.backup.data.covers[0];
    assert.equal(cover?.bookId, 'b1');
    assert.equal(cover?.dataUrl, 'data:image/jpeg;base64,AQID');
    assert.deepEqual(Object.keys(cover ?? {}).sort(), ['bookId', 'createdAt', 'dataUrl', 'mime', 'updatedAt']);
    assert.ok(result.warnings.some((w) => w.includes('缺少 bookId')));
    assert.ok(result.warnings.some((w) => w.includes('图片数据') && w.includes('b3')));
  });

  it('封面段：mime 缺失按 image/jpeg 补齐，时间戳缺失用导出时间兜底，两者都要提示', () => {
    const result = parseBackup(
      backupText({ covers: [{ bookId: 'b1', dataUrl: 'data:image/jpeg;base64,AQID' } as never] }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.backup.data.covers[0]?.mime, 'image/jpeg');
    assert.equal(result.backup.data.covers[0]?.createdAt, STAMP);
    for (const expected of ['封面（书目 b1） 缺少字段 mime', 'createdAt 缺失或不是时间戳', 'updatedAt 缺失或不是时间戳']) {
      assert.ok(result.warnings.some((w) => w.includes(expected)), `缺少提示：${expected}`);
    }
  });

  it('序列化：封面按 bookId 升序，往返逐字节一致', () => {
    const wire = (bookId: string, payload: string): never =>
      ({
        bookId,
        mime: 'image/jpeg',
        dataUrl: `data:image/jpeg;base64,${payload}`,
        createdAt: STAMP,
        updatedAt: STAMP,
      }) as never;
    const backup = parseOk(backupText({ covers: [wire('b2', 'AgID'), wire('b1', 'AQID')] }));

    assert.deepEqual(
      backup.data.covers.map((c) => c.bookId),
      ['b2', 'b1'],
      '解析保持文件里的顺序，重排只发生在序列化时',
    );
    const once = serializeBackup(backup);
    const shuffled: BackupFile = {
      ...backup,
      data: { ...backup.data, covers: [...backup.data.covers].reverse() },
    };
    assert.equal(serializeBackup(shuffled), once, '同一份数据的导出结果与数组顺序无关');
    assert.deepEqual(parseOk(once).data.covers.map((c) => c.bookId), ['b1', 'b2']);
    assert.equal(serializeBackup(parseOk(once)), once, '往返后再导出必须字节完全相同');
  });

  it('序列化稳定：同一份数据两次导出字节一致，且与数组顺序无关', () => {
    const backup = parseOk(
      backupText({
        books: [
          { id: 'b2', title: '乙' } as never,
          { id: 'b1', title: '甲' } as never,
        ],
      }),
    );
    const once = serializeBackup(backup);
    const shuffled: BackupFile = {
      ...backup,
      data: { ...backup.data, books: [...backup.data.books].reverse() },
    };
    assert.equal(serializeBackup(shuffled), once);

    const reparsed = parseOk(once);
    // 导出会按 id 升序重排数组（03 §3.2），所以只能按 id 对齐后逐条比较，
    // 不能按位置 deepEqual —— 那份“顺序变了”正是稳定序列化的设计意图。
    const byId = (rows: readonly { id: string }[]): { id: string }[] =>
      [...rows].sort((a, b) => a.id.localeCompare(b.id));
    for (const key of ['locations', 'books', 'copies', 'loans'] as const) {
      assert.deepEqual(byId(reparsed.data[key]), byId(backup.data[key]), `${key} 往返后必须逐条一致`);
    }
    // 更强的一条：往返后再次导出必须与首次字节完全相同 —— 既没丢字段，也没被重新排出新结果。
    assert.equal(serializeBackup(reparsed), once);
  });
});

describe('合并用的比较工具（03 §5.1）', () => {
  it('deepEqual 认得嵌套结构与键数差异', () => {
    assert.equal(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), true);
    assert.equal(deepEqual({ a: 1 }, { a: 1, b: 2 }), false);
    assert.equal(deepEqual({ a: [1] }, { a: [1, 2] }), false);
    assert.equal(deepEqual(null, {}), false);
    assert.equal(deepEqual(null, null), true);
    assert.equal(deepEqual([], {}), false);
  });

  it('unionSorted 取并集、去空、稳定排序', () => {
    assert.deepEqual(unionSorted(['b', 'a'], ['c', 'a']), ['a', 'b', 'c']);
    assert.deepEqual(unionSorted([''], []), []);
    assert.deepEqual(unionSorted([], ['x']), ['x']);
  });

  it('警告收集器去重并封顶，避免一个坏文件刷出上千行', () => {
    const collector = createWarningCollector(['初始']);
    collector.add('初始');
    collector.add('重复项');
    collector.add('重复项');
    for (let i = 0; i < 500; i++) collector.add(`问题 ${i}`);

    const list = collector.list();
    assert.equal(list[0], '初始');
    assert.ok(list.length <= 202, `实际 ${list.length} 条`);
    assert.ok(list[list.length - 1]?.includes('被省略'));
  });
});
