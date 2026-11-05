/**
 * 网关的实时人数与 AI 并发（只有计数，不含学生身份）。
 *
 * - 「在用的人」：最近 5 分钟有请求经过网关的学生数；「打开的错题本」：存活 worker 数（上限 SEL_MAX_LIVE_WORKERS）。
 * - AI：全机 AI 名额正在用 / 排队 / 最近平均耗时（上限 SEL_GLOBAL_AI_CONCURRENCY）。
 * - 每 5 秒采样一次，按分钟记峰值；最近 5 分钟、今天（北京时间）各给一份峰值和「名额满被挡」次数。
 *
 * 管理后台直接读 status()；巡检脚本（deploy/ops/sel-healthcheck.mjs，另一个进程）读每 15 秒写一次的
 * live-status.json。都只在内存里，服务重启后「今天」从重启时算起。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { CapacitySnapshot } from './workers.js';

export const LIVE_STATUS_FILE = 'live-status.json';
const ACTIVE_WINDOW_MS = 5 * 60_000;
const SAMPLE_MS = 5_000;
const WRITE_MS = 15_000;
const MINUTE = 60_000;

export interface LivePeaks {
  /** 同时打开的错题本最多几个。 */
  peakLive: number;
  /** 在用的人（最近 5 分钟有请求）最多几个。 */
  peakActive: number;
  peakAiInUse: number;
  peakAiWaiting: number;
  /** 名额满被挡的次数（同一个人自动重试会重复计）。 */
  capacityRejections: number;
  /** 被挡过的不同学生数。 */
  rejectedStudents: number;
}

export interface LiveStatus {
  at: string;
  activeStudents: number;
  live: number;
  maxLive: number;
  aiLimit: number;
  aiInUse: number;
  aiWaiting: number;
  aiAverageMs: number | null;
  /** 正被名额挡着、还在自动重试的学生数。 */
  waitingOutside: number;
  last5m: LivePeaks;
  /** 北京时间今天，从服务启动起算。 */
  today: LivePeaks & { day: string; since: string };
}

interface Bucket { peakLive: number; peakActive: number; peakAiInUse: number; peakAiWaiting: number; rejections: number; rejected: Set<string> }

const shanghaiDay = (ms: number): string => new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10);
const emptyBucket = (): Bucket => ({ peakLive: 0, peakActive: 0, peakAiInUse: 0, peakAiWaiting: 0, rejections: 0, rejected: new Set() });

export interface LiveStatsOptions {
  snapshot: () => CapacitySnapshot;
  waitingOutside?: () => number;
  now?: () => number;
}

export class LiveStats {
  private readonly lastSeen = new Map<string, number>();
  private readonly minutes = new Map<number, Bucket>();
  private today: Bucket = emptyBucket();
  private day: string;
  private since: number;
  private readonly snapshot: () => CapacitySnapshot;
  private readonly waitingOutside: () => number;
  private readonly now: () => number;
  private timers: NodeJS.Timeout[] = [];

  constructor(options: LiveStatsOptions) {
    this.snapshot = options.snapshot;
    this.waitingOutside = options.waitingOutside ?? (() => 0);
    this.now = options.now ?? Date.now;
    this.since = this.now();
    this.day = shanghaiDay(this.since);
  }

  /** 网关每转发一个已登录学生的请求就调用一次。 */
  seen(studentId: string): void {
    this.lastSeen.set(studentId, this.now());
  }

  /** 名额满、这个学生没能打开错题本。 */
  rejected(studentId: string): void {
    const at = this.now();
    for (const bucket of [this.bucket(at), this.todayBucket(at)]) { bucket.rejections += 1; bucket.rejected.add(studentId); }
  }

  /** 采样一次当前值，记进本分钟和今天的峰值。 */
  sample(): void {
    const at = this.now();
    const s = this.snapshot();
    const active = this.activeCount(at);
    for (const bucket of [this.bucket(at), this.todayBucket(at)]) {
      bucket.peakLive = Math.max(bucket.peakLive, s.live);
      bucket.peakActive = Math.max(bucket.peakActive, active);
      bucket.peakAiInUse = Math.max(bucket.peakAiInUse, s.aiInUse);
      bucket.peakAiWaiting = Math.max(bucket.peakAiWaiting, s.aiWaiting);
    }
  }

  status(): LiveStatus {
    this.sample();
    const at = this.now();
    const s = this.snapshot();
    const recent = [...this.minutes.entries()].filter(([minute]) => minute > Math.floor(at / MINUTE) - 5).map(([, bucket]) => bucket);
    const last5m = peaks(recent);
    return {
      at: new Date(at).toISOString(), activeStudents: this.activeCount(at),
      live: s.live, maxLive: s.maxLive, aiLimit: s.aiLimit, aiInUse: s.aiInUse, aiWaiting: s.aiWaiting, aiAverageMs: s.aiAverageMs,
      waitingOutside: this.waitingOutside(), last5m,
      today: { ...peaks([this.today]), day: this.day, since: new Date(this.since).toISOString() },
    };
  }

  /** 开始采样，并定期把 status() 写到 dir/live-status.json（原子替换，仅应用用户可读）。 */
  start(dir: string): void {
    if (this.timers.length) return;
    const file = path.join(dir, LIVE_STATUS_FILE);
    const write = (): void => {
      try {
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify(this.status())}\n`, { mode: 0o600 });
        fs.renameSync(tmp, file);
      } catch { /* 巡检会因为文件过期报「实时状态没有更新」 */ }
    };
    write();
    this.timers = [setInterval(() => this.sample(), SAMPLE_MS), setInterval(write, WRITE_MS)];
    for (const timer of this.timers) timer.unref();
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  private activeCount(at: number): number {
    for (const [id, seenAt] of this.lastSeen) if (seenAt <= at - ACTIVE_WINDOW_MS) this.lastSeen.delete(id);
    return this.lastSeen.size;
  }

  private bucket(at: number): Bucket {
    const minute = Math.floor(at / MINUTE);
    for (const key of this.minutes.keys()) if (key <= minute - 5) this.minutes.delete(key);
    let bucket = this.minutes.get(minute);
    if (!bucket) { bucket = emptyBucket(); this.minutes.set(minute, bucket); }
    return bucket;
  }

  private todayBucket(at: number): Bucket {
    const day = shanghaiDay(at);
    if (day !== this.day) { this.day = day; this.since = at; this.today = emptyBucket(); }
    return this.today;
  }
}

function peaks(buckets: Bucket[]): LivePeaks {
  const rejected = new Set<string>();
  for (const bucket of buckets) for (const id of bucket.rejected) rejected.add(id);
  return {
    peakLive: Math.max(0, ...buckets.map(b => b.peakLive)),
    peakActive: Math.max(0, ...buckets.map(b => b.peakActive)),
    peakAiInUse: Math.max(0, ...buckets.map(b => b.peakAiInUse)),
    peakAiWaiting: Math.max(0, ...buckets.map(b => b.peakAiWaiting)),
    capacityRejections: buckets.reduce((sum, b) => sum + b.rejections, 0),
    rejectedStudents: rejected.size,
  };
}
