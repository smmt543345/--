import { createContext, useContext } from 'react';

import type { PocketLibraryDb } from '../db/schema.ts';

/** 数据库实例由启动序列创建后注入（04 §4），页面通过 useDb() 取用。 */
export const DbContext = createContext<PocketLibraryDb | null>(null);

export function useDb(): PocketLibraryDb {
  const db = useContext(DbContext);
  if (db === null) {
    throw new Error('数据库尚未就绪：useDb() 必须在 DbContext.Provider 内使用');
  }
  return db;
}
