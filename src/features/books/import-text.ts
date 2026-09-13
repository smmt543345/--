/**
 * 文本类文件与 JSON 的导入源构造（05 §2.1，B4）：`ImportSource` → `ParsedBookRow[]` 的入口。
 *
 * 自 `import-source.ts` 再拆一层（01 §5.2 的尺寸纪律：新增文件 ≤300 行）：那边是基础解析
 * （粘贴 / CSV / 单元格矩阵），这里只放 B4 新增的两种入口——文本类文件的分隔符探测分发、
 * JSON 书单。分隔符探测与 JSON 字段识别本身在 `import-detect.ts`（纯函数，可单独测）。
 */

import { buildColumnMapping } from './import-mapping.ts';
import { detectDelimiter, jsonMatrix, textMatrix } from './import-detect.ts';
import {
  rowsFromSource,
  sourceFromCsv,
  sourceFromMatrix,
  sourceFromPaste,
  type ImportSource,
  type ParsedBookRow,
} from './import-source.ts';

/**
 * 文本类文件（.txt / .md / .tsv）→ 导入源：先探测分隔符（`import-detect.ts`，05 §2.1），
 * 探到就按那个分隔符切表、走 CSV 同款的列映射管线；探不出就按**逗号口径**处理 ——
 * 也就是粘贴文本那套行内语义（全角/半角逗号，末列按 ISBN 读）。「一行一本、用逗号
 * 分隔」的 .txt 与粘贴进来的书单本来就是一回事，不必多一套规则。
 */
export function sourceFromText(text: string, name = '文本文件'): ImportSource {
  const delimiter = detectDelimiter(text);
  if (delimiter === null) return sourceFromPaste(text, name);
  if (delimiter === ',') return sourceFromCsv(text, name);
  return sourceFromMatrix(textMatrix(text, delimiter), name, 'text');
}

/** 05 §2.1 的公开入口：文本类文件 → 行。 */
export function parseTextFile(text: string, name = '文本文件'): ParsedBookRow[] {
  return rowsFromSource(sourceFromText(text, name));
}

/**
 * JSON 文本 → 导入源（05 §2.1）。行号按**数组里第几条**算（1 起）：json 没有「原始行」
 * 这回事，报告里的「第 N 行」就是第 N 条书目。列名由 `jsonMatrix` 给（别名词典认得的
 * 词），所以预览、改映射与 CSV 完全一致。
 */
export function sourceFromJson(text: string, name = 'JSON 文件'): ImportSource {
  const { header, rows } = jsonMatrix(text);
  return {
    kind: 'json',
    name,
    header,
    mapping: buildColumnMapping(header),
    // 空行（认不出字段的元素）只跳过、不挤掉行号（05 §2.1）
    rows: rows.map((cells, index) => ({ line: index + 1, cells })).filter((row) => row.cells.some((cell) => cell !== '')),
  };
}

/** 05 §2.1 的公开入口：JSON 文本 → 行。 */
export function parseJsonFile(text: string, name = 'JSON 文件'): ParsedBookRow[] {
  return rowsFromSource(sourceFromJson(text, name));
}
