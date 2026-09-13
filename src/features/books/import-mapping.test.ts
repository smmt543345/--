/**
 * 列名映射测试（05 §2.2）：别名词典、表头识别、手动改映射、副本数列解析。
 *
 * 全部是纯函数，不需要数据库；行语义与写库在 import.test.ts。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  HEADER_ALIASES,
  IMPORT_FIELDS,
  buildColumnMapping,
  cellFor,
  defaultColumnMapping,
  isHeaderRow,
  matchHeaderCell,
  parseCopiesCell,
  setColumnField,
} from './import-mapping.ts';

describe('别名词典（05 §2.2）', () => {
  it('中英文别名都能命中，大小写与两侧空白不敏感', () => {
    assert.equal(matchHeaderCell('书名'), 'title');
    assert.equal(matchHeaderCell(' 名称 '), 'title');
    assert.equal(matchHeaderCell('Title'), 'title');
    assert.equal(matchHeaderCell(' ISBN '), 'isbn');
    assert.equal(matchHeaderCell('出版年'), 'publishDate');
    assert.equal(matchHeaderCell('位置'), 'location');
    assert.equal(matchHeaderCell('册数'), 'copies');
    assert.equal(matchHeaderCell('分类'), 'tags');
  });

  it('识别不出的列返回 null（该列忽略）', () => {
    assert.equal(matchHeaderCell('备注'), null);
    assert.equal(matchHeaderCell(''), null);
    assert.equal(matchHeaderCell('   '), null);
  });

  it('每个字段在词典里都有别名', () => {
    for (const field of IMPORT_FIELDS) {
      assert.ok(HEADER_ALIASES[field].length > 0, `${field} 没有别名`);
    }
  });
});

describe('表头识别与列映射', () => {
  it('首行至少一列命中词典才算表头，否则当数据行', () => {
    assert.equal(isHeaderRow(['书名', '作者', 'ISBN']), true);
    assert.equal(isHeaderRow(['三体', '刘慈欣', '9787536692930']), false);
    assert.equal(isHeaderRow([]), false);
  });

  it('按列建映射，未识别的列是 null', () => {
    assert.deepEqual(
      buildColumnMapping(['名称', '作者', '备注', '位置']),
      ['title', 'author', null, 'location'],
    );
  });

  it('无表头时默认三列「书名,作者,ISBN」，且每次返回新数组', () => {
    assert.deepEqual(defaultColumnMapping(), ['title', 'author', 'isbn']);
    const first = defaultColumnMapping();
    (first as (string | null)[])[0] = null;
    assert.deepEqual(defaultColumnMapping(), ['title', 'author', 'isbn'], '共享常量被改坏了');
  });

  it('手动改映射：可改列、可忽略（null）、超长自动补 null', () => {
    const base = buildColumnMapping(['甲', '乙']); // 两列都识别不出
    assert.deepEqual(setColumnField(base, 0, 'title'), ['title', null]);
    assert.deepEqual(setColumnField(base, 0, null), [null, null]);
    assert.deepEqual(setColumnField(base, 3, 'copies'), [null, null, null, 'copies']);
  });

  it('cellFor：取映射列的单元格；未映射或该行没这么多列 → 空串', () => {
    const mapping = buildColumnMapping(['书名', '作者']);
    assert.equal(cellFor(['三体', '刘慈欣'], mapping, 'title'), '三体');
    assert.equal(cellFor(['三体'], mapping, 'author'), '');
    assert.equal(cellFor(['三体', '刘慈欣'], mapping, 'location'), '');
    assert.equal(cellFor(['  三体  ', '刘慈欣'], mapping, 'title'), '三体', '单元格两侧空白要 trim');
  });

  it('同一字段被映射到多列时取最左列', () => {
    const mapping = setColumnField(buildColumnMapping(['书名', '名称']), 0, 'title');
    assert.equal(cellFor(['甲', '乙'], mapping, 'title'), '甲');
  });
});

describe('副本数列解析（05 §2.2 规则 5）', () => {
  it('非负整数才认；0 合法（只建书目不建副本）', () => {
    assert.equal(parseCopiesCell('3'), 3);
    assert.equal(parseCopiesCell(' 0 '), 0);
    assert.equal(parseCopiesCell('１２'), 12, '全角数字要认（中文输入法常见）');
  });

  it('空、小数、负数、文字都当作未填（null），由批量层回退默认值', () => {
    assert.equal(parseCopiesCell(''), null);
    assert.equal(parseCopiesCell('2.5'), null);
    assert.equal(parseCopiesCell('-1'), null);
    assert.equal(parseCopiesCell('两本'), null);
  });

  it('超过上限的值原样返回——截断与记报告是批量层的规矩，解析层不吞', () => {
    assert.equal(parseCopiesCell('999'), 999);
  });
});
