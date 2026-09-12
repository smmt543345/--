import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EMPTY_DRAFT } from './write.ts';
import { buildAiUserPrompt, mergeAiFields, parseAiResponse } from './ai.ts';

describe('parseAiResponse（05 §3.3）', () => {
  it('解析正常 JSON', () => {
    const result = parseAiResponse('{"title":"活着","authors":["余华"],"publisher":"作家出版社","publishDate":"2012-08-01","tags":["文学"]}');
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.fields.title, '活着');
      assert.deepEqual(result.fields.authors, ['余华']);
      assert.equal(result.fields.publishDate, '2012-08-01');
    }
  });

  it('剥掉 ```json 围栏', () => {
    const result = parseAiResponse('```json\n{"title":"活着"}\n```');
    assert.ok(result.ok);
  });

  it('JSON 前后有废话也能截取', () => {
    const result = parseAiResponse('好的，这是结果：{"title":"活着","authors":["余华"]} 希望能帮到你');
    assert.ok(result.ok);
  });

  it('模型胡话 → 明确错误', () => {
    const result = parseAiResponse('抱歉，我无法回答这个问题');
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /JSON/);
  });

  it('非法 publishDate 丢弃，其余字段保留', () => {
    const result = parseAiResponse('{"title":"活着","publishDate":"大约2012年"}');
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.fields.publishDate, '');
  });

  it('日历上不存在的日期（如 2012-02-30）同样丢弃（05 §3.3 走真实日历校验）', () => {
    const result = parseAiResponse('{"title":"活着","publishDate":"2012-02-30"}');
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.fields.publishDate, '');
  });

  it('authors/tags 传字符串时归一成数组', () => {
    const result = parseAiResponse('{"title":"活着","authors":"余华","tags":"文学"}');
    assert.ok(result.ok);
    if (result.ok) assert.deepEqual(result.fields.authors, ['余华']);
  });
});

describe('mergeAiFields（只填空字段）', () => {
  it('空字段被填，已填字段不动', () => {
    const merged = mergeAiFields({ ...EMPTY_DRAFT, title: '我起的名字' }, {
      title: 'AI 起的名字',
      authors: ['余华'],
      publisher: '作家出版社',
      publishDate: '2012-08-01',
      tags: ['文学'],
    });
    assert.equal(merged.title, '我起的名字', '人填的书名优先');
    assert.equal(merged.publisher, '作家出版社');
    assert.equal(merged.publishDate, '2012-08-01');
  });

  it('作者与标签取并集、去重', () => {
    const merged = mergeAiFields({ ...EMPTY_DRAFT, authorsRaw: '余华', tagsRaw: '已读' }, {
      title: '',
      authors: ['余华', '洪治纲'],
      publisher: '',
      publishDate: '',
      tags: ['文学'],
    });
    assert.deepEqual(merged.authorsRaw.split('，'), ['余华', '洪治纲']);
    assert.deepEqual(merged.tagsRaw.split('，'), ['已读', '文学']);
  });
});

describe('buildAiUserPrompt', () => {
  it('书名优先，ISBN 作补充', () => {
    assert.match(buildAiUserPrompt({ title: '活着', isbn: '9787506365437' }), /《活着》/);
    assert.match(buildAiUserPrompt({ title: '活着', isbn: '9787506365437' }), /9787506365437/);
  });

  it('没有书名时只靠 ISBN', () => {
    assert.match(buildAiUserPrompt({ title: '', isbn: '9787506365437' }), /9787506365437/);
  });
});
