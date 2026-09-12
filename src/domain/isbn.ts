/**
 * ISBN 规范化与校验。
 *
 * 规范见 docs/design/02-data-model.md §7.3。要点：
 * - 去连字符/空格/全角，X 转大写
 * - 校验位验证；ISBN-10 有效则转成 ISBN-13（决策 D4，否则同一本书手工录
 *   ISBN-10、扫码得 ISBN-13 会产生两条书目）
 * - 无效或为空 → isbn13 = ''，不阻塞保存（中文书元数据本就不全）
 */

export interface IsbnResult {
  /** 规范化后的 ISBN-13；无效或为空时为 '' */
  isbn13: string;
  valid: boolean;
  /** 清洗后的原始字符（去分隔符），便于提示用户"你输入的其实是 X" */
  cleaned: string;
}

const ISBN10_RE = /^\d{9}[\dX]$/;
const ISBN13_RE = /^\d{13}$/;

/** 去掉一切非 [0-9Xx] 字符（连字符、空格、全角空格、Unicode 连字符等）。 */
function clean(raw: string): string {
  return raw.replace(/[^0-9Xx]/g, '').toUpperCase();
}

export function isValidIsbn10(value: string): boolean {
  if (!ISBN10_RE.test(value)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = value[i] as string;
    const digit = ch === 'X' ? 10 : Number(ch);
    sum += (i + 1) * digit;
  }
  return sum % 11 === 0;
}

export function isValidIsbn13(value: string): boolean {
  if (!ISBN13_RE.test(value)) return false;
  // ISBN（Bookland EAN）必须以 978 / 979 开头
  if (!value.startsWith('978') && !value.startsWith('979')) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    const digit = Number(value[i]);
    sum += i % 2 === 0 ? digit : digit * 3;
  }
  return sum % 10 === 0;
}

/** ISBN-10 → ISBN-13（加 978 前缀并重算校验位）。调用方须先确认输入合法。 */
export function isbn10To13(value: string): string {
  const body = `978${value.slice(0, 9)}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = Number(body[i]);
    sum += i % 2 === 0 ? digit : digit * 3;
  }
  const check = (10 - (sum % 10)) % 10;
  return `${body}${check}`;
}

export function normalizeIsbn(raw: unknown): IsbnResult {
  if (typeof raw !== 'string') return { isbn13: '', valid: false, cleaned: '' };
  const value = clean(raw);
  if (value === '') return { isbn13: '', valid: false, cleaned: '' };

  if (ISBN10_RE.test(value) && isValidIsbn10(value)) {
    const isbn13 = isbn10To13(value);
    return { isbn13, valid: isValidIsbn13(isbn13), cleaned: value };
  }
  if (ISBN13_RE.test(value) && isValidIsbn13(value)) {
    return { isbn13: value, valid: true, cleaned: value };
  }
  return { isbn13: '', valid: false, cleaned: value };
}

/** 便捷入口：只要规范化结果。 */
export function toIsbn13(raw: unknown): string {
  return normalizeIsbn(raw).isbn13;
}
