# 03 · 备份格式与导入合并

> 本文件拥有：备份文件格式与校验、导出规则、导入合并算法、冲突裁定、修复通道、幂等性要求、导入摘要、测试用例清单。
> 实体字段定义见 [02-data-model.md](./02-data-model.md)；不变式 I1–I9 见 02 §6。

「朋友之间共享」在本地优先架构下没有别的路可走：数据只能靠文件交换。因此**合并算法是本项目唯一有真实算法复杂度的地方**，也是唯一一处「写错就悄悄丢书」的地方。这一层必须先写测试。

---

## 1. 设计约束

1. **导入绝不静默丢数据。** 任何被跳过的记录都要出现在摘要的警告列表里，且能说清是哪一条、为什么。
2. **导入幂等。** 同一个文件导入两次，第二次必须产生 0 处变更。这是「朋友反复发同一份清单」的常态。
3. **导入可预览。** 真实写入前必须能给出完整摘要（`previewImport`），UI 据此让用户确认。
4. **两个模式，语义分明**：`merge`（默认，合并）与 `replace`（清空后恢复，用于从备份还原）。
5. **导入不覆盖正在进行的借出**（决策 D6，本地优先）。

---

## 2. 备份文件格式

```jsonc
{
  "format": "pocket-library-backup",   // 固定字符串，用于识别
  "formatVersion": 1,                  // 文件格式版本
  "schemaVersion": 1,                  // 导出时的 Dexie schema 版本（02 §8.1）
  "exportedAt": "2026-09-11T11:39:52.000Z",
  "deviceName": "我的笔记本",            // 仅用于摘要展示，导入时忽略
  "counts": { "locations": 12, "books": 86, "copies": 91, "loans": 24 },
  "data": {
    "locations": [ /* Location[] */ ],
    "books":     [ /* Book[] */ ],
    "copies":    [ /* Copy[] */ ],
    "loans":     [ /* Loan[] */ ]
  }
}
```

**不导出 `settings`。** 理由：里面是「本机偏好 + 快照计数 + 上次导出时间」这类设备专属状态，导入别人的设置只会制造混乱。需要跨设备带走的配置项（如二维码基址）在后续版本里单独做白名单（§6）。

### 2.1 示例（最小可用文件）

```json
{
  "format": "pocket-library-backup",
  "formatVersion": 1,
  "schemaVersion": 1,
  "exportedAt": "2026-09-11T11:39:52.000Z",
  "deviceName": "我的笔记本",
  "counts": { "locations": 2, "books": 1, "copies": 1, "loans": 0 },
  "data": {
    "locations": [
      { "id": "__unsorted__", "parentId": null, "name": "未分类", "path": "未分类", "depth": 0, "type": "home", "sortOrder": 0, "createdAt": "2026-09-01T00:00:00.000Z", "updatedAt": "2026-09-01T00:00:00.000Z" },
      { "id": "5f0c...", "parentId": null, "name": "家", "path": "家", "depth": 0, "type": "home", "sortOrder": 1, "createdAt": "2026-09-01T00:00:00.000Z", "updatedAt": "2026-09-01T00:00:00.000Z" }
    ],
    "books": [
      { "id": "9a1b...", "isbn": "9787508647357", "title": "人类简史", "authors": ["尤瓦尔·赫拉利"], "publisher": "中信出版社", "publishDate": "2014", "coverUrl": "", "tags": ["历史"], "createdAt": "2026-09-01T00:00:00.000Z", "updatedAt": "2026-09-01T00:00:00.000Z" }
    ],
    "copies": [
      { "id": "c3d4...", "bookId": "9a1b...", "locationId": "5f0c...", "status": "on_shelf", "condition": "good", "owner": "", "note": "", "createdAt": "2026-09-01T00:00:00.000Z", "updatedAt": "2026-09-01T00:00:00.000Z" }
    ],
    "loans": []
  }
}
```

---

## 3. 校验与版本兼容

`parseBackup(text)` → `{ ok: true, backup } | { ok: false, error }`，**不抛异常**（UI 要展示原因）。

| 检查 | 失败时 |
|---|---|
| 是合法 JSON | 「文件不是合法的 JSON，可能不是备份文件或已损坏」 |
| `format === 'pocket-library-backup'` | 「这不是掌上图书馆的备份文件」 |
| `formatVersion` 是数字且 `<= 1` | 「此备份文件的格式版本（N）比当前版本更新，请升级 App」 |
| `schemaVersion` 是数字且 `<= 当前 schema 版本` | 同上，文案提示是数据版本更新 |
| `data` 是对象且四个数组存在 | 「备份文件缺少必要的数据段」 |

### 3.1 容错原则：宽进严出

- **数组缺失**视为空数组（继续导入，记警告），不直接失败——用户手改过文件也应当能救回数据。
- **单条记录缺字段**：用 02 的默认值补全（空串 / `[]` / `unknown` / 导出时间），记警告，**逐字段提示**（「书目 b1 缺少字段 publisher，已按空串导入」）。判据是「文件里根本没有这个字段」——空串 / 空数组是用户显式写下的值，不算缺字段。`createdAt` / `updatedAt` 缺失或非法同样补齐并提示：用户看到的时间要是编出来的，他必须知道。
- **只有 `id` 缺失或不是非空字符串才丢弃该条**，并记警告。`bookId`（副本）/ `copyId`（借出）缺失同样在清洗阶段丢弃该条并记警告——引用字段缺了，这条记录没有可落地的含义（§4.3、§4.4 对「指向不存在的对象」是同样的处理）。
- **未知字段直接忽略**（不写入数据库），这样未来版本加字段不会污染老版本。

### 3.2 导出规则

- `counts` 由导出时实时统计，导入时**忽略**（只作人工核对）。
- 数组按 `id` 升序输出，使同一份数据多次导出的结果稳定可比对。
- 时间戳原样输出（本来就是 ISO 字符串）。
- 导出必须包含「未分类」位置（它是所有副本位置的兜底，缺了它导入端要重建）。
- 导出使用**数据层已有的读取路径**（一次性 `toArray()` 四张表），不引入第二套序列化。

---

## 4. 合并算法

全程在**一个 `rw` 事务**里完成（`locations` + `books` + `copies` + `loans` + `settings`）。任一步抛错则整体回滚——宁可没导入，也不能半途而废留下半套数据。

```
applyImport(backup, { mode }):
  1. 校验（§3）
  2. mode === 'replace' → 清空四张表，重新播种「未分类」
  3. 确保「未分类」位置存在（merge 模式下本地本来就有，兜底一次）
  4. 合并 locations（§4.1）
  5. 合并 books，产出 idRemap（§4.2）
  6. 合并 copies，用 idRemap 重指向（§4.3）
  7. 合并 loans，做冲突裁定（§4.4）
  8. 修复通道：rebuildLocationPaths() + repairInvariants()（02 §6）
  9. 统计写入次数，返回摘要（§7）
```

### 4.1 位置

```
incomingIds = set(所有传入 location.id)

对每条传入位置 L（跳过 id 非法的，记警告）：
  本地已存在同 id → 字段级合并（§5.1）；统计 updated（无实际变化则不计）
  本地不存在      → 插入；统计 inserted

第二遍（必须在全部插入之后做，因为父节点可能在数组后面）：
  对每条传入位置 L：
    若 L.parentId !== null 且 L.parentId 不在本地库中：
      L.parentId = UNSORTED_LOCATION_ID；统计 reparented；记警告
      （注意：即使父节点就在同一份文件里，只要它在前面这一遍里被丢弃了，
        这里也必须兜底——判断依据是"本地库里现在有没有"，不是"文件里有没有"）
```

**不做按名字自动合并位置**（例如两边都有「家 / 客厅 / 白书架A」）。理由：书架重名是常见且合法的，自动合并会静默改变副本的归属。改为在摘要里列出「可能与本地重名的位置」提示用户，人工合并工具列入后续项。

### 4.2 书目（两遍，这是合并的核心）

```
idRemap: Map<传入书目的 id, 本地书目的 id>

第一遍 —— 按 id 对齐：
  本地已有该 id         → 字段级合并；记录映射 L.id → 本地 id
  本地没有              → 先不动，留给第二遍判断

第二遍 —— 按 ISBN 对齐（只处理第一遍里本地没有的那些）：
  isbn === ''           → 无法判断 → 直接插入新书目（空 ISBN 不参与查重，02 §7.3）
  本地存在同 isbn 的书目 → 视为同一本书：
                            字段级合并；idRemap.set(传入id, 本地id)；统计 mergedByIsbn
  否则                  → 插入新书目
```

**为什么必须做 idRemap**：A、B 各自录了同一本《人类简史》，产生了两个不同的书目 id。按 ISBN 合并后只能留一条书目，此时 B 的副本还指着 B 的书目 id——不重指向，这些副本就会指向一条被丢弃的记录（即 I1 违规，副本消失）。

**标签做并集，不做覆盖**：标签是人工积累的、丢了很难重建，而且并集是无损操作。其余字段按 `updatedAt` 后写覆盖。

### 4.3 副本

```
对每条传入副本 C：
  目标书目 id = idRemap.get(C.bookId) ?? C.bookId
  若目标书目在本地不存在：
      丢弃该副本，统计 skipped，记警告
      ——"副本指向不存在的书目"是数据损坏，宁可报告也不能凭空造一本书
  本地已有同 id → 字段级合并；若 bookId 发生了变化，同样计入 updated
  本地没有      → 插入，bookId 用目标书目 id

位置处理：C.locationId 在本地不存在 → 改为 UNSORTED_LOCATION_ID，
          统计 relocations，记警告（正常流程下不该发生，除非对方文件不完整）
```

副本 id 是设备本地生成的 UUID，**不存在跨设备撞号的合理场景**，因此副本一律按 id 对齐，不做任何"按内容猜同一本"的合并。两条同名同 ISBN 的副本就是两本实体书，不能合并。

### 4.4 借出（本地优先）

```
对每条传入借出 L：
  本地已有同 id → 字段级合并（正常路径，覆盖不了什么，因为借出记录基本只追加）
  本地没有：
      若 L.status === 'returned' → 直接插入（历史记录，永远安全）
      若 L.status === 'active'：
          查本地该 copyId 是否已有 active 借出 A
            没有    → 插入
            有      → 冲突（§5.2）
```

### 4.5 冲突裁定表

| 冲突 | 裁定 | 依据 |
|---|---|---|
| 同一位置 id，两边字段不同 | `updatedAt` 晚者胜（`tags` 除外） | 简单、可预测；时钟偏差的局限见 §8 |
| 同一书目 id / 同一 ISBN，两边字段不同 | 同上；`tags` 取并集 | 标签并集无损，其余 LWW |
| 同一 ISBN，两个不同书目 id | 合并为本地那一条（保住本地 id），传入的 id 全部重指向它 | 本地 id 已被本地副本引用，改本地 id 代价更大 |
| 副本指向的书目不存在 | 丢弃副本 + 警告 | 不可修复，且造假更糟 |
| 副本指向的位置不存在 | 改指「未分类」+ 警告 | 位置可兜底，书不能丢 |
| **同一副本同时存在两条 active 借出** | **本地那条保持 active**；传入那条转 `returned`，`returnDate` = 本地那条的 `loanDate`，`note` 追加「导入冲突：与本地借出记录重叠」；记警告，警告里带书名与借书人 | 决策 D6：正在进行的借出是现实状态，导入不该改本地现实；`returnDate` 取本地借出的开始日，至少保证时间线自洽（书先还回来，才能再借出去） |
| 位置父子关系缺失 / 成环 | 缺失 → 挂「未分类」；成环 → 打断环，环内一个节点挂「未分类」（02 §6 I5） | 保证路径重建能终止 |

---

## 5. 字段级合并规则

### 5.1 `mergeRecord(local, incoming)`

```
若 incoming.updatedAt > local.updatedAt：
    取 incoming 的全部业务字段
否则：
    保留 local 的全部业务字段
无论哪边胜：
    id       → 永远取 local.id（对齐的锚点）
    createdAt→ 取两者中较早的（同一实体不可能有两个创建时间）
    若 length 字段是 tags → 取并集（去重，稳定排序）
返回 { record, changed }   // changed 为 false 表示合并后与 local 完全一致
```

`changed === false` 的记录**不计入 updated 统计**、也不写库。这是幂等性的实现基础。

### 5.2 时钟不可靠的应对

`updatedAt` 是设备本地时间，两台设备时钟不同步时 LWW 可能选错。**接受这个局限**（小范围熟人使用，且冲突结果可在摘要中看到）。不引入向量时钟或 CRDT —— 复杂度与收益完全不成比例。

---

## 6. 导入模式

| 模式 | 语义 | 用途 |
|---|---|---|
| `merge`（默认） | 按 §4 合并，本地已有数据保留 | 朋友交换清单、增量合并 |
| `replace` | 先清空四张表，再整体写入 | 从备份还原、换设备迁移 |

`replace` 的额外要求：
- UI 必须二次确认，文案写明「将删除本机现有的全部藏书数据」。
- 清空后重新播种「未分类」（02 §7.2）。
- 仍然走同一套写入逻辑（不是另一个函数），只是跳过 `idRemap` 相关的判断——落地方式：`replace` 就是「清空 + merge」，因为清空后不存在任何本地记录，merge 的行为自然退化为整体导入。**不允许为 replace 写第二套导入代码。**

---

## 7. 导入摘要

`previewImport` 与 `applyImport` 返回**同一个结构**，前者 `dryRun: true`：

```ts
interface ImportSummary {
  mode: 'merge' | 'replace';
  dryRun: boolean;
  locations: { inserted: number; updated: number; reparented: number; conflictingNames: string[] };
  books:     { inserted: number; updated: number; mergedByIsbn: number };
  copies:    { inserted: number; updated: number; skipped: number; relocated: number };
  loans:     { inserted: number; updated: number; skipped: number; conflicts: number };
  warnings:  string[];        // 人话，可直接展示给用户
  durationMs: number;
}
```

`warnings` 的文案要求：**说清是哪一条、为什么**。例如「副本《人类简史》指向的书目不存在，已跳过」，而不是「3 条记录被跳过」。

同一句话不重复出现（去重），且总量封顶 200 条，超出部分收成一句「另有 N 条同类提示被省略」——一个坏文件不该把 UI 刷出上千行提示。

**预览的实现方式**：目前采用「在同一事务里跑完整流程，最后抛出一个标记异常回滚」，而不是维护两条代码路径——避免预览与实际执行行为不一致（这类不一致正是丢数据的经典来源）。代价是预览也要完整跑一遍，数据量千级时可忽略。

---

## 8. 幂等性

**定义**：对同一个备份文件，`applyImport` 连续执行两次，第二次的摘要必须满足
`inserted` 全为 0、`updated` 全为 0、`conflicts` 为 0、`warnings` 为空。

这是硬性验收条件，必须有测试覆盖（§10 T7）。实现要点：
- §5.1 的 `changed` 判断——没变化就不写。
- 位置重建（`rebuildLocationPaths`）是幂等的（同样输入必得同样输出）。
- 修复通道（`repairInvariants`）在数据已合规时不产生任何写入。

---

## 9. 表头字段清单（供实现对照）

`BackupFile` / `ImportSummary` / `ImportOptions` 的类型定义写在 `src/backup/format.ts`，本文件 §2、§7 即其规范。任何字段增删都要同步改这里。

---

## 10. 测试用例清单

`src/backup/*.test.ts` 必须覆盖（括号内是断言要点）：

| # | 用例 | 断言 |
|---|---|---|
| T1 | 空库导入完整备份 | 四张表计数与文件一致；「未分类」存在 |
| T2 | 导出一份数据再导入自身（同库） | 全部 inserted=0、updated=0；T7 的幂等前提 |
| T3 | 同一 ISBN、不同书目 id（两边各录了同一本书） | 书目只有 1 条；`mergedByIsbn=1`；传入方的副本**仍指向该书目**且副本数不变 |
| T4 | 传入副本指向的书目不在本地也不在文件里 | 该副本被跳过；`warnings` 含其书名；无 I1 违规 |
| T5 | 传入位置指向的父位置缺失 | 该位置 `parentId` 变成「未分类」；`reparented=1`；路径重建后可读 |
| T6 | 同一副本两条 active 借出 | 本地那条仍为 active；传入那条为 `returned` 且 `note` 含冲突说明；`conflicts=1` |
| T7 | 同一文件连续导入两次 | 第二次全部为 0 变更，`warnings` 为空（§8） |
| T8 | 位置成环（A→B→A） | 导入不挂死；环被打断；有警告；`rebuildLocationPaths` 正常返回 |
| T9 | 非法输入：非 JSON / 缺 `format` / `formatVersion` 过高 / `data` 非对象 | 返回 `ok:false` 与对应错误文案，**不抛异常** |
| T10 | 记录缺字段（缺 `tags`、缺 `publisher`） | 用默认值补全；导入成功；有警告 |
| T11 | 记录 `id` 缺失或为空 | 该条被丢弃；其余记录正常导入 |
| T12 | `replace` 模式 | 本地原有数据被清除；文件中数据完整导入；「未分类」被重新播种 |
| T13 | 借出记录、副本状态与不变式的联动 | 导入后 I7 成立（`lent_out` ⟺ 有 active 借出） |
| T14 | 传入标签与本地标签不同 | 取并集，两边标签都保留 |
| T15 | `previewImport` | 返回与 `applyImport` 相同的摘要结构，且**数据库无任何变化** |
| T16 | 事务回滚 | 某条记录写入失败时，整个导入不留下部分数据 |
