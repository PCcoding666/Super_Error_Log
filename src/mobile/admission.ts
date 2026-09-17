/**
 * 入口容量与资源门槛（Task 3）。
 * - 上传槽位：同时最多 1 个上传正文在解析；满则 429 busy 可重试，不在内存排队。
 * - 任务容量：待处理（含运行中）最多 jobCapacity 张照片；满则 429 capacity_full。
 * - 磁盘门槛：系统盘 <3GiB 或数据目录 10GiB 拒收新上传（503，提示管理）。
 * - 共享图像信号量：normalizePhoto / 上传 metadata 检查 / vision 题图与图示裁切的显式互斥；
 *   `sharp.concurrency(1)` 不等于跨请求串行。
 * 单进程 RSS 观测阈值（768MiB）在 service 层实现，不经由此类。
 */

export interface AdmissionControllerOptions {
  /** 待处理容量上限（含运行中）。默认 10。 */
  jobCapacity?: number;
  /** 系统盘可用字节探测。缺省用真实 df 探测。 */
  diskProbe?: () => Promise<bigint>;
  /** 数据目录已用字节探测。缺省用真实目录大小递归统计。 */
  dataUsageProbe?: () => Promise<bigint>;
}

export const DISK_LOW_THRESHOLD_BYTES = 3n * 1024n ** 3n;
export const DATA_QUOTA_BYTES = 10n * 1024n ** 3n;

type Release = () => void;

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
  private imageBusy = false;
  private imageWaiters: Array<() => void> = [];

  constructor(options: AdmissionControllerOptions & { dataDir?: string } = {}) {
    this.jobCapacity = options.jobCapacity ?? 10;
    const dataDir = options.dataDir;
    this.diskProbe = options.diskProbe ?? defaultDiskFree;
    this.dataUsageProbe = options.dataUsageProbe ?? (dataDir ? () => defaultDataUsage(dataDir) : () => Promise.resolve(0n));
  }

  tryAcquireUploadSlot(_deviceId: string): { accepted: boolean; retryAfterSeconds: number } {
    if (this.uploadSlotBusy) return { accepted: false, retryAfterSeconds: 1 };
    this.uploadSlotBusy = true;
    return { accepted: true, retryAfterSeconds: 0 };
  }

  releaseUploadSlot(_deviceId: string): void {
    this.uploadSlotBusy = false;
  }

  tryAcquireJobCapacity(): { accepted: boolean; retryAfterSeconds: number } {
    if (this.pendingJobs >= this.jobCapacity) return { accepted: false, retryAfterSeconds: 30 };
    this.pendingJobs += 1;
    return { accepted: true, retryAfterSeconds: 0 };
  }

  releaseJobCapacity(): void {
    if (this.pendingJobs > 0) this.pendingJobs -= 1;
  }

  /** 图片处理互斥：覆盖 normalizePhoto、上传 metadata 检查与 vision 裁切。 */
  async acquireImage(): Promise<Release> {
    if (this.imageBusy) {
      await new Promise<void>(resolve => { this.imageWaiters.push(resolve); });
      // 被唤醒即已获得所有权：release 时直接移交给队首等待者（imageBusy 不清零，无插队空窗）。
    } else {
      this.imageBusy = true;
    }
    let released = false;
    return () => {
      if (released) return; // 每闭包一次：重复释放（finally+close 兜底双触发等）无效。
      released = true;
      const next = this.imageWaiters.shift();
      if (next) { next(); return; } // 所有权直接移交：imageBusy 保持 true。
      this.imageBusy = false;
    };
  }

  /** 包裹图片处理段，确保互斥与释放。 */
  async withImage<T>(section: () => Promise<T>): Promise<T> {
    const release = await this.acquireImage();
    try { return await section(); } finally { release(); }
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
