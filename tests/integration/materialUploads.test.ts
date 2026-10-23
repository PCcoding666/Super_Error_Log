import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { migrateMaterials } from '../../src/materials/schema.js';
import { MaterialStore } from '../../src/materials/store.js';
import { MaterialJobs } from '../../src/materials/jobs.js';
import { MaterialUploads } from '../../src/materials/uploads.js';
import { MobileRecognitionService } from '../../src/mobile/service.js';
import { MobileRecognitionStore } from '../../src/mobile/store.js';
import { AdmissionController } from '../../src/mobile/admission.js';
import { acquireUploadAdmission, releaseUploadAdmission, type AdmissionReserve } from '../../src/mobile/router.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(capacity = 2) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'material-uploads-'));
  const db = new DatabaseSync(path.join(dir, 'app.db')); db.exec('PRAGMA foreign_keys=ON'); db.exec(SCHEMA_SQL); migrateMaterials(db);
  db.exec("INSERT INTO student_profile(id,nickname,created_at) VALUES ('student','Synthetic','2026-10-20')");
  const store = new MaterialStore(db, 'student'); const captureId = store.createCapture(randomUUID()).id;
  const admission = new AdmissionController({ jobCapacity: capacity, diskProbe: async () => 10n ** 12n });
  const scheduler = new MobileRecognitionService(await MobileRecognitionStore.open(dir), { inventory: async () => ({ candidates: [], warnings: [], capacityReached: false }), recognizeQuestion: async () => { throw new Error('unused'); } });
  scheduler.useAdmission(admission); const jobs = new MaterialJobs(store, scheduler, admission); const uploads = new MaterialUploads(store, jobs, admission);
  cleanups.push(async () => { await scheduler.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const bytes = await sharp({ create: { width: 24, height: 16, channels: 3, background: '#fff' } }).jpeg().toBuffer();
  const input = { captureId, uploadId: randomUUID(), filename: 'synthetic.jpg', bytes, hints: {} };
  return { dir, db, store, admission, scheduler, jobs, uploads, input };
}
describe('durable material uploads', () => {
  it('replays a committed upload after its response is lost', async () => {
    const f = await fixture(1); const first = await f.uploads.save(f.input);
    const retry = await f.uploads.save(f.input);
    expect(retry.assetId).toBe(first.assetId); expect(retry.job.id).toBe(first.job.id); expect(retry.created).toBe(false);
    expect(f.db.prepare('SELECT count(*) n FROM material_asset').get()).toEqual({ n: 1 });
    expect(f.db.prepare('SELECT count(*) n FROM material_job').get()).toEqual({ n: 1 });
    const source = f.uploads.source(first.assetId);
    expect(readFileSync(source.originalPath)).toEqual(f.input.bytes);
    expect((await sharp(readFileSync(source.normalizedPath)).metadata()).format).toBe('jpeg');
    expect(await f.scheduler.listJobs()).toEqual([]);
  });
  it('rejects same-key different bytes or context with 409 without creating a second material', async () => {
    const f = await fixture(); await f.uploads.save(f.input);
    const changed = await sharp({ create: { width: 24, height: 16, channels: 3, background: '#000' } }).jpeg().toBuffer();
    await expect(f.uploads.save({ ...f.input, bytes: changed })).rejects.toMatchObject({ status: 409 });
    await expect(f.uploads.save({ ...f.input, hints: { label: 'edited' } })).rejects.toMatchObject({ status: 409 });
    expect(f.db.prepare('SELECT count(*) n FROM material_asset').get()).toEqual({ n: 1 });
  });
  it('keeps an immutable original fingerprint after mutable hints and document context change', async () => {
    const f = await fixture();
    const questionId = f.store.createQuestion().id, attemptId = f.store.createAttempt(questionId).id;
    const input = { ...f.input, hints: { label: 'original', questionId, attemptId } };
    const first = await f.uploads.save(input);
    const row = f.db.prepare('SELECT upload_request_fingerprint FROM material_asset WHERE id=?').get(first.assetId) as { upload_request_fingerprint: string };
    expect(row.upload_request_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(() => f.db.prepare('UPDATE material_asset SET upload_request_fingerprint=? WHERE id=?').run('changed', first.assetId)).toThrow(/immutable/);
    f.db.prepare('UPDATE material_asset SET hints_json=? WHERE id=?').run(JSON.stringify({ label: 'edited' }), first.assetId);
    const retry = await f.uploads.save({ ...input, hints: { attemptId, questionId, label: 'original' } });
    expect(retry).toMatchObject({ assetId: first.assetId, job: { id: first.job.id }, created: false });
    expect(f.db.prepare('SELECT hints_json FROM material_asset WHERE id=?').get(first.assetId)).toEqual({ hints_json: '{"label":"edited"}' });
    const changed = await sharp({ create: { width: 24, height: 16, channels: 3, background: '#000' } }).jpeg().toBuffer();
    for (const different of [{ ...input, bytes: changed }, { ...input, captureId: f.store.createCapture(randomUUID()).id }, { ...input, hints: { label: 'edited' } }, { ...input, hints: { ...input.hints, attemptId: f.store.createAttempt(questionId).id } }]) {
      await expect(f.uploads.save(different)).rejects.toMatchObject({ status: 409, code: 'idempotency_conflict' });
    }
    expect(f.db.prepare('SELECT count(*) n FROM material_asset').get()).toEqual({ n: 1 });
    expect(f.db.prepare('SELECT count(*) n FROM material_job').get()).toEqual({ n: 1 });
  });
  it('migrates pre-fingerprint uploads without inventing identity from edited hints', async () => {
    const f = await fixture(); const saved = await f.uploads.save(f.input);
    // Recreate the exact old-schema boundary, where no historical original hints were stored.
    f.db.exec('DROP TRIGGER IF EXISTS material_upload_fingerprint_immutable; ALTER TABLE material_asset DROP COLUMN upload_request_fingerprint');
    f.db.prepare('UPDATE material_asset SET hints_json=? WHERE id=?').run('{"label":"already edited"}', saved.assetId);
    migrateMaterials(f.db); migrateMaterials(f.db);
    expect(f.db.prepare('SELECT upload_request_fingerprint,hints_json FROM material_asset').get()).toEqual({ upload_request_fingerprint: null, hints_json: '{"label":"already edited"}' });
    await expect(f.uploads.save(f.input)).rejects.toMatchObject({ status: 409, code: 'upload_identity_unavailable', message: expect.stringContaining('已保留在服务器') });
    await expect(f.uploads.save({ ...f.input, hints: { label: 'already edited' } })).rejects.toMatchObject({ status: 409, code: 'upload_identity_unavailable' });
    expect(readFileSync(f.uploads.source(saved.assetId).originalPath)).toEqual(f.input.bytes);
    expect(f.db.prepare('SELECT count(*) n FROM material_job').get()).toEqual({ n: 1 });
    expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it('deduplicates physical files but preserves explicitly separate uploads and attempts', async () => {
    const f = await fixture(); const first = await f.uploads.save(f.input);
    const question = f.store.createQuestion().id; const attempt = f.store.createAttempt(question).id;
    const second = await f.uploads.save({ ...f.input, uploadId: randomUUID(), hints: { questionId: question, attemptId: attempt } });
    expect(first.assetId).not.toBe(second.assetId);
    expect(f.uploads.source(first.assetId).originalPath).toBe(f.uploads.source(second.assetId).originalPath);
  });
  it('hands admission over only after commit and leaves replay reservations to finally', async () => {
    const f = await fixture(); const reserve: AdmissionReserve = { slot: false, capacity: false, handoff: false };
    expect(await acquireUploadAdmission(f.admission, reserve)).toBeNull();
    await f.uploads.save(f.input, reserve); expect(reserve.handoff).toBe(true); releaseUploadAdmission(f.admission, reserve);
    const replay: AdmissionReserve = { slot: false, capacity: false, handoff: false };
    expect(await acquireUploadAdmission(f.admission, replay)).toBeNull(); await f.uploads.save(f.input, replay);
    expect(replay.handoff).toBe(false); releaseUploadAdmission(f.admission, replay);
    expect(f.admission.tryAcquireJobCapacity().accepted).toBe(true); f.admission.releaseJobCapacity();
  });
  it('rejects full capacity with retryable 429 before creating files or rows', async () => {
    const f = await fixture(1); await f.uploads.save(f.input);
    // Different bytes: an identical photo is a duplicate and needs no new capacity (P1-1).
    const other = await sharp({ create: { width: 24, height: 16, channels: 3, background: '#000' } }).jpeg().toBuffer();
    await expect(f.uploads.save({ ...f.input, uploadId: randomUUID(), bytes: other })).rejects.toMatchObject({ status: 429, code: 'capacity_full' });
    expect(f.db.prepare('SELECT count(*) n FROM source_asset').get()).toEqual({ n: 1 });
  });
  it('publishes both files atomically before committing the saved material and job', async () => {
    const f = await fixture(); const rename = fs.rename.bind(fs); let release!: () => void; let entered = false;
    const blocked = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from).startsWith(f.uploads.directory)) { entered = true; await new Promise<void>(resolve => { release = resolve; }); }
      return rename(from, to);
    });
    const reserve: AdmissionReserve = { slot: false, capacity: false, handoff: false }; await acquireUploadAdmission(f.admission, reserve);
    const saving = f.uploads.save(f.input, reserve);
    try {
      await expect.poll(() => entered).toBe(true);
      expect(f.db.prepare('SELECT count(*) n FROM material_asset').get()).toEqual({ n: 0 });
      expect(f.db.prepare('SELECT count(*) n FROM material_job').get()).toEqual({ n: 0 }); expect(reserve.handoff).toBe(false);
      const staging = readdirSync(f.uploads.directory)[0]!;
      expect(staging.startsWith('.tmp-')).toBe(true); expect(readdirSync(path.join(f.uploads.directory, staging)).sort()).toEqual(['normalized.jpg', 'original']);
    } finally { release?.(); blocked.mockRestore(); }
    const saved = await saving; releaseUploadAdmission(f.admission, reserve);
    expect(reserve.handoff).toBe(true); expect(f.jobs.get(saved.job.id)?.state).toBe('queued');
    expect(readdirSync(f.uploads.directory).some(name => name.startsWith('.tmp-'))).toBe(false);
  });
  it('rolls back file and database creation on job persistence failure without handoff', async () => {
    const f = await fixture(); const reserve: AdmissionReserve = { slot: false, capacity: false, handoff: false };
    await acquireUploadAdmission(f.admission, reserve);
    f.db.exec("CREATE TRIGGER reject_job BEFORE INSERT ON material_job BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END");
    await expect(f.uploads.save(f.input, reserve)).rejects.toMatchObject({ status: 503 });
    expect(reserve.handoff).toBe(false); releaseUploadAdmission(f.admission, reserve);
    expect(f.db.prepare('SELECT count(*) n FROM material_asset').get()).toEqual({ n: 0 });
    expect(f.db.prepare('SELECT count(*) n FROM source_asset').get()).toEqual({ n: 0 });
    expect(readdirSync(f.uploads.directory)).toEqual([]);
    expect(await f.admission.accepting()).toBe(true);
  });
  it('normalizes within 4096 pixels while preserving the uploaded original', async () => {
    const f = await fixture();
    const bytes = await sharp({ create: { width: 5000, height: 12, channels: 3, background: '#fff' } }).jpeg().toBuffer();
    const result = await f.uploads.save({ ...f.input, bytes }); const source = f.uploads.source(result.assetId);
    expect(readFileSync(source.originalPath)).toEqual(bytes);
    const metadata = await sharp(readFileSync(source.normalizedPath)).metadata();
    expect(metadata.width).toBe(4096);
  });
  it('startup removes incomplete staging files and preserves committed originals', async () => {
    const f = await fixture(); const saved = await f.uploads.save(f.input); const source = f.uploads.source(saved.assetId);
    const staging = path.join(f.uploads.directory, `.tmp-${randomUUID()}`); mkdirSync(staging); writeFileSync(path.join(staging, 'original'), 'partial');
    await f.uploads.initialize();
    expect(existsSync(staging)).toBe(false); expect(readFileSync(source.originalPath)).toEqual(f.input.bytes);
    expect((await f.uploads.save(f.input)).job.id).toBe(saved.job.id);
  });
  it('rejects corrupt and oversized images without claiming that they were saved', async () => {
    const f = await fixture();
    await expect(f.uploads.save({ ...f.input, bytes: Buffer.from('bad image') })).rejects.toMatchObject({ status: 400, code: 'invalid_image' });
    await expect(f.uploads.save({ ...f.input, bytes: Buffer.alloc(15 * 1024 * 1024 + 1) })).rejects.toMatchObject({ status: 413 });
    expect(f.db.prepare('SELECT count(*) n FROM material_asset').get()).toEqual({ n: 0 });
  });
  it('P1-1: byte-identical re-upload by the same student reuses the saved photo and never starts a second AI job', async () => {
    const f = await fixture(); const first = await f.uploads.save(f.input);
    const again = await f.uploads.save({ ...f.input, uploadId: randomUUID(), captureId: f.store.createCapture(randomUUID()).id, filename: 'again.jpg' });
    expect(again).toMatchObject({ assetId: first.assetId, job: { id: first.job.id, kind: 'extract' }, created: false, duplicate: true });
    // Replaying the duplicate's own (unrecorded) upload ID stays idempotent.
    const replay = await f.uploads.save({ ...f.input, uploadId: randomUUID() });
    expect(replay).toMatchObject({ assetId: first.assetId, duplicate: true });
    expect(f.db.prepare('SELECT count(*) n FROM material_asset').get()).toEqual({ n: 1 });
    expect(f.db.prepare('SELECT count(*) n FROM source_asset').get()).toEqual({ n: 1 });
    expect(f.db.prepare("SELECT count(*) n FROM material_job WHERE kind='extract'").get()).toEqual({ n: 1 });
    const other = await sharp({ create: { width: 24, height: 16, channels: 3, background: '#000' } }).jpeg().toBuffer();
    const retake = await f.uploads.save({ ...f.input, uploadId: randomUUID(), bytes: other });
    expect(retake.created).toBe(true); expect(retake.duplicate).toBeUndefined();
    expect(f.db.prepare("SELECT count(*) n FROM material_job WHERE kind='extract'").get()).toEqual({ n: 2 });
  });
  it('P1-1: content dedup is per student; another student with the same bytes gets their own copy', async () => {
    const a = await fixture(); const b = await fixture();
    await a.uploads.save(a.input);
    const saved = await b.uploads.save({ ...b.input, bytes: a.input.bytes });
    expect(saved.created).toBe(true); expect(saved.duplicate).toBeUndefined();
    expect(b.db.prepare('SELECT count(*) n FROM material_asset').get()).toEqual({ n: 1 });
  });
  it('P1-1: the same bytes with different role, marking, label or document hints stay a separate material and are processed', async () => {
    const f = await fixture(10); const first = await f.uploads.save({ ...f.input, hints: { roles: ['question'], label: '第一次' } });
    const same = await f.uploads.save({ ...f.input, uploadId: randomUUID(), hints: { label: '第一次', roles: ['question'] } });
    expect(same).toMatchObject({ assetId: first.assetId, duplicate: true });
    const documentId = (f.db.prepare("INSERT INTO material_document(id,owner_id) VALUES ('mdoc_synthetic','student') RETURNING id").get() as { id: string }).id;
    for (const hints of [{ roles: ['reference_answer'], label: '第一次' }, { roles: ['question'], label: '第一次', marking: 'unmarked' }, { roles: ['question'], label: '另一个备注' }, { roles: ['question'], label: '第一次', documentId }, {}]) {
      const saved = await f.uploads.save({ ...f.input, uploadId: randomUUID(), hints: hints as never });
      expect(saved.created).toBe(true); expect(saved.duplicate).toBeUndefined(); expect(saved.assetId).not.toBe(first.assetId);
      expect(JSON.parse((f.db.prepare('SELECT hints_json FROM material_asset WHERE id=?').get(saved.assetId) as { hints_json: string }).hints_json)).toEqual(hints);
    }
    expect(f.db.prepare("SELECT count(*) n FROM material_job WHERE kind='extract'").get()).toEqual({ n: 6 });
  });
});
