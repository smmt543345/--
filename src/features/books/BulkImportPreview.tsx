/**
 * 批量导入的预览与报告视图（04 §11.1、05 §2.4）。
 *
 * 自 BulkImportSection 拆出（01 §5.1 的 >300 行拆分）：那支流水线（读表 → 认列 →
 * 建书建副本）与这两块纯展示各自独立——它们只吃 ParsedBookRow / BulkImportReport，
 * 不碰 IO、不碰 service。预览的意义是"先看清楚列识别对不对，再决定写不写库"。
 */

import type { ReactNode } from 'react';

import { IMPORT_FIELD_LABELS } from '../../app/labels.ts';
import { Banner, Button } from '../../app/ui.tsx';
import type { BulkImportReport, ParsedBookRow } from './import.ts';
import type { ColumnMapping, ImportField } from './import-mapping.ts';

/** 预览只看前几行：目的是确认列识别对不对，不是替代书单。 */
export const PREVIEW_ROWS = 5;

/** 预览单元格里的字段值（行语义的唯一真源是 ParsedBookRow，不是原始列）。 */
function fieldText(row: ParsedBookRow, field: ImportField): string {
  switch (field) {
    case 'title':
      return row.title;
    case 'author':
      return row.author;
    case 'isbn':
      return row.isbn;
    case 'publisher':
      return row.publisher;
    case 'publishDate':
      return row.publishDate;
    case 'tags':
      return row.tags.join('、');
    case 'location':
      return row.location;
    case 'copies':
      return row.copies === null ? '' : String(row.copies);
  }
}

/** 预览表：前 5 行 + 每行原始行号。列 = 当前映射命中的字段。 */
export function PreviewTable({ rows, mapping }: { rows: readonly ParsedBookRow[]; mapping: ColumnMapping | null }): ReactNode {
  const fields: ImportField[] =
    mapping === null
      ? ['title', 'author', 'isbn']
      : [...new Set(mapping.filter((field): field is ImportField => field !== null))];

  return (
    <div className="space-y-1">
      <div className="overflow-x-auto">
        <table className="w-full min-w-max text-left text-xs">
          <thead className="text-neutral-500 dark:text-neutral-400">
            <tr>
              <th className="py-1 pr-3 font-medium">行</th>
              {fields.map((field) => (
                <th key={field} className="py-1 pr-3 font-medium">
                  {IMPORT_FIELD_LABELS[field]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="text-neutral-800 dark:text-neutral-200">
            {rows.slice(0, PREVIEW_ROWS).map((row) => (
              <tr key={row.line} className="border-t border-neutral-200/70 dark:border-neutral-800/70">
                <td className="py-1 pr-3 text-neutral-400 dark:text-neutral-500">{row.line}</td>
                {fields.map((field) => (
                  <td key={field} className="max-w-[14rem] truncate py-1 pr-3">
                    {fieldText(row, field) === '' ? '—' : fieldText(row, field)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > PREVIEW_ROWS && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          后面还有 {rows.length - PREVIEW_ROWS} 行，预览只显示前 {PREVIEW_ROWS} 行。
        </p>
      )}
    </div>
  );
}

/** 执行后的报告（05 §2.4）：新建/副本/跳过/疑似重复分开展示，警告单独一条。 */
export function ReportView({ report, onBrowse }: { report: BulkImportReport; onBrowse: () => void }): ReactNode {
  return (
    <div className="space-y-2 border-t border-neutral-200 pt-3 dark:border-neutral-800">
      <p className="text-sm text-neutral-800 dark:text-neutral-200">
        ✅ 新建书目 {report.created} 本
        {report.copiesCreated > 0 && <span> · 新建副本 {report.copiesCreated} 本</span>}
        {report.skipped.length > 0 && (
          <span className="text-neutral-500 dark:text-neutral-400"> · ⏭ 跳过 {report.skipped.length} 条</span>
        )}
        {report.suspected.length > 0 && (
          <span className="text-amber-700 dark:text-amber-300"> · ⚠ 疑似重复 {report.suspected.length} 条</span>
        )}
      </p>
      {report.skipped.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-xs text-neutral-500 dark:text-neutral-400">
          {report.skipped.map((item) => (
            <li key={`skip-${item.line}-${item.reason}`}>
              {item.line > 0 ? `第 ${item.line} 行：` : ''}
              {item.reason}
            </li>
          ))}
        </ul>
      )}
      {report.warnings.length > 0 && (
        <Banner tone="amber">
          <ul className="space-y-1">
            {report.warnings.map((item) => (
              <li key={`warn-${item.line}-${item.reason}`}>
                第 {item.line} 行：{item.reason}
              </li>
            ))}
          </ul>
        </Banner>
      )}
      {report.suspected.length > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          疑似重复（已创建）：
          {report.suspected.map((item) => `第 ${item.line} 行《${item.title}》`).join('、')}
          ——如果其实是同一本书，去详情页合并副本即可。
        </p>
      )}
      {report.created > 0 && (
        <Button variant="ghost" onClick={onBrowse}>
          去搜索页看看 →
        </Button>
      )}
    </div>
  );
}
