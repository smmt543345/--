/**
 * 导航清单（04 §2）。
 *
 * 五项固定、单层，**窄屏底部标签栏与宽屏侧边栏读的是同一份常量**——
 * 两处各写一份清单，迟早会出现"手机上有、电脑上没有"的页面。
 */

import type { ReactNode } from 'react';

export interface NavItem {
  to: string;
  label: string;
  /** 这个目的地是干嘛的；空态文案与无障碍标签复用，避免各页自己再编一句 */
  hint: string;
  icon: ReactNode;
}

/** 统一的线性图标：24 格、跟随字号颜色，不引入图标库（01 §2.1）。 */
function Icon({ d }: { d: string }): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

export const NAV_ITEMS: readonly NavItem[] = [
  {
    to: '/',
    label: '总览',
    hint: '藏书概况、逾期提醒与备份提示',
    icon: <Icon d="M4 13h6V4H4v9Zm0 7h6v-4H4v4Zm10 0h6v-9h-6v9Zm0-16v4h6V4h-6Z" />,
  },
  {
    to: '/search',
    label: '搜索',
    hint: '按书名、作者、ISBN、标签找书',
    icon: <Icon d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 4.5 4.5" />,
  },
  {
    to: '/locations',
    label: '位置',
    hint: '家里的书架、格子与藏书分布',
    icon: <Icon d="M12 3 3 8l9 5 9-5-9-5Zm-9 9 9 5 9-5" />,
  },
  {
    to: '/loans',
    label: '借出',
    hint: '谁借走了什么、什么时候该还',
    icon: <Icon d="M12 6.5C10.5 5 8.5 4.5 4 4.5v13c4.5 0 6.5.5 8 2 1.5-1.5 3.5-2 8-2v-13c-4.5 0-6.5.5-8 2Zm0 0v13" />,
  },
  {
    to: '/settings',
    label: '备份与设置',
    hint: '导出、导入、体检与偏好',
    icon: (
      <Icon d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4 0a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    ),
  },
];
