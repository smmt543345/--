/**
 * 测试预载（npm test 的 --import 参数）：在任何模块之前装好假 IndexedDB。
 *
 * 为什么必须预载而不是在 harness 里 import：Dexie 在**模块初始化时**捕获
 * `indexedDB` 全局。若某个 db 模块（经运行时导入链，如 locations → snapshots →
 * backup/export → schema）先于 fake-indexeddb 被加载，Dexie 捕获到的是 undefined，
 * 之后 open() 一律抛 MissingAPIError。预载与测试文件的导入顺序无关，恒有效。
 */

import 'fake-indexeddb/auto';
