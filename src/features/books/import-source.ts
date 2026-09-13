/**
 * 批量导入（05 §2）· 解析半：各种入口 → `ImportSource`（原始表格 + 列映射）→ `ParsedBookRow[]`。
 *
 * 自 `import.ts` 拆出（01 §5.2 的 >500 行拆分）：这一半是**纯解析**——分隔符探测、切表、
 * 列映射、行内语义；另一半（`import.ts`）是**写库规则**——跳过规则、批量默认值、报告。
 * 两者的变化原因不同：加一种书单格式只动这里，改去重口径只动 import.ts。
 *
 * 纯逻辑放 features 层（.tsx 页面里没法直接跑 node --test）：列名别名词典在
 * `import-mapping.ts`（05 §2.2），各格式解析器只负责产出「单元格 / 字段值」——
 * 分隔符探测与 JSON 在 `import-detect.ts`、SheetJS 在 `xlsx.ts`、Word 在 `docx.ts`。
 *
 * 中间那一步可重入：预览里改了映射就重新 `rowsFromSource` 一次，不必回头再读文件（04 §11.1）。
 */

import { normalizeIsbn } from '../../domain/isbn.ts';
import { parseList } from '../../domain/text.ts';
import {
  buildColumnMapping,
  cellFor,
  defaultColumnMapping,
  isHeaderRow,
  parseCopiesCell,
  type ColumnMapping,
} from './import-mapping.ts';

/* ------------------------------------------------------------------ *
 * 行与导入源
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

export type ImportKind = 'paste' | 'csv' | 'text' | 'json' | 'xlsx' | 'docx';

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

/* ------------------------------------------------------------------ *
 * 共用口径
 * ------------------------------------------------------------------ */

/** 行内分隔符：与 parseList 同一套口径（逗号/顿号/分号/斜杠，全角半角）。 */
const ROW_SPLIT = /[,，、;；/]/;

/** 字段两侧空白一律 trim（05 §2.1）；`import.ts` 建书时也用它。 */
export function clean(raw: string): string {
  return (raw ?? '').trim();
}

/**
 * 文本行 → 单元格（05 §2.1 的「逗号口径」：全角/半角逗号、顿号、分号、斜杠）。
 * 粘贴进来的书单与 docx 的散段共用这一份口径；空列不丢（表头识别与列号对齐都靠位置）。
 */
export function splitRowCells(rawLine: string): string[] {
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
export function sourceFromPaste(text: string, name = '粘贴文本'): ImportSource {
  const lines = text.split(/\r?\n/);
  const header = splitRowCells(lines[0] ?? '');
  if (isHeaderRow(header)) {
    return {
      kind: 'paste',
      name,
      header,
      mapping: buildColumnMapping(header),
      rows: lines
        .slice(1)
        .map((line, index) => ({ line: index + 2, cells: splitRowCells(line) }))
        .filter((row) => row.cells.some((cell) => cell !== '')),
    };
  }
  return {
    kind: 'paste',
    name,
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
 * 单元格矩阵 → 导入源（CSV / xlsx / docx 共用，05 §2.1）：
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
 * 表格类输入（xlsx / docx，05 §2.1）
 * ------------------------------------------------------------------ */

/**
 * 表格类输入（xlsx / docx）→ 行：首行是表头就按别名映射，否则按「书名,作者,ISBN」
 * 三列读（05 §2.1）。表格解析器只负责产出单元格，行语义统一从这里进。
 */
export function rowsFromCells(
  cells: readonly (readonly string[])[],
  name = '表格文件',
  kind: ImportKind = 'xlsx',
): ParsedBookRow[] {
  return rowsFromSource(sourceFromMatrix(cells, name, kind));
}
