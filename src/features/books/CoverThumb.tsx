/**
 * 列表行首的封面缩略图（04 §11.8）：搜索页、位置页、首页「最近添加」共用。
 *
 * 没有照片就**什么都不渲染**（不占位、不报错）—— 空着一格灰框只会让列表多一块噪音。
 * 一张一张地 `getCover` 取（cover 表以 bookId 为主键）：照片是大字段，
 * `listCovers` 会把整表拉进内存，而列表一次只需要屏幕上那几行。
 */

import type { ReactNode } from 'react';

import { useDb } from '../../app/db-context.ts';
import { useObjectUrl } from '../../app/hooks.ts';
import { COVER_EDGE_CLASS, cn } from '../../app/ui.tsx';
import { useLiveQuery } from '../../app/useLiveQuery.ts';
import { getCover } from '../../db/covers.ts';
import type { Cover } from '../../domain/types.ts';

/** 行首缩略图尺寸（04 §11.8：~40px）。边框与圆角见 04 §11.9：6px 圆角 + 1px 细边，边色与详情页共用一份令牌。 */
const THUMB_CLASS = 'h-10 w-10';

export function CoverThumb({ bookId, className }: { bookId: string; className?: string }): ReactNode {
  const db = useDb();
  const cover = useLiveQuery<Cover | null>(async () => (await getCover(db, bookId)) ?? null, [db, bookId], null);
  const url = useObjectUrl(cover === null ? null : cover.blob);

  if (url === null) return null;

  return (
    <img
      src={url}
      // 书名就在同一行旁边，这里再念一遍是重复；缩略图本身是装饰
      alt=""
      className={cn(THUMB_CLASS, COVER_EDGE_CLASS, 'shrink-0 rounded-md object-cover', className)}
    />
  );
}
