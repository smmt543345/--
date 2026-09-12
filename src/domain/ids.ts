/**
 * ID 生成与标识校验。
 *
 * 为什么不用 crypto.randomUUID()：它被 secure context 门控，而各宿主
 * （Tauri 的 http://tauri.localhost / tauri://localhost、Capacitor、PWA）
 * 对"是否安全上下文"的判定不一致。见 docs/design/01-architecture.md §1.1。
 * 这里用 crypto.getRandomValues() 自行构造 UUID v4，任何环境都可用；
 * 存在 randomUUID 时作为快路径，但正确性不依赖它。
 */

/** 「未分类」保留位置 id：字面量不含连字符，不可能与 UUID 冲突。 */
export const UNSORTED_LOCATION_ID = '__unsorted__';
export const UNSORTED_LOCATION_NAME = '未分类';

const HEX = '0123456789abcdef';

export function newId(): string {
  const g = globalThis.crypto;
  if (typeof g?.randomUUID === 'function') return g.randomUUID();

  const bytes = new Uint8Array(16);
  g.getRandomValues(bytes);
  // 版本位 = 4，变体位 = 10xx（RFC 4122 §4.4）
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  let out = '';
  for (let i = 0; i < 16; i++) {
    const b = bytes[i] ?? 0;
    if (i === 4 || i === 6 || i === 8 || i === 10) out += '-';
    out += HEX[b >> 4];
    out += HEX[b & 0x0f];
  }
  return out;
}

/** 校验一个值能否作为实体 id 使用（不限制格式，导入要宽进）。 */
export function isValidId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
