/**
 * 备份与设置页（04 §1 `/settings`）：导出 / 导入（预览 → 执行）/ 数据体检 / 偏好 / 清空数据。
 *
 * 几条边界写清楚（都来自设计文档）：
 * - 导入必须先预览、后执行；预览与执行的模式不一致时执行按钮不可用（write.ts 的
 *   `previewMatchesChoice`），`replace` 还要二次确认，文案带现有数量与将写入数量（04 §6）。
 * - 破坏性操作（替换导入、清空数据）的确认文案里的数量全部来自真实查询（`getLibraryCounts`），
 *   不猜（04 §6）。
 * - 数据层只产出字符串，写文件走 `platform/files.ts`（01 §3.2 边界）。
 * - 主题是值域封闭的选择（04 §5），借期/设备名的校验走 `features/settings/write.ts`。
 * - 「自动快照保留份数」不在本页：自动快照尚未实现（阶段 E/G/H），放一个拧了没反应的
 *   旋钮只会骗用户；等快照落地时与它一起加。
 */

import { useState, type ReactNode } from 'react';

import { useDb } from '../../app/db-context.ts';
import {
  IMPORT_MODE_LABELS,
  THEME_LABELS,
  describeLastExport,
  importSummaryRows,
} from '../../app/labels.ts';
import { SkeletonBlock } from '../../app/Skeleton.tsx';
import {
  Banner,
  Button,
  Card,
  ChoiceGroup,
  ConfirmDialog,
  InlineError,
  PageHeader,
  TextField,
  type ChoiceOption,
} from '../../app/ui.tsx';
import { useAsyncAction, useLiveQuery } from '../../app/useLiveQuery.ts';
import { useTheme } from '../../app/useTheme.ts';
import { backupFileName, exportToJson, markExported } from '../../backup/export.ts';
import type { ImportMode, ImportSummary } from '../../backup/format.ts';
import { importFromText } from '../../backup/import.ts';
import { checkInvariants, repairInvariants } from '../../db/repair.ts';
import { SETTING_KEYS, getSetting, setSetting } from '../../db/settings.ts';
import { getLibraryCounts, type LibraryCounts } from '../../db/stats.ts';
import { downloadText, pickTextFile } from '../../platform/files.ts';
import { AiSection } from './AiSection.tsx';
import { BorrowerSection } from './BorrowerSection.tsx';
import { ClearDataSection } from './ClearDataSection.tsx';
import { SnapshotSection } from './SnapshotSection.tsx';
import { THEMES } from '../../platform/theme.ts';
import {
  describeRepairReport,
  describeReplaceImport,
  parseLoanPeriodDays,
  previewMatchesChoice,
  validateDeviceName,
  type ReportRow,
} from './write.ts';

const IMPORT_MODES: readonly ImportMode[] = ['merge', 'replace'];

const IMPORT_MODE_OPTIONS: readonly ChoiceOption<ImportMode>[] = IMPORT_MODES.map((value) => ({
  value,
  label: IMPORT_MODE_LABELS[value],
}));

const THEME_OPTIONS: readonly ChoiceOption<(typeof THEMES)[number]>[] = THEMES.map((value) => ({
  value,
  label: THEME_LABELS[value],
}));

/** 预览摘要的行式渲染（共用 labels.ts 的口径）。 */
function SummaryCard({ summary, title }: { summary: ImportSummary; title: string }): ReactNode {
  return (
    <Card className="space-y-2 p-3">
      <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{title}</p>
      <dl className="space-y-1 text-sm text-neutral-700 dark:text-neutral-300">
        {importSummaryRows(summary).map((row) => (
          <div key={row.label} className="flex justify-between gap-3">
            <dt className="shrink-0 text-neutral-500 dark:text-neutral-400">{row.label}</dt>
            <dd className="text-right">{row.value}</dd>
          </div>
        ))}
      </dl>
      {summary.warnings.length > 0 && (
        <div className="space-y-1 border-t border-neutral-200 pt-2 dark:border-neutral-800">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">警告（{summary.warnings.length} 条）</p>
          <ul className="list-disc space-y-1 pl-5 text-xs text-amber-700 dark:text-amber-300">
            {summary.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

export function SettingsPage(): ReactNode {
  const db = useDb();
  const { theme, setTheme } = useTheme();

  // null = 第一份结果还没到；确认文案只在拿到真实数量后才可用
  const counts = useLiveQuery<LibraryCounts | null>(async () => getLibraryCounts(db), [db], null);
  const lastExportAt = useLiveQuery<string>(async () => getSetting<string>(db, SETTING_KEYS.lastExportAt, ''), [db], '');
  const prefs = useLiveQuery<{ loanPeriodDays: number; deviceName: string }>(
    async () => ({
      loanPeriodDays: await getSetting<number>(db, SETTING_KEYS.loanPeriodDays, 30),
      deviceName: await getSetting<string>(db, SETTING_KEYS.deviceName, ''),
    }),
    [db],
    { loanPeriodDays: 30, deviceName: '' },
  );

  /* ---------------- 导出 ---------------- */

  const exportAction = useAsyncAction();

  function doExport(): void {
    void exportAction.run(async () => {
      const json = await exportToJson(db);
      downloadText(backupFileName(), json);
      await markExported(db);
    });
  }

  /* ---------------- 导入 ---------------- */

  const importAction = useAsyncAction();
  const [picked, setPicked] = useState<{ name: string; text: string } | null>(null);
  const [importMode, setImportMode] = useState<ImportMode>('merge');
  const [preview, setPreview] = useState<ImportSummary | null>(null);
  const [applied, setApplied] = useState<ImportSummary | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [replaceOpen, setReplaceOpen] = useState(false);

  function pickBackup(): void {
    void importAction.run(async () => {
      const file = await pickTextFile();
      if (file !== null) {
        setPicked(file);
        setPreview(null);
        setApplied(null);
        setImportError(null);
      }
    });
  }

  function doPreview(): void {
    if (picked === null) return;
    void importAction.run(async () => {
      const result = await importFromText(db, picked.text, { mode: importMode, dryRun: true });
      if (!result.ok) {
        setImportError(result.error);
        setPreview(null);
        return;
      }
      setImportError(null);
      setPreview(result.summary);
    });
  }

  function requestApply(): void {
    if (picked === null || preview === null) return;
    if (importMode === 'replace') {
      setReplaceOpen(true);
      return;
    }
    void applyImport();
  }

  function applyImport(): void {
    if (picked === null) return;
    void importAction.run(async () => {
      const result = await importFromText(db, picked.text, { mode: importMode });
      if (!result.ok) {
        // 解析失败：关掉确认框，让页面上的错误条可见（对话框里的 error 槽只接抛出的异常）
        setReplaceOpen(false);
        setImportError(result.error);
        return;
      }
      setImportError(null);
      setApplied(result.summary);
      setPreview(null);
      setReplaceOpen(false);
    });
  }

  const canApply = previewMatchesChoice(preview, importMode) && picked !== null;
  const replaceMessage =
    preview !== null && counts !== null ? describeReplaceImport(counts, preview) : null;

  /* ---------------- 数据体检 ---------------- */

  const repairAction = useAsyncAction();
  const [checkResult, setCheckResult] = useState<{ ok: boolean; problems: string[] } | null>(null);
  const [repairRows, setRepairRows] = useState<ReportRow[] | null>(null);
  const [repairWarnings, setRepairWarnings] = useState<string[]>([]);

  function doCheck(): void {
    void repairAction.run(async () => {
      const result = await checkInvariants(db);
      setCheckResult(result);
      setRepairRows(null);
      setRepairWarnings([]);
    });
  }

  function doRepair(): void {
    void repairAction.run(async () => {
      const report = await repairInvariants(db);
      setRepairRows(describeRepairReport(report));
      setRepairWarnings(report.warnings);
      setCheckResult(null);
    });
  }

  /* ---------------- 偏好 ---------------- */

  const prefsAction = useAsyncAction();
  // null = 没在编辑，输入框显示已存的值；保存成功后置回 null，liveQuery 会把新值带回来
  const [periodDraft, setPeriodDraft] = useState<string | null>(null);
  const [periodError, setPeriodError] = useState<string | null>(null);
  const [deviceDraft, setDeviceDraft] = useState<string | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);

  function saveLoanPeriod(): void {
    if (periodDraft === null) return;
    const parsed = parseLoanPeriodDays(periodDraft);
    if (!parsed.ok) {
      setPeriodError(parsed.error);
      return;
    }
    setPeriodError(null);
    void prefsAction.run(async () => {
      await setSetting(db, SETTING_KEYS.loanPeriodDays, parsed.value);
      setPeriodDraft(null);
    });
  }

  function saveDeviceName(): void {
    if (deviceDraft === null) return;
    const problem = validateDeviceName(deviceDraft);
    if (problem !== null) {
      setDeviceError(problem);
      return;
    }
    setDeviceError(null);
    void prefsAction.run(async () => {
      await setSetting(db, SETTING_KEYS.deviceName, deviceDraft.trim());
      setDeviceDraft(null);
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader title="备份与设置" description="导出备份、从备份恢复、检查数据与调整偏好。" />

      <section className="grid gap-4 lg:grid-cols-2">
        {/* ---------------- 导出 ---------------- */}
        <Card className="space-y-3 p-4">
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">导出备份</h2>
          {counts === null ? (
            // 统计首屏骨架（04 §11.9 第 3 条）：三行文字占位，数字到位就地填上
            <div className="space-y-2" role="status" aria-busy="true" aria-live="polite">
              <span className="sr-only">正在统计…</span>
              <SkeletonBlock className="h-4 w-3/4" />
              <SkeletonBlock className="h-4 w-full" />
              <SkeletonBlock className="h-4 w-1/3" />
            </div>
          ) : (
            <>
              <p className="text-sm text-neutral-600 dark:text-neutral-300">
                当前有 {counts.books} 条书目、{counts.copies} 本副本、{counts.locations} 个位置、
                {counts.loans} 条借出记录。上次导出：{describeLastExport(lastExportAt)}。
              </p>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                导出的 JSON 文件包含全部数据，可用于换设备或恢复误删。
              </p>
              {exportAction.error !== null && <InlineError>{exportAction.error}</InlineError>}
              <Button variant="primary" onClick={doExport} disabled={exportAction.pending}>
                {exportAction.pending ? '导出中…' : '导出到文件'}
              </Button>
            </>
          )}
        </Card>

        {/* ---------------- 数据体检 ---------------- */}
        <Card className="space-y-3 p-4">
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">数据体检</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-300">
            检查位置层级、副本归属、借出状态等一致性；发现的问题可以自动修复。应用每次启动也会自动修一遍。
          </p>
          {repairAction.error !== null && <InlineError>{repairAction.error}</InlineError>}
          <div className="flex flex-wrap gap-2">
            <Button onClick={doCheck} disabled={repairAction.pending}>
              {repairAction.pending ? '检查中…' : '检查数据'}
            </Button>
            <Button onClick={doRepair} disabled={repairAction.pending}>
              {repairAction.pending ? '修复中…' : '自动修复'}
            </Button>
          </div>
          {checkResult !== null &&
            (checkResult.ok ? (
              <Banner tone="green">数据一致，没有发现问题。</Banner>
            ) : (
              <div className="space-y-1">
                <Banner tone="amber">发现 {checkResult.problems.length} 个问题：</Banner>
                <ul className="list-disc space-y-1 pl-5 text-sm text-amber-800 dark:text-amber-200">
                  {checkResult.problems.map((problem, index) => (
                    <li key={index}>{problem}</li>
                  ))}
                </ul>
              </div>
            ))}
          {repairRows !== null && (
            <Card className="space-y-1 p-3">
              {repairRows.map((row) => (
                <div key={row.label} className="flex justify-between gap-3 text-sm">
                  <span className="text-neutral-500 dark:text-neutral-400">{row.label}</span>
                  <span className="text-neutral-800 dark:text-neutral-200">{row.value}</span>
                </div>
              ))}
            </Card>
          )}
          {repairWarnings.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-xs text-amber-700 dark:text-amber-300">
              {repairWarnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      {/* ---------------- 导入 ---------------- */}
      <Card className="space-y-3 p-4">
        <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">从备份导入</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={pickBackup} disabled={importAction.pending}>
            选择备份文件
          </Button>
          {picked !== null && (
            <span className="text-sm text-neutral-600 dark:text-neutral-300">已选中：{picked.name}</span>
          )}
        </div>

        {picked !== null && (
          <>
            <ChoiceGroup
              label="导入方式"
              value={importMode}
              options={IMPORT_MODE_OPTIONS}
              onChange={(mode) => {
                setImportMode(mode);
                setImportError(null);
              }}
            />
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={doPreview} disabled={importAction.pending}>
                {importAction.pending ? '预览中…' : '预览'}
              </Button>
              <Button onClick={requestApply} disabled={!canApply || importAction.pending}>
                执行导入
              </Button>
            </div>
            {preview !== null && (
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                预览已按「{IMPORT_MODE_LABELS[preview.mode]}」跑过一遍，数据库没有变化。改过导入方式后需要重新预览。
              </p>
            )}
            {importError !== null && <InlineError>{importError}</InlineError>}
            {preview !== null && <SummaryCard summary={preview} title="预览结果" />}
            {applied !== null && (
              <Banner tone="green">
                已导入：{applied.books.inserted + applied.books.updated + applied.books.mergedByIsbn} 条书目、
                {applied.copies.inserted + applied.copies.updated} 本副本、{applied.locations.inserted + applied.locations.updated}{' '}
                个位置。
              </Banner>
            )}
            {applied !== null && <SummaryCard summary={applied} title="本次导入明细" />}
          </>
        )}
      </Card>

      {/* ---------------- 快照（04 §11.4） ---------------- */}
      <SnapshotSection />

      {/* ---------------- 偏好 ---------------- */}
      <Card className="space-y-4 p-4">
        <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">偏好</h2>
        <ChoiceGroup label="界面主题" value={theme} options={THEME_OPTIONS} onChange={(next) => void setTheme(next)} />
        <div className="flex flex-wrap items-end gap-2">
          <TextField
            label="默认借期（天）"
            type="number"
            min={1}
            value={periodDraft ?? String(prefs.loanPeriodDays)}
            onValueChange={(value) => {
              setPeriodDraft(value);
              setPeriodError(null);
            }}
            hint="借出时按这个天数自动算应还日期"
            error={periodError}
            className="w-40"
          />
          <Button onClick={saveLoanPeriod} disabled={periodDraft === null || prefsAction.pending}>
            保存
          </Button>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <TextField
            label="设备名"
            value={deviceDraft ?? prefs.deviceName}
            onValueChange={(value) => {
              setDeviceDraft(value);
              setDeviceError(null);
            }}
            hint="只写进备份文件，用来辨认这份备份来自哪台设备；可以留空"
            error={deviceError}
            className="w-64"
          />
          <Button onClick={saveDeviceName} disabled={deviceDraft === null || prefsAction.pending}>
            保存
          </Button>
        </div>
        {prefsAction.error !== null && <InlineError>{prefsAction.error}</InlineError>}
      </Card>

      {/* ---------------- 借书人（04 §11.3） ---------------- */}
      <BorrowerSection />

      {/* ---------------- AI 配置（05 §3、04 §11.17） ---------------- */}
      <AiSection />

      {/* ---------------- 清空数据（04 §6） ---------------- */}
      <ClearDataSection counts={counts} />

      <ConfirmDialog
        open={replaceOpen}
        title="确认替换导入"
        confirmLabel="替换导入"
        pending={importAction.pending}
        error={importAction.error}
        message={<p>{replaceMessage ?? ''}</p>}
        onCancel={() => setReplaceOpen(false)}
        onConfirm={() => void applyImport()}
      />
    </div>
  );
}
