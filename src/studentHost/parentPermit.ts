/**
 * 学生 worker 向父进程借名额。不是 worker（没有 IPC）时直接执行，单进程测试不受影响。
 * 视觉模型调用和 sharp 解码用不同的 kind，避免一次长识别堵住所有图片处理。
 */
type PermitKind = 'ai' | 'image';

interface Waiter { resolve: () => void; reject: (error: Error) => void }

let sequence = 0;
let listenerInstalled = false;
const waiters = new Map<string, Waiter>();

export function parentPermitsEnabled(): boolean {
  return process.env.SEL_STUDENT_WORKER === '1' && typeof process.send === 'function';
}

export function installParentPermitListener(): void {
  if (listenerInstalled || !parentPermitsEnabled()) return;
  listenerInstalled = true;
  process.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object' || (message as { type?: unknown }).type !== 'permit') return;
    const id = (message as { id?: unknown }).id;
    if (typeof id !== 'string') return;
    const waiter = waiters.get(id);
    if (!waiter) return;
    waiters.delete(id);
    waiter.resolve();
  });
}

export async function withParentPermit<T>(kind: PermitKind, work: () => Promise<T>): Promise<T> {
  if (!parentPermitsEnabled()) return work();
  installParentPermitListener();
  const id = `${kind}:${process.pid}:${sequence += 1}`;
  await new Promise<void>((resolve, reject) => {
    waiters.set(id, { resolve, reject });
    try {
      process.send!({ type: 'acquire', kind, id }, error => {
        if (!error) return;
        const pending = waiters.get(id);
        if (!pending) return;
        waiters.delete(id);
        pending.reject(error);
      });
    } catch (error) {
      waiters.delete(id);
      reject(error instanceof Error ? error : new Error('无法向父进程申请处理名额'));
    }
  });
  try { return await work(); }
  finally {
    try { process.send?.({ type: 'release', kind, id }); } catch { /* 父进程已退出，worker 会跟着结束 */ }
  }
}
