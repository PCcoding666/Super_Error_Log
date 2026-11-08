/** Independent issue #121 regression: real HTTP/SQLite boundaries; synthetic, gated extraction only. */
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import sharp from 'sharp';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { newId } from '../../src/db/connection.js';
import { migrateMaterials } from '../../src/materials/schema.js';
import { MaterialStore } from '../../src/materials/store.js';
import { MaterialJobs } from '../../src/materials/jobs.js';
import { MaterialUploads } from '../../src/materials/uploads.js';
import { extractMaterial } from '../../src/materials/extraction.js';
import { MaterialProviderError, PartialMaterialExtractionError, type MaterialProvider } from '../../src/materials/provider.js';
import type { Extraction, Fragment } from '../../src/materials/contracts.js';
import { MobileRecognitionService } from '../../src/mobile/service.js';
import { MobileRecognitionStore } from '../../src/mobile/store.js';
import { acquireProcessImage } from '../../src/mobile/admission.js';
import { createStudentApi } from '../../src/web/api.js';

type Progress = { extraction: Extraction; phase: 'located' | 'enriching' };
type ProgressCallback = (progress: Progress) => void | Promise<void>;
type Candidate = { id: string; crop: string | null; excerpt: string; status: string; submitted?: boolean };
type Photo = {
  id: string; state: string; candidates: Candidate[]; questions: { id: string }[];
  progress?: { stage: string; total: number; verified: number };
};
type Intake = { busy: boolean; photos: Photo[] };
type Gate = {
  publish: (progress: Progress) => Promise<void>;
  resolve: (extraction: Extraction) => void;
  reject: (error: unknown) => void;
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'intake-progress-'));
  const databasePath = path.join(dir, 'app.db');
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(SCHEMA_SQL);
  migrateMaterials(db);
  db.exec("INSERT INTO student_profile(id,nickname,created_at) VALUES ('a','Synthetic A','2026-11-08'),('b','Synthetic B','2026-11-08')");
  const scheduler = new MobileRecognitionService(await MobileRecognitionStore.open(dir), {
    inventory: async () => ({ candidates: [], warnings: [], capacityReached: false }),
    recognizeQuestion: async () => { throw new Error('unused'); },
  });
  const gates = new Map<string, Gate>();
  const stores = { a: new MaterialStore(db, 'a'), b: new MaterialStore(db, 'b') };
  const jobs = { a: new MaterialJobs(stores.a, scheduler, null), b: new MaterialJobs(stores.b, scheduler, null) };
  const uploads = { a: new MaterialUploads(stores.a, jobs.a, null), b: new MaterialUploads(stores.b, jobs.b, null) };
  const provider: MaterialProvider = {
    extract: async (input, signal) => new Promise<Extraction>((resolve, reject) => {
      // Structural extension allows the initial RED run before the provider interface is added.
      const onProgress = (input as typeof input & { onProgress?: ProgressCallback }).onProgress;
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      gates.set(input.assetId, {
        publish: async progress => { await onProgress?.(progress); },
        resolve: extraction => { signal.removeEventListener('abort', abort); resolve(extraction); },
        reject: error => { signal.removeEventListener('abort', abort); reject(error); },
      });
      if (signal.aborted) abort();
    }),
  };
  for (const owner of ['a', 'b'] as const) jobs[owner].register('extract', (id, signal) => extractMaterial(stores[owner], provider, id, signal));
  const app = express();
  const mount = (prefix: string, store: MaterialStore, owner: 'a' | 'b') => app.use(prefix, createStudentApi({
    mobileDataDir: dir, materials: store, service: scheduler, timeZone: 'Asia/Singapore', now: () => new Date(),
  }, { studentHostWorker: true, service: scheduler, materialsJobs: jobs[owner], accountRoleOf: () => 'student', inviteExpiresOf: () => null }));
  mount('/s/api', stores.a, 'a');
  mount('/other/api', stores.b, 'b');
  // Separate DB connection + store + router: a fresh request context must recover saved picks from disk.
  const reopened = new DatabaseSync(databasePath);
  mount('/reload/api', new MaterialStore(reopened, 'a'), 'a');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await scheduler.stop();
    reopened.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const bytes = await sharp({ create: { width: 240, height: 160, channels: 3, background: '#83b7e2' } }).png().toBuffer();
  const get = (url: string) => fetch(base + url, { headers: { accept: 'application/json' } });
  const intake = async (prefix = '/s/api'): Promise<Intake> => {
    const response = await get(`${prefix}/intake`);
    expect(response.status).toBe(200);
    return response.json() as Promise<Intake>;
  };
  const select = async (assetId: string, ids: string[], prefix = '/s/api') => {
    const response = await fetch(`${base}${prefix}/intake/photos/${assetId}/select`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ ids }),
    });
    return { status: response.status, body: await response.json() as { included?: number; pending?: number; skipped?: number } };
  };
  const page = async (owner: 'a' | 'b' = 'a') => {
    const saved = await uploads[owner].save({
      captureId: stores[owner].createCapture(randomUUID()).id, uploadId: randomUUID(), filename: 'synthetic.png', bytes,
      hints: { label: randomUUID() },
    });
    await expect.poll(() => gates.has(saved.assetId)).toBe(true);
    const fragment: Fragment = {
      assetId: saved.assetId, fragmentId: newId('mfr'), revision: 1, sourceHash: uploads[owner].source(saved.assetId).sourceHash,
      box: { x: .25, y: .25, width: .5, height: .5 }, role: 'question', text: '', number: '1', subpart: null,
      page: 1, order: 0, requiresDiagram: false, check: 'unchecked', uncertainties: [],
    };
    const extraction = (extra: Partial<Fragment> = {}, siblings: Fragment[] = []): Extraction => ({
      assetId: saved.assetId, revision: 1,
      document: { title: 'Synthetic worksheet', subject: '数学', date: null, printedCode: null, page: 1 },
      fragments: [{ ...fragment, ...extra }, ...siblings], warnings: [], runs: [],
    });
    return {
      ...saved, owner, fragment, candidateId: `${fragment.fragmentId}:1`, extraction,
      detail: `/s/api/intake/candidates/${fragment.fragmentId}?revision=1`,
      crop: `/s/api/intake/candidates/${fragment.fragmentId}/crop?revision=1`,
      gate: () => gates.get(saved.assetId)!,
      publish: (phase: Progress['phase'], extra: Partial<Fragment> = {}, siblings: Fragment[] = []) => gates.get(saved.assetId)!.publish({ phase, extraction: extraction(extra, siblings) }),
      finish: async (extra: Partial<Fragment> = {}, siblings: Fragment[] = []) => {
        gates.get(saved.assetId)!.resolve(extraction({ text: '1. 求 x 的值。', check: 'passed', ...extra }, siblings));
        await expect.poll(() => jobs[owner].get(saved.job.id)?.state).toBe('succeeded');
      },
    };
  };
  const count = (table: string) => (db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;
  const evidence = () => Object.fromEntries(['material_fragment', 'material_question', 'material_item_link', 'error_item', 'material_answer', 'material_grade', 'material_inclusion', 'material_inclusion_event'].map(table => [table, count(table)]));
  const fingerprint = () => Object.fromEntries([
    'material_asset', 'material_job', 'material_fragment', 'material_question', 'material_link_event',
    'material_inclusion', 'material_inclusion_event', 'material_item_link', 'error_item', 'material_answer', 'material_grade',
  ].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  return { db, stores, jobs, base, server, page, get, intake, select, count, evidence, fingerprint };
}

describe('first selectable intake candidates', () => {
  it.each(['queued', 'running'] as const)('keeps %s photos busy while stable crop candidates acquire checked text', async state => {
    const f = await fixture();
    const page = await f.page();
    await page.publish('located');
    // A queued follower / resumed checkpoint must expose the same preview as an active page.
    f.db.prepare('UPDATE material_job SET state=? WHERE id=?').run(state, page.job.id);
    const first = await f.intake();
    expect(first.busy).toBe(true);
    expect(first.photos).toHaveLength(1);
    expect(first.photos[0]).toMatchObject({
      id: page.assetId, questions: [],
      candidates: [{ id: page.candidateId, crop: page.crop, status: 'preliminary' }],
      progress: { stage: 'located', total: 1, verified: 0 },
    });
    const before = f.evidence();
    expect(Object.values(before)).toEqual(Array(8).fill(0));
    await page.publish('enriching', { text: '1. 求 x 的值。' });
    const reading = await f.intake();
    expect(reading.photos[0]).toMatchObject({ candidates: [{ id: page.candidateId, status: 'verifying' }], progress: { stage: 'enriching', total: 1, verified: 0 } });
    await page.publish('enriching', { text: '1. 求 x 的值。', check: 'passed' });
    const verified = await f.intake();
    expect(verified.busy).toBe(true);
    // A checked fragment alone has not passed the final whole-question/diagram gate.
    expect(verified.photos[0]).toMatchObject({ candidates: [{ id: page.candidateId, status: 'verifying' }], progress: { stage: 'enriching', total: 1, verified: 1 } });
    expect(f.evidence()).toEqual(before);
    f.db.prepare("UPDATE material_job SET state='running' WHERE id=?").run(page.job.id);
    await page.finish();
    const final = await f.intake();
    expect(final.busy).toBe(false);
    expect(final.photos[0]!.candidates).toMatchObject([{ id: page.candidateId, status: 'verified' }]);
    expect(f.count('error_item')).toBe(0);
  });

  it('reads full preliminary text and a local crop without creating evidence, jobs, answers or grades', async () => {
    const f = await fixture();
    const page = await f.page();
    const longStem = `1. SYNTHETIC-PRIVATE ${'完整题干'.repeat(40)}`;
    await page.publish('enriching', { text: longStem });
    const before = f.fingerprint();
    for (let read = 0; read < 2; read++) {
      const detail = await f.get(page.detail);
      expect(detail.status).toBe(200);
      expect(detail.headers.get('cache-control')).toContain('no-store');
      expect(await detail.json()).toMatchObject({
        id: page.fragment.fragmentId, revision: 1, crop: page.crop, source: `/s/materials/assets/${page.assetId}/image`,
        stem: [{ text: longStem, check: 'unchecked' }], answers: [], grades: [], work: [], marks: [],
      });
      const crop = await f.get(page.crop);
      expect(crop.status).toBe(200);
      expect(crop.headers.get('content-type')).toMatch(/^image\/jpeg/);
      expect(crop.headers.get('cache-control')).toContain('no-store');
      expect(await sharp(Buffer.from(await crop.arrayBuffer())).metadata()).toMatchObject({ width: 120, height: 80 });
    }
    expect(f.fingerprint()).toEqual(before);
  });

  it('persists an early selection across fresh readers and files it once only after final reconciliation', async () => {
    const f = await fixture();
    const page = await f.page();
    await page.publish('located');
    expect(await f.select(page.assetId, [page.candidateId])).toMatchObject({ status: 200, body: { included: 0, pending: 1, skipped: 0 } });
    expect((await f.intake('/reload/api')).photos[0]!.candidates).toMatchObject([{ id: page.candidateId, submitted: true }]);
    expect(await f.select(page.assetId, [page.candidateId, page.candidateId])).toMatchObject({ status: 200, body: { included: 0, pending: 1, skipped: 0 } });
    await page.publish('enriching', { text: '1. 求 x 的值。', check: 'passed' });
    expect(Object.values(f.evidence())).toEqual(Array(8).fill(0));
    await page.finish();
    expect(f.count('error_item')).toBe(1);
    expect(f.count('material_item_link')).toBe(1);
    expect(f.count('material_inclusion_event')).toBe(1);
    const final = await f.intake();
    expect(final.busy).toBe(false);
    expect(final.photos[0]!.questions).toHaveLength(1);
    expect(final.photos[0]!.candidates).toEqual([]);
    expect(final.photos[0]!.progress).toMatchObject({ stage: 'done', total: 1, verified: 1 });
    const before = f.evidence();
    expect(await f.select(page.assetId, [page.candidateId])).toMatchObject({ status: 200, body: { included: 1, pending: 0, skipped: 0 } });
    expect(f.evidence()).toEqual(before);
  });

  it('waits for the shared image permit before serving a preview crop', async () => {
    const f = await fixture();
    const page = await f.page();
    await page.publish('located');
    const release = await acquireProcessImage();
    const received = new Promise<void>(resolve => f.server.once('request', () => resolve()));
    let settled = false;
    const response = f.get(page.crop).then(response => { settled = true; return response; });
    try {
      await received;
      // The request reached Express. This bounded negative check only verifies
      // it cannot finish while another image operation owns the shared permit.
      await new Promise<void>(resolve => setTimeout(resolve, 50));
      expect(settled).toBe(false);
    } finally { release(); }
    const crop = await response;
    expect(crop.status).toBe(200);
    expect(await sharp(Buffer.from(await crop.arrayBuffer())).metadata()).toMatchObject({ width: 120, height: 80 });
  });

  it('retains a useful crop and saved selection through failed enrichment and retry', async () => {
    const f = await fixture();
    const page = await f.page();
    await page.publish('enriching', { text: '1. 看不清的式子', check: 'low', uncertainties: ['blurry'] });
    expect((await f.select(page.assetId, [page.candidateId])).body).toMatchObject({ included: 0, pending: 1, skipped: 0 });
    const priorGate = page.gate();
    priorGate.reject(new MaterialProviderError('provider_unavailable', 'Synthetic verification outage', true));
    await expect.poll(() => f.jobs.a.get(page.job.id)?.state).toBe('failed');
    expect((await f.intake('/reload/api')).photos[0]).toMatchObject({ state: 'failed', candidates: [{ id: page.candidateId, submitted: true, status: 'needs_review' }] });
    expect((await f.get(page.crop)).status).toBe(200);
    const retry = await fetch(`${f.base}/s/api/intake/photos/${page.assetId}/retry`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: f.base }, body: JSON.stringify({ requestId: randomUUID() }),
    });
    expect(retry.status).toBe(200);
    await expect.poll(() => page.gate() !== priorGate).toBe(true);
    await page.publish('located');
    expect((await f.intake('/reload/api')).photos[0]!.candidates).toMatchObject([{ id: page.candidateId, submitted: true }]);
    expect(f.count('error_item')).toBe(0);
    await page.finish();
    expect(f.count('error_item')).toBe(1);
    expect(f.count('material_inclusion_event')).toBe(1);
  });

  it('keeps a selected unfinished sibling pending when a partial extraction is persisted, then files it after retry', async () => {
    const f = await fixture();
    const page = await f.page();
    const sibling: Fragment = {
      ...page.fragment, fragmentId: newId('mfr'), number: '2', order: 1,
      box: { x: 0, y: .75, width: 1, height: .25 },
    };
    const selectedId = `${sibling.fragmentId}:1`;
    await page.publish('located', {}, [sibling]);
    expect((await f.select(page.assetId, [selectedId])).body).toMatchObject({ included: 0, pending: 1, skipped: 0 });
    await page.publish('enriching', { text: '1. 求 x 的值。', check: 'passed' }, [sibling]);
    const priorGate = page.gate();
    priorGate.reject(new PartialMaterialExtractionError(
      page.extraction({ text: '1. 求 x 的值。', check: 'passed' }),
      new MaterialProviderError('provider_unavailable', 'Synthetic second-question outage', true),
    ));
    await expect.poll(() => f.jobs.a.get(page.job.id)?.state).toBe('failed');
    expect(f.count('material_question')).toBe(1);
    expect(f.count('material_fragment')).toBe(1);
    expect(f.count('error_item')).toBe(0);
    const partial = (await f.intake('/reload/api')).photos[0]!;
    expect(partial.candidates).toHaveLength(2);
    expect(partial.candidates.find(candidate => candidate.id === selectedId)).toMatchObject({ submitted: true, status: 'needs_review' });
    const retry = await fetch(`${f.base}/s/api/intake/photos/${page.assetId}/retry`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: f.base }, body: JSON.stringify({ requestId: randomUUID() }),
    });
    expect(retry.status).toBe(200);
    await expect.poll(() => page.gate() !== priorGate).toBe(true);
    await page.publish('located', {}, [sibling]);
    expect((await f.intake()).photos[0]!.candidates.find(candidate => candidate.id === selectedId)?.submitted).toBe(true);
    await page.finish({}, [{ ...sibling, text: '2. 求 y 的值。', check: 'passed' }]);
    expect(f.count('material_question')).toBe(2);
    expect(f.count('error_item')).toBe(1);
    expect(f.count('material_inclusion_event')).toBe(1);
    expect(f.stores.a.listQuestions().find(question => question.number === '2')?.itemId).toBeTruthy();
    expect((await f.intake()).photos[0]!.candidates).toMatchObject([{ id: page.candidateId, status: 'verified' }]);
  });

  it.each([
    { name: 'unchecked stem', extra: { check: 'unchecked' as const } },
    { name: 'uncertain stem', extra: { check: 'low' as const, uncertainties: ['blurry'] } },
    { name: 'missing required diagram', extra: { check: 'passed' as const, requiresDiagram: true } },
  ])('does not file a selected $name even when a verified teacher cross arrives', async ({ extra }) => {
    const f = await fixture();
    const page = await f.page();
    await page.publish('located');
    expect((await f.select(page.assetId, [page.candidateId])).body).toMatchObject({ included: 0, pending: 1, skipped: 0 });
    const mark: Fragment = { ...page.fragment, fragmentId: newId('mfr'), role: 'teacher_mark', text: '×', check: 'passed', order: 1 };
    await page.finish(extra, [mark]);
    expect(f.count('material_question')).toBe(1);
    expect(f.count('error_item')).toBe(0);
    expect(f.count('material_item_link')).toBe(0);
    expect(f.count('material_inclusion')).toBe(0);
    expect((await f.intake()).photos[0]!.candidates).toMatchObject([{ id: page.candidateId, status: 'needs_review', submitted: true }]);
  });

  it('does not file a picked stem whose same-number continuation failed', async () => {
    const f = await fixture(); const page = await f.page();
    const continuation: Fragment = { ...page.fragment, fragmentId: newId('mfr'), order: 1, subpart: 'b' };
    await page.publish('located', {}, [continuation]);
    await f.select(page.assetId, [page.candidateId]);
    page.gate().reject(new PartialMaterialExtractionError(page.extraction({text:'已读出的半段题干',check:'passed'}), new MaterialProviderError('provider_unavailable','Synthetic failure',true)));
    await expect.poll(() => f.jobs.a.get(page.job.id)?.state).toBe('failed');
    expect(f.count('error_item')).toBe(0);
    expect((await f.intake()).photos[0]!.candidates[0]!.status).not.toBe('verified');
  });

  it('does not automatically file an intermediate stem before its low continuation is linked', async () => {
    const f = await fixture(); const page = await f.page();
    const mark: Fragment = {...page.fragment,fragmentId:'mfr_b',role:'teacher_mark',text:'×',check:'passed',order:1};
    const continuation: Fragment = {...page.fragment,fragmentId:'mfr_c',text:'看不清的条件',check:'low',order:2};
    // Deliberately no progressive callback: every provider must obey the final extraction gate.
    await page.finish({fragmentId:'mfr_a'}, [mark,continuation]);
    expect(f.count('error_item')).toBe(0);
  });

  it('does not file or mark verified a candidate with the wrong-subpart diagram', async () => {
    const f = await fixture(); const page = await f.page();
    const diagram: Fragment = {...page.fragment,fragmentId:newId('mfr'),role:'diagram',subpart:'b',text:'另一小问的图',check:'passed',order:1};
    await page.publish('located', {subpart:'a',requiresDiagram:true}, [diagram]);
    await f.select(page.assetId, [page.candidateId]);
    await page.finish({subpart:'a',requiresDiagram:true}, [diagram]);
    expect(f.count('error_item')).toBe(0);
    expect((await f.intake()).photos[0]!.candidates[0]!.status).toBe('needs_review');
  });

  it('withdraws abandoned previews without accepting new pending selections', async () => {
    const f = await fixture(); const page = await f.page(); await page.publish('located');
    f.db.prepare("UPDATE material_job SET state='failed',error=? WHERE id=?").run(JSON.stringify({code:'set_abandoned',retryable:false}),page.job.id);
    expect((await f.intake()).photos[0]!.candidates).toEqual([]);
    expect((await f.get(page.detail)).status).toBe(404);
    expect((await f.get(page.crop)).status).toBe(404);
    expect((await f.select(page.assetId,[page.candidateId])).body).toMatchObject({included:0,pending:0,skipped:1});
  });

  it.each(['revision', 'hash', 'terminal job'] as const)('rejects a preview after its %s changes, including later callbacks', async change => {
    const f = await fixture();
    const page = await f.page();
    await page.publish('enriching', { text: 'SYNTHETIC-STALE-PRIVATE' });
    expect((await f.intake()).photos[0]!.candidates).toHaveLength(1);
    if (change === 'revision') f.db.prepare('UPDATE material_asset SET revision=revision+1 WHERE id=?').run(page.assetId);
    else if (change === 'hash') f.db.prepare('UPDATE source_asset SET content_hash=? WHERE id=(SELECT source_asset_id FROM material_asset WHERE id=?)').run('replaced-source', page.assetId);
    else f.db.prepare("UPDATE material_job SET state='stale' WHERE id=?").run(page.job.id);
    await page.publish('enriching', { text: 'SYNTHETIC-STALE-PRIVATE', check: 'passed' }).catch(() => undefined);
    expect((await f.intake()).photos[0]!.candidates).toEqual([]);
    for (const url of [page.detail, page.crop]) {
      const response = await f.get(url);
      expect([404, 409]).toContain(response.status);
      expect(await response.text()).not.toContain('SYNTHETIC-STALE-PRIVATE');
    }
    expect(await f.select(page.assetId, [page.candidateId])).toMatchObject({ status: 200, body: { included: 0, pending: 0, skipped: 1 } });
    expect(Object.values(f.evidence())).toEqual(Array(8).fill(0));
  });

  it('isolates preview reads and selections by student and by photo, including final question IDs', async () => {
    const f = await fixture();
    const own = await f.page();
    const another = await f.page();
    const foreign = await f.page('b');
    await own.publish('located');
    await another.publish('located');
    await foreign.publish('enriching', { text: 'ONLY-STUDENT-B' });
    expect((await f.intake()).photos.map(photo => photo.id).sort()).toEqual([own.assetId, another.assetId].sort());
    expect((await f.intake('/other/api')).photos.map(photo => photo.id)).toEqual([foreign.assetId]);
    for (const url of [foreign.detail, foreign.crop]) {
      const response = await f.get(url);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('ONLY-STUDENT-B');
    }
    expect(await f.select(own.assetId, [foreign.candidateId])).toMatchObject({ status: 200, body: { included: 0, pending: 0, skipped: 1 } });
    expect(await f.select(another.assetId, [own.candidateId])).toMatchObject({ status: 200, body: { included: 0, pending: 0, skipped: 1 } });
    expect((await f.intake()).photos.flatMap(photo => photo.candidates).every(candidate => !candidate.submitted)).toBe(true);
    await own.finish();
    const question = f.stores.a.listQuestions().find(question => question.stem.some(fragment => fragment.assetId === own.assetId))!;
    expect(question.itemId).toBeNull();
    const finalId = `${question.id}:${question.revision}`;
    expect(await f.select(another.assetId, [finalId])).toMatchObject({ status: 200, body: { included: 0, pending: 0, skipped: 1 } });
    expect(f.count('error_item')).toBe(0);
    expect(await f.select(own.assetId, [finalId])).toMatchObject({ status: 200, body: { included: 1, pending: 0, skipped: 0 } });
    expect(f.count('error_item')).toBe(1);
  });
});
