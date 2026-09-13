/**
 * 封面压缩的纯逻辑测试（04 §11.8）。
 *
 * Node 里没有 canvas 也没有 `<img>`，所以压缩流水线通过 `ImagePipeline` 注入假的
 * 解码器/编码器：真正要断言的是「长边压到 1000 以内、一定出 JPEG、失败给人话」
 * 这三件事，而它们都在 `compressImage` 自己的代码里，不在浏览器的实现里。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COVER_MAX_EDGE,
  COVER_MIME,
  COVER_READ_FAILED,
  compressImage,
  fitWithin,
  objectUrlOf,
  releaseObjectUrl,
  type ImagePipeline,
} from './image.ts';

/** Node 里没有真的图片对象，这个只当个令牌，用来断言「原样的 source 传下去了」。 */
const FAKE_SOURCE = {} as unknown as CanvasImageSource;

interface EncodeCall {
  source: CanvasImageSource;
  size: { width: number; height: number };
  quality: number;
}

/** 记录调用参数的假流水线；`load` / `encode` 的行为按用例覆写。 */
function fakePipeline(overrides: Partial<ImagePipeline> = {}): { pipeline: ImagePipeline; calls: EncodeCall[]; released: () => number } {
  const calls: EncodeCall[] = [];
  let releases = 0;
  const pipeline: ImagePipeline = {
    load: async () => ({
      source: FAKE_SOURCE,
      width: 3000,
      height: 2000,
      release: () => {
        releases += 1;
      },
    }),
    encode: async (source, size, quality) => {
      calls.push({ source, size, quality });
      return new Blob([new Uint8Array([1, 2, 3])], { type: COVER_MIME });
    },
    ...overrides,
  };
  return { pipeline, calls, released: () => releases };
}

describe('fitWithin（长边 ≤1000px，04 §11.8）', () => {
  it('横图按长边等比缩，短边跟着缩', () => {
    assert.deepEqual(fitWithin(3000, 2000), { width: 1000, height: 667 });
  });

  it('竖图同样按长边缩，不会越缩越小', () => {
    assert.deepEqual(fitWithin(1000, 4000), { width: 250, height: 1000 });
  });

  it('本来就在上限内的图不放大', () => {
    assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600 });
    assert.deepEqual(fitWithin(1000, 1500), { width: 667, height: 1000 });
  });

  it('极端长条缩完也不会出现 0 像素的边', () => {
    assert.deepEqual(fitWithin(1, 9999), { width: 1, height: 1000 });
    assert.deepEqual(fitWithin(9999, 1), { width: 1000, height: 1 });
  });

  it('上限可覆盖（默认就是 04 §11.8 的 1000）', () => {
    assert.equal(COVER_MAX_EDGE, 1000);
    assert.deepEqual(fitWithin(3000, 2000, 500), { width: 500, height: 333 });
  });

  it('取不出正数的尺寸＝这张图解不开，抛人话', () => {
    assert.throws(() => fitWithin(0, 100), new Error(COVER_READ_FAILED));
    assert.throws(() => fitWithin(100, 0), new Error(COVER_READ_FAILED));
    assert.throws(() => fitWithin(Number.NaN, 100), new Error(COVER_READ_FAILED));
    assert.throws(() => fitWithin(100, 100, 0), new Error(COVER_READ_FAILED));
  });
});

describe('compressImage（04 §11.8）', () => {
  it('压到长边 1000px 的 JPEG，返回 blob + mime', async () => {
    const { pipeline, calls } = fakePipeline();
    const result = await compressImage(new Blob([]), pipeline);

    assert.equal(result.mime, COVER_MIME);
    assert.equal(result.blob.type, COVER_MIME);
    assert.ok(result.blob.size > 0, '压缩结果不能是空 blob');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.size.width, 1000);
    assert.equal(calls[0]?.size.height, 667);
    assert.equal(calls[0]?.source, FAKE_SOURCE, '画的是解出来那张图本身');
    assert.ok((calls[0]?.quality ?? 0) > 0 && (calls[0]?.quality ?? 1) < 1, 'JPEG 质量要在 (0,1) 内');
  });

  it('解不开的图抛那句人话，不是英文的解码错误', async () => {
    const { pipeline } = fakePipeline({
      load: async () => {
        throw new Error('The source image could not be decoded.');
      },
    });
    await assert.rejects(compressImage(new Blob([]), pipeline), new Error(COVER_READ_FAILED));
  });

  it('编码拿不到结果（canvas 不给 JPEG）也按解不开报，不返回半个结果', async () => {
    const { pipeline } = fakePipeline({ encode: async () => null });
    await assert.rejects(compressImage(new Blob([]), pipeline), new Error(COVER_READ_FAILED));
  });

  it('无论成功还是失败，解码占的资源都要还回去', async () => {
    const ok = fakePipeline();
    await compressImage(new Blob([]), ok.pipeline);
    assert.equal(ok.released(), 1);

    const failed = fakePipeline({
      encode: async () => {
        throw new Error('画布炸了');
      },
    });
    await assert.rejects(compressImage(new Blob([]), failed.pipeline), new Error('画布炸了'));
    assert.equal(failed.released(), 1, '编码失败也要释放 object URL');
  });

  it('尺寸取不出正数时也释放资源，不泄漏 object URL', async () => {
    let releases = 0;
    const { pipeline } = fakePipeline({
      load: async () => ({
        source: FAKE_SOURCE,
        width: 0,
        height: 0,
        release: () => {
          releases += 1;
        },
      }),
    });
    await assert.rejects(compressImage(new Blob([]), pipeline), new Error(COVER_READ_FAILED));
    assert.equal(releases, 1, '尺寸不合法时也走 finally 释放');
  });
});

describe('object URL 辅助', () => {
  it('建出来的地址非空，释放时按原样接受', () => {
    const url = objectUrlOf(new Blob([new Uint8Array([1])], { type: COVER_MIME }));
    assert.equal(typeof url, 'string');
    assert.notEqual(url, '');
    releaseObjectUrl(url);
    releaseObjectUrl(url); // 重复释放不抛：卸载与重拍竞态下会出现
  });
});
