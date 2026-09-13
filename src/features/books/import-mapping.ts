/**
 * 批量导入的列名映射（05 §2.2）。
 *
 * 用户的书单来自各处导出（Excel、豆瓣、书店下单页），同一列的写法五花八门：
 * 「名称」「题名」「书名」说的是同一列。这一层只做两件事——**认表头**（别名词典）
 * 与**按映射取值**；它不认识 IO，也不认识 `ParsedBookRow`，所以能被 `node --test`
 * 直接测。行语义与写库在 `import.ts`。
 */

import { normalizeDigits } from '../../domain/text.ts';

/* ------------------------------------------------------------------ *
 * 字段与别名词典
 * ------------------------------------------------------------------ */

export const IMPORT_FIELDS = [
  'title',
  'author',
  'isbn',
  'publisher',
  'publishDate',
  'tags',
  'location',
  'copies',
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

/**
 * 别名词典（05 §2.2 表）。比较前统一 trim + 转小写，所以这里只列小写形态
 * （表里的 `ISBN` / `publishDate` 各因此只剩一条）。
 */
export const HEADER_ALIASES: Record<ImportField, readonly string[]> = {
  title: ['title', '书名', '名称', '题名', '书'],
  author: ['author', '作者', '著者', '编者'],
  isbn: ['isbn'],
  publisher: ['publisher', '出版社', '出版'],
  publishDate: ['publishdate', '出版日期', '出版时间', '出版年', '年份'],
  tags: ['tags', 'tag', '标签', '分类', '类别'],
  location: ['location', '位置', '存放地', '存放位置', '书架', '地点'],
  copies: ['copies', 'count', '副本数', '册数', '数量', '本数'],
};

/** 表头单元格 → 字段；识别不出返回 null（05 §2.2 规则 1：识别不出的列忽略）。 */
export function matchHeaderCell(cell: string): ImportField | null {
  const text = cell.trim().toLowerCase();
  if (text === '') return null;
  for (const field of IMPORT_FIELDS) {
    if (HEADER_ALIASES[field].includes(text)) return field;
  }
  return null;
}

/** 首行是不是表头行：至少一列命中词典（05 §2.1「可选表头行，按内容识别」）。 */
export function isHeaderRow(cells: readonly string[]): boolean {
  return cells.some((cell) => matchHeaderCell(cell) !== null);
}

/* ------------------------------------------------------------------ *
 * 列映射
 * ------------------------------------------------------------------ */

/**
 * 列映射：下标 = 列序号（0 起），值 = 字段；`null` = 该列不参与导入（忽略此列）。
 * 用数组而不是 Map：列本来就是有序的，预览要按列号逐列渲染下拉。
 */
export type ColumnMapping = readonly (ImportField | null)[];

/** 表头单元格 → 列映射（未识别的列在结果里是 null）。 */
export function buildColumnMapping(header: readonly string[]): ColumnMapping {
  return header.map((cell) => matchHeaderCell(cell));
}

/** 无表头时的默认三列（05 §2.1：书名,作者,ISBN）。每次返回新数组，避免被改到共享常量。 */
export function defaultColumnMapping(): ColumnMapping {
  return ['title', 'author', 'isbn'];
}

/**
 * 手动改某一列的映射（04 §11.1 的下拉，含「忽略此列」= null）。
 * 列号超出当前映射长度时补 null —— 数据行比表头宽时，用户仍能改到多出来的列。
 */
export function setColumnField(
  mapping: ColumnMapping,
  columnIndex: number,
  field: ImportField | null,
): ColumnMapping {
  const next = mapping.slice();
  while (next.length <= columnIndex) next.push(null);
  next[columnIndex] = field;
  return next;
}

/**
 * 取一行里某字段的原始单元格文字（trim 后）。
 * 该列未映射、或这一行没这么多列 → 空串（空单元格 = 未填，05 §2.1）。
 * 同一字段被映射到多列时取最左边那列——预览里看得见，不需要额外规则。
 */
export function cellFor(cells: readonly string[], mapping: ColumnMapping, field: ImportField): string {
  const index = mapping.indexOf(field);
  if (index < 0) return '';
  return (cells[index] ?? '').trim();
}

/* ------------------------------------------------------------------ *
 * 单元格 → 字段值
 * ------------------------------------------------------------------ */

/**
 * 副本数列（05 §2.2 规则 5）：只认非负整数，其余（空、小数、负数、文字）当作
 * **未填** → 由批量层回退默认值，不跳过该行。`0` 是合法值（只建书目不建副本）。
 *
 * 超过上限的值**原样返回**：截断与「记入报告」是批量层的规则，解析层不吞掉它，
 * 否则用户永远看不到自己填的 999 被改成了 99。
 */
export function parseCopiesCell(raw: string): number | null {
  const text = normalizeDigits(raw).trim();
  if (!/^\d+$/.test(text)) return null;
  return Number(text);
}
