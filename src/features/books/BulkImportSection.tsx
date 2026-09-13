/**
 * 批量导入区（04 §11.1、05 §2）：粘贴 / 文件（CSV、Excel、Word、文本类、JSON）两入口 →
 * 预览（前 5 行 + 「第 N 列 → 字段」映射）→ 批量默认值 → 执行 → 报告。
 *
 * 自 NewBookPage 拆出：这一整块自成一条流水线（读表 → 认列 → 建书建副本），
 * 混在书目表单里会让页面读不下去。拆开后它只依赖 import.ts 与各格式解析器
 * （`import-detect.ts` / `xlsx.ts` / `docx.ts`），不与表单字段互相牵扯。
 *
 * 「先预览再写库」不是可选项（05 §2.2）：用户的书单格式五花八门，列识别错了
 * 还能在下拉里改，改完再执行 —— 免得几百条书目一次建歪，回头再删。
 * 文件按**扩展名**分派解析器（`formatOfFile`），所以一个「选择文件…」就够了。
 */

import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { useDb } from '../../app/db-context.ts';
import { COPY_CONDITION_LABELS, IMPORT_FIELD_LABELS, locationPathText } from '../../app/labels.ts';
import {
  Button,
  Card,
  ChoiceGroup,
  InlineError,
  SelectField,
  TextAreaField,
  TextField,
  type ChoiceOption,
  type SelectOption,
} from '../../app/ui.tsx';
import { useAsyncAction, useLiveQuery } from '../../app/useLiveQuery.ts';
import { listLocations } from '../../db/locations.ts';
import { COPY_CONDITIONS } from '../../domain/types.ts';
import type { CopyCondition, Location } from '../../domain/types.ts';
import { pickBinaryFile } from '../../platform/files.ts';
import { readDocxSource } from './docx.ts';
import { IMPORT_FILE_ACCEPT, formatOfFile } from './import-detect.ts';
import {
  bulkImportBooks,
  rowsFromSource,
  sourceFromCsv,
  sourceFromJson,
  sourceFromPaste,
  sourceFromText,
  type BulkImportReport,
  type ImportSource,
} from './import.ts';
import {
  IMPORT_FIELDS,
  parseCopiesCell,
  setColumnField,
  type ColumnMapping,
} from './import-mapping.ts';
import { MAX_INITIAL_COUNT } from './write.ts';
import { PREVIEW_ROWS, PreviewTable, ReportView } from './BulkImportPreview.tsx';
import { readXlsxSource } from './xlsx.ts';

const CONDITION_OPTIONS: readonly ChoiceOption<CopyCondition>[] = COPY_CONDITIONS.map((value) => ({
  value,
  label: COPY_CONDITION_LABELS[value],
}));

/** 列映射下拉的选项：空值 = 忽略此列（04 §11.1）。 */
const FIELD_OPTIONS: readonly SelectOption[] = [
  { value: '', label: '忽略此列' },
  ...IMPORT_FIELDS.map((field) => ({ value: field, label: IMPORT_FIELD_LABELS[field] })),
];

function emptyReport(reason: string): BulkImportReport {
  return { created: 0, copiesCreated: 0, skipped: [{ line: 0, reason }], suspected: [], warnings: [] };
}

/**
 * 文本类文件按 UTF-8 读（05 §2.1）：不自动探测编码 —— Excel 存出来的中文 GBK CSV
 * 会显示成乱码，用户按「选择文件…」下面那行提示另存 UTF-8 或改用 xlsx 导入即可。
 * TextDecoder 默认会剥掉 BOM。
 */
function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

/** 文件 → 导入源（05 §2.1）：按扩展名分派；`.doc` 与不认识的格式由 formatOfFile 抛人话错误。 */
async function sourceFromFile(file: { name: string; bytes: Uint8Array }): Promise<ImportSource> {
  switch (formatOfFile(file.name)) {
    case 'csv':
      return sourceFromCsv(decodeUtf8(file.bytes), file.name);
    case 'text':
      return sourceFromText(decodeUtf8(file.bytes), file.name);
    case 'json':
      return sourceFromJson(decodeUtf8(file.bytes), file.name);
    case 'xlsx':
      return readXlsxSource(file.bytes, file.name);
    case 'docx':
      return readDocxSource(file.bytes, file.name);
  }
}

export function BulkImportSection(): ReactNode {
  const db = useDb();
  const navigate = useNavigate();
  const action = useAsyncAction();
  const locations = useLiveQuery<Location[]>(async () => listLocations(db), [db], []);

  const [pasteText, setPasteText] = useState('');
  const [source, setSource] = useState<ImportSource | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [report, setReport] = useState<BulkImportReport | null>(null);
  // 批量默认值（05 §2.2 规则 3）：位置默认「未分类」、副本数默认 1、品相默认「新」
  const [defaultLocationId, setDefaultLocationId] = useState('');
  const [copiesRaw, setCopiesRaw] = useState('1');
  const [condition, setCondition] = useState<CopyCondition>('new');

  const rows = source === null ? [] : rowsFromSource(source, mapping);
  const locationOptions: SelectOption[] = [
    { value: '', label: '未分类（默认）' },
    ...locations.map((location) => ({ value: location.id, label: locationPathText(location.path) })),
  ];

  function show(next: ImportSource): void {
    if (next.rows.length === 0) {
      setSource(null);
      setMapping(null);
      setReport(emptyReport(`${next.name}里没有解析出任何书目`));
      return;
    }
    setSource(next);
    setMapping(next.mapping);
    setReport(null);
  }

  function previewFile(): void {
    void action.run(async () => {
      const file = await pickBinaryFile(IMPORT_FILE_ACCEPT);
      if (file !== null) show(await sourceFromFile(file));
    });
  }

  function runImport(): void {
    if (source === null || rows.length === 0) return;
    // 默认副本数：非法输入回退 1（05 §2.2 规则 3）；0 是合法值（只建书目）
    const copies = parseCopiesCell(copiesRaw) ?? 1;
    void action.run(async () => {
      setReport(await bulkImportBooks(db, rows, { locationId: defaultLocationId, copies, condition }));
      // 同一批只导一次：清掉预览，报告留着
      setSource(null);
      setMapping(null);
    });
  }

  return (
    <Card className="space-y-4 p-4">
      <div>
        <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">批量导入</h2>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-300">
          一次导入一整份书单：粘贴、CSV、Excel、Word、文本、JSON 都行。先预览识别结果，确认后再按下面的默认值建书目与副本；
          重复的书自动跳过（05 §2）。
        </p>
      </div>

      <TextAreaField
        label="粘贴书单"
        value={pasteText}
        onValueChange={setPasteText}
        rows={5}
        hint="每行一本：书名 ／ 书名，作者 ／ 书名，作者，ISBN ／ 纯 ISBN；从表格里复制来的（第一行是列名）也能认"
        placeholder={'活着，余华\n三体，刘慈欣\n9787108061690'}
      />
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => show(sourceFromPaste(pasteText))} disabled={action.pending || pasteText.trim() === ''}>
          预览粘贴的书单
        </Button>
        <Button onClick={previewFile} disabled={action.pending}>
          选择文件…
        </Button>
      </div>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        文件支持 CSV / Excel（.xlsx .xls）/ Word（.docx）/ 文本（.txt .md .tsv）/ JSON；
        .doc 是 Word 旧格式，请先在 Word 里另存为 .docx。
      </p>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        文件一律按 UTF-8 读（不自动猜编码）：Excel 存出来的中文 CSV 常常是 GBK，选出来是乱码的话请另存为 UTF-8，或改用 xlsx 导入。
      </p>
      {action.error !== null && <InlineError>{action.error}</InlineError>}

      {source !== null && (
        <div className="space-y-3 border-t border-neutral-200 pt-3 dark:border-neutral-800">
          <p className="text-sm text-neutral-800 dark:text-neutral-200">
            已解析 <span className="font-medium">{source.name}</span>：共 {rows.length} 行
            {rows.length > PREVIEW_ROWS && `（只预览前 ${PREVIEW_ROWS} 行）`}
          </p>

          {mapping === null ? (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              没有表头：按「书名 ／ 作者 ／ ISBN」位置推定解析。想按列指定，就在第一行写上列名。
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {mapping.map((_current, index) => (
                <SelectField
                  key={index}
                  label={`第 ${index + 1} 列${source.header?.[index] === undefined ? '' : `『${source.header[index]}』`}`}
                  value={mapping[index] ?? ''}
                  options={FIELD_OPTIONS}
                  onValueChange={(value) =>
                    setMapping(setColumnField(mapping, index, IMPORT_FIELDS.find((item) => item === value) ?? null))
                  }
                />
              ))}
            </div>
          )}

          <PreviewTable rows={rows} mapping={mapping} />

          <div className="grid gap-3 border-t border-neutral-200 pt-3 sm:grid-cols-2 dark:border-neutral-800">
            <SelectField
              label="默认位置"
              value={defaultLocationId}
              options={locationOptions}
              onValueChange={setDefaultLocationId}
              hint="行里写了位置就按行的；库里没有的位置名会自动新建为顶层位置"
            />
            <TextField
              label="默认副本数"
              type="number"
              min={0}
              max={MAX_INITIAL_COUNT}
              value={copiesRaw}
              onValueChange={setCopiesRaw}
              hint={`行里写了副本数就按行的；填 0 = 只建书目不建副本（上限 ${MAX_INITIAL_COUNT}）`}
            />
          </div>
          <ChoiceGroup label="默认品相" value={condition} options={CONDITION_OPTIONS} onChange={setCondition} />

          <Button variant="primary" onClick={runImport} disabled={action.pending || rows.length === 0}>
            {action.pending ? '导入中…' : `确认导入 ${rows.length} 行`}
          </Button>
        </div>
      )}

      {report !== null && (
        <ReportView report={report} onBrowse={() => navigate('/search')} />
      )}
    </Card>
  );
}

