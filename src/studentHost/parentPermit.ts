/**
 * 学生 worker 向父进程借名额。不是 worker（没有 IPC）时直接执行，单进程测试不受影响。
 * 视觉模型调用和 sharp 解码用不同的 kind，避免一次长识别堵住所有图片处理。
 */
type PermitKind = 'ai' | 'image';

interface Waiter { resolve: () => void; reject: (error: Error) => void }

let sequence = 0;
let listenerInstalled = false;
const waiters = new Map<string, Waiter>();
/** 正在用名额的后台任务：父进程请它让出时调用。 */
const preemptions = new Map<string, () => void>();

/** 后台任务的名额被前台请求要走了：调用方中止这次工作、稍后重排，不算失败。 */
export class PreemptedError extends Error {
  constructor() { super('后台任务让出了名额'); this.name = 'PreemptedError'; }
}

export function parentPermitsEnabled(): boolean {
  return process.env.SEL_STUDENT_WORKER === '1' && typeof process.send === 'function';
}

export function installParentPermitListener(): void {
  if (listenerInstalled || !parentPermitsEnabled()) return;
  listenerInstalled = true;
  process.on('message', (message: unknown) => {
    const type = message && typeof message === 'object' ? (message as { type?: unknown }).type : null;
    const id = message && typeof message === 'object' ? (message as { id?: unknown }).id : null;
    if (typeof id !== 'string') return;
    if (type === 'preempt') { preemptions.get(id)?.(); return; }
    if (type !== 'permit') return;
    const waiter = waiters.get(id);
    if (!waiter) return;
    waiters.delete(id);
    waiter.resolve();
  });
}

/** background：后台任务，排在所有前台请求之后（见 permits.ts）；onPreempt：拿到名额后父进程请它让出时调用。 */
export async function withParentPermit<T>(kind: PermitKind, work: () => Promise<T>, options: { background?: boolean; onPreempt?: () => void } = {}): Promise<T> {
  if (!parentPermitsEnabled()) return work();
  installParentPermitListener();
  const id = `${kind}:${process.pid}:${sequence += 1}`;
  await new Promise<void>((resolve, reject) => {
    waiters.set(id, { resolve, reject });
    try {
      process.send!({ type: 'acquire', kind, id, background: options.background === true }, error => {
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
  if (options.onPreempt) preemptions.set(id, options.onPreempt);
  try { return await work(); }
  finally {
    preemptions.delete(id);
    try { process.send?.({ type: 'release', kind, id }); } catch { /* 父进程已退出，worker 会跟着结束 */ }
  }
}
