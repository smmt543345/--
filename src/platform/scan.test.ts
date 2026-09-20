/**
 * 扫码 / 照片识别的失败文案用例（04 §11.12「失败态」与 D2 的失败态表）。
 *
 * 摄像头本身要真机验收，但「哪一种失败说什么话」是纯函数，必须钉死在这里：
 * 文案挂错档，用户看到的就是「打不开摄像头」这种没用的提示，等于没有失败态。
 * 照片那两条尤其不能混：把「图里没条码」说成「图片打不开」，用户会拿着同一张封面照反复重试。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { translatePhotoError, translateScanError } from './scan.ts';

/** 浏览器抛的往往是 DOMException，这里只借用 name 字段的形状。 */
function named(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe('扫码失败 → 人话（04 §11.12）', () => {
  it('权限被拒（NotAllowedError）→ 指路到权限设置', () => {
    const text = translateScanError(named('NotAllowedError', 'Permission denied'));
    assert.match(text, /权限/);
    assert.match(text, /允许/);
  });

  it('没有摄像头（NotFoundError）→ 让人手填', () => {
    const text = translateScanError(named('NotFoundError', 'Requested device not found'));
    assert.match(text, /没找到摄像头/);
    assert.match(text, /手动填/);
  });

  it('摄像头被占用（NotReadableError）→ 让人关掉占用的程序', () => {
    const text = translateScanError(named('NotReadableError', 'Could not start video source'));
    assert.match(text, /占用/);
  });

  it('浏览器不支持（库抛的字符串，不是 Error）→ 换浏览器或手填', () => {
    const text = translateScanError('Camera streaming not supported');
    assert.match(text, /不支持/);
    assert.match(text, /手动填/);
  });

  it('取景器元素缺失（库同步抛的字符串）→ 让人关掉重开', () => {
    const text = translateScanError('HTML Element with id=isbn-scan-x not found');
    assert.match(text, /取景器/);
  });

  it('认不出的错误 → 兜底文案里带上原始信息，便于用户反馈', () => {
    const text = translateScanError(new Error('kaboom'));
    assert.match(text, /打不开摄像头/);
    assert.match(text, /kaboom/);
  });

  it('非 Error 的抛出物也兜得住，不抛异常', () => {
    for (const thrown of [undefined, null, 42, { weird: true }]) {
      assert.equal(typeof translateScanError(thrown), 'string');
    }
  });
});

describe('照片识别失败 → 人话（04 §11.12 D2）', () => {
  it('照片里没条码（ZXing 兜底抛的 NotFoundException）→ 让人重拍封底', () => {
    const text = translatePhotoError(named('NotFoundException', 'No MultiFormat Readers were able to detect the code.'));
    assert.match(text, /没找到条码/);
    assert.match(text, /封底/);
  });

  it('同一异常的另一种真实形状（只有 name、message 为 undefined）仍按「没条码」处理', () => {
    // OneDReader 那一路抛的是 `new NotFoundException()`：Exception 的构造函数把 message 显式设成
    // undefined（third_party/zxing-js.umd.js:76），所以判定只能落在 name 上
    const bare = new Error();
    bare.name = 'NotFoundException';
    bare.message = undefined as unknown as string;
    assert.match(translatePhotoError(bare), /没找到条码/);
  });

  it('图片打不开（库把 Image.onerror 的事件对象原样 reject）→ 让人换一张', () => {
    const text = translatePhotoError(new Event('error'));
    assert.match(text, /打不开/);
    assert.match(text, /换一张/);
  });

  it('入参不是 File 等意外错误 → 兜底说「换一张」并带上原文，不把人指去拍封底', () => {
    // 库对非 File 入参是**同步抛字符串**（esm/html5-qrcode.js:270）
    const text = translatePhotoError('imageFile argument is mandatory and should be instance of File.');
    assert.match(text, /打不开/);
    assert.match(text, /instance of File/);
    assert.doesNotMatch(text, /封底/);
  });
});
