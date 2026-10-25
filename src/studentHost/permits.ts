/**
 * 父进程持有的跨学生信号量。worker 用完必须 release；进程退出时 dropOwner 归还名额。
 * 等待按先来先服务。limit 是同时持有的个数，不是队列长度。
 * 后台任务（详情页解答的预生成等）排在所有前台请求之后，且上限大于 1 时不占最后一个空名额；
 * 前台排上队却没有空名额时，请正在用名额的后台任务让出来（preempt：worker 中止那次调用、归还名额，稍后重排）。
 */

interface Waiter { owner: string; id: string; grant: () => void; preempt?: () => void }

export class PermitPool {
  private readonly held = new Map<string, Set<string>>();
  private readonly queue: Waiter[] = [];
  private readonly backgroundQueue: Waiter[] = [];
  /** 正持有名额的后台任务：键 owner\0id，值是请它让出的回调（每次持有只请一次）。 */
  private readonly backgroundHeld = new Map<string, (() => void) | null>();
  private pumping = false;
  /** 名额从发出到归还的时间（只用于「人有点多」页的粗略等待估计，不参与调度）。 */
  private readonly grantedAt = new Map<string, number>();
  private holdAverageMs: number | null = null;

  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('并发上限必须是正整数');
  }

  /** 前台排队数（「人有点多」页用；后台任务不算）。 */
  get waiting(): number { return this.queue.length; }
  get inUse(): number { return this.inUseCount(); }
  /** 最近名额平均占用时长（指数滑动平均）；还没有完整样本时为 null。 */
  get averageHoldMs(): number | null { return this.holdAverageMs; }

  acquire(owner: string, id: string, grant: () => void, background = false, preempt?: () => void): void {
    if (!owner || !id) return;
    const mine = this.held.get(owner);
    if (mine?.has(id)) { grant(); return; }
    if ([...this.queue, ...this.backgroundQueue].some(waiter => waiter.owner === owner && waiter.id === id)) return;
    if (background) this.backgroundQueue.push({ owner, id, grant, preempt });
    else this.queue.push({ owner, id, grant });
    this.pump();
  }

  release(owner: string, id: string): void {
    const mine = this.held.get(owner);
    if (mine?.delete(id)) {
      if (mine.size === 0) this.held.delete(owner);
      const key = `${owner}\u0000${id}`; const started = this.grantedAt.get(key); this.grantedAt.delete(key); this.backgroundHeld.delete(key);
      if (started !== undefined) { const sample = Date.now() - started; this.holdAverageMs = this.holdAverageMs === null ? sample : this.holdAverageMs * 0.7 + sample * 0.3; }
      this.pump();
      return;
    }
    for (const queue of [this.queue, this.backgroundQueue]) {
      const index = queue.findIndex(waiter => waiter.owner === owner && waiter.id === id);
      if (index >= 0) queue.splice(index, 1);
    }
  }

  dropOwner(owner: string): void {
    this.held.delete(owner);
    for (const key of [...this.grantedAt.keys(), ...this.backgroundHeld.keys()]) if (key.startsWith(`${owner}\u0000`)) { this.grantedAt.delete(key); this.backgroundHeld.delete(key); }
    for (const queue of [this.queue, this.backgroundQueue]) {
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        if (queue[index]?.owner === owner) queue.splice(index, 1);
      }
    }
    this.pump();
  }

  private inUseCount(): number {
    let count = 0;
    for (const ids of this.held.values()) count += ids.size;
    return count;
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0 && this.inUseCount() < this.limit) this.grant(this.queue.shift()!);
      const backgroundLimit = this.limit > 1 ? this.limit - 1 : this.limit;
      while (this.queue.length === 0 && this.backgroundQueue.length > 0 && this.inUseCount() < backgroundLimit) this.grant(this.backgroundQueue.shift()!);
      // 前台还在等、名额满了：请后台任务让出。
      if (this.queue.length > 0) {
        for (const [key, preempt] of this.backgroundHeld) {
          if (!preempt) continue;
          this.backgroundHeld.set(key, null);
          preempt();
        }
      }
    } finally { this.pumping = false; }
  }

  private grant(next: Waiter): void {
    let mine = this.held.get(next.owner);
    if (!mine) { mine = new Set(); this.held.set(next.owner, mine); }
    mine.add(next.id);
    const key = `${next.owner}\u0000${next.id}`;
    this.grantedAt.set(key, Date.now());
    if (next.preempt) this.backgroundHeld.set(key, next.preempt);
    next.grant();
  }
}
