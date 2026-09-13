import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { withDb } from '../../testing/harness.ts';
import { findBooksByIsbn, listBooks } from '../../db/books.ts';
import { listLocations } from '../../db/locations.ts';
import { UNSORTED_LOCATION_ID } from '../../domain/ids.ts';
import { parsePasteText, parseCsvText, parseTextFile, parseJsonFile, sourceFromJson, bulkImportBooks, parseCsvLine, type ParsedBookRow } from './import.ts';
import { MAX_INITIAL_COUNT } from './write.ts';

describe('粘贴解析（05 §2.1）', () => {
  it('支持三种形态：书名 / 书名,作者 / 书名,作者,ISBN（全角半角逗号都行）', () => {
    const rows = parsePasteText('红楼梦\n活着，余华\n三体，刘慈欣，9787536692930\n');
    assert.equal(rows.length, 3);
    assert.equal(rows[0]?.title, '红楼梦');
    assert.equal(rows[1]?.author, '余华');
    assert.equal(rows[2]?.isbn, '9787536692930');
  });

  it('纯 ISBN 行识别为 isbn，不当作书名', () => {
    const rows = parsePasteText('9787108061690');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.isbn, '9787108061690');
    assert.equal(rows[0]?.title, '');
  });

  it('两列“书名,ISBN”把第 2 列按 ISBN 读，不塞进作者', () => {
    const rows = parsePasteText('活着，9787506365437');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.title, '活着');
    assert.equal(rows[0]?.isbn, '9787506365437');
    assert.equal(rows[0]?.author, '');
  });

  it('多作者用顿号写时全部并入作者，不会错当成 ISBN 列', () => {
    const rows = parsePasteText('三体，刘慈欣、张三、李四');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.author, '刘慈欣、张三、李四');
    assert.equal(rows[0]?.isbn, '');
  });

  it('多作者 + 末列 ISBN：中列合并为作者，末列按 ISBN 读', () => {
    const rows = parsePasteText('三体，刘慈欣、张三，9787536692930');
    assert.equal(rows[0]?.author, '刘慈欣、张三');
    assert.equal(rows[0]?.isbn, '9787536692930');
  });

  it('ISBN 形状（10/13 位）但校验不过的行按无效丢，不建垃圾书目', () => {
    assert.equal(parsePasteText('978750636543X').length, 0);
    assert.equal(parsePasteText('9787506365431').length, 0);
    assert.equal(parsePasteText('1984').length, 1, '短数字串是合法书名，保留');
  });

  it('9–13 位纯数字但校验不过（如少敲一位的 ISBN）同样按无效丢', () => {
    assert.equal(parsePasteText('978710806169').length, 0);
    assert.equal(parsePasteText('978710806').length, 0);
  });

  it('空行与纯空白行丢弃，行号按原始行计', () => {
    const rows = parsePasteText('书A\n\n   \n书B');
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.line, 1);
    assert.equal(rows[1]?.line, 4);
  });

  it('无法识别的行（解析不出书名与 ISBN）被过滤', () => {
    assert.equal(parsePasteText('!!!\n\n').length, 0);
  });

  it('纯标点行不算书名（分隔线、序号残留）', () => {
    assert.equal(parsePasteText('------\n...\n①②').length, 0);
  });
});

describe('CSV 解析（05 §2.1）', () => {
  it('parseCsvLine 处理引号内逗号与 "" 转义', () => {
    assert.deepEqual(parseCsvLine('a,"b,c",d'), ['a', 'b,c', 'd']);
    assert.deepEqual(parseCsvLine('"说""明",x'), ['说"明', 'x']);
  });

  it('带表头：按列名对位，未知列忽略', () => {
    const rows = parseCsvText('title,author,isbn,publisher,publishDate,tags\n活着,余华,9787506365437,作家出版社,2012-08,文学');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.title, '活着');
    assert.equal(rows[0]?.publisher, '作家出版社');
    assert.deepEqual(rows[0]?.tags, ['文学']);
  });

  it('无表头：按 书名,作者,ISBN 三列读', () => {
    const rows = parseCsvText('活着,余华,9787506365437');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.author, '余华');
    assert.equal(rows[0]?.isbn, '9787506365437');
  });

  it('BOM 与表头大小写不影响识别', () => {
    const rows = parseCsvText('\uFEFFTitle,Author,Isbn\n活着,余华,9787506365437');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.title, '活着');
  });

  it('空白行不挤掉原始行号', () => {
    const rows = parseCsvText('书A\n\n书B');
    assert.equal(rows.length, 2);
    assert.equal(rows[1]?.line, 3, '书B 在原始文件第 3 行');
  });
});

describe('批量创建与跳过规则（05 §2.2）', () => {
  it('正常创建，报告计数与行号正确', async () => {
    await withDb(async (db) => {
      const report = await bulkImportBooks(db, parsePasteText('活着，余华\n红楼梦'));
      assert.equal(report.created, 2);
      assert.equal(report.skipped.length, 0);
    });
  });

  it('规则 1：解析不出内容（不会到达，因为 parse 已过滤）——直接测无效 ISBN 单行按书名处理', async () => {
    await withDb(async (db) => {
      const report = await bulkImportBooks(db, parsePasteText('一本不知名的书'));
      assert.equal(report.created, 1);
      assert.equal(report.skipped.length, 0);
    });
  });

  it('规则 2：本批内同名与同 ISBN 跳过', async () => {
    await withDb(async (db) => {
      const report = await bulkImportBooks(
        db,
        parsePasteText('活着\n活  着\n活着，张三\n书A，甲，9787108061690\n书B，乙，9787108061690'),
      );
      assert.equal(report.created, 2, '只建「活着」和「书A」');
      const reasons = report.skipped.map((item) => item.reason).join('|');
      assert.match(reasons, /本批内已有同名/);
      assert.match(reasons, /本批内已有同样 ISBN/);
    });
  });

  it('规则 3：库里已有同 ISBN 跳过', async () => {
    await withDb(async (db) => {
      await bulkImportBooks(db, parsePasteText('活着，余华，9787506365437'));
      const again = await bulkImportBooks(db, parsePasteText('活着新版，李四，9787506365437'));
      assert.equal(again.created, 0);
      assert.match(again.skipped[0]?.reason ?? '', /已有同样 ISBN/);
    });
  });

  it('规则 4：库里同名（无 ISBN）不跳过，标记疑似重复', async () => {
    await withDb(async (db) => {
      await bulkImportBooks(db, parsePasteText('红楼梦'));
      const again = await bulkImportBooks(db, parsePasteText('红楼梦'));
      assert.equal(again.created, 1);
      assert.equal(again.suspected.length, 1);
      assert.equal(again.suspected[0]?.title, '红楼梦');
    });
  });

  it('规则 4：库内同名但 ISBN 不同的行同样标记疑似重复', async () => {
    await withDb(async (db) => {
      await bulkImportBooks(db, parsePasteText('活着，余华，9787506365437'));
      const again = await bulkImportBooks(db, parsePasteText('活着，张三，9787506365400'));
      assert.equal(again.created, 1, '不同 ISBN 不跳过');
      assert.equal(again.suspected.length, 1, '但要提示疑似重复');
      assert.equal(again.suspected[0]?.title, '活着');
    });
  });

  it('建出来的书目可以用 findBooksByIsbn 查到（与库内服务衔接）', async () => {
    await withDb(async (db) => {
      await bulkImportBooks(db, parsePasteText('活着，余华，9787506365437'));
      const found = await findBooksByIsbn(db, '9787506365437');
      assert.equal(found.length, 1);
      assert.equal(found[0]?.authors[0], '余华');
    });
  });
});

/** 造一行解析结果：只给关心的字段，其余用空值。 */
function row(overrides: Partial<ParsedBookRow> = {}): ParsedBookRow {
  return {
    line: 1,
    title: '',
    author: '',
    isbn: '',
    publisher: '',
    publishDate: '',
    tags: [],
    location: '',
    copies: null,
    ...overrides,
  };
}

describe('位置与副本列（05 §2.2，P0-1）', () => {
  it('默认：1 本副本、落在「未分类」、品相「新」', async () => {
    await withDb(async (db) => {
      const report = await bulkImportBooks(db, [row({ title: '三体' })]);
      assert.equal(report.created, 1);
      assert.equal(report.copiesCreated, 1);
      const [book] = await listBooks(db);
      assert.ok(book);
      const copy = await db.copies.where('bookId').equals(book.id).first();
      assert.equal(copy?.locationId, UNSORTED_LOCATION_ID);
      assert.equal(copy?.condition, 'new');
    });
  });

  it('默认副本数 0 = 只建书目不建副本', async () => {
    await withDb(async (db) => {
      const report = await bulkImportBooks(db, [row({ title: '三体' })], { copies: 0 });
      assert.equal(report.created, 1);
      assert.equal(report.copiesCreated, 0);
      assert.equal(await db.copies.count(), 0);
    });
  });

  it('行值优先：行里的副本数与位置名压过默认值；位置不存在时自动新建为顶层', async () => {
    await withDb(async (db) => {
      const report = await bulkImportBooks(db, [row({ title: '三体', copies: 2, location: '书房' })], {
        copies: 5,
      });
      assert.equal(report.copiesCreated, 2, '行里的 2 压过默认的 5');
      const location = (await listLocations(db)).find((item) => item.name === '书房');
      assert.ok(location, '行里的位置名要自动新建');
      assert.equal(location.parentId, null, '新建的是顶层位置');
      const copies = await db.copies.toArray();
      assert.equal(copies.length, 2);
      assert.ok(copies.every((copy) => copy.locationId === location.id));
    });
  });

  it('同批里第二行写同样的位置名时复用刚建的位置，不再新建', async () => {
    await withDb(async (db) => {
      await bulkImportBooks(db, [
        row({ line: 1, title: '甲', location: '书房' }),
        row({ line: 2, title: '乙', location: '书房' }),
      ]);
      const named = (await listLocations(db)).filter((item) => item.name === '书房');
      assert.equal(named.length, 1);
      const copies = await db.copies.toArray();
      assert.equal(copies.length, 2);
      assert.ok(copies.every((copy) => copy.locationId === named[0]?.id));
    });
  });

  it('副本数超过上限：截断到 99 并记入报告警告（不算跳过）', async () => {
    await withDb(async (db) => {
      const report = await bulkImportBooks(db, [row({ title: '三体', copies: 999 })]);
      assert.equal(report.created, 1);
      assert.equal(report.copiesCreated, MAX_INITIAL_COUNT);
      assert.equal(report.skipped.length, 0, '截断不是跳过');
      assert.equal(report.warnings.length, 1);
      assert.match(report.warnings[0]?.reason ?? '', new RegExp(String(MAX_INITIAL_COUNT)));
    });
  });

  it('默认品相可指定，品相写进副本', async () => {
    await withDb(async (db) => {
      await bulkImportBooks(db, [row({ title: '三体' })], { condition: 'good' });
      const copies = await db.copies.toArray();
      assert.equal(copies[0]?.condition, 'good');
    });
  });
});

describe('文本类文件与 JSON（05 §2.1，B4）', () => {
  it('制表符 / 竖线 / 连续空格文件都走同一条列映射管线', () => {
    const tabbed = parseTextFile('书名\t作者\t位置\n三体\t刘慈欣\t书房');
    assert.equal(tabbed[0]?.title, '三体');
    assert.equal(tabbed[0]?.location, '书房');
    const pipe = parseTextFile('| 书名 | 作者 |\n| --- | --- |\n| 活着 | 余华 |');
    assert.equal(pipe[0]?.author, '余华');
    const spaced = parseTextFile('三体    刘慈欣    9787536692930');
    assert.equal(spaced[0]?.author, '刘慈欣');
    assert.equal(spaced[0]?.isbn, '9787536692930');
  });

  it('探测不出分隔符 → 回退逗号口径（全角逗号也是分隔符）', () => {
    const rows = parseTextFile('活着，余华\n三体', '书单.txt');
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.author, '余华');
    assert.equal(rows[1]?.title, '三体');
  });

  it('JSON：行号 = 数组里第几条，副本/位置列生效，跳过规则照常', async () => {
    await withDb(async (db) => {
      const json = '[{"书名":"三体","作者":"刘慈欣","位置":"书房","副本数":2},{"title":"三体","author":"张三"}]';
      const source = sourceFromJson(json, '书单.json');
      assert.equal(source.kind, 'json');
      const report = await bulkImportBooks(db, parseJsonFile(json, '书单.json'));
      assert.equal(report.created, 1);
      assert.equal(report.copiesCreated, 2, '行里的副本数生效');
      assert.equal(report.skipped[0]?.line, 2, '第 2 条与第 1 条同名 → 本批内重复');
      assert.match(report.skipped[0]?.reason ?? '', /本批内已有同名/);
      assert.ok((await listLocations(db)).some((item) => item.name === '书房'), '行里的位置名自动新建');
    });
  });

  it('JSON 非数组 / 空数组报人话错误，不写库', async () => {
    await withDb(async (db) => {
      assert.throws(() => sourceFromJson('{"book":[]}'), /数组/);
      assert.throws(() => sourceFromJson('[]'), /一条书目都没有/);
      assert.equal(await db.books.count(), 0);
      assert.equal(await db.copies.count(), 0);
    });
  });

  it('新格式下的跳过规则与老格式一致（行号对原始行）', async () => {
    await withDb(async (db) => {
      const report = await bulkImportBooks(db, parseTextFile('三体\t刘慈欣\n三体\t张三', '书单.tsv'));
      assert.equal(report.created, 1);
      assert.equal(report.skipped[0]?.line, 2);
      assert.match(report.skipped[0]?.reason ?? '', /本批内已有同名/);
    });
  });
});
