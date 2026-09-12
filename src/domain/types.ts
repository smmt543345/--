/**
 * 实体与值域定义 —— 本文件是数据模型的唯一真源。
 * 规范说明见 docs/design/02-data-model.md。
 *
 * 注意：不使用 TS 的 `enum`（工程硬约束：可擦除语法，见 01-architecture §6）。
 */

/* ------------------------------------------------------------------ *
 * 值域
 * ------------------------------------------------------------------ */

export const LOCATION_TYPES = ['home', 'room', 'shelf', 'layer'] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];

export const COPY_STATUSES = ['on_shelf', 'lent_out', 'lost', 'sold'] as const;
export type CopyStatus = (typeof COPY_STATUSES)[number];

/** 终态：不需要归还，也不再参与借出。 */
export const TERMINAL_COPY_STATUSES = ['lost', 'sold'] as const satisfies readonly CopyStatus[];

export const COPY_CONDITIONS = ['new', 'good', 'fair', 'poor', 'unknown'] as const;
export type CopyCondition = (typeof COPY_CONDITIONS)[number];

export const LOAN_STATUSES = ['active', 'returned'] as const;
export type LoanStatus = (typeof LOAN_STATUSES)[number];

/* ------------------------------------------------------------------ *
 * 实体
 * ------------------------------------------------------------------ */

export interface Location {
  id: string;
  /** null 表示顶层 */
  parentId: string | null;
  name: string;
  /** 物化缓存，如 "家 / 客厅 / 白书架A"。只由 rebuildLocationPaths() 写。 */
  path: string;
  depth: number;
  /** 由 depth 推导后物化，仅作展示提示，业务逻辑不得依赖 */
  type: LocationType;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface Book {
  id: string;
  /** 规范化后的 ISBN-13；未知为空串 */
  isbn: string;
  title: string;
  authors: string[];
  publisher: string;
  publishDate: string;
  coverUrl: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Copy {
  id: string;
  bookId: string;
  locationId: string;
  status: CopyStatus;
  condition: CopyCondition;
  owner: string;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface Loan {
  id: string;
  copyId: string;
  borrower: string;
  contact: string;
  /** YYYY-MM-DD */
  loanDate: string;
  /** YYYY-MM-DD，未设定为空串 */
  dueDate: string;
  /** YYYY-MM-DD，未归还为空串 */
  returnDate: string;
  status: LoanStatus;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface Setting {
  key: string;
  value: unknown;
  updatedAt: string;
}

/* ------------------------------------------------------------------ *
 * 组合视图（供 UI 直接使用，避免页面自己联表）
 * ------------------------------------------------------------------ */

export interface CopyWithLocation extends Copy {
  locationPath: string;
  locationName: string;
  activeLoan: Loan | null;
}

export const MATCH_FIELDS = ['title', 'author', 'isbn', 'tag', 'publisher'] as const;
export type MatchField = (typeof MATCH_FIELDS)[number];

export interface BookSearchResult {
  book: Book;
  copies: CopyWithLocation[];
  matched: MatchField[];
}

export interface BookDetail {
  book: Book;
  copies: CopyWithLocation[];
  /** 该书目下所有副本的借阅历史，按借出日期倒序 */
  loans: Loan[];
}

export interface LoanWithBook extends Loan {
  book: Book;
  copy: Copy;
  locationPath: string;
}

export interface LocationTreeNode extends Location {
  children: LocationTreeNode[];
}
