/**
 * 主题偏好的读写与落地（04 §5：值域封闭，设置里只能挑，不能手打）。
 *
 * 设置存的是 'system' | 'light' | 'dark'，实际生效外观写到 <html data-theme>，
 * Tailwind 的 dark 变体读它（见 index.css）。选 system 时要跟随系统变化，
 * 否则用户在系统里切了深色，应用要等到刷新才跟上。
 */

import { useEffect } from 'react';

import { getSetting, SETTING_KEYS, setSetting } from '../db/settings.ts';
import { applyTheme, DEFAULT_THEME, isTheme, watchSystemTheme, type Theme } from '../platform/theme.ts';
import { useDb } from './db-context.ts';
import { useLiveQuery } from './useLiveQuery.ts';

export interface ThemeControl {
  theme: Theme;
  setTheme: (theme: Theme) => Promise<void>;
}

export function useTheme(): ThemeControl {
  const db = useDb();

  const theme = useLiveQuery<Theme>(
    async () => {
      const stored = await getSetting<unknown>(db, SETTING_KEYS.theme, DEFAULT_THEME);
      return isTheme(stored) ? stored : DEFAULT_THEME;
    },
    [db],
    DEFAULT_THEME,
  );

  useEffect(() => {
    applyTheme(theme);
    // 只有 system 会用到这个回调；applyTheme 对 light/dark 忽略系统值
    return watchSystemTheme(() => applyTheme(theme));
  }, [theme]);

  return {
    theme,
    setTheme: (next: Theme) => setSetting(db, SETTING_KEYS.theme, next),
  };
}
