/**
 * 扫码取景器弹层（04 §11.12「形态」）：复用 Modal / Button / InlineError / Banner 基元，不新增路由。
 * 「连续录入」开关也在弹层里（04 §11.14.B）—— **不新增第 4 个动作按钮**：弹层打开时
 * 正是「要连录一批」的念头最强烈的时候。
 *
 * 分工：**判定在 isbn-scan.ts、摄像头在 platform/scan.ts、跳过与累计的纯逻辑在
 * continuous-scan.ts，这里只管交互、建书循环与生命周期**。
 * 库要的是元素 id 字符串，所以用 useId() 生成一个稳定的 id 挂在取景器容器上。
 *
 * 生命周期（04 §11.12）：识别成功、关弹层、路由离开，三条路都必须释放摄像头 ——
 * 这里用同一个 `stop()` 收口：成功时主动释放一次，弹层关闭 / 组件卸载时由 effect 清理再释放
 * （释放是幂等的，重复调用安全）。不释放的代价是手机摄像头指示灯常亮、后面再开还开不起来。
 *
 * 两种收口：
 * - 常态：扫到合法 ISBN 就关弹层、把 ISBN 交回表单（04 §11.12「填表但不建书」）；
 * - 连录：弹层不关，扫一本建一本；关弹层时把这一批交给调用方去提示「本次共录入 N 本」。
 *   连录的每一步都可能「跳过」（库里已有 / 需要确认 / 建书失败），跳过一律只提示，
 *   **绝不弹「合并 / 仍然新建」打断节奏**（04 §11.14.B）。
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { useDb } from '../../app/db-context.ts';
import { bookDisplayTitle } from '../../app/labels.ts';
import { Banner, Button, InlineError, Modal } from '../../app/ui.tsx';
import { findBooksByIsbn, getBook, updateBook } from '../../db/books.ts';
import { completeChat, isAiConfigured, type AiConfig } from '../../platform/ai.ts';
import { startScan, type ScanSession } from '../../platform/scan.ts';
import { AI_SYSTEM_PROMPT, buildAiUserPrompt, parseAiResponse } from './ai.ts';
import {
  CONTINUOUS_NOTICE,
  aiFailureNotice,
  aiPatchForBook,
  continuousProgress,
  scanDraft,
  skipExistingNotice,
  skipFailedNotice,
  skipNeedsConfirmNotice,
  withAiTitle,
  type ContinuousEntry,
  type ContinuousSeed,
} from './continuous-scan.ts';
import { isbnFromBarcode } from './isbn-scan.ts';
import { submitBook } from './write.ts';

type ScanStatus = 'loading' | 'scanning' | 'error';

export interface ScanDialogProps {
  open: boolean;
  /** 用户关弹层（背板 / × / Escape / 底部按钮）—— 释放摄像头由本组件负责 */
  onClose: () => void;
  /** 扫到合法 ISBN：调用方负责写进表单并关弹层（04 §11.12「填表但不建书」） */
  onDetected: (isbn13: string) => void;
  /** 连录用的种子：位置/品相/标签取表单当前值（04 §11.14.B 第 3 步） */
  continuousSeed: ContinuousSeed;
  /** AI 配置由调用方订阅（动作行也要用），这里不再单独订阅一遍 settings */
  aiConfig: AiConfig;
  /** 关弹层时上报这一批 —— 调用方据此提示「本次共录入 N 本」（04 §11.14.B） */
  onContinuousFinish: (entries: readonly ContinuousEntry[]) => void;
}

export function ScanDialog({
  open,
  onClose,
  onDetected,
  continuousSeed,
  aiConfig,
  onContinuousFinish,
}: ScanDialogProps): ReactNode {
  const db = useDb();
  // useId 出来的 id 只给 document.getElementById 用（库不拼选择器），加前缀便于在 devtools 里认出来
  const elementId = `isbn-scan-${useId()}`;
  const [status, setStatus] = useState<ScanStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  // 认出来了但不是图书（977 期刊 / 乱码）：提示一句，继续扫，不关弹层、不填表
  const [notice, setNotice] = useState<string | null>(null);
  // 连录（04 §11.14.B）：默认关，每次打开都回到关 —— 「默认关」的字面口径
  const [continuous, setContinuous] = useState(false);
  const [entries, setEntries] = useState<ContinuousEntry[]>([]);
  const [aiFailures, setAiFailures] = useState(0);
  // 正在建这一本（本地写，几十毫秒）：按钮给等待态，关弹层也等它落地再上报，免得累计少报一本
  const [busy, setBusy] = useState(false);

  // 回调放 ref：库长期持有它，而 props 每次渲染都是新函数 —— 放进依赖会让摄像头反复重启
  const handlersRef = useRef({ onDetected, onClose, continuousSeed, aiConfig });
  handlersRef.current = { onDetected, onClose, continuousSeed, aiConfig };
  // 连录开关同样要进 ref：扫码回调活在 effect 的闭包里，读不到最新的 state
  const continuousRef = useRef(continuous);
  continuousRef.current = continuous;

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    let session: ScanSession | null = null;
    // 一次扫描只认第一次结果：停之前库可能连着给几帧同样的条码
    let accepted = false;
    // 连录的两个守卫：建书还没落地时忽略新帧；刚录过的条码还在画面里时不重复建
    let building = false;
    let lastIsbn = '';
    // AI 逐本串行排队（04 §11.14.B）：上一本没回来之前不发起下一本，避免并发写库与竞态
    let aiQueue: Promise<void> = Promise.resolve();

    setStatus('loading');
    setError(null);
    setNotice(null);
    setContinuous(false);
    setEntries([]);
    setAiFailures(0);

    /** 第 5 步的后半段：按 bookId 补全刚建的那一条，仍然只填空字段（05 §3.3 口径不变）。 */
    async function completeOne(entry: ContinuousEntry): Promise<void> {
      const config = handlersRef.current.aiConfig;
      if (!isAiConfigured(config)) return;
      try {
        const text = await completeChat(config, AI_SYSTEM_PROMPT, buildAiUserPrompt({ title: '', isbn: entry.isbn }));
        const parsed = parseAiResponse(text);
        if (!parsed.ok) throw new Error(parsed.error);
        const book = await getBook(db, entry.bookId);
        if (book === undefined) return; // 建完又被删了：没有可补的那条
        const patch = aiPatchForBook(book, parsed.fields);
        if (Object.keys(patch).length === 0) return; // 没补到东西就不白写一次库
        await updateBook(db, entry.bookId, patch);
        setEntries((previous) => withAiTitle(previous, entry.bookId, parsed.fields));
      } catch {
        // 补全失败只提示，不阻塞扫描、也不影响累计 —— 书已经建好了，ISBN 是真的
        setAiFailures((previous) => previous + 1);
      }
    }

    /** 按 04 §11.14.B 的 5 步走：判定 → 查库 → 草稿 → 建书 → 进列表并按 bookId 补全。 */
    async function buildOne(isbn13: string): Promise<void> {
      building = true;
      setBusy(true);
      setNotice(null);
      try {
        // 第 2 步：只读查库 —— 命中就跳过，不建重复、也不加副本
        const existing = await findBooksByIsbn(db, isbn13);
        const first = existing[0];
        if (first !== undefined) {
          setNotice(skipExistingNotice(bookDisplayTitle(first)));
          return;
        }
        // 第 3、4 步：位置/品相/标签取表单当前值、副本数 1；needsIsbnConfirm 与异常都按「跳过并提示」
        const result = await submitBook(db, scanDraft(handlersRef.current.continuousSeed, isbn13));
        if (result.kind === 'needsIsbnConfirm') {
          setNotice(skipNeedsConfirmNotice(isbn13));
          return;
        }
        // 第 5 步：先进累计列表，**紧接着**（不等 AI）把这一本排进补全队列
        const entry: ContinuousEntry = { bookId: result.book.id, isbn: isbn13, title: '' };
        setEntries((previous) => [...previous, entry]);
        aiQueue = aiQueue.then(() => completeOne(entry));
      } catch (err: unknown) {
        setNotice(skipFailedNotice(err instanceof Error ? err.message : String(err)));
      } finally {
        building = false;
        setBusy(false);
      }
    }

    const onText = (text: string): void => {
      const outcome = isbnFromBarcode(text);
      if (outcome.kind === 'rejected') {
        // 977 期刊 / 乱码：提示一句接着扫（连录也一样，不打断）
        setNotice(outcome.message);
        return;
      }
      if (continuousRef.current) {
        // 同一帧里库会反复回调同一个条码：刚处理过的这条不再重复建
        if (building || outcome.isbn13 === lastIsbn) return;
        lastIsbn = outcome.isbn13;
        void buildOne(outcome.isbn13);
        return;
      }
      if (accepted) return;
      accepted = true;
      // 先释放摄像头再交结果：别让指示灯亮着等页面跳转
      void session?.stop();
      handlersRef.current.onDetected(outcome.isbn13);
      handlersRef.current.onClose();
    };

    void (async () => {
      try {
        const started = await startScan({ elementId, onDetected: onText });
        if (cancelled) {
          // 关得太快：刚起来的摄像头要立刻还回去
          await started.stop();
          return;
        }
        session = started;
        setStatus('scanning');
      } catch (err: unknown) {
        // platform/scan.ts 抛的已经是人话（权限被拒 / 没有摄像头 / 首次离线加载失败），原样展示
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setStatus('error');
        }
      }
    })();

    return () => {
      cancelled = true;
      const started = session;
      session = null;
      if (started !== null) void started.stop();
    };
  }, [open, elementId, db]);

  /** 关弹层：连录时先把这一批交给调用方（04 §11.14.B「关掉弹层 → 回新增页提示」）。 */
  function close(): void {
    if (busy) return; // 建书还在飞：等它落地，别少报一本
    if (continuous) onContinuousFinish(entries);
    onClose();
  }

  return (
    <Modal
      open={open}
      title="扫码录 ISBN"
      onClose={close}
      footer={
        <>
          <span className="mr-auto self-center text-xs text-neutral-500 dark:text-neutral-400">
            {continuous ? '同 ISBN 已在库里会跳过：不建重复，也不加副本' : '扫不到也没关系，ISBN 可以手动填'}
          </span>
          <Button variant="ghost" onClick={close} disabled={busy}>
            {continuous ? (entries.length === 0 ? '结束连录' : `结束连录（已录 ${entries.length} 本）`) : '手动填 ISBN'}
          </Button>
        </>
      }
    >
      {/* 库把 <video> 插进这个容器，宽度按容器当时宽度定死 */}
      <div id={elementId} className="min-h-40 overflow-hidden rounded-xl bg-neutral-950" />

      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        {continuous
          ? '把图书背面的条码放进取景框：只认 EAN-13 图书条码。扫到就建一本，接着扫下一本。'
          : '把图书背面的条码放进取景框：只认 EAN-13 图书条码，不扫二维码。识别到就会自动停。'}
      </p>

      <label className="flex min-h-11 items-start gap-2 text-sm text-neutral-700 dark:text-neutral-300">
        <input
          type="checkbox"
          className="mt-0.5 h-5 w-5 accent-blue-600"
          checked={continuous}
          onChange={(event) => setContinuous(event.target.checked)}
        />
        <span>连续录入：扫一本建一本（位置、品相、标签沿用表单里的值），弹层不关</span>
      </label>

      {status === 'loading' && <p className="text-sm text-neutral-600 dark:text-neutral-300">正在打开摄像头…</p>}
      {busy && <p className="text-sm text-neutral-600 dark:text-neutral-300">正在建这一本…</p>}
      {notice !== null && <Banner tone="amber">{notice}</Banner>}
      {error !== null && <InlineError>{error}</InlineError>}

      {continuous && (
        <>
          {entries.length > 0 && (
            <p className="text-sm text-neutral-700 dark:text-neutral-200">{continuousProgress(entries)}</p>
          )}
          {!isAiConfigured(aiConfig) && <Banner tone="amber">{CONTINUOUS_NOTICE.noAi}</Banner>}
          {aiFailures > 0 && <Banner tone="amber">{aiFailureNotice(aiFailures)}</Banner>}
        </>
      )}
    </Modal>
  );
}
