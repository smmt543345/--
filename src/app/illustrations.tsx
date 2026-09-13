/**
 * 空态插画（04 §11.9 第 2 条）：手绘线条风 SVG 小插画，给空态一点温度。
 *
 * 三条硬约定：
 * - 画布 96×72，与图标同源的气质：单色描边（`currentColor`，1.5px 圆头）、不加填充色，
 *   只在每张图里留**一处**朱红点缀（`#BA3A2C` 的印泥色），像盖了一方小印。
 * - 纯装饰：`aria-hidden="true"`，颜色跟随父级文字色，深浅色自动适配，不需要第二套。
 * - 不引图标库、不引动效库（01 §2.1、04 §11.9）：就是几个 path，加载成本可以忽略。
 *
 * 用法：`<EmptyState illustration={<EmptyShelfArt />} … />`（不传插画时空态与从前一模一样）。
 */

import type { ReactNode } from 'react';

import { cn } from './ui.tsx';

/** 印泥朱红：每张图只用一次的点缀色（04 §11.9）。 */
const ACCENT = '#BA3A2C';

/** 96×72 的画布按原尺寸显示；`mx-auto` 让它在空态框里自己居中。 */
const ART_CLASS = 'mx-auto block h-[4.5rem] w-24 text-neutral-400 dark:text-neutral-500';

/**
 * 所有插画共用的外壳：描边色走 `currentColor`，线条粗细与圆头一次定死，
 * 单张图里只写形状，不重复写样式。
 */
function Art({ children }: { children: ReactNode }): ReactNode {
  return (
    <svg
      viewBox="0 0 96 72"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn(ART_CLASS)}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** 书库空：一座空书架，立着几本、平放几本，最右那本盖着朱红印记。 */
export function EmptyShelfArt(): ReactNode {
  return (
    <Art>
      <rect x="14" y="8" width="68" height="58" rx="2" />
      <path d="M14 27h68M14 46h68" />
      {/* 上层：三本立着 + 一本朱红 */}
      <rect x="21" y="12" width="6" height="15" />
      <rect x="30" y="12" width="6" height="15" />
      <rect x="39" y="12" width="6" height="15" transform="rotate(10 42 27)" />
      <rect x="50" y="12" width="7" height="15" stroke={ACCENT} fill={ACCENT} fillOpacity="0.14" />
      {/* 中层：两本平放 + 右端两本立着 */}
      <rect x="22" y="29" width="28" height="7" rx="0.5" />
      <rect x="25" y="36" width="24" height="7" rx="0.5" />
      <rect x="62" y="29" width="6" height="14" />
      <rect x="70" y="29" width="6" height="14" />
      {/* 底层：一叠平放的书 */}
      <rect x="22" y="49" width="30" height="6" rx="0.5" />
      <rect x="25" y="55" width="26" height="6" rx="0.5" />
    </Art>
  );
}

/** 搜索无结果：一本合着的书 + 一枚放大镜，书脊是那处朱红。 */
export function NoResultsArt(): ReactNode {
  return (
    <Art>
      <rect x="14" y="20" width="30" height="38" rx="2" />
      <path d="M36 26h5M36 34h5M36 42h5" />
      <path d="M23 21v36" stroke={ACCENT} strokeWidth="2" />
      <circle cx="64" cy="30" r="14" />
      <path d="M74 40l8 8" />
    </Art>
  );
}

/** 没有借出：一本书躺在桌上，夹着的书签露在外面（朱红）。 */
export function NoLoansArt(): ReactNode {
  return (
    <Art>
      <rect x="22" y="16" width="48" height="40" rx="2" />
      <path d="M30 16v40" />
      <path d="M48 16v22l6-5 6 5V16" stroke={ACCENT} fill={ACCENT} fillOpacity="0.14" />
    </Art>
  );
}

/** 没有位置：一棵位置树，根节点上盖着朱红的点。 */
export function NoLocationsArt(): ReactNode {
  return (
    <Art>
      <rect x="36" y="10" width="24" height="14" rx="2" />
      <path d="M48 24v8M26 32h44M26 32v8M70 32v8" />
      <rect x="14" y="40" width="24" height="14" rx="2" />
      <rect x="58" y="40" width="24" height="14" rx="2" />
      <circle cx="48" cy="17" r="2.5" stroke="none" fill={ACCENT} />
    </Art>
  );
}

/** 没有快照：两张叠着的快照卡，上面一張小钟，指针是那处朱红。 */
export function NoSnapshotsArt(): ReactNode {
  return (
    <Art>
      <rect x="26" y="10" width="44" height="32" rx="3" />
      <rect x="18" y="18" width="44" height="32" rx="3" />
      <circle cx="40" cy="34" r="9" />
      <path d="M40 34v-5" />
      <path d="M40 34l4 2.5" stroke={ACCENT} strokeWidth="1.8" />
    </Art>
  );
}

/** 没有借书人：一个人抱着本书，书脊是那处朱红。 */
export function NoBorrowersArt(): ReactNode {
  return (
    <Art>
      <circle cx="32" cy="22" r="9" />
      <path d="M17 56c0-9 7-16 15-16s15 7 15 16" />
      <path d="M47 46h7" />
      <rect x="54" y="32" width="30" height="22" rx="2" />
      <path d="M61 32v22" stroke={ACCENT} strokeWidth="2" />
    </Art>
  );
}
