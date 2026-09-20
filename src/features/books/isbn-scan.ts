/**
 * 条码文本 → ISBN（04 §11.12「只认 EAN-13」那张表）。纯逻辑，可 `node --test`。
 *
 * **前缀门在这里，不在 `normalizeIsbn`**（04 §11.12「前缀门落在哪」）：978/979 的判定属于
 * 「扫码比手填更严」这一条业务规则，`domain/isbn.ts` 只管清洗与校验位（02 §7.3），
 * 手填与导入仍按「无效不阻塞保存」的老口径走。
 *
 * 清洗直接借用 `normalizeIsbn` 的 `cleaned`（去连字符/空格/全角、X 转大写），不另写一份。
 */

import { normalizeIsbn } from '../../domain/isbn.ts';

/** 认不出来时要说的话。两种都「继续扫描」——不关弹层、不填表（04 §11.12）。 */
export const SCAN_NOTICE = {
  /** 977 开头：期刊条码（ISSN 的 EAN 形态，不是图书） */
  journal: '这不是图书条码（977 开头的是期刊）：继续对准图书背面的 ISBN 条码',
  /** 乱码 / 校验位不对 / 不是条码 */
  unreadable: '没读出 ISBN：把图书背面的条码放进取景框，或关掉这里手动填',
} as const;

export type ScanOutcome =
  /** 合法图书条码：isbn13 已规范化（ISBN-10 也在这里转成 ISBN-13，决策 D4） */
  | { kind: 'ok'; isbn13: string }
  /** 认出来了，但不是图书：提示后继续扫 */
  | { kind: 'rejected'; message: string };

const BARCODE_LENGTH = 13;

/**
 * 扫到的条码文本 → 判定结果。
 *
 * 覆盖 04 §11.12 表的每一行：合法 ISBN-13 / 带连字符空格 / ISBN-10 / 977 期刊条码 /
 * 带 EAN-5 附加码（取前 13 位）/ 其余乱码。
 */
export function isbnFromBarcode(text: string): ScanOutcome {
  const { cleaned } = normalizeIsbn(text);
  if (cleaned === '') return { kind: 'rejected', message: SCAN_NOTICE.unreadable };

  // EAN-13 域：977 是期刊（ISSN）的前缀，不是图书 —— 这里就是那道前缀门
  const head = cleaned.slice(0, BARCODE_LENGTH);
  if (head.length === BARCODE_LENGTH && head.startsWith('977')) {
    return { kind: 'rejected', message: SCAN_NOTICE.journal };
  }

  // 带 EAN-5 附加码（期刊、超市标签常见）：条码文本是 13 + 5 位，只用前 13 位判定
  const result = normalizeIsbn(head.length === BARCODE_LENGTH ? head : cleaned);
  if (result.valid && result.isbn13 !== '') return { kind: 'ok', isbn13: result.isbn13 };
  return { kind: 'rejected', message: SCAN_NOTICE.unreadable };
}
