/**
 * Word 书单解析（05 §2.1，B4）：测试里用 fflate 现场造最小 docx（zip 里只有
 * `word/document.xml`，那正是解析器唯一要读的东西），走真实解压，不 mock。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cellsFromDocumentXml, parseDocx, readDocxCells, readDocxSource } from './docx.ts';

/** 段落：`<w:p>` 里一个 run。 */
function p(text: string): string {
  return `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
}

/** 表格行：`<w:tr>` + 若干单元格（每个单元格一个段落）。 */
function tr(cells: readonly string[]): string {
  return `<w:tr>${cells.map((cell) => `<w:tc>${p(cell)}</w:tc>`).join('')}</w:tr>`;
}

function document(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
}

/** 最小 docx 字节：zip 里只有 word/document.xml。 */
async function docxBytes(xml: string): Promise<Uint8Array> {
  const { strToU8, zipSync } = await import('fflate');
  return zipSync({ 'word/document.xml': strToU8(xml) });
}

describe('docx 解压取内容（05 §2.1）', () => {
  it('表格每行一条书，单元格对应列', async () => {
    const bytes = await docxBytes(document(`<w:tbl>${tr(['书名', '作者', 'ISBN'])}${tr(['三体', '刘慈欣', '9787536692930'])}</w:tbl>`));
    assert.deepEqual(await readDocxCells(bytes), [
      ['书名', '作者', 'ISBN'],
      ['三体', '刘慈欣', '9787536692930'],
    ]);
  });

  it('表格之外的段落也当行读：段内有分隔符就切列', () => {
    assert.deepEqual(cellsFromDocumentXml(document(p('活着，余华') + p('三体'))), [['活着', '余华'], ['三体']]);
  });

  it('表格与散段混排时按文档顺序取', () => {
    const xml = document(p('书单') + `<w:tbl>${tr(['三体', '刘慈欣'])}</w:tbl>` + p('活着，余华'));
    assert.deepEqual(cellsFromDocumentXml(xml), [['书单'], ['三体', '刘慈欣'], ['活着', '余华']]);
  });

  it('XML 实体还原：`&amp;` 与数字实体（全角逗号）', () => {
    assert.deepEqual(cellsFromDocumentXml(document(p('Tom &amp; Jerry&#65292;x'))), [['Tom & Jerry', 'x']]);
  });

  it('单元格里的多个段落合并成一格', () => {
    const xml = document(`<w:tbl><w:tr><w:tc>${p('三体')}${p('刘慈欣')}</w:tc></w:tr></w:tbl>`);
    assert.deepEqual(cellsFromDocumentXml(xml), [['三体 刘慈欣']]);
  });

  it('段内的软换行（<w:br/>）不另起一行', () => {
    const xml = document('<w:p><w:r><w:t>三体</w:t><w:br/><w:t>刘慈欣</w:t></w:r></w:p>');
    assert.deepEqual(cellsFromDocumentXml(xml), [['三体 刘慈欣']]);
  });

  it('空文档 → 空矩阵', () => {
    assert.deepEqual(cellsFromDocumentXml(document('')), []);
  });
});

describe('docx 进列映射管线（05 §2.1）', () => {
  it('有表头：按别名映射，导入源带出文件名与映射（预览可改）', async () => {
    const bytes = await docxBytes(
      document(`<w:tbl>${tr(['书名', '作者', '位置', '册数'])}${tr(['三体', '刘慈欣', '书房', '2'])}</w:tbl>`),
    );
    const source = await readDocxSource(bytes, '我的书单.docx');
    assert.equal(source.kind, 'docx');
    assert.equal(source.name, '我的书单.docx');
    assert.deepEqual(source.mapping, ['title', 'author', 'location', 'copies']);
    assert.equal(source.header?.[0], '书名');

    const rows = await parseDocx(bytes);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.title, '三体');
    assert.equal(rows[0]?.location, '书房');
    assert.equal(rows[0]?.copies, 2);
  });

  it('无表头：按「书名,作者,ISBN」三列读', async () => {
    const bytes = await docxBytes(document(`<w:tbl>${tr(['三体', '刘慈欣', '9787536692930'])}</w:tbl>`));
    const rows = await parseDocx(bytes);
    assert.equal(rows[0]?.title, '三体');
    assert.equal(rows[0]?.isbn, '9787536692930');
  });

  it('列对不上时映射仍可在预览里改：解析只给原始单元格', async () => {
    const bytes = await docxBytes(document(`<w:tbl>${tr(['编号', '名称', '备注'])}${tr(['A-1', '三体', '随手记'])}</w:tbl>`));
    const source = await readDocxSource(bytes);
    assert.deepEqual(source.mapping, [null, 'title', null], '认不出的列是 null = 忽略');
  });
});

describe('docx 的错误路径（05 §2.1）', () => {
  it('zip 里没有 word/document.xml → 报人话错误', async () => {
    const { strToU8, zipSync } = await import('fflate');
    await assert.rejects(() => parseDocx(zipSync({ 'docProps/app.xml': strToU8('<x/>') })), /word\/document\.xml/);
  });

  it('不是 zip 的字节 → 报人话错误', async () => {
    await assert.rejects(() => parseDocx(new TextEncoder().encode('这不是一份 docx')), /\.docx/);
  });
});
