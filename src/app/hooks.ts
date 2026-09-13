/**
 * 页面级小钩子。放这里而不是各页面自己的原因：搜索页与位置页都要
 * 「输入停下来再查」，两份实现迟早会漂移。
 */

import { useEffect, useLayoutEffect, useState } from 'react';

import { objectUrlOf, releaseObjectUrl } from '../platform/image.ts';

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

/**
 * Blob → object URL，换了 blob 就重建，卸载时一定释放（04 §11.8 的显示侧）。
 * 封面缩略图、详情页大图、预览三处共用这一份，避免哪一处忘了 revoke。
 *
 * 按 Blob 引用比较、不做内容比较：liveQuery 每次重跑都会给出**新的 Blob 对象**
 * （结构化克隆），同一张照片也会多建一次 URL —— 代价是内存里重新解码一遍，
 * 换来的是永远不会显示上一张照片。少重建一次不值得冒显示旧图的险。
 *
 * 用 `useLayoutEffect` 而不是 `useEffect`：换 blob 时旧地址会在清理阶段被 revoke，
 * 而新地址要到下一轮渲染才落到 `<img src>` 上。布局阶段（绘制前）成对完成，
 * 中间那一帧不会带着已回收的地址被画出来。
 */
export function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (blob === null) {
      setUrl(null);
      return undefined;
    }
    const next = objectUrlOf(blob);
    setUrl(next);
    return () => releaseObjectUrl(next);
  }, [blob]);

  return url;
}
