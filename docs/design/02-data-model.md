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

Borrower  借书人候选（独立表，无外键；Loan.borrower 是历史字符串快照，见 §5.5）
Snapshot  快照（系统表，供删除撤销与全库回滚，见 §12）
```

六张表对应六类实体：

| 概念 | 实体 | 关键点 |
|---|---|---|
| 位置 | `Location` | 自引用树，路径物化 |
| 书目 | `Book` | 一本书的通用信息，按 ISBN 查重 |
| 副本 | `Copy` | 手里这一本，挂在位置上，**可以有多本** |
| 借出 | `Loan` | 挂在**副本**上，不挂书目 |
| 借书人 | `Borrower` | 借书人候选（P0-3）；无外键，与 Loan 解耦 |
| 快照 | `Snapshot` | 删除撤销 + 自动快照共用（P0-4）；不参与业务外键 |
| 封面 | `Cover` | 书目的一对一封面照片（本地 Blob，B4）；进备份不进自动快照，见 §3.5 |

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

## 3.5 Cover（封面照片，B4）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `bookId` | `string` | ✅ | 主键（一本书至多一张），指向 `Book.id` |
| `blob` | `Blob` | ✅ | 压缩后的 JPEG（长边 ≤1000px） |
| `mime` | `string` | ✅ | 固定 `image/jpeg`（v1 只收这一种） |
| `createdAt` | `string` | ✅ | ISO 时间戳 |
| `updatedAt` | `string` | ✅ | ISO 时间戳，重拍刷新 |

规则：
- 照片**只存本机**（IndexedDB Blob），不上传任何服务。
- 一本书一张：重拍 = 覆盖同一行（`bookId` 主键）。
- 删书目级联删封面；**撤销删除时封面一并恢复**（undo 快照含封面，§12.2）。
- 自动/恢复快照**不含封面**（否则 10 份快照各复制一遍照片）；快照回滚不动封面表，
  孤儿封面由 `repairInvariants` 清理（§6 I10）。
- **进备份文件**（03 §2 的 `data.covers`，base64 data URL），换设备封面不丢。

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
| `note` | `string` | ✅ | 备注，默认空串。导入冲突会在此追加说明（03 §4.6） |
| `createdAt` | `string` | ✅ | ISO 时间戳 |
| `updatedAt` | `string` | ✅ | ISO 时间戳 |

**为什么用空串而不是 `null` 表示「未设定」**：与 §3 同理，保持字段恒存在、类型恒为 `string`，避免 `null`/`undefined`/`''` 三态混乱。判断「有到期日」用 `dueDate !== ''`。

---

## 5.5 Borrower（借书人候选，P0-3）

借书人候选表解决「同一个朋友借第 N 次，还要重打名字和联系方式」。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | ✅ | UUID v4 |
| `name` | `string` | ✅ | 借书人姓名 |
| `contact` | `string` | ✅ | 联系方式，默认空串 |
| `createdAt` | `string` | ✅ | ISO 时间戳 |
| `updatedAt` | `string` | ✅ | ISO 时间戳 |

规则：
- **无外键**：`Loan.borrower` 是借出那一刻的历史字符串快照，不指向 Borrower——借书人
  改名后，历史借出记录仍显示当时的名字。
- **自动积累**：`loanOut` 成功后 upsert 一条候选——**`name` 一律存规范化姓名**
  （trim + 折叠连续空白），不存在则插入，存在则更新 `contact` 与 `updatedAt`。
- **手动管理**：设置页提供借书人管理区（增 / 改 / 删），删候选不影响任何借出记录；
  新增时同样按规范化姓名去重——重名视为更新该候选的联系方式。
- **上限 20 条**：超出时按 `updatedAt` 淘汰最旧的一条（候选是"最近常联系的人"，
  不是通讯录）。
- **进备份文件**：候选名单是业务数据，随 03 §2 的 `data.borrowers` 导出，换设备不丢。

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
| I10 | 每个 `Cover.bookId` 指向存在的 `Book` | 删除孤儿封面并记警告（B4） |

**I6 的优先级说明**：导入时的冲突裁定见 03 §4.6，那里的规则是「本地优先」，与本表 I6 的「保留最新」不同——I6 是**修复已损坏数据**时的兜底，两者不冲突，因为修复只在导入后对确实违规的数据生效。

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

- 数据库初始化时播种这一行：`{ id: UNSORTED_LOCATION_ID, parentId: null, name: '未分类', path: '未分类', depth: 0, type: 'home', sortOrder: 0, createdAt: 播种时刻, updatedAt: 播种时刻 }`。
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

// P0-4（schema v2，2026-09-13）：只加表，不改旧表 —— 无回填
this.version(2).stores({
  borrowers: 'id, name',
  snapshots: 'id, kind, createdAt',
});

// B4（schema v3，2026-09-13）：封面照片表（bookId 作主键，一本书一张）
this.version(3).stores({
  covers: 'bookId',
});
```

说明：
- `*tags` 是 Dexie 的 multiEntry 索引，用于按标签筛选（已实测可用）。
- **`parentId` 为 `null` 的记录不会进入索引**（IndexedDB 不索引 `null`）。顶层位置的查询在内存里做（`parentId === null` 过滤）。位置数量是几百级，无性能问题。
- `books.title` 上的索引只用于排序；关键词搜索是内存过滤（§10）。
- `settings` 是键值表：`key` 主键，`value` 任意可 JSON 化的值，另有 `updatedAt`。
- `borrowers.name` 索引用于查重（§5.5 规范化姓名唯一）；`snapshots.kind` 用于撤销/自动快照的筛选（§12）。
- `SCHEMA_VERSION` 升为 `3`；备份文件导出时携带它（03 §2 的 `schemaVersion`）。

### 8.1 版本升级纪律

1. 已写入代码的 `version(N)` **一个字都不许改**。老用户升级时会从 N 逐级跑到最新，改了就等于把他们的迁移路径改坏。
2. 加字段 → 新增 `version(N+1)`，`upgrade()` 里给老数据补默认值：

```ts
this.version(3).stores({
  books: 'id, isbn, title, createdAt, updatedAt, *tags, language',
}).upgrade(tx => tx.table('books').toCollection().modify(b => { b.language ??= ''; }));
```

3. 删索引/删表要谨慎：先发一版只停止使用，下一版再删。
4. 数据结构变更后，**必须同时升级备份文件的 `schemaVersion`**（03 §2 的 `schemaVersion` 字段）。

---

## 9. 删除语义

| 操作 | 规则 |
|---|---|
| 删位置 | 有子位置或有副本时**默认拒绝**。调用方必须显式给策略：`reparent`（子位置与副本上移到父位置）\| `cascade`（连同子位置、位置下的副本一并删除，副本对应的借出记录也删）。UI 必须二次确认，并明确告知将删除多少副本。 |
| 删位置 → 副本上移 | 副本的 `locationId` 改为被删位置的 `parentId`；若为顶层则改为 `UNSORTED_LOCATION_ID`。 |
| 删书目 | 有副本时**默认拒绝**，UI 引导先把副本逐个删除或转移；副本为 0 时允许删除（其历史借出随副本删除）。级联删除（连副本带借出记录一起删）是显式例外：只允许走 `deleteBookCompletely(db, bookId, { strategy: 'cascade' })`，UI 必须二次确认并写明将删除的副本数、借出记录数与正被借出的副本名单。**封面一并删除**（B4），撤销时随 undo 快照恢复。 |
| 删副本 | 连带删除其全部借出记录（`Loan.copyId` 是 I3）。已借出的副本删除前必须二次确认，文案要写明「该副本正被 XX 借出」。 |
| 清空数据 | 删除六张业务表（`locations`/`books`/`copies`/`loans`/`borrowers`/`covers`）全部记录，重新播种「未分类」；`settings` **不动**（保留主题、AI 配置、表单记忆等本机偏好，缺键由 `ensureDefaultSettings` 补齐）；快照表**不动**（清空后仍可用快照恢复，04 §11.4）。 |

**级联删除是不可逆的重操作**，`cascade` 策略必须在函数的签名里显式传参，不允许作为默认值。

### 9.1 删除撤销（P0-4）

删除不再是「点了就永久消失」：破坏性删除操作（删副本 / 删书目级联 / 删位置级联）在真正删除前，把受影响的记录捕获进
`kind='undo'` 的快照（§12），30 秒内可撤销。

| 操作 | 撤销范围 | 恢复方式 |
|---|---|---|
| 删副本（`deleteCopy`） | 该副本 + 其全部借出记录 | 按原 id 原样写回 |
| 删书目·级联（`deleteBookCompletely`） | 书目 + 全部副本 + 全部借出记录 | 按原 id 原样写回 |
| 删位置·级联（`deleteLocation` strategy=cascade） | 被删位置子树 + 其下副本 + 借出记录 | 按原 id 原样写回 |
| 删位置·上移（strategy=reparent） | 不产生 undo（没有数据被销毁） | — |
| 清空数据（`clearAllData`） | **不提供 undo**（二次确认 + 可用快照恢复，§12） | — |

规则：
- **一次只挂一份未撤销的 undo 快照**：新的删除操作顶掉旧的（旧的销毁，其恢复窗口结束）。
- 撤销按钮 30 秒超时后（或用户点了关闭），该 undo 快照被清理。
- 过期清理 API：`expireUndo(db, { olderThanMs })`（`now` 可注入以便测试）；横幅 30 秒
  超时与启动清理都走它（启动时 `olderThanMs=0` 即全清）。
- **撤销不跨会话**：应用启动时清理全部 `undo` 快照（04 §4 启动序列）——撤销横幅是
  会话内 UI 状态，重启后不重现；快照残留由启动清理兜底。
- 撤销恢复 = 按原 id 原样写回记录，随后跑 `rebuildLocationPaths()`（撤销位置级联删除后，
  其余位置若在 30 秒内被移动过，物化路径可能已变）；若 30 秒内用户已新建了同 ISBN 的书，
  撤销可能造成同 ISBN 两条书目——接受（02 §10.1 的重复书目口径会兜住，这是用户 30 秒内的连续操作）。
- **replace 导入与快照恢复前，先清理当前 undo 快照**：这两类操作整体替换业务表，
  30 秒窗口内的旧撤销会把已替换掉的数据写回来，语义混乱（03 §6、§12.4）。
- undo 快照的写入**不算业务写操作**，不计入写计数器（§12.3 计数口径），否则删除一次会同时触发
  快照阈值，语义混乱。
- 实现位置：`deleteCopy` / `deleteBookCompletely` / `deleteLocation` 三个删除函数在
  同一事务内经 `snapshots.ts` 的 `captureUndo()` API 先写 undo 快照再删（删除 service
  不直接读写快照表，§11）。捕获用「删除前先读」的方式：把将要删除的行读出来
  存进快照，而不是事后翻日志。

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

- **关键词**：对 `title` / `authors` / `isbn` / `tags` / `publisher` 做不区分大小写的子串匹配（中文无大小写概念，直接 `includes`）。`keyword` 去除首尾空白后为空时视为无关键词条件。
- **位置过滤**：`locationId` 命中**该位置及其所有子位置**（子树口径，与统计一致）。
- **组合**：所有条件同时生效（AND）。`tag` 是书目维度的条件，单独用它时允许「有标签但一本实体都没有」的书出现；一旦同时给了 `locationId` / `status`，就必须真有符合条件的副本，否则该书不出现。
- **`limit`**：结果条数上限，在排序之后截断。它与「有没有筛选条件」无关 —— 不传任何筛选的「列全部」分支同样受它约束（曾经只有带筛选的分支生效，已修）。
- **实现**：`books` 全表读进内存过滤。理由是数据量在千级，IndexedDB 的 `filter()` 反而更慢且不支持跨表联查；跨表（副本、位置）本来就要在内存里 join。
- **返回**：`{ book, copies: CopyWithLocation[], matched: MatchField[] }`，其中 `CopyWithLocation = Copy & { locationPath: string; locationName: string; activeLoan: Loan | null }`。搜索列表要显示「位置路径 + 状态」，所以必须在数据层一次拼好，不让 UI 自己联表。

**性能阀值**：若某天书目超过约 5000 条，需改为「先按索引粗筛再内存精筛」。现在不做，但在此记录阀值，避免以后误以为是设计失误。

### 10.3 列表查询（N1/N2，2026-09-13 追加）

搜索页与首页的两个新数据入口，实现在独立小模块 `db/listing.ts`（01 §5.1）：

- **`listAllTags(db)`**：返回全库去重标签，取 `books` 表的 `*tags` multiEntry 索引
  的 distinct 键，稳定排序（`localeCompare('zh')`）。供搜索页标签下拉（N1，04 §11.5）。
- **`listRecentBooks(db, { limit })`**：按 `createdAt` 倒序取最近录入的书目，
  返回 `{ book, copies: CopyWithLocation[] }`（与 §10.2 相同的组合视图，UI 不自己联表）。
  供首页「最近添加」区块（N2，04 §11.6）。

---

## 11. 字段的读写责任

| 字段 | 谁写 |
|---|---|
| `createdAt` | service 创建时写一次，之后**永不修改**（导入也一样，取本地与传入的较早值） |
| `updatedAt` | 所有 service 写操作刷新；导入合并按它做「后写覆盖」判断（03 §5） |
| `Location.path` / `depth` | **只有 `rebuildLocationPaths()` 写**，其他任何地方不许直接赋值 |
| `Copy.status` | `on_shelf`/`lost`/`sold` 由副本 service 写；`lent_out` **只能**由借出 service 通过 I7 派生，不手工设置 |
| `Loan.status` | 借出 service（`loanOut` / `returnCopy` / 导入冲突裁定） |
| `Borrower` 整表 | 借书人 service（`borrowers.ts`）与借出 service（`loanOut` 自动 upsert）；导入经 `merge-borrowers.ts` 委托 `borrowers.ts`（03 §4.5） |
| `Snapshot` 整表 | 快照 service（`snapshots.ts`）唯一写入；其他 service 不得直接读写快照表 |

---

## 12. Snapshot（快照，P0-4）

快照表同时服务两件事：**删除撤销**（§9.1）与**全库回滚**（自动快照）。

### 12.1 实体

```ts
interface Snapshot {
  id: string;                 // UUID v4
  kind: 'auto' | 'undo' | 'pre-restore';
  createdAt: string;          // ISO 时间戳
  summary: { locations: number; books: number; copies: number; loans: number; borrowers: number };
  data: {
    locations: Location[];
    books: Book[];
    copies: Copy[];
    loans: Loan[];
    borrowers: Borrower[];
  };
}
```

`data` 的形状与备份文件 `data` 段（03 §2）**完全一致**，复用同一套序列化路径
（`backup/export.ts` 的 `buildBackup`，序列化/类型在 `backup/format.ts`；快照经 `includeCovers:false` 跳过照片），
不另造结构。

**封面例外（B4）**：auto / pre-restore 快照的 `data` **不含 covers**（照片大，10 份快照
各存一遍会翻十倍）；`undo` 快照额外带 `covers?: Cover[]`——只含被删书目的封面，
保证撤销删除后封面一并回来。

### 12.2 三种 kind

| kind | 内容 | 触发 | 生命周期 |
|---|---|---|---|
| `undo` | 只含被删的记录（部分数据） | 删除操作前（§9.1） | 30 秒超时 / 撤销 / 被新 undo 顶掉 |
| `auto` | 全库五张业务表 | 写计数 ≥ 20 且距上次 ≥ 1 天（01 §3.3） | 滚动保留最近 10 份 |
| `pre-restore` | 恢复前一刻的全库 | 用户执行快照恢复前自动拍 | 同 `auto` 一起滚动保留 |

### 12.3 自动快照触发与保留（用户定稿参数，2026-09-13）

- 每个写操作在事务内 `bumpWriteCounter`（`settings.writesSinceSnapshot` +1，01 §3.3）。
- 计数达到 **20** 且 `lastAutoSnapshotAt` 距现在 ≥ **1 天** → 拍一张 `auto` 快照，然后
  `resetWriteCounter`（这是「空转计数器」的兑现：快照成功后必须归零）。
- **触发时机**：`bumpWriteCounter` 只负责计数；达到阈值后，**在写事务提交之后**由快照
  service 异步拍 `auto` 快照并 `resetWriteCounter`（事务内读全库会放大锁范围，且快照
  若与写同事务，回滚会把快照一起带走）。
- **竞态接受**：提交与 `resetWriteCounter` 之间的并发写入可能漏计一次——只影响快照
  节奏、不丢数据，不加锁。
- **计数口径**：仅**六张业务表**（locations/books/copies/loans/borrowers/covers）的增删改计入；
  `settings`、快照表本身、撤销/恢复的写入一律不计（恢复是 replace 语义的整体重写，计入会立刻再触发阈值，无意义）。
  **封面照片的写入/删除也不计入**（B4）——照片不算「读写的书」，且快照不含封面，让拍照顶阈值会拍出不含照片的快照。
  `applyImport` 按实际变更条数计入（写进业务表的行数）；`previewImport` 不计（事务整体回滚）。
- 保留最近 **10** 份 `auto`/`pre-restore` 快照，超出删最旧。
- 设置页显示「最近快照时间」+ 快照列表 + 「恢复」按钮（04 §11）。

### 12.4 恢复语义

恢复 = 把快照 `data` 以「清空 + 整体写入」的方式落回五张业务表（03 §6 的 replace
语义，但**只清业务五表**，`settings` 与其余快照不动），写入后跑
`rebuildLocationPaths` + `repairInvariants`（02 §6）。恢复**前**先自动拍一张
`pre-restore` 快照——恢复操作本身也允许反悔；恢复前同样先清理当前 undo 快照
（§9.1）——旧撤销会把已恢复掉的数据写回。

### 12.5 与备份的边界

- 快照**不进备份文件**（与 `settings` 同类的设备专属状态，03 §2）。
- 快照与备份的分工：快照防「误删误改、想回滚」，备份防「换设备、朋友交换」。
- 快照存 IndexedDB 内，防不住「IndexedDB 被清」——那由后续阶段的快照落盘解决
  （01 §3.2 第 3 层的文件层设计不变，只是移到后续项）。

## 13. 测试用例清单（P0-4 + N1/N2）

`src/db/snapshots.test.ts` / `src/db/snapshots-restore.test.ts` / `src/db/borrowers.test.ts` / `src/db/listing.test.ts` 必须覆盖：

| # | 用例 | 断言 |
|---|---|---|
| S1 | 删副本 → 30 秒内撤销 | 副本与其借出记录按原 id 恢复；undo 快照被清理 |
| S2 | 删书目·级联 → 撤销 | 书目 + 副本 + 借出全恢复；原 id 不变 |
| S3 | 删位置·级联 → 撤销 | 位置子树 + 副本 + 借出全恢复；路径重建后正确 |
| S4 | 删位置·上移（reparent） | 不产生 undo 快照 |
| S5 | 第二次删除顶掉第一次的 undo | 旧 undo 被销毁；只能撤销最新一次 |
| S6 | 撤销超时清理 | `expireUndo`（注入 now，30 秒后）执行后 undo 快照不存在；数据仍是删除后状态 |
| S7 | 写计数达 20 且距上次 ≥1 天 | 自动拍 `auto` 快照；计数器归零 |
| S8 | 写计数 <20 或距上次 <1 天 | 不拍快照 |
| S9 | 快照超过 10 份 | 最旧的被删；恰好保留 10 份 |
| S10 | 恢复快照 | 五表与快照一致；恢复前有 `pre-restore` 快照；settings 不变 |
| S11 | 恢复后不变式 | `repairInvariants` 零警告；「未分类」存在 |
| S12 | 借书人 upsert | 同名借出两次只有一条候选；contact 取最新 |
| S13 | 借书人超 20 条 | 最旧 updatedAt 被淘汰 |
| S14 | 删借书人候选 | 历史借出记录的 borrower 字符串不变 |
| S15 | 借书人随备份导出/导入 | 03 §10 的 T17/T18 覆盖 |
| S16 | 启动清理超期 undo | 应用启动（即 `expireUndo(db, { olderThanMs: 0 })`）后全部 `undo` 快照被清；业务数据不受影响 |
| S17 | 借书人手动新增重名 | 按规范化姓名去重：重名视为更新该候选的联系方式（02 §5.5） |
| S18 | `listAllTags` | 去重；标签多/单/零个书目的库都正确；稳定排序（§10.3） |
| S19 | `listRecentBooks` | 按 `createdAt` 倒序；`limit` 截断；返回的副本组合视图完整（§10.3） |
| S20 | 快照恢复前有未过期 undo | 恢复后该 undo 快照被清理（§12.4）；恢复结果不受其影响 |
| S21 | 删书目→撤销（B4） | 封面照片随 undo 快照一并恢复（blob 字节一致） |
| S22 | 快照回滚不动封面表（B4） | auto/pre-restore 快照 data 不含 covers；恢复后封面仍在 |
| S23 | I10 孤儿封面清理（B4） | 封面指向不存在的书目 → repairInvariants 删除并记警告 |
