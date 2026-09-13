/**
 * 封面数据层（02 §3.5、§9、§11）测试。
 *
 * 照片一律用「读回 arrayBuffer 逐字节比对」验，不用 deepEqual ——
 * Blob 没有可枚举的自有属性，deepEqual 会把两张不同的照片判成相等
 * （所以导入合并没有复用 mergeRecord，另写了一套按 updatedAt 的规则，03 §4.7）。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withDb } from '../testing/harness.ts';
import { createBook, deleteBook } from './books.ts';
import { clearAllData } from './client.ts';
import {
  coverToDataUrl,
  dataUrlToBlob,
  deleteCover,
  getCover,
  isBase64DataUrl,
  listCovers,
  putCover,
} from './covers.ts';
import type { PocketLibraryDb } from './schema.ts';

const STAMP = '2026-01-01T00:00:00.000Z';
const LATER = '2026-06-01T00:00:00.000Z';

/** 造一张"照片"：只看字节，不看内容，所以用几个可辨别的数字当图片数据。 */
function jpeg(...bytes: number[]): Blob {
  return new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });
}

async function bytesOf(blob: Blob): Promise<number[]> {
  return [...new Uint8Array(await blob.arrayBuffer())];
}

async function coverBytes(db: PocketLibraryDb, bookId: string): Promise<number[]> {
  const cover = await getCover(db, bookId);
  assert.ok(cover !== undefined, `书目 ${bookId} 应当有封面`);
  return bytesOf(cover.blob);
}

describe('封面增删改查（02 §3.5）', () => {
  it('存一张再读回来：字节一致，mime 与两个时间戳齐全', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      const saved = await putCover(db, { bookId: book.id, blob: jpeg(1, 2, 3), mime: 'image/jpeg' }, { now: STAMP });

      assert.equal(saved.bookId, book.id, '主键就是 bookId');
      assert.equal(saved.mime, 'image/jpeg');
      assert.equal(saved.createdAt, STAMP);
      assert.equal(saved.updatedAt, STAMP);
      assert.deepEqual(await coverBytes(db, book.id), [1, 2, 3], '照片按字节存回来，不能被重新编码');
    });
  });

  it('一本书一张：重拍覆盖同一行，createdAt 不动、updatedAt 刷新', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      await putCover(db, { bookId: book.id, blob: jpeg(1, 1, 1), mime: 'image/jpeg' }, { now: STAMP });
      const retaken = await putCover(
        db,
        { bookId: book.id, blob: jpeg(9, 9), mime: 'image/jpeg' },
        { now: LATER },
      );

      assert.equal(await db.covers.count(), 1, '重拍是覆盖，不是新增一条');
      assert.equal(retaken.createdAt, STAMP, 'createdAt 只在首次写入时定（02 §11）');
      assert.equal(retaken.updatedAt, LATER);
      assert.deepEqual(await coverBytes(db, book.id), [9, 9], '新照片必须换进去');
    });
  });

  it('listCovers 列全部；deleteCover 只删指定那一张', async () => {
    await withDb(async (db) => {
      const a = await createBook(db, { title: '甲' });
      const b = await createBook(db, { title: '乙' });
      await putCover(db, { bookId: a.id, blob: jpeg(1), mime: 'image/jpeg' });
      await putCover(db, { bookId: b.id, blob: jpeg(2), mime: 'image/jpeg' });

      assert.deepEqual((await listCovers(db)).map((c) => c.bookId).sort(), [a.id, b.id].sort());

      await deleteCover(db, a.id);
      assert.equal(await getCover(db, a.id), undefined);
      assert.deepEqual(await coverBytes(db, b.id), [2], '删一张不能连带删掉别人的');
    });
  });

  it('清空数据连封面一起清（02 §9：六张业务表）', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      await putCover(db, { bookId: book.id, blob: jpeg(1, 2), mime: 'image/jpeg' });

      await clearAllData(db);

      assert.equal(await db.covers.count(), 0, '照片也是业务数据，该清就清');
      assert.equal(await db.books.count(), 0);
    });
  });

  it('删书目级联删封面（02 §9）：书都没了，照片没有归属', async () => {
    await withDb(async (db) => {
      const doomed = await createBook(db, { title: '要删的' });
      const keeper = await createBook(db, { title: '留下的' });
      await putCover(db, { bookId: doomed.id, blob: jpeg(1), mime: 'image/jpeg' });
      await putCover(db, { bookId: keeper.id, blob: jpeg(2), mime: 'image/jpeg' });

      await deleteBook(db, doomed.id);

      assert.equal(await getCover(db, doomed.id), undefined);
      assert.deepEqual(await coverBytes(db, keeper.id), [2]);
    });
  });
});

describe('blob ↔ base64 data URL（备份与撤销快照共用）', () => {
  it('往返后字节一致，且前缀是可识别的 data URL', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      const blob = jpeg(0, 127, 255, 42);
      await putCover(db, { bookId: book.id, blob, mime: 'image/jpeg' });

      const cover = await getCover(db, book.id);
      assert.ok(cover !== undefined);
      const dataUrl = await coverToDataUrl(cover);

      assert.ok(dataUrl.startsWith('data:image/jpeg;base64,'), dataUrl.slice(0, 30));
      assert.deepEqual(await bytesOf(dataUrlToBlob('image/jpeg', dataUrl)), [0, 127, 255, 42]);
      assert.equal(await coverToDataUrl({ ...cover, blob: dataUrlToBlob('image/jpeg', dataUrl) }), dataUrl);
    });
  });

  it('isBase64DataUrl 只认真正能解出来的 base64 data URL', async () => {
    await withDb(async (db) => {
      const book = await createBook(db, { title: '书' });
      const cover = await putCover(db, { bookId: book.id, blob: jpeg(7), mime: 'image/jpeg' });
      const good = await coverToDataUrl(cover);

      assert.equal(isBase64DataUrl(good), true);
      for (const bad of [
        '',
        '   ',
        'http://example.com/cover.jpg',
        'data:image/jpeg;base64',
        'data:image/jpeg;base64X,AQID',
        'data:,AQID',
        'data:image/jpeg;base64,这不是 base64',
        42,
        undefined,
      ]) {
        assert.equal(isBase64DataUrl(bad), false, `${String(bad)} 不该被当成合法封面`);
      }
    });
  });

  it('dataUrlToBlob 对坏输入不抛异常：给 0 字节的空图，由调用方决定怎么报', () => {
    for (const bad of ['', '不是 data url', 'data:image/jpeg;base64,###']) {
      assert.equal(dataUrlToBlob('image/jpeg', bad).size, 0);
    }
    assert.equal(dataUrlToBlob('image/jpeg', 'data:image/jpeg;base64,AQID').type, 'image/jpeg');
  });
});
