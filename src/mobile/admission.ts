/**
 * 入口容量与资源门槛（Task 3）。
 * - 上传槽位：同时最多 1 个上传正文在解析；满则 429 busy 可重试，不在内存排队。
 * - 任务容量：待处理（含运行中）最多 jobCapacity 张照片；满则 429 capacity_full。
 * - 磁盘门槛：系统盘 <3GiB 或数据目录 10GiB 拒收新上传（503，提示管理）。
 * - 共享图像信号量：本进程内 normalize / 裁切 / 打印遮白互斥；学生 worker 再向父进程借全局名额。
 *   `sharp.concurrency(1)` 不等于跨请求串行。
 * 单进程 RSS 观测阈值在 service 层实现（相对整个服务预算，不是固定 768MiB），不经由此类。
 */
import { withParentPermit } from '../studentHost/parentPermit.js';

export interface AdmissionControllerOptions {
  /** 待处理容量上限（含运行中）。默认 10。 */
  jobCapacity?: number;
  /** 系统盘可用字节探测。缺省用真实 df 探测。 */
  diskProbe?: () => Promise<bigint>;
  /** 数据目录已用字节探测。缺省用真实目录大小递归统计。 */
  dataUsageProbe?: () => Promise<bigint>;
  /** Clock for the upload-slot retry estimate. Tests pass a fake. */
  now?: () => number;
}

export const DISK_LOW_THRESHOLD_BYTES = 3n * 1024n ** 3n;
export const DATA_QUOTA_BYTES = 10n * 1024n ** 3n;
/**
 * A 12MP JPEG often holds the single parse slot for much longer than a second
 * (production: ~3.9MB 3024×4032, two immediate 429s, success ~64s later).
 * Tell the client to wait out a typical hold, never less than the floor, never more than the cap.
 */
export const UPLOAD_SLOT_TYPICAL_HOLD_MS = 20_000;
export const UPLOAD_SLOT_RETRY_FLOOR_SECONDS = 8;
export const UPLOAD_SLOT_RETRY_CAP_SECONDS = 30;
export const CAPACITY_FULL_RETRY_SECONDS = 30;
/** RSS admission pause is recoverable, but not in a second. */
export const SERVICE_PAUSED_RETRY_SECONDS = 20;

/** Seconds a rejected upload should wait. `typicalHoldMs` is overridable so the cap can be tested. */
export function uploadSlotRetryAfterSeconds(elapsedMs: number, typicalHoldMs = UPLOAD_SLOT_TYPICAL_HOLD_MS): number {
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const estimate = Math.ceil((typicalHoldMs - elapsed) / 1000);
  return Math.min(UPLOAD_SLOT_RETRY_CAP_SECONDS, Math.max(UPLOAD_SLOT_RETRY_FLOOR_SECONDS, estimate));
}

type Release = () => void;

let imageBusy = false;
const imageWaiters: Array<() => void> = [];

/** 本进程内的图片处理互斥，并在学生 worker 里向父进程申请全局名额。 */
export async function acquireProcessImage(): Promise<Release> {
  if (imageBusy) {
    await new Promise<void>(resolve => { imageWaiters.push(resolve); });
  } else {
    imageBusy = true;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = imageWaiters.shift();
    if (next) { next(); return; }
    imageBusy = false;
  };
}

export async function withProcessImage<T>(section: () => Promise<T>, options: { background?: boolean } = {}): Promise<T> {
  const release = await acquireProcessImage();
  try { return await withParentPermit('image', section, options); }
  finally { release(); }
}

async function defaultDiskFree(): Promise<bigint> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const stat = await promisify(execFile)('df', ['-k', '/']);
  const line = stat.stdout.split('\n')[1] ?? '';
  const availableKb = Number(line.trim().split(/\s+/)[3] ?? '0');
  return BigInt(availableKb) * 1024n;
}

async function defaultDataUsage(dataDir: string): Promise<bigint> {
  const fs = await import('node:fs/promises');
  let total = 0n;
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) total += BigInt((await fs.stat(full)).size);
    }
  };
  await walk(dataDir).catch(() => undefined);
  return total;
}

export class AdmissionController {
  private readonly jobCapacity: number;
  private readonly diskProbe: () => Promise<bigint>;
  private readonly dataUsageProbe: () => Promise<bigint>;
  private pendingJobs = 0;
  private uploadSlotBusy = false;
  private uploadSlotAcquiredAt = 0;
  private readonly now: () => number;

  constructor(options: AdmissionControllerOptions & { dataDir?: string } = {}) {
    this.jobCapacity = options.jobCapacity ?? 10;
    const dataDir = options.dataDir;
    this.diskProbe = options.diskProbe ?? defaultDiskFree;
    this.dataUsageProbe = options.dataUsageProbe ?? (dataDir ? () => defaultDataUsage(dataDir) : () => Promise.resolve(0n));
    this.now = options.now ?? (() => Date.now());
  }

  tryAcquireUploadSlot(_deviceId: string): { accepted: boolean; retryAfterSeconds: number } {
    if (this.uploadSlotBusy) {
      const elapsed = this.uploadSlotAcquiredAt > 0 ? this.now() - this.uploadSlotAcquiredAt : 0;
      return { accepted: false, retryAfterSeconds: uploadSlotRetryAfterSeconds(elapsed) };
    }
    this.uploadSlotBusy = true;
    this.uploadSlotAcquiredAt = this.now();
    return { accepted: true, retryAfterSeconds: 0 };
  }

  releaseUploadSlot(_deviceId: string): void {
    this.uploadSlotBusy = false;
    this.uploadSlotAcquiredAt = 0;
  }

  tryAcquireJobCapacity(): { accepted: boolean; retryAfterSeconds: number } {
    if (this.pendingJobs >= this.jobCapacity) return { accepted: false, retryAfterSeconds: CAPACITY_FULL_RETRY_SECONDS };
    this.pendingJobs += 1;
    return { accepted: true, retryAfterSeconds: 0 };
  }

  releaseJobCapacity(): void {
    if (this.pendingJobs > 0) this.pendingJobs -= 1;
  }

  /** 恢复扫描登记的既有任务占用：无条件 +1（历史超额任务允许继续处理，只拦新增）。 */
  noteExistingOccupancy(): void {
    this.pendingJobs += 1;
  }

  /** 图片处理互斥：覆盖 normalize、上传 metadata 检查、vision 裁切和打印遮白。 */
  acquireImage(): Promise<Release> {
    return acquireProcessImage();
  }

  /** 包裹图片处理段，确保本进程互斥，并在 worker 里占用父进程的全局图片名额。 */
  withImage<T>(section: () => Promise<T>): Promise<T> {
    return withProcessImage(section);
  }

  async storageGate(): Promise<{ ok: boolean; reason?: 'disk_low' | 'data_quota' }> {
    const [free, used] = await Promise.all([this.diskProbe().catch(() => DISK_LOW_THRESHOLD_BYTES), this.dataUsageProbe().catch(() => 0n)]);
    if (free < DISK_LOW_THRESHOLD_BYTES) return { ok: false, reason: 'disk_low' };
    if (used >= DATA_QUOTA_BYTES) return { ok: false, reason: 'data_quota' };
    return { ok: true };
  }

  async accepting(): Promise<boolean> {
    const gate = await this.storageGate();
    return gate.ok && this.pendingJobs < this.jobCapacity;
  }
}
