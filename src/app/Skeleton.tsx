/**
 * 骨架屏（04 §11.9 第 3 条）：整页 / 整块**首次加载**时替代 Spinner。
 *
 * 为什么换掉转圈：转圈只说明"在忙"，骨架屏把"等一下这里会出现什么"先摆出来，
 * 内容到位时是就地填上，不是整块跳一下。
 *
 * 两条边界：
 * - 只给「首次加载」用。按钮里、小范围等待仍然用 `Spinner`（它没被删掉，04 §11.9 明说保留）。
 * - 行距、缩略图尺寸与真实列表对齐（40px 缩略图 + 两条文字占位），否则换进换出照样会跳。
 * - 灰块的尺寸与圆角由调用方定义；默认圆角是 `rounded-lg`，要改就传排序在它之后的
 *   `rounded-md` / `rounded-xl`（Tailwind 按后缀字母序出 CSS，写 `rounded` 会输给默认值）。
 *
 * 脉冲用 Tailwind 的 `animate-pulse`；`prefers-reduced-motion: reduce` 时由
 * `index.css` 统一把动画关掉 —— 那时它就是一块**静态灰框**，不闪。
 */

import type { ReactNode } from 'react';

import { Card, cn } from './ui.tsx';

/** 一块灰色占位。尺寸全交给调用方：`h-4 w-2/3` 这样传，去描述真实内容的长宽。 */
export function SkeletonBlock({ className }: { className?: string }): ReactNode {
  return <div aria-hidden="true" className={cn('animate-pulse rounded-lg bg-neutral-200 dark:bg-neutral-800', className)} />;
}

export interface SkeletonListProps {
  /** 行数；默认 3 行，够撑住首屏的观感又不至于铺满 */
  rows?: number;
  /** 给读屏的一句话（灰块本身是 `aria-hidden`，念不出任何东西） */
  label?: string;
  className?: string;
}

/**
 * N 行的列表骨架：每行一条卡片外壳 + 40px 封面占位 + 两条文字占位
 * ——与 `CoverThumb`（40px）和真实列表行的排布一致，换进换出不会跳。
 */
export function SkeletonList({ rows = 3, label = '正在加载…', className }: SkeletonListProps): ReactNode {
  return (
    <div className={cn('space-y-2', className)} role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <Card key={index}>
          <div className="flex min-h-11 items-center gap-3 p-3">
            <SkeletonBlock className="h-10 w-10 shrink-0 rounded-md" />
            <div className="min-w-0 flex-1 space-y-2">
              <SkeletonBlock className="h-3.5 w-2/3" />
              <SkeletonBlock className="h-3 w-1/3" />
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}
