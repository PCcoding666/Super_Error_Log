import { newId } from '../db/connection.js';
import { canRecover } from '../mobile/contracts.js';
import type { AdmissionController } from '../mobile/admission.js';
import type { AdmissionReserve } from '../mobile/router.js';
import { MobileRecognitionService, MobileRequestError } from '../mobile/service.js';
import type { JobTicket, MaterialJobKind } from './contracts.js';
import { MaterialStore } from './store.js';

type JobRow = JobTicket & { request_id: string; question_id: string | null; asset_id: string | null; basis_key: string; input_json: string; error: string | null };
type Failure = { code: string; message: string; retryable: boolean };
export type MaterialStage = { round: number; attempts: number; state: 'running' | 'succeeded' | 'failed'; result?: unknown; error?: Failure; nextAttemptAt?: number };
export type MaterialExecution = { stages: Record<string, MaterialStage>; retryRequestIds: string[] };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validateRequestId(requestId: string): void { if (!UUID.test(requestId)) throw new MobileRequestError(400, 'invalid_request', '请求键必须是 UUID。'); }
const pending = (state: string) => ['queued', 'running', 'interrupted'].includes(state);
const ticket = (row: JobTicket): JobTicket => ({ id: row.id, kind: row.kind, state: row.state });
function failure(error: unknown): Failure {
  const candidate = error as Partial<Failure> | null;
  const code = typeof candidate?.code === 'string' ? candidate.code : 'internal';
  return { code: typeof candidate?.code === 'string' ? candidate.code : 'internal', message: typeof candidate?.message === 'string' ? candidate.message : '处理暂未完成。', retryable: candidate?.retryable === true && !['internal', 'storage_unavailable', 'invalid_image'].includes(code) };
}
function paused(): MobileRequestError { return new MobileRequestError(503, 'service_paused', '处理服务已暂停，请稍后重试。'); }

/** All external calls must use request(), once per validated request/chunk, to persist budgets and reusable results. */
export class MaterialJobs {
  readonly dataDir: string;
  retryDelaysMs = [2_000, 8_000];
  private readonly handlers = new Map<MaterialJobKind, (jobId: string, signal: AbortSignal) => Promise<void>>();
  private readonly occupancy = new Set<string>();
  private readonly active = new Map<string, Promise<void>>();
  private readonly signals = new Map<string, AbortSignal>();
  private readonly requests = new Map<string, Promise<unknown>>();
  private readonly shutdown = new AbortController();
  private stopped = false;

  constructor(readonly store: MaterialStore, private readonly scheduler: MobileRecognitionService, private readonly admission: AdmissionController | null) {
    this.dataDir = scheduler.store.dataDir;
    scheduler.registerExternalLifecycle({ resume: () => this.resume(), stop: () => this.stop() });
  }

  register(kind: MaterialJobKind, run: (jobId: string, signal: AbortSignal) => Promise<void>): void { this.handlers.set(kind, run); }
  get(jobId: string): JobTicket | null { const row = this.row(jobId); return row ? ticket(row) : null; }
  execution(jobId: string): MaterialExecution {
    const row = this.require(jobId);
    return JSON.parse(row.input_json).execution ?? { stages: {}, retryRequestIds: [] };
  }

  enqueue(kind: MaterialJobKind, targetId: string, requestId: string, basisKey: string, options: { reservation?: AdmissionReserve; persist?: () => void; input?: unknown; dependencies?: unknown; persistJob?: (job:JobTicket)=>void } = {}): JobTicket {
    validateRequestId(requestId);
    const prior = this.store.db.prepare(`SELECT * FROM material_job WHERE owner_id=? AND request_id=? AND kind=? AND ${kind === 'extract' ? 'asset_id' : 'question_id'}=?`)
      .get(this.store.studentId, requestId, kind, targetId) as JobRow | undefined;
    if (prior) {
      if (prior.basis_key !== basisKey) throw new MobileRequestError(409, 'idempotency_conflict', '请求键已用于不同内容。');
      return ticket(prior);
    }
    if (this.stopped || !this.scheduler.acceptingJobs()) throw paused();
    const supplied = options.reservation?.capacity === true && !options.reservation.handoff;
    if (this.admission && !supplied && !this.admission.tryAcquireJobCapacity().accepted) throw new MobileRequestError(429, 'capacity_full', '处理队列已满，请稍后重试。');
    const id = newId('mjob');
    try {
      this.store.transaction(() => {
        // Upload rows and their job commit together; ownership moves only after RELEASE succeeds.
        options.persist?.();
        this.store.db.prepare(`INSERT INTO material_job(id,owner_id,request_id,kind,question_id,asset_id,basis_key,input_json,dependencies_json) VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(id, this.store.studentId, requestId, kind, kind === 'extract' ? null : targetId, kind === 'extract' ? targetId : null, basisKey,JSON.stringify(options.input??{}),JSON.stringify(options.dependencies??[]));
        options.persistJob?.({id,kind,state:'queued'});
      });
    } catch (error) {
      if (this.admission && !supplied) this.admission.releaseJobCapacity();
      throw error;
    }
    this.occupancy.add(id);
    if (supplied) options.reservation!.handoff = true;
    this.schedule(id);
    return ticket(this.require(id));
  }

  retry(jobId: string, requestId: string): JobTicket {
    validateRequestId(requestId);
    const row = this.require(jobId); const execution = this.execution(jobId);
    if (execution.retryRequestIds.includes(requestId) || row.request_id === requestId) return ticket(row);
    // Each material request is a model stage; reuse the legacy model-stage manual recovery policy.
    if (!['failed', 'interrupted'].includes(row.state) || (row.error && !canRecover({ ...JSON.parse(row.error), stage: 'transcribe' }))) throw new MobileRequestError(409, 'not_retryable', '这份材料无法重试，请补拍或重新提交。');
    if (this.stopped || !this.scheduler.acceptingJobs()) throw paused();
    const acquired = !this.occupancy.has(jobId);
    if (acquired && this.admission && !this.admission.tryAcquireJobCapacity().accepted) throw new MobileRequestError(429, 'capacity_full', '处理队列已满，请稍后重试。');
    try {
      for (const stage of Object.values(execution.stages)) {
        if (stage.state !== 'succeeded') { stage.round++; stage.attempts = 0; delete stage.error; delete stage.nextAttemptAt; stage.state = 'running'; }
      }
      execution.retryRequestIds.push(requestId);
      this.store.transaction(() => { this.saveExecution(jobId, execution); this.transition(jobId, 'queued', null); });
    } catch (error) { if (acquired && this.admission) this.admission.releaseJobCapacity(); throw error; }
    this.occupancy.add(jobId); this.schedule(jobId); return ticket(this.require(jobId));
  }

  async resume(): Promise<void> {
    if (this.stopped) return;
    // Link invalidation can cancel a queued job before its handler was registered.
    for (const id of this.occupancy) if (!this.active.has(id)&&!pending(this.require(id).state)) this.release(id);
    const rows = this.store.db.prepare("SELECT * FROM material_job WHERE owner_id=? AND state IN ('queued','running','interrupted')").all(this.store.studentId) as JobRow[];
    for (const row of rows) {
      if (!this.occupancy.has(row.id)) { this.admission?.noteExistingOccupancy(); this.occupancy.add(row.id); }
      this.schedule(row.id);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true; this.shutdown.abort(paused());
    // Join started callbacks, including durable checkpoint writes, before releasing ownership.
    const settled = await Promise.allSettled([...this.active.values()]);
    const errors: unknown[] = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    for (const id of [...this.occupancy]) {
      try { if (pending(this.require(id).state)) this.transition(id, 'interrupted', { code: 'interrupted', message: '处理已中断，保存的材料仍然保留。', retryable: true }); }
      catch (error) { errors.push(error); }
      finally { this.release(id); }
    }
    if (errors.length) throw new AggregateError(errors, 'Material shutdown could not persist all interrupted states; capacity was released.');
  }

  async request<T>(jobId: string, stageKey: string, invoke: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = this.signals.get(jobId);
    if (!signal || signal.aborted) throw paused();
    const key = JSON.stringify([jobId, stageKey]);
    const current = this.requests.get(key);
    if (current) return current as Promise<T>;
    // Install ownership before invoke can run, including a synchronous reentrant caller.
    const work = Promise.resolve().then(() => this.requestStage(jobId, stageKey, invoke, signal))
      .finally(() => { this.requests.delete(key); });
    this.requests.set(key, work);
    return work;
  }

  private async requestStage<T>(jobId: string, stageKey: string, invoke: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
    for (;;) {
      signal.throwIfAborted();
      if (this.require(jobId).state !== 'running') throw new MobileRequestError(409, 'stale_basis', '材料已更新，请重新发起处理。');
      const execution = this.execution(jobId);
      const stage = execution.stages[stageKey] ?? { round: 1, attempts: 0, state: 'running' as const };
      if (stage.state === 'succeeded') return stage.result as T;
      if (stage.error && !stage.error.retryable) throw stage.error;
      if (stage.attempts >= 3) throw stage.error ?? { code: 'retry_budget_exhausted', message: '本轮请求次数已用完，请重试。', retryable: true };
      const waitMs = (stage.nextAttemptAt ?? 0) - Date.now();
      if (waitMs > 0) {
        await this.delay(waitMs, signal);
        // Other stages can finish or reserve attempts during backoff. Read their current
        // checkpoints again before the synchronous reservation below.
        continue;
      }
      signal.throwIfAborted();
      stage.attempts++; stage.state = 'running'; delete stage.nextAttemptAt;
      execution.stages[stageKey] = stage; this.saveExecution(jobId, execution);
      try {
        const result = await invoke(signal);
        signal.throwIfAborted();
        // Re-read to preserve checkpoints from other stage keys in the same handler.
        const updated = this.execution(jobId);
        updated.stages[stageKey] = { ...stage, state: 'succeeded', result }; delete updated.stages[stageKey]!.error;
        this.saveExecution(jobId, updated); return result;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        const updated = this.execution(jobId); const problem = failure(error);
        const failed: MaterialStage = { ...stage, state: 'failed', error: problem };
        if (problem.retryable && stage.attempts < 3) failed.nextAttemptAt = Date.now() + (this.retryDelaysMs[stage.attempts - 1] ?? [2_000, 8_000][stage.attempts - 1]!);
        updated.stages[stageKey] = failed; this.saveExecution(jobId, updated);
        if (!problem.retryable || stage.attempts >= 3) throw problem;
      }
    }
  }

  private schedule(id: string): void {
    const row = this.require(id);
    if (this.stopped || !pending(row.state) || !this.handlers.has(row.kind)) return;
    this.scheduler.enqueueExternalWork(`material:${this.store.studentId}:${id}`, async signal => {
      if (this.stopped) return;
      const work = this.run(id, AbortSignal.any([signal, this.shutdown.signal]));
      this.active.set(id, work);
      try { await work; } finally { this.active.delete(id); }
    });
  }
  private async run(id: string, signal: AbortSignal): Promise<void> {
    const row = this.require(id); const handler = this.handlers.get(row.kind);
    if (!pending(row.state)) { this.release(id); return; }
    if (!handler) return;
    this.signals.set(id, signal);
    try {
      signal.throwIfAborted(); this.transition(id, 'running', null);
      await handler(id, signal); signal.throwIfAborted();
      // A handler may atomically mark a result stale when its dependency revision changed.
      if (this.require(id).state === 'running') this.transition(id, 'succeeded', null);
    } catch (error) {
      if (pending(this.require(id).state)) this.transition(id, signal.aborted ? 'interrupted' : 'failed', signal.aborted ? { code: 'interrupted', message: '处理已中断，已完成结果仍然保留。', retryable: true } : failure(error));
    } finally { this.signals.delete(id); this.release(id); }
  }
  private row(id: string): JobRow | undefined { return this.store.db.prepare('SELECT * FROM material_job WHERE owner_id=? AND id=?').get(this.store.studentId, id) as JobRow | undefined; }
  private require(id: string): JobRow { const row = this.row(id); if (!row) throw new MobileRequestError(404, 'not_found', '材料任务不存在。'); return row; }
  private saveExecution(id: string, execution: MaterialExecution): void {
    const input = JSON.parse(this.require(id).input_json); input.execution = execution;
    this.store.db.prepare('UPDATE material_job SET input_json=?,updated_at=CURRENT_TIMESTAMP WHERE owner_id=? AND id=?').run(JSON.stringify(input), this.store.studentId, id);
  }
  private transition(id: string, state: JobTicket['state'], error: Failure | null): void {
    this.store.db.prepare('UPDATE material_job SET state=?,error=?,updated_at=CURRENT_TIMESTAMP WHERE owner_id=? AND id=?').run(state, error ? JSON.stringify(error) : null, this.store.studentId, id);
  }
  private release(id: string): void { if (this.occupancy.delete(id)) this.admission?.releaseJobCapacity(); }
  private delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
      const timer = setTimeout(finish, ms);
      const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    });
  }
}
