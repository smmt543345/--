/**
 * 借出/归还的表单规则（04 §5）。db 层只管不变式，这里管"用户填的东西合不合理"，
 * 以及把设置里的默认借期折算成默认应还日期。
 */

import { loanOut, returnCopy } from '../../db/loans.ts';
import type { PocketLibraryDb } from '../../db/schema.ts';
import { getSetting, SETTING_KEYS } from '../../db/settings.ts';
import { defaultDueDate, isDateString, today } from '../../domain/time.ts';
import type { Loan } from '../../domain/types.ts';

export interface LoanDraft {
  borrower: string;
  contact: string;
  /** YYYY-MM-DD，留空由 db 层取今天 */
  loanDate: string;
  /** YYYY-MM-DD，留空 = 不设到期日 */
  dueDate: string;
  note: string;
}

export const DEFAULT_LOAN_PERIOD_DAYS = 30;

export function emptyLoanDraft(reference: string = today()): LoanDraft {
  return { borrower: '', contact: '', loanDate: reference, dueDate: '', note: '' };
}

/** 校验借出表单。返回可直接展示的中文错误，或 null 表示通过。 */
export function validateLoanDraft(draft: LoanDraft): string | null {
  if (draft.borrower.trim() === '') return '借书人不能为空';
  if (draft.loanDate.trim() !== '' && !isDateString(draft.loanDate.trim())) {
    return '借出日期格式应为 YYYY-MM-DD';
  }
  const dueDate = draft.dueDate.trim();
  if (dueDate !== '') {
    if (!isDateString(dueDate)) return '应还日期格式应为 YYYY-MM-DD，或留空表示不设';
    const loanDate = draft.loanDate.trim() === '' ? today() : draft.loanDate.trim();
    if (dueDate < loanDate) return '应还日期不能早于借出日期';
  }
  return null;
}

/** 按设置里的借期推算默认应还日期（02 §5）。 */
export async function defaultDueDateFor(db: PocketLibraryDb, loanDate: string = today()): Promise<string> {
  const days = await getSetting<number>(db, SETTING_KEYS.loanPeriodDays, DEFAULT_LOAN_PERIOD_DAYS);
  const period = typeof days === 'number' && Number.isInteger(days) && days > 0 ? days : DEFAULT_LOAN_PERIOD_DAYS;
  return defaultDueDate(loanDate, period);
}

/**
 * 借出。`dueDate` 传 undefined 表示"按默认借期自动推算"，传空串表示"不设到期日"——
 * 这个区分是 db 层定的（loans.ts:20），wrapper 不做二次解释。
 */
export async function lendCopy(
  db: PocketLibraryDb,
  input: { copyId: string } & Partial<LoanDraft>,
): Promise<Loan> {
  const draft: LoanDraft = { ...emptyLoanDraft(), ...input };
  const problem = validateLoanDraft(draft);
  if (problem !== null) throw new Error(problem);

  return loanOut(db, {
    copyId: input.copyId,
    borrower: draft.borrower.trim(),
    contact: draft.contact.trim(),
    loanDate: draft.loanDate.trim() === '' ? undefined : draft.loanDate.trim(),
    dueDate: input.dueDate === undefined ? undefined : draft.dueDate.trim(),
    note: draft.note.trim(),
  });
}

/** 归还。returnDate 留空表示"今天还的"（db 层默认取今天）。 */
export async function returnLoan(
  db: PocketLibraryDb,
  copyId: string,
  returnDate = '',
  note = '',
): Promise<Loan> {
  const trimmed = returnDate.trim();
  // 日期格式错误（如用户手输 2026-13-01）必须在进库前挡住：db 层只做形状校验
  if (trimmed !== '' && !isDateString(trimmed)) throw new Error('归还日期格式应为 YYYY-MM-DD，或留空表示今天');
  return returnCopy(db, {
    copyId,
    returnDate: trimmed === '' ? undefined : trimmed,
    note,
  });
}
