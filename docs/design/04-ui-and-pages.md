# 04 · 界面与页面

> 本文件拥有：页面清单与路由、导航结构、数据订阅方式、启动序列、表单控件约定、空态与错误态约定、宿主能力在 UI 的落点、构建入口文件归属。
> 实体与字段见 [02-data-model.md](./02-data-model.md)；备份格式与导入合并见 [03-backup-and-merge.md](./03-backup-and-merge.md)；技术选型、打包分流与目录结构见 [01-architecture.md](./01-architecture.md)。

---

## 1. 页面清单与路由

01 §8 阶段 B 要求的「五个页面」指**导航里的五个目的地**；此外有两个非导航视图（书目详情、书目表单），由列表页跳入。

| 路由 | 名称 | 在导航 | 主要数据依赖（service 函数） |
|---|---|---|---|
| `/` | 首页 · 总览 | ✅ | `getStats` · `listOverdueLoans` · `getSetting('lastExportAt')` |
| `/search` | 搜索 | ✅ | `searchBooks` · `listLocations` |
| `/locations` | 位置 | ✅ | `getLocationTree` · `getCopiesByLocation` · `listCopiesByLocation` · `createLocation` · `updateLocation` · `moveLocation` · `countLocationDependents` · `deleteLocation` |
| `/loans` | 借出 | ✅ | `listActiveLoans` · `listOverdueLoans` · `listLoanHistory` · `loanOut` · `returnCopy` |
| `/settings` | 备份与设置 | ✅ | `exportToJson` · `markExported` · `importFromText` · `checkInvariants` · `clearAllData` · `getSetting`/`setSetting` · `completeChat`（AI 配置与测试连接，05 §3） |
| `/books/new` | 新增书目 | — | `findBooksByIsbn` · `createBook` · `submitBook` · `bulkImportBooks`（粘贴/CSV 批量导入，05 §2）· `completeChat`（AI 补全，05 §3） |
| `/books/:id` | 书目详情 | — | `getBookDetail` · `updateBook` · `findBooksByIsbn` · `createCopy` · `updateCopy` · `moveCopy` · `setCopyStatus` · `deleteCopy` · `listLocations` · `getActiveLoanForCopy` · `loanOut` · `returnCopy`（后两个经 `features/loans/write.ts` 的 `lendCopy`/`returnLoan`）· `deleteBookCompletely`（`features/books/write.ts`，级联删除走显式 `strategy: 'cascade'`） |

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
4. 返回 `{ db, repairWarnings, persisted }`，交给 React 渲染。

启动失败（IndexedDB 不可用、隐私模式）时，`main.tsx` 渲染一段纯静态的错误说明，**不白屏**。

---

## 5. 表单控件约定

- **值域封闭的字段必须用选择器，禁止自由文本**：副本状态（`COPY_STATUSES`）、品相（`COPY_CONDITIONS`）、主题（`system`/`light`/`dark`）、位置层级类型、导入模式（`merge`/`replace`）、删除策略（`reparent`/`cascade`）。
  理由：自由文本要求用户猜中拼写，校验失败还是静默的。这些值域都来自 `types.ts` 的 `as const` 数组，直接用它们渲染选项，**不另抄一份中文标签表以外的清单**。
- 自由文本仅用于真正开放的输入：书名、作者、出版社、ISBN、借书人、联系方式、备注、位置名、设备名。
- **中文标签映射集中在 `src/app/labels.ts`**，一处定义，页面只引用——避免「同一个状态在三个页面有三种说法」。
- `Copy.status = 'lent_out'` 是派生值（02 §4），表单里**不出现**这个选项；借出/归还只能通过 `loanOut` / `returnCopy`。
- `Location.path` / `depth` / `type` 不作为表单字段（02 §11）：位置表单只有名称、上级、排序。

---

## 6. 空态与错误态

- 每个列表页必须有**空态文案**，且文案要说清下一步动作（如「还没有书，点右上角 ＋ 添加第一本」），不是干巴巴的「暂无数据」。
- 删除类操作一律二次确认，且确认文案必须带**具体数量与人名**（02 §9 要求：删位置要说明将删多少副本；删已借出的副本要写「该副本正被 XX 借出」）。数量从 `countLocationDependents` 等只读函数取，不猜。
- 导入预览用 `previewImport` 的 `ImportSummary` 渲染「新增 / 更新 / 跳过 / 警告」四类数字，**先预览后执行**，`mode` 与 `dryRun` 由用户显式选择。

---

## 7. 宿主能力在 UI 的落点

- 扫码按钮按**能力探测**显示，不按 UA 判断（01 §1.1 第 2 条）。探测函数在 `src/platform/capabilities.ts`，阶段 D 接 `html5-qrcode`。
- 备份落盘分流：浏览器走下载（`src/platform/files.ts` 的 `downloadText`），Tauri/Capacitor 走各自插件（阶段 E/F）。**数据层不认识文件系统**（01 §3.2 边界），`exportToJson` 只产出字符串。

---

## 8. 构建入口与分流

- 仓库根的 `index.html` 是 **Vite 的应用入口**，属于本项目。原先放在该路径的井字棋页面与本项目无关，已移入 `scratch/`（见 01 §9 Q1）。
- `vite.config.ts` 按 `BUILD_TARGET` 决定 `base`（01 §4）。PWA（manifest、图标、Service Worker）已在阶段 F 接入：静态文件在 `public/`（图标由 `scripts/make-icons.mjs` 生成），SW 只在 web 构建注册。
- **web 构建的本地预览用 `npm run serve:web`（`scripts/serve.mjs`），不要用 `vite preview`**：preview 把 dist 摊在根路径，子路径 base 下的资源/SW/manifest 全部回退成 index.html，应用跑不起来也装不上 PWA；serve.mjs 按 `/pocket-library/*` 正确映射，行为与 GitHub Pages 一致。
- 脚本：`npm run dev` / `build` / `preview` / `serve:web` / `build:web` / `build:tauri` / `build:android`。

---

## 9. 后续阶段

扫码与元数据抓取（D）、自动快照落盘（E 剩余部分）、Tauri 桌面打包（G）、Capacitor 安卓打包（H）。

---

## 10. 视觉基调（阶段 B2）

方向：**精致极简**（2026-09-12 与用户确认）。

- 目标感：像精装 Apple 系统设置页——克制留白、细描边、柔和分层阴影、微动效。
- **改动只在三处**：`src/app/index.css`（全局令牌：字体栈、阴影、圆角、过渡）、
  `src/app/ui.tsx`（共享组件）、`src/app/AppShell.tsx` 与 `nav.tsx`（外壳与导航）。
  各页面不动布局结构，只继承共享组件的新质感。
- 硬约束：深浅色都正常；不引入新依赖；正文对比度符合 WCAG AA。
- 验收：五个页面 + 两个子页在深浅色下浏览一遍，无布局破损。
