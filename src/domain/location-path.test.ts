import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildTree,
  collectSubtreeIds,
  computeLocationPaths,
  isDescendantOf,
  locationTypeForDepth,
  sortLocations,
  type PathNode,
} from './location-path.ts';

/** 测试里的位置节点：PathNode（computeLocationPaths 的入参）加上 buildTree 需要的 sortOrder。 */
type Node = PathNode & { sortOrder: number };

const home: Node = { id: 'a', parentId: null, name: '家', sortOrder: 0 };
const living: Node = { id: 'b', parentId: 'a', name: '客厅', sortOrder: 0 };
const shelfA: Node = { id: 'c', parentId: 'b', name: '白书架A', sortOrder: 0 };
const layer1: Node = { id: 'd', parentId: 'c', name: '第1层', sortOrder: 0 };
const layer2: Node = { id: 'e', parentId: 'c', name: '第2层', sortOrder: 0 };

const tree: Node[] = [home, living, shelfA, layer1, layer2];

describe('位置树计算（02 §2）', () => {
  it('路径物化：用 " / " 拼接祖先名称', () => {
    const { entries } = computeLocationPaths(tree);
    assert.equal(entries.get('a')?.path, '家');
    assert.equal(entries.get('b')?.path, '家 / 客厅');
    assert.equal(entries.get('c')?.path, '家 / 客厅 / 白书架A');
    assert.equal(entries.get('d')?.path, '家 / 客厅 / 白书架A / 第1层');
  });

  it('深度由父链推导，类型由深度推导', () => {
    const { entries } = computeLocationPaths(tree);
    assert.equal(entries.get('a')?.depth, 0);
    assert.equal(entries.get('d')?.depth, 3);
    assert.equal(locationTypeForDepth(0), 'home');
    assert.equal(locationTypeForDepth(1), 'room');
    assert.equal(locationTypeForDepth(2), 'shelf');
    assert.equal(locationTypeForDepth(3), 'layer');
    assert.equal(locationTypeForDepth(99), 'layer');
  });

  it('结果与输入顺序无关', () => {
    const shuffled = [layer1, shelfA, home, layer2, living];
    const a = computeLocationPaths(tree).entries;
    const b = computeLocationPaths(shuffled).entries;
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      assert.deepEqual(a.get(id), b.get(id), `节点 ${id} 的路径不应随输入顺序变化`);
    }
  });

  it('环必须被报出且计算有限终止（脏数据不能把 App 卡死）', () => {
    const cyclic: Node[] = [
      { id: 'x', parentId: 'y', name: 'X', sortOrder: 0 },
      { id: 'y', parentId: 'x', name: 'Y', sortOrder: 0 },
    ];
    const result = computeLocationPaths(cyclic);
    assert.deepEqual(result.cycles.sort(), ['x', 'y']);
    assert.equal(result.entries.size, 2);
  });

  it('悬空父节点被报出，节点按根处理而不是消失', () => {
    const dangling: Node[] = [{ id: 'p', parentId: '不存在', name: '孤儿架', sortOrder: 0 }];
    const result = computeLocationPaths(dangling);
    assert.deepEqual(result.dangling, ['p']);
    assert.equal(result.entries.get('p')?.path, '孤儿架');
    assert.equal(result.entries.get('p')?.depth, 0);
  });

  it('collectSubtreeIds 含自身，环下也能终止', () => {
    const ids = collectSubtreeIds('b', tree);
    assert.deepEqual([...ids].sort(), ['b', 'c', 'd', 'e']);
    assert.deepEqual([...collectSubtreeIds('a', tree)].sort(), ['a', 'b', 'c', 'd', 'e']);
    assert.deepEqual([...collectSubtreeIds('d', tree)], ['d']);

    const cyclic: Node[] = [
      { id: 'x', parentId: 'y', name: 'X', sortOrder: 0 },
      { id: 'y', parentId: 'x', name: 'Y', sortOrder: 0 },
    ];
    assert.deepEqual([...collectSubtreeIds('x', cyclic)].sort(), ['x', 'y']);
  });

  it('isDescendantOf 判断子树归属，包含自身', () => {
    assert.equal(isDescendantOf('d', 'a', tree), true);
    assert.equal(isDescendantOf('a', 'a', tree), true);
    assert.equal(isDescendantOf('a', 'd', tree), false);
    assert.equal(isDescendantOf('b', 'c', tree), false);
  });

  it('buildTree 组出嵌套结构且不丢节点', () => {
    const roots = buildTree(tree);
    assert.equal(roots.length, 1);
    assert.equal(roots[0]?.id, 'a');
    assert.equal(roots[0]?.children[0]?.id, 'b');
    assert.equal(roots[0]?.children[0]?.children[0]?.children.length, 2);
  });

  it('buildTree 对悬空父节点不丢数据 —— 补挂到根上', () => {
    const nodes: Node[] = [home, { id: 'z', parentId: '不存在', name: '游离架', sortOrder: 0 }];
    const roots = buildTree(nodes);
    const flat: string[] = [];
    const walk = (list: ReturnType<typeof buildTree<Node>>): void => {
      for (const node of list) {
        flat.push(node.id);
        walk(node.children);
      }
    };
    walk(roots);
    assert.equal(flat.length, 2, '两个节点都必须出现在树里');
  });

  it('sortLocations 先深度、再 sortOrder、再名称', () => {
    const rows = [
      { id: '1', parentId: null, name: '乙', path: '乙', depth: 0, sortOrder: 1 },
      { id: '2', parentId: null, name: '甲', path: '甲', depth: 0, sortOrder: 1 },
      { id: '3', parentId: null, name: '丙', path: '丙', depth: 0, sortOrder: 0 },
      { id: '4', parentId: '1', name: '子', path: '乙 / 子', depth: 1, sortOrder: 0 },
    ];
    assert.deepEqual(sortLocations(rows).map((r) => r.id), ['3', '2', '1', '4']);
  });
});
