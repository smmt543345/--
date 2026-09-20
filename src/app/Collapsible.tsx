/**
 * 折叠区块（04 §11.13）：新增页的「更多信息（可选）」用它收起次要字段。
 *
 * 独立成文件是硬约束逼的（01 §5.6）：`ui.tsx` 已 496 行，塞进去破 500 行上限。
 *
 * 默认收起，**展开态不持久化**（04 §11.13）——录下一本时它又该是收起的，
 * 记住了反而是「上一本展开过，这一本也自动展开」这种说不清的默认。
 * 面板用 `hidden` 而不是条件渲染：里面的照片预览有自己的暂存态（CoverPicker），
 * 收一下再展开不该把它弄丢。
 */

import { useId, useState, type ReactNode } from 'react';

import { buttonClass } from './ui.tsx';

export interface CollapsibleProps {
  /** 未展开时也要说得清里面是什么（如「更多信息（可选）」） */
  title: string;
  /** 已填项数：>0 时挂在标题后面，收起状态下靠它提示「里面有东西」，展开才看得见 */
  count?: number;
  children: ReactNode;
}

export function Collapsible({ title, count = 0, children }: CollapsibleProps): ReactNode {
  const panelId = `collapsible-${useId()}`;
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-xl border border-neutral-200/80 dark:border-neutral-800/80">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(!open)}
        // 长得像按钮的动作行，用 buttonClass 复用按钮样式（ui.tsx 的既定做法），不另抄一份
        className={buttonClass({ variant: 'ghost', className: 'w-full justify-between gap-2 rounded-xl px-3 text-left' })}
      >
        <span>
          {title}
          {count > 0 && <span className="ml-1 text-xs font-normal text-neutral-500 dark:text-neutral-400">· 已填 {count} 项</span>}
        </span>
        {/* 箭头是纯装饰：读屏听 aria-expanded 就够了 */}
        <span aria-hidden="true" className="text-xs text-neutral-400">
          {open ? '▲' : '▼'}
        </span>
      </button>

      <div id={panelId} hidden={!open} className="space-y-4 border-t border-neutral-200/80 p-3 dark:border-neutral-800/80">
        {children}
      </div>
    </div>
  );
}
