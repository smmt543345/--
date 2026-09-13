/**
 * 文本类格式的格式判定与解析（05 §2.1，B4）：分隔符自动探测 + JSON 书单解析。
 *
 * 这一层只做「文件 → 单元格矩阵 / 字段值」的纯计算——不碰 IO、不碰数据库，也不认识
 * `ImportSource`（装配成导入源是 `import.ts` 的事）。所以它能被 `node --test` 直接跑，
 * 也让 `.txt/.md/.tsv/.json` 与 CSV/xlsx 走同一条列映射与预览流水线。
 */

import type { ImportField } from './import-mapping.ts';

/* ------------------------------------------------------------------ *
 * 分隔符自动探测（05 §2.1 口径）
 * ------------------------------------------------------------------ */

/**
 * 候选分隔符，按「越不容易出现在字段内容里越优先」排序：制表符（Excel / 网页复制
 * 出来的表）→ 竖线（markdown 表格）→ 逗号（CSV）→ 连续空格（对齐排版，最容易被
 * 标题里的空格误命中，所以垫底）。`' '` 代表**连续空格**，不是单个空格。
 */
export const TEXT_DELIMITERS = ['\t', '|', ',', ' '] as const;
export type TextDelimiter = (typeof TEXT_DELIMITERS)[number];

/** 探测只看前 20 行（05 §2.1）：书单的形状在表头附近就定性了。 */
export const DETECT_LINES = 20;

/** 各分隔符的切分方式：连续出现按一个算（`a\t\tb` 是两列，不是三列）。 */
const SPLIT_PATTERN: Record<TextDelimiter, RegExp> = {
  '\t': /\t+/,
  '|': /\|+/,
  ',': /,/,
  ' ': /[ \u3000]{2,}/,
};

/**
 * 一行 → 单元格。竖线按 markdown 表格处理：先剥掉两端当边框的 `|`
 * （`| 书名 | 作者 |` 是两列，不是前后各多一个空列）。
 */
export function splitTextRow(line: string, delimiter: TextDelimiter): string[] {
  const text = delimiter === '|' ? line.trim().replace(/^\|/, '').replace(/\|$/, '') : line;
  return text.split(SPLIT_PATTERN[delimiter]).map((cell) => cell.trim());
}

/** 文本 → 单元格矩阵（05 §2.1）。空行保留：行号要对齐原始行（sourceFromMatrix 负责丢空行）。 */
export function textMatrix(text: string, delimiter: TextDelimiter): string[][] {
  return stripBom(text)
    .split(/\r?\n/)
    .map((line) => splitTextRow(line, delimiter));
}

function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, '');
}

/** 探测采样：前 20 行里的非空行——空行不含分隔符信息，留着会让任何候选都不成立。 */
function sampleLines(text: string): string[] {
  return stripBom(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, DETECT_LINES);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/**
 * 自动探测分隔符；探测不出返回 null，由调用方按逗号口径处理（05 §2.1）。
 *
 * 口径（05 §2.1）：取前 20 行的非空行，候选里**每行都出现**、且切分列数中位数 ≥ 2
 * 的第一个。「列数稳定」按中位数判定——不额外要求各行列数完全一致，否则「末行少写
 * 一列」这种常见书单会被误判成探测失败。
 */
export function detectDelimiter(text: string): TextDelimiter | null {
  const lines = sampleLines(text);
  if (lines.length === 0) return null;
  for (const delimiter of TEXT_DELIMITERS) {
    const counts = lines.map((line) => splitTextRow(line, delimiter).length);
    // 有行切不出该分隔符（只有 1 列）→ 它不是这份文件的分隔符
    if (counts.some((count) => count < 2)) continue;
    if (median(counts) >= 2) return delimiter;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 按扩展名分派（05 §2.1）
 * ------------------------------------------------------------------ */

/** 文件选择器接受的扩展名：05 §2.1 列出的全部格式，这里是唯一真源。 */
export const IMPORT_FILE_ACCEPT = '.csv,.txt,.md,.tsv,.json,.xlsx,.xls,.docx';

/** 解析分支；`xlsx` 同时覆盖旧版 `.xls`（SheetJS 两种都读）。 */
export type ImportFileFormat = 'csv' | 'text' | 'json' | 'xlsx' | 'docx';

const EXTENSION_FORMATS: Record<string, ImportFileFormat> = {
  csv: 'csv',
  txt: 'text',
  md: 'text',
  tsv: 'text',
  json: 'json',
  xlsx: 'xlsx',
  xls: 'xlsx',
  docx: 'docx',
};

/**
 * 文件名 → 解析分支（05 §2.1）。不支持的格式抛人话错误，由调用方展示在导入区：
 * `.doc` 是 Word 97-2003 旧格式，读不了，只能提示另存为 `.docx`。
 */
export function formatOfFile(fileName: string): ImportFileFormat {
  const extension = fileName.trim().toLowerCase().split('.').pop() ?? '';
  if (extension === 'doc') {
    throw new Error('.doc 是 Word 97-2003 的旧格式，读不了：请在 Word 里「另存为」.docx，再选那个文件');
  }
  const format = EXTENSION_FORMATS[extension];
  if (format === undefined) {
    throw new Error(`认不出「.${extension}」这种文件；支持 ${IMPORT_FILE_ACCEPT}（.doc 请先另存为 .docx）`);
  }
  return format;
}

/* ------------------------------------------------------------------ *
 * JSON 书单（05 §2.1）
 * ------------------------------------------------------------------ */

/**
 * JSON 的列序、列名与认得的字段名（05 §2.1）：中英文都认。字段名比较前 trim + 转小写，
 * 所以 `ISBN` / `PublishDate` 这类大小写变体同样命中。列名刻意用别名词典认得的词，
 * 于是 json 能和 CSV/xlsx 一样进「列名映射 + 预览」——`import-detect.test.ts` 钉住了这条不变式。
 */
const JSON_COLUMNS: readonly { field: ImportField; header: string; aliases: readonly string[] }[] = [
  { field: 'title', header: '书名', aliases: ['title', '书名'] },
  { field: 'author', header: '作者', aliases: ['author', 'authors', '作者'] },
  { field: 'isbn', header: 'ISBN', aliases: ['isbn'] },
  { field: 'publisher', header: '出版社', aliases: ['publisher', '出版社'] },
  { field: 'publishDate', header: '出版日期', aliases: ['publishdate', '出版日期'] },
  { field: 'tags', header: '标签', aliases: ['tags', '标签'] },
  { field: 'location', header: '位置', aliases: ['location', '位置'] },
  { field: 'copies', header: '副本数', aliases: ['copies', '副本数'] },
];

/** 字段名（含别名）→ 字段；只建一次。 */
const JSON_FIELD_NAMES = new Map<string, ImportField>(
  JSON_COLUMNS.flatMap((column) => column.aliases.map((alias) => [alias, column.field] as const)),
);

/**
 * JSON 文本 → 带表头的单元格矩阵（05 §2.1）：接受一个数组，或 `{ books: [...] }`
 * 包装；不认识的字段忽略。报人话错误（不写库）的三种情况：不是合法 JSON、
 * 最外层不是数组也没有 `books` 数组、数组为空。
 */
export function jsonMatrix(text: string): { header: string[]; rows: string[][] } {
  const books = bookArray(parseJsonText(text));
  if (books === null) {
    throw new Error('JSON 最外层要是一个书目数组，或 { "books": [ ... ] } 包装；现在两者都不是');
  }
  if (books.length === 0) throw new Error('这个 JSON 里一条书目都没有，没有可导入的内容');
  const header = JSON_COLUMNS.map((column) => column.header);
  return { header, rows: books.map((element) => jsonCells(element)) };
}

/** 一条 JSON 书目 → 一条单元格（宽度固定，缺的字段留空串让列映射好对位）。 */
function jsonCells(element: unknown): string[] {
  const cells: string[] = JSON_COLUMNS.map(() => '');
  const book = asRecord(element);
  // 元素不是对象：字符串当书名（`["活着", "三体"]` 这种最简写法）；其余当空行，
  // 由导入源按「空行只跳过、不挤掉行号」处理（05 §2.1）
  if (book === null) {
    if (typeof element === 'string') cells[0] = element.trim();
    return cells;
  }
  for (const [key, value] of Object.entries(book)) {
    const field = JSON_FIELD_NAMES.get(key.trim().toLowerCase());
    if (field === undefined) continue;
    const index = JSON_COLUMNS.findIndex((column) => column.field === field);
    if (index >= 0) cells[index] = cellText(value);
  }
  return cells;
}

/** 字段值 → 单元格文字：字符串 trim、数字/布尔转字符串、数组用顿号拼（标签、多作者）。 */
function cellText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => cellText(item))
      .filter((item) => item !== '')
      .join('、');
  }
  return '';
}

function parseJsonText(text: string): unknown {
  try {
    // 记事本 / Excel 存出来的 JSON 可能带 BOM，先剥掉（同 §2.1 的 CSV 口径）
    return JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`这个文件不是合法的 JSON（${reason}）`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 数组本身，或 `{ books: [...] }` 包装（05 §2.1）；都不是返回 null。 */
function bookArray(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  const books = asRecord(parsed)?.['books'];
  return Array.isArray(books) ? books : null;
}
