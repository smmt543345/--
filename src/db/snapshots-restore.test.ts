/**
 * 自动快照与恢复（02 §12.3 / §12.4）测试：S7–S11、S20。
 *
 * 时间全部注入（阈值/间隔通过直接设置 settings 键控制），不依赖挂钟。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UNSORTED_LOCATION_ID } from '../domain/ids.ts';
import { nowIso } from '../domain/time.ts';
import { withDb } from '../testing/harness.ts';
import { createBook, updateBook } from './books.ts';
import { clearAllData } from './client.ts';
import { createCopy, deleteCopy } from './copies.ts';
import { createLocation } from './locations.ts';
import { loanOut } from './loans.ts';
import { createBorrower, deleteBorrower } from './borrowers.ts';
import { putCover } from './covers.ts';
import { repairInvariants } from './repair.ts';
import { SETTING_KEYS, getSetting, setSetting } from './settings.ts';
import { captureSnapshot, listSnapshots, restoreSnapshot, whenAutoSnapshotSettled } from './snapshots.ts';

const byId = <T extends { id: string }>(rows: readonly T[]): T[] =>
  [...rows].sort((a, b) => a.id.localeCompare(b.id));

function jpeg(...bytes: number[]): Blob {
  return new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });
}

async function bytesOf(blob: Blob): Promise<number[]> {
  return [...new Uint8Array(await blob.arrayBuffer())];
}

describe('自动快照（02 §12.3）', () => {
  it('S7 写计数达 20 且距上次 ≥1 天 → 自动拍 auto 快照；计数器归零', async () => {
    await withDb(async (db) => {
      // 距上次快照足够久：lastAutoSnapshotAt 保持默认空串即视为「很久以前」
      await setSetting(db, SETTING_KEYS.writesSinceSnapshot, 19);
      const book = await createBook(db, { title: '触发' });
      await whenAutoSnapshotSettled();

      const autos = await db.snapshots.where('kind').equals('auto').toArray();
      assert.equal(autos.length, 1, '第 20 次写触发一张 auto 快照');
      assert.equal(autos[0]?.summary.books, 1);
      assert.ok(autos[0]?.data.books.some((b) => b.id === book.id), '快照包含刚写入的数据');
      assert.equal(await getSetting(db, SETTING_KEYS.writesSinceSnapshot, -1), 0, '快照成功后计数器归零');
      assert.notEqual(await getSetting(db, SETTING_KEYS.lastAutoSnapshotAt, ''), '', '记下快照时间');
    });
  });

  it('S8 计数 <20 或距上次 <1 天 → 不拍快照', async () => {
    await withDb(async (db) => {
      await setSetting(db, SETTING_KEYS.writesSinceSnapshot, 19);
      await setSetting(db, SETTING_KEYS.lastAutoSnapshotAt, nowIso());
      await createBook(db, { title: '书' });
      await whenAutoSnapshotSettled();

      assert.equal(await db.snapshots.count(), 0, '距上次不足 1 天不拍');
      assert.equal(await getSetting(db, SETTING_KEYS.writesSinceSnapshot, -1), 20, '不拍则不归零');

      // 计数不足 20 也不触发
      await setSetting(db, SETTING_KEYS.writesSinceSnapshot, 0);
      await setSetting(db, SETTING_KEYS.lastAutoSnapshotAt, '');
      await createBook(db, { title: '第二本' });
      await whenAutoSnapshotSettled();
      assert.equal(await db.snapshots.count(), 0, '计数不足阈值不拍');
    });
  });

  it('S9 快照超过 10 份：最旧的被删，恰好保留 10 份', async () => {
    await withDb(async (db) => {
      // 直接播种 12 份历史 auto 快照（模拟滚动历史）
      for (let i = 0; i < 12; i++) {
        await db.snapshots.put({
          id: `snap-${String(i).padStart(2, '0')}`,
          kind: 'auto',
          createdAt: `2026-09-01T00:${String(i).padStart(2, '0')}:00.000Z`,
          summary: { locations: 1, books: 0, copies: 0, loans: 0, borrowers: 0 },
          data: { locations: [], books: [], copies: [], loans: [], borrowers: [] },
        });
      }
      // 触发第 13 份捕获 → 滚动保留 10 份
      await setSetting(db, SETTING_KEYS.writesSinceSnapshot, 19);
      await setSetting(db, SETTING_KEYS.lastAutoSnapshotAt, '');
      await createBook(db, { title: '书' });
      await whenAutoSnapshotSettled();

      const restorable = await listSnapshots(db);
      assert.equal(restorable.length, 10);
      assert.equal(restorable.some((s) => s.id === 'snap-00'), false, '最旧的被删');
      assert.equal(restorable.some((s) => s.id === 'snap-02'), false, '共 13 份，超出 10 的最旧三份全删');
      assert.equal(restorable.some((s) => s.id === 'snap-03'), true, '第 10 新的一份保留');
    });
  });
});

describe('快照恢复（02 §12.4）', () => {
  it('S10 恢复快照：五表与快照一致；恢复前有 pre-restore 快照；settings 不变', async () => {
    await withDb(async (db) => {
      const home = await createLocation(db, { name: '家' });
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id, locationId: home.id });
      await loanOut(db, { copyId: copy.id, borrower: '小王' });
      const candidate = await createBorrower(db, { name: '老张', contact: '111' });
      await setSetting(db, SETTING_KEYS.theme, 'dark');

      const snapshot = await captureSnapshot(db, 'auto', '2026-09-13T00:00:00.000Z');

      // 把数据改成另一番模样（其中删副本会挂 undo —— 见 S20）
      await deleteCopy(db, copy.id, { confirmLentOut: true });
      await updateBook(db, book.id, { title: '改过的书' });
      await createLocation(db, { name: '书房' });
      await deleteBorrower(db, candidate.id);

      await restoreSnapshot(db, snapshot.id, '2026-09-13T01:00:00.000Z');

      assert.deepEqual(byId(await db.locations.toArray()), byId(snapshot.data.locations));
      assert.deepEqual(byId(await db.books.toArray()), byId(snapshot.data.books));
      assert.deepEqual(byId(await db.copies.toArray()), byId(snapshot.data.copies));
      assert.deepEqual(byId(await db.loans.toArray()), byId(snapshot.data.loans));
      assert.deepEqual(byId(await db.borrowers.toArray()), byId(snapshot.data.borrowers));

      const pre = await db.snapshots.where('kind').equals('pre-restore').toArray();
      assert.equal(pre.length, 1, '恢复前自动拍一张 pre-restore 快照');
      assert.ok(pre[0]?.data.books.some((b) => b.title === '改过的书'), 'pre-restore 是恢复前一刻的状态');

      assert.equal(await getSetting(db, SETTING_KEYS.theme, ''), 'dark', 'settings 不被恢复影响');
    });
  });

  it('S11 恢复后不变式零警告；「未分类」存在', async () => {
    await withDb(async (db) => {
      const home = await createLocation(db, { name: '家' });
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id, locationId: home.id });
      await loanOut(db, { copyId: copy.id, borrower: '小王' });
      const snapshot = await captureSnapshot(db, 'auto', '2026-09-13T00:00:00.000Z');

      await clearAllData(db);
      await restoreSnapshot(db, snapshot.id);

      const report = await repairInvariants(db);
      assert.deepEqual(report.warnings, [], '恢复后数据已合规');
      assert.ok(await db.locations.get(UNSORTED_LOCATION_ID), '「未分类」存在');
    });
  });

  it('S20 快照恢复前有未过期 undo → 恢复后该 undo 被清理；恢复结果不受其影响', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      const copy = await createCopy(db, { bookId: book.id });
      const snapshot = await captureSnapshot(db, 'auto', '2026-09-13T00:00:00.000Z');

      await deleteCopy(db, copy.id);
      assert.equal(await db.snapshots.where('kind').equals('undo').count(), 1, '挂一份未过期 undo');

      await restoreSnapshot(db, snapshot.id, '2026-09-13T01:00:00.000Z');

      assert.equal(await db.snapshots.where('kind').equals('undo').count(), 0, '恢复前先清理当前 undo');
      assert.ok(await db.copies.get(copy.id), '恢复结果 = 快照内容（含被删的副本），不受 undo 影响');
    });
  });

  it('S22 快照回滚不动封面表（B4）：auto/pre-restore 的 data 不含 covers，恢复后照片仍在', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      await putCover(db, { bookId: book.id, blob: jpeg(7, 7, 7), mime: 'image/jpeg' });

      const snapshot = await captureSnapshot(db, 'auto', '2026-09-13T00:00:00.000Z');
      assert.equal(snapshot.data.covers, undefined, 'auto 快照不复制照片（10 份各存一遍会翻十倍）');
      // 落库的那一份也要查 —— 只看返回值会让「存进去了、返回时被剥掉」这种漏网
      const stored = await db.snapshots.get(snapshot.id);
      assert.equal(stored?.data.covers, undefined);
      assert.deepEqual(await db.covers.count(), 1, '拍照本身不进快照，照片还在库里');

      await restoreSnapshot(db, snapshot.id, '2026-09-13T01:00:00.000Z');

      const pre = await db.snapshots.where('kind').equals('pre-restore').toArray();
      assert.equal(pre[0]?.data.covers, undefined, 'pre-restore 同样不带封面');
      const kept = await db.covers.get(book.id);
      assert.ok(kept, '恢复语义只覆盖业务表，不动封面表（02 §12.4）');
      assert.deepEqual(await bytesOf(kept.blob), [7, 7, 7], '照片字节不受恢复影响');
    });
  });

  it('快照恢复后：被恢复掉的书目留下的封面由 I10 收走（B4）', async () => {
    await withDb(async (db) => {
      const kept = await createBook(db, { title: '快照里的书' });
      const snapshot = await captureSnapshot(db, 'auto', '2026-09-13T00:00:00.000Z');

      const added = await createBook(db, { title: '快照之后加的书' });
      await putCover(db, { bookId: added.id, blob: jpeg(1, 2), mime: 'image/jpeg' });
      await putCover(db, { bookId: kept.id, blob: jpeg(3, 4), mime: 'image/jpeg' });

      await restoreSnapshot(db, snapshot.id, '2026-09-13T01:00:00.000Z');

      assert.equal(await db.books.get(added.id), undefined, '恢复 = 回到快照那一刻');
      assert.equal(await db.covers.get(added.id), undefined, '它那张照片成了孤儿，由 I10 收走（02 §3.5）');
      const survivor = await db.covers.get(kept.id);
      assert.ok(survivor, '快照里那本书的封面不受影响');
      assert.deepEqual(await bytesOf(survivor.blob), [3, 4]);
    });
  });
});
