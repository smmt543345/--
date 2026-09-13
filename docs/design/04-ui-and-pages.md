# 04 · 界面与页面

> 本文件拥有：页面清单与路由、导航结构、数据订阅方式、启动序列、表单控件约定、空态与错误态约定、宿主能力在 UI 的落点、构建入口文件归属。
> 实体与字段见 [02-data-model.md](./02-data-model.md)；备份格式与导入合并见 [03-backup-and-merge.md](./03-backup-and-merge.md)；技术选型、打包分流与目录结构见 [01-architecture.md](./01-architecture.md)。

---

## 1. 页面清单与路由

01 §8 阶段 B 要求的「五个页面」指**导航里的五个目的地**；此外有两个非导航视图（书目详情、书目表单），由列表页跳入。

| 路由 | 名称 | 在导航 | 主要数据依赖（service 函数） |
|---|---|---|---|
| `/` | 首页 · 总览 | ✅ | `getStats` · `listOverdueLoans` · `getSetting('lastExportAt')` · `listRecentBooks`（最近添加，§11.6）· `getCover`（缩略图，§11.8） |
| `/search` | 搜索 | ✅ | `searchBooks` · `listLocations` · `listAllTags`（标签筛选，§11.5）· `getCover`（缩略图，§11.8） |
| `/locations` | 位置 | ✅ | `getLocationTree` · `getCopiesByLocation` · `listCopiesByLocation` · `createLocation` · `updateLocation` · `moveLocation` · `countLocationDependents` · `deleteLocation` |
| `/loans` | 借出 | ✅ | `listActiveLoans` · `listOverdueLoans` · `listLoanHistory` · `loanOut` · `returnCopy` · 快速借出（§11.7）：`searchBooks` · `lendCopy` · `listBorrowers` |
| `/settings` | 备份与设置 | ✅ | `exportToJson` · `markExported` · `importFromText` · `checkInvariants` · `clearAllData` · `getSetting`/`setSetting` · `completeChat`（AI 配置与测试连接，05 §3）· `listSnapshots` · `restoreSnapshot`（快照管理与恢复，02 §12）· `listBorrowers` · `createBorrower` · `updateBorrower` · `deleteBorrower`（借书人管理，02 §5.5）· `loanPeriodDays`（默认借期偏好，§11.7 引用） |
| `/books/new` | 新增书目 | — | `findBooksByIsbn` · `createBook` · `submitBook` · `bulkImportBooks`（粘贴/CSV/xlsx/文本类/docx 批量导入，05 §2）· `parseXlsx`（05 §2.1）· `completeChat`（AI 补全，05 §3）· `putCover`（拍照存封面，§11.8）· 表单记忆（§11.2） |
| `/books/:id` | 书目详情 | — | `getBookDetail` · `updateBook` · `findBooksByIsbn` · `createCopy` · `updateCopy` · `moveCopy` · `setCopyStatus` · `deleteCopy` · `listLocations` · `getActiveLoanForCopy` · `loanOut` · `returnCopy`（后两个经 `features/loans/write.ts` 的 `lendCopy`/`returnLoan`）· `deleteBookCompletely`（`features/books/write.ts`，级联删除走显式 `strategy: 'cascade'`）· `listBorrowers`（借书人候选，§11.3）· `getCover`/`putCover`/`deleteCover`（封面，§11.8） |

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

- 入口：NewBookPage 的批量导入区，两个入口：「粘贴文本」与「选择文件…」（接受 `.csv/.txt/.md/.tsv/.json/.xlsx/.xls/.docx`，按扩展名分派解析；B4 起）。
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

### 11.8 拍照存封面（B4）

- **入口**：新增书目页与书目详情页各一个「📷 拍照 / 选图」按钮（书目详情页兼「重拍」「删照片」）。
  手机直接调相机，电脑是选图片文件（`<input type="file" accept="image/*" capture="environment">`）。
- **压缩**：客户端用 canvas 压到长边 ≤1000px 的 JPEG（约 50–100KB），原始大图不入库。
- **预览**：选完先显预览，可确认 / 重拍 / 取消；保存时随书入库（先存书目再存封面）。
- **显示**：详情页大图；搜索页、位置页、首页「最近添加」行首小缩略图（~40px）；**无照片时：详情/新增页显示占位框（📷＋「还没有照片」），列表行不渲染任何占位**（不给每一行加噪音）。
- **失败态**：图片解不开 / 不是图片 → 人话提示（「这张图读不了，换一张试试」），不影响手填与保存。
- **概不联网**：照片只进本机 IndexedDB，不上传任何服务；导出备份时才会写进备份文件（02 §3.5）。

### 11.9 界面细节打磨（B5）

四个方向，**纯视觉层，不动任何业务逻辑与数据流**；零新依赖（D8）；全部尊重
`prefers-reduced-motion`（系统开了「减少动态效果」就不播动画）。

**1. 封面展示升级**
- 详情页封面：固定 **3:4 比例框**，圆角 12px，细边框 + 柔和阴影（浅色模式浅灰边、深色模式亮边）；照片 `object-cover` 填满。
- 列表缩略图（40px）：圆角 6px + 1px 边框，共用同一套边色令牌。
- 无照片：仍是占位框（📷 + 文案），但样式与封面框一致（不发生尺寸跳动）。

**2. 空态插画**
- 新增 `src/app/illustrations.tsx`：手绘线条风 SVG 小插画（与图标同源的「木刻线条」气质：单色描边 + 一个朱红/琥珀点缀），画布 ~96×72。
- 场景：书库空（书架）/ 搜索无结果（放大镜+书）/ 没有借出（书+书签）/ 没有位置 / 没有快照 / 没有借书人。
- `EmptyState` 增可选 `illustration?: ReactNode`；**不传 = 现状不变**（所有旧调用零影响）。

**3. 骨架屏**
- 新增 `src/app/Skeleton.tsx`：`SkeletonBlock`（圆角灰块 + 脉冲）与 `SkeletonList`（N 行，每行含封面占位 + 两条文字占位）。
- 替换「整页/整块首次加载」的 `Spinner`：搜索页、首页、位置页藏书面板、书目详情列表区、设置页统计区。
- `Spinner` 组件**保留**（按钮内、小范围等待仍用它）；脉冲动画在 reduced-motion 下降级为静态灰块（不闪）。

**4. 微交互**（全部 CSS，不引库）
- 卡片：hover 微浮起（`-translate-y-0.5` + 阴影加深）、`transition` 150ms。
- 列表项：首次进入渐显（CSS animation，不用 JS 计时）。
- 按钮：按下 `active:scale-[0.98]`；禁用态不动。
- 焦点环、滚动条等既有基调（§10）不变。

**为什么不做**：不改信息架构、不换主色、不加动效库（如 framer-motion）——打磨是让现有界面更耐看，不是重新设计。

**交付记录（2026-09-13）**：四条全部落地——`illustrations.tsx`（6 张空态插画）· `Skeleton.tsx`（骨架块/骨架列表）·
`ui.tsx`（`Card.interactive`、`EmptyState.illustration?`、封面边色令牌）· `index.css`（`fade-rise` 渐显 + 全局 reduced-motion 关闭动画）。
骨架屏取代了**全部首屏等待**（搜索/首页/位置树/藏书面板/借出页/详情页/快照区/借书人区/设置统计区）；
`Spinner` 仅在按钮内与小范围等待（快速借出对话框）保留。
**两处实现裁定**：① `Card.interactive` 只给真正可点的列表行（表单卡不浮起，避免鼠标扫过整页抖动）；
② 占位封面框与真封面**同几何**（同宽、同 3:4、同圆角、同 1px 边色），只把边框改虚线以示「空着」。
验收：`npm test` 425/425、`typecheck`、`build` 全绿；零新依赖。

### 11.10 应用图标（B5）

- `scripts/make-icons.mjs` 重写为**木刻版画**风格（宣纸纤维底 + 黑墨手刻开卷书 + 朱红印记 + 书架横档），
  零依赖（手写 PNG 编码 + SDF 绘制 + 盒模糊），生成 192/512/180 三张。
- 素材收在中心 80% 内（安卓自适应图标裁切安全区）；背景全出血。
- 换风格只需改这个脚本并重跑（`node scripts/make-icons.mjs`），产物进 `public/icons/`。

### 11.11 美术方向：纸 · 墨 · 朱（B6）

界面与应用图标共用同一套颜色体系（宣纸底、暖墨字、朱砂点校），不逐页改类名——
**改 `src/app/index.css` 的 `@theme` 令牌**：界面通篇用的是 neutral/blue/red/amber/emerald
五个色阶（neutral 单色就 400+ 处），覆盖这五个色阶等于全应用换色。

| 维度 | 取值 | 理由 |
|---|---|---|
| 底色 neutral-50 / 卡片 | `#f7f2e7` 宣纸米白 | 与图标同一张纸 |
| 正文/墨色 neutral-900 | `#221e18` 暖墨 | 冷灰黑会与纸色打架 |
| 主色 blue-600（主按钮/激活态） | `#354966` 靛墨 | 主色不能是朱红——朱红要留给危险与强调 |
| 危险/批校 red-600 | `#a83527` 朱砂 | 与图标印章同色 |
| 提醒 amber-500 | `#c8922a` 藤黄 | 传统四色之黄 |
| 正常/在架 emerald-600 | `#4a6b4a` 苔绿 | 低饱和，不抢朱红 |
| 圆角 | 整体收敛一档（卡片 12→6px） | 版画是方的 |
| 阴影 | 极淡墨色投影 | 印刷没有浮起来的卡片 |
| 标题字体 | 衬线（Georgia / 宋体栈） | 字面自带书卷气；正文仍无衬线保可读性 |
| 纸纹 | `body::after` 固定覆盖层，网格 3% 透明度 | 再明显就成「屏幕脏了」；深色模式走变量换亮颗粒 |

**朱笔点校落点（不加会整体偏冷）**：侧栏导航激活项左侧 3px 朱线、窄屏标签栏激活项顶部朱线、
页面标题下 8×2px 短朱线。除这三处不在别处用朱红做大面积。

**交付记录（2026-09-13）**：令牌 + 纸纹 + 衬线标题 + 三处朱线落地；
`npm test` 425/425、`typecheck`、`build` 全绿。顺带补了一条韧性不变量 **I11**（02 §6）：
库内 `authors`/`tags` 不是字符串数组时收敛并告警——之前这种数据会让界面在 `authors.join` 上直接崩。
