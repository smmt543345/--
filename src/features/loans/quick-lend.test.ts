import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CopyStatus, CopyWithLocation } from '../../domain/types.ts';
import { describeNoShelfCopies, describeOffShelf, splitOnShelf } from './quick-lend.ts';

const STAMP = '2026-09-13T03:00:00.000Z';

function copy(id: string, status: CopyStatus): CopyWithLocation {
  return {
    id,
    bookId: 'b1',
    locationId: 'l1',
    status,
    condition: 'unknown',
    owner: '',
    note: '',
    createdAt: STAMP,
    updatedAt: STAMP,
    locationPath: '家 / 客厅',
    locationName: '客厅',
    activeLoan: null,
  };
}

describe('快速借出：在架副本的切分（04 §11.7）', () => {
  it('只有 on_shelf 的副本可以借，其余进不在架一组', () => {
    const split = splitOnShelf([copy('c1', 'on_shelf'), copy('c2', 'lent_out'), copy('c3', 'lost')]);
    assert.deepEqual(split.onShelf.map((item) => item.id), ['c1']);
    assert.deepEqual(split.offShelf.map((item) => item.id), ['c2', 'c3']);
  });

  it('空态标题里的数量是全部不在架的副本', () => {
    const split = splitOnShelf([copy('c1', 'lent_out'), copy('c2', 'sold')]);
    assert.equal(split.onShelf.length, 0);
    assert.equal(describeNoShelfCopies(split.offShelf.length), '该书没有在架副本（2 本已借出/丢失/卖掉）');
  });

  it('不在架的分状态点名，顺序稳定（借出 → 丢失 → 卖掉）', () => {
    const text = describeOffShelf([copy('c1', 'sold'), copy('c2', 'lent_out'), copy('c3', 'lent_out')]);
    assert.equal(text, '2 本借出 · 1 本卖掉');
  });

  it('没有不在架副本时不给一个孤零零的分隔符', () => {
    assert.equal(describeOffShelf([]), '');
  });
});
