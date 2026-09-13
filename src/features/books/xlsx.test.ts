/**
 * xlsx 解析测试（05 §2.1）：走真实 SheetJS 往返（写一份工作簿 → 读出字节 → 解析），
 * 不 mock —— 与 CSV 同构的行为（表头识别、三列回退、空单元格）正是要验证的点。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseXlsx, readXlsxSource } from './xlsx.ts';

/** 用 SheetJS 造一份工作簿字节（表里给的就是单元格矩阵）。 */
async function workbookBytes(rows: readonly (readonly string[])[]): Promise<Uint8Array> {
  const xlsx = await import('xlsx');
  const sheet = xlsx.utils.aoa_to_sheet(rows.map((row) => [...row]));
  const book = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(book, sheet, '书目');
  const out = xlsx.write(book, { type: 'array', bookType: 'xlsx' });
  return new Uint8Array(out as ArrayBuffer);
}

describe('xlsx 解析（05 §2.1）', () => {
  it('有表头：中文表头按别名映射，未识别的列忽略', async () => {
    const bytes = await workbookBytes([
      ['书名', '作者', '备注', '位置', '册数'],
      ['三体', '刘慈欣', '随手记', '书房', '2'],
    ]);
    const rows = await parseXlsx(bytes);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.title, '三体');
    assert.equal(rows[0]?.author, '刘慈欣');
    assert.equal(rows[0]?.location, '书房');
    assert.equal(rows[0]?.copies, 2);
  });

  it('无表头：按「书名,作者,ISBN」三列读', async () => {
    const bytes = await workbookBytes([
      ['三体', '刘慈欣', '9787536692930'],
      ['活着', '余华', ''],
    ]);
    const rows = await parseXlsx(bytes);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.title, '三体');
    assert.equal(rows[0]?.isbn, '9787536692930');
    assert.equal(rows[1]?.title, '活着');
    assert.equal(rows[1]?.isbn, '', '空单元格 = 未填');
  });

  it('空单元格同空列：不给默认值，交给批量层', async () => {
    const bytes = await workbookBytes([
      ['书名', '作者', '位置', '册数'],
      ['三体', '', '', ''],
    ]);
    const rows = await parseXlsx(bytes);
    assert.equal(rows[0]?.author, '');
    assert.equal(rows[0]?.location, '');
    assert.equal(rows[0]?.copies, null);
  });

  it('readXlsxSource 带出列映射（预览用），表头与数据行分开', async () => {
    const bytes = await workbookBytes([
      ['名称', '作者', '位置'],
      ['三体', '刘慈欣', '书房'],
    ]);
    const source = await readXlsxSource(bytes, '我的书单.xlsx');
    assert.equal(source.name, '我的书单.xlsx');
    assert.equal(source.kind, 'xlsx');
    assert.deepEqual(source.mapping, ['title', 'author', 'location']);
    assert.equal(source.header?.[0], '名称', '原始表头保留给预览渲染');
    assert.equal(source.rows.length, 1);
  });

  it('无表头时 header 为 null，映射回退默认三列', async () => {
    const bytes = await workbookBytes([['三体', '刘慈欣', '']]);
    const source = await readXlsxSource(bytes);
    assert.equal(source.header, null);
    assert.deepEqual(source.mapping, ['title', 'author', 'isbn']);
    assert.equal(source.rows.length, 1);
  });
});
