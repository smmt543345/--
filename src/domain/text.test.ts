import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { joinList, normalizeDigits, parseList, parsePositiveInt } from './text.ts';

describe('parseList', () => {
  it('按中英文逗号、顿号、分号、斜杠切分并去空白', () => {
    assert.deepEqual(parseList('金庸, 古龙、梁羽生；温瑞安/黄易'), [
      '金庸',
      '古龙',
      '梁羽生',
      '温瑞安',
      '黄易',
    ]);
  });

  it('丢掉空片段与重复项，保留顺序', () => {
    assert.deepEqual(parseList(' 科幻 ,, 科幻 ，, 推理 ,'), ['科幻', '推理']);
  });

  it('空输入得到空数组', () => {
    assert.deepEqual(parseList(''), []);
    assert.deepEqual(parseList('   ,  、  '), []);
  });

  it('名称里本来就带逗号的情况不会被再切一刀（只按分隔符切）', () => {
    assert.deepEqual(parseList('J. R. R. Tolkien'), ['J. R. R. Tolkien']);
  });
});

describe('joinList', () => {
  it('默认用顿号，可指定分隔符', () => {
    assert.equal(joinList(['客厅', '阳台']), '客厅、阳台');
    assert.equal(joinList(['a', 'b'], ' / '), 'a / b');
    assert.equal(joinList([]), '');
  });
});

describe('normalizeDigits', () => {
  it('全角数字转半角，其余字符原样保留', () => {
    assert.equal(normalizeDigits('３０天'), '30天');
    assert.equal(normalizeDigits('abc１２3'), 'abc123');
    assert.equal(normalizeDigits('完全没有数字'), '完全没有数字');
  });
});

describe('parsePositiveInt', () => {
  it('接受半角与全角的正整数，两侧空白忽略', () => {
    assert.equal(parsePositiveInt('30'), 30);
    assert.equal(parsePositiveInt(' 7 '), 7);
    assert.equal(parsePositiveInt('３０'), 30);
    assert.equal(parsePositiveInt('007'), 7);
  });

  it('拒绝带单位、小数、科学计数法、符号与零', () => {
    for (const raw of ['30天', '3.5', '1e2', '-1', '+7', '0', '']) {
      assert.equal(parsePositiveInt(raw), null, `${raw} 不该被当成合法正整数`);
    }
  });
});
