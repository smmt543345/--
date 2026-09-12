import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canScan, detectHost, type HostProbe } from './capabilities.ts';

const WEB: HostProbe = { hasTauriInternals: false, hasCapacitor: false, hasGetUserMedia: true };
const ANDROID: HostProbe = { hasTauriInternals: false, hasCapacitor: true, hasGetUserMedia: true };
const DESKTOP: HostProbe = { hasTauriInternals: true, hasCapacitor: false, hasGetUserMedia: true };

describe('detectHost', () => {
  it('按注入的原生桥对象判断宿主', () => {
    assert.equal(detectHost(WEB), 'web');
    assert.equal(detectHost(ANDROID), 'capacitor');
    assert.equal(detectHost(DESKTOP), 'tauri');
  });

  it('没有桥对象就是普通浏览器，即便没有摄像头', () => {
    assert.equal(detectHost({ ...WEB, hasGetUserMedia: false }), 'web');
  });
});

describe('canScan（01 §1.1 第 2 条）', () => {
  it('浏览器与安卓有摄像头时可用', () => {
    assert.equal(canScan(WEB), true);
    assert.equal(canScan(ANDROID), true);
  });

  it('桌面端即便探测到摄像头也不承诺扫码', () => {
    assert.equal(canScan(DESKTOP), false);
  });

  it('没有 getUserMedia 时不可用', () => {
    assert.equal(canScan({ ...WEB, hasGetUserMedia: false }), false);
    assert.equal(canScan({ ...ANDROID, hasGetUserMedia: false }), false);
  });
});
