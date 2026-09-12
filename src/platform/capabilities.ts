/**
 * 宿主能力探测。
 *
 * 硬约束（01 §1.1 第 2 条）：**按能力探测，不看 UA 字符串**。
 * 扫码只在浏览器与安卓上承诺可用；桌面端（Tauri）隐藏扫码按钮。
 * 判据不是"是不是桌面"，而是宿主是否注入了已知的原生桥对象。
 */

export type HostKind = 'web' | 'tauri' | 'capacitor';

export interface HostProbe {
  /** Tauri 2 注入的全局对象 */
  hasTauriInternals: boolean;
  /** Capacitor 注入的全局对象 */
  hasCapacitor: boolean;
  /** navigator.mediaDevices.getUserMedia 是否可用 */
  hasGetUserMedia: boolean;
}

export function detectHost(probe: HostProbe): HostKind {
  if (probe.hasTauriInternals) return 'tauri';
  if (probe.hasCapacitor) return 'capacitor';
  return 'web';
}

/** 扫码承诺范围：浏览器与安卓。桌面端即便有摄像头也不承诺（无相机权限）。 */
export function canScan(probe: HostProbe): boolean {
  return probe.hasGetUserMedia && detectHost(probe) !== 'tauri';
}

function hasGlobalObject(name: string): boolean {
  const bag = globalThis as unknown as Record<string, unknown>;
  const value = bag[name];
  return typeof value === 'object' && value !== null;
}

export function probeHost(): HostProbe {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  // 老浏览器没有 mediaDevices，能力探测必须能安全地回答"没有"
  const mediaDevices = nav === undefined ? undefined : (nav as Partial<Navigator>).mediaDevices;
  return {
    hasTauriInternals: hasGlobalObject('__TAURI_INTERNALS__'),
    hasCapacitor: hasGlobalObject('Capacitor'),
    hasGetUserMedia: typeof mediaDevices?.getUserMedia === 'function',
  };
}
