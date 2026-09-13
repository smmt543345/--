/**
 * 快速借出（04 §11.7）的纯逻辑：把一本书的副本切分成「在架」与「不在架」两组，
 * 并为空态给出带数字的说明（「该书没有在架副本（N 本已借出/丢失/卖掉）」）。
 *
 * 放在 .ts 而不是对话框里：`node --test` 跑不了 .tsx，而这句带数字的文案恰恰最该被断言。
 */

import { COPY_STATUS_LABELS } from '../../app/labels.ts';
import { COPY_STATUSES, type CopyWithLocation } from '../../domain/types.ts';

export interface ShelfSplit {
  /** 可以借出的副本（status = on_shelf） */
  onShelf: CopyWithLocation[];
  /** 不在架的副本：借出 / 丢失 / 卖掉 */
  offShelf: CopyWithLocation[];
  /** 「2 本借出 · 1 本丢失」；没有不在架的副本时为空串 */
  offShelfText: string;
}

/** 不在架副本的分状态点名（04 §11.7）：按 COPY_STATUSES 的顺序，只列出现过的状态。 */
export function describeOffShelf(copies: readonly CopyWithLocation[]): string {
  const parts: string[] = [];
  for (const status of COPY_STATUSES) {
    if (status === 'on_shelf') continue;
    const count = copies.filter((copy) => copy.status === status).length;
    if (count > 0) parts.push(`${count} 本${COPY_STATUS_LABELS[status]}`);
  }
  return parts.join(' · ');
}

/** 空态标题（04 §11.7）：N = 不在架的副本数。 */
export function describeNoShelfCopies(count: number): string {
  return `该书没有在架副本（${count} 本已借出/丢失/卖掉）`;
}

export function splitOnShelf(copies: readonly CopyWithLocation[]): ShelfSplit {
  const onShelf = copies.filter((copy) => copy.status === 'on_shelf');
  const offShelf = copies.filter((copy) => copy.status !== 'on_shelf');
  return { onShelf, offShelf, offShelfText: describeOffShelf(offShelf) };
}
