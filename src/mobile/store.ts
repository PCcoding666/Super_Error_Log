import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { MOBILE_CONTRACT_VERSION, publicJob, type RecognitionFailure, type RecognitionJob, type StoredRecognitionJob } from './contracts.js';

const execFileAsync = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256 = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
const MAX_ATTEMPT_FILE_BYTES = 3_000_000;

export class IdempotencyConflictError extends Error {}
export class UnknownMediaError extends Error {}

async function durableWrite(filename: string, bytes: Buffer | string): Promise<void> {
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.promises.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await fs.promises.rename(temporary, filename);
  await fs.promises.chmod(filename, 0o600);
  const directory = await fs.promises.open(path.dirname(filename), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

async function privateDirectory(directory: string): Promise<void> {
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.promises.chmod(directory, 0o700);
}

async function excludeFromBackup(directory: string): Promise<void> {
  if (process.platform !== 'darwin') return;
  try {
    await execFileAsync('/usr/bin/xattr', ['-w', 'com.apple.metadata:com_apple_backup_excludeItem', 'com.apple.backupd', directory], { timeout: 5000 });
  } catch {
    throw new Error('无法为移动识别目录设置 macOS 备份排除属性');
  }
}

function interruption(stage: string): RecognitionFailure {
  return { code: 'interrupted', message: '识别因本机服务重启而中断，已完成的内容仍然保留。', stage, retryable: true };
}

export class MobileRecognitionStore {
  private readonly jobs = new Map<string, StoredRecognitionJob>();
  private readonly idempotency = new Map<string, { sourceHash: string; jobId: string }>();
  private mutation: Promise<void> = Promise.resolve();

  private constructor(readonly dataDir: string) {}

  static async open(dataDir: string): Promise<MobileRecognitionStore> {
    const store = new MobileRecognitionStore(path.resolve(dataDir));
    await privateDirectory(store.dataDir);
    await excludeFromBackup(store.dataDir);
    await privateDirectory(store.jobsDir());
    await store.loadAndInterrupt();
    return store;
  }

  private jobsDir(): string { return path.join(this.dataDir, 'jobs'); }
  private jobDir(id: string): string { return path.join(this.jobsDir(), id); }
  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutation;
    let release!: () => void;
    this.mutation = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  private async loadAndInterrupt(): Promise<void> {
    const entries = await fs.promises.readdir(this.jobsDir(), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
      let job: StoredRecognitionJob; let changed = false;
      try {
        const raw = await fs.promises.readFile(path.join(this.jobDir(entry.name), 'job.json'), 'utf8');
        job = JSON.parse(raw) as StoredRecognitionJob;
        if (job.version !== 1 || job.id !== entry.name || !UUID.test(job.id) || !Array.isArray(job.questions)
          || typeof job.idempotencyKey !== 'string' || typeof job.sourceHash !== 'string') continue;
        job.inventoryCandidates ??= {};
        job.questionCheckpoints ??= {};
        const pendingQuestions = job.questions.filter(question => question.status === 'queued' || question.status === 'processing');
        if (pendingQuestions.length) {
          for (const question of pendingQuestions) { question.status = 'failed'; question.error = interruption('question'); question.revision += 1; }
          job.status = 'interrupted'; job.phase = 'questions'; job.error = interruption('questions'); changed = true;
        } else if (job.status === 'queued' || job.status === 'processing') {
          if (job.phase === 'questions') {
            const failed = job.questions.filter(question => question.status === 'failed');
            // unselected 不参与精读：收拢判定与 finalize 一致，不算可用题也不算失败。
            const usable = job.questions.filter(question => !['failed', 'queued', 'processing', 'unselected'].includes(question.status));
            job.phase = 'complete';
            if (!failed.length) { job.status = 'completed'; job.error = null; }
            else if (usable.length) { job.status = 'partial'; job.error = { code: 'partial', message: '识别暂未完成，已完成的题目已保留。', stage: 'questions', retryable: failed.some(question => question.error?.retryable) }; }
            else { job.status = 'failed'; job.error = failed[0]?.error ?? interruption('questions'); }
          } else { job.status = 'interrupted'; job.error = interruption(job.phase); }
          changed = true;
        }
        if (changed) {
          job.revision += 1; job.updatedAt = new Date().toISOString();
        }
      } catch { continue; /* A corrupt/incomplete record is not exposed as an accepted job. */ }
      this.jobs.set(job.id, job);
      this.idempotency.set(job.idempotencyKey, { sourceHash: job.sourceHash, jobId: job.id });
      // A readable job that cannot persist its recovery transition is a storage fault, not corrupt input.
      if (changed) await this.persist(job);
    }
  }

  private async persist(job: StoredRecognitionJob): Promise<void> {
    await durableWrite(path.join(this.jobDir(job.id), 'job.json'), JSON.stringify(job, null, 2));
  }

  async createJob(input: { idempotencyKey: string; photoName: string; sourceBytes: Buffer; normalizedBytes: Buffer }): Promise<{ job: RecognitionJob; created: boolean }> {
    return this.locked(async () => {
      const sourceHash = sha256(input.sourceBytes);
      const existing = this.idempotency.get(input.idempotencyKey);
      if (existing) {
        if (existing.sourceHash !== sourceHash) throw new IdempotencyConflictError('相同幂等键已用于不同照片');
        return { job: publicJob(this.jobs.get(existing.jobId)!), created: false };
      }
      const id = crypto.randomUUID(); const sourceMediaId = crypto.randomUUID(); const now = new Date().toISOString();
      const directory = this.jobDir(id); await privateDirectory(directory); await privateDirectory(path.join(directory, 'media')); await privateDirectory(path.join(directory, 'attempts'));
      await durableWrite(path.join(directory, 'source-original.jpg'), input.sourceBytes);
      const sourceFilename = `${sourceMediaId}.jpg`;
      await durableWrite(path.join(directory, 'media', sourceFilename), input.normalizedBytes);
      const stored: StoredRecognitionJob = { version: MOBILE_CONTRACT_VERSION, id, revision: 1, photoName: input.photoName, sourceHash, sourceMediaId,
        attemptBudgets: { inventory: { currentRoundId: id, rounds: [{ id, reservations: [], retryCount: 0, retryNotBefore: null }] } },
        status: 'queued', phase: 'inventory', inventoryWarnings: [], questions: [], error: null, createdAt: now, updatedAt: now,
        idempotencyKey: input.idempotencyKey, transformedHash: sha256(input.normalizedBytes), media: { [sourceMediaId]: { filename: sourceFilename, kind: 'source' } }, inventoryCandidates: {}, questionCheckpoints: {} };
      await this.persist(stored);
      this.jobs.set(id, stored); this.idempotency.set(input.idempotencyKey, { sourceHash, jobId: id });
      return { job: publicJob(stored), created: true };
    });
  }

  async getJob(id: string): Promise<RecognitionJob | null> { const job = this.jobs.get(id); return job ? publicJob(job) : null; }
  async getStoredJob(id: string): Promise<StoredRecognitionJob | null> { const job = this.jobs.get(id); return job ? structuredClone(job) : null; }
  /** Task 3：容量预约前的幂等键查验（只读内存索引，不触发 IO）。 */
  async hasJob(idempotencyKey: string): Promise<boolean> { return this.idempotency.has(idempotencyKey); }
  async listJobs(): Promise<RecognitionJob[]> {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicJob);
  }
  /** 自愈扫描用：返回含内部字段的完整任务快照（不做状态改写）。 */
  async listStoredJobs(): Promise<StoredRecognitionJob[]> {
    return [...this.jobs.values()].map(job => structuredClone(job));
  }

  async saveJob(job: RecognitionJob | StoredRecognitionJob): Promise<void> {
    await this.locked(async () => {
      const current = this.jobs.get(job.id); if (!current) throw new Error('识别任务不存在');
      const provided = structuredClone(job) as RecognitionJob & Partial<StoredRecognitionJob>;
      const stored: StoredRecognitionJob = { ...structuredClone(current), ...provided,
        idempotencyKey: current.idempotencyKey, transformedHash: current.transformedHash,
        media: provided.media ?? current.media, inventoryCandidates: provided.inventoryCandidates ?? current.inventoryCandidates,
        questionCheckpoints: provided.questionCheckpoints ?? current.questionCheckpoints };
      await this.persist(stored); this.jobs.set(stored.id, stored);
    });
  }

  async updateJob(id: string, update: (job: StoredRecognitionJob) => void): Promise<StoredRecognitionJob> {
    return this.locked(async () => {
      const current = this.jobs.get(id); if (!current) throw new Error('识别任务不存在');
      const next = structuredClone(current); update(next); await this.persist(next); this.jobs.set(id, next); return structuredClone(next);
    });
  }

  async writeMedia(jobId: string, bytes: Buffer, kind: 'question' | 'diagram'): Promise<string> {
    return this.locked(async () => {
      const job = this.jobs.get(jobId); if (!job) throw new Error('识别任务不存在');
      const mediaId = crypto.randomUUID(); const filename = `${mediaId}.jpg`;
      await durableWrite(path.join(this.jobDir(jobId), 'media', filename), bytes);
      job.media[mediaId] = { filename, kind }; job.updatedAt = new Date().toISOString();
      await this.persist(job); return mediaId;
    });
  }

  async readMedia(jobId: string, mediaId: string): Promise<Buffer> {
    if (!UUID.test(jobId) || !UUID.test(mediaId)) throw new UnknownMediaError('媒体不存在');
    const job = this.jobs.get(jobId); const media = job?.media[mediaId];
    if (!job || !media) throw new UnknownMediaError('媒体不存在');
    return fs.promises.readFile(path.join(this.jobDir(jobId), 'media', media.filename));
  }

  async readSource(jobId: string): Promise<Buffer> {
    const job = this.jobs.get(jobId); if (!job) throw new Error('识别任务不存在');
    const source = job.media[job.sourceMediaId]; if (!source || source.kind !== 'source') throw new Error('转正后的来源照片不存在');
    return fs.promises.readFile(path.join(this.jobDir(jobId), 'media', source.filename));
  }

  async writeAttempt(jobId: string, questionId: string | null, record: unknown): Promise<void> {
    if (!this.jobs.has(jobId)) throw new Error('识别任务不存在');
    const filename = `${Date.now()}-${questionId ?? 'inventory'}-${crypto.randomUUID()}.json`;
    const payload = { version: 1, recordedAt: new Date().toISOString(), questionId, ...record as object } as Record<string, unknown>;
    let serialized = JSON.stringify(payload, null, 2);
    if (Buffer.byteLength(serialized) > MAX_ATTEMPT_FILE_BYTES && typeof payload.responseRaw === 'string') {
      const original = payload.responseRaw;
      payload.responseTruncatedForStorage = true; payload.responseOriginalBytes = Buffer.byteLength(original); payload.responseRaw = '';
      if (Buffer.byteLength(JSON.stringify(payload, null, 2)) > MAX_ATTEMPT_FILE_BYTES) throw new Error('模型调用元数据超出本地保存上限');
      let low = 0; let high = original.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2); payload.responseRaw = original.slice(0, middle);
        if (Buffer.byteLength(JSON.stringify(payload, null, 2)) <= MAX_ATTEMPT_FILE_BYTES) low = middle; else high = middle - 1;
      }
      payload.responseRaw = original.slice(0, low); serialized = JSON.stringify(payload, null, 2);
    }
    if (Buffer.byteLength(serialized) > MAX_ATTEMPT_FILE_BYTES) throw new Error('模型调用记录超出本地保存上限');
    await durableWrite(path.join(this.jobDir(jobId), 'attempts', filename), serialized);
  }
}
