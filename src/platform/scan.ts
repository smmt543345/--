/**
 * 扫码平台层（04 §11.12）：html5-qrcode 的动态加载、摄像头启停与释放、失败翻译成人话。
 * 照片识别（04 §11.12 D2）也在这里：同一份库引用、同一套失败文案口径，只是把「取帧」
 * 换成「解码一张图」——**全程在本地 canvas 上做，不上传任何文件**。
 *
 * 与 xlsx / fflate 同一约定：**动态 `import()`** —— 只有用户真点了「📷 扫码」或「🖼 拍照识别」
 * 才把库拉进内存，不进首屏包（01 §5.5 依赖方向）。features 层只拿字符串进出，DOM、摄像头与库 API 都留在这里。
 *
 * 库里的事实（写之前逐条读过 node_modules/html5-qrcode@2.3.8 的 d.ts 与 esm 产物）：
 * - 构造函数第一个参数是**元素 id 字符串**，不是元素本身（esm/html5-qrcode.d.ts:39）；
 * - 库查元素只用 `document.getElementById`（esm/html5-qrcode.js:139、708），不拼选择器；
 * - `start()` 失败时 reject 的是**字符串**而不是 Error；摄像头错误裹成
 *   `Error getting userMedia, error = NotAllowedError: …`（esm/strings.js:7）；
 * - 没在扫描时 `stop()` 会抛、还在扫描时 `clear()` 会抛（esm/html5-qrcode.js:228、706），
 *   所以释放必须**先 stop() 再 clear()**，且两步都要兜住重复调用。
 *
 * 只引库的**类型**（`import type` 会被编译擦除）：运行时永远只有动态 `import()` 这一条路，
 * 首屏包里不会出现 html5-qrcode。
 */

import type { Html5Qrcode } from 'html5-qrcode';

/** 条码是横长的：取景框用矩形，不是正方形（库 README「rectangular scanning area」）。 */
const BARCODE_BOX = { width: 250, height: 150 };

/** 失败态文案（04 §11.12：权限被拒 / 没有摄像头 / 非安全上下文各给人话，并留手填退路）。 */
const SCAN_MESSAGES = {
  loadFailed: '扫码组件没加载下来：首次使用扫码需要联网加载一次，之后就能离线用。请连上网络再试一次',
  insecure: '摄像头只能在 HTTPS（或 localhost）下打开：当前地址不是安全上下文，请改用 https 地址打开，或手动填 ISBN',
  unsupported: '这个浏览器不支持调用摄像头：请换手机浏览器打开，或手动填 ISBN',
  permissionDenied: '摄像头权限被拒绝了：在浏览器地址栏的权限设置里允许摄像头，再点一次「📷 扫码」',
  noCamera: '没找到摄像头：这台设备可能没有可用的摄像头，请手动填 ISBN',
  cameraBusy: '摄像头打不开：可能被别的程序占用了，关掉正在用摄像头的应用再试',
  viewfinderMissing: '取景器没准备好，请关掉再点一次「📷 扫码」',
  unknown: '打不开摄像头',
  /** 照片识别（04 §11.12 D2 失败态表）：图里没条码 —— 要给出「拍哪一面」的具体动作 */
  photoNoBarcode: '这张照片里没找到条码：拍封底的条码区，别拍封面，换一张再试',
  /** 照片识别：图打不开 / 不是图片 / 出了意料之外的事，都退回这一句（+ 原始信息） */
  photoUnreadable: '这张图片打不开，换一张试试',
} as const;

function describe(error: unknown): string {
  if (error instanceof Error) return error.message === '' ? error.name : error.message;
  return String(error);
}

/**
 * 库/浏览器抛上来的东西 → 人话（04 §11.12 失败态）。
 * 纯字符串判定、不碰 DOM，导出就是为了能单测（用例见同目录 scan.test.ts）。
 */
export function translateScanError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  const text = `${name} ${describe(error)}`;
  if (/NotAllowedError|Permission|permission denied/i.test(text)) return SCAN_MESSAGES.permissionDenied;
  if (/NotFoundError|Requested device not found|no camera/i.test(text)) return SCAN_MESSAGES.noCamera;
  if (/NotReadableError|TrackStartError|Could not start video source|in use/i.test(text)) return SCAN_MESSAGES.cameraBusy;
  // 老浏览器没有 mediaDevices：库把这种情况翻译成这句话（esm/html5-qrcode.js:183）
  if (/Camera streaming not supported/i.test(text)) return SCAN_MESSAGES.unsupported;
  if (/not found|clientWidth|Cannot read properties of null/i.test(text)) return SCAN_MESSAGES.viewfinderMissing;
  return `${SCAN_MESSAGES.unknown}（${describe(error)}）`;
}

/**
 * 照片识别的抛出物 → 人话（04 §11.12 D2 失败态表）。
 *
 * 与 `translateScanError` 分开写，因为同一个信号在两条路上含义不同：ZXing 的
 * `NotFoundException` 在摄像头那条路上是「这一帧没认出来」（每帧都会发生，属正常，不提示），
 * 在照片这条路上才是「这张照片里没有条码」（要明确让人重拍封底）。
 */
export function translatePhotoError(error: unknown): string {
  // 图打不开时库把 `Image.onerror` 的事件对象**原样 reject** 出来（esm/html5-qrcode.js:330），不是 Error
  if (typeof Event !== 'undefined' && error instanceof Event) return SCAN_MESSAGES.photoUnreadable;
  const name = error instanceof Error ? error.name : '';
  const text = `${name} ${describe(error)}`;
  // 解不出条码：ZXing 在 MultiFormatReader 兜底处抛的带 message，OneDReader 抛的连 message 都没有，只有 name
  if (/NotFoundException|No MultiFormat Readers/i.test(text)) return SCAN_MESSAGES.photoNoBarcode;
  // 入参不是 File / 摄像头正开着 / 容器 id 不存在……都不是「图里没有条码」，别把人指去拍封底
  return `${SCAN_MESSAGES.photoUnreadable}（${describe(error)}）`;
}

/** 一次扫描会话：拿到它就能释放摄像头。 */
export interface ScanSession {
  /** 释放摄像头（先 stop() 再 clear()）。幂等：重复调用、已经停过都不抛（04 §11.12 生命周期）。 */
  stop(): Promise<void>;
}

export interface StartScanOptions {
  /** 取景器容器的 DOM id —— 库要的是 id 字符串（由调用方用 useId() 生成） */
  elementId: string;
  /** 每识别到一个条码文本回调一次；收不收、要不要继续扫由调用方决定 */
  onDetected: (text: string) => void;
}

/** 开摄像头前的本地判定：这两条不满足时连库都不用加载。 */
function assertCanStart(): void {
  const globalBag = globalThis as { isSecureContext?: boolean };
  if (globalBag.isSecureContext === false) throw new Error(SCAN_MESSAGES.insecure);
  const mediaDevices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
  if (typeof mediaDevices?.getUserMedia !== 'function') throw new Error(SCAN_MESSAGES.unsupported);
}

async function loadScanner(): Promise<typeof import('html5-qrcode')> {
  try {
    return await import('html5-qrcode');
  } catch (error) {
    // 动态分块没被 SW 缓存时（首次、或断网首次）会走到这里：public/sw.js 是运行时缓存，不预缓存（04 §11.12）
    throw new Error(`${SCAN_MESSAGES.loadFailed}（${describe(error)}）`);
  }
}

/**
 * 打开摄像头开始识别 EAN-13。失败抛**中文人话**（04 §11.12 失败态），调用方原样展示。
 * 调用方必须在自己这一侧（识别成功 / 关弹层 / 组件卸载）调 `stop()`。
 */
export async function startScan({ elementId, onDetected }: StartScanOptions): Promise<ScanSession> {
  assertCanStart();
  const { Html5Qrcode, Html5QrcodeSupportedFormats, Html5QrcodeScannerState } = await loadScanner();

  let scanner: Html5Qrcode;
  try {
    scanner = new Html5Qrcode(elementId, {
      // 只开 EAN_13：这个入口不扫二维码（04 §11.12「只认 EAN-13」）
      formatsToSupport: [Html5QrcodeSupportedFormats.EAN_13],
      verbose: false,
    });
  } catch (error) {
    // 元素缺失时库**同步抛字符串**而不是 Error（esm/html5-qrcode.js:88）：同样要翻成人话
    throw new Error(translateScanError(error));
  }

  async function release(): Promise<void> {
    try {
      // stop() 只在扫描/暂停时才允许调，别的状态它会抛（esm/html5-qrcode.js:228）
      const state = scanner.getState();
      if (state === Html5QrcodeScannerState.SCANNING || state === Html5QrcodeScannerState.PAUSED) {
        await scanner.stop();
      }
    } catch {
      // 已经停了，或停的过程中出错：这里的目标是**一定释放摄像头**，不是把错误抛给关弹层的人
    }
    try {
      // 运行中调 clear() 会抛（esm/html5-qrcode.js:706）；上面已经停过，这里兜的是重复调用
      scanner.clear();
    } catch {
      // 同上：释放动作本身不报错（不释放才是问题——手机摄像头指示灯会常亮）
    }
  }

  try {
    await scanner.start(
      // 手机优先后置摄像头；桌面浏览器会退到默认设备
      { facingMode: 'environment' },
      { fps: 10, qrbox: BARCODE_BOX },
      (text) => onDetected(text),
      // 每帧没认出条码都会回调，这不是错误：静默（真正的失败在下面的 catch 里）
      () => undefined,
    );
  } catch (error) {
    await release();
    throw new Error(translateScanError(error));
  }

  return { stop: release };
}

/* ------------------------------------------------------------------ *
 * 照片识别（04 §11.12 D2）
 * ------------------------------------------------------------------ */

export interface ScanImageOptions {
  /** 解码容器的 DOM id（隐藏 div 即可）—— 库只认 id 字符串，取不到元素会同步抛 */
  elementId: string;
  /** 用户选的图片（相册 / 文件选择器给的 File）。**不上传**：库在本地 canvas 上解码 */
  file: File;
}

/**
 * 从一张照片里解码条码，返回原始文本 —— **判定交给调用方**，与实时扫码走同一个 `isbnFromBarcode`
 * （04 §11.12 D2：判定不关心文本来源）。失败抛中文人话，调用方原样展示。
 *
 * 三条库行为已对着装好的产物逐条核过（04 §11.12 要求先验证再写）：
 * - `scanFileV2(imageFile, showImage)` → `Promise<Html5QrcodeResult>`，取 `.decodedText`
 *   （esm/html5-qrcode.d.ts:46、esm/core.d.ts:62）；
 * - 容器宽度取不到时回退默认宽度（`element.clientWidth ? … : DEFAULT_WIDTH`，esm/html5-qrcode.js:289）；
 * - 解码画布按**原图尺寸**建（`max(图片尺寸, 绘制尺寸)`，esm/html5-qrcode.js:306）—— 大图不缩着解。
 *
 * `showImage = false`：库默认还会往容器里插一张缩过的**可见**画布给人看（:293），
 * 而这里容器的设计就是隐藏的（宽度 0），画了没人看，白画一遍。
 */
export async function scanImageFile({ elementId, file }: ScanImageOptions): Promise<string> {
  const { Html5Qrcode, Html5QrcodeSupportedFormats } = await loadScanner();

  let scanner: Html5Qrcode | null = null;
  try {
    scanner = new Html5Qrcode(elementId, {
      // 与实时扫码同一条口径：只认 EAN-13 图书条码（04 §11.12「只认 EAN-13」）
      formatsToSupport: [Html5QrcodeSupportedFormats.EAN_13],
      verbose: false,
    });
    const result = await scanner.scanFileV2(file, false);
    return result.decodedText;
  } catch (error) {
    // scanFileV2 有两处是**同步抛**而不是 reject（入参不是 File、摄像头正开着），一并兜住
    throw new Error(translatePhotoError(error));
  } finally {
    // 清掉库里插进容器的画布：照片解码不碰摄像头，所以只有 clear() 一步，没有 stop()
    try {
      scanner?.clear();
    } catch {
      // 清理失败不能顶掉上面那条结论（成功的结果或失败的原因），用户要的是那一条
    }
  }
}
