/**
 * 启动信息（04 §4）：启动体检的修复告警、持久化存储是否被授予。
 * 首页要用前者显示一次性横幅，设置页要用后者说明"数据可能被系统清理"。
 */

import { createContext, useContext } from 'react';

export interface BootInfo {
  /** repairInvariants 在启动时修掉的问题；非空时首页顶部提示，不静默吞掉 */
  repairWarnings: readonly string[];
  /** 持久化存储是否授予；false 不影响使用，只是数据可能被浏览器回收 */
  persisted: boolean;
}

export const BootContext = createContext<BootInfo>({ repairWarnings: [], persisted: true });

export function useBootInfo(): BootInfo {
  return useContext(BootContext);
}
