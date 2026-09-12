/**
 * 备份与设置页的纯逻辑（04 §6、03 §6）。
 *
 * 放 features 而不是页面里：这些规则要能被 `node --test` 直接测（.tsx 跑不了），
 * 也避免同一句「将要删掉多少东西」的确认文案在「清空数据」和「替换导入」两处各写一份、
 * 慢慢漂开。数量一律从实际查询取，不猜（04 §6）。
 */

import type { BackupCounts, ImportMode, ImportSummary } from '../../backup/format.ts';
import type { RepairReport } from '../../db/repair.ts';
import { parsePositiveInt } from '../../domain/text.ts';

/** 借期的合法区间。上限只是防手滑（9999 天不叫借期），不是业务规则。 */
export const MAX_LOAN_PERIOD_DAYS = 365;

/** 设备名只写进备份文件供人辨认，长度限制同样是防手滑。 */
export const MAX_DEVICE_NAME_LENGTH = 30;

/* ------------------------------------------------------------------ *
 * 借期与设备名
 * ------------------------------------------------------------------ */

export type NumberParse = { ok: true; value: number } | { ok: false; error: string };

/** 解析默认借期（天）。只认十进制正整数，全角数字按半角读。 */
export function parseLoanPeriodDays(raw: string): NumberParse {
  const value = parsePositiveInt(raw);
  if (value === null) return { ok: false, error: '借期要填整数天数，例如 30' };
  if (value > MAX_LOAN_PERIOD_DAYS) {
    return { ok: false, error: `借期最多 ${MAX_LOAN_PERIOD_DAYS} 天；真有借得更久的，在借出时手填应还日期` };
  }
  return { ok: true, value };
}

/** 设备名允许留空（备份文件里就是空字符串，表示没起名字）。 */
export function validateDeviceName(raw: string): string | null {
  if (raw.trim().length > MAX_DEVICE_NAME_LENGTH) return `设备名最多 ${MAX_DEVICE_NAME_LENGTH} 个字`;
  return null;
}

/* ------------------------------------------------------------------ *
 * 导入
 * ------------------------------------------------------------------ */

/** 值域封闭（04 §5）：单选组给回来的是字符串，用不上的一律 null。 */
export function parseImportMode(raw: string): ImportMode | null {
  return raw === 'merge' || raw === 'replace' ? raw : null;
}

/**
 * 预览结果是否仍然对应当前选择。
 *
 * 预览是「按某个模式完整跑一遍再回滚」，那些数字属于跑的那个模式：用户在预览之后
 * 把模式从「合并」改成「替换」，屏幕上的数字就还是上一套的 —— 这时必须重新预览，
 * 否则等于让人对着 A 的后果按下了 B 的确认键。
 */
export function previewMatchesChoice(
  preview: { mode: ImportMode; dryRun: boolean } | null,
  mode: ImportMode,
): boolean {
  return preview !== null && preview.dryRun && preview.mode === mode;
}

/* ------------------------------------------------------------------ *
 * 破坏性操作的确认文案（04 §6：必须带具体数量）
 * ------------------------------------------------------------------ */

/** 「N 条书目、M 本副本…」—— 两处确认框共用一份口径。 */
export function describeLibraryCounts(counts: BackupCounts): string {
  return `${counts.books} 条书目、${counts.copies} 本副本、${counts.locations} 个位置、${counts.loans} 条借出记录`;
}

export function describeClearAllData(counts: BackupCounts): string {
  return `将删除本机的 ${describeLibraryCounts(counts)}。删除后无法撤销，只能靠之前导出的备份文件恢复。主题与设备名属于本机偏好，会保留。`;
}

export function describeReplaceImport(counts: BackupCounts, preview: ImportSummary): string {
  const incoming = `书目 ${preview.books.inserted} 条、副本 ${preview.copies.inserted} 本、位置 ${preview.locations.inserted} 个`;
  return `替换会先清空本机的 ${describeLibraryCounts(counts)}，再写入文件里的 ${incoming}。本机现有的借出记录也会一并清掉，无法撤销。`;
}

/* ------------------------------------------------------------------ *
 * 体检与修复结果
 * ------------------------------------------------------------------ */

export interface ReportRow {
  label: string;
  value: string;
}

/** 只列非零项：一份大半是 0 的报告比一句「没有问题」更难读。 */
export function describeRepairReport(report: RepairReport): ReportRow[] {
  const rows: ReportRow[] = [];
  const push = (label: string, value: number): void => {
    if (value > 0) rows.push({ label, value: `${value} 处` });
  };

  push('补上失效的上级位置', report.danglingParentsFixed);
  push('打断位置层级环', report.cyclesBroken);
  push('副本改挂到「未分类」', report.copiesRepointed);
  push('删除内容已丢失的副本', report.copiesDeleted);
  push('删除指向已删副本的借出记录', report.loansDeleted);
  push('解决重复的进行中借出', report.duplicateActiveLoansResolved);
  push('校正副本状态', report.copyStatusFixed);
  push('重建位置路径', report.pathsRebuilt);
  if (report.warnings.length > 0) rows.push({ label: '附带告警', value: `${report.warnings.length} 条` });
  if (rows.length === 0) rows.push({ label: '结果', value: '没有需要修复的问题' });
  return rows;
}
