/**
 * 时间工具。
 *
 * 硬约束（见 docs/design/01-architecture.md §6.4）：
 * - 时间戳一律 ISO 8601 UTC 字符串（`2026-09-11T11:39:52.000Z`）
 * - 日历日一律 `YYYY-MM-DD`（本地时区）
 * - 绝不把 Date 对象写进数据库
 */

const PAD = (n: number): string => String(n).padStart(2, '0');

export function nowIso(): string {
  return new Date().toISOString();
}

/** 本地日历日 YYYY-MM-DD。 */
export function toLocalDate(at: Date = new Date()): string {
  return `${at.getFullYear()}-${PAD(at.getMonth() + 1)}-${PAD(at.getDate())}`;
}

export function today(at: Date = new Date()): string {
  return toLocalDate(at);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDateString(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(y, m - 1, d);
  return probe.getFullYear() === y && probe.getMonth() === m - 1 && probe.getDate() === d;
}

export function isTimestampString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}

/** YYYY-MM-DD 的字典序即为时间序，因此可直接比较字符串。 */
export function isOverdue(dueDate: string, reference: string = today()): boolean {
  return dueDate !== '' && isDateString(dueDate) && dueDate < reference;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const probe = new Date(y, m - 1, d);
  probe.setDate(probe.getDate() + days);
  return toLocalDate(probe);
}

/** 从某天起算的默认应还日期。 */
export function defaultDueDate(from: string = today(), days = 30): string {
  return isDateString(from) ? addDays(from, days) : '';
}

/** reference 与 date 相差的天数（正数表示 date 已过去）。 */
export function daysSince(date: string, reference: string = today()): number {
  if (!isDateString(date) || !isDateString(reference)) return 0;
  const a = Date.parse(`${date}T00:00:00Z`);
  const b = Date.parse(`${reference}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** 取两个 ISO 时间戳中较早的一个；用于 createdAt 的合并。 */
export function earliest(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return a <= b ? a : b;
}
