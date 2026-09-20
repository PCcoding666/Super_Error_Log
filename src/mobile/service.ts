import crypto from 'node:crypto';
import sharp from 'sharp';
import { normalizePhoto } from '../media/images.js';
import { canRecover, publicJob, type RecognitionFailure, type RecognitionJob, type RecognitionQuestion, type StoredRecognitionJob } from './contracts.js';
import type { Box } from '../media/images.js';
import { IdempotencyConflictError, MobileRecognitionStore, UnknownMediaError } from './store.js';
import { MobileVisionError, type InventoryCandidate, type MobileVisionBoundary } from './vision.js';
import type { AdmissionController } from './admission.js';

export class MobileRequestError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); this.name = 'MobileRequestError'; }
}
class MobileStorageError extends Error {
  constructor(cause: unknown) { super('mobile recognition storage unavailable', { cause }); this.name = 'MobileStorageError'; }
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

/** 单进程 RSS 观测阈值（应用层新任务准入，不是内核节流声明）。 */
const RSS_ADMISSION_THRESHOLD_BYTES = 768 * 1024 * 1024;

export class MobileRecognitionService {
  private readonly queue: Array<{ jobId: string; kind: 'inventory' | 'question'; questionId?: string }> = [];
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
  private readonly autoRetryUsed = new Map<string, number>();
  private readonly inflight = new Set<string>();
  private watchdog: ReturnType<typeof setInterval> | null = null;

  constructor(readonly store: MobileRecognitionStore, readonly vision: MobileVisionBoundary) {}

  /** 云端模式：接入入口容量控制（上传图像信号量 + 任务容量释放）。 */
  useAdmission(admission: AdmissionController): void { this.admission = admission; }

  acceptingJobs(): boolean {
    if (!this.accepting) return false;
    // 单进程 RSS 观测：超过 768MiB 阈值时停止接收新任务并记日志（可恢复：内存回落后恢复）。
    const rss = process.memoryUsage.rss();
    if (rss > RSS_ADMISSION_THRESHOLD_BYTES) {
      console.warn(`[admission] 单进程 RSS ${Math.round(rss / 1024 / 1024)}MiB 超过 768MiB 阈值，暂停接收新任务。`);
      return false;
    }
    return true;
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
      this.reserveRetryCapacity(jobId);
      job = await this.persistTransition(() => this.store.updateJob(jobId, current => { current.status = 'queued'; current.error = null; this.touch(current) }));
      this.enqueue({ jobId, kind: 'inventory' });
      return publicJob(job);
    }
    const question = job.questions.find(item => item.id === questionId);
    if (!question) throw new MobileRequestError(404, 'not_found', '题目不存在。');
    if (question.status !== 'failed' || !canRecover(question.error)) throw new MobileRequestError(409, 'not_retryable', '这道题当前不能恢复。');
    this.reserveRetryCapacity(jobId);
    job = await this.persistTransition(() => this.store.updateJob(jobId, current => { const target = current.questions.find(item => item.id === questionId)!;
      target.status = 'queued'; target.error = null; target.revision += 1; current.status = 'processing'; current.phase = 'questions'; current.error = null; this.touch(current); }));
    this.enqueue({ jobId, kind: 'question', questionId });
    return publicJob(job);
  }

  /** 重试重新占用一个任务容量位：非终态任务恰好占用 1（按 jobId 去重，不重复计照片数）；满则保守拒绝。 */
  private reserveRetryCapacity(jobId: string): void {
    if (!this.admission) return;
    if (!this.activeCapacityJobs.has(jobId)) {
      const capacity = this.admission.tryAcquireJobCapacity();
      if (!capacity.accepted) throw new MobileRequestError(429, 'capacity_full', '识别队列已满，请稍后再试。');
      this.activeCapacityJobs.add(jobId);
    }
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

  stop(): void {
    this.accepting = false;
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
  }
  isStorageAvailable(): boolean { return this.storageAvailable; }

  /** 启动看门狗：立即做一次恢复扫描，随后按周期扫描。 */
  startWatchdog(): void {
    if (this.watchdog) return;
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
  async resumeIncompleteJobs(): Promise<void> {
    if (!this.accepting) return;
    // 队列有积压但没人 drain（异常路径下 running 卡 false 的防御）：补一脚驱动。
    if (this.queue.length > 0 && !this.running) void this.drain();
    let resumed = 0;
    for (const job of await this.store.listStoredJobs()) {
      if (['completed', 'partial', 'failed'].includes(job.status)) continue;
      if (job.phase === 'inventory') {
        const key = `${job.id}:inventory:`;
        if (this.queued.has(key) || this.inflight.has(key)) continue;
        if (!['queued', 'processing', 'interrupted'].includes(job.status)) continue;
        if (job.status === 'interrupted' && job.error && !job.error.retryable) continue;
        if (job.status !== 'queued') {
          await this.ownedStorage(() => this.store.updateJob(job.id, current => { current.status = 'queued'; this.touch(current); }));
        }
        this.activeCapacityJobs.add(job.id);
        this.enqueue({ jobId: job.id, kind: 'inventory' });
        resumed += 1;
        continue;
      }
      if (job.phase !== 'questions') continue;
      let resumedAny = false;
      for (const question of job.questions) {
        const key = `${job.id}:question:${question.id}`;
        if (this.queued.has(key) || this.inflight.has(key)) continue;
        const wedged = question.status === 'queued' || question.status === 'processing';
        const interrupted = question.status === 'failed' && question.error?.code === 'interrupted';
        if (!wedged && !interrupted) continue;
        await this.ownedStorage(() => this.store.updateJob(job.id, current => {
          const target = current.questions.find(item => item.id === question.id);
          if (target) { target.status = 'queued'; target.error = null; target.revision += 1; this.touch(current); }
        }));
        this.activeCapacityJobs.add(job.id);
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

  private enqueue(task: { jobId: string; kind: 'inventory' | 'question'; questionId?: string }): void {
    if (!this.accepting) {
      console.warn(`[queue] 服务未在接收状态，任务未能入队：${task.jobId} ${task.kind} ${task.questionId ?? ''}（由看门狗在恢复后重新拾取）`);
      return;
    }
    const key = `${task.jobId}:${task.kind}:${task.questionId ?? ''}`; if (this.queued.has(key)) return;
    this.queued.add(key); this.queue.push(task); void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) return; this.running = true;
    try {
      while (this.accepting && this.queue.length) {
        const task = this.queue.shift()!; this.queued.delete(`${task.jobId}:${task.kind}:${task.questionId ?? ''}`);
        const inflightKey = `${task.jobId}:${task.kind}:${task.questionId ?? ''}`;
        this.inflight.add(inflightKey);
        try {
          if (task.kind === 'inventory') await this.processInventory(task.jobId);
          else await this.processQuestionRetry(task.jobId, task.questionId!);
        } catch { this.failStorage(); }
        finally { this.inflight.delete(inflightKey); }
      }
    } finally { this.running = false; }
  }

  private async processInventory(jobId: string): Promise<void> {
    let job = await this.requireStored(jobId); if (job.phase !== 'inventory' || !['queued', 'interrupted'].includes(job.status)) return;
    job = await this.ownedStorage(() => this.store.updateJob(jobId, current => { current.status = 'processing'; current.error = null; this.touch(current); }));
    try {
      const source = await this.ownedStorage(() => this.store.readSource(job.id));
      const result = await this.vision.inventory(source, this.context(job, null));
      job = await this.ownedStorage(() => this.store.updateJob(jobId, current => {
        current.inventoryWarnings = result.warnings;
        current.questions = result.candidates.map(candidate => {
        const id = crypto.randomUUID(); current.inventoryCandidates[id] = structuredClone(candidate);
        return { id, number: candidate.number, revision: 1, status: 'queued', selectionEvidence: candidate.selectionEvidence,
          evidence: null, verification: null, questionMediaId: null, diagramMediaIds: [], error: null, confirmedAt: null };
      });
        current.phase = 'questions'; current.status = 'processing'; this.touch(current);
      }));
    } catch (error) {
      if (error instanceof MobileStorageError) throw error;
      const f = failure(error, 'inventory');
      const used = this.autoRetryUsed.get(jobId) ?? 0;
      if (f.retryable && used < 1 && this.autoRetryDelaysMs.length > 0) {
        // 清单级瞬时失败自动重试一次：任务保持 queued，客户端只见「等待识别」。
        this.autoRetryUsed.set(jobId, used + 1);
        await this.ownedStorage(() => this.store.updateJob(jobId, current => {
          current.status = 'queued'; current.error = { ...f, message: '识别暂时失败，正在自动重试…' }; this.touch(current);
        }));
        const delay = this.autoRetryDelaysMs[0]!;
        console.warn(`[queue] 清单自动重试：job=${jobId}，${delay}ms 后执行（${f.code}）。`);
        const timer = setTimeout(() => this.enqueue({ jobId, kind: 'inventory' }), delay);
        timer.unref();
        return;
      }
      await this.ownedStorage(() => this.store.updateJob(jobId, current => { current.status = 'failed'; current.phase = 'inventory'; current.error = f; this.touch(current); }));
      // 清单失败即任务终态：释放入口容量，避免容量泄漏。
      this.admission?.releaseJobCapacity(); this.activeCapacityJobs.delete(jobId);
      return;
    }
    await this.processQuestions(job.id, job.questions.map(question => question.id));
  }

  private async processQuestions(jobId: string, questionIds: string[]): Promise<void> {
    let cursor = 0;
    // Task 3：逐题并发降为 1（云端 2GB 机器资源保护；回环模式同样收敛）。
    const worker = async () => { while (cursor < questionIds.length) { const id = questionIds[cursor++]; if (id) await this.runQuestion(jobId, id); } };
    await Promise.all(Array.from({ length: Math.min(1, questionIds.length) }, worker));
    await this.finalize(jobId);
  }

  private async processQuestionRetry(jobId: string, questionId: string): Promise<void> { await this.runQuestion(jobId, questionId); await this.finalize(jobId); }

  private async runQuestion(jobId: string, questionId: string): Promise<void> {
    let job = await this.requireStored(jobId); let question = job.questions.find(item => item.id === questionId);
    if (!question || question.status !== 'queued') return;
    job = await this.ownedStorage(() => this.store.updateJob(jobId, current => { const target = current.questions.find(item => item.id === questionId)!;
      target.status = 'processing'; target.error = null; target.revision += 1; this.touch(current); }));
    question = job.questions.find(item => item.id === questionId)!;
    try {
      const source = await this.ownedStorage(() => this.store.readSource(job.id)); const candidate = job.inventoryCandidates[questionId] as InventoryCandidate | undefined;
      if (!candidate) throw new MobileVisionError('invalid_output', '题目候选定位记录缺失。', 'question', false);
      const result = await this.vision.recognizeQuestion(source, candidate, this.context(job, questionId));
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
      if (error instanceof MobileStorageError) throw error;
      const f = failure(error, 'question');
      const retryKey = `${jobId}:${questionId}`;
      const used = this.autoRetryUsed.get(retryKey) ?? 0;
      if (f.retryable && used < this.autoRetryDelaysMs.length) {
        // 题级瞬时失败自动退避重试：题目回到 queued，客户端只见「等待识别」，无需人工点重试。
        this.autoRetryUsed.set(retryKey, used + 1);
        await this.ownedStorage(() => this.store.updateJob(jobId, current => { const target = current.questions.find(item => item.id === questionId);
          if (!target) return;
          target.status = 'queued'; target.revision += 1;
          target.error = { ...f, message: `识别暂时失败，正在自动重试（第 ${used + 1} 次）…` };
          this.touch(current); }));
        const delay = this.autoRetryDelaysMs[used]!;
        console.warn(`[queue] 题目自动重试：job=${jobId} question=${questionId} 第 ${used + 1} 次，${delay}ms 后执行（${f.code}）。`);
        const timer = setTimeout(() => this.enqueue({ jobId, kind: 'question', questionId }), delay);
        timer.unref();
        return;
      }
      await this.ownedStorage(() => this.store.updateJob(jobId, current => { const target = current.questions.find(item => item.id === questionId);
        if (!target) return; target.status = 'failed'; target.error = f; target.revision += 1; this.touch(current); }));
    }
  }

  private async finalize(jobId: string): Promise<void> {
    let terminal = false;
    await this.ownedStorage(() => this.store.updateJob(jobId, job => { const failed = job.questions.filter(question => question.status === 'failed');
      if (job.questions.some(question => question.status === 'queued' || question.status === 'processing')) return;
      for (const question of job.questions) {
        if (question.status === 'needs_check' && !unresolvedOccurrence(job, question) && !occurrenceConflict(job, question)
          && allChecksPass(question, job.inventoryCandidates[question.id])) { question.status = 'ready'; question.revision += 1; }
      }
      const usable = job.questions.filter(question => !['failed', 'queued', 'processing'].includes(question.status));
      job.phase = 'complete';
      if (failed.length === 0) { job.status = 'completed'; job.error = null; }
      else if (usable.length > 0) { job.status = 'partial'; job.error = { code: 'partial', message: '识别暂未完成，已完成的题目已保留。', stage: 'questions', retryable: failed.some(question => question.error?.retryable) }; }
      else { job.status = 'failed'; job.error = failed[0]?.error ?? { code: 'failed', message: '识别暂未完成。', stage: 'questions', retryable: false }; }
      terminal = true;
      this.touch(job);
    }));
    // 仅在真正到达终态时释放容量：并发重试的中间态（仍有 queued/processing 题目）保持占用，
    // 由最后一次 finalize 释放，避免容量提前归还导致的超发。
    if (terminal) {
      this.admission?.releaseJobCapacity(); this.activeCapacityJobs.delete(jobId);
      // 任务终态后清空该任务的自动重试预算：人工重试开启新一轮时重新获得完整预算。
      for (const key of [...this.autoRetryUsed.keys()]) if (key === jobId || key.startsWith(`${jobId}:`)) this.autoRetryUsed.delete(key);
    }
  }

  private context(job: StoredRecognitionJob, questionId: string | null) {
    return { jobId: job.id, sourceHash: job.sourceHash, questionId,
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
    try { return await operation(); }
    catch (error) {
      const storageError = error instanceof MobileStorageError ? error : new MobileStorageError(error);
      this.failStorage(); throw storageError;
    }
  }
  private failStorage(): void {
    this.storageAvailable = false; this.accepting = false;
    console.error('[storage] 存储故障：服务停止接收新任务与队列处理（检查磁盘/权限后重启恢复）。');
  }
  private touch(job: StoredRecognitionJob): void { job.revision += 1; job.updatedAt = now(); }
}
