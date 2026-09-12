/**
 * 构建目标（01 §4）。值由 vite.config.ts 的 define 在构建期注入；
 * 类型只在这一处声明。Service Worker 等「只属于 web」的代码拿它当开关。
 *
 * 注意：node --test 直接跑本文件会因 __BUILD_TARGET__ 未定义而报错，
 * 所以测试代码不要 import 它（测试也不需要构建目标）。
 */
declare const __BUILD_TARGET__: 'web' | 'tauri' | 'android';

export const BUILD_TARGET: 'web' | 'tauri' | 'android' = __BUILD_TARGET__;
