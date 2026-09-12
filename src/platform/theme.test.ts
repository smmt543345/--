import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_THEME, isTheme, resolveTheme, THEMES } from './theme.ts';

describe('resolveTheme', () => {
  it('跟随系统时按系统偏好取值', () => {
    assert.equal(resolveTheme('system', true), 'dark');
    assert.equal(resolveTheme('system', false), 'light');
  });

  it('显式选择时忽略系统偏好', () => {
    assert.equal(resolveTheme('dark', false), 'dark');
    assert.equal(resolveTheme('light', true), 'light');
  });

  it('三种取值都能解析出确定外观（不存在漏掉的分支）', () => {
    for (const theme of THEMES) {
      assert.ok(['light', 'dark'].includes(resolveTheme(theme, true)));
      assert.ok(['light', 'dark'].includes(resolveTheme(theme, false)));
    }
  });
});

describe('isTheme', () => {
  it('只接受封闭值域内的字符串', () => {
    assert.equal(isTheme('system'), true);
    assert.equal(isTheme('light'), true);
    assert.equal(isTheme('dark'), true);
    assert.equal(isTheme('Dark'), false);
    assert.equal(isTheme(''), false);
    assert.equal(isTheme(undefined), false);
    assert.equal(isTheme(1), false);
  });

  it('默认值是值域内的合法值', () => {
    assert.equal(isTheme(DEFAULT_THEME), true);
  });
});
