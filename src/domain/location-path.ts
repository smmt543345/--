/**
 * 位置树的纯函数部分（不碰数据库）。
 *
 * 规范见 docs/design/02-data-model.md §2、§4。
 * 这一层只做计算：路径物化、深度/类型推导、子树枚举、环检测。
 */

import type { LocationType } from './types.ts';

export const PATH_SEPARATOR = ' / ';

export interface PathNode {
  id: string;
  parentId: string | null;
  name: string;
}

export interface PathEntry {
  path: string;
  depth: number;
  type: LocationType;
}

export interface PathComputation {
  entries: Map<string, PathEntry>;
  /** 处于环中的位置 id；调用方（repair）必须打断这些环 */
  cycles: string[];
  /** parentId 指向不存在节点的位置 id */
  dangling: string[];
}

export function locationTypeForDepth(depth: number): LocationType {
  if (depth <= 0) return 'home';
  if (depth === 1) return 'room';
  if (depth === 2) return 'shelf';
  return 'layer';
}

/**
 * 计算每个位置的完整路径与深度。对脏数据（环、悬空父节点）必须**有限终止**，
 * 并把问题如实报出来，而不是猜。
 */
export function computeLocationPaths(nodes: readonly PathNode[]): PathComputation {
  const byId = new Map<string, PathNode>();
  for (const node of nodes) byId.set(node.id, node);

  const entries = new Map<string, PathEntry>();
  const cycleIds = new Set<string>();
  const danglingIds = new Set<string>();

  const resolve = (startId: string): void => {
    if (entries.has(startId)) return;

    const chain: PathNode[] = [];
    const walked = new Set<string>();
    let base: PathEntry | undefined;

    let cursor: PathNode | undefined = byId.get(startId);
    while (cursor !== undefined) {
      const memo = entries.get(cursor.id);
      if (memo !== undefined) {
        base = memo;
        break;
      }
      if (walked.has(cursor.id)) {
        // 环：把链上所有节点标记出来，并就地把它当作根，保证终止
        for (const node of chain) cycleIds.add(node.id);
        base = undefined;
        break;
      }
      walked.add(cursor.id);
      chain.push(cursor);

      const parentId = cursor.parentId;
      if (parentId === null) {
        base = undefined;
        break;
      }
      const parent = byId.get(parentId);
      if (parent === undefined) {
        danglingIds.add(cursor.id);
        base = undefined;
        break;
      }
      cursor = parent;
    }

    // chain 的末尾最靠近根，从后往前补深度与路径
    let depth = base === undefined ? 0 : base.depth + 1;
    let path = base === undefined ? '' : base.path;
    for (let i = chain.length - 1; i >= 0; i--) {
      const node = chain[i] as PathNode;
      path = path === '' ? node.name : `${path}${PATH_SEPARATOR}${node.name}`;
      entries.set(node.id, { path, depth, type: locationTypeForDepth(depth) });
      depth += 1;
    }
  };

  for (const node of nodes) resolve(node.id);

  return { entries, cycles: [...cycleIds], dangling: [...danglingIds] };
}

/** 建立 parentId → 子节点 的索引；`null` 为顶层。 */
export function indexChildren<T extends { id: string; parentId: string | null }>(
  nodes: readonly T[],
): { byParent: Map<string | null, T[]>; byId: Map<string, T> } {
  const byParent = new Map<string | null, T[]>();
  for (const node of nodes) {
    const bucket = byParent.get(node.parentId);
    if (bucket === undefined) byParent.set(node.parentId, [node]);
    else bucket.push(node);
  }
  return { byParent, byId: new Map(nodes.map((n) => [n.id, n])) };
}

/** 子树 id 集合（含自身）。遇到环也能终止。 */
export function collectSubtreeIds(
  rootId: string,
  nodes: readonly { id: string; parentId: string | null }[],
): Set<string> {
  const { byParent } = indexChildren(nodes);
  const result = new Set<string>([rootId]);
  const queue: string[] = [rootId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const child of byParent.get(current) ?? []) {
      if (result.has(child.id)) continue; // 环保护
      result.add(child.id);
      queue.push(child.id);
    }
  }
  return result;
}

/** `isDescendant(candidate, ancestor)`：candidate 是否位于 ancestor 子树内。 */
export function isDescendantOf(
  candidateId: string,
  ancestorId: string,
  nodes: readonly { id: string; parentId: string | null }[],
): boolean {
  if (candidateId === ancestorId) return true;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const walked = new Set<string>();
  let cursor = byId.get(candidateId);
  while (cursor !== undefined && cursor.parentId !== null) {
    if (walked.has(cursor.id)) return false; // 环保护
    walked.add(cursor.id);
    if (cursor.parentId === ancestorId) return true;
    cursor = byId.get(cursor.parentId);
  }
  return false;
}

/** 按路径排序（同层内按 sortOrder，再按名称）。 */
export function sortLocations<T extends { path: string; depth: number; sortOrder: number; name: string }>(
  nodes: readonly T[],
): T[] {
  return [...nodes].sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.name.localeCompare(b.name, 'zh');
  });
}

export type TreeNode<T> = T & { children: TreeNode<T>[] };

/** 位置树组装：由扁平行构造嵌套结构，脏数据（环/悬空）不会导致丢节点。 */
export function buildTree<T extends { id: string; parentId: string | null; sortOrder: number; name: string }>(
  nodes: readonly T[],
): TreeNode<T>[] {
  type Node = TreeNode<T>;
  const { byParent } = indexChildren(nodes);
  const compare = (a: T, b: T): number =>
    a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder : a.name.localeCompare(b.name, 'zh');

  const build = (parentId: string | null, seen: Set<string>): Node[] =>
    [...(byParent.get(parentId) ?? [])].sort(compare).flatMap((node) => {
      if (seen.has(node.id)) return []; // 环保护
      seen.add(node.id);
      return [{ ...node, children: build(node.id, seen) }];
    });

  const roots = build(null, new Set<string>());
  // 悬空父节点的记录不会出现在根里，这里补挂，避免"数据没显示"这种最难查的 bug
  const placed = new Set<string>();
  const mark = (list: Node[]): void => {
    for (const node of list) {
      placed.add(node.id);
      mark(node.children);
    }
  };
  mark(roots);
  const orphans = nodes.filter((n) => !placed.has(n.id));
  for (const orphan of orphans) {
    if (placed.has(orphan.id)) continue;
    const node: Node = { ...orphan, children: [] };
    placed.add(node.id);
    roots.push(node);
  }
  return roots;
}
