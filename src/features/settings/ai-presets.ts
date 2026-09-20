/**
 * AI 服务商预设（04 §11.17）。
 *
 * 为什么需要：AI 补全要手填「接口地址 + 模型名」，而默认值是 `https://api.openai.com/v1` ——
 * **国内直连不通**（2026-09-20 实测：预检与请求都八秒无响应直到超时）。用户看到的是
 * 「请求超时」，根本推不到「地址填错了」上；预设把这两个「服务商的属性」一次填好，
 * 用户只需要贴自己的密钥。
 *
 * 表编译进代码、不走云端：断网也能用，也不会因为远端配置变化而悄悄改变行为。
 * 模型名会随时间过期（下面三条是国内三家在 2026-09-20 查官方文档／模型列表页所得），
 * **过期不影响可用性** —— 用户仍可手改模型名，改完就自动落到「自定义」。
 */

export interface AiPreset {
  id: string;
  label: string;
  /** 接口地址。`platform/ai.ts` 会拼上 `/chat/completions` 再发请求 */
  baseUrl: string;
  /** 该服务商当前的对话模型名 */
  model: string;
  /** 按钮下方的一行说明，含「国内能不能直连」这种关键信息 */
  note: string;
}

/** 不匹配任何预设时的状态（不是可选项，是反查结果）。 */
export const CUSTOM_PRESET_ID = 'custom';

/** 顺序即界面顺序：能用的排前面，OpenAI 垫底并标明直连不通。 */
export const AI_PRESETS: readonly AiPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek（深度求索）',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    note: '推荐：国内直连可用、便宜。密钥在 platform.deepseek.com 申请。',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5.3',
    note: '国内直连可用。密钥在 open.bigmodel.cn 申请。',
  },
  {
    id: 'dashscope',
    label: '通义千问（阿里云百炼）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.8-flash',
    note: '国内直连可用。密钥在阿里云百炼控制台申请。',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    note: '国内多数网络直连不通（需自备网络）。保留它只因为它是这套协议的基准。',
  },
];

/** 比地址时忽略结尾斜杠与首尾空白：`…/v1` 与 `…/v1/` 是同一个地方。 */
function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/**
 * 按「地址 + 模型」反查当前配置属于哪个预设；两个都对得上才算。
 * 只比地址不比模型，会把「同一个地址换了个模型」误报成预设 —— 那正是用户手改过的情形。
 */
export function matchPresetId(baseUrl: string, model: string): string {
  const url = normalizeBaseUrl(baseUrl);
  if (url === '') return CUSTOM_PRESET_ID;
  const name = model.trim();
  const hit = AI_PRESETS.find((preset) => normalizeBaseUrl(preset.baseUrl) === url && preset.model === name);
  return hit === undefined ? CUSTOM_PRESET_ID : hit.id;
}

export function presetById(id: string): AiPreset | undefined {
  return AI_PRESETS.find((preset) => preset.id === id);
}
