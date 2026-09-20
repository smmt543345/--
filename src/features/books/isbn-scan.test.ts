/**
 * 条码文本 → ISBN 的用例（04 §11.12 那张表逐行覆盖）。
 * 摄像头本身测不了（真机验收），但「扫到什么算数」这层必须钉死在这里。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SCAN_NOTICE, isbnFromBarcode } from './isbn-scan.ts';

describe('条码文本 → ISBN（04 §11.12）', () => {
  it('合法 ISBN-13（978 / 979 开头）→ 接受', () => {
    assert.deepEqual(isbnFromBarcode('9780306406157'), { kind: 'ok', isbn13: '9780306406157' });
    assert.deepEqual(isbnFromBarcode('9791234567896'), { kind: 'ok', isbn13: '9791234567896' });
  });

  it('带连字符 / 空格 / 杂分隔符 → 先清洗再接受', () => {
    assert.deepEqual(isbnFromBarcode('978-0-306-40615-7'), { kind: 'ok', isbn13: '9780306406157' });
    assert.deepEqual(isbnFromBarcode(' 978 0 306 40615 7 '), { kind: 'ok', isbn13: '9780306406157' });
    // 清洗是「去掉一切非 [0-9Xx]」，别的分隔符也照去（与手填走的是同一个 normalizeIsbn）
    assert.deepEqual(isbnFromBarcode('978#0306#40615#7'), { kind: 'ok', isbn13: '9780306406157' });
  });

  it('ISBN-10（含 X 结尾）→ 转成 ISBN-13 后接受（决策 D4）', () => {
    assert.deepEqual(isbnFromBarcode('0-306-40615-2'), { kind: 'ok', isbn13: '9780306406157' });
    assert.deepEqual(isbnFromBarcode('155404295X'), { kind: 'ok', isbn13: '9781554042951' });
  });

  it('977 期刊条码 → 不接受，提示这不是图书条码', () => {
    const outcome = isbnFromBarcode('9771234567003');
    assert.equal(outcome.kind, 'rejected');
    assert.equal(outcome.kind === 'rejected' ? outcome.message : '', SCAN_NOTICE.journal);
    assert.match(SCAN_NOTICE.journal, /不是图书条码/);
  });

  it('带 EAN-5 附加码：图书条码取前 13 位判定，合法则接受', () => {
    assert.deepEqual(isbnFromBarcode('9780306406157 51299'), { kind: 'ok', isbn13: '9780306406157' });
    assert.deepEqual(isbnFromBarcode('978030640615751299'), { kind: 'ok', isbn13: '9780306406157' });
  });

  it('带 EAN-5 附加码的期刊条码照样不接受（前缀门在前，附加码在后）', () => {
    assert.deepEqual(isbnFromBarcode('9771234567003 12345'), { kind: 'rejected', message: SCAN_NOTICE.journal });
  });

  it('校验位错误 → 不接受（宁可让人重扫，也不往 ISBN 字段填错号）', () => {
    assert.equal(isbnFromBarcode('9787115546080').kind, 'rejected');
    assert.equal(isbnFromBarcode('0306406153').kind, 'rejected');
  });

  it('13 位但不是 978/979（如内部条码）→ 按乱码口径提示', () => {
    assert.deepEqual(isbnFromBarcode('1234567890128'), { kind: 'rejected', message: SCAN_NOTICE.unreadable });
  });

  it('空串 / 空白 / 字母 / 短数字 / 全角数字 → 提示乱码，且都不抛异常', () => {
    for (const input of ['', '   ', 'abc', '12345', '978X0306406157', '９７８０３０６４０６１５７']) {
      const outcome = isbnFromBarcode(input);
      assert.equal(outcome.kind, 'rejected', `输入「${input}」应判为认不出来`);
      assert.equal(outcome.kind === 'rejected' ? outcome.message : '', SCAN_NOTICE.unreadable);
    }
  });

  it('两种提示都是可直接展示的中文，不是空话', () => {
    for (const message of [SCAN_NOTICE.journal, SCAN_NOTICE.unreadable]) {
      assert.ok(message.trim().length > 0);
      // 提示里要告诉用户下一步做什么（继续扫 / 手填），不能只说「失败」
      assert.match(message, /继续|手动|填/);
    }
  });
});
