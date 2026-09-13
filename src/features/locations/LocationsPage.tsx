/**
 * 位置管理页（04 §1 的「位置」页，路由 /locations）。
 *
 * 三件事：把 getLocationTree 的结果画成一棵树、在树上做位置的增/改/移/删、
 * 点开某个位置看它下面有哪些副本。
 *
 * 为什么表单里没有「层级类型」这一项（任务描述里提到、但**不能**做成可编辑字段）：
 * `Location.path` / `depth` / `type` 是派生字段，只有 `rebuildLocationPaths()` 会写它们
 * （02 §11、01 §6 第 5 条、`db/locations.ts` 文件头），而 `createLocation` /
 * `updateLocation` 的入参里根本没有 `type`。放一个能点的选择器只会让用户以为改了就生效，
 * 所以这里把它画成**只读的推导结果**（见 `LocationForm`）。
 *
 * 读写一律走 service（01 §6 第 5 条）：位置走 `db/locations.ts`，副本列表走
 * `db/copies.ts`，位置计数走 `db/stats.ts`（02 §10.1 的口径来源），书目标题走 `db/books.ts`。
 */

import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { useDb } from '../../app/db-context.ts';
import { NoLocationsArt } from '../../app/illustrations.tsx';
import {
  COPY_STATUS_LABELS,
  DELETE_STRATEGY_LABELS,
  LOCATION_TYPE_LABELS,
  bookDisplayTitle,
  copyStatusTone,
} from '../../app/labels.ts';
import { SkeletonBlock, SkeletonList } from '../../app/Skeleton.tsx';
import {
  Badge,
  Button,
  buttonClass,
  Card,
  ChoiceGroup,
  ConfirmDialog,
  EmptyState,
  InlineError,
  Modal,
  PageHeader,
  SelectField,
  TextField,
  cn,
  type ChoiceOption,
  type SelectOption,
} from '../../app/ui.tsx';
import { useAsyncAction, useLiveQuery } from '../../app/useLiveQuery.ts';
import { listBooks } from '../../db/books.ts';
import { listCopiesByLocation } from '../../db/copies.ts';
import {
  countLocationDependents,
  createLocation,
  deleteLocation,
  getLocationTree,
  moveLocation,
  updateLocation,
  type DeleteLocationStrategy,
  type UpdateLocationInput,
} from '../../db/locations.ts';
import { getCopiesByLocation, type LocationStat } from '../../db/stats.ts';
import { UNSORTED_LOCATION_ID } from '../../domain/ids.ts';
import { collectSubtreeIds, locationTypeForDepth } from '../../domain/location-path.ts';
import {
  LOCATION_TYPES,
  type Book,
  type CopyWithLocation,
  type Location,
  type LocationTreeNode,
  type LocationType,
} from '../../domain/types.ts';
import { CoverThumb } from '../books/CoverThumb.tsx';
import { flattenTree, isSortOrderInvalid, parentOptions, parseSortOrder } from './tree-view.ts';

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

const PAGE_DESCRIPTION =
  '位置是一棵树：家 → 房间 → 书架 → 层，层级深度不限。徽章数字是该位置及其所有子位置的副本总数，括号里是直接放在这一层的数量。';

type CopyScope = 'subtree' | 'self';

/** 副本列表的范围口径；默认「含子层」，与统计口径一致（02 §10.1）。 */
const COPY_SCOPE_OPTIONS: readonly ChoiceOption<CopyScope>[] = [
  { value: 'subtree', label: '含子层' },
  { value: 'self', label: '只此层' },
];

/** 层级类型的只读展示用选项：直接用 types.ts 的清单，不另抄一份（04 §5）。 */
const LOCATION_TYPE_OPTIONS: readonly ChoiceOption<LocationType>[] = LOCATION_TYPES.map((value) => ({
  value,
  label: LOCATION_TYPE_LABELS[value],
}));

/** 删除策略的选项由 labels 的键派生：以后加策略，界面自动多一个按钮，不会漏。 */
const DELETE_STRATEGY_OPTIONS: readonly ChoiceOption<DeleteLocationStrategy>[] = (
  Object.keys(DELETE_STRATEGY_LABELS) as DeleteLocationStrategy[]
).map((value) => ({ value, label: DELETE_STRATEGY_LABELS[value] }));

/**
 * ui.tsx 只提供 Button（渲染成 <button>），没有链接版本。导航动作必须是 <a>
 * 才能中键/新标签打开、才能被读屏当作链接，所以这里用 buttonClass() 复用按钮本体的
 * 样式，而不是另抄一份类名（抄一份就会和按钮漂开）。
 */
const LINK_BUTTON_CLASS = buttonClass();

const NO_EXCLUSION: ReadonlySet<string> = new Set<string>();

/* ------------------------------------------------------------------ *
 * 位置表单（新建与编辑共用，04 §5：表单只有名称、上级、排序）
 * ------------------------------------------------------------------ */

interface LocationFormValues {
  name: string;
  /** 空串 = 顶层 */
  parentId: string;
  /** 空串 = 新建时自动 / 编辑时不改动 */
  sortOrder: string;
}

function LocationForm({
  mode,
  initial,
  parentChoices,
  parentDepths,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  mode: 'create' | 'edit';
  initial: LocationFormValues;
  parentChoices: readonly SelectOption[];
  parentDepths: ReadonlyMap<string, number>;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (values: LocationFormValues) => void;
}): ReactNode {
  const formId = useId();
  const [name, setName] = useState(initial.name);
  const [nameTouched, setNameTouched] = useState(false);
  const [parentId, setParentId] = useState(initial.parentId);
  const [sortOrder, setSortOrder] = useState(initial.sortOrder);

  const sortOrderInvalid = isSortOrderInvalid(sortOrder);
  const nameMissing = name.trim() === '';
  const canSubmit = !nameMissing && !sortOrderInvalid && !pending;

  // 层级类型是派生值：由所选上级的深度推出来（0=家、1=房间、2=书架、≥3=层）。
  // 编辑时改上级 = 保存后调用 moveLocation，路径重建会顺手把这个值改掉。
  const parentDepth = parentId === '' ? -1 : parentDepths.get(parentId) ?? 0;
  const derivedType = locationTypeForDepth(parentDepth + 1);

  return (
    <form
      id={formId}
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) return;
        onSubmit({ name, parentId, sortOrder });
      }}
    >
      <TextField
        label="名称"
        value={name}
        onValueChange={setName}
        onBlur={() => setNameTouched(true)}
        autoFocus
        placeholder="例如：客厅书架"
        hint="只填这一层的名字，完整路径由上级拼出来"
        error={nameTouched && nameMissing ? '名称不能为空' : null}
      />

      <SelectField
        label="上级位置"
        value={parentId}
        onValueChange={setParentId}
        options={parentChoices}
        hint="留空表示顶层；不能选到自己或自己的下级里（那会形成环）"
      />

      <TextField
        label="排序"
        type="number"
        step={1}
        inputMode="numeric"
        value={sortOrder}
        onValueChange={setSortOrder}
        hint={
          mode === 'create'
            ? '同一上级下的先后顺序，数字小的排前面；留空 = 自动排在最后'
            : '同一上级下的先后顺序，数字小的排前面；留空 = 不修改现有排序'
        }
        error={sortOrderInvalid ? '排序要填整数（如 0、1、2），或留空' : null}
      />

      <ChoiceGroup
        label="层级类型"
        value={derivedType}
        options={LOCATION_TYPE_OPTIONS}
        // 只读：type 是派生字段，只有 rebuildLocationPaths() 会写它（02 §11）
        onChange={() => undefined}
        disabled
        hint="由所在层级自动决定（顶层是「家」，往下依次是「房间」「书架」「层」），不需要手填"
      />

      {error !== null && <InlineError>{error}</InlineError>}

      <div className="flex flex-wrap justify-end gap-2 pt-1">
        <Button onClick={onCancel} disabled={pending}>
          取消
        </Button>
        <Button type="submit" variant="primary" disabled={!canSubmit}>
          {pending ? '保存中…' : mode === 'create' ? '创建位置' : '保存修改'}
        </Button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ *
 * 页面
 * ------------------------------------------------------------------ */

interface TreeData {
  tree: LocationTreeNode[];
  stats: LocationStat[];
}

interface CopiesData {
  copies: CopyWithLocation[];
  books: Map<string, Book>;
}

type FormTarget = { mode: 'create' } | { mode: 'edit'; node: Location };

export function LocationsPage(): ReactNode {
  const db = useDb();

  // 存「已收起」而不是「已展开」：新加的位置天然是展开的，不需要再写一个 effect
  // 把新 id 补进展开集合（那种同步逻辑正是漏网的来源）。
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scope, setScope] = useState<CopyScope>('subtree');
  const [formTarget, setFormTarget] = useState<FormTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Location | null>(null);
  const [strategy, setStrategy] = useState<DeleteLocationStrategy>('reparent');

  const createAction = useAsyncAction();
  const editAction = useAsyncAction();
  const deleteAction = useAsyncAction();

  // 树与各位置藏书量一次性取齐：分两个订阅会出现「树已经变了、计数还是旧的」的中间帧。
  const treeData = useLiveQuery<TreeData | null>(
    async () => {
      const [tree, stats] = await Promise.all([getLocationTree(db), getCopiesByLocation(db)]);
      return { tree, stats };
    },
    [db],
    null,
  );

  const flat = treeData === null ? [] : flattenTree(treeData.tree);
  const byId = new Map(flat.map((node) => [node.id, node]));
  const statByLocation = new Map((treeData?.stats ?? []).map((stat) => [stat.locationId, stat]));
  const parentDepths = new Map(flat.map((node) => [node.id, node.depth]));

  // 删除确认里的数量只能来自 countLocationDependents，不许猜（04 §6）。
  const deleteTargetId = deleteTarget?.id ?? null;
  const dependents = useLiveQuery<{ childLocations: number; copies: number } | null>(
    async () => (deleteTargetId === null ? null : countLocationDependents(db, deleteTargetId)),
    [db, deleteTargetId],
    null,
  );

  // 面板挂在被点开的那个节点上，所以节点一旦消失（被删/被合并）面板自然不再渲染，
  // 这里顺带把 id 失效的查询也停掉，免得白跑一次。
  const activeId = selectedId !== null && byId.has(selectedId) ? selectedId : null;
  const copiesData = useLiveQuery<CopiesData | null>(
    async () => {
      if (activeId === null) return null;
      const [copies, books] = await Promise.all([
        listCopiesByLocation(db, activeId, { includeSubtree: scope === 'subtree' }),
        // 副本只带 bookId，列表要显示书名、点进详情，所以这里把书目一起取回来做映射
        listBooks(db),
      ]);
      return { copies, books: new Map(books.map((book) => [book.id, book])) };
    },
    [db, activeId, scope],
    null,
  );

  /* ---------------- 交互 ---------------- */

  function toggleCollapsed(id: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleCopies(id: string): void {
    setSelectedId((prev) => (prev === id ? null : id));
  }

  function openCreate(): void {
    createAction.clearError();
    editAction.clearError();
    setFormTarget({ mode: 'create' });
  }

  function openEdit(node: Location): void {
    editAction.clearError();
    createAction.clearError();
    setFormTarget({ mode: 'edit', node });
  }

  function openDelete(node: Location): void {
    deleteAction.clearError();
    // 每次都回到默认策略：「上移」保留数据，危险的那个必须是用户主动选的（02 §9）
    setStrategy('reparent');
    setDeleteTarget(node);
  }

  function closeForm(): void {
    setFormTarget(null);
    createAction.clearError();
    editAction.clearError();
  }

  function closeDelete(): void {
    setDeleteTarget(null);
    deleteAction.clearError();
  }

  async function submitForm(values: LocationFormValues): Promise<void> {
    const target = formTarget;
    if (target === null) return;

    if (target.mode === 'create') {
      await createAction.run(async () => {
        await createLocation(db, {
          name: values.name,
          parentId: values.parentId === '' ? null : values.parentId,
          sortOrder: parseSortOrder(values.sortOrder),
        });
        setFormTarget(null);
      });
      return;
    }

    const node = target.node;
    await editAction.run(async () => {
      const name = values.name.trim();
      const parentId = values.parentId === '' ? null : values.parentId;
      const patch: UpdateLocationInput = {};
      if (name !== node.name) patch.name = name;
      const sortOrder = parseSortOrder(values.sortOrder);
      if (sortOrder !== undefined && sortOrder !== node.sortOrder) patch.sortOrder = sortOrder;

      // 名称与排序走 updateLocation；改上级必须走 moveLocation —— 环校验在那边（02 §6 I5）
      if (Object.keys(patch).length > 0) await updateLocation(db, node.id, patch);
      if (parentId !== node.parentId) await moveLocation(db, node.id, parentId);
      setFormTarget(null);
    });
  }

  async function confirmDelete(): Promise<void> {
    const target = deleteTarget;
    // 数量还没统计出来时不允许执行：确认文案要带具体数字，不能先删了再补说明
    if (target === null || dependents === null) return;
    const hasDependents = dependents.childLocations + dependents.copies > 0;
    await deleteAction.run(async () => {
      await deleteLocation(db, target.id, hasDependents ? strategy : undefined);
      setDeleteTarget(null);
    });
  }

  /* ---------------- 渲染 ---------------- */

  function renderCopiesPanel(node: LocationTreeNode, depth: number): ReactNode {
    const data = copiesData;
    return (
      <div
        className="mb-2 rounded-xl border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-950/40"
        style={{ marginLeft: `${depth * 16 + 36}px` }}
      >
        <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">
          {scope === 'subtree' ? `「${node.path}」及其子位置的藏书` : `「${node.path}」本层的藏书`}
          {data !== null ? `（${data.copies.length} 本）` : ''}
        </p>

        <div className="mt-2">
          <ChoiceGroup
            label="范围"
            value={scope}
            options={COPY_SCOPE_OPTIONS}
            onChange={setScope}
            hint="默认含子层，与统计口径一致"
          />
        </div>

        {data === null ? (
          <SkeletonList rows={3} label="正在读取藏书…" />
        ) : data.copies.length === 0 ? (
          <div className="mt-2">
            <EmptyState
              title="这个位置还没有书"
              hint="去「新增书目」把书收录进来，在副本里把位置选到这里即可。"
              action={
                <Link className={LINK_BUTTON_CLASS} to="/books/new">
                  ＋ 新增书目
                </Link>
              }
            />
          </div>
        ) : (
          <ul className="mt-1 divide-y divide-neutral-200 dark:divide-neutral-800">
            {data.copies.map((copy) => {
              const book = data.books.get(copy.bookId);
              const meta: string[] = [];
              // 「只此层」时所有条目都在同一个位置，再显示一遍路径是噪音
              if (scope === 'subtree') meta.push(copy.locationPath);
              if (copy.owner !== '') meta.push(`拥有者：${copy.owner}`);
              if (copy.activeLoan !== null) meta.push(`借给「${copy.activeLoan.borrower}」`);
              return (
                <li key={copy.id} className="animate-fade-rise">
                  <Link
                    to={`/books/${copy.bookId}`}
                    className="flex min-h-11 items-center gap-2 py-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-800/60"
                  >
                    {/* 行首缩略图（04 §11.8）：没有照片就不渲染，这一行不会多出一块空格 */}
                    <CoverThumb bookId={copy.bookId} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-neutral-800 dark:text-neutral-100">
                        {book === undefined ? '（这条副本的书目记录已丢失）' : bookDisplayTitle(book)}
                      </span>
                      {meta.length > 0 && (
                        <span className="mt-0.5 block truncate text-xs text-neutral-500 dark:text-neutral-400">
                          {meta.join(' · ')}
                        </span>
                      )}
                    </span>
                    <Badge tone={copyStatusTone(copy.status)}>{COPY_STATUS_LABELS[copy.status]}</Badge>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  }

  function renderNode(node: LocationTreeNode, depth: number): ReactNode {
    const isSystem = node.id === UNSORTED_LOCATION_ID;
    const stat = statByLocation.get(node.id);
    const subtreeCopies = stat?.subtree ?? 0;
    const directCopies = stat?.direct ?? 0;
    const hasChildren = node.children.length > 0;
    const isCollapsed = collapsed.has(node.id);
    const isOpen = activeId === node.id;

    const label = (
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="min-w-0 truncate text-sm font-medium text-neutral-800 dark:text-neutral-100">{node.name}</span>
        <span className="flex shrink-0 items-center gap-1">
          <Badge tone="gray">{LOCATION_TYPE_LABELS[node.type]}</Badge>
          {isSystem && <Badge tone="gray">系统位置</Badge>}
          <Badge tone={subtreeCopies > 0 ? 'green' : 'gray'}>{`${subtreeCopies} 本`}</Badge>
          {directCopies !== subtreeCopies && (
            <span className="text-xs text-neutral-400 dark:text-neutral-500">{`本层 ${directCopies}`}</span>
          )}
        </span>
      </span>
    );

    return (
      <li key={node.id}>
        <div
          className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-neutral-100 py-1 dark:border-neutral-800"
          style={{ paddingLeft: `${depth * 16}px` }}
        >
          <div className="flex min-w-0 flex-[1_1_13rem] items-center gap-1">
            {hasChildren ? (
              // 这个箭头是给鼠标/触屏用的重复入口（名字那块也能点），所以它不进 Tab 序列、
              // 也不被读屏念出来，免得同一个动作出现两个焦点停靠点
              <button
                type="button"
                tabIndex={-1}
                aria-hidden="true"
                onClick={() => toggleCollapsed(node.id)}
                className="flex min-h-11 w-8 shrink-0 items-center justify-center rounded-lg text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
              >
                <span aria-hidden="true" className={cn('inline-block transition-transform', !isCollapsed && 'rotate-90')}>
                  ▶
                </span>
              </button>
            ) : (
              <span className="w-8 shrink-0" aria-hidden="true" />
            )}

            {/* 有子位置时整块名字都可点（比 8px 的箭头好按）；没有子位置就不是按钮，免得出现点了没反应的控件 */}
            {hasChildren ? (
              <button
                type="button"
                onClick={() => toggleCollapsed(node.id)}
                aria-expanded={!isCollapsed}
                className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-1 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                {label}
              </button>
            ) : (
              <div className="flex min-h-11 min-w-0 flex-1 items-center gap-2 px-1">{label}</div>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <Button onClick={() => toggleCopies(node.id)} aria-pressed={isOpen}>
              {isOpen ? '收起藏书' : '查看藏书'}
            </Button>
            <Button
              onClick={() => openEdit(node)}
              disabled={isSystem}
              title={isSystem ? '「未分类」是系统位置，不能重命名或移动' : undefined}
            >
              编辑
            </Button>
            <Button
              onClick={() => openDelete(node)}
              disabled={isSystem}
              title={isSystem ? '「未分类」是系统位置，不能删除' : undefined}
            >
              删除
            </Button>
          </div>
        </div>

        {isSystem && (
          <p
            className="pb-2 text-xs text-neutral-500 dark:text-neutral-400"
            style={{ paddingLeft: `${depth * 16 + 36}px` }}
          >
            「未分类」是系统位置：位置未知的书都收容在这里，所以不能重命名、移动或删除。
          </p>
        )}

        {isOpen && renderCopiesPanel(node, depth)}

        {hasChildren && !isCollapsed && (
          <ul>{node.children.map((child) => renderNode(child, depth + 1))}</ul>
        )}
      </li>
    );
  }

  if (treeData === null) {
    return (
      <div>
        <PageHeader
          title="位置"
          description={PAGE_DESCRIPTION}
          actions={
            <Button variant="primary" onClick={openCreate}>
              ＋ 新增位置
            </Button>
          }
        />
        <SkeletonBlock className="h-4 w-40" />
      </div>
    );
  }

  const hasUserLocations = flat.some((node) => node.id !== UNSORTED_LOCATION_ID);
  const unsortedCopies = statByLocation.get(UNSORTED_LOCATION_ID)?.subtree ?? 0;
  const onlySystemLocation = treeData.tree.length > 0 && !hasUserLocations;
  // 只剩「未分类」且它还是空的时，树只会在屏幕上占一行噪音，直接不画
  const showTree = onlySystemLocation ? unsortedCopies > 0 : treeData.tree.length > 0;
  const nodesWithChildren = flat.filter((node) => node.children.length > 0);
  const allCollapsed = nodesWithChildren.length > 0 && nodesWithChildren.every((node) => collapsed.has(node.id));

  const deleteMessage = (): ReactNode => {
    if (deleteTarget === null) return null;
    if (dependents === null) {
      return <p>正在统计「{deleteTarget.path}」下会受影响的子位置与副本…</p>;
    }
    const total = dependents.childLocations + dependents.copies;
    const fallbackPath =
      deleteTarget.parentId === null ? '未分类' : byId.get(deleteTarget.parentId)?.path ?? '未分类';
    return (
      <>
        <p>
          「{deleteTarget.path}」下有 <strong>{dependents.childLocations}</strong> 个子位置、
          <strong>{dependents.copies}</strong> 本副本会受影响。
        </p>
        {total === 0 ? (
          <p className="mt-2">它没有子位置，也没有副本，删除后不可恢复。</p>
        ) : strategy === 'cascade' ? (
          <p className="mt-2 text-red-700 dark:text-red-300">
            级联删除会把这些子位置、副本，以及副本的全部借出记录一并删掉，不可恢复。
          </p>
        ) : (
          <p className="mt-2">
            上移：{dependents.childLocations} 个子位置与 {dependents.copies} 本副本会移到「{fallbackPath}」，
            数据都保留下来。
          </p>
        )}
      </>
    );
  };

  const activeFormAction = formTarget?.mode === 'edit' ? editAction : createAction;

  return (
    <div>
      <PageHeader
        title="位置"
        description={PAGE_DESCRIPTION}
        actions={
          <Button variant="primary" onClick={openCreate}>
            ＋ 新增位置
          </Button>
        }
      />

      {!hasUserLocations && (
        <div className="mb-4">
          <EmptyState
            illustration={<NoLocationsArt />}
            title="还没有位置"
            hint={
              unsortedCopies > 0
                ? `先建一个「客厅书架」这样的位置，再往里放书。「未分类」里现在还堆着 ${unsortedCopies} 本没指定位置的书，建好位置后可以逐本移过去。`
                : '先建一个「客厅书架」这样的位置，再往里放书。'
            }
            action={
              <Button variant="primary" onClick={openCreate}>
                ＋ 新增位置
              </Button>
            }
          />
        </div>
      )}

      {showTree && (
        <Card className="p-3">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">位置树</h2>
            {nodesWithChildren.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setCollapsed(allCollapsed ? new Set<string>() : new Set(nodesWithChildren.map((n) => n.id)))}
              >
                {allCollapsed ? '展开全部' : '收起全部'}
              </Button>
            )}
          </div>
          <ul>{treeData.tree.map((node) => renderNode(node, 0))}</ul>
        </Card>
      )}

      <Modal
        open={formTarget !== null}
        title={formTarget?.mode === 'edit' ? '编辑位置' : '新增位置'}
        onClose={closeForm}
      >
        {formTarget !== null && (
          <LocationForm
            // 换一个目标就换一次 key，表单状态不会串到上一个位置
            key={formTarget.mode === 'edit' ? formTarget.node.id : 'create'}
            mode={formTarget.mode}
            initial={
              formTarget.mode === 'edit'
                ? {
                    name: formTarget.node.name,
                    parentId: formTarget.node.parentId ?? '',
                    sortOrder: String(formTarget.node.sortOrder),
                  }
                : { name: '', parentId: '', sortOrder: '' }
            }
            parentChoices={
              formTarget.mode === 'edit'
                ? parentOptions(treeData.tree, collectSubtreeIds(formTarget.node.id, flat))
                : parentOptions(treeData.tree, NO_EXCLUSION)
            }
            parentDepths={parentDepths}
            pending={activeFormAction.pending}
            error={activeFormAction.error}
            onCancel={closeForm}
            onSubmit={(values) => {
              void submitForm(values);
            }}
          />
        )}
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除位置"
        confirmLabel="确认删除"
        // 数量没统计出来之前按钮是禁用的：确认文案必须带具体数字（04 §6），
        // 而之前“点了没反应”的空转按钮只会让人以为是卡住了
        pending={deleteAction.pending || dependents === null}
        error={deleteAction.error}
        onCancel={closeDelete}
        onConfirm={() => {
          void confirmDelete();
        }}
        message={deleteMessage()}
      >
        {/* 没有子位置也没有副本时不需要选策略（选哪个结果都一样），直接把选择器藏起来，避免出现空转的控件 */}
        {dependents !== null && dependents.childLocations + dependents.copies > 0 && (
          <ChoiceGroup<DeleteLocationStrategy>
            label="删除策略"
            value={strategy}
            options={DELETE_STRATEGY_OPTIONS}
            onChange={setStrategy}
            hint="「上移」保留数据；「级联删除」不可恢复，选它前请确认这些副本已经不需要了"
          />
        )}
      </ConfirmDialog>
    </div>
  );
}
