/**
 * 批量导入（05 §2）：粘贴文本 / CSV 的解析、去重与批量创建。
 *
 * 纯逻辑放 features 层（.tsx 页面里没法直接跑 node --test），
 * 且「跳过规则」是产品规则，不能散在按钮的 onClick 里。
 */

import { createBook, listBooks, normalizeTitle } from '../../db/books.ts';
import type { PocketLibraryDb } from '../../db/schema.ts';
import { normalizeIsbn } from '../../domain/isbn.ts';
import { parseList } from '../../domain/text.ts';
import { isDateString } from '../../domain/time.ts';

/** 解析后的一行书单。line 是原始行号（1 起），报告里指给人看。 */
export interface ParsedBookRow {
  line: number;
  title: string;
  author: string;
  isbn: string;
  publisher: string;
  publishDate: string;
  tags: string[];
}

export interface BulkImportReport {
  created: number;
  /** 跳过明细（05 §2.2 规则 1–3） */
  skipped: { line: number; reason: string }[];
  /** 疑似重复但已创建（规则 4）：只提示，不阻断 */
  suspected: { line: number; title: string }[];
}

/** 行内分隔符：与 parseList 同一套口径（逗号/顿号/分号/斜杠，全角半角）。 */
const ROW_SPLIT = /[,，、;；/]/;

function clean(raw: string): string {
  return (raw ?? '').trim();
}

/**
 * 「书名，作者，ISBN」及其常见变体（05 §2.1）：
 * - 1 列：书名，或纯 ISBN（能通过 ISBN 校验就按 ISBN 读）
 * - 2 列：书名,作者；若第 2 列是合法 ISBN（书名,ISBN 的常见写单方式），按 ISBN 读
 * - ≥3 列：末列是合法 ISBN 时按 ISBN 读，其余中列合并为作者（多作者用顿号写）；
 *   末列不是 ISBN 时，全部中列并入作者，不产生 ISBN 列
 */
export function parsePasteRow(rawLine: string, line: number): ParsedBookRow {
  const fields = rawLine.split(ROW_SPLIT).map(clean).filter((field) => field !== '');
  let title = fields[0] ?? '';
  let author = '';
  let isbn = '';

  if (fields.length === 1) {
    // 只有一列且本身就是合法 ISBN：按纯 ISBN 行处理（05 §2.1）
    if (normalizeIsbn(title).valid) {
      isbn = title;
      title = '';
    }
  } else {
    const last = fields[fields.length - 1] ?? '';
    if (normalizeIsbn(last).valid) {
      // 末列是合法 ISBN：中列合并为作者
      isbn = last;
      author = fields.slice(1, -1).join('、');
    } else {
      // 末列不是 ISBN：全部中列并入作者（多作者、书名带顿号的情况）
      author = fields.slice(1).join('、');
    }
  }
  return {
    line,
    title,
    author,
    isbn,
    publisher: '',
    publishDate: '',
    tags: [],
  };
}

/** 一行书单是否可用：书名要含文字或数字（纯标点/符号/空白按无效丢），或带合法 ISBN。 */
export function isUsableRow(row: ParsedBookRow): boolean {
  if (normalizeIsbn(row.isbn).isbn13 !== '') return true;
  // ISBN 形状（10/13 位，含 X 校验位）或 9–13 位纯数字但校验不过：
  // 几乎可以肯定是抄错的 ISBN，按无效丢（05 §4）；短数字串（如「1984」）仍是合法书名
  if (/^(?:\d{9,13}|\d{9}[\dXx]|\d{12}[\dXx])$/.test(row.title) && !normalizeIsbn(row.title).valid) return false;
  // \p{Nd} 只认十进制数字：带圈序号（①②）属于 No 类，不该把一行序号当书名
  return /[\p{L}\p{Nd}]/u.test(row.title);
}

export function parsePasteText(text: string): ParsedBookRow[] {
  return text
    .split(/\r?\n/)
    .map((line, index) => parsePasteRow(line, index + 1))
    .filter(isUsableRow);
}

/* ------------------------------------------------------------------ *
 * CSV
 * ------------------------------------------------------------------ */

/** 最小 CSV 解析：引号包裹（引号内逗号不算分隔、"" 转义）、BOM 剥离。 */
export function parseCsvLine(rawLine: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < rawLine.length; i += 1) {
    const char = rawLine[i];
    if (inQuotes) {
      if (char === '"' && rawLine[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"' && current === '') {
      inQuotes = true;
    } else if (char === ',') {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

const HEADER_ALIASES: Record<string, keyof ParsedBookRow> = {
  title: 'title',
  author: 'author',
  isbn: 'isbn',
  publisher: 'publisher',
  publishdate: 'publishDate',
  tags: 'tags',
};

function looksLikeHeader(cells: string[]): boolean {
  return cells.some((cell) => HEADER_ALIASES[clean(cell).toLowerCase()] !== undefined);
}

/** CSV → 行。有表头按列名对位（多余列忽略），无表头按 书名,作者,ISBN 三列读。 */
export function parseCsvText(text: string): ParsedBookRow[] {
  const body = text.replace(/^\uFEFF/, '');
  const lines = body.split(/\r?\n/);
  if (lines.length === 0) return [];

  const rows: ParsedBookRow[] = [];
  const first = parseCsvLine(lines[0] ?? '');
  const hasHeader = looksLikeHeader(first);
  const headerMap = hasHeader
    ? new Map(first.map((cell, index) => [HEADER_ALIASES[clean(cell).toLowerCase()] ?? '', index]))
    : undefined;

  for (let i = hasHeader ? 1 : 0; i < lines.length; i += 1) {
    // 行号必须对应原始文件行（05 §2.3）：空白行只是跳过，不能把编号挤掉
    const rawLine = lines[i] ?? '';
    if (rawLine.trim() === '') continue;
    const cells = parseCsvLine(rawLine);
    const pick = (field: keyof ParsedBookRow): string => {
      if (headerMap === undefined) {
        // 无表头：书名,作者,ISBN
        if (field === 'title') return cells[0] ?? '';
        if (field === 'author') return cells[1] ?? '';
        if (field === 'isbn') return cells[2] ?? '';
        return '';
      }
      const index = headerMap.get(field);
      return index === undefined ? '' : (cells[index] ?? '');
    };
    const row: ParsedBookRow = {
      line: i + 1,
      title: clean(pick('title')),
      author: clean(pick('author')),
      isbn: clean(pick('isbn')),
      publisher: clean(pick('publisher')),
      publishDate: clean(pick('publishDate')),
      tags: parseList(pick('tags')),
    };
    if (isUsableRow(row)) rows.push(row);
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * 批量创建（05 §2.2 跳过规则）
 * ------------------------------------------------------------------ */

export async function bulkImportBooks(db: PocketLibraryDb, rows: ParsedBookRow[]): Promise<BulkImportReport> {
  const report: BulkImportReport = { created: 0, skipped: [], suspected: [] };

  const existing = await listBooks(db);
  const libraryIsbns = new Set<string>();
  const libraryTitles = new Set<string>();
  for (const book of existing) {
    const key = normalizeTitle(book.title);
    if (key !== '') libraryTitles.add(key);
  }
  for (const book of existing) {
    const isbn13 = normalizeIsbn(book.isbn).isbn13;
    if (isbn13 !== '') libraryIsbns.add(isbn13);
  }

  const batchTitles = new Set<string>();
  const batchIsbns = new Set<string>();

  for (const row of rows) {
    const titleKey = normalizeTitle(row.title);
    const isbn13 = normalizeIsbn(row.isbn).isbn13;

    if (titleKey === '' && isbn13 === '') {
      report.skipped.push({ line: row.line, reason: '无法识别（没有书名也没有 ISBN）' });
      continue;
    }
    if (isbn13 !== '' && batchIsbns.has(isbn13)) {
      report.skipped.push({ line: row.line, reason: '本批内已有同样 ISBN' });
      continue;
    }
    if (titleKey !== '' && batchTitles.has(titleKey)) {
      report.skipped.push({ line: row.line, reason: '本批内已有同名书目' });
      continue;
    }
    if (isbn13 !== '' && libraryIsbns.has(isbn13)) {
      report.skipped.push({ line: row.line, reason: `库里已有同样 ISBN 的书（${row.isbn}）` });
      continue;
    }

    try {
      const author = clean(row.author);
      await createBook(db, {
        title: row.title,
        isbn: row.isbn,
        authors: author === '' ? [] : [author],
        publisher: row.publisher,
        publishDate: isDateString(row.publishDate) ? row.publishDate : '',
        tags: row.tags,
      });
    } catch (error) {
      report.skipped.push({ line: row.line, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }

    report.created += 1;
    if (titleKey !== '') batchTitles.add(titleKey);
    if (isbn13 !== '') batchIsbns.add(isbn13);
    // 规则 4：库内同名（规范化后）→ 已建，仅提示（02 §10.1 口径：同名但 ISBN 不同）。
    // 同 ISBN 的在规则 3 已被跳过，走到这里必然不是同名同 ISBN，直接标记
    if (titleKey !== '' && libraryTitles.has(titleKey)) {
      report.suspected.push({ line: row.line, title: row.title });
    }
  }

  return report;
}
