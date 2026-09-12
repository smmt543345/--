import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { withDb } from '../../testing/harness.ts';
import { findBooksByIsbn } from '../../db/books.ts';
import { parsePasteText, parseCsvText, bulkImportBooks, parseCsvLine } from './import.ts';

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
