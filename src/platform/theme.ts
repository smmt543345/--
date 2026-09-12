/**
 * 主题（值域封闭，见 04 §5）。
 * 设置里存 'system' | 'light' | 'dark'，实际生效外观解析后写到 <html data-theme>，
 * Tailwind 的 dark: 变体读它（定义见 src/app/index.css）。
 */

export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

export const DEFAULT_THEME: Theme = 'system';

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

/** 把设置值解析成实际生效的外观。纯函数，便于测试。 */
export function resolveTheme(theme: Theme, prefersDark: boolean): 'light' | 'dark' {
  if (theme === 'system') return prefersDark ? 'dark' : 'light';
  return theme;
}

export function prefersDarkNow(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function applyTheme(theme: Theme, prefersDark: boolean = prefersDarkNow()): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset['theme'] = resolveTheme(theme, prefersDark);
}

/** 订阅系统外观变化，返回退订函数。 */
export function watchSystemTheme(onChange: (prefersDark: boolean) => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = (event: MediaQueryListEvent): void => onChange(event.matches);
  query.addEventListener('change', handler);
  return () => query.removeEventListener('change', handler);
}
