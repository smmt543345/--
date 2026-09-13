/**
 * 借书人合并（03 §4.5）。
 *
 * 按 id 对齐、字段级合并（LWW，createdAt 取较早值，复用 §5.1 的 mergeRecord）。
 * **不做按姓名自动合并**（03 §4.5：收益小、规则复杂，要合并让用户在设置页手动删）。
 * 写入委托 db/borrowers.ts（02 §11），全程运行在调用方（applyImport）的事务内；
 * 上限 20 条在导入后由 borrowers 服务检查（02 §5.5）。
 */

import { enforceBorrowerCapInTx, putBorrowerInTx } from '../db/borrowers.ts';
import type { PocketLibraryDb } from '../db/schema.ts';
import type { Borrower } from '../domain/types.ts';
import { mergeRecord, type ImportSummary } from './format.ts';

export async function mergeBorrowers(
  db: PocketLibraryDb,
  incoming: readonly Borrower[],
  summary: ImportSummary,
): Promise<void> {
  for (const borrower of incoming) {
    const local = await db.borrowers.get(borrower.id);
    if (local === undefined) {
      await putBorrowerInTx(db, borrower);
      summary.borrowers.inserted += 1;
      continue;
    }

    // 无 tags 这类集合字段，纯 LWW（03 §4.5）
    const { record, changed } = mergeRecord(local, borrower);
    if (changed) {
      await putBorrowerInTx(db, record);
      summary.borrowers.updated += 1;
    }
  }

  // 上限 20 条（02 §5.5）：导入后检查，超出按 updatedAt 淘汰最旧
  await enforceBorrowerCapInTx(db);
}
