import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { listBooks } from '../../db/books.ts';
import { listLocations } from '../../db/locations.ts';
import { lendCopy } from '../loans/write.ts';
import { withDb } from '../../testing/harness.ts';
import type { Book } from '../../domain/types.ts';
import {
  deleteBookCompletely,
  draftToMergePatch,
  EMPTY_DRAFT,
  isbnNotice,
  MAX_INITIAL_COUNT,
  submitBook,
  suspectedDuplicates,
  validateDraft,
  type BookDraft,
  type SubmitResult,
} from './write.ts';

const ISBN13 = '9787536692930';
const ISBN10 = '7536692935';

function draft(overrides: Partial<BookDraft> = {}): BookDraft {
  return { ...EMPTY_DRAFT, title: '三体', ...overrides };
}

/**
 * 取提交结果里的书目。`needsIsbnConfirm` 分支本来就没有书，测试到这里就是要它已经建好了，
 * 因此走错分支直接失败（同时把联合类型收窄，省得每处都写一遍 if）。
 */
function savedBook(result: SubmitResult): Book {
  if (result.kind === 'needsIsbnConfirm') {
    throw new Error(`预期已保存，却返回待确认（命中 ${result.existing.length} 条）`);
  }
  return result.book;
}

describe('validateDraft', () => {
  it('书名与 ISBN 至少填一个', () => {
    assert.equal(validateDraft(draft()), null);
    assert.equal(validateDraft(draft({ title: '', isbn: ISBN13 })), null);
    assert.match(validateDraft(draft({ title: '   ', isbn: '' })) ?? '', /书名与 ISBN 至少要填一个/);
  });

  it('副本数量必须是合理正整数', () => {
    assert.equal(validateDraft(draft({ initialCount: 1 })), null);
    assert.equal(validateDraft(draft({ initialCount: MAX_INITIAL_COUNT })), null);
    assert.notEqual(validateDraft(draft({ initialCount: 0 })), null);
    assert.notEqual(validateDraft(draft({ initialCount: -3 })), null);
    assert.notEqual(validateDraft(draft({ initialCount: 1.5 })), null);
    assert.notEqual(validateDraft(draft({ initialCount: MAX_INITIAL_COUNT + 1 })), null);
  });

  it('出版日期留空可以，填了就必须是合法日历日', () => {
    assert.equal(validateDraft(draft({ publishDate: '' })), null);
    assert.equal(validateDraft(draft({ publishDate: '2008-01-01' })), null);
    assert.notEqual(validateDraft(draft({ publishDate: '2008-1-1' })), null);
    assert.notEqual(validateDraft(draft({ publishDate: '2008-02-30' })), null);
  });
});

describe('isbnNotice', () => {
  it('空 ISBN 不提示', () => {
    assert.equal(isbnNotice(''), null);
    assert.equal(isbnNotice('   '), null);
  });

  it('已经是 ISBN-13 时不啰嗦（多打了连字符也不算改变）', () => {
    assert.equal(isbnNotice(ISBN13), null);
    assert.equal(isbnNotice('978-7-5366-9293-0'), null);
  });

  it('ISBN-10 会说明将按 ISBN-13 保存（决策 D4）', () => {
    assert.match(isbnNotice(ISBN10) ?? '', /将按 ISBN-13 保存：9787536692930/);
  });

  it('无效 ISBN 明确告知会被留空，而不是静默丢弃', () => {
    const notice = isbnNotice('abc123');
    assert.match(notice ?? '', /不是有效的 ISBN/);
    assert.match(notice ?? '', /123/);
  });
});

describe('draftToMergePatch', () => {
  it('只带非空字段，空文本框不会覆盖已有数据', () => {
    const patch = draftToMergePatch(draft({ title: '', authorsRaw: '', publisher: '' }));
    assert.equal(patch.title, undefined);
    assert.equal(patch.authors, undefined);
    assert.equal(patch.publisher, undefined);
    assert.equal(patch.isbn, undefined);
  });

  it('填了的字段才进补丁', () => {
    const patch = draftToMergePatch(draft({ publisher: '重庆出版社', tagsRaw: '科幻、小说' }));
    assert.equal(patch.publisher, '重庆出版社');
    assert.deepEqual(patch.tags, ['科幻', '小说']);
    assert.equal(patch.title, '三体');
  });
});

describe('suspectedDuplicates', () => {
  const existing = [
    {
      id: 'b1',
      isbn: '',
      title: '三体（全集）',
      authors: [],
      publisher: '',
      publishDate: '',
      coverUrl: '',
      tags: [],
      createdAt: '',
      updatedAt: '',
    },
    {
      id: 'b2',
      isbn: ISBN13,
      title: '三体',
      authors: [],
      publisher: '',
      publishDate: '',
      coverUrl: '',
      tags: [],
      createdAt: '',
      updatedAt: '',
    },
  ];

  it('书名规范化后相同即为疑似重复（含全角括号差异）', () => {
    const hits = suspectedDuplicates(existing, draft({ title: '三体(全集)', isbn: '' }));
    assert.deepEqual(
      hits.map((b) => b.id),
      ['b1'],
    );
  });

  it('ISBN 相同的是同一本书，不算疑似重复', () => {
    assert.deepEqual(suspectedDuplicates(existing, draft({ title: '三体', isbn: ISBN13 })), []);
  });

  it('书名为空时不报疑似重复', () => {
    assert.deepEqual(suspectedDuplicates(existing, draft({ title: '' })), []);
  });
});

describe('submitBook', () => {
  it('新建书目并按 initialCount 生成副本，落位到指定位置', async () => {
    await withDb(async (db) => {
      const [room] = await listLocations(db);
      assert.ok(room);

      const result = await submitBook(db, draft({ isbn: ISBN13, locationId: room.id, initialCount: 3 }));
      assert.equal(result.kind, 'created');
      const saved = savedBook(result);

      const copies = await db.copies.where('bookId').equals(saved.id).toArray();
      assert.equal(copies.length, 3);
      for (const copy of copies) {
        assert.equal(copy.locationId, room.id);
        assert.equal(copy.status, 'on_shelf');
      }
      const book = await db.books.get(saved.id);
      assert.equal(book?.isbn, ISBN13);
    });
  });

  it('ISBN-10 输入按 ISBN-13 入库（否则同一本书会有两条记录）', async () => {
    await withDb(async (db) => {
      const result = await submitBook(db, draft({ isbn: ISBN10 }));
      assert.equal(savedBook(result).isbn, ISBN13);
    });
  });

  it('未指定位置时落到「未分类」，不是丢进虚空', async () => {
    await withDb(async (db) => {
      const result = await submitBook(db, draft({ locationId: '' }));
      const copies = await db.copies.where('bookId').equals(savedBook(result).id).toArray();
      assert.equal(copies.length, 1);
      const location = await db.locations.get(copies[0]?.locationId ?? '');
      assert.equal(location?.name, '未分类');
    });
  });

  it('ISBN 命中已有书目时先返回待确认，不偷偷建重复记录', async () => {
    await withDb(async (db) => {
      await submitBook(db, draft({ isbn: ISBN13 }));
      const second = await submitBook(db, draft({ isbn: ISBN13, title: '三体（新版）' }));
      assert.equal(second.kind, 'needsIsbnConfirm');
      assert.equal(second.kind === 'needsIsbnConfirm' ? second.existing.length : -1, 1);
      assert.equal((await listBooks(db)).length, 1);
    });
  });

  it('确认后仍可新建（用户明确选择"就当两本不同书"）', async () => {
    await withDb(async (db) => {
      await submitBook(db, draft({ isbn: ISBN13 }));
      const second = await submitBook(db, draft({ isbn: ISBN13, title: '三体（新版）' }), { isbnConfirmed: true });
      assert.equal(second.kind, 'created');
      assert.equal((await listBooks(db)).length, 2);
    });
  });

  it('合并到已有书目：副本挂过去，且不会被空文本框清空元数据', async () => {
    await withDb(async (db) => {
      const first = savedBook(await submitBook(db, draft({ isbn: ISBN13, publisher: '重庆出版社', initialCount: 1 })));
      const second = await submitBook(
        db,
        draft({ isbn: ISBN13, title: '', authorsRaw: '', publisher: '', initialCount: 2 }),
        { mergeIntoBookId: first.id },
      );
      assert.equal(second.kind, 'merged');
      assert.equal(savedBook(second).id, first.id);

      const book = await db.books.get(first.id);
      assert.equal(book?.title, '三体');
      assert.equal(book?.publisher, '重庆出版社');
      const copies = await db.copies.where('bookId').equals(first.id).toArray();
      assert.equal(copies.length, 3);
      assert.equal((await listBooks(db)).length, 1);
    });
  });

  it('校验不过时抛人话错误，且数据库没有变化', async () => {
    await withDb(async (db) => {
      await assert.rejects(() => submitBook(db, draft({ title: '', isbn: '' })), /书名与 ISBN 至少要填一个/);
      assert.equal((await listBooks(db)).length, 0);
    });
  });
});

describe('deleteBookCompletely', () => {
  it('连副本与借出记录一起删除（deleteBook 单独调用会因有副本而拒绝）', async () => {
    await withDb(async (db) => {
      const saved = savedBook(await submitBook(db, draft({ initialCount: 2 })));
      const removed = await deleteBookCompletely(db, saved.id, { strategy: 'cascade' });
      assert.equal(removed.copies, 2);
      assert.equal(removed.loans, 0);
      assert.equal(await db.books.get(saved.id), undefined);
      assert.equal(await db.copies.where('bookId').equals(saved.id).count(), 0);
    });
  });

  it('副本正被借出时必须显式确认，否则拒绝删除', async () => {
    await withDb(async (db) => {
      const [room] = await listLocations(db);
      assert.ok(room);
      const saved = savedBook(await submitBook(db, draft({ locationId: room.id })));
      const copy = await db.copies.where('bookId').equals(saved.id).first();
      assert.ok(copy);
      await lendCopy(db, { copyId: copy.id, borrower: '张三' });

      await assert.rejects(() => deleteBookCompletely(db, saved.id, { strategy: 'cascade' }), /正被「张三」借出/);
      assert.ok(await db.books.get(saved.id));

      await deleteBookCompletely(db, saved.id, { strategy: 'cascade', confirmLentOut: true });
      assert.equal(await db.books.get(saved.id), undefined);
      assert.equal(await db.loans.count(), 0);
    });
  });
});
