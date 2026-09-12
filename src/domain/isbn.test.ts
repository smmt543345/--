import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isbn10To13,
  isValidIsbn10,
  isValidIsbn13,
  normalizeIsbn,
  toIsbn13,
} from './isbn.ts';

describe('ISBN 规范化（02 §7.3）', () => {
  it('接受合法的 ISBN-13，去掉连字符与空格', () => {
    assert.equal(toIsbn13('978-7-115-54608-1'), '9787115546081');
    assert.equal(toIsbn13('978 7 115 54608 1'), '9787115546081');
    assert.equal(toIsbn13('9787115546081'), '9787115546081');
  });

  it('把合法的 ISBN-10 一律转成 ISBN-13（决策 D4）', () => {
    // 扫码拿到 ISBN-13、手工录入 ISBN-10 时，必须落到同一条书目
    assert.equal(isValidIsbn10('0306406152'), true);
    assert.equal(isbn10To13('0306406152'), '9780306406157');
    assert.equal(toIsbn13('0-306-40615-2'), '9780306406157');
  });

  it('校验位错误的 ISBN 判为无效 —— 宁可留空，也不能写错号', () => {
    assert.equal(isValidIsbn13('9787115546080'), false);
    assert.equal(normalizeIsbn('9787115546080').valid, false);
    assert.equal(normalizeIsbn('9787115546080').isbn13, '');
  });

  it('非法输入返回空串，不抛异常（导入必须宽进）', () => {
    for (const input of ['', '   ', 'abc', '123', null, undefined, 42, {}, []]) {
      assert.equal(toIsbn13(input), '', `输入 ${JSON.stringify(input)} 应返回空串`);
    }
  });

  it('保留 cleaned 供用户核对"你输入的其实是 X"', () => {
    const result = normalizeIsbn('978-71155-46081');
    assert.equal(result.cleaned, '9787115546081');
    assert.equal(result.valid, true);
  });

  it('非 978/979 开头的 13 位数字不算 ISBN', () => {
    assert.equal(isValidIsbn13('1234567890128'), false);
  });

  it('小写 x 结尾的 ISBN-10 能被识别', () => {
    assert.equal(isValidIsbn10('155404295x'.toUpperCase()), true);
    assert.equal(toIsbn13('155404295X'), isbn10To13('155404295X'));
  });
});
