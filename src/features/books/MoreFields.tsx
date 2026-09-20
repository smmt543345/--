/**
 * 「更多信息（可选）」区（04 §11.13）：ISBN · 出版日期 · 标签 · 品相 · 所有者 · 备注 ·
 * 封面图 URL · 拍照存封面 · 副本数量 —— 九项，默认收起。
 *
 * 从 NewBookPage 整块迁出（01 §5.6）：这九项是「录完书名之后才想起来要填」的东西，
 * 收起来时它们只占一行标题，展开时它们自己就是一整套表单 —— 混在默认层里会把
 * 「书名 → 保存」这条最短路径淹掉。
 *
 * 折叠计数也归这里（`countMoreFields`）：数的是哪些字段、怎么算「已填」，
 * 与这些字段写在一处才不会说两套话（04 §11.13 的计数规则）。
 */

import { type ReactNode } from 'react';

import { COVER_LABELS, COPY_CONDITION_LABELS, bookDisplayTitle } from '../../app/labels.ts';
import { ChoiceGroup, TextAreaField, TextField, type ChoiceOption } from '../../app/ui.tsx';
import { parsePositiveInt } from '../../domain/text.ts';
import { COPY_CONDITIONS } from '../../domain/types.ts';
import type { CopyCondition } from '../../domain/types.ts';
import type { CompressedImage } from '../../platform/image.ts';
import { CoverPicker } from './CoverPicker.tsx';
import { MAX_INITIAL_COUNT, isbnNotice, type BookDraft } from './write.ts';

const CONDITION_OPTIONS: readonly ChoiceOption<CopyCondition>[] = COPY_CONDITIONS.map((value) => ({
  value,
  label: COPY_CONDITION_LABELS[value],
}));

export interface MoreFieldsProps {
  draft: BookDraft;
  /** 这一区只设值，不做函数式更新（需要基于最新值的合并发生在 LookupActions 里） */
  updateDraft: (next: BookDraft) => void;
  /** 副本数量是文本态：可以乱敲，判定留给 validateDraft，页面原样拿着 */
  countRaw: string;
  onCountChange: (value: string) => void;
  /** 拍好待保存的封面（04 §11.8：先存书目再存封面），null = 没有 */
  pendingCover: CompressedImage | null;
  onPendingCover: (image: CompressedImage | null) => void;
  /** 保存进行中：字段与拍照按钮一并禁用 */
  disabled?: boolean;
  /** 用户动了 ISBN：上一条扫后提示描述的是旧值，调用方据此清掉（04 §11.12） */
  onIsbnEdit: () => void;
}

/**
 * 「已填 N 项」的 N（04 §11.13 计数规则）：只数 **ISBN、出版日期、所有者、备注、
 * 封面图 URL、封面照片、副本数≠1** 这 7 项。
 *
 * 品相与标签**一律不计**（无论是否手动改过）：它们正是表单记忆管的「每批通用的默认值」，
 * 计进去等于每次进页面都显示「已填 2 项」，很快就被无视。
 * 副本数按「填了个有效的非 1 数」算 —— 清空的输入框不算一项。
 */
export function countMoreFields(draft: BookDraft, pendingCover: CompressedImage | null, countRaw: string): number {
  const copies = parsePositiveInt(countRaw);
  return [
    draft.isbn.trim() !== '',
    draft.publishDate.trim() !== '',
    draft.owner.trim() !== '',
    draft.note.trim() !== '',
    draft.coverUrl.trim() !== '',
    pendingCover !== null,
    copies !== null && copies !== 1,
  ].filter(Boolean).length;
}

export function MoreFields({
  draft,
  updateDraft,
  countRaw,
  onCountChange,
  pendingCover,
  onPendingCover,
  disabled = false,
  onIsbnEdit,
}: MoreFieldsProps): ReactNode {
  return (
    <>
      <TextField
        label="ISBN"
        inputMode="numeric"
        value={draft.isbn}
        onValueChange={(value) => {
          // 改了 ISBN，上一条提示（「库里已有同 ISBN」/「已补全」）就失效了，免得它继续描述旧值
          onIsbnEdit();
          updateDraft({ ...draft, isbn: value });
        }}
        hint={isbnNotice(draft.isbn) ?? '可以留空；填了才能按 ISBN 查重'}
      />
      <TextField
        label="出版日期"
        value={draft.publishDate}
        onValueChange={(value) => updateDraft({ ...draft, publishDate: value })}
        hint="YYYY-MM-DD；不确定就留空"
      />
      <TextField
        label="标签"
        value={draft.tagsRaw}
        onValueChange={(value) => updateDraft({ ...draft, tagsRaw: value })}
        hint="多个标签用逗号或顿号分开"
      />
      <ChoiceGroup
        label="品相"
        value={draft.condition}
        options={CONDITION_OPTIONS}
        onChange={(value) => updateDraft({ ...draft, condition: value })}
      />
      <TextField
        label="所有者"
        value={draft.owner}
        onValueChange={(value) => updateDraft({ ...draft, owner: value })}
        hint="朋友合库时用来区分「我的」「老张的」，可以留空"
      />
      <TextAreaField label="备注" value={draft.note} onValueChange={(value) => updateDraft({ ...draft, note: value })} hint="可以留空" />
      <TextField
        label="封面图 URL"
        value={draft.coverUrl}
        onValueChange={(value) => updateDraft({ ...draft, coverUrl: value })}
        hint="网络图片地址，可以留空"
      />
      {/* 拍照存封面（04 §11.8）：先在这里预览确认，保存书目时随书入库 */}
      <CoverPicker
        title={bookDisplayTitle({ title: draft.title, isbn: draft.isbn })}
        current={pendingCover}
        onConfirm={onPendingCover}
        onDelete={() => onPendingCover(null)}
        removeLabel={COVER_LABELS.removePending}
        disabled={disabled}
      />
      <TextField
        label="副本数量"
        type="number"
        min={1}
        max={MAX_INITIAL_COUNT}
        value={countRaw}
        onValueChange={onCountChange}
        hint={`同一本书有几本就填几，最多 ${MAX_INITIAL_COUNT} 本`}
      />
    </>
  );
}
