/**
 * AI 元数据补全的纯逻辑（05 §3）：提示词拼装、回复解析与校验、表单合并。
 *
 * 网络调用在 platform/ai.ts；这里只处理字符串进出，方便 node --test 直接测。
 */

import { isDateString } from '../../domain/time.ts';
import type { BookDraft } from './write.ts';

export interface AiInput {
  title: string;
  isbn: string;
}

export interface AiBookFields {
  title: string;
  authors: string[];
  publisher: string;
  publishDate: string;
  tags: string[];
}

export type AiParseResult = { ok: true; fields: AiBookFields } | { ok: false; error: string };

/** 给模型的系统提示：要什么、什么格式、不许胡编。 */
export const AI_SYSTEM_PROMPT =
  '你是一个藏书目录助手。用户给你一条书名或 ISBN，你返回这本书的权威书目信息。' +
  '只输出一个 JSON 对象，不要任何解释文字或代码围栏。' +
  'JSON 格式：{"title":"书名","authors":["作者1","作者2"],"publisher":"出版社","publishDate":"YYYY-MM-DD","tags":["标签"]}。' +
  '不知道的字段给空字符串或空数组；publishDate 不确定就给空字符串；不要编造 ISBN。';

export function buildAiUserPrompt(input: AiInput): string {
  const title = input.title.trim();
  const isbn = input.isbn.trim();
  if (title !== '') return `请补全这本书的信息：书名《${title}》${isbn === '' ? '' : `，ISBN ${isbn}`}。`;
  return `请根据 ISBN ${isbn} 补全这本书的信息。`;
}

/** 模型回复 → 结构化字段。只认 JSON，模型胡话一律当错误（05 §3.3）。 */
export function parseAiResponse(text: string): AiParseResult {
  const trimmed = text.trim();
  // 模型偶尔会套 ```json 围栏，剥掉（只处理最外层）
  const fenced = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const candidate = fenced !== null ? (fenced[1] ?? '') : trimmed;

  let data: unknown;
  try {
    data = JSON.parse(candidate);
  } catch {
    // 再试一次：从第一个 { 到最后一个 } 之间截取（模型常在 JSON 前后加废话）
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) {
      return { ok: false, error: 'AI 没有返回可用的 JSON，请重试或换一个模型' };
    }
    try {
      data = JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return { ok: false, error: 'AI 返回的 JSON 解析失败，请重试或换一个模型' };
    }
  }

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, error: 'AI 返回的不是预期的对象，请重试' };
  }
  const record = data as Record<string, unknown>;

  const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  const asStringList = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim());
    return typeof value === 'string' && value.trim() !== '' ? [value.trim()] : [];
  };

  return {
    ok: true,
    fields: {
      title: asString(record['title']),
      authors: asStringList(record['authors']),
      publisher: asString(record['publisher']),
      // publishDate 必须过真实日历校验（05 §3.3），模型瞎编的日期直接丢弃
      publishDate: isDateString(asString(record['publishDate'])) ? asString(record['publishDate']) : '',
      tags: asStringList(record['tags']),
    },
  };
}

/** 只填空字段（05 §3.3）：人填过的值一概不覆盖。作者/标签与现有值取并集。 */
export function mergeAiFields(draft: BookDraft, fields: AiBookFields): BookDraft {
  const existingAuthors = new Set(draft.authorsRaw.split(/[,，、;；/]/).map((s) => s.trim()).filter((s) => s !== ''));
  const existingTags = new Set(draft.tagsRaw.split(/[,，、;；/]/).map((s) => s.trim()).filter((s) => s !== ''));
  const mergedAuthors = [...existingAuthors, ...fields.authors.filter((author) => !existingAuthors.has(author))];
  const mergedTags = [...existingTags, ...fields.tags.filter((tag) => !existingTags.has(tag))];

  return {
    ...draft,
    title: draft.title.trim() === '' ? fields.title : draft.title,
    publisher: draft.publisher.trim() === '' ? fields.publisher : draft.publisher,
    publishDate: draft.publishDate.trim() === '' ? fields.publishDate : draft.publishDate,
    authorsRaw: mergedAuthors.join('，'),
    tagsRaw: mergedTags.join('，'),
  };
}
