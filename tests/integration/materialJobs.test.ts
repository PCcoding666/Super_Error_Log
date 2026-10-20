import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { migrateMaterials } from '../../src/materials/schema.js';
import { MaterialStore } from '../../src/materials/store.js';
import { MaterialJobs } from '../../src/materials/jobs.js';
import { MobileRecognitionService } from '../../src/mobile/service.js';
import { MobileRecognitionStore } from '../../src/mobile/store.js';
import { AdmissionController } from '../../src/mobile/admission.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(capacity = 2) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'material-jobs-'));
  const db = new DatabaseSync(path.join(dir, 'app.db')); db.exec('PRAGMA foreign_keys=ON'); db.exec(SCHEMA_SQL); migrateMaterials(db);
  db.exec("INSERT INTO student_profile(id,nickname,created_at) VALUES ('student','Synthetic','2026-10-20')");
  const store = new MaterialStore(db, 'student'); const question = store.createQuestion().id;
  const admission = new AdmissionController({ jobCapacity: capacity, diskProbe: async () => 10n ** 12n });
  const scheduler = new MobileRecognitionService(await MobileRecognitionStore.open(dir), { inventory: async () => ({ candidates: [], warnings: [], capacityReached: false }), recognizeQuestion: async () => { throw new Error('unused'); } });
  scheduler.useAdmission(admission);
  const jobs = new MaterialJobs(store, scheduler, admission);
  cleanups.push(async () => { await scheduler.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, db, store, question, scheduler, admission, jobs };
}
async function settled(jobs: MaterialJobs, id: string, state: string) {
  await expect.poll(() => jobs.get(id)?.state).toBe(state);
}
const transient = () => Object.assign(new Error('synthetic busy'), { code: 'provider_unavailable', retryable: true });

describe('durable material scheduling', () => {
  it('keeps missing handlers pending and shares capacity with legacy work', async () => {
    const f = await fixture(1);
    const ticket = f.jobs.enqueue('answer', f.question, randomUUID(), 'basis');
    await f.jobs.resume();
    expect(f.jobs.get(ticket.id)?.state).toBe('queued');
    expect(f.admission.tryAcquireJobCapacity().accepted).toBe(false);
    expect(() => f.jobs.enqueue('grade', f.question, randomUUID(), 'basis')).toThrow(expect.objectContaining({ status: 429 }));
    expect(await f.scheduler.listJobs()).toEqual([]);
    f.jobs.register('answer', async () => {}); await f.jobs.resume();
    await settled(f.jobs, ticket.id, 'succeeded');
    expect(f.admission.tryAcquireJobCapacity().accepted).toBe(true); f.admission.releaseJobCapacity();
  });

  it('serializes external work with the legacy drain and isolates handler errors', async () => {
    const f = await fixture(); const order: string[] = []; let release!: () => void;
    f.scheduler.enqueueExternalWork('block', async () => { order.push('first'); await new Promise<void>(r => { release = r; }); order.push('last'); });
    f.jobs.register('answer', async () => { order.push('material'); throw new Error('handler failed'); });
    const ticket = f.jobs.enqueue('answer', f.question, randomUUID(), 'basis');
    await expect.poll(() => order).toEqual(['first']); release();
    await settled(f.jobs, ticket.id, 'failed');
    expect(order).toEqual(['first', 'last', 'material']); expect(f.scheduler.isStorageAvailable()).toBe(true);
  });

  it('shares the worker and capacity with a real legacy recognition job', async () => {
    const f = await fixture(2); let release!: () => void; const order: string[] = [];
    f.scheduler.vision.inventory = async () => { order.push('legacy'); await new Promise<void>(r => { release = r; }); return { candidates: [], warnings: [], capacityReached: false }; };
    const bytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#fff' } }).jpeg().toBuffer();
    expect(f.admission.tryAcquireJobCapacity().accepted).toBe(true);
    const legacy = await f.scheduler.submit({ idempotencyKey: randomUUID(), photoName: 'legacy.jpg', sourceBytes: bytes });
    await expect.poll(() => order).toEqual(['legacy']);
    f.jobs.register('answer', async () => { order.push('material'); });
    const material = f.jobs.enqueue('answer', f.question, randomUUID(), 'basis');
    expect(f.admission.tryAcquireJobCapacity().accepted).toBe(false);
    await new Promise(resolve => setImmediate(resolve)); expect(order).toEqual(['legacy']); release();
    await settled(f.jobs, material.id, 'succeeded');
    expect((await f.scheduler.getJob(legacy.job.id)).status).toBe('completed'); expect(order).toEqual(['legacy', 'material']);
    expect(f.admission.tryAcquireJobCapacity().accepted).toBe(true); expect(f.admission.tryAcquireJobCapacity().accepted).toBe(true);
    f.admission.releaseJobCapacity(); f.admission.releaseJobCapacity();
  });

  it('rejects bad-file retries even when the boundary incorrectly calls them retryable', async () => {
    const f = await fixture(); f.jobs.retryDelaysMs = [1, 2]; let calls = 0;
    f.jobs.register('answer', async id => { await f.jobs.request(id, 'decode', async () => { calls++; throw Object.assign(new Error('bad file'), { code: 'invalid_image', retryable: true }); }); });
    const ticket = f.jobs.enqueue('answer', f.question, randomUUID(), 'basis'); await settled(f.jobs, ticket.id, 'failed');
    expect(calls).toBe(1); expect(() => f.jobs.retry(ticket.id, randomUUID())).toThrow(expect.objectContaining({ status: 409 }));
  });

  it('permits explicit retry after configuration repair without automatically retrying authentication errors', async () => {
    const f = await fixture(); let calls = 0;
    f.jobs.register('answer', async id => { await f.jobs.request(id, 'answer', async () => { calls++; if (calls === 1) throw Object.assign(new Error('config missing'), { code: 'authentication', retryable: false }); return 'ok'; }); });
    const ticket = f.jobs.enqueue('answer', f.question, randomUUID(), 'basis'); await settled(f.jobs, ticket.id, 'failed'); expect(calls).toBe(1);
    f.jobs.retry(ticket.id, randomUUID()); await settled(f.jobs, ticket.id, 'succeeded'); expect(calls).toBe(2);
  });

  it('does not send a request when its durable budget reservation fails', async () => {
    const f = await fixture(); let calls = 0;
    f.db.exec("CREATE TRIGGER reject_budget BEFORE UPDATE OF input_json ON material_job BEGIN SELECT RAISE(ABORT,'budget disk failure'); END");
    f.jobs.register('answer', async id => { await f.jobs.request(id, 'request', async () => { calls++; return 'never'; }); });
    const ticket = f.jobs.enqueue('answer', f.question, randomUUID(), 'basis'); await settled(f.jobs, ticket.id, 'failed');
    expect(calls).toBe(0); expect(f.jobs.execution(ticket.id).stages).toEqual({});
  });

  it('watchdog picks up durable material work after its handler becomes available', async () => {
    const f = await fixture(); f.scheduler.watchdogIntervalMs = 10; await f.scheduler.initialize();
    const ticket = f.jobs.enqueue('answer', f.question, randomUUID(), 'basis');
    await new Promise(resolve => setTimeout(resolve, 30)); expect(f.jobs.get(ticket.id)?.state).toBe('queued');
    f.jobs.register('answer', async () => {}); await settled(f.jobs, ticket.id, 'succeeded');
  });

  it('persists each actual request before invoking and retries at most three times', async () => {
    const f = await fixture(); f.jobs.retryDelaysMs = [1, 2]; let calls = 0;
    f.jobs.register('answer', async id => {
      await f.jobs.request(id, 'answer:chunk:0', async () => {
        calls++; expect(f.jobs.execution(id).stages['answer:chunk:0']?.attempts).toBe(calls); throw transient();
      });
    });
    const ticket = f.jobs.enqueue('answer', f.question, randomUUID(), 'basis');
    await settled(f.jobs, ticket.id, 'failed');
    expect(calls).toBe(3); expect(f.jobs.execution(ticket.id).stages['answer:chunk:0']?.attempts).toBe(3);
    await f.jobs.resume(); expect(calls).toBe(3);
  });

  it('resumes only unfinished work without resetting request budgets', async () => {
    const f = await fixture(); let successfulExtractionCalls = 0;
    f.jobs.retryDelaysMs = [500, 500];
    f.jobs.register('answer', async id => {
      await f.jobs.request(id, 'extract', async () => { successfulExtractionCalls++; return { text: 'saved' }; });
      await f.jobs.request(id, 'verify', async () => { throw transient(); });
    });
    const ticket = f.jobs.enqueue('answer', f.question, randomUUID(), 'basis');
    await expect.poll(() => f.jobs.execution(ticket.id).stages.verify?.attempts).toBe(1);
    const attemptsBeforeRestart = f.jobs.execution(ticket.id).stages.verify!.attempts;
    await f.scheduler.stop(); expect(f.jobs.get(ticket.id)?.state).toBe('interrupted');
    expect(await f.admission.accepting()).toBe(true);
    const scheduler = new MobileRecognitionService(await MobileRecognitionStore.open(f.dir), f.scheduler.vision);
    scheduler.useAdmission(f.admission);
    const reopenedDb = new DatabaseSync(path.join(f.dir, 'app.db'));
    const restarted = new MaterialJobs(new MaterialStore(reopenedDb, 'student'), scheduler, f.admission);
    cleanups.push(async () => { await scheduler.stop(); reopenedDb.close(); });
    restarted.register('answer', async id => {
      await restarted.request(id, 'extract', async () => { successfulExtractionCalls++; return { text: 'bad repeat' }; });
      await restarted.request(id, 'verify', async () => 'verified');
    });
    await restarted.resume();
    const attemptsAfterRestart = restarted.execution(ticket.id).stages.verify!.attempts;
    expect(attemptsAfterRestart).toBe(attemptsBeforeRestart); expect(successfulExtractionCalls).toBe(1);
    await settled(restarted, ticket.id, 'succeeded');
    expect(successfulExtractionCalls).toBe(1); expect(restarted.execution(ticket.id).stages.verify!.attempts).toBe(2);
    await scheduler.stop();
    const admissionOccupancyAfterStop = f.admission.tryAcquireJobCapacity().accepted ? 0 : 1;
    expect(admissionOccupancyAfterStop).toBe(0); f.admission.releaseJobCapacity();
  });

  it('explicit retry is idempotent and reuses successful stages', async () => {
    const f = await fixture(); f.jobs.retryDelaysMs = [1, 2]; let firstCalls = 0; let secondCalls = 0; let succeed = false;
    f.jobs.register('answer', async id => {
      expect(await f.jobs.request(id, 'first', async () => { firstCalls++; return 'validated'; })).toBe('validated');
      await f.jobs.request(id, 'second', async () => { secondCalls++; if (!succeed) throw transient(); return 'ok'; });
    });
    const ticket = f.jobs.enqueue('answer', f.question, randomUUID(), 'basis'); await settled(f.jobs, ticket.id, 'failed');
    const requestId = randomUUID(); succeed = true;
    expect(f.jobs.retry(ticket.id, requestId).id).toBe(ticket.id);
    expect(f.jobs.retry(ticket.id, requestId).id).toBe(ticket.id);
    await settled(f.jobs, ticket.id, 'succeeded');
    expect(firstCalls).toBe(1); expect(secondCalls).toBe(4);
    expect(f.jobs.execution(ticket.id).stages.second?.round).toBe(2);
  });

  it('rejects invalid request IDs before reserving capacity', async () => {
    const f = await fixture(1);
    expect(() => f.jobs.enqueue('answer', f.question, 'not-a-uuid', 'basis')).toThrow(expect.objectContaining({ status: 400 }));
    expect(f.db.prepare('SELECT count(*) n FROM material_job').get()).toEqual({ n: 0 });
    expect(await f.admission.accepting()).toBe(true);
  });

  it('explicit retry opens a fresh round for an interrupted request but keeps completed stages', async () => {
    const f = await fixture();
    const ticket = f.jobs.enqueue('answer', f.question, randomUUID(), 'basis');
    f.db.prepare('UPDATE material_job SET state=?,input_json=? WHERE id=?').run('interrupted', JSON.stringify({ execution: { retryRequestIds: [], stages: {
      completed: { round: 1, attempts: 1, state: 'succeeded', result: 'saved' },
      interrupted: { round: 1, attempts: 3, state: 'running' },
    } } }), ticket.id);
    f.jobs.register('answer', async id => {
      expect(await f.jobs.request(id, 'completed', async () => { throw new Error('completed stage replayed'); })).toBe('saved');
      await f.jobs.request(id, 'interrupted', async () => 'recovered');
    });
    f.jobs.retry(ticket.id, randomUUID()); await settled(f.jobs, ticket.id, 'succeeded');
    expect(f.jobs.execution(ticket.id).stages.interrupted).toMatchObject({ round: 2, attempts: 1 });
  });

  it('stop interrupts queued and running external work and releases capacity once', async () => {
    const f = await fixture(2);
    f.jobs.register('answer', async (id) => { await f.jobs.request(id, 'request', signal => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); })); });
    const first = f.jobs.enqueue('answer', f.question, randomUUID(), 'basis');
    const second = f.jobs.enqueue('answer', f.question, randomUUID(), 'basis');
    await expect.poll(() => f.jobs.get(first.id)?.state).toBe('running');
    await f.scheduler.stop(); await f.jobs.stop();
    expect([f.jobs.get(first.id)?.state, f.jobs.get(second.id)?.state]).toEqual(['interrupted', 'interrupted']);
    expect(f.admission.tryAcquireJobCapacity().accepted).toBe(true);
    expect(f.admission.tryAcquireJobCapacity().accepted).toBe(true);
    expect(f.admission.tryAcquireJobCapacity().accepted).toBe(false);
    f.admission.releaseJobCapacity(); f.admission.releaseJobCapacity();
    expect(f.scheduler.enqueueExternalWork('after-stop', async () => {})).toBe('stopped');
  });
});
