/**
 * 新增书目页（04 §1 `/books/new`）：表单校验与保存流程走 `./write.ts`。
 *
 * 两个分支都来自 submitBook 的返回值（不是页面自己发明的规则）：
 * - ISBN 命中已有书目 → 给「合并到已有书目（把副本挂过去）/ 仍然新建」两个选项；
 * - 书名疑似重复（同名不同 ISBN）→ 只提示不阻断（02 §10.3）。
 *
 * 页面顺序是 04 §11.13 定的：动作行 → 书名 → 作者 → 出版社 → 位置 →「更多信息」折叠区 →
 * 保存 → 批量导入区（原样留在最下方）。三个识别入口整块在 LookupActions，折叠区九项在 MoreFields
 * —— 页面只管编排与保存，不再自己排字段。
 *
 * 保存成功后**不跳转**（04 §11.14.A）：停留本页 + 顶部横幅「已保存《书名》· N 副本」+
 * 「去看这本书」；表单按「保留位置/品相/标签、清空其余、副本数回 1」重置。录第 2 本不该先点回新增页。
 *
 * 表单记忆（04 §11.2）：挂载时用 applyDraftPrefs 回填位置/品相/标签，保存成功后
 * 用 rememberDraftPrefs 记住这一次 —— 连录几十本时不必每次重选。
 */

import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { Collapsible } from '../../app/Collapsible.tsx';
import { useDb } from '../../app/db-context.ts';
import { COVER_LABELS, bookDisplayTitle, locationPathText } from '../../app/labels.ts';
import { Banner, Button, Card, InlineError, PageHeader, SelectField, TextField, type SelectOption } from '../../app/ui.tsx';
import { useAsyncAction, useLiveQuery } from '../../app/useLiveQuery.ts';
import { listBooks } from '../../db/books.ts';
import { putCover } from '../../db/covers.ts';
import { listLocations } from '../../db/locations.ts';
import { parsePositiveInt } from '../../domain/text.ts';
import type { Book, Location } from '../../domain/types.ts';
import type { CompressedImage } from '../../platform/image.ts';
import { BulkImportSection } from './BulkImportSection.tsx';
import { LookupActions, type LookupNotice } from './LookupActions.tsx';
import { MoreFields, countMoreFields } from './MoreFields.tsx';
import {
  EMPTY_DRAFT,
  applyDraftPrefs,
  rememberDraftPrefs,
  submitBook,
  suspectedDuplicates,
  validateDraft,
  type BookDraft,
  type SubmitOptions,
} from './write.ts';

/** 刚保存的那一本：顶部横幅与「去看这本书」用它（04 §11.14.A）。 */
interface SavedBook {
  bookId: string;
  title: string;
  copies: number;
}

/** 04 §11.14.A 的重置口径：**保留**位置/品相/标签（表单记忆的三个字段，04 §11.2），清空其余。 */
function resetDraft(previous: BookDraft): BookDraft {
  return {
    ...EMPTY_DRAFT,
    locationId: previous.locationId,
    condition: previous.condition,
    tagsRaw: previous.tagsRaw,
  };
}

export function NewBookPage(): ReactNode {
  const db = useDb();
  const navigate = useNavigate();

  const [draft, setDraft] = useState<BookDraft>(EMPTY_DRAFT);
  const [countRaw, setCountRaw] = useState(String(EMPTY_DRAFT.initialCount));
  const [formError, setFormError] = useState<string | null>(null);
  const action = useAsyncAction();
  // needsIsbnConfirm：submitBook 返回待确认时进入这个状态，给「合并 / 仍然新建」选项
  const [isbnConflicts, setIsbnConflicts] = useState<Book[] | null>(null);
  const [mergeIntoId, setMergeIntoId] = useState('');
  // 拍好的封面先留在这里，保存书目时随书入库（04 §11.8：先存书目再存封面）
  const [pendingCover, setPendingCover] = useState<CompressedImage | null>(null);
  // 动作行的提示横幅（扫码 / 照片 / AI 的结果）—— ISBN 框在折叠区里，改 ISBN 时要清掉它
  const [lookupNotice, setLookupNotice] = useState<LookupNotice | null>(null);
  // 上一次保存的结果：本页横幅（04 §11.14.A）
  const [saved, setSaved] = useState<SavedBook | null>(null);
  // 每保存成功一次 +1：给折叠区换 key 用（见下面 Collapsible 的注释）
  const [formRound, setFormRound] = useState(0);

  const locations = useLiveQuery<Location[]>(async () => listLocations(db), [db], []);
  const books = useLiveQuery<Book[]>(async () => listBooks(db), [db], []);

  // 表单记忆（04 §11.2）：挂载时回填上次的位置/品相/标签，其余字段始终空白。
  // 只在草稿还没被动过时才回填 —— 用户已经动手敲了字，他填的比记忆重要。
  useEffect(() => {
    let active = true;
    void (async () => {
      const remembered = await applyDraftPrefs(db, EMPTY_DRAFT);
      if (active) setDraft((previous) => (previous === EMPTY_DRAFT ? remembered : previous));
    })();
    return () => {
      active = false;
    };
  }, [db]);

  const locationOptions: SelectOption[] = [
    { value: '', label: '未分类（默认）' },
    ...locations.map((location) => ({ value: location.id, label: locationPathText(location.path) })),
  ];
  const suspected = suspectedDuplicates(books, draft);

  /* ---------------- 保存 ---------------- */

  function submit(options: SubmitOptions = {}): void {
    const candidate: BookDraft = {
      ...draft,
      initialCount: parsePositiveInt(countRaw) ?? 0,
    };
    const problem = validateDraft(candidate);
    if (problem !== null) {
      setFormError(problem);
      return;
    }
    setFormError(null);
    setIsbnConflicts(null);
    void action.run(async () => {
      const result = await submitBook(db, candidate, options);
      if (result.kind === 'needsIsbnConfirm') {
        setIsbnConflicts(result.existing);
        setMergeIntoId(result.existing[0]?.id ?? '');
        return;
      }
      // 保存成功后才记（04 §11.2）：位置/品相/标签下次进新增页时回填，
      // 连录几十本时不用每次重选
      await rememberDraftPrefs(db, candidate);
      // 先存书目再存封面（04 §11.8）：封面以 bookId 为主键，得先有那本书。
      // 封面写失败时书目已经落库了，所以要把这句话说清楚；但**不能让用户再点一次「保存」**
      // 去补救——没填 ISBN 时那条路会再建一条同名书目，填了 ISBN 时合并又会按副本数再建一遍副本。
      // 指路详情页重拍，两边都不会有副作用。
      if (pendingCover !== null) {
        try {
          await putCover(db, { bookId: result.book.id, blob: pendingCover.blob, mime: pendingCover.mime });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(
            `${COVER_LABELS.saveFailed}：${reason}。书目已经保存好了，去这本书的详情页就能重新拍一张。`,
          );
        }
      }
      // 不跳转（04 §11.14.A）：本页横幅报一句就行，接着录下一本
      setSaved({ bookId: result.book.id, title: bookDisplayTitle(result.book), copies: result.copies });
      setDraft(resetDraft);
      setCountRaw(String(EMPTY_DRAFT.initialCount));
      setPendingCover(null);
      // 上一本的扫后提示描述的是上一个 ISBN，跟着表单一起清掉
      setLookupNotice(null);
      setFormRound((previous) => previous + 1);
    });
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title="新增书目"
        description="先记下书名或 ISBN，其余信息之后可以再补。保存后可以在详情页继续添加副本。"
      />

      {/* 保存成功后的落点（04 §11.14.A）：想去看刚存的那本，这里一步就到 */}
      {saved !== null && (
        <Banner
          tone="green"
          action={
            <Button size="sm" variant="primary" onClick={() => navigate(`/books/${saved.bookId}`)}>
              去看这本书
            </Button>
          }
        >
          已保存《{saved.title}》· {saved.copies} 副本
        </Banner>
      )}

      {isbnConflicts !== null && (
        <Card className="space-y-3 border-amber-300 p-4 dark:border-amber-800">
          <p className="text-sm text-amber-900 dark:text-amber-200">库里已经有同样 ISBN 的书：</p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-neutral-700 dark:text-neutral-300">
            {isbnConflicts.map((book) => (
              <li key={book.id}>{bookDisplayTitle(book)}</li>
            ))}
          </ul>
          <p className="text-sm text-neutral-600 dark:text-neutral-300">
            如果就是那本书，选「合并到已有书目」——这次填的信息会补进它的资料，副本会挂到它下面。
            如果是不同的版本（同 ISBN 的再版/精装版），选「仍然新建」。
          </p>
          {isbnConflicts.length > 1 && (
            <SelectField
              label="合并到哪一本"
              value={mergeIntoId}
              options={isbnConflicts.map((book) => ({ value: book.id, label: bookDisplayTitle(book) }))}
              onValueChange={setMergeIntoId}
            />
          )}
          <div className="flex flex-wrap gap-2">
            {isbnConflicts.length === 1 && isbnConflicts[0] !== undefined && (
              <Button variant="primary" onClick={() => submit({ mergeIntoBookId: isbnConflicts[0]?.id })} disabled={action.pending}>
                合并到《{bookDisplayTitle(isbnConflicts[0])}》
              </Button>
            )}
            {isbnConflicts.length > 1 && mergeIntoId !== '' && (
              <Button variant="primary" onClick={() => submit({ mergeIntoBookId: mergeIntoId })} disabled={action.pending}>
                合并到选中的书
              </Button>
            )}
            <Button onClick={() => submit({ isbnConfirmed: true })} disabled={action.pending}>
              仍然新建一本
            </Button>
            <Button variant="ghost" onClick={() => setIsbnConflicts(null)} disabled={action.pending}>
              再想想
            </Button>
          </div>
        </Card>
      )}

      {suspected.length > 0 && (
        <Banner tone="amber">
          疑似重复：库里已有同名的《{bookDisplayTitle(suspected[0] ?? { title: '', isbn: '' })}》但 ISBN 不同。
          如果其实是同一本书，建议直接去它的详情页添加副本，而不是新建一条。
        </Banner>
      )}

      <Card className="space-y-4 p-4">
        {/* 第 1 项：动作行（04 §11.13）—— 三个入口都是动作，不跟着 ISBN 收进折叠区 */}
        <LookupActions
          draft={draft}
          updateDraft={setDraft}
          disabled={action.pending}
          notice={lookupNotice}
          onNotice={setLookupNotice}
        />
        <TextField
          label="书名"
          value={draft.title}
          onValueChange={(value) => setDraft({ ...draft, title: value })}
          hint="可以先留空，之后再补"
        />
        <TextField
          label="作者"
          value={draft.authorsRaw}
          onValueChange={(value) => setDraft({ ...draft, authorsRaw: value })}
          hint="多个作者用逗号或顿号分开"
        />
        <TextField
          label="出版社"
          value={draft.publisher}
          onValueChange={(value) => setDraft({ ...draft, publisher: value })}
        />
        <SelectField label="位置" value={draft.locationId} options={locationOptions} onValueChange={(value) => setDraft({ ...draft, locationId: value })} />

        {/* 第 6 项：折叠区（04 §11.13）—— 收起时只占一行，计数提示里面已经填了几项。
            每保存一次就换一次 key：里面有一张**拍了但没确认**的照片（CoverPicker 的暂存态，
            页面看不到也清不掉），那是上一本的照片，不该跟着下一本 —— 顺手也把折叠区收回默认态 */}
        <Collapsible key={formRound} title="更多信息（可选）" count={countMoreFields(draft, pendingCover, countRaw)}>
          <MoreFields
            draft={draft}
            updateDraft={setDraft}
            countRaw={countRaw}
            onCountChange={setCountRaw}
            pendingCover={pendingCover}
            onPendingCover={setPendingCover}
            disabled={action.pending}
            onIsbnEdit={() => setLookupNotice(null)}
          />
        </Collapsible>

        {(formError ?? action.error) !== null && <InlineError>{formError ?? action.error}</InlineError>}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => submit()} disabled={action.pending}>
            {action.pending ? '保存中…' : '保存'}
          </Button>
        </div>
      </Card>

      {/* 批量导入（04 §11.1、05 §2）：整块是独立的导入流水线，留在页面最下方（04 §11.13 第 8 项） */}
      <BulkImportSection />
    </div>
  );
}
