# 04 · 界面与页面

> 本文件拥有：页面清单与路由、导航结构、数据订阅方式、启动序列、表单控件约定、空态与错误态约定、宿主能力在 UI 的落点、构建入口文件归属。
> 实体与字段见 [02-data-model.md](./02-data-model.md)；备份格式与导入合并见 [03-backup-and-merge.md](./03-backup-and-merge.md)；技术选型、打包分流与目录结构见 [01-architecture.md](./01-architecture.md)。

---

## 1. 页面清单与路由

01 §8 阶段 B 要求的「五个页面」指**导航里的五个目的地**；此外有两个非导航视图（书目详情、书目表单），由列表页跳入。

| 路由 | 名称 | 在导航 | 主要数据依赖（service 函数） |
|---|---|---|---|
| `/` | 首页 · 总览 | ✅ | `getStats` · `listOverdueLoans` · `getSetting('lastExportAt')` · `listRecentBooks`（最近添加，§11.6） |
| `/search` | 搜索 | ✅ | `searchBooks` · `listLocations` · `listAllTags`（标签筛选，§11.5） |
| `/locations` | 位置 | ✅ | `getLocationTree` · `getCopiesByLocation` · `listCopiesByLocation` · `createLocation` · `updateLocation` · `moveLocation` · `countLocationDependents` · `deleteLocation` |
| `/loans` | 借出 | ✅ | `listActiveLoans` · `listOverdueLoans` · `listLoanHistory` · `loanOut` · `returnCopy` · 快速借出（§11.7）：`searchBooks` · `lendCopy` · `listBorrowers` |
| `/settings` | 备份与设置 | ✅ | `exportToJson` · `markExported` · `importFromText` · `checkInvariants` · `clearAllData` · `getSetting`/`setSetting` · `completeChat`（AI 配置与测试连接，05 §3）· `listSnapshots` · `restoreSnapshot`（快照管理与恢复，02 §12）· `listBorrowers` · `createBorrower` · `updateBorrower` · `deleteBorrower`（借书人管理，02 §5.5）· `loanPeriodDays`（默认借期偏好，§11.7 引用） |
| `/books/new` | 新增书目 | — | `findBooksByIsbn` · `createBook` · `submitBook` · `bulkImportBooks`（粘贴/CSV/xlsx 批量导入，05 §2）· `parseXlsx`（05 §2.1）· `completeChat`（AI 补全，05 §3）· 表单记忆（§11.2） |
| `/books/:id` | 书目详情 | — | `getBookDetail` · `updateBook` · `findBooksByIsbn` · `createCopy` · `updateCopy` · `moveCopy` · `setCopyStatus` · `deleteCopy` · `listLocations` · `getActiveLoanForCopy` · `loanOut` · `returnCopy`（后两个经 `features/loans/write.ts` 的 `lendCopy`/`returnLoan`）· `deleteBookCompletely`（`features/books/write.ts`，级联删除走显式 `strategy: 'cascade'`）· `listBorrowers`（借书人候选，§11.3） |

**为什么是这五个**：四张业务表（位置 / 书目 / 副本 / 借出，02 §1）里，书目与副本是同一件事的两个层次，合成一个「搜索」入口更符合「我要找一本书」的实际动作；再加上统计总览与备份设置，正好五页。阶段 D 的扫码录入、阶段 E 的备份 UI 都挂在这五个页面里，不新增导航项。

**「五个页面」的硬验收点**（01 §8）：能在浏览器里加一本书、看到它出现在搜索页和位置页。

---

## 2. 导航结构

- 单层导航，五项固定，**不做二级菜单**——页面数少，二级菜单只会增加点击。
- 布局：窄屏（< 768px）底部标签栏，宽屏左侧边栏。同一份 `NAV_ITEMS` 常量渲染两处，避免两套清单漂移。
- 全局「＋ 新增书目」按钮常驻在导航栏外层（`AppShell`），因为「加书」是最高频动作，不该被埋在某个页面里。

---

## 3. 数据订阅

**不引入状态管理库**（01 §2.1）。所有页面通过 Dexie 自带的 `liveQuery` 订阅查询结果：

- `src/app/useLiveQuery.ts` 提供 `useLiveQuery(querier, deps, fallback)`，内部用 `liveQuery()` + 订阅/退订，**不引入 `dexie-react-hooks`**（同一个能力，dexie 本体已有）。
- 页面**不手工失效缓存**：任何写操作后 Dexie 自己会重跑活跃查询。这是选它而不是「用完手动重查」的原因——手动重查的漏网点（改完位置忘了刷计数、导入后忘了刷首页）是这类应用最常见的错。
- 写操作函数仍必须有 `try/catch`：service 抛的是人话中文（如「位置名称不能为空」），UI 原样展示，不吞错。

---

## 4. 启动序列

`src/app/startup.ts` 的 `bootstrapApp()`，顺序不可调换：

1. `requestPersistentStorage()` —— best-effort，失败不阻塞（01 §3.2 第 1 条）。
2. `openDb()` —— 建实例 + `open()` + `seedDefaults()`（`client.ts`）。
3. `repairInvariants(db)` —— 02 §6 要求「启动时各跑一次」。返回的 `warnings` 若非空，首页顶部显示**一次性**横幅（本次会话内可关闭），不静默吞掉数据修复。
4. `expireUndo(db, { olderThanMs: 0 })` —— 清理全部 `undo` 快照（撤销不跨会话，02 §9.1）。
5. 返回 `{ db, repairWarnings, persisted }`，交给 React 渲染。

启动失败（IndexedDB 不可用、隐私模式）时，`main.tsx` 渲染一段纯静态的错误说明，**不白屏**。

---

## 5. 表单控件约定

- **值域封闭的字段必须用选择器，禁止自由文本**：副本状态（`COPY_STATUSES`）、品相（`COPY_CONDITIONS`）、主题（`system`/`light`/`dark`）、导入模式（`merge`/`replace`）、删除策略（`reparent`/`cascade`）。
  理由：自由文本要求用户猜中拼写，校验失败还是静默的。这些值域都来自 `types.ts` 的 `as const` 数组，直接用它们渲染选项，**不另抄一份中文标签表以外的清单**。
- 自由文本仅用于真正开放的输入：书名、作者、出版社、ISBN、借书人、联系方式、备注、位置名、设备名。
- **借书人输入 = 自由文本 + 历史候选下拉**（P0-3）：输入框获得焦点时展示候选列表（`listBorrowers`），
  选中后姓名与联系方式一起自动填；自由输入新名字照常有效，借出成功后自动进入候选（02 §5.5）。
- **中文标签映射集中在 `src/app/labels.ts`**，一处定义，页面只引用——避免「同一个状态在三个页面有三种说法」。
- `Copy.status = 'lent_out'` 是派生值（02 §4），表单里**不出现**这个选项；借出/归还只能通过 `loanOut` / `returnCopy`。
- `Location.path` / `depth` / `type` 不作为表单字段（02 §11）：位置表单只有名称、上级、排序。

---

## 6. 空态与错误态

- 每个列表页必须有**空态文案**，且文案要说清下一步动作（如「还没有书，点右上角 ＋ 添加第一本」），不是干巴巴的「暂无数据」。
- 删除类操作一律二次确认，且确认文案必须带**具体数量与人名**（02 §9 要求：删位置要说明将删多少副本；删已借出的副本要写「该副本正被 XX 借出」）。数量从 `countLocationDependents` 等只读函数取，不猜。
- **删除后 30 秒内可撤销**（P0-4）：删除成功后在页面底部展示一条固定横幅「已删除《XX》｜撤销」，
  30 秒倒计时结束或用户关闭后消失；点「撤销」按原样恢复（02 §9.1）。新一次删除顶掉上一次的撤销提示。
- 导入预览用 `previewImport` 的 `ImportSummary` 渲染「新增 / 更新 / 跳过 / 警告」四类数字，**先预览后执行**，`mode` 与 `dryRun` 由用户显式选择。

---

## 7. 宿主能力在 UI 的落点

- 扫码按钮按**能力探测**显示，不按 UA 判断（01 §1.1 第 2 条）。探测函数在 `src/platform/capabilities.ts`，阶段 D 接 `html5-qrcode`。
- 备份落盘分流：浏览器走下载（`src/platform/files.ts` 的 `downloadText`），Tauri/Capacitor 走各自插件（阶段 E/F）。**数据层不认识文件系统**（01 §3.2 边界），`exportToJson` 只产出字符串。

---

## 8. 构建入口与分流

- 仓库根的 `index.html` 是 **Vite 的应用入口**，属于本项目。原先放在该路径的井字棋页面与本项目无关，已移入 `scratch/`（见 01 §9 Q1）。
- `vite.config.ts` 按 `BUILD_TARGET` 决定 `base`（01 §4）。PWA（manifest、图标、Service Worker）已在阶段 F 接入：静态文件在 `public/`（图标由 `scripts/make-icons.mjs` 生成），SW 只在 web 构建注册。
- **web 构建的本地预览用 `npm run serve:web`（`scripts/serve.mjs`），不要用 `vite preview`**：preview 把 dist 摊在根路径，子路径 base 下的资源/SW/manifest 全部回退成 index.html，应用跑不起来也装不上 PWA；serve.mjs 按 `/--/*` 正确映射（与 vite.config.ts 的 web base 同步），行为与 GitHub Pages 一致。
- 脚本：`npm run dev` / `build` / `preview` / `serve:web` / `build:web` / `build:tauri` / `build:android`。

---

## 9. 后续阶段

扫码与元数据抓取（D）、快照落盘到应用数据目录（E 剩余部分，01 §3.2）、Tauri 桌面打包（G）、Capacitor 安卓打包（H）。

---

## 10. 视觉基调（阶段 B2）

方向：**精致极简**（2026-09-12 与用户确认）。

- 目标感：像精装 Apple 系统设置页——克制留白、细描边、柔和分层阴影、微动效。
- **改动只在四处**：`src/app/index.css`（全局令牌：字体栈、阴影、圆角、过渡）、
  `src/app/ui.tsx`（共享组件）、`src/app/AppShell.tsx` 与 `nav.tsx`（外壳与导航）。
  各页面不动布局结构，只继承共享组件的新质感。
- 硬约束：深浅色都正常；不引入新依赖；正文对比度符合 WCAG AA。
- 验收：五个页面 + 两个子页在深浅色下浏览一遍，无布局破损。

---

## 11. P0 交互细则（2026-09-13 定稿）

四个 P0 改动的界面行为在此定稿；数据语义分别在 02/03/05，这里只写交互。

### 11.1 批量导入：列映射预览（P0-1）

- 入口：NewBookPage 的批量导入区，三个入口：「粘贴文本」「CSV 文件」「Excel 文件」。
- 文件选择后**不直接写库**：先展示预览表（前 5 行 + 「第 N 列 → 字段」的映射行）；
  映射不正确的列可以用下拉改（含「忽略此列」），确认后执行。
- 预览区下方是三个批量默认值（下拉/数字控件）：默认值语义以 05 §2.2 为权威——
  位置默认「未分类」、副本数默认 1（可填 0 = 只建书目）、品相默认「新」。
- 执行后展示 `BulkImportReport`（新建书目 N / 新建副本 M / 跳过 K 条与原因 / 疑似重复）。
- 粘贴文本与 CSV 的映射也可用同一预览（CSV 表头识别错了同样能改）。

### 11.2 新增表单记忆（P0-2）

- 保存成功后，把本次的「位置、品相、标签」三个字段写入 settings 键
  `lastDraftPrefs`（设备专属，不进备份）。
- 下次进入新增页，草稿从 `EMPTY_DRAFT` 起步，但**只回填这三个字段**（其余字段始终空白）。
- 实现：`features/books/write.ts` 的 `rememberDraftPrefs` / `applyDraftPrefs` 两个纯函数
  + NewBookPage 在挂载与保存成功两个时机调用；不用 localStorage（settings 表是唯一真源，
  换浏览器会话行为一致）。
- 「位置/品相」是 `BookDraft` 的副本种子字段（`locationId`/`condition`）：新增保存时由
  `submitBook` 经 `createCopy` 建出 `initialCount` 本副本；记忆只作用于这两个字段与标签。
- 副本数字段规格：默认 1、上限 `MAX_INITIAL_COUNT`（99），与批量导入同口径（05 §2.2）。

### 11.3 借书人候选（P0-3）

- 借出弹窗（书目详情页与借出页共用同一弹窗组件）的「借书人」字段：输入框聚焦/输入时下拉展示候选（姓名，最多 20 条，
  按 `updatedAt` 倒序）；选中 → 姓名与联系方式一起填入。
- 设置页新增「借书人」区：列表（姓名 + 联系方式）+ 新增 / 编辑 / 删除；
  删除只删候选，不影响历史借出记录（02 §5.5）。

### 11.4 删除撤销与快照（P0-4）

- 删除撤销：见 §6（30 秒横幅）。横幅常驻底部、跨页面不消失（放在 AppShell 层），
  与当前在哪个页面无关。
- 设置页新增「快照」区：最近快照时间 + 快照列表（时间 + 各表计数，最近 10 份）+
  「恢复」按钮；点恢复弹二次确认（写明将覆盖当前全部藏书数据），确认后先自动拍
  `pre-restore` 快照再恢复（02 §12.4），完成后刷新页面数据。
- 「清空数据」不做撤销提示，但引导文案提一句「可在上方快照区恢复」。

### 11.5 搜索页标签筛选（N1）

- 搜索页新增「标签」下拉（选项来自 `listAllTags`，默认「全部」），与关键词、位置、
  状态一起 AND 组合——组合语义见 02 §10.2（单独按标签搜时允许「有标签但无实体」的书
  出现；一旦叠加位置/状态，就必须有符合的副本）。
- 没有任何标签的书库：下拉隐藏（没得选就不占地方）。

### 11.6 首页最近添加（N2）

- 首页「逾期未还」区块下方新增「最近添加」区块：最近 8 本（`listRecentBooks(db, { limit: 8 })`），
  每本显示书名、作者、副本数，点击进详情页；新录入后自动置顶（liveQuery 订阅）。
- 书库为空时整个区块不显示。

### 11.7 快速借出（N3）

- 借出页顶部新增「＋ 快速借出」按钮，打开一个三步弹窗，**不再需要跳去详情页**：
  1. **选书**：迷你搜索框（复用 `searchBooks` 的书名/ISBN 关键词），列表选一本书；
  2. **选副本**：显示该书的**在架**（`on_shelf`）副本列表（含位置路径），选一本；
     若该书没有在架副本，显示空态「该书没有在架副本（N 本已借出/丢失/卖掉）」+
     「换一本书」按钮（归还不在本弹窗内）。
  3. **填借出信息**：借书人（候选下拉，§11.3）+ 联系方式 + 应还日期（默认按**存量**设置项
     `loanPeriodDays` 折算——默认 30 天，设置页「偏好」区可改），确认即 `lendCopy` 借出。
- 校验复用 `features/loans/write.ts` 的 `validateLoanDraft`/`lendCopy`，失败显示中文人话，
  不新造一套校验。书目详情页原有的借出弹窗保持不变（快速借出是新增入口，不是替代）。
