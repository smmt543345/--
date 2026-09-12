#!/usr/bin/env node
/**
 * 生成 PWA 图标（阶段 F，01 §4）：192/512（manifest）+ 180（apple-touch-icon）。
 *
 * 零依赖：手写最小 PNG 编码器（zlib 是 Node 内置）。图标是纯几何图形
 * （蓝底 + 打开的书），不引入图像库——项目原则是依赖尽量少（D8）。
 *
 * 内容全部画在中心 50% 以内，满足 Android 自适应图标（maskable）的安全区；
 * 背景全出血铺满，适配各家启动器的裁切形状。
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

/** RGBA 缓冲 → PNG（8bit、无隔行、无透明度层优化） */
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

/* ---------------- 画图（归一化坐标 0..1） ---------------- */

const BLUE_BG = [37, 99, 235]; // Tailwind blue-600，与主按钮同色
const PAGE = [255, 255, 255];
const SPINE = [96, 165, 250]; // blue-400 中缝
const LINE = [219, 234, 254]; // blue-100 页面纹理线

function drawIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const paint = (x, y, color) => {
    const i = (y * size + x) * 4;
    buf[i] = color[0];
    buf[i + 1] = color[1];
    buf[i + 2] = color[2];
    buf[i + 3] = 255;
  };
  const fill = (x0, y0, x1, y1, color) => {
    const X0 = Math.round(x0 * size);
    const Y0 = Math.round(y0 * size);
    const X1 = Math.round(x1 * size);
    const Y1 = Math.round(y1 * size);
    for (let y = Y0; y < Y1; y += 1) {
      for (let x = X0; x < X1; x += 1) paint(x, y, color);
    }
  };

  fill(0, 0, 1, 1, BLUE_BG);
  // 打开的书：左页 / 中缝 / 右页
  fill(0.26, 0.28, 0.48, 0.72, PAGE);
  fill(0.48, 0.28, 0.52, 0.72, SPINE);
  fill(0.52, 0.28, 0.74, 0.72, PAGE);
  // 两页各两条文字纹理线
  fill(0.30, 0.40, 0.45, 0.425, LINE);
  fill(0.30, 0.50, 0.45, 0.525, LINE);
  fill(0.55, 0.40, 0.70, 0.425, LINE);
  fill(0.55, 0.50, 0.70, 0.525, LINE);
  return encodePng(size, buf);
}

/* ---------------- 产出 ---------------- */

const targets = [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['apple-touch-icon.png', 180],
];

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, size] of targets) {
  const png = drawIcon(size);
  writeFileSync(resolve(OUT_DIR, name), png);
  const sig = png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  console.log(`${name}: ${png.length} bytes, PNG 签名 ${sig ? 'OK' : '异常'}（${size}×${size}）`);
}
