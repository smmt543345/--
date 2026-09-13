import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ImportSummary } from '../backup/format.ts';
import {
  COPY_CONDITIONS,
  COPY_STATUSES,
  LOCATION_TYPES,
  LOAN_STATUSES,
  MATCH_FIELDS,
  SNAPSHOT_KINDS,
  type Book,
  type Copy,
  type Location,
  type Snapshot,
} from '../domain/types.ts';
import { THEMES } from '../platform/theme.ts';
import {
  authorsText,
  bookDisplayTitle,
  COPY_CONDITION_LABELS,
  COPY_STATUS_LABELS,
  copyStatusTone,
  describeLastExport,
  describeUndo,
  formatDateTime,
  IMPORT_MODE_LABELS,
  importSummaryRows,
  LOCATION_TYPE_LABELS,
  LOAN_STATUS_LABELS,
  MATCH_FIELD_LABELS,
  SNAPSHOT_KIND_LABELS,
  snapshotCountsText,
  THEME_LABELS,
} from './labels.ts';

describe('标签完备性', () => {
  // 这组断言的用意：types.ts 里加了新枚举值、却忘了加中文标签时，测试立刻红
  const cases: Array<[string, readonly string[], Readonly<Record<string, string>>]> = [
    ['CopyStatus', COPY_STATUSES, COPY_STATUS_LABELS],
    ['CopyCondition', COPY_CONDITIONS, COPY_CONDITION_LABELS],
    ['LoanStatus', LOAN_STATUSES, LOAN_STATUS_LABELS],
    ['LocationType', LOCATION_TYPES, LOCATION_TYPE_LABELS],
    ['MatchField', MATCH_FIELDS, MATCH_FIELD_LABELS],
    ['Theme', THEMES, THEME_LABELS],
    ['SnapshotKind', SNAPSHOT_KINDS, SNAPSHOT_KIND_LABELS],
  ];

  for (const [name, values, labels] of cases) {
    it(`${name} 的每个取值都有非空中文标签，且没有多余条目`, () => {
      assert.deepEqual(Object.keys(labels).sort(), [...values].sort());
      for (const value of values) {
        assert.equal(typeof labels[value], 'string');
        assert.notEqual(labels[value]?.trim(), '');
      }
    });
  }
});

describe('copyStatusTone', () => {
  it('每个状态都有色调，且借出/丢失能一眼区分', () => {
    for (const status of COPY_STATUSES) {
      assert.ok(['green', 'amber', 'red', 'gray'].includes(copyStatusTone(status)));
    }
    assert.equal(copyStatusTone('lent_out'), 'amber');
    assert.equal(copyStatusTone('lost'), 'red');
  });
});

describe('展示格式', () => {
  it('非法时间戳不显示 Invalid Date', () => {
    assert.equal(formatDateTime(''), '');
    assert.equal(formatDateTime('不是时间'), '');
  });

  it('合法时间戳能格式化出年月日', () => {
    const text = formatDateTime('2026-09-11T11:39:52.000Z');
    assert.match(text, /\d{4}/);
    assert.match(text, /\d{2}:\d{2}/);
  });

  it('describeLastExport 处理从未导出与近期导出', () => {
    assert.equal(describeLastExport(''), '从未导出');
    assert.equal(describeLastExport('不是时间'), '从未导出');
    assert.equal(describeLastExport(new Date().toISOString()), '今天');
  });

  it('describeLastExport 按本地日历日算天数', () => {
    const reference = '2026-09-11';
    const tenDaysAgo = new Date('2026-09-01T12:00:00.000Z').toISOString();
    // 跨时区会有一天的浮动，这里只断言落在合理区间
    const days = Number.parseInt(describeLastExport(tenDaysAgo, reference), 10);
    assert.ok(days >= 9 && days <= 11, `期望约 10 天，实际 ${days}`);
  });

  it('书名可以是空串，列表里要有占位文案', () => {
    assert.equal(bookDisplayTitle({ title: '三体', isbn: '9787536692930' }), '三体');
    assert.equal(bookDisplayTitle({ title: '   ', isbn: '9787536692930' }), '（未命名 · 9787536692930）');
    assert.equal(bookDisplayTitle({ title: '', isbn: '' }), '（未命名）');
  });

  it('作者为空时显示佚名，而不是空白', () => {
    assert.equal(authorsText([]), '佚名');
    assert.equal(authorsText(['刘慈欣']), '刘慈欣');
    assert.equal(authorsText(['刘慈欣', '李淼']), '刘慈欣 / 李淼');
  });
});

describe('快照与撤销的展示口径（04 §6、§11.4）', () => {
  const STAMP = '2026-09-13T03:00:00.000Z';

  function bookRow(id: string, title: string): Book {
    return {
      id,
      isbn: '',
      title,
      authors: [],
      publisher: '',
      publishDate: '',
      coverUrl: '',
      tags: [],
      createdAt: STAMP,
      updatedAt: STAMP,
    };
  }

  function copyRow(id: string): Copy {
    return {
      id,
      bookId: 'b1',
      locationId: 'l1',
      status: 'on_shelf',
      condition: 'unknown',
      owner: '',
      note: '',
      createdAt: STAMP,
      updatedAt: STAMP,
    };
  }

  function locationRow(id: string): Location {
    return {
      id,
      parentId: null,
      name: '客厅',
      path: '客厅',
      depth: 1,
      type: 'room',
      sortOrder: 0,
      createdAt: STAMP,
      updatedAt: STAMP,
    };
  }

  /** 只给 data 里真正被删掉的那几段，其余留空 —— 与 captureUndo 的部分数据形状一致（02 §9.1）。 */
  function undoSnapshot(data: Partial<Snapshot['data']>): Snapshot {
    const full: Snapshot['data'] = { locations: [], books: [], copies: [], loans: [], borrowers: [], ...data };
    return {
      id: 'undo-1',
      kind: 'undo',
      createdAt: STAMP,
      summary: {
        locations: full.locations.length,
        books: full.books.length,
        copies: full.copies.length,
        loans: full.loans.length,
        borrowers: full.borrowers.length,
      },
      data: full,
    };
  }

  it('删书目级联：说出书名与连带删掉的副本', () => {
    const text = describeUndo(undoSnapshot({ books: [bookRow('b1', '三体')], copies: [copyRow('c1'), copyRow('c2')] }));
    assert.match(text, /已删除《三体》/);
    assert.match(text, /2 本副本/);
  });

  it('删副本：没有书名时只报副本数，不编一个书名出来', () => {
    assert.equal(describeUndo(undoSnapshot({ copies: [copyRow('c1')] })), '已删除 1 本副本');
  });

  it('删位置级联：位置与副本都算上', () => {
    const text = describeUndo(undoSnapshot({ locations: [locationRow('l1')], copies: [copyRow('c1')] }));
    assert.match(text, /1 个位置/);
    assert.match(text, /1 本副本/);
  });

  it('空快照也给一句人话，不是「已删除」两个字的空话', () => {
    assert.equal(describeUndo(undoSnapshot({})), '已删除一批数据');
  });

  it('计数只列非零项，空快照另说', () => {
    assert.equal(snapshotCountsText(undoSnapshot({}).summary), '没有任何记录');
    assert.equal(
      snapshotCountsText({ locations: 0, books: 12, copies: 15, loans: 0, borrowers: 2 }),
      '12 条书目 · 15 本副本 · 2 位借书人',
    );
  });
});

describe('importSummaryRows', () => {
  const summary: ImportSummary = {
    mode: 'merge',
    dryRun: true,
    locations: { inserted: 2, updated: 1, reparented: 0, conflictingNames: [] },
    books: { inserted: 3, updated: 0, mergedByIsbn: 1 },
    copies: { inserted: 4, updated: 0, skipped: 1, relocated: 2 },
    loans: { inserted: 0, updated: 1, skipped: 0, conflicts: 1 },
    borrowers: { inserted: 0, updated: 0 },
    warnings: [],
    durationMs: 12,
  };

  it('四类数字都出现在摘要行里（01 §8 阶段 E 的验收口径）', () => {
    const text = importSummaryRows(summary)
      .map((row) => `${row.label}：${row.value}`)
      .join('\n');
    assert.match(text, /新增 3/);
    assert.match(text, /更新 0/);
    assert.match(text, /跳过 1/);
    assert.match(text, /按 ISBN 合并 1/);
    assert.match(text, /改到未分类 2/);
  });

  it('预览态明确写出「没有写入任何数据」', () => {
    const rows = importSummaryRows(summary);
    assert.ok(rows.some((row) => row.label === '本次为预览' && row.value === '没有写入任何数据'));
    const applied = importSummaryRows({ ...summary, dryRun: false });
    assert.ok(!applied.some((row) => row.label === '本次为预览'));
  });

  it('重名位置只在非空时出现，且合并成一行', () => {
    assert.ok(!importSummaryRows(summary).some((row) => row.label === '重名位置'));
    const withConflicts = importSummaryRows({
      ...summary,
      locations: { ...summary.locations, conflictingNames: ['客厅', '阳台'] },
    });
    assert.ok(withConflicts.some((row) => row.label === '重名位置' && row.value === '客厅、阳台'));
  });

  it('模式文案区分合并与替换', () => {
    assert.notEqual(IMPORT_MODE_LABELS.merge, IMPORT_MODE_LABELS.replace);
  });
});
