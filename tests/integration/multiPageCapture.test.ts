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

async function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'multi-page-'));
  const db = new DatabaseSync(path.join(dir, 'app.db'));
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(SCHEMA_SQL);
  migrateMaterials(db);
  db.exec("INSERT INTO student_profile(id,nickname,created_at) VALUES ('student','Synthetic','2026-10-20')");
  const store = new MaterialStore(db, 'student');
  const captureId = store.createCapture(randomUUID()).id;
  const admission = new AdmissionController({ jobCapacity: 4, diskProbe: async () => 10n ** 12n });
  const scheduler = new MobileRecognitionService(await MobileRecognitionStore.open(dir), { inventory: async () => ({ candidates: [], warnings: [], capacityReached: false }), recognizeQuestion: async () => { throw new Error('unused'); } });
  scheduler.useAdmission(admission);
  const jobs = new MaterialJobs(store, scheduler, admission);
  const uploads = new MaterialUploads(store, jobs, admission);
  await uploads.initialize();
  cleanups.push(async () => { await scheduler.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const jpeg = (color: string) => sharp({ create: { width: 32, height: 24, channels: 3, background: color } }).jpeg().toBuffer();
  return { db, store, jobs, uploads, captureId, jpeg };
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
    await f.jobs.resume();
    expect(jobInput(f.db, paper.job.id)).toEqual({ deferred: true });
    const sheet = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'sheet.jpg', bytes: await f.jpeg('#111'), hints: sheetHints });
    expect(jobInput(f.db, paper.job.id)).toEqual({});
    expect(jobInput(f.db, sheet.job.id)).toEqual({});
    const seen: string[][] = [];
    const provider = { extract: async (input: { assetId: string; hints: CaptureHints; pages?: MaterialPageImage[] }) => {
      seen.push((input.pages ?? []).map(page => page.assetId));
      const sourceHash = f.uploads.source(input.assetId).sourceHash;
      const role = input.hints.pageKind === 'answer_sheet' ? 'student_work' as const : 'question' as const;
      const fragment: Fragment = { assetId: input.assetId, fragmentId: newId('mfr'), revision: 1, sourceHash, box: { x: 0, y: 0, width: 1, height: 1 }, role, text: role === 'question' ? '1+1=?' : '2', number: '1', subpart: null, page: 1, order: 0, requiresDiagram: false, check: 'passed', uncertainties: [] };
      const extraction: Extraction = { assetId: input.assetId, revision: 1, document: { title: null, subject: '数学', date: null, printedCode: null, page: input.hints.pageIndex ?? 1 }, fragments: [fragment], warnings: [], runs: [] };
      return extraction;
    } };
    await extractMaterial(f.store, provider, paper.job.id, new AbortController().signal);
    await extractMaterial(f.store, provider, sheet.job.id, new AbortController().signal);
    expect(seen).toEqual([[paper.assetId, sheet.assetId], [paper.assetId, sheet.assetId]]);
    const questions = f.store.listQuestions();
    expect(questions).toHaveLength(1);
    expect(questions[0]!.documentId).toBe(`set_${f.captureId}`);
    expect(questions[0]!.stem.map(fragment => fragment.role)).toEqual(['question']);
    expect(questions[0]!.stem[0]!.text).toBe('1+1=?');
    expect(questions[0]!.attempts.flatMap(attempt => attempt.fragments).map(fragment => fragment.text)).toEqual(['2']);
    expect(questions[0]!.unresolved).toEqual([]);
  });
});
