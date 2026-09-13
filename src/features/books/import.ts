/**
 * 批量导入（05 §2.2 默认值 / §2.3 跳过规则 / §2.4 报告）· 写库半：`ParsedBookRow[]` → 库。
 *
 * 按 01 §5.2 的 >500 行拆分，原先的 `import.ts` 现已切成三块：`import-source.ts` 与
 * `import-text.ts` 是**纯解析**（切表、列映射、行内语义），本文件是**批量创建**（跳过规则、
 * 默认值、报告）。三者变化的原因不同 —— 加一种书单格式只动那两个，改去重口径只动本文件。
 * 解析入口在本文件原样转出（`export ... from`），所以调用方（`BulkImportSection.tsx`、
 * `xlsx.ts`、`docx.ts`）按老路径 `./import.ts` import 即可。
 *
 * 逐条创建而不是整批一个事务：`createBook` / `createCopy` 各自带事务与写计数器，
 * 单条失败（如校验不过）只记为跳过，不中断整批（05 §1「失败不中断」）。
 */

import { createBook, listBooks, normalizeTitle } from '../../db/books.ts';
import { createCopy } from '../../db/copies.ts';
import { createLocation, listLocations } from '../../db/locations.ts';
import type { PocketLibraryDb } from '../../db/schema.ts';
import { UNSORTED_LOCATION_ID } from '../../domain/ids.ts';
import { normalizeIsbn } from '../../domain/isbn.ts';
import { isDateString } from '../../domain/time.ts';
import type { Book, CopyCondition } from '../../domain/types.ts';
import { clean, type ParsedBookRow } from './import-source.ts';
import { MAX_INITIAL_COUNT } from './write.ts';

/* ------------------------------------------------------------------ *
 * 解析入口的转出（拆分的边界不外泄）
 * ------------------------------------------------------------------ */

export {
  isUsableRow,
  parseCsvLine,
  parseCsvText,
  parsePasteRow,
  parsePasteText,
  rowFromCells,
  rowsFromCells,
  rowsFromSource,
  sourceFromCsv,
  sourceFromMatrix,
  sourceFromPaste,
  splitRowCells,
} from './import-source.ts';
/** 文本类与 JSON 的入口在 `import-text.ts`（同一个拆分的第二层）。 */
export { parseJsonFile, parseTextFile, sourceFromJson, sourceFromText } from './import-text.ts';
export type { ImportKind, ImportSource, ParsedBookRow, SheetRow } from './import-source.ts';

/* ------------------------------------------------------------------ *
 * 报告与批量默认值
 * ------------------------------------------------------------------ */

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
 * 批量创建（05 §2.2 默认值 / §2.3 跳过规则 / §2.4 报告）
 * ------------------------------------------------------------------ */

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
