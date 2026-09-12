/**
 * 页面级小钩子。放这里而不是各页面自己的原因：搜索页与位置页都要
 * 「输入停下来再查」，两份实现迟早会漂移。
 */

import { useEffect, useState } from 'react';

/**
 * 延迟跟随一个值。用于文本框 → liveQuery 之间：每敲一个字都重跑一次全表查询
 * 在千级藏书下也扛得住，但会让输入框在低端机上发涩，所以停 200ms 再跟。
 */
export function useDebounced<T>(value: T, delayMs = 200): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}
