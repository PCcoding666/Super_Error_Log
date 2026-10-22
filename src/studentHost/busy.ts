/**
 * 「人有点多」（worker 名额满）时网关能如实说的话（P0-7 界面部分）。
 * 只用父进程真有的数据：存活 worker 数与上限、全机 AI 名额的占用/排队与最近平均耗时、
 * 最近被挡在外面、还在自动重试的其他学生人数。不排号、不承诺顺序；估计只给下限。
 */
import type { CapacitySnapshot } from './workers.js';

/** 503 页自动重试间隔（秒），同时作为 Retry-After。 */
export const CAPACITY_RETRY_SECONDS = 30;
/** 多久没再来重试就不算「还在等」。比两次自动重试的间隔长一些。 */
const WAITING_WINDOW_MS = 3 * CAPACITY_RETRY_SECONDS * 1000;

/** 被名额挡住的学生（只存在内存里，只给出人数）。进去了就移除。 */
export class CapacityWaitlist {
  private readonly seen = new Map<string, number>();
  constructor(private readonly now: () => number = () => Date.now(), private readonly windowMs = WAITING_WINDOW_MS) {}
  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    for (const [id, at] of this.seen) if (at < cutoff) this.seen.delete(id);
  }
  /** 记下这个学生又被挡了一次；返回「另外还在等的人数」。 */
  rejected(studentId: string): number {
    this.prune();
    this.seen.set(studentId, this.now());
    return this.seen.size - 1;
  }
  admitted(studentId: string): void { this.seen.delete(studentId); }
}

export interface CapacityFacts { snapshot: CapacitySnapshot; othersWaiting: number }

/** AI 队列里已经排着的请求至少还要多少分钟（下限）；没有耗时样本或队列空时返回 null。 */
export function aiQueueMinutes(s: CapacitySnapshot): number | null {
  const queued = s.aiInUse + s.aiWaiting;
  if (!queued || s.aiAverageMs === null || s.aiAverageMs <= 0) return null;
  return Math.max(1, Math.ceil((queued * s.aiAverageMs) / Math.max(1, s.aiLimit) / 60_000));
}

/** 给学生看的几句真话（17–18 岁，不用内部名词）。 */
export function capacityLines({ snapshot: s, othersWaiting }: CapacityFacts): string[] {
  const lines: string[] = [];
  lines.push(s.maxLive > 0
    ? `现在最多同时开 ${s.maxLive} 个同学的错题本，${s.live >= s.maxLive ? `${s.maxLive} 个都` : `${s.live} 个`}在用：有人正在打开页面，或者照片还在整理。他们用完才会空出位置。`
    : '现在打开的人太多，要等别人用完才会空出位置。');
  if (othersWaiting > 0) lines.push(`除了你，还有 ${othersWaiting} 位同学也在等。不是按先来后到排号，谁先重试到空位谁先进。`);
  const queued = s.aiInUse + s.aiWaiting;
  const minutes = aiQueueMinutes(s);
  if (queued > 0) {
    lines.push(`整理照片的 AI 同时只能做 ${s.aiLimit} 件事，现在正在做 ${s.aiInUse} 件，还有 ${s.aiWaiting} 件在排队${s.aiAverageMs ? `，最近每件大约 ${Math.max(1, Math.round(s.aiAverageMs / 1000))} 秒` : ''}。`);
    lines.push(minutes !== null
      ? `只算已经排着的这些，至少还要约 ${minutes} 分钟；他们一套卷子可能还有更多，所以实际可能更久。`
      : '要等多久说不准，取决于前面同学的照片什么时候整理完。');
  } else {
    lines.push('要等多久说不准：可能一两分钟，也可能更久。');
  }
  return lines;
}
