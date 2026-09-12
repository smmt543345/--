/**
 * 新增书目页（04 §1 `/books/new`）：表单校验与保存流程走 `./write.ts`。
 *
 * 两个分支都来自 submitBook 的返回值（不是页面自己发明的规则）：
 * - ISBN 命中已有书目 → 给「合并到已有书目（把副本挂过去）/ 仍然新建」两个选项；
 * - 书名疑似重复（同名不同 ISBN）→ 只提示不阻断（02 §10.3）。
 *
 * 阶段 B2 的另外两个入口（规范 05）：
 * - 「AI 补全」：书名/ISBN → OpenAI 兼容服务 → 只填空字段（05 §3.3）；
 * - 「批量导入」：粘贴书单或 CSV 文件 → 只建书目不建副本，跳过规则见 05 §2.2。
 *
 * 保存成功后跳到书目详情页 —— 那里可以继续加副本、借出。
 */

import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { useDb } from '../../app/db-context.ts';
import { COPY_CONDITION_LABELS, bookDisplayTitle, locationPathText } from '../../app/labels.ts';
import {
  Banner,
  Button,
  Card,
  ChoiceGroup,
  InlineError,
  PageHeader,
  SelectField,
  TextAreaField,
  TextField,
  type ChoiceOption,
  type SelectOption,
} from '../../app/ui.tsx';
import { useAsyncAction, useLiveQuery } from '../../app/useLiveQuery.ts';
import { listBooks } from '../../db/books.ts';
import { listLocations } from '../../db/locations.ts';
import { SETTING_KEYS, getSetting } from '../../db/settings.ts';
import { parsePositiveInt } from '../../domain/text.ts';
import { COPY_CONDITIONS } from '../../domain/types.ts';
import type { Book, CopyCondition, Location } from '../../domain/types.ts';
import { completeChat, isAiConfigured, type AiConfig } from '../../platform/ai.ts';
import { pickTextFile } from '../../platform/files.ts';
import { AI_SYSTEM_PROMPT, buildAiUserPrompt, mergeAiFields, parseAiResponse } from './ai.ts';
import {
  bulkImportBooks,
  parseCsvText,
  parsePasteText,
  type BulkImportReport,
} from './import.ts';
import {
  EMPTY_DRAFT,
  MAX_INITIAL_COUNT,
  isbnNotice,
  submitBook,
  suspectedDuplicates,
  validateDraft,
  type BookDraft,
  type SubmitOptions,
} from './write.ts';

const CONDITION_OPTIONS: readonly ChoiceOption<CopyCondition>[] = COPY_CONDITIONS.map((value) => ({
  value,
  label: COPY_CONDITION_LABELS[value],
}));

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

  const locations = useLiveQuery<Location[]>(async () => listLocations(db), [db], []);
  const books = useLiveQuery<Book[]>(async () => listBooks(db), [db], []);

  const locationOptions: SelectOption[] = [
    { value: '', label: '未分类（默认）' },
    ...locations.map((location) => ({ value: location.id, label: locationPathText(location.path) })),
  ];
  const suspected = suspectedDuplicates(books, draft);

  /* ---------------- AI 补全（05 §3） ---------------- */

  const aiConfig = useLiveQuery<AiConfig>(
    async () => ({
      baseUrl: await getSetting<string>(db, SETTING_KEYS.aiBaseUrl, 'https://api.openai.com/v1'),
      apiKey: await getSetting<string>(db, SETTING_KEYS.aiApiKey, ''),
      model: await getSetting<string>(db, SETTING_KEYS.aiModel, 'gpt-4o-mini'),
    }),
    [db],
    { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' },
  );
  const aiConfigured = isAiConfigured(aiConfig);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiNotice, setAiNotice] = useState<{ tone: 'green' | 'red'; text: string } | null>(null);

  function runAiComplete(): void {
    if (draft.title.trim() === '' && draft.isbn.trim() === '') return;
    setAiBusy(true);
    setAiNotice(null);
    void (async () => {
      try {
        const text = await completeChat(aiConfig, AI_SYSTEM_PROMPT, buildAiUserPrompt({ title: draft.title, isbn: draft.isbn }));
        const parsed = parseAiResponse(text);
        if (!parsed.ok) {
          setAiNotice({ tone: 'red', text: parsed.error });
          return;
        }
        setDraft((previous) => mergeAiFields(previous, parsed.fields));
        setAiNotice({ tone: 'green', text: '已补全，请核对后保存——你已经填过的字段不会被覆盖。' });
      } catch (error) {
        setAiNotice({ tone: 'red', text: error instanceof Error ? error.message : String(error) });
      } finally {
        setAiBusy(false);
      }
    })();
  }

  /* ---------------- 批量导入（05 §2） ---------------- */

  const bulkAction = useAsyncAction();
  const [pasteText, setPasteText] = useState('');
  const [csvName, setCsvName] = useState<string | null>(null);
  const [bulkReport, setBulkReport] = useState<BulkImportReport | null>(null);

  function runPasteImport(): void {
    const rows = parsePasteText(pasteText);
    if (rows.length === 0) {
      setBulkReport({ created: 0, skipped: [{ line: 0, reason: '没有解析出任何书目（每行一本：书名，作者，ISBN）' }], suspected: [] });
      return;
    }
    void bulkAction.run(async () => {
      setBulkReport(await bulkImportBooks(db, rows));
      setPasteText('');
    });
  }

  function runCsvImport(): void {
    void bulkAction.run(async () => {
      const file = await pickTextFile('.csv,text/csv');
      if (file === null) return;
      const rows = parseCsvText(file.text);
      if (rows.length === 0) {
        setBulkReport({ created: 0, skipped: [{ line: 0, reason: 'CSV 里没有解析出任何书目' }], suspected: [] });
        return;
      }
      setCsvName(file.name);
      setBulkReport(await bulkImportBooks(db, rows));
    });
  }

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
      // created / merged 都去详情页：接着加副本、借出都在那里
      navigate(`/books/${result.book.id}`);
    });
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title="新增书目"
        description="先记下书名或 ISBN，其余信息之后可以再补。保存后可以在详情页继续添加副本。"
      />

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
        <TextField
          label="书名"
          value={draft.title}
          onValueChange={(value) => setDraft({ ...draft, title: value })}
          hint="可以先留空，之后再补"
        />
        <TextField
          label="ISBN"
          value={draft.isbn}
          onValueChange={(value) => setDraft({ ...draft, isbn: value })}
          hint={isbnNotice(draft.isbn) ?? '可以留空；填了才能按 ISBN 查重'}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={runAiComplete} disabled={!aiConfigured || aiBusy || (draft.title.trim() === '' && draft.isbn.trim() === '')}>
            {aiBusy ? 'AI 补全中…' : '✦ AI 补全'}
          </Button>
          <span className="text-xs text-neutral-500 dark:text-neutral-400">
            {aiConfigured
              ? '按书名或 ISBN 自动补作者、出版社等信息；只填空着的字段'
              : '在「备份与设置 → AI 元数据补全」配置后可用（OpenAI 兼容接口）'}
          </span>
        </div>
        {aiNotice !== null && <Banner tone={aiNotice.tone}>{aiNotice.text}</Banner>}
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
        <TextField
          label="出版日期"
          value={draft.publishDate}
          onValueChange={(value) => setDraft({ ...draft, publishDate: value })}
          hint="YYYY-MM-DD；不确定就留空"
        />
        <TextField
          label="封面图 URL"
          value={draft.coverUrl}
          onValueChange={(value) => setDraft({ ...draft, coverUrl: value })}
          hint="网络图片地址，可以留空"
        />
        <TextField
          label="标签"
          value={draft.tagsRaw}
          onValueChange={(value) => setDraft({ ...draft, tagsRaw: value })}
          hint="多个标签用逗号或顿号分开"
        />

        <SelectField label="位置" value={draft.locationId} options={locationOptions} onValueChange={(value) => setDraft({ ...draft, locationId: value })} />
        <ChoiceGroup
          label="品相"
          value={draft.condition}
          options={CONDITION_OPTIONS}
          onChange={(value) => setDraft({ ...draft, condition: value })}
        />
        <TextField
          label="所有者"
          value={draft.owner}
          onValueChange={(value) => setDraft({ ...draft, owner: value })}
          hint="朋友合库时用来区分「我的」「老张的」，可以留空"
        />
        <TextAreaField label="备注" value={draft.note} onValueChange={(value) => setDraft({ ...draft, note: value })} hint="可以留空" />
        <TextField
          label="副本数量"
          type="number"
          min={1}
          max={MAX_INITIAL_COUNT}
          value={countRaw}
          onValueChange={setCountRaw}
          hint={`同一本书有几本就填几，最多 ${MAX_INITIAL_COUNT} 本`}
        />

        {(formError ?? action.error) !== null && <InlineError>{formError ?? action.error}</InlineError>}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => submit()} disabled={action.pending}>
            {action.pending ? '保存中…' : '保存'}
          </Button>
        </div>
      </Card>

      {/* ---------------- 批量导入（05 §2） ---------------- */}
      <Card className="space-y-3 p-4">
        <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">批量导入书目</h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-300">
          把一整份书单一次导入。只建书目不建副本（副本是实物，之后在详情页加）；重复的书自动跳过。
        </p>
        <TextAreaField
          label="粘贴书单"
          value={pasteText}
          onValueChange={setPasteText}
          rows={6}
          hint="每行一本：书名 ／ 书名，作者 ／ 书名，作者，ISBN ／ 纯 ISBN"
          placeholder={'活着，余华\n三体，刘慈欣\n9787108061690'}
        />
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={runPasteImport} disabled={bulkAction.pending || pasteText.trim() === ''}>
            {bulkAction.pending ? '导入中…' : '导入粘贴的书单'}
          </Button>
          <Button onClick={runCsvImport} disabled={bulkAction.pending}>
            从 CSV 文件导入…
          </Button>
          {csvName !== null && <span className="self-center text-xs text-neutral-500 dark:text-neutral-400">已导入：{csvName}</span>}
        </div>
        {bulkAction.error !== null && <InlineError>{bulkAction.error}</InlineError>}
        {bulkReport !== null && (
          <div className="space-y-2 border-t border-neutral-200 pt-3 dark:border-neutral-800">
            <p className="text-sm text-neutral-800 dark:text-neutral-200">
              ✅ 新建 {bulkReport.created} 本
              {bulkReport.skipped.length > 0 && <span className="text-neutral-500 dark:text-neutral-400"> · ⏭ 跳过 {bulkReport.skipped.length} 条</span>}
              {bulkReport.suspected.length > 0 && <span className="text-amber-700 dark:text-amber-300"> · ⚠ 疑似重复 {bulkReport.suspected.length} 条</span>}
            </p>
            {bulkReport.skipped.length > 0 && (
              <ul className="list-disc space-y-1 pl-5 text-xs text-neutral-500 dark:text-neutral-400">
                {bulkReport.skipped.map((item) => (
                  <li key={`${item.line}-${item.reason}`}>
                    {item.line > 0 ? `第 ${item.line} 行：` : ''}
                    {item.reason}
                  </li>
                ))}
              </ul>
            )}
            {bulkReport.suspected.length > 0 && (
              <p className="text-xs text-amber-700 dark:text-amber-300">
                疑似重复（已创建）：{bulkReport.suspected.map((item) => `第 ${item.line} 行《${item.title}》`).join('、')}——如果其实是同一本书，去详情页合并副本即可。
              </p>
            )}
            {bulkReport.created > 0 && (
              <Button variant="ghost" onClick={() => navigate('/search')}>
                去搜索页看看 →
              </Button>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
