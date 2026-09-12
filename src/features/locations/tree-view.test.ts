import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UNSORTED_LOCATION_ID } from '../../domain/ids.ts';
import type { LocationType, LocationTreeNode } from '../../domain/types.ts';
import { flattenTree, isSortOrderInvalid, parentOptions, parseSortOrder } from './tree-view.ts';

function node(
  id: string,
  name: string,
  depth: number,
  children: LocationTreeNode[] = [],
  type: LocationType = 'home',
): LocationTreeNode {
  return {
    id,
    parentId: null,
    name,
    path: name,
    depth,
    type,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    children,
  };
}

/** 家 / 客厅 / 白书架A（第1层、第2层） + 顶层「未分类」（排第一，与播种行一致）。 */
const layer1 = node('l1', '第1层', 3, [], 'layer');
const layer2 = node('l2', '第2层', 3, [], 'layer');
const shelf = node('shelf', '白书架A', 2, [layer1, layer2], 'shelf');
const living = node('living', '客厅', 1, [shelf], 'room');
const home = node('home', '家', 0, [living]);
const unsorted: LocationTreeNode = { ...node(UNSORTED_LOCATION_ID, '未分类', 0), sortOrder: -1 };

const tree: LocationTreeNode[] = [unsorted, home];

describe('位置页的树视图辅助（04 §1 /locations）', () => {
  it('flattenTree 按前序铺开：父节点一定排在子节点前面', () => {
    assert.deepEqual(
      flattenTree(tree).map((n) => n.id),
      ['__unsorted__', 'home', 'living', 'shelf', 'l1', 'l2'],
    );
  });

  it('flattenTree 处理空树与无子节点的树', () => {
    assert.deepEqual(flattenTree([]), []);
    assert.deepEqual(
      flattenTree([unsorted]).map((n) => n.id),
      ['__unsorted__'],
    );
  });

  it('每个节点都排在自己的后代之前 —— 这是下拉框缩进能读的前提', () => {
    const ids = flattenTree(tree).map((n) => n.id);
    const at = (id: string): number => ids.indexOf(id);
    assert.ok(at('home') < at('living'));
    assert.ok(at('home') < at('shelf'));
    assert.ok(at('home') < at('l1'));
    assert.ok(at('living') < at('shelf'));
    assert.ok(at('living') < at('l2'));
    assert.ok(at('shelf') < at('l1'));
    assert.ok(at('shelf') < at('l2'));
  });

  it('上级下拉框第一项是「顶层」，空串对应 parentId = null', () => {
    const options = parentOptions(tree);
    assert.deepEqual(options[0], { value: '', label: '顶层（没有上级）' });
  });

  it('入参直接给树时也能列出全部节点 —— 回归：曾经只遍历根节点，选项静默少掉大半', () => {
    assert.equal(parentOptions(tree).length, flattenTree(tree).length + 1);
  });

  it('上级下拉框按深度缩进，并标出系统位置', () => {
    const options = parentOptions(tree);
    const byValue = new Map(options.map((o) => [o.value, o.label]));
    assert.equal(byValue.get('home'), '家（家）');
    assert.equal(byValue.get('living'), '　客厅（房间）');
    assert.equal(byValue.get('shelf'), '　　白书架A（书架）');
    assert.equal(byValue.get('l1'), '　　　第1层（层）');
    assert.match(byValue.get(UNSORTED_LOCATION_ID) ?? '', /^未分类（家） · 系统$/);
  });

  it('编辑时不能把自己或自己的后代选成上级（否则成环，02 §6 I5）', () => {
    // 编辑「客厅」：可选里不该有客厅、白书架A、第1层、第2层
    const excluded = new Set(['living', 'shelf', 'l1', 'l2']);
    const values = parentOptions(tree, excluded).map((o) => o.value);
    assert.deepEqual(values, ['', UNSORTED_LOCATION_ID, 'home']);
  });

  it('叶子位置只排除自己，其余兄弟仍可作为上级', () => {
    const values = parentOptions(tree, new Set(['l1'])).map((o) => o.value);
    assert.ok(!values.includes('l1'));
    assert.ok(values.includes('l2'));
  });

  it('parseSortOrder：空串 = 不指定，整数原样返回，小数与乱码当没填', () => {
    assert.equal(parseSortOrder(''), undefined);
    assert.equal(parseSortOrder('   '), undefined);
    assert.equal(parseSortOrder('0'), 0);
    assert.equal(parseSortOrder(' 12 '), 12);
    assert.equal(parseSortOrder('-3'), -3);
    assert.equal(parseSortOrder('1.5'), undefined);
    assert.equal(parseSortOrder('abc'), undefined);
    assert.equal(parseSortOrder('NaN'), undefined);
  });

  it('isSortOrderInvalid：空串合法（= 不指定），非整数非法', () => {
    assert.equal(isSortOrderInvalid(''), false);
    assert.equal(isSortOrderInvalid('3'), false);
    assert.equal(isSortOrderInvalid('1.5'), true);
    assert.equal(isSortOrderInvalid('abc'), true);
  });
});
