# 02 · 数据模型

> 本文件拥有：实体与字段、类型与枚举、不变式、状态机、位置路径物化规则、Dexie schema 与版本升级纪律、ID 生成、删除语义、统计口径、搜索口径。
> 存储介质与打包见 [01-architecture.md](./01-architecture.md)；导入合并的冲突裁定见 [03-backup-and-merge.md](./03-backup-and-merge.md)。

---

## 1. 实体关系

```
Location ──┐ (parentId 自引用，构成树)
           │
           │ locationId
           ▼
Book ──── Copy ──── Loan
 (1)      (1..n)     (0..n，其中至多 1 条 active)
           │
           └── bookId → Book
```

四条业务线，对应原文案四个核心概念：

| 概念 | 实体 | 关键点 |
|---|---|---|
| 位置 | `Location` | 自引用树，路径物化 |
| 书目 | `Book` | 一本书的通用信息，按 ISBN 查重 |
| 副本 | `Copy` | 手里这一本，挂在位置上，**可以有多本** |
| 借出 | `Loan` | 挂在**副本**上，不挂书目 |

---

## 2. Location（位置）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | ✅ | UUID v4；顶层「未分类」为保留常量（§7.2） |
| `parentId` | `string \| null` | ✅ | `null` 表示顶层 |
| `name` | `string` | ✅ | 单层名称，如「白书架A」 |
| `path` | `string` | ✅ | **物化缓存**，如 `家 / 客厅 / 白书架A / 第3层`（§4） |
| `depth` | `number` | ✅ | 0 起算，`path` 的层数减一；由重建过程写入 |
| `type` | `LocationType` | ✅ | `home` \| `room` \| `shelf` \| `layer`，按 `depth` 推导后物化；仅作图标与文案提示，业务逻辑不得依赖它 |
| `sortOrder` | `number` | ✅ | 同一父节点下的排序键，默认取「插入时的递增序号」 |
| `createdAt` | `string` | ✅ | ISO 时间戳 |
| `updatedAt` | `string` | ✅ | ISO 时间戳，任何字段变更都要刷新 |

**为什么存 `type` 而不只用 `depth`**：导出文件要自解释，UI 要选图标。但层级深度是自由的（允许 `家 > 阳台 > 纸箱` 这种不规范树），所以 `type` 只是提示，**不是约束**——不要写「type 必须是 shelf 才能放书」这类校验。

**层级规则**：
- 任意深度都允许，不强制四级。
- 新建子位置时，`depth = parent.depth + 1`，`type` 按 `depth` 推导（0=home, 1=room, 2=shelf, ≥3=layer）。
- 循环引用是非法数据（见 §5 不变式 I5），导入时必须检测并打断。

---

## 3. Book（书目）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | ✅ | UUID v4 |
| `isbn` | `string` | ✅ | **规范化后**的 ISBN-13（无连字符）；未知时为空串 `''`（§7.3） |
| `title` | `string` | ✅ | 书名；允许为空串（先存后补的场景） |
| `authors` | `string[]` | ✅ | 作者，默认 `[]` |
| `publisher` | `string` | ✅ | 出版社，未知为空串 |
| `publishDate` | `string` | ✅ | 出版日期，未知为空串；可能是 `2014` 或 `2014-05-01` |
| `coverUrl` | `string` | ✅ | 封面图 URL，未知为空串。v1 不做离线化（01 §10） |
| `tags` | `string[]` | ✅ | 标签，默认 `[]` |
| `createdAt` | `string` | ✅ | ISO 时间戳 |
| `updatedAt` | `string` | ✅ | ISO 时间戳 |

**为什么 `authors` 是数组而不是原文案的 `author` 字符串**：Open Library / Google Books 返回的就是数组；合成一个字符串会丢掉结构，之后想按作者精确筛选、或做「同一作者的其他书」，都得反过来拆字符串。UI 展示时 `authors.join(' / ')` 即可，成本为零。

**为什么字段全部必填且用空值而不是 `undefined`**：IndexedDB 的索引不收录 `undefined`，字段时有时无会让「查 xx 为空的书」这类查询行为不一致。全字段存在 + 空值默认，导出文件也规整。

---

## 4. Copy（副本）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | ✅ | UUID v4 |
| `bookId` | `string` | ✅ | 所属书目 |
| `locationId` | `string` | ✅ | 所在位置；**不允许为空**，位置未知时指向「未分类」（§7.2） |
| `status` | `CopyStatus` | ✅ | `on_shelf` \| `lent_out` \| `lost` \| `sold` |
| `condition` | `CopyCondition` | ✅ | `new` \| `good` \| `fair` \| `poor` \| `unknown`，默认 `unknown` |
| `owner` | `string` | ✅ | 拥有者，默认空串（朋友合库时区分「我的」「老张的」） |
| `note` | `string` | ✅ | 备注，默认空串 |
| `createdAt` | `string` | ✅ | ISO 时间戳 |
| `updatedAt` | `string` | ✅ | ISO 时间戳 |

状态语义：

| 状态 | 中文 | 是否终态 | 说明 |
|---|---|---|---|
| `on_shelf` | 在架 | 否 | 默认状态 |
| `lent_out` | 借出 | 否 | **由借出记录派生**，不允许手工直接设置 |
| `lost` | 丢失 | 是 | 终态；无需归还 |
| `sold` | 卖掉 | 是 | 终态 |

---

## 5. Loan（借出）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | ✅ | UUID v4 |
| `copyId` | `string` | ✅ | 哪一本副本 |
| `borrower` | `string` | ✅ | 借给谁 |
| `contact` | `string` | ✅ | 联系方式，默认空串 |
| `loanDate` | `string` | ✅ | 借出日期 `YYYY-MM-DD`（本地日历日） |
| `dueDate` | `string` | ✅ | 应还日期 `YYYY-MM-DD`；未设定为空串 |
| `returnDate` | `string` | ✅ | 归还日期 `YYYY-MM-DD`；未归还为空串 |
| `status` | `LoanStatus` | ✅ | `active` \| `returned` |
| `note` | `string` | ✅ | 备注，默认空串。导入冲突会在此追加说明（03 §5） |
| `createdAt` | `string` | ✅ | ISO 时间戳 |
| `updatedAt` | `string` | ✅ | ISO 时间戳 |

**为什么用空串而不是 `null` 表示「未设定」**：与 §3 同理，保持字段恒存在、类型恒为 `string`，避免 `null`/`undefined`/`''` 三态混乱。判断「有到期日」用 `dueDate !== ''`。

---

## 6. 不变式（Invariants）

这些是数据正确性的判据，**`repair.ts` 必须能检查并修复**（导入后、启动时各跑一次）。

| # | 不变式 | 违反时的处置 |
|---|---|---|
| I1 | 每个 `Copy.bookId` 指向存在的 `Book` | 无法修复（不知道是哪本书）→ 删除副本并记警告 |
| I2 | 每个 `Copy.locationId` 指向存在的 `Location` | 改指「未分类」并记警告 |
| I3 | 每个 `Loan.copyId` 指向存在的 `Copy` | 删除借出记录并记警告（孤儿借出无意义） |
| I4 | 每个 `Location.parentId` 为 `null` 或指向存在的 `Location` | 改为「未分类」（即 `parentId = UNSORTED_ID`）并记警告 |
| I5 | 位置树无环 | 打断环：把环内某个节点挂到「未分类」并记警告 |
| I6 | 一个副本**至多一条** `status='active'` 的 `Loan` | 保留 `loanDate` 最新的一条为 active，其余转 `returned`（`returnDate` = 保留者的 `loanDate`，`note` 追加冲突说明）并记警告 |
| I7 | `Copy.status='lent_out'` ⟺ 该副本存在 active 借出（`lost`/`sold` 除外） | 有 active 借出但状态不对 → 置 `lent_out`；状态是 `lent_out` 但无 active 借出 → 置 `on_shelf`；副本是 `lost`/`sold` 但有 active 借出 → 关闭该借出（`returnDate` = 当天，`note` 追加说明） |
| I8 | `Location.path` / `depth` 与树的实际结构一致 | 整树重算（§4） |
| I9 | 不存在 `id` 重复的多行 | 不可能的数据库层面情况；导入时以 `id` 为准合并（03） |

**I6 的优先级说明**：导入时的冲突裁定见 03 §5，那里的规则是「本地优先」，与本表 I6 的「保留最新」不同——I6 是**修复已损坏数据**时的兜底，两者不冲突，因为修复只在导入后对确实违规的数据生效。

---

## 7. 标识与值域

### 7.1 UUID v4

`src/domain/ids.ts` 提供 `newId()`，用 `crypto.getRandomValues()` 自行构造 v4（`xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`，`y` ∈ `[89ab]`）。

**不用 `crypto.randomUUID()` 的原因见 01 §1.1**：它被 secure context 门控，而 Tauri 各平台的 origin 判定不一致。若运行时存在 `crypto.randomUUID` 则作为快路径，但正确性不依赖它。

ID 由**设备本地生成**，因此天然全局唯一——这是导入合并按 id 对齐的前提（03 §4）。

### 7.2 保留常量：未分类

```ts
export const UNSORTED_LOCATION_ID = '__unsorted__';
```

- 数据库初始化时播种这一行：`{ id: UNSORTED_LOCATION_ID, parentId: null, name: '未分类', path: '未分类', depth: 0, type: 'home' }`。
- **不可删除、不可重命名、不可移动**（service 层拦截）。
- 它的用途：位置未知的副本、导入时父节点缺失的位置、被删位置下的副本——都收容到这里。有了它，`Copy.locationId` 才能是「必填且总有效」。
- 字面量不含连字符，不可能与 UUID 冲突。

### 7.3 ISBN 规范化

`src/domain/isbn.ts`：

```
normalizeIsbn(raw) → { isbn13: string, valid: boolean }
```

规则：
1. 去掉连字符、空格、全角字符，`X` 转大写。
2. 校验位验证（ISBN-10 mod 11 / ISBN-13 mod 10）。
3. **ISBN-10 有效则转换为 ISBN-13**（前缀 `978`，重算校验位）——决策 D4，否则同一本书手工录 `0-306-40615-2`、扫码得 `9780306406157` 会变成两条书目。
4. 无效或为空 → 返回 `{ isbn13: '', valid: false }`，**不阻塞保存**（中文书元数据本来就不全，原则「先存后补」）。

`Book.isbn` 一律存 `normalizeIsbn` 的结果。查重键即 `isbn`，空串不参与查重（避免所有无 ISBN 的书互相碰撞）。

---

## 8. Dexie schema

```ts
// src/db/schema.ts
this.version(1).stores({
  locations: 'id, parentId, path, type, [parentId+sortOrder]',
  books:     'id, isbn, title, createdAt, updatedAt, *tags',
  copies:    'id, bookId, locationId, status, [bookId+locationId]',
  loans:     'id, copyId, status, dueDate, [copyId+status]',
  settings:  'key',
});
```

说明：
- `*tags` 是 Dexie 的 multiEntry 索引，用于按标签筛选（已实测可用）。
- **`parentId` 为 `null` 的记录不会进入索引**（IndexedDB 不索引 `null`）。顶层位置的查询在内存里做（`parentId === null` 过滤）。位置数量是几百级，无性能问题。
- `books.title` 上的索引只用于排序；关键词搜索是内存过滤（§10）。
- `settings` 是键值表：`key` 主键，`value` 任意可 JSON 化的值，另有 `updatedAt`。

### 8.1 版本升级纪律

1. 已写入代码的 `version(N)` **一个字都不许改**。老用户升级时会从 N 逐级跑到最新，改了就等于把他们的迁移路径改坏。
2. 加字段 → 新增 `version(N+1)`，`upgrade()` 里给老数据补默认值：

```ts
this.version(2).stores({
  books: 'id, isbn, title, createdAt, updatedAt, *tags, language',
}).upgrade(tx => tx.table('books').toCollection().modify(b => { b.language ??= ''; }));
```

3. 删索引/删表要谨慎：先发一版只停止使用，下一版再删。
4. 数据结构变更后，**必须同时升级备份文件的 `schemaVersion`**（03 §3.3）。

---

## 9. 删除语义

| 操作 | 规则 |
|---|---|
| 删位置 | 有子位置或有副本时**默认拒绝**。调用方必须显式给策略：`reparent`（子位置与副本上移到父位置）\| `cascade`（连同子位置、位置下的副本一并删除，副本对应的借出记录也删）。UI 必须二次确认，并明确告知将删除多少副本。 |
| 删位置 → 副本上移 | 副本的 `locationId` 改为被删位置的 `parentId`；若为顶层则改为 `UNSORTED_LOCATION_ID`。 |
| 删书目 | 有副本时**默认拒绝**，UI 引导先把副本逐个删除或转移；副本为 0 时允许删除（其历史借出随副本删除）。级联删除（连副本带借出记录一起删）是显式例外：只允许走 `deleteBookCompletely(db, bookId, { strategy: 'cascade' })`，UI 必须二次确认并写明将删除的副本数、借出记录数与正被借出的副本名单。 |
| 删副本 | 连带删除其全部借出记录（`Loan.copyId` 是 I3）。已借出的副本删除前必须二次确认，文案要写明「该副本正被 XX 借出」。 |
| 清空数据 | 删除四个业务表全部记录，重新播种「未分类」与默认 `settings`；保留界面主题等本机偏好。 |

**级联删除是不可逆的重操作**，`cascade` 策略必须在函数的签名里显式传参，不允许作为默认值。

---

## 10. 统计与搜索口径

### 10.1 统计（`stats.ts`）

| 指标 | 口径 |
|---|---|
| 书目数 | `books.count()` |
| 副本数 | `copies.count()` |
| 在架 / 借出 / 丢失 / 卖掉 | 按 `copies.status` 分组计数 |
| 借出未还 | `loans` 中 `status='active'` 的条数（与上一条「借出」应恒等，不一致即为 I7 违规） |
| 逾期未还 | active 借出中 `dueDate !== ''` 且 `dueDate < 今天` 的条数 |
| 各位置藏书量 | **两种口径都给**：`direct`（直接放在该位置的副本数）+ `subtree`（含所有子位置）。UI 默认显示 `subtree`，因为用户问「客厅有多少本书」时指的是后者 |
| 重复书籍 | ① **同一 ISBN 存在多条书目记录**（导入后可能发生，必须能查到）② 书名规范化（去空格与标点，**`#` 与 `+` 除外** —— 它俩抹平会把「C#」「C++」归一成同一本「C」）相同但 ISBN 不同的书目，标为「疑似重复」 |

### 10.2 搜索（`books.ts`）

`searchBooks({ keyword, locationId, status, tag, limit })`

- **关键词**：对 `title` / `authors` / `isbn` / `tags` / `publisher` 做不区分大小写的子串匹配（中文无大小写概念，直接 `includes`）。非空 `keyword` 时忽略长度小于 1 的输入。
- **位置过滤**：`locationId` 命中**该位置及其所有子位置**（子树口径，与统计一致）。
- **组合**：所有条件同时生效（AND）。`tag` 是书目维度的条件，单独用它时允许「有标签但一本实体都没有」的书出现；一旦同时给了 `locationId` / `status`，就必须真有符合条件的副本，否则该书不出现。
- **`limit`**：结果条数上限，在排序之后截断。它与「有没有筛选条件」无关 —— 不传任何筛选的「列全部」分支同样受它约束（曾经只有带筛选的分支生效，已修）。
- **实现**：`books` 全表读进内存过滤。理由是数据量在千级，IndexedDB 的 `filter()` 反而更慢且不支持跨表联查；跨表（副本、位置）本来就要在内存里 join。
- **返回**：`{ book, copies: CopyWithLocation[], matched: MatchField[] }`，其中 `CopyWithLocation = Copy & { locationPath: string; locationName: string; activeLoan: Loan | null }`。搜索列表要显示「位置路径 + 状态」，所以必须在数据层一次拼好，不让 UI 自己联表。

**性能阀值**：若某天书目超过约 5000 条，需改为「先按索引粗筛再内存精筛」。现在不做，但在此记录阀值，避免以后误以为是设计失误。

---

## 11. 字段的读写责任

| 字段 | 谁写 |
|---|---|
| `createdAt` | service 创建时写一次，之后**永不修改**（导入也一样，取本地与传入的较早值） |
| `updatedAt` | 所有 service 写操作刷新；导入合并按它做「后写覆盖」判断（03 §5） |
| `Location.path` / `depth` | **只有 `rebuildLocationPaths()` 写**，其他任何地方不许直接赋值 |
| `Copy.status` | `on_shelf`/`lost`/`sold` 由副本 service 写；`lent_out` **只能**由借出 service 通过 I7 派生，不手工设置 |
| `Loan.status` | 借出 service（`loanOut` / `returnCopy` / 导入冲突裁定） |
