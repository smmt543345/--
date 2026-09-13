/**
 * 宿主文件落盘（01 §3.2 边界）：数据层只产出字符串，写文件是 platform 的事。
 * v1 浏览器走下载；Tauri / Capacitor 的分支在阶段 G/H 接入，届时只改本文件。
 */

export function downloadText(filename: string, text: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 立刻 revoke 会让部分浏览器来不及读取，延后一拍
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * 让用户选一个**二进制**文件并读出字节（xlsx/xls 导入，05 §2.1）；取消选择返回 null。
 * 与 pickTextFile 同一套口径：取消是 resolve(null) 而不是 reject，否则调用方的
 * await 会永远悬着（用户点一下「取消」界面就卡住）。
 */
export function pickBinaryFile(accept = '.xlsx,.xls'): Promise<{ name: string; bytes: Uint8Array } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file === undefined) {
        resolve(null);
        return;
      }
      file.arrayBuffer().then(
        (buffer) => resolve({ name: file.name, bytes: new Uint8Array(buffer) }),
        () => resolve(null),
      );
    });
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/**
 * 让用户选一个文本文件并读出内容；取消选择返回 null。
 * 不用 FileReader：File.text() 已是标准且更短。
 *
 * 连文件名一起返回：导入前要让用户确认「选中的是不是那个文件」，
 * 只给内容的话界面上没法回答这句话。
 */
export function pickTextFile(accept = '.json,application/json'): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file === undefined) {
        resolve(null);
        return;
      }
      file.text().then(
        (text) => resolve({ name: file.name, text }),
        () => resolve(null),
      );
    });
    // 用户直接关掉选择框时 change 不会触发，没有这一条 Promise 会永远悬着
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}
