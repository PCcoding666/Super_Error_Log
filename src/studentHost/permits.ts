/**
 * 父进程持有的跨学生信号量。worker 用完必须 release；进程退出时 dropOwner 归还名额。
 * 等待按先来先服务。limit 是同时持有的个数，不是队列长度。
 */

interface Waiter { owner: string; id: string; grant: () => void }

export class PermitPool {
  private readonly held = new Map<string, Set<string>>();
  private readonly queue: Waiter[] = [];
  private pumping = false;

  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('并发上限必须是正整数');
  }

  get waiting(): number { return this.queue.length; }
  get inUse(): number { return this.inUseCount(); }

  acquire(owner: string, id: string, grant: () => void): void {
    if (!owner || !id) return;
    const mine = this.held.get(owner);
    if (mine?.has(id)) { grant(); return; }
    if (this.queue.some(waiter => waiter.owner === owner && waiter.id === id)) return;
    this.queue.push({ owner, id, grant });
    this.pump();
  }

  release(owner: string, id: string): void {
    const mine = this.held.get(owner);
    if (mine?.delete(id)) {
      if (mine.size === 0) this.held.delete(owner);
      this.pump();
      return;
    }
    const index = this.queue.findIndex(waiter => waiter.owner === owner && waiter.id === id);
    if (index >= 0) this.queue.splice(index, 1);
  }

  dropOwner(owner: string): void {
    this.held.delete(owner);
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      if (this.queue[index]?.owner === owner) this.queue.splice(index, 1);
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
      while (this.queue.length > 0 && this.inUseCount() < this.limit) {
        const next = this.queue.shift()!;
        let mine = this.held.get(next.owner);
        if (!mine) { mine = new Set(); this.held.set(next.owner, mine); }
        mine.add(next.id);
        next.grant();
      }
    } finally { this.pumping = false; }
  }
}
