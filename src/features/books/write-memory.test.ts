/**
 * 表单记忆测试（04 §11.2）：只记位置 / 品相 / 标签三字段，保存后回填；
 * 记忆值坏掉（位置被删）时按「没记过」处理，不放一个不存在的 id 进表单。
 *
 * 从 write.test.ts 拆出来：那边已经 263 行，本文件按 01 §5.1 的拆分计划独立成文。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createLocation, deleteLocation } from '../../db/locations.ts';
import { withDb } from '../../testing/harness.ts';
import { EMPTY_DRAFT, applyDraftPrefs, rememberDraftPrefs } from './write.ts';

describe('表单记忆（04 §11.2）', () => {
  it('只记位置/品相/标签：保存后回填，其余字段不记', async () => {
    await withDb(async (db) => {
      const room = await createLocation(db, { name: '书房' });
      await rememberDraftPrefs(db, {
        ...EMPTY_DRAFT,
        title: '三体',
        publisher: '重庆出版社',
        locationId: room.id,
        condition: 'good',
        tagsRaw: '科幻、历史',
      });

      const next = await applyDraftPrefs(db, EMPTY_DRAFT);
      assert.equal(next.locationId, room.id, '位置要回填');
      assert.equal(next.condition, 'good', '品相要回填');
      assert.equal(next.tagsRaw, '科幻、历史', '标签要回填');
      assert.equal(next.title, '', '书名不记');
      assert.equal(next.publisher, '', '出版社不记');
    });
  });

  it('位置已被删除时丢弃该记忆，其余字段照记', async () => {
    await withDb(async (db) => {
      const room = await createLocation(db, { name: '书房' });
      await rememberDraftPrefs(db, { ...EMPTY_DRAFT, locationId: room.id, condition: 'fair' });
      await deleteLocation(db, room.id);

      const next = await applyDraftPrefs(db, EMPTY_DRAFT);
      assert.equal(next.locationId, '', '不存在的位置不能带进表单');
      assert.equal(next.condition, 'fair', '其余记忆不受影响');
    });
  });

  it('没记过时草稿原样返回，不凭空造值', async () => {
    await withDb(async (db) => {
      const next = await applyDraftPrefs(db, { ...EMPTY_DRAFT, title: 'X' });
      assert.equal(next.title, 'X');
      assert.equal(next.condition, EMPTY_DRAFT.condition);
      assert.equal(next.locationId, EMPTY_DRAFT.locationId);
      assert.equal(next.tagsRaw, EMPTY_DRAFT.tagsRaw);
    });
  });
});
