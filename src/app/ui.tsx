/**
 * 共享 UI 原件（04 §5、§6）。
 *
 * 只放「多个页面都要用、而且长得必须一样」的东西：按钮、表单控件、徽章、
 * 空态、横幅、对话框。页面特有的排版留在各自页面里——这里不做一套通用布局系统。
 *
 * 值域封闭的字段一律走 ChoiceGroup / SelectField（04 §5），
 * 选项数组直接用 `types.ts` 的 `as const` 清单渲染，不在页面里另抄一份。
 */

import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

import type { Tone } from './labels.ts';

export function cn(...parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' ');
}

/* ------------------------------------------------------------------ *
 * 色调
 * ------------------------------------------------------------------ */

const TONE_BADGE: Record<Tone, string> = {
  green: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300',
  amber: 'bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-200',
  red: 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300',
  gray: 'bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300',
};

const TONE_BANNER: Record<Tone, string> = {
  green: 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  amber: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200',
  red: 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200',
  gray: 'border-neutral-300 bg-neutral-50 text-neutral-800 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200',
};

export function Badge({ tone = 'gray', children }: { tone?: Tone; children: ReactNode }): ReactNode {
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', TONE_BADGE[tone])}>
      {children}
    </span>
  );
}

export function Banner({
  tone = 'gray',
  children,
  onClose,
  action,
}: {
  tone?: Tone;
  children: ReactNode;
  onClose?: () => void;
  action?: ReactNode;
}): ReactNode {
  return (
    <div
      className={cn('flex items-start gap-3 rounded-xl border px-3 py-2.5 text-sm', TONE_BANNER[tone])}
      role={tone === 'red' ? 'alert' : 'status'}
    >
      <div className="min-w-0 flex-1">{children}</div>
      {action}
      {onClose !== undefined && (
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭提示"
          className="-mt-0.5 rounded px-1.5 py-0.5 text-lg leading-none opacity-60 hover:opacity-100"
        >
          ×
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 容器
 * ------------------------------------------------------------------ */

/**
 * 卡片容器。
 * `interactive` 给「整块可点」的卡片（列表行那一类）加悬停微浮起（04 §11.9 第 4 条）；
 * 表单卡、区块容器这类静态卡片不浮起 —— 鼠标扫过一整块版面就抖一下是噪声，不是精致。
 * 过渡写在基类里：静态卡片不该因为 hover 才拥有过渡，浮起时也不该是硬跳。
 * 两个坑写在这里，免得下次又被踩：
 * - Tailwind v4 的 `-translate-y-*` 写的是独立属性 `translate`（不是 `transform`），
 *   光写 `transition-[transform,…]` 的话浮起会是硬跳 —— 必须把它列进去。
 * - `@layer base` 里给 `body *` 定的「主题切换时背景/边框色平滑过渡」会被这里的
 *   工具类盖掉（util 层高于 base 层），所以 `background-color`、`border-color` 也得列进去，
 *   否则深浅色切换时卡片会硬跳。
 */
export function Card({
  children,
  className,
  interactive = false,
}: {
  children: ReactNode;
  className?: string;
  interactive?: boolean;
}): ReactNode {
  return (
    <div
      className={cn(
        'rounded-xl border border-neutral-200/80 bg-white shadow-sm shadow-neutral-950/[0.03] transition-[background-color,border-color,transform,translate,box-shadow] duration-150 dark:border-neutral-800/80 dark:bg-neutral-900 dark:shadow-black/20',
        interactive &&
          'hover:-translate-y-0.5 hover:shadow-md hover:shadow-neutral-950/[0.09] dark:hover:shadow-black/50',
        className,
      )}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 封面框（04 §11.9 第 1 条）
 * ------------------------------------------------------------------ */

/**
 * 封面与缩略图共用的边色令牌：浅色模式浅灰边、深色模式亮边。
 * 详情页大图（3:4）与列表缩略图（40px）必须读同一份 —— 各写一份迟早会漂开。
 */
export const COVER_EDGE_CLASS = 'border border-neutral-200 dark:border-neutral-700';

/** 封面框的柔和阴影（同一套）。40px 的小图不用它：那么小的面积上阴影只是脏。 */
export const COVER_SHADOW_CLASS = 'shadow-sm shadow-neutral-950/[0.06] dark:shadow-black/40';

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }): ReactNode {
  return (
    <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">{title}</h1>
        {/* 标题下的短朱线：全书统一的「标目」记号（04 §11.11） */}
        <span aria-hidden="true" className="mt-1.5 block h-[2px] w-8 rounded-full bg-red-600/85 dark:bg-red-500/85" />
        {description !== undefined && <p className="mt-1.5 text-sm text-neutral-500 dark:text-neutral-400">{description}</p>}
      </div>
      {actions !== undefined && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function EmptyState({
  title,
  hint,
  action,
  illustration,
}: {
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  /** 插画（04 §11.9 第 2 条）：**不传 = 与从前完全一样**，既有调用零影响 */
  illustration?: ReactNode;
}): ReactNode {
  return (
    <div className="rounded-xl border border-dashed border-neutral-300 px-4 py-10 text-center dark:border-neutral-700">
      {illustration !== undefined && <div className="mb-3 flex justify-center">{illustration}</div>}
      <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">{title}</p>
      {hint !== undefined && <p className="mx-auto mt-2 max-w-md text-sm text-neutral-500 dark:text-neutral-400">{hint}</p>}
      {action !== undefined && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function Spinner({ label = '加载中…' }: { label?: string }): ReactNode {
  return (
    <div className="flex items-center gap-2 py-6 text-sm text-neutral-500 dark:text-neutral-400">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-300 border-t-transparent dark:border-neutral-600" />
      {label}
    </div>
  );
}

export function InlineError({ children }: { children: ReactNode }): ReactNode {
  return (
    <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300" role="alert">
      {children}
    </p>
  );
}

export function StatTile({ label, value, tone = 'gray', hint }: { label: string; value: number | string; tone?: Tone; hint?: string }): ReactNode {
  return (
    <div className="rounded-xl border border-neutral-200/80 bg-white p-3 shadow-sm shadow-neutral-950/[0.03] dark:border-neutral-800/80 dark:bg-neutral-900 dark:shadow-black/20">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm text-neutral-500 dark:text-neutral-400">{label}</span>
        <span className={cn('rounded px-1.5 py-0.5 text-xs font-medium', TONE_BADGE[tone])}>{value}</span>
      </div>
      {hint !== undefined && <p className="mt-1 text-xs text-neutral-400 dark:text-neutral-500">{hint}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 按钮
 * ------------------------------------------------------------------ */

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'danger-outline' | 'ghost';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-blue-600 text-white shadow-sm shadow-blue-600/25 hover:bg-blue-700 hover:shadow-md hover:shadow-blue-600/25 disabled:bg-blue-400 disabled:shadow-none dark:disabled:bg-blue-800',
  secondary:
    'border border-neutral-300 bg-white text-neutral-800 shadow-sm hover:border-neutral-400 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:border-neutral-600 dark:hover:bg-neutral-800',
  danger:
    'bg-red-600 text-white shadow-sm shadow-red-600/25 hover:bg-red-700 hover:shadow-md hover:shadow-red-600/25 disabled:bg-red-400 disabled:shadow-none dark:disabled:bg-red-900',
  // 红描边：保留危险信号但降视觉权重 —— 破坏性操作不该是页面上最亮的（04 §11.18）
  'danger-outline':
    'border border-red-300 bg-white text-red-700 shadow-sm hover:border-red-400 hover:bg-red-50 dark:border-red-800 dark:bg-neutral-900 dark:text-red-300 dark:hover:border-red-700 dark:hover:bg-red-950/40',
  ghost: 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800',
};

const BUTTON_SIZES = {
  sm: 'min-h-9 px-3 text-sm',
  md: 'min-h-11 px-4 text-sm',
} as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: keyof typeof BUTTON_SIZES;
}

const BASE_BUTTON_CLASS =
  // `scale` 单列：v4 的 `active:scale-[0.98]` 写的是独立属性 `scale`，不在 `transform` 里
  'inline-flex items-center justify-center gap-1.5 rounded-xl font-medium transition-[background-color,color,border-color,box-shadow,transform,scale] duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100';

/**
 * 按钮的类名组合。导出给「长得像按钮的链接」用：<a> 里不能套 <button>，
 * 而导航动作必须是真链接（中键 / 新标签 / 读屏都靠它），所以那里只能复用类名。
 * 拿一份抄好的字符串去凑，迟早会和按钮本体漂开 —— 样式只有一个来源。
 */
export function buttonClass(
  options: { variant?: ButtonVariant; size?: keyof typeof BUTTON_SIZES; className?: string } = {},
): string {
  const { variant = 'secondary', size = 'md', className } = options;
  return cn(BASE_BUTTON_CLASS, BUTTON_SIZES[size], BUTTON_VARIANTS[variant], className);
}

export function Button({ variant = 'secondary', size = 'md', type = 'button', className, ...rest }: ButtonProps): ReactNode {
  return <button type={type} className={buttonClass({ variant, size, className })} {...rest} />;
}

/* ------------------------------------------------------------------ *
 * 表单
 * ------------------------------------------------------------------ */

const CONTROL_CLASS =
  'w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 transition-colors placeholder:text-neutral-400 hover:border-neutral-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15 focus:outline-none dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-600 dark:hover:border-neutral-600';

function FieldShell({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
}): ReactNode {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">{label}</span>
      {children}
      {hint !== undefined && <span className="mt-1 block text-xs text-neutral-500 dark:text-neutral-400">{hint}</span>}
      {error !== undefined && error !== null && <span className="mt-1 block text-xs text-red-600 dark:text-red-400">{error}</span>}
    </label>
  );
}

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  hint?: ReactNode;
  error?: string | null;
}

export function TextField({ label, value, onValueChange, hint, error, className, ...rest }: TextFieldProps): ReactNode {
  return (
    <FieldShell label={label} hint={hint} error={error}>
      <input
        className={cn(CONTROL_CLASS, 'min-h-11', className)}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        {...rest}
      />
    </FieldShell>
  );
}

export interface TextAreaFieldProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value'> {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  hint?: ReactNode;
  error?: string | null;
}

export function TextAreaField({ label, value, onValueChange, hint, error, className, rows = 3, ...rest }: TextAreaFieldProps): ReactNode {
  return (
    <FieldShell label={label} hint={hint} error={error}>
      <textarea
        rows={rows}
        className={cn(CONTROL_CLASS, className)}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        {...rest}
      />
    </FieldShell>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value'> {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  hint?: ReactNode;
  error?: string | null;
}

export function SelectField({ label, value, onValueChange, options, hint, error, className, ...rest }: SelectFieldProps): ReactNode {
  return (
    <FieldShell label={label} hint={hint} error={error}>
      <select
        className={cn(CONTROL_CLASS, 'min-h-11', className)}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        {...rest}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
}

/**
 * 值域封闭字段的选择器（04 §5）：一排按钮，点一下就选中。
 * 比下拉框少一次点击，也避免用户看到不该出现的选项（如只读展示的「借出」）。
 */
export function ChoiceGroup<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
  disabled = false,
}: {
  label: string;
  value: T;
  options: readonly ChoiceOption<T>[];
  onChange: (value: T) => void;
  hint?: ReactNode;
  disabled?: boolean;
}): ReactNode {
  return (
    <FieldShell label={label} hint={hint}>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              disabled={disabled}
              aria-pressed={active}
              onClick={() => onChange(option.value)}
              className={cn(
                'min-h-11 rounded-lg border px-3 text-sm font-medium transition-[background-color,color,border-color,box-shadow,transform,scale] duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100',
                active
                  ? 'border-blue-600 bg-blue-600 text-white shadow-sm shadow-blue-600/25'
                  : 'border-neutral-300 bg-white text-neutral-700 hover:border-neutral-400 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:border-neutral-600 dark:hover:bg-neutral-800',
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </FieldShell>
  );
}

/* ------------------------------------------------------------------ *
 * 对话框
 * ------------------------------------------------------------------ */

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}): ReactNode {
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-neutral-950/50 backdrop-blur-sm sm:items-center sm:p-4"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
        className="max-h-[90vh] w-full overflow-y-auto rounded-t-2xl border border-neutral-200/60 bg-white p-4 shadow-2xl shadow-neutral-950/20 sm:max-w-lg sm:rounded-2xl dark:border-neutral-800 dark:bg-neutral-900"
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">{title}</h2>
          <button type="button" onClick={onClose} aria-label="关闭" className="-mt-1 rounded px-1.5 text-xl leading-none text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200">
            ×
          </button>
        </div>
        <div className="space-y-3">{children}</div>
        {footer !== undefined && <div className="mt-4 flex flex-wrap justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = '确认',
  cancelLabel = '取消',
  tone = 'danger',
  pending = false,
  error = null,
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
  pending?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
}): ReactNode {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm} disabled={pending}>
            {pending ? '处理中…' : confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm text-neutral-700 dark:text-neutral-300">{message}</div>
      {children}
      {error !== null && <InlineError>{error}</InlineError>}
    </Modal>
  );
}
