/**
 * 自由文本的小工具（纯逻辑，无 IO）。
 * 放在 domain 而不是 app：UI 与 db 都可能用它，domain 是最低层，不会造成反向依赖。
 */

/**
 * 逗号分隔的自由输入 → 去空、去重、保序的数组。
 * 中英文逗号、顿号、分号、斜杠都认 —— 用户从豆瓣/书店页复制作者名时，
 * 分隔符是什么全看运气，只认半角逗号等于逼用户手工改写。
 */
export function parseList(raw: string): string[] {
  const parts = raw.split(/[,，、;；/]/);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of parts) {
    const value = part.trim();
    if (value === '' || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function joinList(items: readonly string[], separator = '、'): string {
  return items.join(separator);
}

/**
 * 全角数字转半角（０-９ → 0-9）。
 * 中文输入法下打「３０」是常事，直接交给 Number() 会得到 NaN —— 用户看到的是
 * 「请填整数」却完全看不出哪里不对。所有数字输入统一先过这一道。
 */
export function normalizeDigits(raw: string): string {
  return raw.replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
}

/**
 * 十进制正整数解析，失败返回 null。
 * 只认纯数字：「30天」「3.5」「1e2」「-1」「+7」一律 null —— 它们都能被 Number()
 * 勉强解释出个数（甚至一个正数），但用户想填的显然不是那个数，猜错比报错更糟。
 */
export function parsePositiveInt(raw: string): number | null {
  const text = normalizeDigits(raw).trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return value > 0 ? value : null;
}
