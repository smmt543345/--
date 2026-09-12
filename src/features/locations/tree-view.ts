/**
 * 位置页的纯计算部分（不碰数据库、不碰 React），与 `features/loans/write.ts` 同样的分工：
 * 页面只负责画，容易算错的东西放在这里，好单独用 node --test 覆盖。
 *
 * 树的组装本身在 `domain/location-path.ts` 的 `buildTree` 里（02 §2），这里只处理
 * 「怎么把这棵树摊给用户看」：扁平化、上级下拉框的可选项、排序输入的解释。
 */

import { LOCATION_TYPE_LABELS } from '../../app/labels.ts';
import type { SelectOption } from '../../app/ui.tsx';
import { UNSORTED_LOCATION_ID } from '../../domain/ids.ts';
import type { LocationTreeNode } from '../../domain/types.ts';

/** 树 → 前序扁平列表（父节点一定排在子节点前面，正好适合给下拉框做缩进）。 */
export function flattenTree(nodes: readonly LocationTreeNode[]): LocationTreeNode[] {
  const out: LocationTreeNode[] = [];
  const walk = (list: readonly LocationTreeNode[]): void => {
    for (const node of list) {
      out.push(node);
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/**
 * 上级位置下拉框的选项。`excluded` 用来剔除「自己 + 自己的所有后代」——
 * service 层也会拦（`moveLocation` 抛「不能把位置移动到它自己的下级里」，02 §6 I5），
 * 但让用户根本选不到非法值，比让他点了再吃一个报错好。
 *
 * 空串代表「顶层（没有上级）」，与 `Location.parentId === null` 对应。
 *
 * 入参是**树**而不是扁平列表：早先的版本直接遍历传入的数组，调用方一旦图省事把
 * `tree` 原样传进来，下拉框就只剩根节点 —— 不报错、不崩溃，只是选项凭空少了一大半。
 * 宁可在函数内部多摊一次，也不留这种静默截断的坑。
 */
export function parentOptions(
  tree: readonly LocationTreeNode[],
  excluded: ReadonlySet<string> = new Set<string>(),
): SelectOption[] {
  const options: SelectOption[] = [{ value: '', label: '顶层（没有上级）' }];
  for (const node of flattenTree(tree)) {
    if (excluded.has(node.id)) continue;
    options.push({
      value: node.id,
      // 原生 select 不认层级，全角空格缩进是唯一能让用户看出上下级的手段
      label: `${'　'.repeat(node.depth)}${node.name}（${LOCATION_TYPE_LABELS[node.type]}）${
        node.id === UNSORTED_LOCATION_ID ? ' · 系统' : ''
      }`,
    });
  }
  return options;
}

/**
 * 排序输入 → 数字。空串表示「不指定」，两种含义由调用方决定：
 * 新建 = 自动排在同级最后（`createLocation` 的语义），编辑 = 不修改现有排序。
 * 非整数（含空串以外的乱码）返回 undefined，表单层已经用同样的规则禁用提交按钮。
 */
export function parseSortOrder(raw: string): number | undefined {
  const text = raw.trim();
  if (text === '') return undefined;
  const value = Number(text);
  return Number.isInteger(value) ? value : undefined;
}

/** 排序输入是否非法（用于表单校验提示）：空串合法，非整数非法。 */
export function isSortOrderInvalid(raw: string): boolean {
  const text = raw.trim();
  return text !== '' && !Number.isInteger(Number(text));
}
