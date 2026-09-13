/**
 * 封面服务。规范见 docs/design/02-data-model.md §3.5、§6 I10、§11。
 *
 * - 一本书一张：`bookId` 是主键，重拍 = 覆盖同一行。
 * - 照片只存本机（IndexedDB Blob），不上传任何服务。
 * - blob ↔ base64 data URL 的转换也在这里：备份导出（03 §2）与导入合并（03 §4.7）
 *   共用这一份实现，不另造第二套。
 *
 * 写操作**不计入写计数器**（02 §12.3 的计数口径只含五张业务表）：快照不含封面，
 * 让「拍了张照片」触发一张不含该照片的自动快照没有意义。
 */

import { nowIso } from '../domain/time.ts';
import type { Cover } from '../domain/types.ts';
import type { PocketLibraryDb } from './schema.ts';

export interface PutCoverInput {
  bookId: string;
  /** 压缩后的 JPEG（长边 ≤1000px，02 §3.5） */
  blob: Blob;
  /** 固定 image/jpeg（v1 只收这一种） */
  mime: string;
}

export async function getCover(db: PocketLibraryDb, bookId: string): Promise<Cover | undefined> {
  return db.covers.get(bookId);
}

export async function listCovers(db: PocketLibraryDb): Promise<Cover[]> {
  return db.covers.toArray();
}

/**
 * upsert（02 §3.5：一本书一张，重拍覆盖同一行）。
 * `createdAt` 只在首次写入时定，重拍只刷新 `updatedAt`（02 §11 的字段读写责任）。
 */
export async function putCover(
  db: PocketLibraryDb,
  input: PutCoverInput,
  options: { now?: string } = {},
): Promise<Cover> {
  return db.transaction('rw', db.covers, async () => {
    const stamp = options.now ?? nowIso();
    const existing = await db.covers.get(input.bookId);
    const cover: Cover = {
      bookId: input.bookId,
      blob: input.blob,
      mime: input.mime,
      createdAt: existing?.createdAt ?? stamp,
      updatedAt: stamp,
    };
    await db.covers.put(cover);
    return cover;
  });
}

/**
 * 删封面（02 §9：删书目级联删封面）。
 * 只删封面本身 —— 撤销删除时封面从 undo 快照写回，孤儿封面由 repair 兜底（§6 I10）。
 */
export async function deleteCover(db: PocketLibraryDb, bookId: string): Promise<void> {
  await db.covers.delete(bookId);
}

/* ------------------------------------------------------------------ *
 * blob ↔ data URL（备份文件与撤销快照共用）
 * ------------------------------------------------------------------ */

/** 是不是一份能解出来的 base64 data URL（清洗阶段的判据，03 §3.1）。 */
export function isBase64DataUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const payload = splitDataUrl(value);
  if (payload === null) return false;
  try {
    atob(payload);
    return true;
  } catch {
    return false;
  }
}

/** Cover → `data:image/jpeg;base64,...`（03 §2 封面段的形态）。 */
export async function coverToDataUrl(cover: Cover): Promise<string> {
  const bytes = new Uint8Array(await cover.blob.arrayBuffer());
  return `data:${cover.mime};base64,${bytesToBase64(bytes)}`;
}

/**
 * data URL → Blob。**刻意不抛异常**：解不出内容时给 0 字节的 Blob，
 * 由调用方决定怎么报（清洗阶段已用 `isBase64DataUrl` 把这类记录挡在门外）。
 */
export function dataUrlToBlob(mime: string, dataUrl: string): Blob {
  const payload = splitDataUrl(dataUrl);
  return new Blob([payload === null ? new Uint8Array(0) : base64ToBytes(payload)], { type: mime });
}

/** 拆出 data URL 的 base64 载荷；不是 `<data:...;base64,>` 形态时返回 null。 */
function splitDataUrl(value: string): string | null {
  if (!value.startsWith('data:')) return null;
  const comma = value.indexOf(',');
  if (comma < 0) return null;
  if (!value.slice(5, comma).endsWith(';base64')) return null;
  return value.slice(comma + 1);
}

/** 分块拼接：一次性 `String.fromCharCode(...bytes)` 会在几十 KB 的数组上炸栈。 */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(payload: string): Uint8Array<ArrayBuffer> {
  if (payload === '') return new Uint8Array(0);
  let binary: string;
  try {
    binary = atob(payload);
  } catch {
    return new Uint8Array(0);
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
