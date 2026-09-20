/**
 * 连续录入的纯逻辑（04 §11.14.B）：下一本草稿、跳过判定、累计与收尾文案。
 *
 * 拆成纯函数是为了能 `node --test` 直接测（01 §5.6）：这一段全是「什么情况说什么话」，
 * 塞进 ScanDialog 就只能靠真机点着看 —— 而它恰恰是连续模式里最容易说错话的地方
 * （跳过的是哪一本、累计到第几本、没书名时显示什么）。建书、写库、调 AI 留在 ScanDialog。
 */

import type { UpdateBookInput } from '../../db/books.ts';
import { parseList } from '../../domain/text.ts';
import type { Book, CopyCondition } from '../../domain/types.ts';
import { mergeAiFields, type AiBookFields } from './ai.ts';
import { EMPTY_DRAFT, type BookDraft } from './write.ts';

/* ------------------------------------------------------------------ *
 * 每扫一本的草稿（04 §11.14.B 第 3 步）
 * ------------------------------------------------------------------ */

/** 连录时从表单带过来的三个字段：位置 / 品相 / 标签（其余一律空）。 */
export interface ContinuousSeed {
  locationId: string;
  condition: CopyCondition;
  tagsRaw: string;
}

/** 表单当前值 → 种子。连录期间表单全程不被改动，所以取一次即可，逐本复用。 */
export function seedFromDraft(draft: BookDraft): ContinuousSeed {
  return { locationId: draft.locationId, condition: draft.condition, tagsRaw: draft.tagsRaw };
}

/**
 * 下一本的草稿：ISBN 用刚扫到的，副本数 **1**，位置/品相/标签取表单当前值，其余字段空
 * —— 元数据留给 AI 补，补不回来也不影响「这本书存在」这个事实。
 */
export function scanDraft(seed: ContinuousSeed, isbn13: string): BookDraft {
  return { ...EMPTY_DRAFT, isbn: isbn13, initialCount: 1, ...seed };
}

/* ------------------------------------------------------------------ *
 * 累计
 * ------------------------------------------------------------------ */

export interface ContinuousEntry {
  bookId: string;
  isbn: string;
  title: string;
}

/** 累计列表最多列几条（04 §11.14.B「书名A、书名B、书名C（最近几条）」）。 */
export const CONTINUOUS_RECENT = 5;

/** 列表里的一项：**没有书名时回退显示 ISBN**（未配 AI 的一批只有 ISBN）。 */
export function entryLabel(entry: ContinuousEntry): string {
  return entry.title.trim() === '' ? entry.isbn : entry.title;
}

export function continuousProgress(entries: readonly ContinuousEntry[]): string {
  if (entries.length === 0) return '';
  const recent = entries.slice(-CONTINUOUS_RECENT);
  const tail = entries.length > recent.length ? `（最近 ${recent.length} 条）` : '';
  return `已录入 ${entries.length} 本：${recent.map(entryLabel).join('、')}${tail}`;
}

/** AI 补全回来 → 更新对应那条的书名；模型没给书名就保持原样（回退显示 ISBN）。 */
export function withAiTitle(
  entries: readonly ContinuousEntry[],
  bookId: string,
  fields: AiBookFields,
): ContinuousEntry[] {
  const title = fields.title.trim();
  return entries.map((entry) => (entry.bookId === bookId && title !== '' ? { ...entry, title } : entry));
}

/** 关弹层时回新增页的一句。一本都没录（进来看看就关了）就不吭声，不报「共录入 0 本」。 */
export function finishNotice(entries: readonly ContinuousEntry[], aiConfigured: boolean): string | null {
  if (entries.length === 0) return null;
  const head = `本次共录入 ${entries.length} 本`;
  return aiConfigured ? head : `${head}；没配 AI，这批只存了 ISBN，书名可以之后补`;
}

/** 补全失败只提示，不阻塞扫描、也不影响累计 —— 书已经建好了，ISBN 是真的（04 §11.14.B）。 */
export function aiFailureNotice(failed: number): string {
  return `AI 补全失败 ${failed} 本：书已经建好了，书名可以之后在搜索页补`;
}

export const CONTINUOUS_NOTICE = {
  noAi: '未配置 AI：这批只存了 ISBN，书名可以之后补',
} as const;

/* ------------------------------------------------------------------ *
 * 跳过提示（04 §11.14.B 第 2、4 步：一律「跳过并提示」，绝不弹合并分支）
 * ------------------------------------------------------------------ */

export function skipExistingNotice(title: string): string {
  return `《${title}》库里已有，已跳过`;
}

/** 第 2 步已经挡掉了已有 ISBN，所以走到这里说明查询与实际不一致 —— 同样跳过，不打断节奏。 */
export function skipNeedsConfirmNotice(isbn: string): string {
  return `ISBN ${isbn} 需要确认才能建，连续模式里已跳过：这本请在表单里手动保存`;
}

export function skipFailedNotice(reason: string): string {
  return `这本没能建上，已跳过：${reason}`;
}

/* ------------------------------------------------------------------ *
 * AI 结果写回刚建的那一条（04 §11.14.B「AI 补全（连续模式）」）
 * ------------------------------------------------------------------ */

/** 刚建的那条书目 → 可以喂给 `mergeAiFields` 的草稿（只读，不回写书目本身）。 */
function draftFromBook(book: Book): BookDraft {
  return {
    ...EMPTY_DRAFT,
    title: book.title,
    isbn: book.isbn,
    authorsRaw: book.authors.join('，'),
    publisher: book.publisher,
    publishDate: book.publishDate,
    coverUrl: book.coverUrl,
    tagsRaw: book.tags.join('，'),
  };
}

/**
 * AI 补全结果 → `updateBook` 的补丁，**只补空字段**（05 §3.3 口径不变）。
 *
 * 判空依据是库里那条的原值，不靠「合并前后有无差异」推：空串与顿号归一化会造出假差异，
 * 那会把一个空字段当成「有值」写回库。补丁为空就不调 `updateBook`（不白写一次）。
 */
export function aiPatchForBook(book: Book, fields: AiBookFields): UpdateBookInput {
  const merged = mergeAiFields(draftFromBook(book), fields);
  const patch: UpdateBookInput = {};
  if (book.title.trim() === '' && merged.title.trim() !== '') patch.title = merged.title;
  if (book.publisher.trim() === '' && merged.publisher.trim() !== '') patch.publisher = merged.publisher;
  if (book.publishDate.trim() === '' && merged.publishDate.trim() !== '') patch.publishDate = merged.publishDate;
  const authors = book.authors.length === 0 ? parseList(merged.authorsRaw) : [];
  if (authors.length > 0) patch.authors = authors;
  const tags = book.tags.length === 0 ? parseList(merged.tagsRaw) : [];
  if (tags.length > 0) patch.tags = tags;
  return patch;
}
