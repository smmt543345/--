/**
 * 连续录入纯逻辑的用例（04 §11.14.B）。
 *
 * 真机验收只能证明「扫得动」，证明不了「说对了话」：跳过的是哪一本、累计到第几本、
 * 没书名时显示什么、AI 回来往哪条写 —— 这些全在测试里钉死。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Book } from '../../domain/types.ts';
import type { AiBookFields } from './ai.ts';
import {
  CONTINUOUS_NOTICE,
  CONTINUOUS_RECENT,
  aiFailureNotice,
  aiPatchForBook,
  continuousProgress,
  entryLabel,
  finishNotice,
  scanDraft,
  seedFromDraft,
  skipExistingNotice,
  skipFailedNotice,
  skipNeedsConfirmNotice,
  withAiTitle,
  type ContinuousEntry,
} from './continuous-scan.ts';
import { EMPTY_DRAFT } from './write.ts';

function book(overrides: Partial<Book> = {}): Book {
  return {
    id: 'b1',
    isbn: '9787115428028',
    title: '',
    authors: [],
    publisher: '',
    publishDate: '',
    coverUrl: '',
    tags: [],
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    ...overrides,
  };
}

function fields(overrides: Partial<AiBookFields> = {}): AiBookFields {
  return { title: '三体', authors: ['刘慈欣'], publisher: '重庆出版社', publishDate: '2008-01-01', tags: ['科幻'], ...overrides };
}

function entry(bookId: string, isbn: string, title = ''): ContinuousEntry {
  return { bookId, isbn, title };
}

describe('连录：下一本的草稿（04 §11.14.B 第 3 步）', () => {
  const seed = { locationId: 'loc-1', condition: 'good' as const, tagsRaw: '待读' };

  it('副本数是 1、ISBN 用刚扫到的，其余字段一律空', () => {
    const draft = scanDraft(seed, '9787115428028');
    assert.equal(draft.isbn, '9787115428028');
    assert.equal(draft.initialCount, 1);
    for (const key of ['title', 'authorsRaw', 'publisher', 'publishDate', 'coverUrl', 'owner', 'note'] as const) {
      assert.equal(draft[key], EMPTY_DRAFT[key], `${key} 应为空`);
    }
  });

  it('位置/品相/标签取表单当前值，不是 EMPTY_DRAFT 的默认值', () => {
    const draft = scanDraft(seed, '9787115428028');
    assert.equal(draft.locationId, 'loc-1');
    assert.equal(draft.condition, 'good');
    assert.equal(draft.tagsRaw, '待读');
  });

  it('seedFromDraft 只搬这三个字段', () => {
    assert.deepEqual(seedFromDraft({ ...EMPTY_DRAFT, title: '不该被搬走', locationId: 'loc-2', owner: '老张' }), {
      locationId: 'loc-2',
      condition: EMPTY_DRAFT.condition,
      tagsRaw: EMPTY_DRAFT.tagsRaw,
    });
  });
});

describe('连录：累计与收尾文案（04 §11.14.B 界面）', () => {
  it('一本都没录时进度为空串（弹层里不显示一行空的「已录入 0 本」）', () => {
    assert.equal(continuousProgress([]), '');
  });

  it('三本：按录入顺序列出书名', () => {
    const entries = [entry('1', '9787115428028', '三体'), entry('2', '9787020002207', '红楼梦'), entry('3', '9787536692930', '球状闪电')];
    assert.equal(continuousProgress(entries), '已录入 3 本：三体、红楼梦、球状闪电');
  });

  it(`超过 ${CONTINUOUS_RECENT} 本只列最近几条，并注明是「最近」（不能让人以为只录了这几本）`, () => {
    const entries = Array.from({ length: 7 }, (_unused, index) => entry(String(index), `978000000000${index}`, `书${index}`));
    const text = continuousProgress(entries);
    assert.match(text, /^已录入 7 本：/);
    assert.match(text, /书2、书3、书4、书5、书6/);
    assert.doesNotMatch(text, /书1、/);
    assert.match(text, /最近 5 条/);
  });

  it('没有书名的那几条回退显示 ISBN（未配 AI 的一批只有 ISBN）', () => {
    assert.equal(entryLabel(entry('1', '9787115428028')), '9787115428028');
    assert.match(continuousProgress([entry('1', '9787115428028')]), /9787115428028/);
  });

  it('AI 回来只更新对应那条的书名，其余不动', () => {
    const entries = [entry('1', '9787115428028'), entry('2', '9787020002207', '红楼梦')];
    const next = withAiTitle(entries, '1', fields());
    assert.equal(next[0]?.title, '三体');
    assert.deepEqual(next[1], entries[1]);
    assert.equal(entries[0]?.title, '', '原数组不该被就地改动');
  });

  it('模型没给书名时列表保持原样（不能写成空串把 ISBN 顶掉）', () => {
    const next = withAiTitle([entry('1', '9787115428028')], '1', fields({ title: '  ' }));
    assert.equal(entryLabel(next[0] as ContinuousEntry), '9787115428028');
  });

  it('一本没录就关弹层 → 不吭声（不报「本次共录入 0 本」）', () => {
    assert.equal(finishNotice([], true), null);
    assert.equal(finishNotice([], false), null);
  });

  it('关弹层 → 「本次共录入 N 本」；没配 AI 时补一句 ISBN 已经存下', () => {
    const entries = [entry('1', '9787115428028'), entry('2', '9787020002207')];
    assert.equal(finishNotice(entries, true), '本次共录入 2 本');
    assert.match(finishNotice(entries, false) ?? '', /^本次共录入 2 本；.*ISBN/);
  });

  it('补全失败只提示、不吓人：书已经建好了', () => {
    const text = aiFailureNotice(2);
    assert.match(text, /AI 补全失败 2 本/);
    assert.match(text, /已经建好/);
  });

  it('未配 AI 的弹层内提示点名「只存了 ISBN」', () => {
    assert.match(CONTINUOUS_NOTICE.noAi, /未配置 AI/);
    assert.match(CONTINUOUS_NOTICE.noAi, /ISBN/);
  });
});

describe('连录：跳过并提示（04 §11.14.B 第 2、4 步）', () => {
  it('库里已有 → 说出是哪一本，并说明已跳过', () => {
    const text = skipExistingNotice('三体');
    assert.match(text, /《三体》/);
    assert.match(text, /已跳过/);
  });

  it('needsIsbnConfirm → 带上 ISBN 与已跳过，并指路表单', () => {
    const text = skipNeedsConfirmNotice('9787115428028');
    assert.match(text, /9787115428028/);
    assert.match(text, /已跳过/);
    assert.match(text, /表单/);
  });

  it('建书抛异常 → 原样带出原因，而不是吞掉', () => {
    const text = skipFailedNotice('位置不存在：loc-9');
    assert.match(text, /位置不存在：loc-9/);
    assert.match(text, /已跳过/);
  });

  it('三条跳过提示都不提「合并 / 仍然新建」—— 连续模式里绝不弹分支打断节奏', () => {
    for (const text of [skipExistingNotice('三体'), skipNeedsConfirmNotice('9787115428028'), skipFailedNotice('boom')]) {
      assert.doesNotMatch(text, /合并/);
      assert.doesNotMatch(text, /仍然新建/);
    }
  });
});

describe('连录：AI 结果写回刚建的那一条（04 §11.14.B、05 §3.3）', () => {
  it('刚建的书只有 ISBN → 补丁补齐书名/作者/出版社/出版日期/标签', () => {
    assert.deepEqual(aiPatchForBook(book(), fields()), {
      title: '三体',
      authors: ['刘慈欣'],
      publisher: '重庆出版社',
      publishDate: '2008-01-01',
      tags: ['科幻'],
    });
  });

  it('人已经填过的字段不进补丁（05 §3.3 口径：人填的优先于机器猜的）', () => {
    const filled = book({ title: '我写的书名', publisher: '我写的社', authors: ['我写的作者'] });
    assert.deepEqual(aiPatchForBook(filled, fields()), { publishDate: '2008-01-01', tags: ['科幻'] });
  });

  it('AI 什么都没给 → 空补丁（调用方据此跳过这次写库）', () => {
    const empty = fields({ title: '', authors: [], publisher: '', publishDate: '', tags: [] });
    assert.deepEqual(aiPatchForBook(book(), empty), {});
  });

  it('作者与标签按分隔符切成数组再写库（与 db 层的 cleanList 同形）', () => {
    const patch = aiPatchForBook(book(), fields({ authors: ['刘慈欣', '姚海军'], tags: ['科幻', '中文'] }));
    assert.deepEqual(patch.authors, ['刘慈欣', '姚海军']);
    assert.deepEqual(patch.tags, ['科幻', '中文']);
  });
});
