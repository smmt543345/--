/**
 * 批量导入（05 §2）：粘贴文本 / CSV / xlsx 的解析、列映射、去重与批量创建。
 *
 * 纯逻辑放 features 层（.tsx 页面里没法直接跑 node --test），且「跳过规则」与
 * 「批量默认值」是产品规则，不能散在按钮的 onClick 里。列名别名词典与列映射在
 * `import-mapping.ts`（05 §2.2），SheetJS 的调用在 `xlsx.ts`（05 §2.1）。
 *
 * 数据流：三种入口 → `ImportSource`（原始表格 + 列映射）→ `ParsedBookRow[]` →
 * `bulkImportBooks`。中间那一步可重入 —— 预览里改了映射就重新解析一次，
 * 不必回头再读文件（04 §11.1）。
 */

import { createBook, listBooks, normalizeTitle } from '../../db/books.ts';
import { createCopy } from '../../db/copies.ts';
import { createLocation, listLocations } from '../../db/locations.ts';
import type { PocketLibraryDb } from '../../db/schema.ts';
import { UNSORTED_LOCATION_ID } from '../../domain/ids.ts';
import { normalizeIsbn } from '../../domain/isbn.ts';
import { parseList } from '../../domain/text.ts';
import { isDateString } from '../../domain/time.ts';
import type { Book, CopyCondition } from '../../domain/types.ts';
import {
  buildColumnMapping,
  cellFor,
  defaultColumnMapping,
  isHeaderRow,
  parseCopiesCell,
  type ColumnMapping,
} from './import-mapping.ts';
import { MAX_INITIAL_COUNT } from './write.ts';

/* ------------------------------------------------------------------ *
 * 行与报告
 * ------------------------------------------------------------------ */

/** 解析后的一行书单。line 是原始行号（1 起），报告里指给人看。 */
export interface ParsedBookRow {
  line: number;
  title: string;
  author: string;
  isbn: string;
  publisher: string;
  publishDate: string;
  tags: string[];
  /** 位置名（05 §2.2）；空串 = 用批量默认位置 */
  location: string;
  /** 副本数（05 §2.2）；null = 用批量默认副本数，0 = 只建书目 */
  copies: number | null;
}

export interface BulkImportReport {
  /** 成功新建的书目数 */
  created: number;
  /** 实际建成的副本总数（05 §2.4，P0-1） */
  copiesCreated: number;
  /** 跳过明细（05 §2.3 规则 1–3） */
  skipped: { line: number; reason: string }[];
  /** 疑似重复但已创建（规则 4）：只提示，不阻断 */
  suspected: { line: number; title: string }[];
  /**
   * 已创建、但有需要说明的情况：副本数截断、位置建不出来（05 §2.2 规则 4/5
   * 「记入报告」）。**不是跳过** —— 这些行的书目已经建好了，所以不能混进
   * `skipped`（那会让「跳过 N 条」的数字骗人）。
   */
  warnings: { line: number; reason: string }[];
}

export interface BulkImportDefaults {
  /** 默认位置 id；空串/未给 = 「未分类」（05 §2.2 规则 3）。行里写了位置名时按行的 */
  locationId?: string;
  /** 默认副本数（默认 1；0 = 只建书目不建副本） */
  copies?: number;
  /** 默认品相（默认「新」）。createCopy 自己的兜底是「未知」，这里必须显式传 */
  condition?: CopyCondition;
}

/* ------------------------------------------------------------------ *
 * 导入源（预览的数据侧，04 §11.1）
 * ------------------------------------------------------------------ */

export type ImportKind = 'paste' | 'csv' | 'xlsx';

/** 源里的一行：line 是原始行号，cells 是拆好的单元格。 */
export interface SheetRow {
  line: number;
  cells: string[];
}

/**
 * 解析后的导入源 = 原始表格 + 列映射。预览要展示「第 N 列 → 字段」并能手动改
 * （04 §11.1），改完重新 `rowsFromSource` 即可 —— 文件只读一次。
 *
 * `mapping === null` 表示「位置推定」形态：无表头的粘贴文本（05 §2.1），
 * 行内语义（末列按 ISBN 读、中列并成作者）只有 parsePasteRow 知道，
 * 此时 `rows[i].cells[0]` 存的是**整行原文**。
 */
export interface ImportSource {
  kind: ImportKind;
  name: string;
  /** 表头单元格；null = 无表头 */
  header: string[] | null;
  /** 列映射；null = 位置推定（不提供改映射） */
  mapping: ColumnMapping | null;
  rows: SheetRow[];
}

/** 行内分隔符：与 parseList 同一套口径（逗号/顿号/分号/斜杠，全角半角）。 */
const ROW_SPLIT = /[,，、;；/]/;

function clean(raw: string): string {
  return (raw ?? '').trim();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 粘贴行 → 单元格。空列不丢（表头识别与列号对齐都靠位置）。 */
function splitPasteLine(rawLine: string): string[] {
  return rawLine.split(ROW_SPLIT).map(clean);
}

/* ------------------------------------------------------------------ *
 * 粘贴文本（05 §2.1）
 * ------------------------------------------------------------------ */

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
  return { line, title, author, isbn, publisher: '', publishDate: '', tags: [], location: '', copies: null };
}

/**
 * 粘贴文本 → 导入源。首行命中别名词典时按列名映射（贴的是带表头的表格），
 * 否则走位置推定 —— 整行原文交给 `parsePasteRow`，分隔符口径只留一份。
 */
export function sourceFromPaste(text: string): ImportSource {
  const lines = text.split(/\r?\n/);
  const header = splitPasteLine(lines[0] ?? '');
  if (isHeaderRow(header)) {
    return {
      kind: 'paste',
      name: '粘贴文本',
      header,
      mapping: buildColumnMapping(header),
      rows: lines
        .slice(1)
        .map((line, index) => ({ line: index + 2, cells: splitPasteLine(line) }))
        .filter((row) => row.cells.some((cell) => cell !== '')),
    };
  }
  return {
    kind: 'paste',
    name: '粘贴文本',
    header: null,
    mapping: null,
    rows: lines.map((line, index) => ({ line: index + 1, cells: [line] })),
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
  return rowsFromSource(sourceFromPaste(text));
}

/* ------------------------------------------------------------------ *
 * CSV 与单元格矩阵（05 §2.1）
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

/** CSV 文本 → 导入源：BOM 剥离、字段两侧 trim、可选表头（05 §2.1）。 */
export function sourceFromCsv(text: string, name = 'CSV 文件'): ImportSource {
  const body = text.replace(/^\uFEFF/, '');
  const matrix = body.split(/\r?\n/).map((line) => parseCsvLine(line).map(clean));
  return sourceFromMatrix(matrix, name, 'csv');
}

/**
 * 单元格矩阵 → 导入源（CSV 与 xlsx 共用，05 §2.1）：
 * 首行命中别名词典就当表头走别名识别，否则整表按 书名,作者,ISBN 三列读
 * （映射仍可改，见 04 §11.1）。**空行只跳过、不挤掉行号** —— 报告要指原始行。
 */
export function sourceFromMatrix(
  cells: readonly (readonly string[])[],
  name: string,
  kind: ImportKind = 'csv',
): ImportSource {
  const first = cells[0];
  const hasHeader = first !== undefined && isHeaderRow(first);
  const rows: SheetRow[] = [];
  for (let i = hasHeader ? 1 : 0; i < cells.length; i += 1) {
    const row = cells[i] ?? [];
    if (row.every((cell) => clean(cell) === '')) continue;
    rows.push({ line: i + 1, cells: row.map(clean) });
  }
  return hasHeader
    ? { kind, name, header: (first ?? []).map(clean), mapping: buildColumnMapping(first ?? []), rows }
    : { kind, name, header: null, mapping: defaultColumnMapping(), rows };
}

/** 单元格 → 行（按列映射取值）。publishDate 的合法性由 bulkImportBooks 判（02 §7.3）。 */
export function rowFromCells(cells: readonly string[], mapping: ColumnMapping, line: number): ParsedBookRow {
  return {
    line,
    title: cellFor(cells, mapping, 'title'),
    author: cellFor(cells, mapping, 'author'),
    isbn: cellFor(cells, mapping, 'isbn'),
    publisher: cellFor(cells, mapping, 'publisher'),
    publishDate: cellFor(cells, mapping, 'publishDate'),
    tags: parseList(cellFor(cells, mapping, 'tags')),
    location: cellFor(cells, mapping, 'location'),
    copies: parseCopiesCell(cellFor(cells, mapping, 'copies')),
  };
}

export function parseCsvText(text: string): ParsedBookRow[] {
  return rowsFromSource(sourceFromCsv(text));
}

/**
 * 导入源 → 行：唯一的解析入口（预览与执行共用）。
 * 有映射按列取值；位置推定的粘贴走整行原文。两边都过滤掉不可用行
 * （05 §2.3 规则 1 在解析期就生效）。
 */
export function rowsFromSource(source: ImportSource, mapping: ColumnMapping | null = source.mapping): ParsedBookRow[] {
  return source.rows
    .map((row) =>
      mapping === null ? parsePasteRow(row.cells[0] ?? '', row.line) : rowFromCells(row.cells, mapping, row.line),
    )
    .filter(isUsableRow);
}

/* ------------------------------------------------------------------ *
 * 批量创建（05 §2.2 默认值 / §2.3 跳过规则 / §2.4 报告）
 * ------------------------------------------------------------------ */

/** 默认位置：空串或已被删除 → 「未分类」（02 §7.2 的保留行，必然存在）。 */
async function resolveDefaultLocation(db: PocketLibraryDb, locationId: string | undefined): Promise<string> {
  const id = clean(locationId ?? '');
  if (id === '' || id === UNSORTED_LOCATION_ID) return UNSORTED_LOCATION_ID;
  const location = await db.locations.get(id);
  return location === undefined ? UNSORTED_LOCATION_ID : id;
}

/** 默认副本数：未给 / 非法 → 1（05 §2.2 规则 3）。超上限的默认值直接截断，不记报告。 */
function pickDefaultCopies(raw: number | undefined): number {
  if (raw === undefined || !Number.isInteger(raw) || raw < 0) return 1;
  return Math.min(raw, MAX_INITIAL_COUNT);
}

/** 行内副本数：非法 → 视为未填（用默认，规则 5）；超过上限 → 截断并记入报告。 */
function pickRowCopies(row: ParsedBookRow, defaultCopies: number, report: BulkImportReport): number {
  const value = row.copies;
  if (value === null || !Number.isInteger(value) || value < 0) return defaultCopies;
  if (value > MAX_INITIAL_COUNT) {
    report.warnings.push({
      line: row.line,
      reason: `副本数 ${value} 超过上限，已按 ${MAX_INITIAL_COUNT} 截断`,
    });
    return MAX_INITIAL_COUNT;
  }
  return value;
}

interface RowContext {
  defaultLocationId: string;
  locationIdByName: Map<string, string>;
}

/**
 * 行内位置名 → 位置 id。05 §2.2 规则 4：库里没有这个名字就**自动新建为顶层位置**
 * （parentId = null，路径由 createLocation 内的 rebuildLocationPaths 物化），
 * 不提示；建不出来（如空名）才记入报告并返回 null。
 */
async function resolveRowLocation(
  db: PocketLibraryDb,
  row: ParsedBookRow,
  context: RowContext,
  report: BulkImportReport,
): Promise<string | null> {
  const name = clean(row.location);
  if (name === '') return context.defaultLocationId;
  const known = context.locationIdByName.get(name);
  if (known !== undefined) return known;
  try {
    const created = await createLocation(db, { name, parentId: null });
    context.locationIdByName.set(name, created.id);
    return created.id;
  } catch (error) {
    report.warnings.push({
      line: row.line,
      reason: `位置「${name}」没能建出来（${message(error)}），这本书的副本没有创建`,
    });
    return null;
  }
}

/** 逐本建副本。单条失败不中断整批：报告里的 copiesCreated 如实反映实际建成的数量。 */
async function createRowCopies(
  db: PocketLibraryDb,
  row: ParsedBookRow,
  book: Book,
  plan: { copies: number; condition: CopyCondition; context: RowContext },
  report: BulkImportReport,
): Promise<void> {
  if (plan.copies <= 0) return;
  const locationId = await resolveRowLocation(db, row, plan.context, report);
  if (locationId === null) return;
  for (let i = 0; i < plan.copies; i += 1) {
    try {
      await createCopy(db, { bookId: book.id, locationId, condition: plan.condition });
      report.copiesCreated += 1;
    } catch (error) {
      report.warnings.push({ line: row.line, reason: `副本只建成 ${i} 本：${message(error)}` });
      return;
    }
  }
}

/**
 * 批量创建（05 §2.3 顺序判定 + §2.2 默认值 + §2.4 报告）。
 *
 * 逐条走 `createBook` / `createCopy`：两者各自带事务与写计数器，批量层不再包事务
 * ——单条失败（如校验不过）只记为跳过，整批继续（05 §1「失败不中断」）。
 */
export async function bulkImportBooks(
  db: PocketLibraryDb,
  rows: readonly ParsedBookRow[],
  defaults: BulkImportDefaults = {},
): Promise<BulkImportReport> {
  const report: BulkImportReport = { created: 0, copiesCreated: 0, skipped: [], suspected: [], warnings: [] };
  const defaultCopies = pickDefaultCopies(defaults.copies);
  const condition = defaults.condition ?? 'new';
  const context: RowContext = {
    defaultLocationId: await resolveDefaultLocation(db, defaults.locationId),
    // 位置按**名字**解析（行里写的是名字）：本批新建的也要能被后面的行命中
    locationIdByName: new Map<string, string>(),
  };
  for (const location of await listLocations(db)) {
    if (!context.locationIdByName.has(location.name)) context.locationIdByName.set(location.name, location.id);
  }

  const libraryTitles = new Set<string>();
  const libraryIsbns = new Set<string>();
  for (const book of await listBooks(db)) {
    const titleKey = normalizeTitle(book.title);
    if (titleKey !== '') libraryTitles.add(titleKey);
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

    const copies = pickRowCopies(row, defaultCopies, report);
    let book: Book | null = null;
    try {
      const author = clean(row.author);
      book = await createBook(db, {
        title: row.title,
        isbn: row.isbn,
        authors: author === '' ? [] : [author],
        publisher: row.publisher,
        publishDate: isDateString(row.publishDate) ? row.publishDate : '',
        tags: row.tags,
      });
    } catch (error) {
      report.skipped.push({ line: row.line, reason: message(error) });
      continue;
    }
    if (book === null) continue;

    report.created += 1;
    if (titleKey !== '') batchTitles.add(titleKey);
    if (isbn13 !== '') batchIsbns.add(isbn13);
    // 规则 4：库内同名（规范化后）→ 已建，仅提示（02 §10.1 口径：同名但 ISBN 不同）。
    // 同 ISBN 的在规则 3 已被跳过，走到这里必然不是同名同 ISBN，直接标记
    if (titleKey !== '' && libraryTitles.has(titleKey)) {
      report.suspected.push({ line: row.line, title: row.title });
    }

    await createRowCopies(db, row, book, { copies, condition, context }, report);
  }

  return report;
}
