/**
 * 借书人管理（04 §11.3）：候选列表 + 新增 / 编辑 / 删除。
 *
 * 候选只服务借出表单的下拉（借过一次自动进候选）；删候选不动历史借出记录
 * —— Loan.borrower 是借出那一刻的历史字符串快照，不指向候选表（02 §5.5）。
 * 重名按规范化姓名去重：重名新增视为更新那一条的联系方式。
 */

import { useState, type ReactNode } from 'react';

import { useDb } from '../../app/db-context.ts';
import { Button, Card, ConfirmDialog, EmptyState, InlineError, Spinner, TextField } from '../../app/ui.tsx';
import { useAsyncAction, useLiveQuery } from '../../app/useLiveQuery.ts';
import { createBorrower, deleteBorrower, listBorrowers, updateBorrower } from '../../db/borrowers.ts';
import type { Borrower } from '../../domain/types.ts';

interface EditDraft {
  id: string;
  name: string;
  contact: string;
}

export function BorrowerSection(): ReactNode {
  const db = useDb();
  const action = useAsyncAction();

  const [nameDraft, setNameDraft] = useState('');
  const [contactDraft, setContactDraft] = useState('');
  const [editing, setEditing] = useState<EditDraft | null>(null);
  const [removing, setRemoving] = useState<Borrower | null>(null);

  const borrowers = useLiveQuery(() => listBorrowers(db), [db], null);

  if (borrowers === null) {
    return (
      <Card className="space-y-3 p-4">
        <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">借书人</h2>
        <Spinner label="正在读取借书人…" />
      </Card>
    );
  }

  const add = (): void => {
    void action.run(async () => {
      await createBorrower(db, { name: nameDraft, contact: contactDraft });
      setNameDraft('');
      setContactDraft('');
    });
  };

  const saveEdit = (): void => {
    const draft = editing;
    if (draft === null) return;
    void action.run(async () => {
      await updateBorrower(db, draft.id, { name: draft.name, contact: draft.contact });
      setEditing(null);
    });
  };

  return (
    <Card className="space-y-3 p-4">
      <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">借书人</h2>
      <p className="text-sm text-neutral-600 dark:text-neutral-300">
        借出时从这里选，姓名和联系方式会自动填上。借过书的人会自动进这个名单（最多 20 位，按最近使用淘汰）。
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <TextField
          label="姓名"
          value={nameDraft}
          onValueChange={setNameDraft}
          className="w-40"
        />
        <TextField
          label="联系方式"
          value={contactDraft}
          onValueChange={setContactDraft}
          hint="可留空"
          className="w-56"
        />
        <Button onClick={add} disabled={nameDraft.trim() === '' || action.pending}>
          添加
        </Button>
      </div>

      {borrowers.length === 0 ? (
        <EmptyState title="还没有借书人" hint="添加一位，或者借出一本书后自动出现。" />
      ) : (
        <ul className="space-y-2">
          {borrowers.map((person) => (
            <li
              key={person.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-neutral-200 px-3 py-2 dark:border-neutral-800"
            >
              {editing !== null && editing.id === person.id ? (
                <div className="flex flex-wrap items-end gap-2">
                  <TextField
                    label="姓名"
                    value={editing.name}
                    onValueChange={(value) => setEditing({ ...editing, name: value })}
                    className="w-40"
                  />
                  <TextField
                    label="联系方式"
                    value={editing.contact}
                    onValueChange={(value) => setEditing({ ...editing, contact: value })}
                    className="w-56"
                  />
                  <Button size="sm" variant="primary" onClick={saveEdit} disabled={action.pending}>
                    保存
                  </Button>
                  <Button size="sm" onClick={() => setEditing(null)} disabled={action.pending}>
                    取消
                  </Button>
                </div>
              ) : (
                <>
                  <div className="min-w-0">
                    <p className="truncate text-sm text-neutral-800 dark:text-neutral-100">{person.name}</p>
                    {person.contact !== '' && (
                      <p className="mt-0.5 truncate text-xs text-neutral-500 dark:text-neutral-400">{person.contact}</p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => {
                        action.clearError();
                        setEditing({ id: person.id, name: person.name, contact: person.contact });
                      }}
                    >
                      编辑
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => {
                        action.clearError();
                        setRemoving(person);
                      }}
                    >
                      删除
                    </Button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {action.error !== null && removing === null && editing === null && <InlineError>{action.error}</InlineError>}

      <ConfirmDialog
        open={removing !== null}
        title="删除借书人"
        confirmLabel="删除"
        pending={action.pending}
        error={action.error}
        message={
          removing === null ? null : (
            <p>
              从候选名单里移除「{removing.name}」。历史借出记录不受影响——记录里仍写着当时的名字。
            </p>
          )
        }
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const person = removing;
          if (person === null) return;
          void action.run(async () => {
            await deleteBorrower(db, person.id);
            setRemoving(null);
          });
        }}
      />
    </Card>
  );
}
