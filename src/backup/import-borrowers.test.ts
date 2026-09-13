/**
 * 借书人随备份导入（03 §4.5、§6）测试：T17–T21。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Borrower } from '../domain/types.ts';
import { withDb } from '../testing/harness.ts';
import { createBook } from '../db/books.ts';
import { createCopy, deleteCopy } from '../db/copies.ts';
import { createBorrower } from '../db/borrowers.ts';
import { checkInvariants } from '../db/repair.ts';
import { parseBackup, type BackupFile } from './format.ts';
import { applyImport } from './import.ts';

const STAMP = '2026-01-01T00:00:00.000Z';

function borrower(id: string, name: string, contact = '', updatedAt = STAMP): Borrower {
  return { id, name, contact, createdAt: STAMP, updatedAt };
}

/** 构造一份 schemaVersion 2 的备份（data 段可局部覆盖）。 */
function fileOf(data: Record<string, unknown> = {}, top: Record<string, unknown> = {}): BackupFile {
  const text = JSON.stringify({
    format: 'pocket-library-backup',
    formatVersion: 1,
    schemaVersion: 2,
    exportedAt: STAMP,
    deviceName: '朋友的手机',
    counts: { locations: 0, books: 0, copies: 0, loans: 0, borrowers: 0 },
    data: { locations: [], books: [], copies: [], loans: [], borrowers: [], ...data },
    ...top,
  });
  const parsed = parseBackup(text);
  if (!parsed.ok) throw new Error(`备份文本本应解析成功：${parsed.error}`);
  return parsed.backup;
}

describe('借书人导入（03 §4.5）', () => {
  it('T17 借书人随备份导入：按 id 插入/合并，计数正确；重复导入 0 变更', async () => {
    await withDb(async (db) => {
      // 本地已有同 id 的旧联系方式（模拟字段级合并）
      await db.borrowers.put(borrower('b1', '小王', '旧联系方式'));

      const backup = fileOf({
        borrowers: [
          borrower('b1', '小王', '新联系方式', '2026-06-01T00:00:00.000Z'),
          borrower('b2', '小李', '222'),
        ],
      });

      const first = await applyImport(db, backup);
      assert.deepEqual(first.borrowers, { inserted: 1, updated: 1 });
      assert.equal(await db.borrowers.count(), 2);
      assert.equal((await db.borrowers.get('b1'))?.contact, '新联系方式', 'LWW：传入方较新则覆盖');

      const second = await applyImport(db, backup);
      assert.deepEqual(second.borrowers, { inserted: 0, updated: 0 }, '幂等');
    });
  });

  it('T18 老文件（schemaVersion 1）无 data.borrowers 段：视为空数组，无警告，正常导入', async () => {
    await withDb(async (db) => {
      const text = JSON.stringify({
        format: 'pocket-library-backup',
        formatVersion: 1,
        schemaVersion: 1,
        exportedAt: STAMP,
        deviceName: '朋友的手机',
        counts: { locations: 0, books: 0, copies: 0, loans: 0 },
        data: {
          locations: [],
          books: [{ id: 'b1', isbn: '', title: '书', authors: [], publisher: '', publishDate: '', coverUrl: '', tags: [], createdAt: STAMP, updatedAt: STAMP }],
          copies: [],
          loans: [],
        },
      });
      const parsed = parseBackup(text);
      assert.equal(parsed.ok, true);
      if (!parsed.ok) return;
      assert.deepEqual(parsed.backup.data.borrowers, [], '缺失段视为空数组');
      assert.equal(parsed.warnings.some((w) => w.includes('borrowers')), false, '老文件缺 borrowers 不警告（03 §3.1）');

      const summary = await applyImport(db, parsed.backup);
      assert.deepEqual(summary.borrowers, { inserted: 0, updated: 0 });
      assert.equal(await db.borrowers.count(), 0);
      assert.equal(summary.books.inserted, 1, '其余段照常导入');
    });
  });

  it('T19 replace 模式：本地借书人被清空；文件中的借书人完整导入', async () => {
    await withDb(async (db) => {
      await createBorrower(db, { name: '本地朋友' });
      const backup = fileOf({ borrowers: [borrower('b1', '文件朋友')] });

      const summary = await applyImport(db, backup, { mode: 'replace' });
      assert.equal(summary.borrowers.inserted, 1);

      const rows = await db.borrowers.toArray();
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.id, 'b1', '本地借书人已被清空');
    });
  });

  it('T20 传入借出指向的副本不存在（本地与文件里都没有）：跳过并有警告；无 I3 违规', async () => {
    await withDb(async (db) => {
      const backup = fileOf({
        loans: [
          {
            id: 'l1',
            copyId: '不存在的副本',
            borrower: '小王',
            contact: '',
            loanDate: '2026-01-01',
            dueDate: '',
            returnDate: '',
            status: 'active',
            note: '',
            createdAt: STAMP,
            updatedAt: STAMP,
          },
        ],
      });

      const summary = await applyImport(db, backup);
      assert.equal(summary.loans.skipped, 1);
      assert.ok(summary.warnings.some((w) => w.includes('借出') && w.includes('跳过')));
      assert.equal(await db.loans.count(), 0);
      assert.equal((await checkInvariants(db)).ok, true, '无 I3 违规');
    });
  });

  it('T21 replace 导入前存在未过期 undo 快照：导入后该 undo 被清理；导入结果不受影响', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '本地书' });
      const copy = await createCopy(db, { bookId: book.id });
      await deleteCopy(db, copy.id);
      assert.equal(await db.snapshots.where('kind').equals('undo').count(), 1, '挂一份未过期 undo');

      const backup = fileOf({
        books: [
          { id: 'f1', isbn: '', title: '文件里的书', authors: [], publisher: '', publishDate: '', coverUrl: '', tags: [], createdAt: STAMP, updatedAt: STAMP },
        ],
      });
      const summary = await applyImport(db, backup, { mode: 'replace' });
      assert.equal(summary.books.inserted, 1);

      assert.equal(await db.snapshots.where('kind').equals('undo').count(), 0, 'replace 执行前先清 undo（03 §6）');
      assert.equal((await db.books.toArray()).length, 1);
      assert.equal((await db.books.toArray())[0]?.title, '文件里的书', '导入结果不受 undo 影响');
    });
  });
});
