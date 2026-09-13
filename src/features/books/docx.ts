/**
 * Word 书单解析（05 §2.1，B4）。
 *
 * `.docx` 就是一个 zip，正文在 `word/document.xml` 里。这一层只做两件事：用 fflate
 * 解压（**动态 import**，只有用户真选了 Word 文件才把它拉进内存，不进首屏包，01 §2）、
 * 从 XML 里按文档顺序取出「表格行 / 段落」。行语义（什么算一条书、哪列是哪个字段）交给
 * `import.ts` 的列映射管线——与 CSV/xlsx 完全同构（05 §2.1「解析结果与其他格式同构」）。
 */

import {
  rowsFromCells,
  sourceFromMatrix,
  splitRowCells,
  type ImportSource,
  type ParsedBookRow,
} from './import.ts';

/** 正文本体在 zip 里的路径；没有它就不是一份能读的 docx（05 §2.1）。 */
const DOCUMENT_PATH = 'word/document.xml';

/** 单元格里一个段落接一个段落时的连接符：一个单元格 = 一个字段值，不能带换行。 */
const CELL_JOIN = ' ';

/**
 * 标签扫描：`<w:tr>` / `</w:tc>` / `<w:br/>` 都认得。
 * WordprocessingML 的属性值里不会出现 `>`，所以按「到第一个 `>` 为止」切标签是安全的。
 */
const TAG = /<(\/?)([A-Za-z0-9:._-]+)[^>]*?(\/?)>/g;

/**
 * `word/document.xml` → 单元格矩阵（05 §2.1）。
 *
 * - 表格（`<w:tbl>`）里每行 `<w:tr>` 是一条书，单元格 `<w:tc>` 对应列；
 * - 表格之外的段落 `<w:p>` 也当行读（「文档末尾的散段也当行读」）：段内有分隔符就按
 *   §2.1 的逗号口径切列，没有就是单列（整段当一个书名）。
 *
 * 文字只取 `<w:t>` 里的内容（正文就在这里）；`<w:tab/>` 与 `<w:br/>` 当空格处理——
 * 行由 `<w:p>` / `<w:tr>` 决定，段内的软换行不另起一行。表格里嵌套的表格按外层单元格
 * 的文字处理（只在最外层认行列）。
 */
export function cellsFromDocumentXml(xml: string): string[][] {
  const rows: string[][] = [];
  let tableDepth = 0; // <w:tbl> 深度：1 = 我们认的表
  let rowCells: string[] | null = null; // 当前表格行已收的单元格
  let cellPieces: string[] | null = null; // 当前单元格里的文字片段
  let paragraphPieces: string[] | null = null; // 表格外当前段落的文字片段
  let capture: string[] | null = null; // <w:t> 文字的落点
  let cursor = 0; // 上一个标签的结束位置（标签之间的原文就是文本节点）
  const cellText = (): string => (cellPieces ?? []).join('').trim();

  TAG.lastIndex = 0;
  for (let match = TAG.exec(xml); match !== null; match = TAG.exec(xml)) {
    if (capture !== null && match.index > cursor) capture.push(decodeXml(xml.slice(cursor, match.index)));
    cursor = match.index + match[0].length;

    const closing = match[1] === '/';
    const name = match[2] ?? '';
    const selfClosing = match[3] === '/';

    if (name === 'w:tbl' && !selfClosing) {
      tableDepth += closing ? -1 : 1;
      // 表结束：状态归零，免得半截单元格漏给后面的段落
      if (tableDepth <= 0) {
        tableDepth = 0;
        rowCells = null;
        cellPieces = null;
      }
    } else if (name === 'w:tr' && tableDepth === 1 && !selfClosing) {
      if (closing) {
        if (rowCells !== null) rows.push(rowCells); // 空行照收：矩阵行号要对齐文档里的行
        rowCells = null;
        cellPieces = null;
      } else if (rowCells === null) {
        rowCells = [];
      }
    } else if (name === 'w:tc' && tableDepth === 1 && !selfClosing) {
      if (closing) {
        if (rowCells !== null) rowCells.push(cellText());
        cellPieces = null;
      } else if (cellPieces === null) {
        cellPieces = [];
      }
    } else if (name === 'w:p' && !selfClosing) {
      if (cellPieces !== null) {
        if (closing) cellPieces.push(CELL_JOIN); // 单元格里的多段：空格隔开（收尾 trim 会去多余）
      } else if (tableDepth === 0) {
        if (closing) {
          if (paragraphPieces !== null) rows.push(splitRowCells(paragraphPieces.join('')));
          paragraphPieces = null;
        } else if (paragraphPieces === null) {
          paragraphPieces = [];
        }
      }
    } else if ((name === 'w:br' || name === 'w:tab') && !closing) {
      (cellPieces ?? paragraphPieces)?.push(CELL_JOIN);
    } else if (name === 'w:t') {
      capture = closing || selfClosing ? null : (cellPieces ?? paragraphPieces);
    }
  }
  return rows;
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** XML 实体还原：`&amp;` 这类命名实体，以及 `&#233;` / `&#xE9;` 数字实体。 */
function decodeXml(raw: string): string {
  return raw.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z]+);/g, (whole, body: string) => {
    if (!body.startsWith('#')) return XML_ENTITIES[body.toLowerCase()] ?? whole;
    const hex = body[1] === 'x' || body[1] === 'X';
    const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/**
 * docx 字节 → 单元格矩阵：fflate 解压 + 取 `word/document.xml`。
 * 解压失败（不是 zip）或包里没有正文，都报人话错误，由导入区展示。
 */
export async function readDocxCells(bytes: Uint8Array): Promise<string[][]> {
  const { unzipSync } = await import('fflate');
  let files: Record<string, Uint8Array>;
  try {
    // 只取正文：带照片的 .docx 里内嵌媒体可能很大，filter 让它们不被解压进内存
    files = unzipSync(bytes, { filter: (file) => file.name === DOCUMENT_PATH });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`这个文件不是一份能打开的 .docx（解压失败：${reason}）`);
  }
  const document = files[DOCUMENT_PATH];
  if (document === undefined) throw new Error('这个 .docx 里没有 word/document.xml，读不出内容');
  return cellsFromDocumentXml(new TextDecoder('utf-8').decode(document));
}

/** docx 字节 → 导入源（预览用，列映射可改）；口径见 cellsFromDocumentXml。 */
export async function readDocxSource(bytes: Uint8Array, name = 'Word 文件'): Promise<ImportSource> {
  return sourceFromMatrix(await readDocxCells(bytes), name, 'docx');
}

/** 05 §2.1 的公开入口：docx 字节 → 行。 */
export async function parseDocx(bytes: Uint8Array, name = 'Word 文件'): Promise<ParsedBookRow[]> {
  return rowsFromCells(await readDocxCells(bytes), name, 'docx');
}
