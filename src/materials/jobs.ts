import { newId } from '../db/connection.js';
import { canRecover } from '../mobile/contracts.js';
import { CAPACITY_FULL_RETRY_SECONDS, SERVICE_PAUSED_RETRY_SECONDS, type AdmissionController } from '../mobile/admission.js';
import type { AdmissionReserve } from '../mobile/router.js';
import { MobileRecognitionService, MobileRequestError } from '../mobile/service.js';
import { SET_HOLD_MS, SET_PAGE_MISSING } from './captureHints.js';
import type { CaptureHints, JobTicket, MaterialJobKind } from './contracts.js';
import { MaterialStore } from './store.js';

type JobRow = JobTicket & { request_id: string; question_id: string | null; asset_id: string | null; basis_key: string; input_json: string; error: string | null };
/** `detail`: head of a model body that failed validation (invalid_output); stays in this student's job record, never in logs or responses. */
type Failure = { code: string; message: string; retryable: boolean; detail?: string };
export type MaterialStage = { round: number; attempts: number; state: 'running' | 'succeeded' | 'failed'; result?: unknown; error?: Failure; nextAttemptAt?: number };
export type MaterialExecution = { stages: Record<string, MaterialStage>; retryRequestIds: string[] };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validateRequestId(requestId: string): void { if (!UUID.test(requestId)) throw new MobileRequestError(400, 'invalid_request', '请求键必须是 UUID。'); }
const pending = (state: string) => ['queued', 'running', 'interrupted'].includes(state);
const ticket = (row: JobTicket): JobTicket => ({ id: row.id, kind: row.kind, state: row.state });
function failure(error: unknown): Failure {
  const candidate = error as Partial<Failure> | null;
  const code = typeof candidate?.code === 'string' ? candidate.code : 'internal';
  const detail = typeof candidate?.detail === 'string' && candidate.detail ? candidate.detail.slice(0, 4000) : undefined;
  return { code: typeof candidate?.code === 'string' ? candidate.code : 'internal', message: typeof candidate?.message === 'string' ? candidate.message : '处理暂未完成。', retryable: candidate?.retryable === true && !['internal', 'storage_unavailable', 'invalid_image'].includes(code), ...(detail ? { detail } : {}) };
}
function paused(): MobileRequestError { return new MobileRequestError(503, 'service_paused', '处理服务已暂停，请稍后重试。', SERVICE_PAUSED_RETRY_SECONDS); }

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
  private readonly holdTimer: ReturnType<typeof setInterval>;

  constructor(readonly store: MaterialStore, private readonly scheduler: MobileRecognitionService, private readonly admission: AdmissionController | null) {
    this.dataDir = scheduler.store.dataDir;
    scheduler.registerExternalLifecycle({ resume: () => this.resume(), stop: () => this.stop() });
    // A live process must notice an abandoned set without waiting for the next restart.
    this.holdTimer = setInterval(() => { if (!this.stopped) this.releaseExpiredHolds(); }, 60_000);
    this.holdTimer.unref?.();
  }

  register(kind: MaterialJobKind, run: (jobId: string, signal: AbortSignal) => Promise<void>): void { this.handlers.set(kind, run); }
  /** 还有排队或正在跑的材料任务（后台解答等它们做完再开始）。 */
  busy(): boolean { return this.occupancy.size > 0 || this.active.size > 0; }
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
    // Waiting pages are not work yet. They must not take a slot in the per-student queue.
    const deferred = this.deferred({ input_json: JSON.stringify(options.input ?? {}) });
    const follower = this.follower({ input_json: JSON.stringify(options.input ?? {}) });
    // A page joining a set that already has a lead does not take a second slot and does not start its own extract.
    if (!deferred && !follower && this.admission && !supplied && !this.admission.tryAcquireJobCapacity().accepted) throw new MobileRequestError(429, 'capacity_full', '处理队列已满，请稍后重试。', CAPACITY_FULL_RETRY_SECONDS);
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
      if (!deferred && !follower && this.admission && !supplied) this.admission.releaseJobCapacity();
      throw error;
    }
    if (deferred || follower) return ticket(this.require(id));
    this.occupancy.add(id);
    if (supplied) options.reservation!.handoff = true;
    this.schedule(id);
    return ticket(this.require(id));
  }

  /**
   * Start one extract for a multi-page set from the pages already stored. Followers do not take a slot.
   * `accepted` is false when nothing started. `queued` stays true when the pages are still waiting because the queue is full.
   */
  releaseCapture(captureId: string): { accepted: boolean; queued: boolean } {
    const rows = this.captureJobs(captureId);
    if (!rows.length) return { accepted: false, queued: false };
    const appointed = this.appointedLead(captureId);
    if (appointed && !rows.some(row => row.id === appointed.id)) return this.startIndividuals(rows);
    const lead = appointed ? rows.find(row => row.id === appointed.id)! : this.leadOf(rows);
    return this.startLead(lead, rows);
  }

  /** Process whatever pages have arrived once a set has been waiting too long. Survives restart via resume(). */
  releaseExpiredHolds(maxAgeMs = SET_HOLD_MS): void {
    const seconds = Math.max(1, Math.floor(maxAgeMs / 1000));
    const rows = this.store.db.prepare(`SELECT DISTINCT a.capture_id AS captureId FROM material_job j
      JOIN material_asset a ON a.owner_id=j.owner_id AND a.id=j.asset_id
      WHERE j.owner_id=? AND j.kind='extract' AND j.state IN ('queued','interrupted')
        AND json_extract(j.input_json,'$.deferred') = 1
        AND datetime(a.created_at) <= datetime('now', ?)`).all(this.store.studentId, `-${seconds} seconds`) as { captureId: string }[];
    for (const row of rows) this.releaseCapture(row.captureId);
  }

  /** waiting: still held. released: a lead was chosen. abandoned: the student gave the set up. */
  capturePhase(captureId: string): 'waiting' | 'released' | 'abandoned' {
    const rows = this.store.db.prepare(`SELECT j.state, j.input_json, j.error FROM material_job j
      JOIN material_asset a ON a.owner_id=j.owner_id AND a.id=j.asset_id
      WHERE j.owner_id=? AND j.kind='extract' AND a.capture_id=?`).all(this.store.studentId, captureId) as { state: string; input_json: string; error: string | null }[];
    for (const row of rows) {
      if (!row.error) continue;
      try { if ((JSON.parse(row.error) as { code?: string }).code === 'set_abandoned') return 'abandoned'; } catch { /* not a structured error */ }
    }
    for (const row of rows) {
      const input = this.inputOf(row);
      if (input.setRole === 'lead' || input.setRole === 'follow' || input.deferred !== true) return 'released';
    }
    return 'waiting';
  }

  /** True while the chosen first page has not reached a terminal state. */
  leadPending(captureId: string): boolean {
    const lead = this.appointedLead(captureId);
    return !!lead && pending(lead.state);
  }

  /** Drop an unfinished multi-page set. The pages stay saved; their extract jobs do not keep a queue slot. */
  abandonCapture(captureId: string): number {
    const assets = this.store.db.prepare('SELECT hints_json FROM material_asset WHERE owner_id=? AND capture_id=?').all(this.store.studentId, captureId) as { hints_json: string }[];
    const multi = assets.some(row => { try { return (JSON.parse(row.hints_json) as CaptureHints).captureMode === 'multi'; } catch { return false; } });
    if (!multi) throw new MobileRequestError(409, 'set_conflict', '这不是一组多页。');
    const rows = this.captureJobs(captureId);
    let abandoned = 0;
    for (const row of rows) {
      if (!pending(row.state)) continue;
      if (this.occupancy.has(row.id)) this.release(row.id);
      const input = this.inputOf(row);
      delete input.deferred;
      this.writeInput(row.id, input);
      this.transition(row.id, 'failed', { code: 'set_abandoned', message: '这组多页没有传完，已放弃。', retryable: false });
      abandoned += 1;
    }
    return abandoned;
  }

  retry(jobId: string, requestId: string): JobTicket {
    validateRequestId(requestId);
    const row = this.require(jobId); const execution = this.execution(jobId);
    if (execution.retryRequestIds.includes(requestId) || row.request_id === requestId) return ticket(row);
    // Each material request is a model stage; reuse the legacy model-stage manual recovery policy.
    if (!['failed', 'interrupted'].includes(row.state) || (row.error && !canRecover({ ...JSON.parse(row.error), stage: 'transcribe' }))) throw new MobileRequestError(409, 'not_retryable', '这份材料无法重试，请补拍或重新提交。');
    if (this.stopped || !this.scheduler.acceptingJobs()) throw paused();
    const acquired = !this.occupancy.has(jobId);
    if (acquired && this.admission && !this.admission.tryAcquireJobCapacity().accepted) throw new MobileRequestError(429, 'capacity_full', '处理队列已满，请稍后重试。', CAPACITY_FULL_RETRY_SECONDS);
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
    this.releaseExpiredHolds();
    // Link invalidation can cancel a queued job before its handler was registered.
    for (const id of this.occupancy) if (!this.active.has(id)&&!pending(this.require(id).state)) this.release(id);
    const rows = this.store.db.prepare("SELECT * FROM material_job WHERE owner_id=? AND state IN ('queued','running','interrupted')").all(this.store.studentId) as JobRow[];
    for (const row of rows) {
      if (this.held(row)) continue;
      if (this.follower(row)) {
        const saved = row.asset_id ? this.store.db.prepare('SELECT extraction_json FROM material_asset WHERE owner_id=? AND id=?').get(this.store.studentId, row.asset_id) as { extraction_json: string | null } | undefined : undefined;
        if (saved?.extraction_json) this.transition(row.id, 'succeeded', null);
        else if (this.leadTerminal(row)) this.failMissing(row.id);
        continue;
      }
      if (!this.occupancy.has(row.id)) { this.admission?.noteExistingOccupancy(); this.occupancy.add(row.id); }
      if (this.deferred(row)) this.clearDeferred(row.id);
      this.schedule(row.id);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true; clearInterval(this.holdTimer); this.shutdown.abort(paused());
    // Join started callbacks, including durable checkpoint writes, before releasing ownership.
    const settled = await Promise.allSettled([...this.active.values()]);
    const errors: unknown[] = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    for (const id of [...this.occupancy]) {
      try {
        const row = this.require(id);
        // An incomplete multi-page set is still waiting for the rest of its pages, not a failed extract.
        if (pending(row.state) && !this.held(row)) this.transition(id, 'interrupted', { code: 'interrupted', message: '处理已中断，保存的材料仍然保留。', retryable: true });
      }
      catch (error) { errors.push(error); }
      finally { this.release(id); }
    }
    if (errors.length) throw new AggregateError(errors, 'Material shutdown could not persist all interrupted states; capacity was released.');
  }

  async request<T>(jobId: string, stageKey: string, invoke: (signal: AbortSignal, beforeRequest?: () => Promise<void>) => Promise<T>): Promise<T> {
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

  private async requestStage<T>(jobId: string, stageKey: string, invoke: (signal: AbortSignal, beforeRequest?: () => Promise<void>) => Promise<T>, signal: AbortSignal): Promise<T> {
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
        let firstRequest = true;
        const beforeRequest = async (): Promise<void> => {
          signal.throwIfAborted();
          if (this.require(jobId).state !== 'running') throw new MobileRequestError(409, 'stale_basis', '材料已更新，请重新发起处理。');
          if (firstRequest) { firstRequest = false; return; }
          if (stage.attempts >= 3) throw { code: 'retry_budget_exhausted', message: '本轮请求次数已用完，请重试。', retryable: true };
          stage.attempts++;
          const current = this.execution(jobId);
          current.stages[stageKey] = { ...stage };
          this.saveExecution(jobId, current);
        };
        const result = await invoke(signal, beforeRequest);
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

  private inputOf(row: { input_json: string }): Record<string, unknown> {
    try {
      const value = JSON.parse(row.input_json) as unknown;
      return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    } catch { return {}; }
  }
  private deferred(row: { input_json: string }): boolean { return this.inputOf(row).deferred === true; }
  private follower(row: { input_json: string }): boolean { return this.inputOf(row).setRole === 'follow'; }
  /** The job that was chosen to read the set, including after it has already finished. */
  private appointedLead(captureId: string): JobRow | undefined {
    const rows = this.store.db.prepare(`SELECT j.* FROM material_job j
      JOIN material_asset a ON a.owner_id=j.owner_id AND a.id=j.asset_id
      WHERE j.owner_id=? AND j.kind='extract' AND a.capture_id=?`).all(this.store.studentId, captureId) as JobRow[];
    return rows.find(row => this.inputOf(row).setRole === 'lead');
  }
  private leadTerminal(row: JobRow): boolean {
    if (!row.asset_id) return false;
    const asset = this.store.db.prepare('SELECT capture_id FROM material_asset WHERE owner_id=? AND id=?').get(this.store.studentId, row.asset_id) as { capture_id: string } | undefined;
    if (!asset) return false;
    const lead = this.appointedLead(asset.capture_id);
    return !!lead && lead.id !== row.id && !pending(lead.state);
  }
  /** The first page already finished. Remaining pages are extracted on their own, never as a new lead. */
  private startIndividuals(rows: (JobRow & { hints_json: string })[]): { accepted: boolean; queued: boolean } {
    let accepted = false;
    let queued = false;
    for (const row of rows) {
      const input = this.inputOf(row);
      if (input.setRole === 'lead') continue;
      if (input.setRole === 'follow') {
        const saved = row.asset_id ? this.store.db.prepare('SELECT extraction_json FROM material_asset WHERE owner_id=? AND id=?').get(this.store.studentId, row.asset_id) as { extraction_json: string | null } | undefined : undefined;
        if (saved?.extraction_json) this.transition(row.id, 'succeeded', null);
        else this.failMissing(row.id);
        continue;
      }
      if (!this.deferred(row) && (this.occupancy.has(row.id) || !pending(row.state))) { accepted = true; continue; }
      if (!this.occupancy.has(row.id)) {
        if (this.admission && !this.admission.tryAcquireJobCapacity().accepted) { queued = true; continue; }
        this.occupancy.add(row.id);
      }
      delete input.deferred;
      delete input.setRole;
      this.writeInput(row.id, input);
      this.schedule(row.id);
      accepted = true;
    }
    return { accepted, queued };
  }
  /** Keep an already chosen lead. Pages that are already running on their own are left alone. */
  private startLead(lead: JobRow & { hints_json: string }, rows: (JobRow & { hints_json: string })[]): { accepted: boolean; queued: boolean } {
    const participants = rows.filter(row => {
      const input = this.inputOf(row);
      return row.id === lead.id || input.deferred === true || input.setRole === 'follow' || input.setRole === 'lead';
    });
    if (this.admission && !this.occupancy.has(lead.id) && !this.admission.tryAcquireJobCapacity().accepted) return { accepted: false, queued: true };
    for (const row of participants) {
      const input = this.inputOf(row);
      delete input.deferred;
      input.setRole = row.id === lead.id ? 'lead' : 'follow';
      this.writeInput(row.id, input);
    }
    if (!this.occupancy.has(lead.id)) this.occupancy.add(lead.id);
    if (!this.active.has(lead.id)) this.schedule(lead.id);
    return { accepted: true, queued: false };
  }
  /** A follower the lead did not cover. Clearing the role lets a retry read this page by itself. */
  private failMissing(id: string): void {
    const row = this.require(id);
    if (row.state !== 'queued' && row.state !== 'interrupted') return;
    const input = this.inputOf(row);
    delete input.deferred;
    delete input.setRole;
    this.store.transaction(() => {
      const current = this.require(id);
      if (current.state !== 'queued' && current.state !== 'interrupted') return;
      this.writeInput(id, input);
      this.transition(id, 'failed', SET_PAGE_MISSING);
    });
  }
  private writeInput(id: string, input: Record<string, unknown>): void {
    this.store.db.prepare('UPDATE material_job SET input_json=?, updated_at=CURRENT_TIMESTAMP WHERE owner_id=? AND id=?').run(JSON.stringify(input), this.store.studentId, id);
  }
  private captureJobs(captureId: string): (JobRow & { hints_json: string })[] {
    return this.store.db.prepare(`SELECT j.*, a.hints_json FROM material_job j
      JOIN material_asset a ON a.owner_id=j.owner_id AND a.id=j.asset_id
      WHERE j.owner_id=? AND j.kind='extract' AND a.capture_id=? AND j.state IN ('queued','interrupted','running')`).all(this.store.studentId, captureId) as (JobRow & { hints_json: string })[];
  }
  private leadOf(rows: (JobRow & { hints_json: string })[]): JobRow & { hints_json: string } {
    return [...rows].sort((a, b) => {
      const page = (row: { hints_json: string }) => { try { return (JSON.parse(row.hints_json) as CaptureHints).pageIndex ?? 0; } catch { return 0; } };
      return page(a) - page(b) || a.id.localeCompare(b.id);
    })[0]!;
  }
  /** True while a multi-page extract is waiting for the rest of its capture. */
  private held(row: JobRow): boolean {
    if (!this.deferred(row) || !row.asset_id) return false;
    const asset = this.store.db.prepare('SELECT capture_id, hints_json FROM material_asset WHERE owner_id=? AND id=?').get(this.store.studentId, row.asset_id) as { capture_id: string; hints_json: string } | undefined;
    if (!asset) return false;
    const hints = this.inputOf({ input_json: asset.hints_json });
    const pageCount = hints.pageCount;
    if (hints.captureMode !== 'multi' || typeof pageCount !== 'number' || pageCount <= 1) return false;
    const count = this.store.db.prepare('SELECT count(*) AS n FROM material_asset WHERE owner_id=? AND capture_id=?').get(this.store.studentId, asset.capture_id) as { n: number };
    return count.n < pageCount;
  }
  private clearDeferred(id: string): void {
    const row = this.require(id);
    const input = this.inputOf(row);
    if (input.deferred !== true) return;
    delete input.deferred;
    this.writeInput(id, input);
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
    } finally {
      // A page can join while the lead's write is already done. Settle it once the lead is actually finished.
      this.settleFinishedLead(id);
      this.signals.delete(id); this.release(id);
    }
  }
  /** The lead reached a terminal state. Covered followers are done; the rest can be retried alone. */
  private settleFinishedLead(id: string): void {
    const row = this.row(id);
    if (!row?.asset_id || this.inputOf(row).setRole !== 'lead' || pending(row.state)) return;
    const asset = this.store.db.prepare('SELECT capture_id FROM material_asset WHERE owner_id=? AND id=?').get(this.store.studentId, row.asset_id) as { capture_id: string } | undefined;
    if (!asset) return;
    const followers = this.store.db.prepare(`SELECT j.id, j.asset_id FROM material_job j
      JOIN material_asset a ON a.owner_id=j.owner_id AND a.id=j.asset_id
      WHERE j.owner_id=? AND j.kind='extract' AND a.capture_id=? AND j.state IN ('queued','interrupted')`).all(this.store.studentId, asset.capture_id) as { id: string; asset_id: string }[];
    for (const follower of followers) {
      if (this.inputOf(this.require(follower.id)).setRole !== 'follow') continue;
      const saved = this.store.db.prepare('SELECT extraction_json FROM material_asset WHERE owner_id=? AND id=?').get(this.store.studentId, follower.asset_id) as { extraction_json: string | null } | undefined;
      if (saved?.extraction_json) this.transition(follower.id, 'succeeded', null);
      else this.failMissing(follower.id);
    }
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
