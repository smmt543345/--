import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UNSORTED_LOCATION_ID, isUuid, newId } from './ids.ts';

describe('id（01 §1.1）', () => {
  it('newId 生成 UUID v4 且不重复', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const id = newId();
      assert.equal(isUuid(id), true, `生成的 id 不是 UUID：${id}`);
      assert.equal(ids.has(id), false, '生成了重复 id');
      ids.add(id);
    }
  });

  it('「未分类」保留 id 不会被 UUID 撞上', () => {
    assert.equal(isUuid(UNSORTED_LOCATION_ID), false);
  });
});
