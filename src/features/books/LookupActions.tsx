/**
 * 动作行（04 §11.13 第 1 项）：`📷 扫码` `🖼 拍照识别` `✦ AI 补全` + 隐藏解码容器 + 提示横幅。
 *
 * 从 IsbnField 整块迁出并升到默认层（01 §5.6、04 §11.13）：**按钮是动作，不跟着 ISBN 收进折叠区**
 * —— ISBN 是扫码 / 照片 / AI 填进去的，而按钮藏起来会让每录一本都多一次展开（正是要消除的成本）。
 *
 * 两条识别路径共用**同一套扫后链路**（04 §11.12 与 D2）：判定 `isbnFromBarcode` → 填 ISBN →
 * 只读查库（`findBooksByIsbn`）→ 已有则提示、没有则按配置跑一次 AI 补全。判定不关心文本来源。
 *
 * 照片识别全程不联网：解码在 `platform/scan.ts` 里用库的本地 canvas 完成，**不上传任何文件**。
 */

import { useId, useRef, useState, type ReactNode } from 'react';

import { useDb } from '../../app/db-context.ts';
import { bookDisplayTitle, type Tone } from '../../app/labels.ts';
import { Banner, Button } from '../../app/ui.tsx';
import { useLiveQuery } from '../../app/useLiveQuery.ts';
import { findBooksByIsbn } from '../../db/books.ts';
import { SETTING_KEYS, getSetting } from '../../db/settings.ts';
import { completeChat, isAiConfigured, type AiConfig } from '../../platform/ai.ts';
import { canScan, probeHost } from '../../platform/capabilities.ts';
import { scanImageFile } from '../../platform/scan.ts';
import { AI_SYSTEM_PROMPT, buildAiUserPrompt, mergeAiFields, parseAiResponse } from './ai.ts';
import { finishNotice, seedFromDraft, type ContinuousEntry } from './continuous-scan.ts';
import { isbnFromBarcode } from './isbn-scan.ts';
import { ScanDialog } from './ScanDialog.tsx';
import type { BookDraft } from './write.ts';

/** AI 默认配置：与设置页的占位一致（05 §3.1）。 */
const AI_DEFAULTS: AiConfig = { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' };

/** 与 setState 同形：异步结果（AI 回复）要基于**最新**草稿合并，不能读渲染那一刻的旧值。 */
export type DraftUpdater = (next: BookDraft | ((previous: BookDraft) => BookDraft)) => void;

export interface LookupNotice {
  tone: Tone;
  text: string;
}

export interface LookupActionsProps {
  draft: BookDraft;
  updateDraft: DraftUpdater;
  /** 保存进行中：三个动作按钮一并禁用（04 §11.12「进行中与禁用」） */
  disabled?: boolean;
  /**
   * 提示状态放在页面里：ISBN 输入框在折叠区（MoreFields），改 ISBN 时要把这里的提示清掉
   * （04 §11.12：提示描述的是刚扫到的那个 ISBN，值一改就不该再挂着）。
   */
  notice: LookupNotice | null;
  onNotice: (notice: LookupNotice | null) => void;
}

export function LookupActions({
  draft,
  updateDraft,
  disabled = false,
  notice,
  onNotice,
}: LookupActionsProps): ReactNode {
  const db = useDb();
  const [scanOpen, setScanOpen] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);
  // 库要一个**存在的容器 id**（缺元素会同步抛），照片解码画布就插在这只隐藏 div 里（04 §11.12 D2）
  const decodeElementId = `isbn-photo-${useId()}`;

  const aiConfig = useLiveQuery<AiConfig>(
    async () => ({
      baseUrl: await getSetting<string>(db, SETTING_KEYS.aiBaseUrl, AI_DEFAULTS.baseUrl),
      apiKey: await getSetting<string>(db, SETTING_KEYS.aiApiKey, AI_DEFAULTS.apiKey),
      model: await getSetting<string>(db, SETTING_KEYS.aiModel, AI_DEFAULTS.model),
    }),
    [db],
    AI_DEFAULTS,
  );
  const aiConfigured = isAiConfigured(aiConfig);

  /* ---------------- AI 补全（05 §3.3 入口 ①、04 §11.12 扫后自动跑一次） ---------------- */

  /**
   * 补全一次。**入参显式给**：扫码刚写进字段的那一刻，渲染闭包里的 draft 还是旧值，
   * 从 state 里读 ISBN 会拿着空串去问 AI（扫后自动补全正是踩这个坑的地方）。
   */
  async function runAiComplete(input: { title: string; isbn: string }): Promise<void> {
    if (input.title.trim() === '' && input.isbn.trim() === '') return;
    setAiBusy(true);
    onNotice(null);
    try {
      const text = await completeChat(aiConfig, AI_SYSTEM_PROMPT, buildAiUserPrompt(input));
      const parsed = parseAiResponse(text);
      if (!parsed.ok) {
        onNotice({ tone: 'red', text: parsed.error });
        return;
      }
      // updater 形式：AI 往返这段时间用户可能又填了字段，拿旧草稿合并会把新填的覆盖回去
      updateDraft((previous) => mergeAiFields(previous, parsed.fields));
      onNotice({ tone: 'green', text: '已补全，请核对后保存——你已经填过的字段不会被覆盖。' });
    } catch (error: unknown) {
      onNotice({ tone: 'red', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setAiBusy(false);
    }
  }

  /* ---------------- 扫后链路（04 §11.12：扫码与照片识别共用这一条） ---------------- */

  function handleDetected(isbn13: string): void {
    // 只写字段：不自动保存、不建书（04 §11.12「填表但不建书」）
    updateDraft((previous) => ({ ...previous, isbn: isbn13 }));
    onNotice(null);
    void (async () => {
      const existing = await findBooksByIsbn(db, isbn13);
      const first = existing[0];
      if (first !== undefined) {
        // 已有：不跑自动补全，只提示（保存时仍走既有的合并 / 仍然新建分支）
        onNotice({
          tone: 'amber',
          text: `库里已经有同 ISBN 的书目《${bookDisplayTitle(first)}》：保存时会让你选「合并到已有书目」还是「仍然新建」，这里就不再问 AI 了。`,
        });
        return;
      }
      if (!aiConfigured) {
        // 未配置 AI：ISBN 已填好，其余手填（04 §11.12：两种情况 ISBN 都已填好）
        onNotice({
          tone: 'amber',
          text: 'ISBN 已填好。书名、作者可以手动补；在「备份与设置 → AI 元数据补全」配置后，扫码就能自动补全。',
        });
        return;
      }
      // 书名取当前草稿的（扫码期间用户敲不了字），ISBN 用刚扫到的这个
      await runAiComplete({ title: draft.title, isbn: isbn13 });
    })();
  }

  /* ---------------- 拍照识别（04 §11.12 D2） ---------------- */

  function handlePhoto(file: File): void {
    setPhotoBusy(true);
    onNotice(null);
    void (async () => {
      try {
        const text = await scanImageFile({ elementId: decodeElementId, file });
        const outcome = isbnFromBarcode(text);
        if (outcome.kind === 'rejected') {
          // 977 期刊等：复用实时扫码的既有提示（04 §11.12 D2 失败态表第三行）
          onNotice({ tone: 'amber', text: outcome.message });
          return;
        }
        handleDetected(outcome.isbn13);
      } catch (error: unknown) {
        // platform/scan.ts 抛的已经是人话（图里没条码 / 图打不开），原样展示
        onNotice({ tone: 'red', text: error instanceof Error ? error.message : String(error) });
      } finally {
        setPhotoBusy(false);
      }
    })();
  }

  /** 连录结束：回新增页提示「本次共录入 N 本」；一本没录（进来看看就关了）则不吭声。 */
  function handleContinuousFinish(entries: readonly ContinuousEntry[]): void {
    const text = finishNotice(entries, aiConfigured);
    if (text !== null) onNotice({ tone: 'green', text });
  }

  const canScanHere = canScan(probeHost());
  const locked = disabled === true || aiBusy || photoBusy;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {/* 桌面端不承诺扫码（01 §1.1 第 2 条）：按钮按能力探测显示，不是按 UA 判断 */}
        {canScanHere && (
          <Button
            onClick={() => {
              onNotice(null);
              setScanOpen(true);
            }}
            disabled={locked}
          >
            📷 扫码
          </Button>
        )}
        {/* 桌面唯一可用的识别入口（04 §11.12 D2）：不按能力探测隐藏 */}
        <Button onClick={() => photoInputRef.current?.click()} disabled={locked}>
          {photoBusy ? '🖼 识别中…' : '🖼 拍照识别'}
        </Button>
        <Button
          onClick={() => void runAiComplete({ title: draft.title, isbn: draft.isbn })}
          disabled={locked || !aiConfigured || (draft.title.trim() === '' && draft.isbn.trim() === '')}
        >
          {aiBusy ? 'AI 补全中…' : '✦ AI 补全'}
        </Button>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          {aiConfigured
            ? '按书名或 ISBN 自动补作者、出版社等信息；只填空着的字段'
            : '在「备份与设置 → AI 元数据补全」配置后可用（OpenAI 兼容接口）'}
        </span>
      </div>

      {notice !== null && <Banner tone={notice.tone}>{notice.text}</Banner>}

      {/* 取图：**不加 capture**（04 §11.12 D2）—— 加了会强制打开相机、吃掉「相册」选项。
          真正可点的按钮在上面，所以这个 input 不进 Tab 序列、也不被读屏单独念一遍 */}
      <input
        ref={photoInputRef}
        type="file"
        accept="image/*"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // 清空 value：同一张照片再选一次也要能触发 change
          event.target.value = '';
          if (file !== undefined) handlePhoto(file);
        }}
      />
      {/* 库的解码画布落在这只隐藏 div 里：宽度为 0 时库回退默认宽度，解码画布仍按原图尺寸建 */}
      <div id={decodeElementId} className="hidden" aria-hidden="true" />

      <ScanDialog
        open={scanOpen}
        onClose={() => setScanOpen(false)}
        onDetected={handleDetected}
        continuousSeed={seedFromDraft(draft)}
        aiConfig={aiConfig}
        onContinuousFinish={handleContinuousFinish}
      />
    </div>
  );
}
