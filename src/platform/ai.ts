/**
 * AI 网络适配（05 §3.4）：OpenAI 兼容 chat/completions 调用。
 *
 * 平台层边界与 files.ts 一致：features 层拿字符串进来，拿字符串出去，
 * 网络与超时都留在这里。请求只发往调用方传入的 baseUrl，不经过任何中转。
 */

export interface AiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 配置是否完整可用（05 §3.3：未配置时按钮置灰）。 */
export function isAiConfigured(config: AiConfig): boolean {
  return config.baseUrl.trim() !== '' && config.model.trim() !== '';
}

const TIMEOUT_MS = 10_000;

async function requestWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 发一次对话补全，返回模型文本。失败抛中文可读错误（页面原样展示，04 §3）。
 * 错误文案不含密钥内容（05 §3.2）。
 */
export async function completeChat(
  config: AiConfig,
  systemPrompt: string,
  userPrompt: string,
  maxTokens?: number,
): Promise<string> {
  const base = config.baseUrl.trim().replace(/\/+$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey.trim() !== '') headers['Authorization'] = `Bearer ${config.apiKey.trim()}`;

  const body: Record<string, unknown> = {
    model: config.model.trim(),
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.2,
  };
  if (maxTokens !== undefined) body['max_tokens'] = maxTokens;

  let response: Response;
  try {
    response = await requestWithTimeout(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('请求超时，AI 服务没有在 10 秒内响应');
    throw new Error('连不上 AI 服务：请检查接口地址是否正确、网络是否可用');
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error('AI 服务拒绝了请求：密钥可能无效或没有权限');
  }
  if (response.status === 404) {
    throw new Error('接口地址不对：服务返回 404（检查地址是否以 /v1 结尾）');
  }
  if (!response.ok) {
    throw new Error(`AI 服务返回错误（HTTP ${response.status}）`);
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error('AI 服务返回的不是合法 JSON');
  }

  const content = extractContent(data);
  if (content === null) throw new Error('AI 服务响应里没有内容，请检查模型名是否正确');
  return content;
}

function extractContent(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  const choices = record['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (typeof first !== 'object' || first === null) return null;
  const message = (first as Record<string, unknown>)['message'];
  if (typeof message !== 'object' || message === null) return null;
  const content = (message as Record<string, unknown>)['content'];
  return typeof content === 'string' ? content : null;
}
