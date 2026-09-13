/**
 * 搜索页（04 §1）。
 *
 * 搜索走 `searchBooks(db, { keyword, locationId, status, limit })`，条件之间是 AND（02 §10.2）。
 * 关键词用 useDebounced 之后再进 useLiveQuery 的 deps：每敲一个字重跑一次全表查询在千级藏书下
 * 也能跑，但会让输入框在低端机上发涩。
 *
 * 结果里的「命中：」徽章不是装饰 —— 它回答的是"为什么这本书会被搜出来"，
 * 关键词匹配了书名以外的字段时（作者、标签、出版社），用户才不会以为搜错了。
 */

import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { useDb } from '../../app/db-context.ts';
import { useDebounced } from '../../app/hooks.ts';
import {
  COPY_STATUS_LABELS,
  MATCH_FIELD_LABELS,
  authorsText,
  bookDisplayTitle,
  copyStatusTone,
} from '../../app/labels.ts';
import {
  Badge,
  Button,
  Card,
  ChoiceGroup,
  EmptyState,
  PageHeader,
  SelectField,
  Spinner,
  TextField,
  type ChoiceOption,
  type SelectOption,
} from '../../app/ui.tsx';
import { useLiveQuery } from '../../app/useLiveQuery.ts';
import { searchBooks, type SearchBooksOptions } from '../../db/books.ts';
import { listLocations } from '../../db/locations.ts';
import { listAllTags } from '../../db/listing.ts';
import { COPY_STATUSES, type BookSearchResult, type CopyStatus, type CopyWithLocation, type Location } from '../../domain/types.ts';

/** 一屏放不下的结果没有意义；超了就让用户细化关键词（service 的 limit）。 */
const RESULT_LIMIT = 50;

/** 「列全部」时的初始值，避免每次渲染都造一个新数组。 */
const NO_LOCATIONS: readonly Location[] = [];
const NO_TAGS: readonly string[] = [];

type StatusFilter = 'all' | CopyStatus;

/** 值域来自 types.ts 的 COPY_STATUSES，不另抄一份清单（04 §5）。 */
const STATUS_FILTER_OPTIONS: readonly ChoiceOption<StatusFilter>[] = [
  { value: 'all', label: '全部' },
  ...COPY_STATUSES.map((status) => ({ value: status, label: COPY_STATUS_LABELS[status] })),
];

/** 副本状态分布。只列出现过的状态，没出现的不占位置。 */
function statusRows(copies: readonly CopyWithLocation[]): { status: CopyStatus; count: number }[] {
  const counts = new Map<CopyStatus, number>();
  for (const copy of copies) counts.set(copy.status, (counts.get(copy.status) ?? 0) + 1);
  return COPY_STATUSES.filter((status) => (counts.get(status) ?? 0) > 0).map((status) => ({
    status,
    count: counts.get(status) ?? 0,
  }));
}

/** 这本书的实体都在哪；同一位置去重，太多时只报数量。 */
function locationPathsText(copies: readonly CopyWithLocation[]): string {
  const paths = [...new Set(copies.map((copy) => copy.locationPath).filter((path) => path !== ''))];
  if (paths.length <= 3) return paths.join('、');
  return `${paths.slice(0, 3).join('、')} 等 ${paths.length} 处`;
}

function ResultRow({ result }: { result: BookSearchResult }): ReactNode {
  const { book, copies, matched } = result;
  const rows = statusRows(copies);
  const paths = locationPathsText(copies);

  return (
    <Card>
      <Link
        to={`/books/${book.id}`}
        className="block min-h-11 p-3 hover:bg-neutral-50 dark:hover:bg-neutral-800/60"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-medium">{bookDisplayTitle(book)}</p>
            <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">{authorsText(book.authors)}</p>
          </div>
          <Badge tone="gray">{copies.length} 本</Badge>
        </div>

        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          {book.isbn !== '' ? `ISBN ${book.isbn}` : '无 ISBN'}
          {book.publisher !== '' && ` · ${book.publisher}`}
        </p>

        {book.tags.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {book.tags.map((tag) => (
              <Badge key={tag} tone="gray">
                {tag}
              </Badge>
            ))}
          </div>
        )}

        {rows.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {rows.map(({ status, count }) => (
              <Badge key={status} tone={copyStatusTone(status)}>
                {COPY_STATUS_LABELS[status]} {count}
              </Badge>
            ))}
          </div>
        )}

        {copies.length === 0 && (
          <p className="mt-1.5 text-xs text-neutral-400 dark:text-neutral-500">还没有实体副本，进详情页添加一本</p>
        )}

        {paths !== '' && <p className="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400">位置：{paths}</p>}

        {/* 命中字段用中性色：绿/琥珀/红已被副本状态占用（copyStatusTone），别混用 */}
        {matched.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            <span className="text-xs text-neutral-500 dark:text-neutral-400">命中：</span>
            {matched.map((field) => (
              <Badge key={field} tone="gray">
                {MATCH_FIELD_LABELS[field]}
              </Badge>
            ))}
          </div>
        )}
      </Link>
    </Card>
  );
}

export function SearchPage(): ReactNode {
  const db = useDb();
  const navigate = useNavigate();

  const [keyword, setKeyword] = useState('');
  const [locationId, setLocationId] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [tag, setTag] = useState('');

  const settledKeyword = useDebounced(keyword, 200);

  const locations = useLiveQuery(() => listLocations(db), [db], NO_LOCATIONS);
  const tags = useLiveQuery(() => listAllTags(db), [db], NO_TAGS);

  const locationOptions = useMemo<readonly SelectOption[]>(
    () => [
      { value: '', label: '全部位置' },
      ...locations.map((location) => ({
        value: location.id,
        label: location.path === '' ? location.name : location.path,
      })),
    ],
    [locations],
  );

  const tagOptions = useMemo<readonly SelectOption[]>(
    () => [{ value: '', label: '全部标签' }, ...tags.map((item) => ({ value: item, label: item }))],
    [tags],
  );

  // 多要一条：拿它判断"还有更多"，就不必再跑一次 count（service 在排序后截断）
  const results = useLiveQuery<BookSearchResult[] | null>(
    async () => {
      const options: SearchBooksOptions = { limit: RESULT_LIMIT + 1 };
      if (settledKeyword.trim() !== '') options.keyword = settledKeyword;
      if (locationId !== '') options.locationId = locationId;
      if (status !== 'all') options.status = status;
      if (tag !== '') options.tag = tag;
      return searchBooks(db, options);
    },
    [db, settledKeyword, locationId, status, tag],
    null,
  );

  const query = settledKeyword.trim();
  const hasFilter = query !== '' || locationId !== '' || status !== 'all' || tag !== '';
  // 位置/状态是副本维度的条件：命中后每条只带符合条件的副本，
  // 不加这句说明，用户会以为「我明明有 3 本，怎么只显示 1 本」。
  const copyFilterActive = locationId !== '' || status !== 'all';
  const truncated = results !== null && results.length > RESULT_LIMIT;
  const visible = results === null ? [] : truncated ? results.slice(0, RESULT_LIMIT) : results;

  const clearFilters = (): void => {
    setKeyword('');
    setLocationId('');
    setStatus('all');
    setTag('');
  };

  return (
    <div className="space-y-4">
      <PageHeader title="搜索" description="按书名、作者、ISBN、标签、出版社找书，可再按位置与状态收窄" />

      <div className="space-y-3">
        <TextField
          label="关键词"
          type="search"
          value={keyword}
          onValueChange={setKeyword}
          placeholder="书名 / 作者 / ISBN / 标签 / 出版社"
          autoComplete="off"
        />
        <SelectField
          label="位置"
          value={locationId}
          onValueChange={setLocationId}
          options={locationOptions}
          hint="选中一个位置时，连它的下级位置一起搜（与「位置」页的计数口径一致）"
        />
        {/* 库里一个标签都没有时不占位置（04 §11.5） */}
        {tags.length > 0 && (
          <SelectField
            label="标签"
            value={tag}
            onValueChange={setTag}
            options={tagOptions}
            hint="单独按标签搜时，只有标签、还没有实体副本的书也会列出来"
          />
        )}
        <ChoiceGroup label="副本状态" value={status} options={STATUS_FILTER_OPTIONS} onChange={setStatus} />
      </div>

      {results === null ? (
        <Spinner label="正在检索…" />
      ) : visible.length === 0 ? (
        hasFilter ? (
          <EmptyState
            title="没找到符合条件的书"
            hint="换个关键词试试，或者放宽位置、标签与状态的筛选。刚到手还没录入的书，直接去新增一本。"
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button onClick={clearFilters}>清空筛选</Button>
                <Button variant="primary" onClick={() => void navigate('/books/new')}>
                  ＋ 新增书目
                </Button>
              </div>
            }
          />
        ) : (
          <EmptyState
            title="书库还是空的"
            hint="还没有书可以搜。点右上角「＋ 新增书目」记下第一本，之后就能按书名、作者、ISBN 或标签把它找回来。"
            action={
              <Button variant="primary" onClick={() => void navigate('/books/new')}>
                ＋ 添加第一本
              </Button>
            }
          />
        )
      ) : (
        <section aria-label="搜索结果" className="space-y-2">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            {truncated
              ? `结果较多，只显示前 ${RESULT_LIMIT} 条 —— 输入更具体的关键词，或用位置、状态收窄范围。`
              : `共 ${visible.length} 条。`}
            {copyFilterActive && '每条的副本数与位置，只算符合当前位置/状态筛选的那些。'}
          </p>
          <ul className="space-y-2">
            {visible.map((result) => (
              <li key={result.book.id}>
                <ResultRow result={result} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
