/**
 * 数据订阅与写操作状态。
 *
 * 选 liveQuery 的理由（04 §3）：任何写操作后 Dexie 自己会重跑活跃查询，
 * 页面不需要手工失效缓存 —— 手动重查的漏网点（改完位置忘了刷首页计数、
 * 导入后忘了刷列表）是这类应用最常见的错。
 *
 * 不引入 dexie-react-hooks：同一个能力 dexie 本体已有（01 §2.1 的判断标准）。
 */

import { liveQuery } from 'dexie';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 订阅一个查询，返回最新结果。首次结果到达前返回 fallback。
 * 查询抛错时在渲染期重新抛出，由 ErrorBoundary 接住并显示人话错误。
 */
export function useLiveQuery<T>(
  querier: () => Promise<T>,
  deps: readonly unknown[],
  fallback: T,
): T {
  const [value, setValue] = useState<T>(fallback);
  const [error, setError] = useState<unknown>(null);

  // querier 每次渲染都是新函数，用 ref 持有最新的一份，避免把 deps 换成 querier 本身
  const querierRef = useRef(querier);
  querierRef.current = querier;

  useEffect(() => {
    const subscription = liveQuery(() => querierRef.current()).subscribe({
      next: (next) => {
        setValue(next);
        setError(null);
      },
      error: (err: unknown) => {
        setError(err);
      },
    });
    return () => subscription.unsubscribe();
  }, deps);

  if (error !== null) throw error;
  return value;
}

export interface AsyncAction {
  run: (action: () => Promise<void>) => Promise<void>;
  pending: boolean;
  error: string | null;
  clearError: () => void;
}

/**
 * 写操作的统一外壳：pending 状态 + 把异常转成人话。
 * service 抛出的就是中文可读文案（如「位置名称不能为空」），原样展示，不吞错。
 */
export function useAsyncAction(): AsyncAction {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (action: () => Promise<void>): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { run, pending, error, clearError };
}
