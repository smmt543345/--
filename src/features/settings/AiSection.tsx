/**
 * AI 元数据补全配置区（05 §3、04 §11.17）。
 *
 * 从 SettingsPage 整块迁出（01 §5.8）：那一页长期在 500 行硬上限之上，而这一区自带
 * 四个草稿态、两个动作与一个测试流程，是其中最大的一块独立逻辑 —— 与 BorrowerSection /
 * SnapshotSection 同一做法。
 *
 * 预设按钮（04 §11.17）只做一件事：把「接口地址 + 模型名」按服务商填好。
 * **密钥永远不碰**，也不自动保存、不自动测试 —— 与页面其它字段同一口径。
 */

import { useState, type ReactNode } from 'react';

import { useDb } from '../../app/db-context.ts';
import { Button, Card, InlineError, TextField } from '../../app/ui.tsx';
import { useAsyncAction, useLiveQuery } from '../../app/useLiveQuery.ts';
import { SETTING_KEYS, getSetting, setSetting } from '../../db/settings.ts';
import { completeChat, isAiConfigured, type AiConfig } from '../../platform/ai.ts';
import { AI_PRESETS, matchPresetId, presetById } from './ai-presets.ts';

/** 与 05 §3.1 的默认值一致：没配过时字段里展示的就是这两项。 */
const AI_FALLBACK: AiConfig = { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' };

export function AiSection(): ReactNode {
  const db = useDb();

  const prefs = useLiveQuery<AiConfig>(
    async () => ({
      baseUrl: await getSetting<string>(db, SETTING_KEYS.aiBaseUrl, AI_FALLBACK.baseUrl),
      apiKey: await getSetting<string>(db, SETTING_KEYS.aiApiKey, AI_FALLBACK.apiKey),
      model: await getSetting<string>(db, SETTING_KEYS.aiModel, AI_FALLBACK.model),
    }),
    [db],
    AI_FALLBACK,
  );

  const action = useAsyncAction();
  const [baseDraft, setBaseDraft] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState<string | null>(null);
  const [modelDraft, setModelDraft] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  // 展示值 = 草稿优先，草稿为空则用已存值（null 表示「没动过这个字段」）
  const baseUrl = baseDraft ?? prefs.baseUrl;
  const model = modelDraft ?? prefs.model;

  // 当前配置属于哪个预设：从字段反查得出，不额外存状态（04 §11.17）
  const matchedId = matchPresetId(baseUrl, model);
  const matched = presetById(matchedId);

  function applyPreset(presetId: string): void {
    const preset = presetById(presetId);
    if (preset === undefined) return;
    // 只写「服务商的属性」这两项；密钥是用户的，一概不碰（04 §11.17 第 1 条）
    setBaseDraft(preset.baseUrl);
    setModelDraft(preset.model);
    setTestResult(null);
  }

  /**
   * 字段一改，上一次的测试结论就失效了 —— 它测的是改之前那套配置。
   * （审查意见 #4）不清的话，改完地址旁边还挂着绿灯「连接成功」。
   */
  function editBase(value: string): void {
    setBaseDraft(value);
    setTestResult(null);
  }

  function editKey(value: string): void {
    setKeyDraft(value);
    setTestResult(null);
  }

  function editModel(value: string): void {
    setModelDraft(value);
    setTestResult(null);
  }

  function save(): void {
    void action.run(async () => {
      await setSetting(db, SETTING_KEYS.aiBaseUrl, baseUrl.trim());
      await setSetting(db, SETTING_KEYS.aiApiKey, (keyDraft ?? prefs.apiKey).trim());
      await setSetting(db, SETTING_KEYS.aiModel, model.trim());
      setBaseDraft(null);
      setKeyDraft(null);
      setModelDraft(null);
      setTestResult(null);
    });
  }

  function test(): void {
    setTestResult(null);
    void action.run(async () => {
      const config: AiConfig = {
        baseUrl: baseUrl.trim(),
        apiKey: (keyDraft ?? prefs.apiKey).trim(),
        model: model.trim(),
      };
      if (!isAiConfigured(config)) {
        throw new Error('先填好接口地址和模型名再测试');
      }
      const reply = await completeChat(config, '你是连通性测试。', '请只回复两个字：连通', 16);
      setTestResult(`连接成功（模型回复：${reply.slice(0, 40)}${reply.length > 40 ? '…' : ''}）`);
    });
  }

  return (
    <Card className="space-y-4 p-4">
      <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">AI 元数据补全</h2>
      <p className="text-sm text-neutral-600 dark:text-neutral-300">
        录书时用书名或 ISBN 一键补全作者、出版社等信息。先按服务商点一下预设（它会填好接口地址与模型名），再填自己的密钥即可；
        本地 Ollama 这类没有预设的，直接手填。
      </p>

      {/* 预设按钮（04 §11.17）：点一下 = 一次填写动作，不制造「选中值」与字段值两套真相 */}
      <div className="space-y-2">
        <span className="text-sm text-neutral-700 dark:text-neutral-300">服务商预设</span>
        <div className="flex flex-wrap gap-2">
          {AI_PRESETS.map((preset) => (
            <Button
              key={preset.id}
              variant={preset.id === matchedId ? 'primary' : 'secondary'}
              onClick={() => applyPreset(preset.id)}
              disabled={action.pending}
            >
              {preset.label}
              {/* 直连不通的把警示挂在按钮上（04 §11.17）：不能等「当前正好是这一家」才看见 */}
              {preset.caveat !== undefined && <span className="ml-1 text-xs font-normal opacity-80">（{preset.caveat}）</span>}
            </Button>
          ))}
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {matched === undefined
            ? '当前：自定义（接口地址与模型名是你自己填的）'
            : `当前：${matched.label} —— ${matched.note}`}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <TextField
          label="接口地址"
          value={baseUrl}
          onValueChange={editBase}
          hint="OpenAI 兼容的 base URL；除 DeepSeek 外一般以 /v1 结尾"
          className="w-80"
        />
        <Button onClick={save} disabled={action.pending}>
          保存
        </Button>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <TextField
          label="密钥"
          type="password"
          value={keyDraft ?? prefs.apiKey}
          onValueChange={editKey}
          hint="只存在这台设备上，请求只发给你填的地址；本地 Ollama 可留空"
          className="w-80"
        />
        <TextField
          label="模型名"
          value={model}
          onValueChange={editModel}
          hint="点上面的预设会自动填；也可以手填（例如本地 Ollama 的 llama3.1）"
          className="w-64"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={test} disabled={action.pending}>
          {action.pending ? '测试中…' : '测试连接'}
        </Button>
        {testResult !== null && <span className="text-sm text-emerald-700 dark:text-emerald-300">{testResult}</span>}
      </div>
      {action.error !== null && <InlineError>{action.error}</InlineError>}
    </Card>
  );
}
