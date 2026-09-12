import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addDays, daysSince, earliest, isDateString, isOverdue, isTimestampString, today } from './time.ts';

describe('时间工具（01 §6.4）', () => {
  it('日期串校验拒绝不存在的日子', () => {
    assert.equal(isDateString('2026-09-11'), true);
    assert.equal(isDateString('2026-02-30'), false);
    assert.equal(isDateString('2026-13-01'), false);
    assert.equal(isDateString('2026-9-1'), false);
    assert.equal(isDateString(''), false);
    assert.equal(isDateString(20260911), false);
  });

  it('时间戳校验', () => {
    assert.equal(isTimestampString('2026-09-11T11:39:52.000Z'), true);
    assert.equal(isTimestampString('2026-09-11'), true);
    assert.equal(isTimestampString('乱码'), false);
    assert.equal(isTimestampString(''), false);
    assert.equal(isTimestampString(null), false);
  });

  it('addDays 跨月跨年正确', () => {
    assert.equal(addDays('2026-01-31', 1), '2026-02-01');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  });

  it('逾期判断：空 dueDate 永不算逾期', () => {
    assert.equal(isOverdue('2026-01-01', '2026-02-01'), true);
    assert.equal(isOverdue('2026-02-01', '2026-02-01'), false);
    assert.equal(isOverdue('', '2026-02-01'), false);
  });

  it('daysSince 正数表示已过去', () => {
    assert.equal(daysSince('2026-02-01', '2026-02-11'), 10);
    assert.equal(daysSince('2026-02-11', '2026-02-01'), -10);
    assert.equal(daysSince('乱码', '2026-02-01'), 0);
  });

  it('earliest 取较早时间戳，空串当无穷大', () => {
    assert.equal(earliest('2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'), '2026-01-01T00:00:00.000Z');
    assert.equal(earliest('', '2026-02-01T00:00:00.000Z'), '2026-02-01T00:00:00.000Z');
    assert.equal(earliest('2026-01-01T00:00:00.000Z', ''), '2026-01-01T00:00:00.000Z');
  });

  it('today 输出 YYYY-MM-DD', () => {
    assert.match(today(), /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(today(new Date(2026, 8, 11)), '2026-09-11');
  });
});
