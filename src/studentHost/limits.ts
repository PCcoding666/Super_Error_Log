/**
 * 多学生容量的环境变量。缺省按 4 核 / 8 GB 的推荐档；2 核 / 1.8 GB 小机要改小，见 deploy/README.md。
 * 这里只解析数字，不启动进程，也不打开数据库。
 */

export const DEFAULT_MAX_STUDENTS = 50;
export const DEFAULT_WORKER_IDLE_MS = 12 * 60 * 1000;
export const DEFAULT_MAX_LIVE_WORKERS = 8;
export const DEFAULT_AI_CONCURRENCY = 2;
export const DEFAULT_IMAGE_CONCURRENCY = 2;
export const DEFAULT_SERVICE_MEMORY_MIB = 4096;

const MIB = 1024 * 1024;

function readInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min} 到 ${max} 的整数`);
  }
  return value;
}

/** 注册表里最多允许多少个学生空间。SEL_MAX_STUDENTS 缺省 50。 */
export function maxStudentsLimit(env: NodeJS.ProcessEnv = process.env): number {
  return readInt(env, 'SEL_MAX_STUDENTS', DEFAULT_MAX_STUDENTS, 1, 500);
}

/** worker 空闲多久后退出。0 表示不因空闲退出。缺省 12 分钟。 */
export function workerIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  return readInt(env, 'SEL_WORKER_IDLE_MS', DEFAULT_WORKER_IDLE_MS, 0, 24 * 60 * 60 * 1000);
}

/** 同时存活的学生 worker 上限。0 表示不限制。缺省 8。 */
export function maxLiveWorkers(env: NodeJS.ProcessEnv = process.env): number {
  return readInt(env, 'SEL_MAX_LIVE_WORKERS', DEFAULT_MAX_LIVE_WORKERS, 0, 500);
}

export function aiConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  return readInt(env, 'SEL_GLOBAL_AI_CONCURRENCY', DEFAULT_AI_CONCURRENCY, 1, 32);
}

export function imageConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  return readInt(env, 'SEL_GLOBAL_IMAGE_CONCURRENCY', DEFAULT_IMAGE_CONCURRENCY, 1, 32);
}

/**
 * 单进程 RSS 超过该值就暂停接收新识别任务（应用层准入，不是 cgroup 硬限制）。
 * - SEL_RSS_ADMISSION_MIB 优先，64–8192。
 * - 否则用服务预算 SEL_SERVICE_MEMORY_MIB（缺省 4096，对应推荐的 MemoryMax=4G）。
 * - 学生 worker：预算的一半 ÷ 存活上限，夹在 192–512 MiB。
 * - 主进程：预算的 60%，夹在 256–512 MiB。
 */
export function rssAdmissionThresholdBytes(env: NodeJS.ProcessEnv = process.env): number {
  const explicit = env.SEL_RSS_ADMISSION_MIB;
  if (explicit !== undefined && explicit.trim() !== '') return readInt(env, 'SEL_RSS_ADMISSION_MIB', 0, 64, 8192) * MIB;
  const budget = readInt(env, 'SEL_SERVICE_MEMORY_MIB', DEFAULT_SERVICE_MEMORY_MIB, 256, 65_536);
  if (env.SEL_STUDENT_WORKER !== '1') return Math.min(512, Math.max(256, Math.floor(budget * 0.6))) * MIB;
  const slots = Math.max(readInt(env, 'SEL_MAX_LIVE_WORKERS', DEFAULT_MAX_LIVE_WORKERS, 0, 500), 1);
  const share = Math.floor(budget * 0.5 / slots);
  return Math.min(512, Math.max(192, share)) * MIB;
}
