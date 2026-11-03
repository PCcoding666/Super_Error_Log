import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { newId } from '../../src/db/connection.js';
import { migrateMaterials } from '../../src/materials/schema.js';
import { MaterialStore } from '../../src/materials/store.js';
import { MaterialJobs } from '../../src/materials/jobs.js';
import { MaterialUploads } from '../../src/materials/uploads.js';
import { extractMaterial } from '../../src/materials/extraction.js';
import { MobileRecognitionService } from '../../src/mobile/service.js';
import { MobileRecognitionStore } from '../../src/mobile/store.js';
import { AdmissionController } from '../../src/mobile/admission.js';
import type { CaptureHints, Extraction, Fragment } from '../../src/materials/contracts.js';
import type { MaterialPageImage } from '../../src/materials/provider.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(capacity = 4) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'multi-page-'));
  const db = new DatabaseSync(path.join(dir, 'app.db'));
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(SCHEMA_SQL);
  migrateMaterials(db);
  db.exec("INSERT INTO student_profile(id,nickname,created_at) VALUES ('student','Synthetic','2026-10-20')");
  const store = new MaterialStore(db, 'student');
  const captureId = store.createCapture(randomUUID()).id;
  const admission = new AdmissionController({ jobCapacity: capacity, diskProbe: async () => 10n ** 12n });
  const scheduler = new MobileRecognitionService(await MobileRecognitionStore.open(dir), { inventory: async () => ({ candidates: [], warnings: [], capacityReached: false }), recognizeQuestion: async () => { throw new Error('unused'); } });
  scheduler.useAdmission(admission);
  const jobs = new MaterialJobs(store, scheduler, admission);
  const uploads = new MaterialUploads(store, jobs, admission);
  await uploads.initialize();
  cleanups.push(async () => { await scheduler.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const jpeg = (color: string) => sharp({ create: { width: 32, height: 24, channels: 3, background: color } }).jpeg().toBuffer();
  return { dir, db, store, jobs, uploads, admission, captureId, jpeg };
}

function jobInput(db: DatabaseSync, id: string): Record<string, unknown> {
  return JSON.parse((db.prepare('SELECT input_json FROM material_job WHERE id=?').get(id) as { input_json: string }).input_json) as Record<string, unknown>;
}

describe('multi-page capture', () => {
  it('holds extract until every page of the set is saved, then treats the pages as one submission', async () => {
    const f = await fixture();
    const paperHints: CaptureHints = { captureMode: 'multi', pageIndex: 1, pageCount: 2, pageKind: 'paper' };
    const sheetHints: CaptureHints = { captureMode: 'multi', pageIndex: 2, pageCount: 2, pageKind: 'answer_sheet' };
    const paper = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'paper.jpg', bytes: await f.jpeg('#fff'), hints: paperHints });
    expect(jobInput(f.db, paper.job.id)).toEqual({ deferred: true });
    expect(paper.job.state).toBe('queued');
    expect(f.admission.tryAcquireJobCapacity().accepted).toBe(true); f.admission.releaseJobCapacity();
    await f.jobs.resume();
    expect(jobInput(f.db, paper.job.id)).toEqual({ deferred: true });
    const sheet = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'sheet.jpg', bytes: await f.jpeg('#111'), hints: sheetHints });
    expect(jobInput(f.db, paper.job.id)).toMatchObject({ setRole: 'lead' });
    expect(jobInput(f.db, paper.job.id).deferred).toBeUndefined();
    expect(jobInput(f.db, sheet.job.id)).toMatchObject({ setRole: 'follow' });
    const seen: string[][] = [];
    const provider = { extract: async (input: { assetId: string; hints: CaptureHints; pages?: MaterialPageImage[] }) => {
      seen.push((input.pages ?? []).map(page => page.assetId));
      const piece = (assetId: string, role: Fragment['role'], text: string): Extraction => {
        const sourceHash = f.uploads.source(assetId).sourceHash;
        const fragment: Fragment = { assetId, fragmentId: newId('mfr'), revision: 1, sourceHash, box: { x: 0, y: 0, width: 1, height: 1 }, role, text, number: '1', subpart: null, page: 1, order: 0, requiresDiagram: false, check: 'passed', uncertainties: [] };
        return { assetId, revision: 1, document: { title: null, subject: '数学', date: null, printedCode: null, page: 1 }, fragments: [fragment], warnings: [], runs: [] };
      };
      const lead = piece(paper.assetId, 'question', '1+1=?');
      const follow = piece(sheet.assetId, 'student_work', '2');
      return { ...lead, set: [lead, follow] };
    } };
    await extractMaterial(f.store, provider, paper.job.id, new AbortController().signal);
    expect(seen).toEqual([[paper.assetId, sheet.assetId]]);
    expect(f.jobs.get(sheet.job.id)?.state).toBe('succeeded');
    const questions = f.store.listQuestions();
    expect(questions).toHaveLength(1);
    expect(questions[0]!.documentId).toBe(`set_${f.captureId}`);
    expect(questions[0]!.stem.map(fragment => fragment.role)).toEqual(['question']);
    expect(questions[0]!.stem[0]!.text).toBe('1+1=?');
    expect(questions[0]!.attempts.flatMap(attempt => attempt.fragments).map(fragment => fragment.text)).toEqual(['2']);
    expect(questions[0]!.unresolved).toEqual([]);
  });

  it('keeps a repeated photo inside its own set instead of borrowing one from an older capture', async () => {
    const f = await fixture();
    const hints: CaptureHints = { captureMode: 'multi', pageIndex: 1, pageCount: 2, pageKind: 'paper' };
    const bytes = await f.jpeg('#abc');
    const older = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'old.jpg', bytes, hints });
    const fresh = f.store.createCapture(randomUUID()).id;
    const again = await f.uploads.save({ captureId: fresh, uploadId: randomUUID(), filename: 'again.jpg', bytes, hints });
    expect(again.assetId).not.toBe(older.assetId);
    expect(again.created).toBe(true);
    const sheet = await f.uploads.save({ captureId: fresh, uploadId: randomUUID(), filename: 'sheet.jpg', bytes: await f.jpeg('#def'), hints: { captureMode: 'multi', pageIndex: 2, pageCount: 2, pageKind: 'answer_sheet' } });
    expect(jobInput(f.db, again.job.id).setRole).toBe('lead');
    expect(jobInput(f.db, sheet.job.id).setRole).toBe('follow');
    const replay = await f.uploads.save({ captureId: fresh, uploadId: randomUUID(), filename: 'again.jpg', bytes, hints });
    expect(replay).toMatchObject({ assetId: again.assetId, duplicate: true, created: false });
  });

  it('rejects a duplicate page, a different page count, and a single page mixed into the set', async () => {
    const f = await fixture();
    const first = { captureMode: 'multi' as const, pageIndex: 1, pageCount: 2, pageKind: 'paper' as const };
    await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'a.jpg', bytes: await f.jpeg('#fff'), hints: first });
    await expect(f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'dup.jpg', bytes: await f.jpeg('#000'), hints: first })).rejects.toMatchObject({ status: 409, code: 'set_conflict' });
    await expect(f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'count.jpg', bytes: await f.jpeg('#111'), hints: { captureMode: 'multi', pageIndex: 2, pageCount: 3 } })).rejects.toMatchObject({ status: 409, code: 'set_conflict' });
    await expect(f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'single.jpg', bytes: await f.jpeg('#222'), hints: { captureMode: 'single' } })).rejects.toMatchObject({ status: 409, code: 'set_conflict' });
    await expect(f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'plain.jpg', bytes: await f.jpeg('#333'), hints: {} })).rejects.toMatchObject({ status: 409, code: 'set_conflict' });
    expect(f.db.prepare('SELECT count(*) n FROM material_asset').get()).toEqual({ n: 1 });
  });

  it('keeps the set when one page is rejected, then accepts the retry', async () => {
    const f = await fixture();
    const paper = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'paper.jpg', bytes: await f.jpeg('#fff'), hints: { captureMode: 'multi', pageIndex: 1, pageCount: 2 } });
    await expect(f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'bad.jpg', bytes: Buffer.alloc(0), hints: { captureMode: 'multi', pageIndex: 2, pageCount: 2 } })).rejects.toMatchObject({ status: 400 });
    expect(jobInput(f.db, paper.job.id).deferred).toBe(true);
    expect(f.db.prepare('SELECT count(*) n FROM material_asset').get()).toEqual({ n: 1 });
    const retry = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'sheet.jpg', bytes: await f.jpeg('#111'), hints: { captureMode: 'multi', pageIndex: 2, pageCount: 2 } });
    expect(jobInput(f.db, paper.job.id).deferred).toBeUndefined();
    expect(jobInput(f.db, retry.job.id).setRole).toBe('follow');
    expect(f.db.prepare('SELECT count(*) n FROM material_asset').get()).toEqual({ n: 2 });
  });

  it('does not hold a queue slot for an unfinished set, then releases the pages it has after the wait', async () => {
    const f = await fixture(1);
    const saved = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'paper.jpg', bytes: await f.jpeg('#fff'), hints: { captureMode: 'multi', pageIndex: 1, pageCount: 2 } });
    expect(f.admission.tryAcquireJobCapacity().accepted).toBe(true); f.admission.releaseJobCapacity();
    f.db.prepare("UPDATE material_asset SET created_at='2020-01-01 00:00:00' WHERE id=?").run(saved.assetId);
    f.jobs.releaseExpiredHolds();
    expect(jobInput(f.db, saved.job.id).deferred).toBeUndefined();
    expect(jobInput(f.db, saved.job.id).setRole).toBe('lead');
    expect(f.admission.tryAcquireJobCapacity().accepted).toBe(false);
  });

  it('abandons an unfinished set without taking a queue slot', async () => {
    const f = await fixture(1);
    const saved = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'paper.jpg', bytes: await f.jpeg('#fff'), hints: { captureMode: 'multi', pageIndex: 1, pageCount: 2 } });
    expect(f.jobs.abandonCapture(f.captureId)).toBe(1);
    expect(f.jobs.get(saved.job.id)).toMatchObject({ state: 'failed' });
    expect(f.admission.tryAcquireJobCapacity().accepted).toBe(true); f.admission.releaseJobCapacity();
    f.jobs.releaseExpiredHolds();
    expect(f.jobs.get(saved.job.id)?.state).toBe('failed');
  });

  it('recovers an unfinished set after restart without occupying a slot until it expires', async () => {
    const f = await fixture(1);
    const saved = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'paper.jpg', bytes: await f.jpeg('#fff'), hints: { captureMode: 'multi', pageIndex: 1, pageCount: 2 } });
    await f.jobs.stop();
    const scheduler = new MobileRecognitionService(await MobileRecognitionStore.open(f.dir), { inventory: async () => ({ candidates: [], warnings: [], capacityReached: false }), recognizeQuestion: async () => { throw new Error('unused'); } });
    const admission = new AdmissionController({ jobCapacity: 1, diskProbe: async () => 10n ** 12n });
    scheduler.useAdmission(admission);
    const restarted = new MaterialJobs(f.store, scheduler, admission);
    cleanups.push(async () => { await scheduler.stop(); });
    await restarted.resume();
    expect(jobInput(f.db, saved.job.id).deferred).toBe(true);
    expect(admission.tryAcquireJobCapacity().accepted).toBe(true); admission.releaseJobCapacity();
    f.db.prepare("UPDATE material_asset SET created_at='2020-01-01 00:00:00' WHERE id=?").run(saved.assetId);
    await restarted.resume();
    expect(jobInput(f.db, saved.job.id).setRole).toBe('lead');
    expect(jobInput(f.db, saved.job.id).deferred).toBeUndefined();
    expect(admission.tryAcquireJobCapacity().accepted).toBe(false);
  });
});
