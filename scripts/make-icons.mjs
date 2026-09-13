#!/usr/bin/env node
/**
 * 生成 PWA 图标（阶段 F，01 §4）：192/512（manifest）+ 180（apple-touch-icon）。
 *
 * 零依赖：手写最小 PNG 编码器（zlib 是 Node 内置）+ SDF 绘制 + 3 次盒模糊，
 * 不引入图像库——项目原则是依赖尽量少（D8）。
 *
 * 视觉（B5，2026-09-13 定稿）：**木刻版画**。
 * 宣纸底（纤维纹理）+ 黑墨手刻的开卷书（刻痕页线、粗轮廓）+ 朱红印记，
 * 边缘用高频抖动做出手工刻痕感——不是"精致产品图标"，是有作者痕迹的平面作品。
 *
 * 安全区：素材全部落在中心 80% 内（安卓自适应图标会按圆形/圆角矩形裁切，
 * 四角会被切掉，所以朱印放在安全圆内）。背景全出血铺满。
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

/* ---------------- 最小 PNG 编码器 ---------------- */

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}
/** RGBA 缓冲 → PNG（8bit、无隔行） */
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型：RGBA
  const stride = size * 4 + 1; // 每行前一个 0x00 滤波字节
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y += 1) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- 绘制原语（浮点 RGBA + SDF 抗锯齿） ---------------- */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function over(dst, size, x, y, r, g, b, a) {
  if (a <= 0) return;
  const i = (y * size + x) * 4;
  const da = dst[i + 3];
  const oa = a + da * (1 - a);
  if (oa <= 0) return;
  dst[i] = (r * a + dst[i] * da * (1 - a)) / oa;
  dst[i + 1] = (g * a + dst[i + 1] * da * (1 - a)) / oa;
  dst[i + 2] = (b * a + dst[i + 2] * da * (1 - a)) / oa;
  dst[i + 3] = oa;
}

/** 圆角矩形距离场（像素坐标） */
const sdRoundRect = (cx, cy, w, h, r) => (x, y) => {
  const dx = Math.abs(x - cx) - (w / 2 - r);
  const dy = Math.abs(y - cy) - (h / 2 - r);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
};
/** 绕 (ox,oy) 旋转 deg 度后再求距离（用于书页的对称外倾） */
const sdfRot = (deg, ox, oy) => (fn) => {
  const a = (-deg * Math.PI) / 180;
  const cs = Math.cos(a);
  const sn = Math.sin(a);
  return (x, y) => {
    const dx = x - ox;
    const dy = y - oy;
    return fn(ox + dx * cs - dy * sn, oy + dx * sn + dy * cs);
  };
};
/** 手刻抖动：给距离场加高频起伏，边缘带手工刻痕感 */
const rough = (amp, freq, seed) => (fn) => (x, y) =>
  fn(x, y) + amp * (Math.sin(x * freq + seed) * 0.6 + Math.sin(y * freq * 1.17 + seed * 1.7) * 0.4);

/** 以 SDF 覆盖绘制（dist < 0 为内部，单位像素） */
function fillDist(buf, size, distFn, colorFn, alphaMul = 1) {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const cov = clamp01(0.5 - distFn(x + 0.5, y + 0.5));
      if (cov <= 0) continue;
      const c = colorFn(x + 0.5, y + 0.5);
      over(buf, size, x, y, c[0] / 255, c[1] / 255, c[2] / 255, (c[3] ?? 1) * cov * alphaMul);
    }
  }
}
/** 3 次盒模糊 ≈ 高斯：墨块下方的柔影 */
function boxBlur(mask, size, radius) {
  if (radius <= 0) return mask;
  let src = mask;
  let dst = new Float32Array(size * size);
  for (let pass = 0; pass < 3; pass += 1) {
    const r = Math.max(1, Math.round(radius / 3));
    for (let y = 0; y < size; y += 1) {
      let sum = 0;
      for (let x = -r; x <= r; x += 1) sum += src[y * size + Math.min(size - 1, Math.max(0, x))];
      for (let x = 0; x < size; x += 1) {
        dst[y * size + x] = sum / (2 * r + 1);
        sum += src[y * size + Math.min(size - 1, Math.max(0, x + r + 1))] - src[y * size + Math.min(size - 1, Math.max(0, x - r))];
      }
    }
    [src, dst] = [dst, src];
    for (let x = 0; x < size; x += 1) {
      let sum = 0;
      for (let y = -r; y <= r; y += 1) sum += src[Math.min(size - 1, Math.max(0, y)) * size + x];
      for (let y = 0; y < size; y += 1) {
        dst[y * size + x] = sum / (2 * r + 1);
        sum += src[Math.min(size - 1, Math.max(0, y + r + 1)) * size + x] - src[Math.min(size - 1, Math.max(0, y - r)) * size + x];
      }
    }
    [src, dst] = [dst, src];
  }
  return src;
}
function softFill(buf, size, distFn, blurPx, color, alpha) {
  const mask = new Float32Array(size * size);
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) mask[y * size + x] = clamp01(0.5 - distFn(x + 0.5, y + 0.5));
  const blurred = boxBlur(mask, size, blurPx);
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const a = blurred[y * size + x] * alpha;
    if (a > 0.001) over(buf, size, x, y, color[0] / 255, color[1] / 255, color[2] / 255, a);
  }
}
/** 宣纸纤维：逐行微差 + 细密横纹 */
function paperFibers(buf, size, strength, seed = 3) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) >>> 0; return s / 4294967296; };
  for (let y = 0; y < size; y += 1) {
    const f1 = (rnd() - 0.5) * strength;
    const f2 = (rnd() - 0.5) * strength * 0.5;
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      if (buf[i + 3] <= 0.001) continue;
      const n = f1 + f2 * Math.sin(x * 0.35);
      buf[i] = clamp01(buf[i] + n);
      buf[i + 1] = clamp01(buf[i + 1] + n);
      buf[i + 2] = clamp01(buf[i + 2] + n);
    }
  }
}
/** 细颗粒（墨色不匀） */
function grain(buf, size, amount, seed = 7) {
  let s = seed;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const i = (y * size + x) * 4;
    if (buf[i + 3] <= 0.001) continue;
    const n = (rnd() - 0.5) * amount;
    buf[i] = clamp01(buf[i] + n);
    buf[i + 1] = clamp01(buf[i + 1] + n);
    buf[i + 2] = clamp01(buf[i + 2] + n);
  }
}

/* ---------------- 木刻版画图标 ---------------- */

const PAPER = [243, 236, 222]; // 宣纸
const INK = [26, 24, 22]; // 墨
const VERMILION = [186, 58, 44]; // 朱砂

function drawIcon(size) {
  const buf = new Float32Array(size * size * 4);
  const P = (v) => v * size;
  const R = (amp = P(0.005), seed = 3) => rough(amp, 0.075, seed);

  // 宣纸底
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    over(buf, size, x, y, PAPER[0] / 255, PAPER[1] / 255, PAPER[2] / 255, 1);
  }
  paperFibers(buf, size, 0.03, 5);

  // 翻开的书：两页对称外倾，墨影垫底
  const cx = P(0.5);
  const cy = P(0.5);
  const pageW = P(0.225);
  const pageH = P(0.4);
  const leftPage = R(P(0.005), 3)(sdfRot(-9, cx, cy)(sdRoundRect(cx - P(0.118), cy, pageW, pageH, P(0.022))));
  const rightPage = R(P(0.005), 7)(sdfRot(9, cx, cy)(sdRoundRect(cx + P(0.118), cy, pageW, pageH, P(0.022))));
  const book = (x, y) => Math.min(leftPage(x, y), rightPage(x, y));
  softFill(buf, size, (x, y) => book(x, y - P(0.012)), size * 0.012, INK, 0.5);

  // 页心留白 + 粗墨轮廓（先铺纸色再描边，得到"翻开"的中空形）
  fillDist(buf, size, book, () => PAPER);
  fillDist(buf, size, book, (x, y) => (book(x, y) > -P(0.021) ? INK : [0, 0, 0, 0]));

  // 刻痕页线（每页四条，粗细略不匀）
  for (const dy of [-0.105, -0.025, 0.055, 0.135]) {
    fillDist(buf, size, R(P(0.004), 11)(sdfRot(-9, cx, cy)(sdRoundRect(cx - P(0.118), cy + P(dy), P(0.145), P(0.015), P(0.0075)))), () => [...INK, 0.92]);
    fillDist(buf, size, R(P(0.004), 13)(sdfRot(9, cx, cy)(sdRoundRect(cx + P(0.118), cy + P(dy), P(0.145), P(0.015), P(0.0075)))), () => [...INK, 0.92]);
  }
  // 中缝
  fillDist(buf, size, R(P(0.003), 17)(sdRoundRect(cx, cy, P(0.016), P(0.38), P(0.0065))), () => INK);

  // 桌面：一条干净的墨色横档（书架面）
  fillDist(buf, size, R(P(0.002), 9)(sdRoundRect(P(0.5), P(0.785), P(0.44), P(0.026), P(0.013))), () => [...INK, 0.95]);

  // 朱红印记（收在安全圆内，安卓自适应裁切不会切掉）
  fillDist(buf, size, R(P(0.004), 23)(sdRoundRect(P(0.715), P(0.735), P(0.098), P(0.098), P(0.008))), () => [...VERMILION, 0.96]);
  fillDist(buf, size, R(P(0.003), 29)(sdRoundRect(P(0.715), P(0.735), P(0.06), P(0.06), P(0.004))), () => PAPER);

  grain(buf, size, 0.022, 11);
  paperFibers(buf, size, 0.016, 31);

  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < rgba.length; i += 1) rgba[i] = Math.round(clamp01(buf[i]) * 255);
  return rgba;
}

/* ---------------- 产出 ---------------- */

const targets = [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['apple-touch-icon.png', 180],
];

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, size] of targets) {
  const png = encodePng(size, drawIcon(size));
  writeFileSync(resolve(OUT_DIR, name), png);
  const sig = png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  console.log(`${name}: ${png.length} bytes, PNG 签名 ${sig ? 'OK' : '异常'}（${size}×${size}）`);
}
