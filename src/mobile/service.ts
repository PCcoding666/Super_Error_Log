import crypto from 'node:crypto';
import sharp from 'sharp';
import { normalizePhoto } from '../media/images.js';
import { canRecover, publicJob, type RecognitionFailure, type RecognitionJob, type RecognitionQuestion, type StoredRecognitionJob } from './contracts.js';
import type { Box } from '../media/images.js';
import { IdempotencyConflictError, MobileRecognitionStore, UnknownMediaError } from './store.js';
import { MobileVisionError, type InventoryCandidate, type MobileVisionBoundary } from './vision.js';

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

export class MobileRecognitionService {
  private readonly queue: Array<{ jobId: string; kind: 'inventory' | 'question'; questionId?: string }> = [];
  private readonly queued = new Set<string>();
  private running = false;
  private accepting = true;
  private storageAvailable = true;

  constructor(readonly store: MobileRecognitionStore, readonly vision: MobileVisionBoundary) {}

  async submit(input: { idempotencyKey: string; photoName: string; sourceBytes: Buffer }): Promise<RecognitionJob> {
    this.assertStorageAvailable();
    let normalized: Buffer;
    try {
      const metadata = await sharp(input.sourceBytes, { failOn: 'error', limitInputPixels: 40_000_000 }).metadata();
      if (metadata.format !== 'jpeg') throw new Error('not jpeg');
      normalized = await normalizePhoto(input.sourceBytes);
    }
    catch { throw new MobileRequestError(400, 'invalid_image', '照片无法读取、已损坏或超过大小限制。'); }
    let result;
    try { result = await this.store.createJob({ ...input, normalizedBytes: normalized }); }
    catch (error) {
      if (error instanceof MobileRequestError || error instanceof IdempotencyConflictError) throw error;
      this.failStorage(); throw new MobileRequestError(503, 'storage_unavailable', '本地存储暂时不可用，未接受新的识别任务。');
    }
    if (result.created) this.enqueue({ jobId: result.job.id, kind: 'inventory' });
    return result.job;
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
      job = await this.persistTransition(() => this.store.updateJob(jobId, current => { current.status = 'queued'; current.error = null; this.touch(current); })); this.enqueue({ jobId, kind: 'inventory' });
      return publicJob(job);
    }
    const question = job.questions.find(item => item.id === questionId);
    if (!question) throw new MobileRequestError(404, 'not_found', '题目不存在。');
    if (question.status !== 'failed' || !canRecover(question.error)) throw new MobileRequestError(409, 'not_retryable', '这道题当前不能恢复。');
    job = await this.persistTransition(() => this.store.updateJob(jobId, current => { const target = current.questions.find(item => item.id === questionId)!;
      target.status = 'queued'; target.error = null; target.revision += 1; current.status = 'processing'; current.phase = 'questions'; current.error = null; this.touch(current); }));
    this.enqueue({ jobId, kind: 'question', questionId });
    return publicJob(job);
  }

  async confirm(jobId: string, questionId: string, input: { revision: number; action: 'confirm' | 'skip'; sourceCompared?: boolean }): Promise<RecognitionJob> {
    this.assertStorageAvailable();
    await this.requireStored(jobId);
    const job = await this.persistTransition(() => this.store.updateJob(jobId, current => {
      const question = current.questions.find(item => item.id === questionId);
      if (!question) throw new MobileRequestError(404, 'not_found', '题目不存在。');
      if (question.revision !== input.revision) throw new MobileRequestError(409, 'stale_revision', '题目已更新，请重新查看后再确认。');
      if (input.action === 'confirm') {
        const candidate = current.inventoryCandidates[questionId];
        if (input.sourceCompared !== true || !allChecksPass(question, candidate) || question.status !== 'ready'
          || unresolvedOccurrence(current, question) || occurrenceConflict(current, question)) throw new MobileRequestError(409, 'confirmation_required', '请先对照原图并解决所有不确定项。');
        question.status = 'confirmed'; question.confirmedAt = now();
      } else if (input.action === 'skip') {
        if (question.status === 'queued' || question.status === 'processing') throw new MobileRequestError(409, 'question_active', '题目仍在识别中，请等待本轮完成后再操作。');
        if (question.status === 'confirmed') throw new MobileRequestError(409, 'already_confirmed', '已确认题目不能直接跳过。');
        question.status = 'skipped'; question.confirmedAt = null;
      } else throw new MobileRequestError(400, 'invalid_request', '确认操作不合法。');
      question.revision += 1; this.touch(current);
    }));
    return publicJob(job);
  }

  stop(): void { this.accepting = false; }
  isStorageAvailable(): boolean { return this.storageAvailable; }

  private enqueue(task: { jobId: string; kind: 'inventory' | 'question'; questionId?: string }): void {
    if (!this.accepting) return;
    const key = `${task.jobId}:${task.kind}:${task.questionId ?? ''}`; if (this.queued.has(key)) return;
    this.queued.add(key); this.queue.push(task); void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) return; this.running = true;
    try {
      while (this.accepting && this.queue.length) {
        const task = this.queue.shift()!; this.queued.delete(`${task.jobId}:${task.kind}:${task.questionId ?? ''}`);
        try {
          if (task.kind === 'inventory') await this.processInventory(task.jobId);
          else await this.processQuestionRetry(task.jobId, task.questionId!);
        } catch { this.failStorage(); }
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
      await this.ownedStorage(() => this.store.updateJob(jobId, current => { current.status = 'failed'; current.phase = 'inventory'; current.error = failure(error, 'inventory'); this.touch(current); }));
      return;
    }
    await this.processQuestions(job.id, job.questions.map(question => question.id));
  }

  private async processQuestions(jobId: string, questionIds: string[]): Promise<void> {
    let cursor = 0;
    const worker = async () => { while (cursor < questionIds.length) { const id = questionIds[cursor++]; if (id) await this.runQuestion(jobId, id); } };
    await Promise.all(Array.from({ length: Math.min(2, questionIds.length) }, worker));
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
      await this.ownedStorage(() => this.store.updateJob(jobId, current => { const target = current.questions.find(item => item.id === questionId);
        if (!target) return; target.status = 'failed'; target.error = failure(error, 'question'); target.revision += 1; this.touch(current); }));
    }
  }

  private async finalize(jobId: string): Promise<void> {
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
      this.touch(job);
    }));
  }

  private context(job: StoredRecognitionJob, questionId: string | null) {
    return { jobId: job.id, sourceHash: job.sourceHash, questionId, recordAttempt: (attempt: unknown) => this.ownedStorage(() => this.store.writeAttempt(job.id, questionId, attempt)),
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
  private failStorage(): void { this.storageAvailable = false; this.accepting = false; }
  private touch(job: StoredRecognitionJob): void { job.revision += 1; job.updatedAt = now(); }
}
