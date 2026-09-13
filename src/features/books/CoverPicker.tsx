/**
 * 封面区（04 §11.8）：新增页与详情页共用同一套「📷 拍照 / 选图 → 压缩 → 预览 → 确认」。
 *
 * 两页只差在「确认之后写到哪」：
 * - 详情页：立刻 `putCover`（重拍＝覆盖同一行，02 §3.5）；
 * - 新增页：先记在页面 state 里、保存书目时随书入库 —— **先存书目再存封面**，
 *   因为封面以 bookId 为主键，得先有那本书。
 *
 * 三个状态：待确认的（staged：用这张 / 重拍 / 取消）、已确认的（current）、没有（占位图标）。
 * 失败态（04 §11.8）：解不开的图把 `compressImage` 那句人话原样显示出来，
 * 只提示、不阻断手填与保存。
 */

import { useRef, useState, type ReactNode } from 'react';

import { useObjectUrl } from '../../app/hooks.ts';
import { COVER_LABELS, coverPhotoAlt } from '../../app/labels.ts';
import { Button, InlineError, cn } from '../../app/ui.tsx';
import { compressImage, type CompressedImage } from '../../platform/image.ts';

/** 画框尺寸：详情页大图 / 表单里的预览。 */
const FRAME_SIZES = {
  sm: 'h-28 w-20',
  lg: 'h-36 w-24',
} as const;

const FRAME_ICON_SIZES = {
  sm: 'text-xl',
  lg: 'text-2xl',
} as const;

// 边框颜色写在这里：Tailwind v4 的 `border` 不带颜色时用 currentColor，正文色当边框太重
const FRAME_CLASS = 'shrink-0 rounded-lg border border-neutral-200 object-cover dark:border-neutral-800';

export interface CoverPickerProps {
  /** 这本书的书名，只用于封面图的 alt */
  title: string;
  /** 已确认的那张：详情页＝库里那张，新增页＝本次待保存那张；null = 还没有 */
  current: CompressedImage | null;
  /** 用户点了「用这张」——详情页去 putCover，新增页记进页面 state */
  onConfirm: (image: CompressedImage) => void;
  /** 「删照片」按钮；不传就只显示拍照/更换 */
  onDelete?: () => void;
  /** 删除按钮上的字（新增页是「不用这张」） */
  removeLabel?: string;
  /** 写库进行中：按钮一律禁用，避免连点两次发两次写 */
  pending?: boolean;
  disabled?: boolean;
  /** 没有本机照片时退回显示的封面图 URL（v1 的 `Book.coverUrl` 字段） */
  fallbackUrl?: string;
  size?: keyof typeof FRAME_SIZES;
}

export function CoverPicker({
  title,
  current,
  onConfirm,
  onDelete,
  removeLabel = COVER_LABELS.remove,
  pending = false,
  disabled = false,
  fallbackUrl = '',
  size = 'sm',
}: CoverPickerProps): ReactNode {
  const inputRef = useRef<HTMLInputElement>(null);
  const [staged, setStaged] = useState<CompressedImage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 记下加载失败的那个 URL 而不是布尔量：换成另一张网络封面图时要重新试一次
  const [brokenFallback, setBrokenFallback] = useState('');

  const shown = staged ?? current;
  const shownUrl = useObjectUrl(shown === null ? null : shown.blob);
  const showFallback = shown === null && fallbackUrl !== '' && brokenFallback !== fallbackUrl;
  const locked = busy || disabled || pending;

  function openPicker(): void {
    setError(null);
    inputRef.current?.click();
  }

  function takeFile(file: Blob): void {
    setError(null);
    setBusy(true);
    void (async () => {
      try {
        setStaged(await compressImage(file));
      } catch (err: unknown) {
        // 解不开的图带着 COVER_READ_FAILED 那句人话上来；万一抛的不是 Error，也别显示 [object Object]
        setError(err instanceof Error && err.message !== '' ? err.message : COVER_LABELS.readFailed);
      } finally {
        setBusy(false);
      }
    })();
  }

  function confirm(): void {
    if (staged === null) return;
    onConfirm(staged);
    // 交出去的这张由页面持有；这里回到「已确认」态，避免出现两张待确认的照片
    setStaged(null);
  }

  return (
    <div className="space-y-2">
      {/* 手机直接调相机，电脑是选图片文件（04 §11.8）。真正可点的按钮在下面，
          所以这个 input 不进 Tab 序列、也不被读屏单独念一遍 */}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // 清空 value：同一张照片再选一次也要能触发 change（「重拍」时很常见）
          event.target.value = '';
          if (file !== undefined) takeFile(file);
        }}
      />

      {shownUrl !== null ? (
        <img src={shownUrl} alt={coverPhotoAlt(title)} className={cn(FRAME_CLASS, FRAME_SIZES[size])} />
      ) : showFallback ? (
        <img
          src={fallbackUrl}
          alt={coverPhotoAlt(title)}
          onError={() => setBrokenFallback(fallbackUrl)}
          className={cn(FRAME_CLASS, FRAME_SIZES[size])}
        />
      ) : (
        <div
          className={cn(
            FRAME_SIZES[size],
            'flex shrink-0 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-neutral-300 text-neutral-400 dark:border-neutral-700 dark:text-neutral-500',
          )}
        >
          <span aria-hidden="true" className={FRAME_ICON_SIZES[size]}>
            📷
          </span>
          <span className="text-xs">{COVER_LABELS.empty}</span>
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {staged !== null ? (
          <>
            <Button size="sm" variant="primary" onClick={confirm} disabled={locked}>
              {COVER_LABELS.confirm}
            </Button>
            <Button size="sm" onClick={openPicker} disabled={locked}>
              {busy ? COVER_LABELS.compressing : COVER_LABELS.retake}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setStaged(null)} disabled={locked}>
              {COVER_LABELS.cancel}
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" onClick={openPicker} disabled={locked}>
              {busy ? COVER_LABELS.compressing : current === null ? COVER_LABELS.capture : COVER_LABELS.replace}
            </Button>
            {current !== null && onDelete !== undefined && (
              <Button size="sm" variant="ghost" onClick={onDelete} disabled={locked}>
                {removeLabel}
              </Button>
            )}
          </>
        )}
      </div>

      {staged === null && <p className="text-xs text-neutral-500 dark:text-neutral-400">{COVER_LABELS.hint}</p>}
      {error !== null && <InlineError>{error}</InlineError>}
    </div>
  );
}
