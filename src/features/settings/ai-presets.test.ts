/**
 * AI 服务商预设的用例（04 §11.17）。
 *
 * 预设表本身是数据，但「反查」是纯逻辑：它决定界面上那行状态文字说「当前：DeepSeek」
 * 还是「当前：自定义」。反查错了，用户会以为自己在用 A、实际配的是 B。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AI_PRESETS, CUSTOM_PRESET_ID, matchPresetId, presetById } from './ai-presets.ts';

describe('AI 服务商预设（04 §11.17）', () => {
  it('每个预设都填齐了，id 不重复', () => {
    const ids = AI_PRESETS.map((preset) => preset.id);
    assert.equal(new Set(ids).size, ids.length, 'id 不能重复');
    for (const preset of AI_PRESETS) {
      assert.ok(preset.label.trim() !== '', `${preset.id} 缺 label`);
      assert.ok(preset.baseUrl.startsWith('https://'), `${preset.id} 的地址必须是 https`);
      assert.ok(preset.model.trim() !== '', `${preset.id} 缺 model`);
      assert.ok(preset.note.trim() !== '', `${preset.id} 缺 note`);
    }
  });

  it('地址不以 / 结尾（否则会被拼成 //chat/completions）', () => {
    for (const preset of AI_PRESETS) {
      assert.ok(!preset.baseUrl.endsWith('/'), `${preset.id} 的地址不该以 / 结尾`);
    }
  });

  it('按「地址 + 模型」能反查回自己', () => {
    for (const preset of AI_PRESETS) {
      assert.equal(matchPresetId(preset.baseUrl, preset.model), preset.id);
    }
  });

  it('结尾斜杠与首尾空白不影响匹配', () => {
    assert.equal(matchPresetId('  https://api.deepseek.com/  ', ' deepseek-flash '), 'deepseek');
    assert.equal(matchPresetId('https://api.openai.com/v1/', 'gpt-4o-mini'), 'openai');
  });

  it('地址对但模型被改过 → 自定义（不能谎报成某个预设）', () => {
    assert.equal(matchPresetId('https://api.deepseek.com', 'deepseek-v4-pro'), CUSTOM_PRESET_ID);
  });

  it('地址不认识 / 为空 → 自定义', () => {
    assert.equal(matchPresetId('https://my-proxy.example.com/v1', 'gpt-4o-mini'), CUSTOM_PRESET_ID);
    assert.equal(matchPresetId('', 'gpt-4o-mini'), CUSTOM_PRESET_ID);
    assert.equal(matchPresetId('   ', ''), CUSTOM_PRESET_ID);
  });

  it('「自定义」不是一个预设项（它是反查结果，不该能被选中）', () => {
    assert.equal(presetById(CUSTOM_PRESET_ID), undefined);
    assert.equal(
      AI_PRESETS.some((preset) => preset.id === CUSTOM_PRESET_ID),
      false,
    );
  });

  it('OpenAI 保留在表里，且说明里点明国内直连不通', () => {
    const openai = presetById('openai');
    assert.notEqual(openai, undefined);
    assert.match(openai?.note ?? '', /直连不通/);
  });
});
