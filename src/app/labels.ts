/**
 * 中文标签与展示格式的唯一来源（04 §5）。
 * 页面只引用这里，不再各自写一遍 —— 否则同一个状态会在三个页面有三种说法。
 *
 * 值域映射用 Record<联合类型, string>：types.ts 里新增枚举值时，
 * 这里编译不过，正是想要的提醒（labels.test.ts 另有断言兜底）。
 */

import type { ImportMode, ImportSummary } from '../backup/format.ts';
import type { DeleteLocationStrategy } from '../db/locations.ts';
import type { ImportField } from '../features/books/import-mapping.ts';
import { joinList } from '../domain/text.ts';
import { daysSince, isTimestampString, toLocalDate, today } from '../domain/time.ts';
import type {
  Book,
  CopyCondition,
  CopyStatus,
  LoanStatus,
  LocationType,
  MatchField,
  Snapshot,
  SnapshotKind,
} from '../domain/types.ts';
import type { Theme } from '../platform/theme.ts';

/* ------------------------------------------------------------------ *
 * 值域 → 中文
 * ------------------------------------------------------------------ */

export const COPY_STATUS_LABELS: Record<CopyStatus, string> = {
  on_shelf: '在架',
  lent_out: '借出',
  lost: '丢失',
  sold: '卖掉',
};

export const COPY_CONDITION_LABELS: Record<CopyCondition, string> = {
  new: '全新',
  good: '良好',
  fair: '一般',
  poor: '较差',
  unknown: '未知',
};

export const LOAN_STATUS_LABELS: Record<LoanStatus, string> = {
  active: '借出中',
  returned: '已归还',
};

export const LOCATION_TYPE_LABELS: Record<LocationType, string> = {
  home: '家',
  room: '房间',
  shelf: '书架',
  layer: '层',
};

export const MATCH_FIELD_LABELS: Record<MatchField, string> = {
  title: '书名',
  author: '作者',
  isbn: 'ISBN',
  tag: '标签',
  publisher: '出版社',
};

/** 批量导入的列映射下拉用的字段名（05 §2.2）。 */
export const IMPORT_FIELD_LABELS: Record<ImportField, string> = {
  title: '书名',
  author: '作者',
  isbn: 'ISBN',
  publisher: '出版社',
  publishDate: '出版日期',
  tags: '标签',
  location: '位置',
  copies: '副本数',
};

export const THEME_LABELS: Record<Theme, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
};

export const IMPORT_MODE_LABELS: Record<ImportMode, string> = {
  merge: '合并：保留本地数据，冲突时本地优先',
  replace: '替换：先清空本机数据，再全部导入',
};

export const DELETE_STRATEGY_LABELS: Record<DeleteLocationStrategy, string> = {
  reparent: '把子位置与副本上移到上级',
  cascade: '连同子位置、副本与借出记录一并删除',
};

export const SNAPSHOT_KIND_LABELS: Record<SnapshotKind, string> = {
  auto: '自动快照',
  undo: '删除撤销',
  'pre-restore': '恢复前快照',
};

export type Tone = 'green' | 'amber' | 'red' | 'gray';

export function copyStatusTone(status: CopyStatus): Tone {
  switch (status) {
    case 'on_shelf':
      return 'green';
    case 'lent_out':
      return 'amber';
    case 'lost':
      return 'red';
    case 'sold':
      return 'gray';
  }
}

/* ------------------------------------------------------------------ *
 * 展示格式
 * ------------------------------------------------------------------ */

const DATE_TIME_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** ISO 时间戳 → 本机可读时间；非法输入返回空串（不显示「Invalid Date」）。 */
export function formatDateTime(iso: string): string {
  if (!isTimestampString(iso)) return '';
  return DATE_TIME_FORMAT.format(new Date(iso));
}

/** 「上次导出：N 天前」（01 §3.2 第 3 条）。 */
export function describeLastExport(iso: string, reference: string = today()): string {
  if (!isTimestampString(iso)) return '从未导出';
  // lastExportAt 是 UTC 时间戳，先折算成本地日历日再比天数
  const days = daysSince(toLocalDate(new Date(iso)), reference);
  if (days <= 0) return '今天';
  return `${days} 天前`;
}

/** 书名允许为空串（02 §3「先存后补」），列表里要有可读的占位。 */
export function bookDisplayTitle(book: Pick<Book, 'title' | 'isbn'>): string {
  if (book.title.trim() !== '') return book.title;
  return book.isbn === '' ? '（未命名）' : `（未命名 · ${book.isbn}）`;
}

export function authorsText(authors: readonly string[]): string {
  return authors.length === 0 ? '佚名' : authors.join(' / ');
}

/** 位置路径为空时的兜底文案（挂在已删除位置等异常数据的展示口径）。 */
export function locationPathText(path: string): string {
  return path === '' ? '位置未知' : path;
}

/** 快照里各表的计数一行（04 §11.4）：只列非零项，空快照给一句说明而不是一排 0。 */
export function snapshotCountsText(summary: Snapshot['summary']): string {
  const parts: string[] = [];
  if (summary.books > 0) parts.push(`${summary.books} 条书目`);
  if (summary.copies > 0) parts.push(`${summary.copies} 本副本`);
  if (summary.locations > 0) parts.push(`${summary.locations} 个位置`);
  if (summary.loans > 0) parts.push(`${summary.loans} 条借出记录`);
  if (summary.borrowers > 0) parts.push(`${summary.borrowers} 位借书人`);
  return parts.length === 0 ? '没有任何记录' : parts.join(' · ');
}

/**
 * 撤销横幅的说明（04 §6「已删除《XX》｜撤销」）：快照里有什么就说什么 ——
 * 删副本、删书目级联、删位置级联三种删除共用这一句，不给每处各写一份文案。
 */
export function describeUndo(snapshot: Snapshot): string {
  const { books, copies, locations, loans } = snapshot.data;
  const gone: string[] = [];
  const only = books[0];
  if (books.length === 1 && only !== undefined) gone.push(`《${bookDisplayTitle(only)}》`);
  else if (books.length > 1) gone.push(`${books.length} 条书目`);
  if (copies.length > 0) gone.push(`${copies.length} 本副本`);
  if (locations.length > 0) gone.push(`${locations.length} 个位置`);

  const first = gone[0];
  if (first === undefined) {
    return loans.length > 0 ? `已删除 ${loans.length} 条借出记录` : '已删除一批数据';
  }
  // 书名号紧贴「已删除」（已删除《三体》）；以数字开头时留一个空格（已删除 1 本副本）
  return `已删除${first.startsWith('《') ? '' : ' '}${gone.join('、')}`;
}

/* ------------------------------------------------------------------ *
 * 导入摘要的行化（03 §7）
 * ------------------------------------------------------------------ */

export interface SummaryRow {
  label: string;
  value: string;
}

export function importSummaryRows(summary: ImportSummary): SummaryRow[] {
  const rows: SummaryRow[] = [
    { label: '模式', value: IMPORT_MODE_LABELS[summary.mode] },
  ];
  if (summary.dryRun) {
    rows.push({ label: '本次为预览', value: '没有写入任何数据' });
  }
  rows.push(
    {
      label: '位置',
      value: `新增 ${summary.locations.inserted} · 更新 ${summary.locations.updated} · 改挂 ${summary.locations.reparented}`,
    },
    {
      label: '书目',
      value: `新增 ${summary.books.inserted} · 更新 ${summary.books.updated} · 按 ISBN 合并 ${summary.books.mergedByIsbn}`,
    },
    {
      label: '副本',
      value: `新增 ${summary.copies.inserted} · 更新 ${summary.copies.updated} · 跳过 ${summary.copies.skipped} · 改到未分类 ${summary.copies.relocated}`,
    },
    {
      label: '借出',
      value: `新增 ${summary.loans.inserted} · 更新 ${summary.loans.updated} · 跳过 ${summary.loans.skipped} · 冲突转归还 ${summary.loans.conflicts}`,
    },
  );
  if (summary.locations.conflictingNames.length > 0) {
    rows.push({ label: '重名位置', value: joinList(summary.locations.conflictingNames) });
  }
  return rows;
}
