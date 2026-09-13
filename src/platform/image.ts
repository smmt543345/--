/**
 * 封面照片的客户端处理（04 §11.8、02 §3.5）。
 *
 * 边界与 files.ts / ai.ts 一致：features 层把用户选的文件交进来、拿一个压缩好的
 * Blob 出去；`<img>`、canvas、object URL 这些浏览器能力都留在 platform 层。
 *
 * 硬约束（04 §11.8）：**原始大图不入库**。手机原图常有 3–8MB，压到长边 ≤1000px 的
 * JPEG 后约 50–100KB。照片只进本机 IndexedDB，不上传任何服务（02 §3.5）。
 *
 * 解不开的图（不是图片、文件截断、格式解不了）统一抛 `COVER_READ_FAILED` 那一句
 * 人话，页面原样显示、不阻断手填与保存。
 */

/** 压缩后的长边上限（04 §11.8、02 §3.5）。 */
export const COVER_MAX_EDGE = 1000;

/** v1 只收 JPEG（02 §3.5：`Cover.mime` 固定 image/jpeg）。 */
export const COVER_MIME = 'image/jpeg';

/** JPEG 质量：0.8 时 1000px 的照片约 50–100KB，与 04 §11.8 的预估一致。 */
export const COVER_JPEG_QUALITY = 0.8;

/** 图片读不了时的人话（04 §11.8 失败态）。 */
export const COVER_READ_FAILED = '这张图读不了，换一张试试';

/** 一张可以入库的照片：blob 与它的 mime。与 `PutCoverInput` 的前两个字段同形。 */
export interface CompressedImage {
  blob: Blob;
  /** 固定 `COVER_MIME` */
  mime: string;
}

/** 解出来的一张图 + 像素尺寸 + 释放钩子。 */
export interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  /** 释放解码占用的资源（object URL）。**画完再调**，别在 drawImage 之前回收。 */
  release: () => void;
}

/**
 * 解码与编码两个动作（注入点）。默认实现见 `BROWSER_PIPELINE`；
 * 测试里换成假的，整条流水线就能在没有 canvas / `<img>` 的 Node 里跑。
 */
export interface ImagePipeline {
  load: (file: Blob) => Promise<DecodedImage>;
  encode: (
    source: CanvasImageSource,
    size: { width: number; height: number },
    quality: number,
  ) => Promise<Blob | null>;
}

/**
 * 长边压到 `maxEdge` 以内；本来就小的图**不放大**。
 * 尺寸取不出正数（0×0、NaN）说明这张图解不开，按失败态处理。
 */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number = COVER_MAX_EDGE,
): { width: number; height: number } {
  if (!(width > 0) || !(height > 0) || !(maxEdge > 0)) throw new Error(COVER_READ_FAILED);
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  // 极端长条（1×9999）缩完可能不到 1px：取整后兜底成 1，别给 canvas 一个 0
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * 图片文件 → 长边 ≤1000px 的 JPEG（04 §11.8）。
 * 解不开就抛 `COVER_READ_FAILED`，不返回半个结果。
 */
export async function compressImage(
  file: Blob,
  pipeline: ImagePipeline = BROWSER_PIPELINE,
): Promise<CompressedImage> {
  let decoded: DecodedImage;
  try {
    decoded = await pipeline.load(file);
  } catch {
    // 原样往上抛只会得到「The source image could not be decoded」这种英文，页面要的是人话
    throw new Error(COVER_READ_FAILED);
  }
  try {
    const size = fitWithin(decoded.width, decoded.height);
    const blob = await pipeline.encode(decoded.source, size, COVER_JPEG_QUALITY);
    if (blob === null) throw new Error(COVER_READ_FAILED);
    return { blob, mime: COVER_MIME };
  } finally {
    decoded.release();
  }
}

/* ------------------------------------------------------------------ *
 * object URL：建了就必须释放（04 §11.8 的显示侧靠这一对）
 * ------------------------------------------------------------------ */

export function objectUrlOf(blob: Blob): string {
  return URL.createObjectURL(blob);
}

export function releaseObjectUrl(url: string): void {
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------------ *
 * 浏览器实现
 * ------------------------------------------------------------------ */

const BROWSER_PIPELINE: ImagePipeline = {
  load: loadViaImageElement,
  encode: encodeJpeg,
};

/**
 * 用 `<img>` 解码，不用 `createImageBitmap`：`<img>` 默认按 EXIF 方向摆正，
 * 手机竖拍的照片不会横过来（createImageBitmap 默认不摆正，得额外传 imageOrientation）。
 * 解出来的图一直留着，等画完 canvas 再 revoke 这个 object URL。
 */
function loadViaImageElement(file: Blob): Promise<DecodedImage> {
  return new Promise<DecodedImage>((resolve, reject) => {
    const url = objectUrlOf(file);
    const image = new Image();
    const drop = (): void => releaseObjectUrl(url);

    image.onload = () => {
      resolve({ source: image, width: image.naturalWidth, height: image.naturalHeight, release: drop });
    };
    image.onerror = () => {
      drop();
      reject(new Error(COVER_READ_FAILED));
    };
    image.src = url;
  });
}

function encodeJpeg(
  source: CanvasImageSource,
  size: { width: number; height: number },
  quality: number,
): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (context === null) return Promise.resolve(null);
  context.drawImage(source, 0, 0, size.width, size.height);
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob), COVER_MIME, quality);
  });
}
