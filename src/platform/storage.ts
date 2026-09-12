/**
 * 持久化存储申请（01 §3.2 第 1 条）。
 * 被授予后浏览器不再自动清理本站数据（Chrome/Edge 有效，Safari 无效）。
 * **这一条只是加分项，失败不阻塞启动。**
 */

export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === 'undefined') return false;
  const storage = (navigator as Partial<Navigator>).storage;
  if (storage === undefined || typeof storage.persist !== 'function') return false;
  try {
    if (typeof storage.persisted === 'function' && (await storage.persisted())) return true;
    return await storage.persist();
  } catch {
    return false;
  }
}
