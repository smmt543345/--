# 01 · 技术架构

> 本文件拥有：技术选型、运行环境约束、数据落盘策略、三端打包与 PWA 分流、工程硬约束、目录结构、开发路线图、待决问题。
> 数据模型见 [02-data-model.md](./02-data-model.md)；备份与合并见 [03-backup-and-merge.md](./03-backup-and-merge.md)。

---

## 1. 运行环境矩阵

同一套前端代码要在四种宿主形态里跑，**它们的差异是真问题，不是理论问题**。

| 宿主 | 页面来源 origin | 摄像头（扫码） | 后台提醒 | IndexedDB 持久性 |
|---|---|---|---|---|
| 浏览器开发 | `http://localhost:5173` | 可用 | 无 | 好 |
| Tauri 桌面（Win） | `http://tauri.localhost` | 不可用（无相机权限） | 系统通知（需插件） | 一般，见 §3 |
| Tauri 桌面（macOS） | `tauri://localhost` | 同上 | 同上 | 一般，见 §3 |
| Capacitor 安卓 | `https://localhost` | 可用（需相机权限） | 系统通知（需插件） | 好 |
| iOS PWA | `https://smmt543345.github.io/--/` | 部分受限 | 无 | **会被系统清理** |

### 1.1 由此产生的三条硬结论

1. **不能依赖 secure context。** 各宿主对 `http://tauri.localhost` / `tauri://localhost` 是否算安全上下文判定不一致，配置一改就变。因此 ID 生成不用 `crypto.randomUUID()`（它被 secure context 门控），改用 `crypto.getRandomValues()` 自行实现 UUID v4，任何环境都可用。见 02 §7。
   - 打包阶段仍需在真机上验证一次 `crypto.randomUUID` 是否存在（列在 §8 阶段 G 的验收清单里），存在则作为快路径，不存在走自实现——**但正确性不得依赖它**。
2. **扫码只在浏览器和安卓上承诺可用。** 桌面包不做扫码承诺，UI 需按宿主能力隐藏扫码按钮（能力探测，不是 UA 判断）。
3. **后台提醒分两期。** v1 只做「App 启动时检查 + 首页横幅 + 借出页角标」，零依赖；v2 再考虑 Tauri/Capacitor 的系统通知插件。见 §10 后续项。

---

## 2. 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 构建 | Vite + React + TypeScript | 开发快，Tauri/Capacitor 都用它 |
| 样式 | Tailwind CSS v4 | v4 用 `@tailwindcss/vite` 插件 + CSS 内配置，不需要 `tailwind.config.js`；v3 的 PostCSS 链路更啰嗦，无理由选它 |
| 数据 | Dexie 4（IndexedDB） | 三端原生可用，免安装、免服务端 |
| 扫码 | html5-qrcode | 浏览器/安卓可用 |
| 二维码 | qrcode | 生成位置码 |
| 表格解析 | SheetJS CE（`xlsx`） | 批量导入 .xlsx/.xls（P0-1）；`import('xlsx')` 动态加载，不进首屏包 |
| 元数据 | Open Library + Google Books | 免费，无需 key |
| 桌面打包 | Tauri 2 | 产物体积小 |
| 安卓打包 | Capacitor | 复用同一套代码 |
| PWA | 手写 manifest + Service Worker（零依赖） | 仅 web 构建启用，见 §4 |
| 测试 | `node --test`（Node 内置）+ `fake-indexeddb`（devDependency） | 能直接跑 `.ts`，见 §6 |

### 2.1 明确不引入的依赖（以及为什么）

| 不引入 | 理由 |
|---|---|
| 状态管理库（Redux/Zustand/Jotai） | 数据量是"一个人的藏书"，页面级状态 + 一个 Dexie 订阅足够；引入后反而要在两处同步"真源" |
| 日期库（dayjs/date-fns） | 只需要格式化与比较，`Intl.DateTimeFormat` + ISO 字符串比较够用 |
| uuid 库 | 原生 `crypto.getRandomValues` 够用 |
| axios | 原生 `fetch` 够用，且要控制请求数 |
| 表单库 | 表单字段少，受控组件够用 |
| 任何 BaaS（Supabase/Firebase/云开发） | 违反项目原则：数据不出本机 |

判断标准：**引入一个依赖，必须换来一处靠标准库写不出来的能力。** 否则不引。

---

## 3. 数据落盘策略

### 3.1 唯一真源：IndexedDB（Dexie）

不用 SQLite 的原因：SQLite 在 Tauri 和 Capacitor 上是两套不同的原生插件（`tauri-plugin-sql` / `@capacitor-community/sqlite`），意味着**两套数据库访问代码 + 两套迁移脚本**，同时丢掉浏览器端。这套应用的数据量（几千本书）和查询复杂度完全在 IndexedDB 能力范围内。用一致性换掉双实现，划算。

### 3.2 自动快照兜底（**本项目最关键的一条补充**）

IndexedDB 会被清理：macOS 的 WKWebView、安卓 WebView 的沙盒重置、iOS Safari 的站点数据回收、用户清缓存——都会造成静默丢数据。原文案「数据存在 IndexedDB 里，靠导出 JSON 备份」把全部风险压在用户记性上，不可接受。

策略（三层，从便宜到贵）：

1. **申请持久化存储**：启动时调用 `navigator.storage.persist()`，被授予后浏览器不再自动清（Chrome/Edge 有效，Safari 无效）。这一条不保证成功，只能算加分项。
2. **库内快照（P0-4 已交付，2026-09-13）**：自动快照与删除撤销共用 IndexedDB 里的 `snapshots` 表——写计数达 20 且距上次 ≥ 1 天自动拍全库快照，滚动保留 10 份；设置页可恢复；删除操作前写 undo 快照（30 秒撤销）。**语义与触发参数见 02 §12**。防的是「误删误改、想回滚」，防不住「IndexedDB 被清」。
3. **快照落盘（后续项，原案保留）**：库内快照在 IndexedDB 被清时同归于尽，因此还要把最近一份快照写到本机应用数据目录（滚动保留）：
   - Tauri → `appDataDir/backups/*.json`（`@tauri-apps/plugin-fs`）
   - Capacitor → `Directory.Data/backups/`（`@capacitor/filesystem`）
   - 浏览器/PWA → 触发一次下载（或提供「立即备份」按钮），不静默下载
   快照用的是和手动导出完全相同的格式与代码路径（03 §2），不另造一套序列化；`buildBackup()` 落在 `backup/format.ts`（纯序列化叶子模块，只 import domain），快照与导出都从它拿字符串；落盘由 `src/platform/` 里的宿主适配层做——数据层不认识文件系统。
4. **提醒**：首页显示「上次导出：N 天前」，超过 14 天显示醒目提示。

### 3.3 写操作与快照计数器

`settings` 表记录 `lastAutoSnapshotAt` 与 `writesSinceSnapshot`。所有写操作经由 `src/db/` 的 service 函数，在同一个事务里自增计数器（见 §6 硬约束），不需要额外钩子。

**计数器闭环（P0-4 兑现）**：阈值触发、拍快照、归零的完整机制见 02 §12.3；此前计数器
只增不落、快照从未生成，属**待修复的空转缺陷**，由本设计兑现。

---

## 4. PWA 与 App 构建分流

Service Worker 在 Tauri/Capacitor 里没有意义，还会让资源缓存难以调试（改了代码看到旧页面）。

做法：用环境变量 `BUILD_TARGET` 决定构建形态，`vite.config.ts` 里三元判断。

| `BUILD_TARGET` | PWA（manifest + Service Worker） | base | 产物 |
|---|---|---|---|
| `web`（默认） | 启用（手写，零依赖，见下） | `/--/`（GitHub Pages 子路径，Q3 定稿：仓库 `SMMT543345/--`） | 静态站点 |
| `tauri` | 关闭 | `/` | 交给 Tauri 打包 |
| `android` | 关闭 | `/` | 交给 Capacitor 打包 |

`npm run build:web` / `build:tauri` / `build:android` 三条脚本，避免手改配置。

阶段 F 决定**手写 manifest 与 Service Worker**（`public/manifest.webmanifest` + `public/sw.js`），不引入 vite-plugin-pwa——与 D8「依赖尽量少」一致。SW 只在 web 构建注册：`vite.config.ts` 把 `BUILD_TARGET` 经 define 注入，`main.tsx` 按 `import.meta.env.PROD && BUILD_TARGET === 'web'` 把关。

---

## 5. 目录结构

```
docs/design/            设计文档（本目录）
src/
  domain/               纯逻辑，无 IO、不碰数据库（可单独测试）
    types.ts            实体与枚举（真源，见 02）
    ids.ts              UUID v4、保留常量
    time.ts             ISO 时间工具
    isbn.ts             ISBN 规范化与校验
    location-path.ts    位置路径的纯函数
    text.ts             parseList / normalizeTitle 等文本口径（02 §10.1、05 §2.1）
  db/                   数据库层：schema + 仓储 + 服务
    schema.ts           Dexie 类与版本（见 02 §8）
    client.ts           实例、打开、播种、清空
    locations.ts        位置增删改查、路径重建、树
    books.ts            书目增删改查、按 ISBN 查重、搜索
    copies.ts           副本增删改查、移动、状态
    loans.ts            借出/归还/历史/逾期
    borrowers.ts        借书人候选（P0-3，02 §5.5）
    snapshots.ts        快照：撤销/自动/恢复（P0-4，02 §12）
    settings.ts         键值配置
    stats.ts            统计
    repair.ts           不变式检查与修复（导入后 / 启动时）
  backup/               备份
    format.ts           文件格式、校验、序列化
    export.ts           导出
    import.ts           预览与合并导入（算法见 03）
  platform/             宿主适配（扫码、文件落盘、通知、能力探测）
  features/             UI，按页面分
    books/import.ts     批量粘贴/CSV 解析、跳过规则、批量创建（05 §2）
    books/import-mapping.ts  列名映射与别名词典（05 §2.2）
    books/xlsx.ts       xlsx 解析包装（P0-1，动态 import SheetJS，05 §2.1）
    books/ai.ts         AI 提示词拼装与回复解析（05 §3.4）
    books/write.ts      书目表单校验、草稿→实体、保存（04 §5）
    loans/write.ts      借出/归还表单规则（04 §5）

（B3 新增/改动文件全清单见 §5.1。）
  app/                  App shell、路由
*.test.ts               与被测文件同目录，由 `npm test` 收集
```

**依赖方向是单向的**：`features → db → domain`，`backup → db → domain`，`platform` 只被 `features` 调用。`domain` 不许 import `db`。
细化：`db/snapshots.ts` 复用 `backup/format.ts` 的 build 逻辑（`snapshots → format → domain`，不构成环）。

### 5.1 B3 受影响文件与尺寸标注（2026-09-13 定稿）

设计评审要求：每个将修改的源/测试文件标注**当前行数 + 预计增量**（受影响文件行数标注）。行数为 2026-09-13 实测；
>300 行触发拆分审查、>500 行必须拆分（无豁免）；B3 新增文件一律按 ≤300 行设计。

**新建文件（19 个）**：

| 文件 | 预计行数 | 内容 |
|---|---|---|
| `src/db/snapshots.ts` | ~200 | 快照 service：captureUndo / 自动快照 / 恢复 / expireUndo（02 §12） |
| `src/db/snapshots.test.ts` | ~200 | S1–S6（删除撤销） |
| `src/db/snapshots-restore.test.ts` | ~200 | S7–S11、S20（自动快照 / 恢复 / undo 清理） |
| `src/db/borrowers.ts` | ~90 | 借书人候选 service（02 §5.5） |
| `src/db/borrowers.test.ts` | ~180 | S12–S17 |
| `src/db/listing.ts` | ~80 | listAllTags / listRecentBooks（02 §10.3） |
| `src/db/listing.test.ts` | ~80 | S18 / S19 |
| `src/features/books/xlsx.ts` | ~70 | SheetJS 包装（05 §2.1） |
| `src/features/books/xlsx.test.ts` | ~80 | xlsx 解析用例 |
| `src/features/books/import-mapping.ts` | ~130 | 别名词典 + 列映射（05 §2.2） |
| `src/features/books/import-mapping.test.ts` | ~120 | 别名命中 / 手动改映射用例 |
| `src/backup/merge-borrowers.ts` | ~70 | 借书人合并逻辑（03 §4.5） |
| `src/backup/import-borrowers.test.ts` | ~120 | T17–T21（借书人合并 + replace/撤销交互） |
| `src/features/books/BulkImportSection.tsx` | ~250 | 导入区组件（自 NewBookPage 拆出，04 §11.1） |
| `src/features/books/BorrowForm.tsx` | ~150 | 借出弹窗（详情页与快速借出共用，04 §11.3/§11.7） |
| `src/features/loans/QuickLendDialog.tsx` | ~130 | 快速借出三步弹窗（04 §11.7） |
| `src/features/settings/SnapshotSection.tsx` | ~120 | 快照列表与恢复（04 §11.4） |
| `src/features/settings/BorrowerSection.tsx` | ~110 | 借书人管理（04 §11.3） |
| `src/app/UndoBanner.tsx` | ~60 | 30 秒撤销横幅（04 §6，AppShell 挂载） |

**修改文件（28 个）**：

| 文件 | 当前 | 增量 | 预计 | 备注 |
|---|---|---|---|---|
| `src/db/schema.ts` | 39 | +11 | ~50 | version(2) 加两表 |
| `src/db/client.ts` | 73 | +12 | ~85 | clearAllData 保留 settings/快照 |
| `src/db/copies.ts` | 224 | +16 | ~240 | deleteCopy 捕获 undo（02 §9.1） |
| `src/db/locations.ts` | 257 | +23 | ~280 | deleteLocation 级联捕获 undo |
| `src/db/loans.ts` | 165 | +10 | ~175 | loanOut 借书人 upsert（02 §5.5） |
| `src/db/settings.ts` | 98 | +4 | ~102 | SETTING_KEYS 增 `lastDraftPrefs` |
| `src/db/copies.test.ts` | 171 | +9 | ~180 | deleteCopy undo 交互 |
| `src/db/locations.test.ts` | 217 | +8 | ~225 | 位置级联 undo 交互 |
| `src/db/loans.test.ts` | 184 | +11 | ~195 | loanOut 触发借书人 upsert |
| `src/backup/format.ts` | 521 | +20 | ~541 | BackupFile 增 borrowers 段——存量 >500：B3 只追加字段，整体拆分入 01 §10 |
| `src/backup/export.ts` | 61 | +5 | ~66 | 导出 borrowers 数组 |
| `src/backup/import.ts` | 386 | +10 | ~396 | 调 `merge-borrowers`（存量 >300：B3 只加调用） |
| `src/backup/import.test.ts` | 531 | 0 | 531 | 不动（>500 存量；borrowers 用例走新文件） |
| `src/domain/types.ts` | 130 | +45 | ~175 | Borrower / Snapshot / ImportSummary.borrowers |
| `src/features/books/import.ts` | 257 | +13 | ~270 | 解析接入 location/copies 字段（映射逻辑已拆走） |
| `src/features/books/import.test.ts` | 174 | +56 | ~230 | 新列解析 / 默认值用例 |
| `src/features/books/write.ts` | 229 | +31 | ~260 | rememberDraftPrefs/applyDraftPrefs（04 §11.2） |
| `src/features/books/write.test.ts` | 263 | +32 | ~295 | 记忆用例（超 300 则拆 `write-memory.test.ts`） |
| `src/features/books/NewBookPage.tsx` | 380 | −130 | ~250 | 导入区拆出，仅挂载 BulkImportSection |
| `src/features/books/BookDetailPage.tsx` | 934 | −130 | ~804 | 借出弹窗迁至 BorrowForm——存量仍 >500，整体拆分入 01 §10 |
| `src/features/loans/write.ts` | 88 | +7 | ~95 | 快速借出复用校验入口 |
| `src/features/loans/LoansPage.tsx` | 275 | +15 | ~290 | 挂 QuickLendDialog |
| `src/features/search/SearchPage.tsx` | 259 | +16 | ~275 | 标签下拉（N1，04 §11.5） |
| `src/features/overview/OverviewPage.tsx` | 208 | +42 | ~250 | 最近添加区块（N2，04 §11.6） |
| `src/features/settings/SettingsPage.tsx` | 585 | −20 | ~565 | 快照/借书人区拆独立组件——存量 >500，整体拆分入 01 §10 |
| `src/app/startup.ts` | 24 | +6 | ~30 | expireUndo 调用（04 §4） |
| `src/app/AppShell.tsx` | 112 | +8 | ~120 | 挂 UndoBanner |
| `package.json` | 36 | +1 | ~37 | xlsx 依赖 |

**测试文件一律 ≤300 行设计目标**；超标的拆分计划已在备注列写明。

### 5.2 实现后实测与偏差（2026-09-13 交付）

B3 已实现并全绿：`npm test` 343 项通过、`npm run typecheck` 通过、`npm run build` 通过（xlsx 按需分包，独立 chunk）。
§5.1 是设计预算，本节是实现后的实测记录；两者不一致时以本节为准。

**拆分执行**：`BulkImportSection.tsx` 实测 340 行（>300 触发拆分审查）→ 拆出
`BulkImportPreview.tsx`（预览表 + 报告视图，135 行），拆后 219 行；测试按计划拆出
`write-memory.test.ts`（表单记忆，59 行）。

**跨越 300 行的文件与拆分审查结论**：

| 文件 | 预算 | 实测 | 审查结论 |
|---|---|---|---|
| `src/features/books/import.ts` | ~347 | 472 | 解析（源构造 + 行解析）与批量创建同居一文件；若继续增长，把 `sourceFrom*`/`rowsFromSource` 拆入 `import-source.ts`（~200 行） |
| `src/features/books/write.ts` | ~260 | 303 | 记忆函数（§11.2）是首位提取候选（→ `prefs.ts`）；当前仅超 3 行，不动 |
| `src/features/books/NewBookPage.tsx` | ~250 | 310 | 导入区已拆走；页面主体（表单 + AI 补全接线）仍 310，候选：拆 `AiAssistSection.tsx` |
| `src/features/loans/QuickLendDialog.tsx` | ~130 | 181 | 三步弹窗含两个子步骤组件；<300，不动 |
| `src/features/settings/BorrowerSection.tsx` | ~110 | 179 | 列表 + 编辑态 + 确认框；<300，不动 |

**存量 >500 的受动文件**（均在 §10 大文件拆分立项内）：`backup/format.ts` 600（borrowers 段 + 校验增量）、
`BookDetailPage.tsx` 865（借出弹窗已迁 BorrowForm，净减 ~70）、`SettingsPage.tsx` 593（快照/借书人已拆组件）。

**§5.1 未列出的新增文件**：`BulkImportPreview.tsx`(135)、`quick-lend.ts`(41) + `quick-lend.test.ts`(48)、
`write-memory.test.ts`(59)、`testing/indexeddb-setup.ts`(11)。

**测试预载（新增基础设施）**：`npm test` 现以 `node --import ./src/testing/indexeddb-setup.ts` 启动——
Dexie 在**模块初始化时**捕获 `indexedDB` 全局，而 `locations → snapshots → backup/export → schema` 这条
运行时导入链会早于 fake-indexeddb 把 Dexie 加载进来，导致 open() 一律 MissingAPIError。预载与测试文件的
导入顺序无关，恒有效；新测试文件不需要自己 import fake-indexeddb。

---

## 6. 工程硬约束

这些不是风格偏好，是**工具链决定的**——违反会导致测试跑不起来或数据出错。

1. **只用可擦除语法（erasable syntax only）**：不用 `enum`、`namespace`、构造函数参数属性、`declare` 字段初始化以外的 TS 运行时语法。用 `const` 对象 + 联合类型代替 `enum`。
   原因：测试直接由 Node 原生跑 `.ts`（类型擦除，无编译步骤）。用了非可擦除语法，`node --test` 直接报错。`tsconfig.json` 已开 `erasableSyntaxOnly` 把这条交给编译器把关。
2. **相对导入必须带 `.ts` 扩展名**（`import { x } from './x.ts'`）。Node 原生解析不做扩展名补全；Vite/Rollup 能正确处理并输出 `.js`。
3. **类型导入必须写 `import type`**（或行内 `type` 修饰）。`verbatimModuleSyntax` 已开启，类型擦除无法判断哪个名字是类型。
4. **时间一律以 ISO 8601 字符串入库**：
   - 时间戳（`createdAt`/`updatedAt`）→ `2026-09-11T11:39:52.000Z`（UTC）
   - 日期（`loanDate`/`dueDate`）→ `2026-09-11`（本地日历日）
   - **绝不把 `Date` 对象写进 IndexedDB**：JSON 往返后变字符串，类型骗人，排序行为也变。字符串同时可被 Dexie 索引与比较。
5. **所有写操作走 `src/db/` 的 service 函数**，不允许 UI 直接 `db.books.put(...)`。原因有三：`updatedAt` 必须统一刷新；位置改动后必须重建路径；导入需要一份可控的写入面。service 函数对同一批数据使用**单个事务**。
6. **Dexie 版本块只增不改**：已发布的 `version(N)` 一旦改动，老用户的升级路径就断了。加字段一律新增 `version(N+1)` 并在 `upgrade()` 里补默认值。详见 02 §8。
7. **类型检查必须过**：`npm run typecheck`（`tsc --noEmit`，`strict` + `noUncheckedIndexedAccess`）。

命令：

```
npm test          # node --test "src/**/*.test.ts"
npm run typecheck # tsc --noEmit
```

---

## 7. 关键决策记录

| # | 决策 | 备选方案 | 为什么这么选 |
|---|---|---|---|
| D1 | 唯一数据层用 Dexie/IndexedDB + JSON 自动快照兜底 | ① Tauri 用 SQLite、Capacitor 用 SQLite、Web 用 IndexedDB ② 纯 IndexedDB 不做兜底 | ① 变成两套数据代码 + 两套迁移，维护成本翻倍，且丢掉浏览器端 ② 把丢数据风险全押在用户记性上，不可接受 |
| D2 | 书目与副本分表 | 一本书 = 一行，多本存重复行 | 同一本书两本放不同位置、分别借出，是原文案明确要求的核心场景；单表无法表达 |
| D3 | 位置路径 `path` **物化存储**，任何位置变更后整树重算 | 每次查询时向上递归拼路径 | 藏书量下整树重算成本可忽略（几百个位置），换来：搜索/导出/展示零递归、导出文件自解释。代价是必须有一个唯一的重建入口，已定为 `rebuildLocationPaths()` |
| D4 | ISBN 规范化时把 ISBN-10 转成 ISBN-13 | 只做去连字符 | 同一本书手工录 ISBN-10、扫码得 ISBN-13 会造成两条书目记录；转换算法确定，成本极低 |
| D5 | 借出记录挂副本，且**只允许一条进行中的借出**（事务内强制） | 允许多条并行 | 一本书同时借给两个人是数据错误，不是业务需求；用不变式挡住比事后排查便宜 |
| D6 | 导入冲突按「**本地优先**」，被压掉的记录转历史并记警告 | 按时间戳 LWW 覆盖本地 | 正在进行的借出是现实世界的状态，导入一份别人的文件不应该把它改掉；宁可留下一条可见的冲突记录让用户自己修 |
| D7 | 自动快照 24h / 200 次写，滚动保留 5 份 | 每天定时 / 每次写都存 | 定时器在 App 里不可靠（进程会被挂起）；每次写都存会写爆磁盘。⚠️ 已被 D9 分层：该参数仅管「快照落盘」文件层（后续项）；库内快照用 20 次写/1 天/10 份（02 §12.3） |
| D8 | 测试用 Node 内置 runner + `fake-indexeddb`，不引入 Vitest | Vitest | 项目原则是依赖尽量少；`node --test` + 原生 TS 已实测可用（事务回滚、multiEntry 索引均验证通过） |
| D9 | 自动快照分两层：库内快照（P0-4，防误删误改，20 次写/1 天/保留 10 份）+ 快照落盘（后续项，防 IndexedDB 被清，原 D7 参数仍管文件层） | 单一文件快照方案 | 浏览器/PWA 无法静默写文件，文件层必须等宿主插件（Tauri/Capacitor）；库内快照立刻兑现「删除撤销 + 自动快照」且与撤销共用一张表 |
| D10 | xlsx 解析选 SheetJS CE，动态 `import()` 按需加载 | ① read-excel-file（仅 .xlsx）② 用户另存为 CSV | ① 用户书单「各种都有」（含旧 .xls）；② 另存为 CSV 是每批一次的额外步骤，正是痛点 #2 的一部分。动态加载保首屏体积 |

---

## 8. 开发路线图

对应用户方案 §九，每阶段都必须有可验收的产出。

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| A | 设计文档 | 本目录五份文档；五个坑（落盘、iOS 托管、合并规则、到期提醒、PWA 分流）都有明确结论 | ✅ 2026-09-11 |
| C | 数据层：四张表 + 服务 + 导入合并 + 单元测试 | `npm test` 全绿；`npm run typecheck` 通过；导出一份 JSON 再导入同一文件，第二次导入产生 0 处变更（幂等） | ✅ 2026-09-11（149/149 通过、typecheck 通过、幂等已验证） |
| B | 骨架与页面：Vite + React + Tailwind + 路由 + 五个页面 | 能在浏览器里加一本书、看到它出现在搜索和位置页 | ✅ 2026-09-12（五个页面 + 新增/详情页全部完成，typecheck/243 测试/构建全绿；加书→搜索/位置链路待用户真机验收） |
| D | 扫码与元数据：html5-qrcode + Open Library / Google Books | 扫一本真实书，书名作者出版自动填上；查不到时可手动补 |
| E | 备份 UI：导出下载 / 导入预览 / 冲突摘要展示 | 导入前能看到「新增 N、更新 M、跳过 K、警告列表」 | ✅ 2026-09-12（随阶段 B 交付：设置页已实现导出/导入/预览/冲突摘要；「快照落盘」移入 §3.2 第 3 层，作后续项） |
| F | PWA：manifest、图标、离线缓存 | 断网仍能打开并检索已有数据 | ✅ 2026-09-12（manifest/三张图标/手写 SW 就位并通过产物检查；部署工作流就位，Q3 已解；真机安装与断网验收待用户执行） |
| B2 | 批量导入（粘贴/CSV）+ AI 元数据补全（OpenAI 兼容接口自配）+ 界面精致化 | 粘贴一段书单一键建完（重复跳过并报告）；配好外部 AI 后能从书名/ISBN 一键补全元数据；界面质感升级且深浅色正常 | 🔨 2026-09-12 进行中（规范见 05，视觉基调见 04 §10） |
| B3 | P0 四件套 + N1-N3：批量导入升级（xlsx/列映射/位置副本标签列）、表单记忆、借书人候选、删除撤销 + 库内自动快照（schema v2）、搜索标签筛选、首页最近添加、快速借出 | 拖入 .xlsx 经预览映射一键建书+副本；连录不重选位置品相；借书人下拉自动填；误删 30 秒可撤销，快照可恢复；搜索页可按标签筛选；首页显示最近添加；借出页三步完成借出 | ✅ 2026-09-13 实现交付（规范：02 §5.5/§9.1/§10.3/§12、03 §2/§4.5、04 §11、05 §2；实现行数实测见 §5.1）；npm test 343/343、typecheck、build 全绿；真机验收待用户执行 |
| G | Tauri 桌面打包 | 产出安装包；**真机验证 `crypto.randomUUID` 是否存在并记录结论** |
| H | Capacitor 安卓打包 | 产出 APK；相机权限可用；`androidScheme: 'https'` 已配置 |
| I | 实测：录 50–100 本真实书 | 走完录入→找书→借出→归还→导出→导入全流程 |

---

## 9. 待决问题

| # | 问题 | 影响 | 状态 |
|---|---|---|---|
| Q1 | 项目根目录里的 `index.html` 是一个无关的井字棋页面（2026-09-11 生成）。Vite 要求入口 `index.html` 位于根目录，两者冲突。 | 曾阻塞阶段 B | **已解决**（2026-09-11）：该文件确认与本项目无关，移入 `scratch/` 保留；根 `index.html` 改写为本项目入口。见 04 §8 |
| Q2 | 本机未安装 git（`git` 不在 PATH，常见安装路径也没有），项目目前**没有版本控制**，也没有回滚保护。 | 影响所有阶段的可恢复性 | **待用户决定**：装 git，还是接受无 VCS |
| Q3 | iOS PWA 需要一个 HTTPS 地址。建议 GitHub Pages（免费、自带 HTTPS、子路径即 §4 的 `base`），但需要确认账号与仓库名。 | ✅ 2026-09-12：`SMMT543345/--`；部署工作流 `.github/workflows/deploy.yml` 已就位（推送到 main 自动构建+发布），待用户把代码推到仓库后生效。站点：`https://smmt543345.github.io/--/` |
| Q4 | Tailwind v4 要求 Node ≥ 20 与现代浏览器；Tauri 的 WebView2 与安卓 WebView（Android 7+）均满足。若后续要支持更老的安卓机，需回退 v3。 | 影响阶段 B | 暂按 v4，实测后再定 |

## 10. 后续项（明确不在 v1）

- 阅读状态（想读/在读/已读/评分/笔记）
- 位置照片
- 盘点模式、标签批量打印
- 系统通知级到期提醒（§1.1 第 3 条的 v2）
- 局域网主机模式（一台设备当服务端）
- 封面离线化：v1 只存 `coverUrl`，断网时封面会挂（书名等信息仍可用）；后续把封面存成 blob 到独立表
- 书脊 AI 识别
- 大文件拆分：`BookDetailPage.tsx`（934 行）、`SettingsPage.tsx`（585 行）、`backup/format.ts`（521 行）、`backup/import.test.ts`（531 行）已超 500 行硬上限——B3 只做减量/追加，整体拆分立项后续（01 §5.1）
