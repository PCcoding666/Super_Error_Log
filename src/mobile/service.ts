import crypto from 'node:crypto';
import sharp from 'sharp';
import { cropPhoto, normalizePhoto } from '../media/images.js';
import { canRecover, publicJob, type RecognitionAttemptRound, type RecognitionFailure, type RecognitionJob, type RecognitionQuestion, type StoredRecognitionJob } from './contracts.js';
import type { Box } from '../media/images.js';
import { IdempotencyConflictError, MobileRecognitionStore, UnknownMediaError } from './store.js';
import { MobileVisionError, type InventoryCandidate, type MobileVisionBoundary } from './vision.js';
import { expandCropMargin } from './modelBox.js';
import type { AdmissionController } from './admission.js';
import { rssAdmissionThresholdBytes, studentAiConcurrency } from '../studentHost/limits.js';

export class MobileRequestError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); this.name = 'MobileRequestError'; }
}
class MobileStorageError extends Error {
  constructor(cause: unknown) { super('mobile recognition storage unavailable', { cause }); this.name = 'MobileStorageError'; }
}
class WorkerStopped extends Error {}
type Work = { jobId: string; kind: 'inventory' | 'question'; questionId?: string };
type ExternalWork = { kind: 'external'; key: string; run: (signal: AbortSignal) => Promise<void> };

type QueueTask = Work | ExternalWork;

function workKey(task: Work): string {
  return `${task.jobId}:${task.kind}:${task.questionId ?? ''}`;
}

function taskKey(task: QueueTask): string {
  return task.kind === 'external' ? `external:${task.key}` : workKey(task);
}

function failure(error: unknown, fallbackStage: string): RecognitionFailure {
  if (error instanceof MobileVisionError) return { code: error.code, message: error.message, stage: error.stage, retryable: error.retryable };
  const candidate = error as Partial<RecognitionFailure> & { message?: unknown };
  if (typeof candidate.code === 'string' && typeof candidate.stage === 'string' && typeof candidate.retryable === 'boolean') {
    return { code: candidate.code, message: typeof candidate.message === 'string' ? candidate.message : '识别暂未完成，已完成的题目已保留。', stage: candidate.stage, retryable: candidate.retryable };
  }
  return { code: 'internal', message: '识别暂未完成，已完成的题目已保留。', stage: fallbackStage, retryable: false };
}

function now(): string { return new Date().toISOString(); }
function intersection(a: Box, b: Box): number {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
}
function disjointSameNumber(job: StoredRecognitionJob, a: RecognitionQuestion, b: RecognitionQuestion): boolean {
  const first = job.inventoryCandidates[a.id], second = job.inventoryCandidates[b.id];
  return Boolean(a.id !== b.id && first && second && first.number === second.number && intersection(first.box, second.box) === 0);
}
function occurrenceConflict(job: StoredRecognitionJob, question: RecognitionQuestion): boolean {
  const a = question.evidence?.questionRegion;
  return Boolean(a && job.questions.some(other => {
    const b = other.evidence?.questionRegion;
    if (!b || !disjointSameNumber(job, question, other)) return false;
    const shared = intersection(a, b);
    return shared / (a.width * a.height + b.width * b.height - shared) >= .8;
  }));
}
function unresolvedOccurrence(job: StoredRecognitionJob, question: RecognitionQuestion): boolean {
  return job.questions.some(other => disjointSameNumber(job, question, other) && ['queued', 'processing', 'failed'].includes(other.status));
}
function applyOccurrenceConflicts(job: StoredRecognitionJob): void {
  for (const question of job.questions) {
    if (!['ready', 'needs_check'].includes(question.status) || !occurrenceConflict(job, question)) continue;
    const issue = '同题号的不同候选定位到同一来源区域，无法确认是哪一处；请对照原图，保留待核对。';
    if (question.verification && !question.verification.issues.includes(issue)) question.verification.issues.push(issue);
    question.status = 'needs_check'; question.revision += 1;
  }
}
function allChecksPass(question: RecognitionQuestion, candidate?: InventoryCandidate): boolean {
  const check = question.verification;
  return Boolean(candidate && check && check.textComplete && check.questionCropComplete && check.questionCropPure && check.transcriptionMatches && check.diagramSafe
    && check.issues.length === 0 && question.evidence && question.evidence.uncertainties.length === 0 && !candidate.partial
    && (!question.evidence.requiresDiagram || (question.diagramMediaIds.length > 0
      && question.diagramMediaIds.length === question.evidence.regions.filter(region => region.kind === 'diagram').length)));
}

export class MobileRecognitionService {
  /** 单进程 RSS 准入（应用层，不是 cgroup）。构造时读环境变量，学生 worker 与主进程用不同份额。 */
  private readonly rssAdmissionBytes = rssAdmissionThresholdBytes();
  private readonly queue: Array<Work | ExternalWork> = [];
  private readonly externalLifecycles = new Set<{ resume: () => Promise<void>; stop: () => Promise<void> }>();
  private readonly queued = new Set<string>();
  private running = false;
  private accepting = true;
  private storageAvailable = true;
  private admission: AdmissionController | null = null;
  /** 当前占用任务容量的 jobId 集合：非终态任务恰好占 1（重试不重复计照片数）。 */
  private readonly activeCapacityJobs = new Set<string>();
  /** 可重试失败的自动退避间隔（题级至多用完整个数组；清单级只用第 1 个）。置空数组 = 关闭自动重试。 */
  autoRetryDelaysMs: number[] = [2_000, 8_000];
  /** 看门狗周期：扫描持久化为非终态、但既不在内存队列也不在执行中的僵尸工作单元。 */
  watchdogIntervalMs = 60_000;
  private readonly shutdown = new AbortController();
  /** 本学生同时进行的照片或材料任务数（SEL_STUDENT_AI_CONCURRENCY，缺省 3）。同一张照片仍只占一条通道。 */
  private readonly studentAiConcurrency: number;
  /** 正在跑的识别通道。与 studentAiConcurrency 比较，不再用单飞的 running 把整队串成一张照片。 */
  private lanes = 0;
  private readonly lanePromises = new Set<Promise<void>>();
  private scanning: Promise<void> | null = null;
  private readonly ownedPersistence = new Set<Promise<unknown>>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inflight = new Set<string>();
  /** 退避计时器已挂起、尚未重新入队的工作单元键（看门狗不得把这类待重试单元当僵尸）。 */
  private readonly retryScheduled = new Set<string>();
  private watchdog: ReturnType<typeof setInterval> | null = null;

  constructor(readonly store: MobileRecognitionStore, readonly vision: MobileVisionBoundary, options?: { studentAiConcurrency?: number }) {
    const value = options?.studentAiConcurrency ?? studentAiConcurrency();
    if (!Number.isSafeInteger(value) || value < 1 || value > 32) throw new Error('SEL_STUDENT_AI_CONCURRENCY 必须是 1 到 32 的整数');
    this.studentAiConcurrency = value;
  }

  /** 云端模式：接入入口容量控制（上传图像信号量 + 任务容量释放）。 */
  useAdmission(admission: AdmissionController): void { this.admission = admission; }

  /** Durable subsystems share this worker and its shutdown/watchdog, without legacy job records. */
  registerExternalLifecycle(lifecycle: { resume: () => Promise<void>; stop: () => Promise<void> }): void {
    this.externalLifecycles.add(lifecycle);
  }

  enqueueExternalWork(key: string, run: (signal: AbortSignal) => Promise<void>): 'queued' | 'already_queued' | 'stopped' {
    if (!this.accepting) return 'stopped';
    const identity = `external:${key}`;
    if (this.queued.has(identity) || this.inflight.has(identity)) return 'already_queued';
    this.queued.add(identity); this.queue.push({ kind: 'external', key, run });
    // Callers may still be committing their synchronous transaction.
    queueMicrotask(() => this.kick());
    return 'queued';
  }

  async initialize(): Promise<void> {
    // Rebuild all ownership before returning the app to callers/listeners.
    for (const job of await this.store.listStoredJobs()) {
      if (!['completed', 'partial', 'failed'].includes(job.status)) this.noteRestoredOccupancy(job.id);
    }
    this.startWatchdog();
  }

  acceptingJobs(): boolean {
    if (!this.accepting) return false;
    // 单进程 RSS 观测：超过本进程份额时停止接收新任务（可恢复：内存回落后恢复）。不是内核节流。
    const rss = process.memoryUsage.rss();
    if (rss > this.rssAdmissionBytes) {
      const limit = Math.round(this.rssAdmissionBytes / 1024 / 1024);
      console.warn(`[admission] 单进程 RSS ${Math.round(rss / 1024 / 1024)}MiB 超过 ${limit}MiB 准入阈值，暂停接收新任务。`);
      return false;
    }
    return true;
  }

  /** 队列、正在跑的识别、自动重试倒计时或恢复扫描都算忙。空闲退出前由 worker 问这一下。 */
  hasPendingRecognition(): boolean {
    return this.running || this.queue.length > 0 || this.inflight.size > 0 || this.retryScheduled.size > 0 || this.scanning !== null;
  }

  async hasJob(idempotencyKey: string): Promise<boolean> { return this.store.hasJob(idempotencyKey); }

  async submit(input: { idempotencyKey: string; photoName: string; sourceBytes: Buffer }): Promise<{ job: RecognitionJob; created: boolean }> {
    this.assertStorageAvailable();
    // 非接收状态（停服/存储故障恢复中）明确拒绝，不产出 queued 僵尸任务。
    if (!this.accepting) throw new MobileRequestError(503, 'service_paused', '识别服务暂时不可用（正在恢复），请稍后再试。照片仍保存在本机。');
    let normalized: Buffer | undefined;
    try {
      // 共享图像信号量：metadata 检查与归一化在互斥内执行（sharp.concurrency(1) 不保证跨请求串行）。
      const decode = async (): Promise<void> => {
        const metadata = await sharp(input.sourceBytes, { failOn: 'error', limitInputPixels: 40_000_000 }).metadata();
        if (metadata.format !== 'jpeg') throw new Error('not jpeg');
        normalized = await normalizePhoto(input.sourceBytes);
      };
      if (this.admission) await this.admission.withImage(decode);
      else await decode();
    }
    catch { throw new MobileRequestError(400, 'invalid_image', '照片无法读取、已损坏或超过大小限制。'); }
    if (!normalized) throw new MobileRequestError(400, 'invalid_image', '照片无法读取、已损坏或超过大小限制。');
    this.assertStorageAvailable();
    if (!this.accepting) throw new MobileRequestError(503, 'service_paused', '识别服务暂时不可用（正在恢复），请稍后再试。照片仍保存在本机。');
    let result;
    try { result = await this.store.createJob({ idempotencyKey: input.idempotencyKey, photoName: input.photoName, sourceBytes: input.sourceBytes, normalizedBytes: normalized }); }
    catch (error) {
      if (error instanceof MobileRequestError || error instanceof IdempotencyConflictError) throw error;
      this.failStorage(); throw new MobileRequestError(503, 'storage_unavailable', '本地存储暂时不可用，未接受新的识别任务。');
    }
    if (result.created) { this.activeCapacityJobs.add(result.job.id); this.enqueue({ jobId: result.job.id, kind: 'inventory' }); }
    return { job: result.job, created: result.created };
  }

  async getJob(id: string): Promise<RecognitionJob> {
    const job = await this.store.getJob(id); if (!job) throw new MobileRequestError(404, 'not_found', '识别任务不存在。'); return job;
  }
  async listJobs(): Promise<RecognitionJob[]> { return this.store.listJobs(); }
  async getMedia(jobId: string, mediaId: string): Promise<Buffer> {
    try { return await this.store.readMedia(jobId, mediaId); }
    catch (error) {
      if (error instanceof UnknownMediaError) throw new MobileRequestError(404, 'not_found', '媒体不存在。');
      this.failStorage(); throw this.storageUnavailable();
    }
  }

  async retry(jobId: string, questionId: string | null): Promise<RecognitionJob> {
    this.assertStorageAvailable();
    let job = await this.requireStored(jobId);
    if (questionId === null) {
      if (job.phase !== 'inventory' || !['failed', 'interrupted'].includes(job.status) || !canRecover(job.error)) throw new MobileRequestError(409, 'not_retryable', '清单阶段当前不能恢复。');
      // 容量预约先于状态改写：预约失败时任务保持 failed/interrupted，不会卡在 queued。
      const reserved = this.reserveRetryCapacity(jobId);
      try {
        job = await this.persistTransition(() => this.store.updateJob(jobId, current => {
          if (current.phase !== 'inventory' || !['failed', 'interrupted'].includes(current.status)) throw new MobileRequestError(409, 'not_retryable', '清单阶段当前不能恢复。');
          this.newRound(current, 'inventory'); current.status = 'queued'; current.error = null; this.touch(current) }));
      } catch (error) {
        // 迁移失败只回滚本次新预约的名额（若任务本已占位，名额仍归属在途工作单元）。
        if (reserved) this.releaseCapacityOnce(jobId);
        throw error;
      }
      this.enqueue({ jobId, kind: 'inventory' });
      return publicJob(job);
    }
    const question = job.questions.find(item => item.id === questionId);
    if (!question) throw new MobileRequestError(404, 'not_found', '题目不存在。');
    if (question.status !== 'failed' || !canRecover(question.error)) throw new MobileRequestError(409, 'not_retryable', '这道题当前不能恢复。');
    const reserved = this.reserveRetryCapacity(jobId);
    try {
      job = await this.persistTransition(() => this.store.updateJob(jobId, current => { const target = current.questions.find(item => item.id === questionId)!;
        if (target.status !== 'failed') throw new MobileRequestError(409, 'not_retryable', '这道题当前不能恢复。');
        this.newRound(current, questionId);
        target.status = 'queued'; target.error = null; target.revision += 1; current.status = 'processing'; current.phase = 'questions'; current.error = null; this.touch(current); }));
    } catch (error) {
      if (reserved) this.releaseCapacityOnce(jobId);
      throw error;
    }
    this.enqueue({ jobId, kind: 'question', questionId });
    return publicJob(job);
  }

  /**
   * v2.1a 学生勾选：把 unselected 的题转为 queued 精读（标 selectedByStudent、开新一轮预算）。
   * 其他状态的 id 忽略（幂等，重复提交不重复精读）；一道都没转换则原样返回、不改任务状态。
   * 还在找题（phase inventory，含排队/进行中/找题失败/中断）一律 409。
   */
  async select(jobId: string, questionIds: string[]): Promise<RecognitionJob> {
    this.assertStorageAvailable();
    let job = await this.requireStored(jobId);
    if (job.phase === 'inventory') throw new MobileRequestError(409, 'not_selectable', '这张照片还在找题，稍后再选。');
    const known = new Set(job.questions.map(item => item.id));
    // 任一 id 不属于该任务：整条请求不生效。
    for (const questionId of questionIds) {
      if (!known.has(questionId)) throw new MobileRequestError(404, 'not_found', '题目不存在。');
    }
    if (!job.questions.some(item => item.status === 'unselected' && questionIds.includes(item.id))) return publicJob(job);
    // 容量预约沿用 retry 的做法：满则 429，失败回滚只撤销自己新占的名额。
    const reserved = this.reserveRetryCapacity(jobId);
    let transitioned: string[] = [];
    try {
      job = await this.persistTransition(() => this.store.updateJob(jobId, current => {
        transitioned = [];
        for (const questionId of questionIds) {
          const target = current.questions.find(item => item.id === questionId)!;
          if (target.status !== 'unselected') continue;
          this.newRound(current, questionId);
          target.status = 'queued'; target.selectedByStudent = true; target.error = null; target.revision += 1;
          transitioned.push(questionId);
        }
        // 至少一道发生转换：任务（可从终态）回到处理中。
        if (transitioned.length > 0) { current.status = 'processing'; current.phase = 'questions'; current.error = null; this.touch(current); }
      }));
    } catch (error) {
      if (reserved) this.releaseCapacityOnce(jobId);
      throw error;
    }
    for (const questionId of transitioned) this.enqueue({ jobId, kind: 'question', questionId });
    return publicJob(job);
  }

  /** 候选题缩略图：按清单候选框从任务原图现算裁出（余量与精读裁图一致），不落盘；任何题目状态都可取。 */
  async getCandidateCrop(jobId: string, questionId: string): Promise<Buffer> {
    this.assertStorageAvailable();
    const job = await this.store.getStoredJob(jobId);
    if (!job) throw new MobileRequestError(404, 'not_found', '识别任务不存在。');
    const candidate = job.inventoryCandidates[questionId];
    if (!job.questions.some(item => item.id === questionId) || !candidate) throw new MobileRequestError(404, 'not_found', '题目不存在。');
    let source: Buffer;
    try { source = await this.store.readSource(jobId); }
    catch { throw new MobileRequestError(404, 'not_found', '题目不存在。'); }
    try { return await cropPhoto(source, expandCropMargin(candidate.box)); }
    catch { throw new MobileRequestError(404, 'not_found', '题目不存在。'); }
  }

  /** 重试重新占用一个任务容量位：非终态任务恰好占用 1（按 jobId 去重，不重复计照片数）；满则保守拒绝。
   *  返回是否为本次调用新预约——失败回滚只撤销自己新占的名额，不动他人既有占位。 */
  private reserveRetryCapacity(jobId: string): boolean {
    if (!this.admission) return false;
    if (this.activeCapacityJobs.has(jobId)) return false;
    const capacity = this.admission.tryAcquireJobCapacity();
    if (!capacity.accepted) throw new MobileRequestError(429, 'capacity_full', '识别队列已满，请稍后再试。');
    this.activeCapacityJobs.add(jobId);
    return true;
  }

  /**
   * 恢复扫描的容量登记：恢复的既有任务必须真实占用容量位（无条件登记，不试满即拒——
   * 历史超额任务允许继续处理，仅拦新增）。已占位的任务重复扫描不重复登记。
   */
  private noteRestoredOccupancy(jobId: string): void {
    if (!this.admission) return;
    if (!this.activeCapacityJobs.has(jobId)) {
      this.admission.noteExistingOccupancy();
      this.activeCapacityJobs.add(jobId);
    }
  }

  /** 容量恰好释放一次：只有确实占位的任务才归还名额（重复 finalize/收拢不再误伤在途任务）。 */
  private releaseCapacityOnce(jobId: string): void {
    if (!this.admission) return;
    if (this.activeCapacityJobs.delete(jobId)) this.admission.releaseJobCapacity();
  }

  async confirm(jobId: string, questionId: string, input: { revision: number; action: 'confirm' | 'skip'; sourceCompared?: boolean; manualRelease?: boolean }): Promise<RecognitionJob> {
    this.assertStorageAvailable();
    await this.requireStored(jobId);
    const job = await this.persistTransition(() => this.store.updateJob(jobId, current => {
      const question = current.questions.find(item => item.id === questionId);
      if (!question) throw new MobileRequestError(404, 'not_found', '题目不存在。');
      if (question.revision !== input.revision) throw new MobileRequestError(409, 'stale_revision', '题目已更新，请重新查看后再确认。');
      if (input.action === 'confirm') {
        const candidate = current.inventoryCandidates[questionId];
        if (input.sourceCompared !== true) throw new MobileRequestError(409, 'confirmation_required', '请先对照原图并解决所有不确定项。');
        if (input.manualRelease === true) {
          // 人工放行（needs_check）：学生对照原图后主动拍板。不要求 AI 五项全过，
          // 但保留原 issues 并追加审计标记；同题号冲突与未决冲突仍不放行。
          if (question.status !== 'needs_check') throw new MobileRequestError(409, 'confirmation_required', '该题无需人工放行，请按常规流程确认。');
          if (unresolvedOccurrence(current, question) || occurrenceConflict(current, question)) throw new MobileRequestError(409, 'confirmation_required', '同题号定位存在冲突，请先对照原图解决。');
          if (question.verification && !question.verification.issues.includes('人工放行：学生已对照原图确认本题（AI 未通过完整性核对）。')) question.verification.issues.push('人工放行：学生已对照原图确认本题（AI 未通过完整性核对）。');
          question.status = 'confirmed'; question.confirmedAt = now(); question.manualRelease = true;
        } else {
          if (!allChecksPass(question, candidate) || question.status !== 'ready'
            || unresolvedOccurrence(current, question) || occurrenceConflict(current, question)) throw new MobileRequestError(409, 'confirmation_required', '请先对照原图并解决所有不确定项。');
          question.status = 'confirmed'; question.confirmedAt = now();
        }
      } else if (input.action === 'skip') {
        if (question.status === 'queued' || question.status === 'processing') throw new MobileRequestError(409, 'question_active', '题目仍在识别中，请等待本轮完成后再操作。');
        if (question.status === 'confirmed') throw new MobileRequestError(409, 'already_confirmed', '已确认题目不能直接跳过。');
        question.status = 'skipped'; question.confirmedAt = null;
      } else throw new MobileRequestError(400, 'invalid_request', '确认操作不合法。');
      question.revision += 1; this.touch(current);
    }));
    return publicJob(job);
  }

  async stop(): Promise<void> {
    this.accepting = false;
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear(); this.retryScheduled.clear();
    this.shutdown.abort(new WorkerStopped('recognition worker stopped'));
    // Abort material handlers while lanes are still joined. A lifecycle stop waits for
    // those handlers, which themselves run on a lane.
    const lifecycleStops = [...this.externalLifecycles].map(lifecycle => lifecycle.stop());
    while (this.lanePromises.size > 0 || this.scanning) {
      await Promise.allSettled([...this.lanePromises, ...(this.scanning ? [this.scanning] : [])]);
    }
    const settled = await Promise.allSettled(lifecycleStops);
    // A generic boundary may settle via cancellation before its started storage
    // callback returns. No new callbacks can enter ownedStorage after stop.
    await Promise.allSettled([...this.ownedPersistence]);
    const errors = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'External recognition shutdown failed.');
  }
  isStorageAvailable(): boolean { return this.storageAvailable; }

  /** 启动看门狗：立即做一次恢复扫描，随后按周期扫描。 */
  startWatchdog(): void {
    if (this.watchdog || !this.accepting) return;
    this.watchdog = setInterval(() => { void this.resumeIncompleteJobs().catch(() => undefined); }, this.watchdogIntervalMs);
    this.watchdog.unref();
    void this.resumeIncompleteJobs().catch(error => console.warn('[queue] 启动恢复扫描失败：', error));
  }

  /**
   * 自愈扫描：把「持久化为非终态、但既不在内存队列也不在执行中」的工作单元重新入队。
   * 覆盖两类真实事故：进程内队列卡死/崩溃后的 queued 僵尸（2026-09-20 真机验收实测），
   * 与重启时被标记为 interrupted 的中断工作。幂等，可被看门狗反复调用。
   * 边界：仅自动恢复中断（interrupted）产生的失败；真实模型失败仍走人工/显式重试。
   */
  resumeIncompleteJobs(): Promise<void> {
    if (!this.accepting) return Promise.resolve();
    if (this.scanning) return this.scanning;
    this.scanning = this.scanIncompleteJobs().finally(() => { this.scanning = null; });
    return this.scanning;
  }

  private async scanIncompleteJobs(): Promise<void> {
    if (!this.accepting) return;
    // 队列有积压但没人 drain（异常路径下 running 卡 false 的防御）：补一脚驱动。
    if (this.queue.length > 0 && !this.running) this.kick();
    for (const lifecycle of this.externalLifecycles) await lifecycle.resume();
    let resumed = 0;
    for (const job of await this.store.listStoredJobs()) {
      if (!this.accepting) return;
      if (['completed', 'partial', 'failed'].includes(job.status)) continue;
      // 任务级活动守卫：inventory 工作单元在队/在执行时，其逐题阶段由 processInventory 内部
      // 串行驱动（不占逐题队列键），看门狗不得把这种正常长任务视作僵尸重复入队。
      if (this.queued.has(`${job.id}:inventory:`) || this.inflight.has(`${job.id}:inventory:`)) continue;
      if (job.phase === 'inventory') {
        const key = `${job.id}:inventory:`;
        if (this.queued.has(key) || this.inflight.has(key) || this.retryScheduled.has(key)) continue;
        if (!['queued', 'processing', 'interrupted'].includes(job.status)) continue;
        if (job.status === 'interrupted' && job.error && !job.error.retryable) continue;
        if (this.restoreDelay(job, null)) continue;
        if (job.status !== 'queued') {
          await this.ownedStorage(() => this.store.updateJob(job.id, current => { current.status = 'queued'; this.touch(current); }));
        }
        this.noteRestoredOccupancy(job.id);
        this.enqueue({ jobId: job.id, kind: 'inventory' });
        resumed += 1;
        continue;
      }
      if (job.phase !== 'questions') continue;
      let resumedAny = false;
      for (const question of job.questions) {
        const key = `${job.id}:question:${question.id}`;
        if (this.queued.has(key) || this.inflight.has(key) || this.retryScheduled.has(key)) continue;
        const wedged = question.status === 'queued' || question.status === 'processing';
        const interrupted = question.status === 'failed' && question.error?.code === 'interrupted';
        if (!wedged && !interrupted) continue;
        if (this.restoreDelay(job, question.id)) { resumedAny = true; continue; }
        await this.ownedStorage(() => this.store.updateJob(job.id, current => {
          const target = current.questions.find(item => item.id === question.id);
          if (target) { target.status = 'queued'; target.error = null; target.revision += 1; this.touch(current); }
        }));
        this.noteRestoredOccupancy(job.id);
        this.enqueue({ jobId: job.id, kind: 'question', questionId: question.id });
        resumed += 1; resumedAny = true;
      }
      // 恢复进行中：任务级状态回到 processing（客户端显示「正在识别」，不再停留「已中断」）。
      if (resumedAny) {
        await this.ownedStorage(() => this.store.updateJob(job.id, current => {
          if (current.status !== 'processing') { current.status = 'processing'; this.touch(current); }
        }));
      }
      // 没有可恢复题目但任务卡在中断/进行中（全部题目已有结论）：用 finalize 收拢到终态。
      if (!resumedAny) await this.finalize(job.id);
    }
    if (resumed > 0) console.info(`[queue] 自愈扫描：恢复 ${resumed} 个中断/卡死的工作单元。`);
  }

  private enqueue(task: Work, scheduled = false): void {
    if (!this.accepting) {
      console.warn(`[queue] 服务未在接收状态，任务未能入队：${task.jobId} ${task.kind} ${task.questionId ?? ''}（由看门狗在恢复后重新拾取）`);
      return;
    }
    const key = workKey(task); if (this.queued.has(key) || (!scheduled && this.inflight.has(key))) return;
    this.queued.add(key); this.queue.push(task); this.kick();
  }

  /** 同一张照片已经有清单或逐题在跑时，不再开第二条通道，避免题序和结果写串。 */
  private jobBusy(jobId: string): boolean {
    for (const key of this.inflight) if (key.startsWith(`${jobId}:`)) return true;
    return false;
  }

  /** 照片要等自己的清单或逐题结束；同一 external 键已在跑时不再占第二条通道。 */
  private runnable(task: QueueTask): boolean {
    if (task.kind === 'external') return !this.inflight.has(taskKey(task));
    return !this.jobBusy(task.jobId);
  }

  private hasRunnable(): boolean {
    return this.queue.some(task => this.runnable(task));
  }

  /** 取队列里第一项当前可以开跑的任务，并在让出事件循环前占上 in-flight。 */
  private takeRunnable(): QueueTask | undefined {
    const index = this.queue.findIndex(task => this.runnable(task));
    if (index < 0) return undefined;
    const task = this.queue.splice(index, 1)[0]!;
    const key = taskKey(task);
    this.queued.delete(key);
    this.inflight.add(key);
    return task;
  }

  private kick(): void {
    if (!this.accepting) return;
    while (this.lanes < this.studentAiConcurrency && this.hasRunnable()) this.startLane();
  }

  private startLane(): void {
    this.lanes += 1;
    this.running = true;
    const lane = this.runLane();
    this.lanePromises.add(lane);
    void lane.finally(() => {
      this.lanePromises.delete(lane);
      this.lanes -= 1;
      if (this.accepting) this.kick();
      if (this.lanes === 0) this.running = false;
    });
  }

  private async runLane(): Promise<void> {
    while (this.accepting) {
      const task = this.takeRunnable();
      if (!task) return;
      const inflightKey = taskKey(task);
      try {
        if (task.kind === 'external') await task.run(this.shutdown.signal);
        else if (task.kind === 'inventory') await this.processInventory(task.jobId);
        else await this.processQuestionRetry(task.jobId, task.questionId!);
      } catch (error) { if (task.kind !== 'external' && !(error instanceof WorkerStopped)) this.failStorage(); }
      finally { this.inflight.delete(inflightKey); }
    }
  }

  private async processInventory(jobId: string): Promise<void> {
    let job = await this.requireStored(jobId); if (job.phase !== 'inventory' || !['queued', 'interrupted'].includes(job.status)) return;
    job = await this.ownedStorage(() => this.store.updateJob(jobId, current => { current.status = 'processing'; current.error = null; this.touch(current); }));
    try {
      const source = await this.ownedStorage(() => this.store.readSource(job.id));
      this.round(job, 'inventory');
      const result = await this.invoke(() => this.vision.inventory(source, this.context(job, null)));
      job = await this.ownedStorage(() => this.store.updateJob(jobId, current => {
        current.inventoryWarnings = result.warnings;
        current.questions = result.candidates.map(candidate => {
        const id = crypto.randomUUID(); current.inventoryCandidates[id] = structuredClone(candidate);
        // v2.1a 分流：有批改痕迹（marked_wrong/corrected）的题照旧排队精读；
        // 只有勾/无痕迹/看不清的题标 unselected——不建精读工作单元、不占预算、不发模型请求，等学生勾选。
        const automatic = candidate.selectionEvidence === 'marked_wrong' || candidate.selectionEvidence === 'corrected';
        if (automatic) this.newRound(current, id);
        return { id, number: candidate.number, revision: 1, status: automatic ? 'queued' as const : 'unselected' as const, selectionEvidence: candidate.selectionEvidence,
          evidence: null, verification: null, questionMediaId: null, diagramMediaIds: [], error: null, confirmedAt: null };
      });
        current.phase = 'questions'; current.status = 'processing'; this.touch(current);
      }));
    } catch (error) {
      if (error instanceof MobileStorageError || error instanceof WorkerStopped) throw error;
      const f = failure(error, 'inventory');
      if (f.retryable && await this.scheduleRetry(jobId, null, f, 1)) {
        // 清单级瞬时失败自动重试一次：任务保持 queued，客户端只见「等待识别」。
        return;
      }
      await this.ownedStorage(() => this.store.updateJob(jobId, current => { current.status = 'failed'; current.phase = 'inventory'; current.error = f; this.touch(current); }));
      // 清单失败即任务终态：释放入口容量，避免容量泄漏（恰好一次：未占位的任务不误释放他人名额）。
      this.releaseCapacityOnce(jobId);
      return;
    }
    // 只精读参与队列的题（自动题 + 学生已勾选的题）；unselected 永不入队。
    const queued = job.questions.filter(question => question.status === 'queued').map(question => question.id);
    if (queued.length === 0) {
      // 一道自动题都没有：找题完成即终态 completed，释放入口容量（与其他终态一致，恰好一次）。
      await this.finalize(job.id);
      return;
    }
    await this.processQuestions(job.id, queued);
  }

  private async processQuestions(jobId: string, questionIds: string[]): Promise<void> {
    let cursor = 0;
    // 同一张照片里的题保持逐题（题序、同题号冲突、每阶段 3 次预算）。照片之间的并行在上面的通道里。
    const worker = async () => { while (cursor < questionIds.length) { this.assertRunning(); const id = questionIds[cursor++]; if (id) await this.runQuestion(jobId, id); } };
    await Promise.all(Array.from({ length: Math.min(1, questionIds.length) }, worker));
    await this.finalize(jobId);
  }

  private async processQuestionRetry(jobId: string, questionId: string): Promise<void> { await this.runQuestion(jobId, questionId); await this.finalize(jobId); }

  private async runQuestion(jobId: string, questionId: string): Promise<void> {
    let job = await this.requireStored(jobId); let question = job.questions.find(item => item.id === questionId);
    if (!question || !(question.status === 'queued' || (question.status === 'failed' && question.error?.code === 'interrupted'))) return;
    job = await this.ownedStorage(() => this.store.updateJob(jobId, current => { const target = current.questions.find(item => item.id === questionId)!;
      target.status = 'processing'; target.error = null; target.revision += 1; this.touch(current); }));
    question = job.questions.find(item => item.id === questionId)!;
    try {
      const source = await this.ownedStorage(() => this.store.readSource(job.id)); const candidate = job.inventoryCandidates[questionId] as InventoryCandidate | undefined;
      if (!candidate) throw new MobileVisionError('invalid_output', '题目候选定位记录缺失。', 'question', false);
      this.round(job, questionId);
      const result = await this.invoke(() => this.vision.recognizeQuestion(source, candidate, this.context(job, questionId)));
      const questionMediaId = await this.ownedStorage(() => this.store.writeMedia(job.id, result.questionCrop, 'question'));
      const diagramMediaIds: string[] = [];
      for (const bytes of result.diagramCrops) diagramMediaIds.push(await this.ownedStorage(() => this.store.writeMedia(job.id, bytes, 'diagram')));
      await this.ownedStorage(() => this.store.updateJob(jobId, current => { const target = current.questions.find(item => item.id === questionId)!;
        target.evidence = result.evidence; target.verification = result.verification; target.questionMediaId = questionMediaId; target.diagramMediaIds = diagramMediaIds;
        const partial = candidate.partial;
        if (partial && candidate.warning && !target.verification.issues.includes(candidate.warning)) target.verification.issues.push(candidate.warning);
        target.status = allChecksPass(target, candidate) && !unresolvedOccurrence(current, target) ? 'ready' : 'needs_check'; target.error = null; target.revision += 1;
        applyOccurrenceConflicts(current); this.touch(current); }));
    } catch (error) {
      if (error instanceof MobileStorageError || error instanceof WorkerStopped) throw error;
      const f = failure(error, 'question');
      if (f.retryable && await this.scheduleRetry(jobId, questionId, f, this.autoRetryDelaysMs.length)) {
        // 题级瞬时失败自动退避重试：题目回到 queued，客户端只见「等待识别」，无需人工点重试。
        return;
      }
      await this.ownedStorage(() => this.store.updateJob(jobId, current => { const target = current.questions.find(item => item.id === questionId);
        if (!target) return; target.status = 'failed'; target.error = f; target.revision += 1; this.touch(current); }));
    }
  }

  private async finalize(jobId: string): Promise<void> {
    let terminal = false;
    await this.ownedStorage(() => this.store.updateJob(jobId, job => { const failed = job.questions.filter(question => question.status === 'failed');
      // Reopened pending questions are temporarily marked failed/interrupted. Their
      // persisted backoff or queued owner still owns capacity until actual settlement.
      if ([...this.retryScheduled].some(key => key.startsWith(`${jobId}:`)) || this.queue.some(task => task.kind !== 'external' && task.jobId === jobId)) return;
      if (job.questions.some(question => question.status === 'queued' || question.status === 'processing')) return;
      for (const question of job.questions) {
        if (question.status === 'needs_check' && !unresolvedOccurrence(job, question) && !occurrenceConflict(job, question)
          && allChecksPass(question, job.inventoryCandidates[question.id])) { question.status = 'ready'; question.revision += 1; }
      }
      // unselected 不参与精读：不算进行中、不算失败、不算可用题（partial/failed 判定只看参与精读的题）。
      const usable = job.questions.filter(question => !['failed', 'queued', 'processing', 'unselected'].includes(question.status));
      job.phase = 'complete';
      if (failed.length === 0) { job.status = 'completed'; job.error = null; }
      else if (usable.length > 0) { job.status = 'partial'; job.error = { code: 'partial', message: '识别暂未完成，已完成的题目已保留。', stage: 'questions', retryable: failed.some(question => question.error?.retryable) }; }
      else { job.status = 'failed'; job.error = failed[0]?.error ?? { code: 'failed', message: '识别暂未完成。', stage: 'questions', retryable: false }; }
      terminal = true;
      this.touch(job);
    }));
    // 仅在真正到达终态时释放容量：并发重试的中间态（仍有 queued/processing 题目）保持占用，
    // 由最后一次 finalize 释放，避免容量提前归还导致的超发。
    // 恰好释放一次：只有本进程登记过占位的任务才归还名额（重复 finalize/遗留任务收拢不误伤他人）。
    if (terminal) {
      this.releaseCapacityOnce(jobId);
    }
  }

  private context(job: StoredRecognitionJob, questionId: string | null) {
    return { jobId: job.id, sourceHash: job.sourceHash, questionId,
      signal: this.shutdown.signal,
      reserveAttempt: async (stage: 'inventory' | 'transcribe' | 'verify' | 'ground') => {
        this.assertRunning();
        let reservation!: { roundId: string; reservationId: string; attempt: number };
        await this.ownedStorage(() => this.store.updateJob(job.id, current => {
          this.assertRunning();
          const round = this.round(current, questionId ?? 'inventory');
          const used = round.reservations.filter(item => item.stage === stage).length;
          if (used >= 3) throw new MobileVisionError('attempt_budget_exhausted', '本轮该阶段已达到三次调用上限，已保存证据；请手动重试开启新一轮。', stage, false);
          const id = crypto.randomUUID();
          round.reservations.push({ id, stage, reservedAt: now() });
          reservation = { roundId: round.id, reservationId: id, attempt: used + 1 };
          this.touch(current);
        }));
        this.assertRunning();
        return reservation;
      },
      // 共享图像信号量：vision 题图/图示裁切互斥执行（Task 3）。
      ...(this.admission ? { withImage: <T,>(section: () => Promise<T>) => this.admission!.withImage(section) } : {}),
      recordAttempt: (attempt: unknown) => this.ownedStorage(() => this.store.writeAttempt(job.id, questionId, attempt)),
      ...(questionId ? { resumeCheckpoint: job.questionCheckpoints[questionId], checkpoint: (checkpoint: StoredRecognitionJob['questionCheckpoints'][string]) => this.ownedStorage(() => this.store.updateJob(job.id, current => {
        const question = current.questions.find(item => item.id === questionId); if (!question) throw new Error('题目不存在');
        current.questionCheckpoints[questionId] = structuredClone(checkpoint); question.evidence = structuredClone(checkpoint.evidence);
        question.verification = checkpoint.verification ? structuredClone(checkpoint.verification) : null; question.revision += 1; this.touch(current);
      })).then(() => undefined) } : {}) };
  }
  private async requireStored(id: string): Promise<StoredRecognitionJob> {
    const job = await this.store.getStoredJob(id); if (!job) throw new MobileRequestError(404, 'not_found', '识别任务不存在。'); return job;
  }
  private assertStorageAvailable(): void {
    if (!this.storageAvailable) throw this.storageUnavailable();
  }
  private storageUnavailable(): MobileRequestError { return new MobileRequestError(503, 'storage_unavailable', '本地存储暂时不可用，未接受新的识别任务。'); }
  private async persistTransition<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof MobileRequestError) throw error;
      this.failStorage(); throw this.storageUnavailable();
    }
  }
  private async ownedStorage<T>(operation: () => Promise<T>): Promise<T> {
    this.assertRunning();
    const pending = Promise.resolve().then(operation);
    this.ownedPersistence.add(pending);
    try { return await pending; }
    catch (error) {
      if (error instanceof MobileVisionError || error instanceof WorkerStopped) throw error;
      const storageError = error instanceof MobileStorageError ? error : new MobileStorageError(error);
      this.failStorage(); throw storageError;
    }
    finally { this.ownedPersistence.delete(pending); }
  }
  private failStorage(): void {
    this.storageAvailable = false; this.accepting = false;
    void this.stop().catch(error => console.error('[storage] Shutdown cleanup failed:', error));
    console.error('[storage] 存储故障：服务停止接收新任务与队列处理（检查磁盘/权限后重启恢复）。');
  }
  private assertRunning(): void {
    if (!this.accepting || this.shutdown.signal.aborted) throw new WorkerStopped('recognition worker stopped');
  }

  private async invoke<T>(operation: () => Promise<T>): Promise<T> {
    this.assertRunning();
    if (this.vision.supportsCancellation) {
      const result = await operation();
      this.assertRunning();
      return result;
    }
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(this.shutdown.signal.reason);
      this.shutdown.signal.addEventListener('abort', abort, { once: true });
    });
    try { const result = await Promise.race([operation(), cancelled]); this.assertRunning(); return result; }
    finally { this.shutdown.signal.removeEventListener('abort', abort); }
  }

  private newRound(job: StoredRecognitionJob, unit: string): void {
    if (!job.attemptBudgets || typeof job.attemptBudgets !== 'object' || Array.isArray(job.attemptBudgets)) job.attemptBudgets = {};
    const previous = job.attemptBudgets[unit];
    const rounds = Array.isArray(previous?.rounds) ? previous.rounds : [];
    let id: string;
    do { id = crypto.randomUUID(); } while (rounds.some(round => round?.id === id));
    job.attemptBudgets[unit] = { currentRoundId: id, rounds: [
      ...rounds,
      { id, reservations: [], retryCount: 0, retryNotBefore: null },
    ] };
  }

  private round(job: StoredRecognitionJob, unit: string): RecognitionAttemptRound {
    const budget = job.attemptBudgets?.[unit];
    const matches = typeof budget?.currentRoundId === 'string' && budget.currentRoundId.trim() && Array.isArray(budget.rounds)
      ? budget.rounds.filter(item => item?.id === budget.currentRoundId) : [];
    // Old ambiguous evidence remains auditable after an explicit new round. Only
    // one nonempty identity may select the active budget; never choose a first match.
    const round = matches.length === 1 ? matches[0] : undefined;
    if (!round || typeof round.id !== 'string' || !Array.isArray(round.reservations)
      || !Number.isSafeInteger(round.retryCount) || round.retryCount < 0
      || !(round.retryNotBefore === null || (Number.isFinite(round.retryNotBefore) && round.retryNotBefore >= 0))
      || round.reservations.some(item => !item || typeof item.id !== 'string' || !['inventory', 'transcribe', 'verify', 'ground'].includes(item.stage) || !Number.isFinite(Date.parse(item.reservedAt)))
      || new Set(round.reservations.map(item => item.id)).size !== round.reservations.length) {
      throw new MobileVisionError('attempt_budget_unknown', '历史调用次数无法可靠确认，已停止自动处理；请手动重试开启新一轮。', unit === 'inventory' ? 'inventory' : 'question', false);
    }
    return round;
  }

  private async scheduleRetry(jobId: string, questionId: string | null, error: RecognitionFailure, limit: number): Promise<boolean> {
    const job = await this.requireStored(jobId);
    const round = this.round(job, questionId ?? 'inventory');
    const delay = this.autoRetryDelaysMs[round.retryCount];
    if (round.retryCount >= limit || delay === undefined) return false;
    const deadline = Date.now() + delay;
    await this.ownedStorage(() => this.store.updateJob(jobId, current => {
      const active = this.round(current, questionId ?? 'inventory');
      active.retryCount += 1; active.retryNotBefore = deadline;
      const f = { ...error, message: '识别暂时失败，正在自动重试…' };
      if (questionId) {
        const question = current.questions.find(item => item.id === questionId)!;
        question.status = 'queued'; question.error = f; question.revision += 1;
      } else { current.status = 'queued'; current.error = f; }
      this.touch(current);
    }));
    this.schedule({ jobId, kind: questionId ? 'question' : 'inventory', ...(questionId ? { questionId } : {}) }, deadline);
    return true;
  }

  private restoreDelay(job: StoredRecognitionJob, questionId: string | null): boolean {
    // Unknown legacy budget is handled by normal work as a recoverable terminal error.
    let deadline: number | null;
    try { deadline = this.round(job, questionId ?? 'inventory').retryNotBefore; } catch { return false; }
    if (!deadline || deadline <= Date.now()) return false;
    this.schedule({ jobId: job.id, kind: questionId ? 'question' : 'inventory', ...(questionId ? { questionId } : {}) }, deadline);
    return true;
  }

  private schedule(task: Work, deadline: number): void {
    if (!this.accepting) return;
    const key = workKey(task);
    if (this.retryTimers.has(key)) return;
    this.retryScheduled.add(key);
    const timer = setTimeout(() => {
      this.retryTimers.delete(key); this.retryScheduled.delete(key);
      this.enqueue(task, true);
    }, Math.max(0, deadline - Date.now()));
    timer.unref(); this.retryTimers.set(key, timer);
  }
  private touch(job: StoredRecognitionJob): void { job.revision += 1; job.updatedAt = now(); }
}
