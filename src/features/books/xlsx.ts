/**
 * xlsx / xls 解析包装（05 §2.1）：页面与其余导入逻辑**不直接 import SheetJS**，
 * 想读 Excel 只能从这里进 —— 换解析库时改动范围就限定在本文件。
 *
 * 依赖走动态 `import('xlsx')`：只有用户真选了 Excel 文件才把它拉进内存，
 * 不进首屏包（01 §2、决策 D10）。单元格只取值不取格式；空单元格同 CSV 空列处理。
 */

import { rowsFromSource, sourceFromMatrix, type ImportSource, type ParsedBookRow } from './import.ts';

/** 工作表 → 单元格矩阵（空单元格补空串）。SheetJS 只在这个文件里出现。 */
async function readCells(bytes: Uint8Array): Promise<string[][]> {
  const xlsx = await import('xlsx');
  const workbook = xlsx.read(bytes, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  if (sheetName === undefined) return [];
  const sheet = workbook.Sheets[sheetName];
  if (sheet === undefined) return [];

  // header:1 → 数组的数组；defval:'' → 空单元格补空串（同 CSV 空列）；
  // blankrows:false → 空行不占位置（行号仍由 sourceFromMatrix 按原始行算）
  const rows = xlsx.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', raw: false, blankrows: false });
  return rows.map((row) =>
    Array.isArray(row) ? row.map((cell) => (cell === null || cell === undefined ? '' : String(cell))) : [],
  );
}

/**
 * xlsx 字节 → 导入源（预览用）。只读**第一个工作表**（05 §2.1）：
 * 首行命中别名词典就当表头，否则按 书名,作者,ISBN 三列读（口径与 CSV 完全一致）。
 */
export async function readXlsxSource(bytes: Uint8Array, name = 'Excel 文件'): Promise<ImportSource> {
  return sourceFromMatrix(await readCells(bytes), name, 'xlsx');
}

/** 05 §2.1 的公开入口：xlsx / xls 字节 → 行。 */
export async function parseXlsx(bytes: Uint8Array, name = 'Excel 文件'): Promise<ParsedBookRow[]> {
  return rowsFromSource(await readXlsxSource(bytes, name));
}
