import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BackupCounts, ImportSummary } from '../../backup/format.ts';
import type { RepairReport } from '../../db/repair.ts';
import {
  describeClearAllData,
  describeLibraryCounts,
  describeRepairReport,
  describeReplaceImport,
  MAX_DEVICE_NAME_LENGTH,
  MAX_LOAN_PERIOD_DAYS,
  parseImportMode,
  parseLoanPeriodDays,
  previewMatchesChoice,
  validateDeviceName,
} from './write.ts';

describe('parseLoanPeriodDays', () => {
  it('接受 1..365 的整数，全角数字按半角读', () => {
    assert.deepEqual(parseLoanPeriodDays('30'), { ok: true, value: 30 });
    assert.deepEqual(parseLoanPeriodDays(' 7 '), { ok: true, value: 7 });
    assert.deepEqual(parseLoanPeriodDays('３０'), { ok: true, value: 30 });
    assert.deepEqual(parseLoanPeriodDays('1'), { ok: true, value: 1 });
    assert.deepEqual(parseLoanPeriodDays(String(MAX_LOAN_PERIOD_DAYS)), { ok: true, value: MAX_LOAN_PERIOD_DAYS });
  });

  it('拒绝空、零、小数、带单位与科学计数法，并给出中文原因', () => {
    for (const raw of ['', '   ', '0', '3.5', '30天', '1e2', '-5']) {
      const result = parseLoanPeriodDays(raw);
      assert.equal(result.ok, false, `${raw} 不该被接受`);
      if (!result.ok) assert.equal(result.error, '借期要填整数天数，例如 30');
    }
  });

  it('超过上限时说明怎么办，而不是只说"不合法"', () => {
    const result = parseLoanPeriodDays(String(MAX_LOAN_PERIOD_DAYS + 1));
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /应还日期/);
  });
});

describe('validateDeviceName', () => {
  it('允许留空，也允许正好到上限', () => {
    assert.equal(validateDeviceName(''), null);
    assert.equal(validateDeviceName('书房 iPad'), null);
    assert.equal(validateDeviceName('x'.repeat(MAX_DEVICE_NAME_LENGTH)), null);
  });

  it('超长要拦下来，但两侧空白不算字数', () => {
    assert.notEqual(validateDeviceName('x'.repeat(MAX_DEVICE_NAME_LENGTH + 1)), null);
    assert.equal(validateDeviceName(`   ${'x'.repeat(MAX_DEVICE_NAME_LENGTH)}   `), null);
  });
});

describe('parseImportMode', () => {
  it('只认 merge / replace', () => {
    assert.equal(parseImportMode('merge'), 'merge');
    assert.equal(parseImportMode('replace'), 'replace');
    for (const raw of ['MERGE', 'both', '', ' merge']) {
      assert.equal(parseImportMode(raw), null);
    }
  });
});

describe('previewMatchesChoice', () => {
  it('没有预览时一律不能执行', () => {
    assert.equal(previewMatchesChoice(null, 'merge'), false);
    assert.equal(previewMatchesChoice(null, 'replace'), false);
  });

  it('预览的模式与当前选择一致才放行', () => {
    assert.equal(previewMatchesChoice({ mode: 'merge', dryRun: true }, 'merge'), true);
    assert.equal(previewMatchesChoice({ mode: 'merge', dryRun: true }, 'replace'), false);
  });

  it('真实执行的结果不算预览（不能被当成"已经预演过"）', () => {
    assert.equal(previewMatchesChoice({ mode: 'merge', dryRun: false }, 'merge'), false);
  });
});

const COUNTS: BackupCounts = { locations: 4, books: 12, copies: 15, loans: 3, borrowers: 2 };

function makeSummary(overrides: Partial<ImportSummary> = {}): ImportSummary {
  const empty = { inserted: 0, updated: 0, skipped: 0 };
  return {
    mode: 'replace',
    dryRun: true,
    locations: { ...empty, reparented: 0, conflictingNames: [] },
    books: { ...empty, mergedByIsbn: 0 },
    copies: { ...empty, relocated: 0 },
    loans: { ...empty, conflicts: 0 },
    borrowers: { inserted: 0, updated: 0 },
    warnings: [],
    durationMs: 1,
    ...overrides,
  };
}

describe('确认文案必须带具体数量（04 §6）', () => {
  it('四个数字一个都不能少', () => {
    const text = describeLibraryCounts(COUNTS);
    for (const value of ['4', '12', '15', '3']) assert.match(text, new RegExp(value));
  });

  it('清空数据的文案要说清不可撤销、以及什么会保留', () => {
    const text = describeClearAllData(COUNTS);
    assert.match(text, /12 条书目/);
    assert.match(text, /15 本副本/);
    assert.match(text, /无法撤销/);
    assert.match(text, /主题与设备名.*保留/);
  });

  it('替换导入的文案同时给出现有数量与将要写入的数量', () => {
    const summary = makeSummary({
      books: { inserted: 8, updated: 0, mergedByIsbn: 0 },
      copies: { inserted: 9, updated: 0, skipped: 0, relocated: 0 },
      locations: { inserted: 2, updated: 0, reparented: 0, conflictingNames: [] },
    });
    const text = describeReplaceImport(COUNTS, summary);
    assert.match(text, /清空本机的 12 条书目/);
    assert.match(text, /书目 8 条、副本 9 本、位置 2 个/);
    assert.match(text, /借出记录也会一并清掉/);
  });
});

describe('describeRepairReport', () => {
  const EMPTY_REPORT: RepairReport = {
    danglingParentsFixed: 0,
    cyclesBroken: 0,
    copiesRepointed: 0,
    copiesDeleted: 0,
    loansDeleted: 0,
    duplicateActiveLoansResolved: 0,
    copyStatusFixed: 0,
    pathsRebuilt: 0,
    warnings: [],
  };

  it('全零给一句话，而不是一串 0', () => {
    const rows = describeRepairReport(EMPTY_REPORT);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.value, '没有需要修复的问题');
  });

  it('只列非零项，并标出告警条数', () => {
    const rows = describeRepairReport({
      ...EMPTY_REPORT,
      cyclesBroken: 1,
      copiesRepointed: 3,
      pathsRebuilt: 4,
      warnings: ['打断了 1 个环', '副本已改挂'],
    });
    assert.deepEqual(
      rows.map((row) => row.label),
      ['打断位置层级环', '副本改挂到「未分类」', '重建位置路径', '附带告警'],
    );
    assert.equal(rows[0]?.value, '1 处');
    assert.equal(rows[3]?.value, '2 条');
  });
});
