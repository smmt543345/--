import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { listLocations } from '../../db/locations.ts';
import { SETTING_KEYS, setSetting } from '../../db/settings.ts';
import { addDays, isDateString, today } from '../../domain/time.ts';
import { withDb } from '../../testing/harness.ts';
import { submitBook } from '../books/write.ts';
import { defaultDueDateFor, emptyLoanDraft, lendCopy, returnLoan, validateLoanDraft } from './write.ts';

/** 建一本带单个副本的书，返回副本 id。 */
async function seedCopy(db: Parameters<typeof submitBook>[0]): Promise<string> {
  const [location] = await listLocations(db);
  assert.ok(location);
  const result = await submitBook(db, {
    ...{
      title: '三体',
      isbn: '',
      authorsRaw: '',
      publisher: '',
      publishDate: '',
      coverUrl: '',
      tagsRaw: '',
      locationId: location.id,
      condition: 'unknown',
      owner: '',
      note: '',
      initialCount: 1,
    },
  });
  // assert.equal 的断言签名会把联合类型收窄到 created，因此下一行能直接取 result.book
  assert.equal(result.kind, 'created');
  const copy = await db.copies.where('bookId').equals(result.book.id).first();
  assert.ok(copy);
  return copy.id;
}

describe('emptyLoanDraft', () => {
  it('默认借出日期是今天，应还日期留空（由 UI 决定填不填）', () => {
    const draft = emptyLoanDraft('2026-09-11');
    assert.equal(draft.loanDate, '2026-09-11');
    assert.equal(draft.dueDate, '');
    assert.equal(draft.borrower, '');
  });
});

describe('validateLoanDraft', () => {
  it('借书人必填', () => {
    assert.equal(validateLoanDraft({ ...emptyLoanDraft(), borrower: '张三' }), null);
    assert.match(validateLoanDraft(emptyLoanDraft()) ?? '', /借书人不能为空/);
    assert.match(validateLoanDraft({ ...emptyLoanDraft(), borrower: '   ' }) ?? '', /借书人不能为空/);
  });

  it('借出日期格式错误要挡住', () => {
    assert.notEqual(validateLoanDraft({ ...emptyLoanDraft(), borrower: '张三', loanDate: '2026/09/11' }), null);
    assert.notEqual(validateLoanDraft({ ...emptyLoanDraft(), borrower: '张三', loanDate: '2026-02-30' }), null);
  });

  it('应还日期可以留空，填了就不能早于借出日期', () => {
    const base = { ...emptyLoanDraft(), borrower: '张三', loanDate: '2026-09-11' };
    assert.equal(validateLoanDraft(base), null);
    assert.equal(validateLoanDraft({ ...base, dueDate: '2026-10-11' }), null);
    assert.equal(validateLoanDraft({ ...base, dueDate: '2026-09-11' }), null);
    assert.match(validateLoanDraft({ ...base, dueDate: '2026-09-10' }) ?? '', /不能早于借出日期/);
    assert.match(validateLoanDraft({ ...base, dueDate: '下个月' }) ?? '', /格式/);
  });
});

describe('defaultDueDateFor', () => {
  it('按设置里的借期推算', async () => {
    await withDb(async (db) => {
      await setSetting(db, SETTING_KEYS.loanPeriodDays, 14);
      assert.equal(await defaultDueDateFor(db, '2026-09-11'), '2026-09-25');
    });
  });

  it('设置被写坏时回落到 30 天，而不是算出空日期', async () => {
    await withDb(async (db) => {
      await setSetting(db, SETTING_KEYS.loanPeriodDays, '三十');
      const due = await defaultDueDateFor(db, '2026-09-11');
      assert.ok(isDateString(due));
      assert.equal(due, addDays('2026-09-11', 30));
    });
  });
});

describe('lendCopy / returnLoan', () => {
  it('借出后副本状态变 lent_out，归还后回到在架', async () => {
    await withDb(async (db) => {
      const copyId = await seedCopy(db);

      const loan = await lendCopy(db, { copyId, borrower: ' 张三 ' });
      assert.equal(loan.borrower, '张三');
      assert.equal(loan.status, 'active');
      assert.equal((await db.copies.get(copyId))?.status, 'lent_out');

      const returned = await returnLoan(db, copyId);
      assert.equal(returned.status, 'returned');
      assert.equal((await db.copies.get(copyId))?.status, 'on_shelf');
    });
  });

  it('应还日期留空 = 不设到期日，不会算出一个假日期', async () => {
    await withDb(async (db) => {
      const copyId = await seedCopy(db);
      const loan = await lendCopy(db, { copyId, borrower: '张三', dueDate: '' });
      assert.equal(loan.dueDate, '');
    });
  });

  it('不传 dueDate 时按设置自动推算', async () => {
    await withDb(async (db) => {
      await setSetting(db, SETTING_KEYS.loanPeriodDays, 7);
      const copyId = await seedCopy(db);
      const loan = await lendCopy(db, { copyId, borrower: '张三', loanDate: today() });
      assert.equal(loan.dueDate, addDays(today(), 7));
    });
  });

  it('借书人为空时抛人话错误，副本状态不变', async () => {
    await withDb(async (db) => {
      const copyId = await seedCopy(db);
      await assert.rejects(() => lendCopy(db, { copyId, borrower: '  ' }), /借书人不能为空/);
      assert.equal((await db.copies.get(copyId))?.status, 'on_shelf');
    });
  });

  it('归还日期格式错误时挡住，且不产生"已归还"的假状态', async () => {
    await withDb(async (db) => {
      const copyId = await seedCopy(db);
      await lendCopy(db, { copyId, borrower: '张三' });
      await assert.rejects(() => returnLoan(db, copyId, '2026-13-40'), /格式应为 YYYY-MM-DD/);
      assert.equal((await db.copies.get(copyId))?.status, 'lent_out');
    });
  });

  it('归还时可以指定日期（补录昨天还的书）', async () => {
    await withDb(async (db) => {
      const copyId = await seedCopy(db);
      await lendCopy(db, { copyId, borrower: '张三' });
      const returned = await returnLoan(db, copyId, '2026-09-10');
      assert.equal(returned.returnDate, '2026-09-10');
      assert.equal(returned.status, 'returned');
    });
  });
});
