/**
 * 备份文件格式：类型、校验、序列化、清洗。
 * 规范见 docs/design/03-backup-and-merge.md §2、§3、§7、§9。
 */

import { isValidId } from '../domain/ids.ts';
import { earliest, isDateString, isTimestampString, nowIso } from '../domain/time.ts';
import {
  COPY_CONDITIONS,
  COPY_STATUSES,
  LOCATION_TYPES,
  LOAN_STATUSES,
  type Book,
  type Borrower,
  type Copy,
  type CopyCondition,
  type CopyStatus,
  type Loan,
  type LoanStatus,
  type Location,
  type LocationType,
} from '../domain/types.ts';
import { SCHEMA_VERSION } from '../db/schema.ts';

export const BACKUP_FORMAT = 'pocket-library-backup';
export const BACKUP_FORMAT_VERSION = 1;

export interface BackupCounts {
  locations: number;
  books: number;
  copies: number;
  loans: number;
  borrowers: number;
}

export interface BackupData {
  locations: Location[];
  books: Book[];
  copies: Copy[];
  loans: Loan[];
  /** P0-3 新增段（02 §5.5）；老文件缺省视为空数组（§3.1） */
  borrowers: Borrower[];
}

export interface BackupFile {
  format: string;
  formatVersion: number;
  schemaVersion: number;
  exportedAt: string;
  /** 仅用于摘要展示，导入时忽略 */
  deviceName: string;
  counts: BackupCounts;
  data: BackupData;
}

export type ImportMode = 'merge' | 'replace';

export interface ImportOptions {
  mode?: ImportMode;
  /** 解析阶段产生的警告，会并入摘要 */
  parseWarnings?: string[];
}

export interface ImportSummary {
  mode: ImportMode;
  dryRun: boolean;
  locations: { inserted: number; updated: number; reparented: number; conflictingNames: string[] };
  books: { inserted: number; updated: number; mergedByIsbn: number };
  copies: { inserted: number; updated: number; skipped: number; relocated: number };
  loans: { inserted: number; updated: number; skipped: number; conflicts: number };
  /** P0-3（02 §5.5） */
  borrowers: { inserted: number; updated: number };
  /** 人话，可直接展示给用户；每一条都说明"是哪条、为什么" */
  warnings: string[];
  durationMs: number;
}

export type ParseResult =
  | { ok: true; backup: BackupFile; warnings: string[] }
  | { ok: false; error: string };

/* ------------------------------------------------------------------ *
 * 警告收集：去重 + 封顶，避免一个坏文件刷出上千行提示
 * ------------------------------------------------------------------ */

const WARNING_LIMIT = 200;

export interface WarningCollector {
  add(message: string): void;
  list(): string[];
}

export function createWarningCollector(initial: readonly string[] = []): WarningCollector {
  const items: string[] = [];
  const seen = new Set<string>();
  let dropped = 0;

  const push = (message: string): void => {
    if (message === '' || seen.has(message)) return;
    seen.add(message);
    if (items.length >= WARNING_LIMIT) {
      dropped += 1;
      return;
    }
    items.push(message);
  };

  for (const message of initial) push(message);

  return {
    add: push,
    list: () => (dropped === 0 ? [...items] : [...items, `另有 ${dropped} 条同类提示被省略`]),
  };
}

/* ------------------------------------------------------------------ *
 * 深比较：导入幂等性依赖"合并后是否真的变了"的判断（03 §5.1、§8）
 * ------------------------------------------------------------------ */

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
}

/** 并集 + 去重 + 稳定排序（标签合并用，结果可比较）。 */
export function unionSorted(a: readonly string[], b: readonly string[]): string[] {
  const set = new Set<string>();
  for (const item of a) if (typeof item === 'string' && item !== '') set.add(item);
  for (const item of b) if (typeof item === 'string' && item !== '') set.add(item);
  return [...set].sort((x, y) => x.localeCompare(y, 'zh'));
}

/** 可合并记录的公共字段（03 §5.1）。 */
export interface Mergeable {
  id: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 字段级合并（03 §5.1）。放在本模块（共享叶子）供导入与借书人合并复用，
 * 避免 backup/import.ts ↔ merge-borrowers.ts 互相引用。
 * - 后写覆盖：incoming.updatedAt > local.updatedAt 时取 incoming 的业务字段
 * - id 永远取 local.id（对齐的锚点）
 * - createdAt 取两者较早者（同一实体不可能有两个创建时间）
 * - unionFields 指定的数组字段取并集（标签不能丢）
 * - changed 为 false 表示合并后与本地完全一致 → 不写库（幂等性的基础）
 */
export function mergeRecord<T extends Mergeable>(
  local: T,
  incoming: T,
  unionFields: readonly string[] = [],
): { record: T; changed: boolean } {
  const incomingWins = incoming.updatedAt > local.updatedAt;
  const record = {
    ...(incomingWins ? incoming : local),
    id: local.id,
    createdAt: earliest(local.createdAt, incoming.createdAt),
  } as T;

  for (const field of unionFields) {
    const a = (local as unknown as Record<string, unknown>)[field];
    const b = (incoming as unknown as Record<string, unknown>)[field];
    if (Array.isArray(a) && Array.isArray(b)) {
      (record as unknown as Record<string, unknown>)[field] = unionSorted(a as string[], b as string[]);
    }
  }

  return { record, changed: !deepEqual(record, local) };
}

/* ------------------------------------------------------------------ *
 * 清洗：宽进严出（§3.1）。未知字段一律丢弃，只按显式字段清单构造对象。
 * ------------------------------------------------------------------ */

function pickEnum<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(asString).filter((item) => item !== '');
}

function asTimestamp(value: unknown, fallback: string): string {
  return isTimestampString(value) ? value : fallback;
}

function asDate(value: unknown): string {
  return isDateString(value) ? value : '';
}

export interface SanitizeContext {
  warn(message: string): void;
  /** 兜底时间戳（导出时间），用于补齐缺失的 createdAt/updatedAt */
  fallbackStamp: string;
}

/** 缺字段的提示规格：字段名 → 用什么补的（03 §3.1）。 */
type MissingFieldRule = readonly [field: string, consequence: string];

const LOCATION_FIELDS: readonly MissingFieldRule[] = [
  ['parentId', '已按顶层位置导入'],
  ['name', '已按空串导入'],
  ['path', '已由本机重算'],
  ['depth', '已由本机重算'],
  ['type', '已按默认值（home）导入'],
  ['sortOrder', '已按默认值（0）导入'],
];

const BOOK_FIELDS: readonly MissingFieldRule[] = [
  ['isbn', '已按空串导入'],
  ['title', '已按空串导入'],
  ['authors', '已按空数组导入'],
  ['publisher', '已按空串导入'],
  ['publishDate', '已按空串导入'],
  ['coverUrl', '已按空串导入'],
  ['tags', '已按空数组导入'],
];

const COPY_FIELDS: readonly MissingFieldRule[] = [
  ['locationId', '已按空串导入'],
  ['status', '已按默认值（on_shelf）导入'],
  ['condition', '已按默认值（unknown）导入'],
  ['owner', '已按空串导入'],
  ['note', '已按空串导入'],
];

const LOAN_FIELDS: readonly MissingFieldRule[] = [
  ['borrower', '已按空串导入'],
  ['contact', '已按空串导入'],
  ['loanDate', '已按空日期导入'],
  ['dueDate', '已按空日期导入'],
  ['returnDate', '已按空日期导入'],
  ['status', '已按默认值（active）导入'],
  ['note', '已按空串导入'],
];

const BORROWER_FIELDS: readonly MissingFieldRule[] = [
  ['name', '已按空串导入'],
  ['contact', '已按空串导入'],
];

/**
 * 缺字段提示（03 §3.1）：单条记录缺字段要按 02 的默认值补全，**并且记警告**。
 *
 * 判据是「文件里根本没有这个字段」（`undefined`）：空串 / 空数组是用户显式写下的值，不算缺字段。
 * 引用字段（`id` / `bookId` / `copyId`）刻意不列进来 —— 它们缺了走的是「丢弃该条」那条路，
 * 各自已经有更具体的提示，同一个毛病报两遍只会让用户以为出了两个问题。
 */
function warnMissingFields(
  ctx: SanitizeContext,
  label: string,
  row: Record<string, unknown>,
  rules: readonly MissingFieldRule[],
): void {
  for (const [field, consequence] of rules) {
    if (row[field] === undefined) ctx.warn(`${label} 缺少字段 ${field}，${consequence}`);
  }
}

/**
 * 时间戳的兜底与提示。缺失或非法都要说出来：
 * 用户看到的时间要是编出来的，他必须知道，否则会把「导出时间」当成真实的录入时间。
 */
function sanitizeTimestamps(
  ctx: SanitizeContext,
  label: string,
  row: Record<string, unknown>,
): { createdAt: string; updatedAt: string } {
  const createdAt = asTimestamp(row['createdAt'], ctx.fallbackStamp);
  if (!isTimestampString(row['createdAt'])) {
    ctx.warn(`${label} 的 createdAt 缺失或不是时间戳，已用导出时间兜底`);
  }
  const updatedAt = asTimestamp(row['updatedAt'], createdAt);
  if (!isTimestampString(row['updatedAt'])) {
    ctx.warn(`${label} 的 updatedAt 缺失或不是时间戳，已沿用创建时间`);
  }
  return { createdAt, updatedAt };
}

function sanitizeLocation(raw: unknown, ctx: SanitizeContext): Location | null {
  if (raw === null || typeof raw !== 'object') {
    ctx.warn('位置列表中存在非对象记录，已跳过');
    return null;
  }
  const row = raw as Record<string, unknown>;
  if (!isValidId(row['id'])) {
    ctx.warn('位置记录缺少 id，已丢弃该条');
    return null;
  }
  const id = row['id'] as string;
  warnMissingFields(ctx, `位置 ${id}`, row, LOCATION_FIELDS);
  // 「没有 name 字段」已在上面按字段提示过；这里单管另一种毛病：用户写了个空名字。
  const name = asString(row['name']);
  if (row['name'] !== undefined && name === '') {
    ctx.warn(`位置 ${id} 的名称是空串，已按空名称导入`);
  }
  const parentId = isValidId(row['parentId']) ? (row['parentId'] as string) : null;
  const { createdAt, updatedAt } = sanitizeTimestamps(ctx, `位置 ${id}`, row);

  return {
    id,
    parentId,
    name,
    path: asString(row['path']),
    depth: typeof row['depth'] === 'number' && Number.isFinite(row['depth']) ? row['depth'] : 0,
    type: pickEnum<LocationType>(LOCATION_TYPES, row['type'], 'home'),
    sortOrder: typeof row['sortOrder'] === 'number' && Number.isFinite(row['sortOrder']) ? row['sortOrder'] : 0,
    createdAt,
    updatedAt,
  };
}

function sanitizeBook(raw: unknown, ctx: SanitizeContext): Book | null {
  if (raw === null || typeof raw !== 'object') {
    ctx.warn('书目列表中存在非对象记录，已跳过');
    return null;
  }
  const row = raw as Record<string, unknown>;
  if (!isValidId(row['id'])) {
    ctx.warn('书目记录缺少 id，已丢弃该条');
    return null;
  }
  const id = row['id'] as string;
  warnMissingFields(ctx, `书目 ${id}`, row, BOOK_FIELDS);
  // 字段在、但不是数组，是另一种毛病（用户写成了字符串之类），单独提示
  if (row['authors'] !== undefined && !Array.isArray(row['authors'])) {
    ctx.warn(`书目 ${id} 的 authors 不是数组，已按空数组导入`);
  }
  if (row['tags'] !== undefined && !Array.isArray(row['tags'])) {
    ctx.warn(`书目 ${id} 的 tags 不是数组，已按空数组导入`);
  }
  const { createdAt, updatedAt } = sanitizeTimestamps(ctx, `书目 ${id}`, row);

  return {
    id,
    isbn: asString(row['isbn']),
    title: asString(row['title']),
    authors: asStringArray(row['authors']),
    publisher: asString(row['publisher']),
    publishDate: asString(row['publishDate']),
    coverUrl: asString(row['coverUrl']),
    tags: asStringArray(row['tags']),
    createdAt,
    updatedAt,
  };
}

function sanitizeCopy(raw: unknown, ctx: SanitizeContext): Copy | null {
  if (raw === null || typeof raw !== 'object') {
    ctx.warn('副本列表中存在非对象记录，已跳过');
    return null;
  }
  const row = raw as Record<string, unknown>;
  if (!isValidId(row['id'])) {
    ctx.warn('副本记录缺少 id，已丢弃该条');
    return null;
  }
  const id = row['id'] as string;
  if (!isValidId(row['bookId'])) {
    ctx.warn(`副本 ${id} 缺少 bookId，已丢弃该条`);
    return null;
  }
  warnMissingFields(ctx, `副本 ${id}`, row, COPY_FIELDS);
  const { createdAt, updatedAt } = sanitizeTimestamps(ctx, `副本 ${id}`, row);

  const status: CopyStatus = pickEnum<CopyStatus>(COPY_STATUSES, row['status'], 'on_shelf');
  const condition: CopyCondition = pickEnum<CopyCondition>(COPY_CONDITIONS, row['condition'], 'unknown');

  return {
    id,
    bookId: row['bookId'] as string,
    locationId: asString(row['locationId']),
    status,
    condition,
    owner: asString(row['owner']),
    note: asString(row['note']),
    createdAt,
    updatedAt,
  };
}

function sanitizeLoan(raw: unknown, ctx: SanitizeContext): Loan | null {
  if (raw === null || typeof raw !== 'object') {
    ctx.warn('借出列表中存在非对象记录，已跳过');
    return null;
  }
  const row = raw as Record<string, unknown>;
  if (!isValidId(row['id'])) {
    ctx.warn('借出记录缺少 id，已丢弃该条');
    return null;
  }
  const id = row['id'] as string;
  if (!isValidId(row['copyId'])) {
    ctx.warn(`借出记录 ${id} 缺少 copyId，已丢弃该条`);
    return null;
  }
  warnMissingFields(ctx, `借出记录 ${id}`, row, LOAN_FIELDS);
  const { createdAt, updatedAt } = sanitizeTimestamps(ctx, `借出记录 ${id}`, row);

  const status: LoanStatus = pickEnum<LoanStatus>(LOAN_STATUSES, row['status'], 'active');

  return {
    id,
    copyId: row['copyId'] as string,
    borrower: asString(row['borrower']),
    contact: asString(row['contact']),
    loanDate: asDate(row['loanDate']),
    dueDate: asDate(row['dueDate']),
    returnDate: asDate(row['returnDate']),
    status,
    note: asString(row['note']),
    createdAt,
    updatedAt,
  };
}

function sanitizeBorrower(raw: unknown, ctx: SanitizeContext): Borrower | null {
  if (raw === null || typeof raw !== 'object') {
    ctx.warn('借书人列表中存在非对象记录，已跳过');
    return null;
  }
  const row = raw as Record<string, unknown>;
  if (!isValidId(row['id'])) {
    ctx.warn('借书人记录缺少 id，已丢弃该条');
    return null;
  }
  const id = row['id'] as string;
  warnMissingFields(ctx, `借书人 ${id}`, row, BORROWER_FIELDS);
  const { createdAt, updatedAt } = sanitizeTimestamps(ctx, `借书人 ${id}`, row);
  return { id, name: asString(row['name']), contact: asString(row['contact']), createdAt, updatedAt };
}

function sanitizeArray<T>(
  value: unknown,
  field: string,
  context: SanitizeContext,
  sanitize: (raw: unknown, ctx: SanitizeContext) => T | null,
): T[] {
  if (value === undefined || value === null) {
    context.warn(`备份文件缺少 ${field} 数据段，已按空列表处理`);
    return [];
  }
  if (!Array.isArray(value)) {
    context.warn(`备份文件的 ${field} 不是数组，已按空列表处理`);
    return [];
  }
  const out: T[] = [];
  for (const raw of value) {
    const record = sanitize(raw, context);
    if (record !== null) out.push(record);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 解析
 * ------------------------------------------------------------------ */

/**
 * 解析备份文本。**不抛异常** —— UI 需要展示失败原因（§3）。
 * 返回的 backup 已完成清洗，可以安全地交给合并逻辑。
 */
export function parseBackup(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: '文件不是合法的 JSON，可能不是备份文件或已损坏' };
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '备份文件的顶层结构不是对象' };
  }
  const file = raw as Record<string, unknown>;

  if (file['format'] !== BACKUP_FORMAT) {
    return { ok: false, error: '这不是掌上图书馆的备份文件' };
  }

  const formatVersion = file['formatVersion'];
  if (typeof formatVersion !== 'number' || !Number.isFinite(formatVersion)) {
    return { ok: false, error: '备份文件缺少格式版本号' };
  }
  if (formatVersion > BACKUP_FORMAT_VERSION) {
    return {
      ok: false,
      error: `此备份文件的格式版本（${formatVersion}）比当前版本（${BACKUP_FORMAT_VERSION}）更新，请先升级 App`,
    };
  }

  const schemaVersion = file['schemaVersion'];
  if (typeof schemaVersion !== 'number' || !Number.isFinite(schemaVersion)) {
    return { ok: false, error: '备份文件缺少数据版本号' };
  }
  if (schemaVersion > SCHEMA_VERSION) {
    return {
      ok: false,
      error: `此备份文件的数据版本（${schemaVersion}）比当前版本（${SCHEMA_VERSION}）更新，请先升级 App`,
    };
  }

  const data = file['data'];
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: '备份文件缺少必要的数据段' };
  }
  const sections = data as Record<string, unknown>;

  const warnings = createWarningCollector();
  const exportedAt = asTimestamp(file['exportedAt'], nowIso());
  const context: SanitizeContext = { warn: warnings.add, fallbackStamp: exportedAt };

  const counts = file['counts'];
  const countOf = (key: string): number =>
    counts !== null && typeof counts === 'object' && !Array.isArray(counts)
      ? Number((counts as Record<string, unknown>)[key]) || 0
      : 0;

  const locations = sanitizeArray(sections['locations'], 'locations', context, sanitizeLocation);
  const books = sanitizeArray(sections['books'], 'books', context, sanitizeBook);
  const copies = sanitizeArray(sections['copies'], 'copies', context, sanitizeCopy);
  const loans = sanitizeArray(sections['loans'], 'loans', context, sanitizeLoan);
  // 03 §3.1：schemaVersion 1 的老文件没有 borrowers 段 —— 视为空数组且**不警告**（正常形态不是损坏）；
  // 字段存在但不是数组时仍走 sanitizeArray 的警告路径（那是被手改坏的形态）
  const borrowers =
    sections['borrowers'] === undefined
      ? []
      : sanitizeArray(sections['borrowers'], 'borrowers', context, sanitizeBorrower);

  // counts 只作人工核对，与内容不符时提示（导入本身以内容为准，见 §3.2）
  const actual = {
    locations: locations.length,
    books: books.length,
    copies: copies.length,
    loans: loans.length,
    borrowers: borrowers.length,
  };
  for (const key of ['locations', 'books', 'copies', 'loans', 'borrowers'] as const) {
    const declared = countOf(key);
    if (declared !== 0 && declared !== actual[key]) {
      warnings.add(`备份文件声明的 ${key} 数量（${declared}）与实际内容（${actual[key]}）不一致，已以内容为准`);
    }
  }

  const backup: BackupFile = {
    format: BACKUP_FORMAT,
    formatVersion,
    schemaVersion,
    exportedAt,
    deviceName: asString(file['deviceName']),
    counts: actual,
    data: { locations, books, copies, loans, borrowers },
  };

  return { ok: true, backup, warnings: warnings.list() };
}

/** 稳定序列化：数组按 id 升序，便于同一份数据多次导出后比对。 */
export function serializeBackup(backup: BackupFile): string {
  const byId = <T extends { id: string }>(rows: readonly T[]): T[] =>
    [...rows].sort((a, b) => a.id.localeCompare(b.id));

  return `${JSON.stringify(
    {
      format: backup.format,
      formatVersion: backup.formatVersion,
      schemaVersion: backup.schemaVersion,
      exportedAt: backup.exportedAt,
      deviceName: backup.deviceName,
      counts: backup.counts,
      data: {
        locations: byId(backup.data.locations),
        books: byId(backup.data.books),
        copies: byId(backup.data.copies),
        loans: byId(backup.data.loans),
        borrowers: byId(backup.data.borrowers),
      },
    },
    null,
    2,
  )}\n`;
}
