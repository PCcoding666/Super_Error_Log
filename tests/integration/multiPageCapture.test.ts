import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import sharp from 'sharp';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { newId } from '../../src/db/connection.js';
import { migrateMaterials } from '../../src/materials/schema.js';
import { MaterialStore } from '../../src/materials/store.js';
import { MaterialJobs } from '../../src/materials/jobs.js';
import { MaterialUploads } from '../../src/materials/uploads.js';
import { extractMaterial } from '../../src/materials/extraction.js';
import { dismissPreviewCandidates, readIntakeProgress, selectPreviewCandidates } from '../../src/materials/intakeProgress.js';
import { MobileRecognitionService } from '../../src/mobile/service.js';
import { MobileRecognitionStore } from '../../src/mobile/store.js';
import { AdmissionController } from '../../src/mobile/admission.js';
import { createMaterialsRouter } from '../../src/web/materialsRouter.js';
import type { CaptureHints, Extraction, Fragment } from '../../src/materials/contracts.js';
import { MaterialProviderError, PartialMaterialExtractionError, type ExtractedMaterial, type MaterialPageImage } from '../../src/materials/provider.js';

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
function jobError(db: DatabaseSync, id: string): { code?: string; retryable?: boolean } | null {
  const row = db.prepare('SELECT error FROM material_job WHERE id=?').get(id) as { error: string | null };
  return row.error ? JSON.parse(row.error) as { code?: string; retryable?: boolean } : null;
}
function storedExtraction(db: DatabaseSync, assetId: string): string | null {
  return (db.prepare('SELECT extraction_json FROM material_asset WHERE id=?').get(assetId) as { extraction_json: string | null }).extraction_json;
}
function pageExtraction(uploads: MaterialUploads, assetId: string, role: Fragment['role'], text: string): Extraction {
  const sourceHash = uploads.source(assetId).sourceHash;
  const fragment: Fragment = { assetId, fragmentId: newId('mfr'), revision: 1, sourceHash, box: { x: 0, y: 0, width: 1, height: 1 }, role, text, number: '1', subpart: null, page: 1, order: 0, requiresDiagram: false, check: 'passed', uncertainties: [] };
  return { assetId, revision: 1, document: { title: null, subject: '数学', date: null, printedCode: null, page: 1 }, fragments: [fragment], warnings: [], runs: [] };
}

describe('multi-page capture', () => {
  it.each(['low', 'passed'] as const)('waits for the whole bundle before filing a saved selection with a %s diagram on a later page', async check => {
    const f = await fixture();
    const paper = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'paper.jpg', bytes: await f.jpeg('#fff'), hints: { captureMode: 'multi', pageIndex: 1, pageCount: 2, pageKind: 'paper' } });
    const sheet = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'diagram.jpg', bytes: await f.jpeg('#111'), hints: { captureMode: 'multi', pageIndex: 2, pageCount: 2, pageKind: 'paper' } });
    const lead = pageExtraction(f.uploads, paper.assetId, 'question', '1. 求图中角的大小。');
    const follow = pageExtraction(f.uploads, sheet.assetId, 'diagram', '同题的图');
    follow.fragments[0]!.check = check;
    await extractMaterial(f.store, { extract: async input => {
      await input.onProgress?.({ extraction: lead, phase: 'located' });
      expect(selectPreviewCandidates(f.store, paper.assetId, [{ questionId: lead.fragments[0]!.fragmentId, revision: 1 }])).toEqual({ included: 0, pending: 1, skipped: 0 });
      return { ...lead, set: [lead, follow] };
    } }, paper.job.id, new AbortController().signal);
    const questions = f.store.listQuestions();
    expect(questions).toHaveLength(1);
    expect(questions[0]!.stem.map(fragment => fragment.role).sort()).toEqual(['diagram', 'question']);
    const included = check === 'passed' ? 1 : 0;
    expect(f.db.prepare('SELECT count(*) n FROM material_inclusion').get()).toEqual({ n: included });
    expect(f.db.prepare('SELECT count(*) n FROM error_item').get()).toEqual({ n: included });
  });

  it('dismissing a preview selection removes it and does not file it when extraction finishes', async () => {
    const f = await fixture();
    const paper = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'paper.jpg', bytes: await f.jpeg('#fff'), hints: { captureMode: 'single' } });
    const lead = pageExtraction(f.uploads, paper.assetId, 'question', '1. DROP-PREVIEW 求 x。');
    const fragmentId = lead.fragments[0]!.fragmentId;
    await extractMaterial(f.store, { extract: async input => {
      await input.onProgress?.({ extraction: lead, phase: 'located' });
      expect(selectPreviewCandidates(f.store, paper.assetId, [{ questionId: fragmentId, revision: 1 }])).toEqual({ included: 0, pending: 1, skipped: 0 });
      expect(dismissPreviewCandidates(f.store, paper.assetId, [{ questionId: fragmentId, revision: 1 }])).toEqual({ dismissed: [fragmentId], skipped: [] });
      expect(selectPreviewCandidates(f.store, paper.assetId, [{ questionId: fragmentId, revision: 1 }])).toEqual({ included: 0, pending: 0, skipped: 1 });
      return lead;
    } }, paper.job.id, new AbortController().signal);
    const questions = f.store.listQuestions();
    expect(questions).toHaveLength(1);
    expect(questions[0]!.itemId).toBeNull();
    expect(f.db.prepare('SELECT count(*) n FROM error_item').get()).toEqual({ n: 0 });
  });

  it('files a located question when extraction later finds a cross and the student did not dismiss it', async () => {
    const f = await fixture();
    const paper = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'paper.jpg', bytes: await f.jpeg('#fff'), hints: { captureMode: 'single' } });
    const lead = pageExtraction(f.uploads, paper.assetId, 'question', '1. KEEP-MARK 求 x。');
    const marked = { ...lead, fragments: [lead.fragments[0]!, { ...lead.fragments[0]!, fragmentId: newId('mfr'), role: 'teacher_mark' as const, text: '×', order: 1 }] };
    await extractMaterial(f.store, { extract: async input => {
      await input.onProgress?.({ extraction: lead, phase: 'located' });
      expect(f.store.listQuestions()).toHaveLength(0);
      return marked;
    } }, paper.job.id, new AbortController().signal);
    expect(f.store.listQuestions()).toHaveLength(1);
    expect(f.store.listQuestions()[0]!.itemId).toBeTruthy();
    expect(f.db.prepare('SELECT count(*) n FROM error_item').get()).toEqual({ n: 1 });
  });

  it('does not auto-file a preview dismissed before its question existed, even after a later cross', async () => {
    const f = await fixture();
    const paper = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'paper.jpg', bytes: await f.jpeg('#eee'), hints: { captureMode: 'single' } });
    const lead = pageExtraction(f.uploads, paper.assetId, 'question', '1. DROP-MARK 求 x。');
    const fragmentId = lead.fragments[0]!.fragmentId;
    const marked = { ...lead, fragments: [lead.fragments[0]!, { ...lead.fragments[0]!, fragmentId: newId('mfr'), role: 'teacher_mark' as const, text: '×', order: 1 }] };
    await extractMaterial(f.store, { extract: async input => {
      await input.onProgress?.({ extraction: lead, phase: 'located' });
      expect(f.store.listQuestions()).toHaveLength(0);
      expect(dismissPreviewCandidates(f.store, paper.assetId, [{ questionId: fragmentId, revision: 1 }])).toEqual({ dismissed: [fragmentId], skipped: [] });
      expect((f.db.prepare('SELECT count(*) n FROM material_inclusion').get() as { n: number }).n).toBe(0);
      return marked;
    } }, paper.job.id, new AbortController().signal);
    const questions = f.store.listQuestions();
    expect(questions).toHaveLength(1);
    expect(questions[0]!.teacherMarks.map(mark => mark.text)).toEqual(['×']);
    expect(questions[0]!.itemId).toBeNull();
    expect(f.db.prepare('SELECT count(*) n FROM error_item').get()).toEqual({ n: 0 });
    expect(f.db.prepare('SELECT included FROM material_inclusion WHERE owner_id=? AND question_id=?').get(f.store.studentId, questions[0]!.id)).toEqual({ included: 0 });
    expect(readIntakeProgress(f.store).get(paper.assetId)?.dismissed).toContain(fragmentId);
    expect(f.store.getQuestion(questions[0]!.id)!.itemId).toBeNull();
  });

  it('records exclusion when the question already exists, and does not remove one that is already filed', async () => {
    const f = await fixture();
    const openCapture = f.store.createCapture(randomUUID()).id;
    const filedCapture = f.store.createCapture(randomUUID()).id;
    const openPaper = await f.uploads.save({ captureId: openCapture, uploadId: randomUUID(), filename: 'open.jpg', bytes: await f.jpeg('#abc'), hints: { captureMode: 'single' } });
    const filedPaper = await f.uploads.save({ captureId: filedCapture, uploadId: randomUUID(), filename: 'filed.jpg', bytes: await f.jpeg('#cba'), hints: { captureMode: 'single' } });
    const openLead = pageExtraction(f.uploads, openPaper.assetId, 'question', '1. OPEN-Q 求 a。');
    const filedLead = pageExtraction(f.uploads, filedPaper.assetId, 'question', '1. FILED-Q 求 b。');
    const filedMarked = { ...filedLead, fragments: [filedLead.fragments[0]!, { ...filedLead.fragments[0]!, fragmentId: newId('mfr'), role: 'teacher_mark' as const, text: '×', order: 1 }] };
    await extractMaterial(f.store, { extract: async input => { await input.onProgress?.({ extraction: openLead, phase: 'located' }); return openLead; } }, openPaper.job.id, new AbortController().signal);
    await extractMaterial(f.store, { extract: async input => { await input.onProgress?.({ extraction: filedLead, phase: 'located' }); return filedMarked; } }, filedPaper.job.id, new AbortController().signal);
    const openQuestion = f.store.listQuestions().find(question => question.stem.some(fragment => fragment.text.includes('OPEN-Q')))!;
    const filedQuestion = f.store.listQuestions().find(question => question.stem.some(fragment => fragment.text.includes('FILED-Q')))!;
    expect(openQuestion.itemId).toBeNull();
    expect(filedQuestion.itemId).toBeTruthy();
    const openFragment = openQuestion.stem.find(fragment => fragment.role === 'question')!.fragmentId;
    const filedFragment = filedQuestion.stem.find(fragment => fragment.role === 'question')!.fragmentId;
    expect(dismissPreviewCandidates(f.store, openPaper.assetId, [{ questionId: openFragment, revision: 1 }])).toEqual({ dismissed: [openFragment], skipped: [] });
    expect(f.db.prepare('SELECT included FROM material_inclusion WHERE owner_id=? AND question_id=?').get(f.store.studentId, openQuestion.id)).toEqual({ included: 0 });
    expect(f.store.getQuestion(openQuestion.id)!.itemId).toBeNull();
    const kept = filedQuestion.itemId;
    expect(dismissPreviewCandidates(f.store, filedPaper.assetId, [{ questionId: filedFragment, revision: 1 }])).toEqual({ dismissed: [], skipped: [filedFragment] });
    expect(f.store.getQuestion(filedQuestion.id)!.itemId).toBe(kept);
    expect(f.db.prepare('SELECT count(*) n FROM error_item').get()).toEqual({ n: 1 });
  });

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

  it('settles the other pages when the first page fails, including a partial result', async () => {
    const f = await fixture();
    const paper = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'paper.jpg', bytes: await f.jpeg('#fff'), hints: { captureMode: 'multi', pageIndex: 1, pageCount: 2, pageKind: 'paper' } });
    const sheet = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'sheet.jpg', bytes: await f.jpeg('#111'), hints: { captureMode: 'multi', pageIndex: 2, pageCount: 2, pageKind: 'answer_sheet' } });
    await expect(extractMaterial(f.store, { extract: async () => { throw new MaterialProviderError('provider_down', '模型没有返回。', true); } }, paper.job.id, new AbortController().signal)).rejects.toMatchObject({ code: 'provider_down' });
    expect(f.jobs.get(sheet.job.id)?.state).toBe('failed');
    expect(jobError(f.db, sheet.job.id)).toMatchObject({ code: 'set_page_missing', retryable: true });
    expect(storedExtraction(f.db, paper.assetId)).toBeNull();
    expect(storedExtraction(f.db, sheet.assetId)).toBeNull();
    expect(f.db.prepare('SELECT count(*) n FROM material_asset').get()).toEqual({ n: 2 });
    const again = f.store.createCapture(randomUUID()).id;
    const lead = await f.uploads.save({ captureId: again, uploadId: randomUUID(), filename: 'paper.jpg', bytes: await f.jpeg('#222'), hints: { captureMode: 'multi', pageIndex: 1, pageCount: 2 } });
    const omitted = await f.uploads.save({ captureId: again, uploadId: randomUUID(), filename: 'sheet.jpg', bytes: await f.jpeg('#333'), hints: { captureMode: 'multi', pageIndex: 2, pageCount: 2 } });
    const partialLead = pageExtraction(f.uploads, lead.assetId, 'question', '1+1=?');
    const partialResult: ExtractedMaterial = { ...partialLead, set: [partialLead] };
    await expect(extractMaterial(f.store, { extract: async () => { throw new PartialMaterialExtractionError(partialResult, new MaterialProviderError('fragment_unavailable', '有一块没读出来。', true)); } }, lead.job.id, new AbortController().signal)).rejects.toMatchObject({ code: 'fragment_unavailable' });
    expect(storedExtraction(f.db, lead.assetId)).toContain('1+1=?');
    expect(storedExtraction(f.db, omitted.assetId)).toBeNull();
    expect(f.jobs.get(omitted.job.id)?.state).toBe('failed');
    expect(jobError(f.db, omitted.job.id)).toMatchObject({ code: 'set_page_missing', retryable: true });
    expect(f.db.prepare('SELECT count(*) n FROM material_asset').get()).toEqual({ n: 4 });
  });

  it('marks a page the model left out as failed and retryable, then a retry reads that page alone', async () => {
    const f = await fixture();
    const paper = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'paper.jpg', bytes: await f.jpeg('#fff'), hints: { captureMode: 'multi', pageIndex: 1, pageCount: 2, pageKind: 'paper' } });
    const sheet = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'sheet.jpg', bytes: await f.jpeg('#111'), hints: { captureMode: 'multi', pageIndex: 2, pageCount: 2, pageKind: 'answer_sheet' } });
    const lead = pageExtraction(f.uploads, paper.assetId, 'question', '1+1=?');
    const seen: number[] = [];
    await extractMaterial(f.store, { extract: async (input: { pages?: MaterialPageImage[] }) => { seen.push(input.pages?.length ?? 0); return { ...lead, set: [lead] }; } }, paper.job.id, new AbortController().signal);
    expect(seen).toEqual([2]);
    expect(f.jobs.get(paper.job.id)?.state).toBe('queued');
    expect(f.jobs.get(sheet.job.id)?.state).toBe('failed');
    expect(jobError(f.db, sheet.job.id)).toMatchObject({ code: 'set_page_missing', retryable: true });
    expect(jobInput(f.db, sheet.job.id).setRole).toBeUndefined();
    expect(storedExtraction(f.db, sheet.assetId)).toBeNull();
    const retried = f.jobs.retry(sheet.job.id, randomUUID());
    expect(retried.state).toBe('queued');
    await f.jobs.resume();
    expect(f.jobs.get(sheet.job.id)?.state).not.toBe('failed');
    const alone = pageExtraction(f.uploads, sheet.assetId, 'student_work', '2');
    await extractMaterial(f.store, { extract: async (input: { pages?: MaterialPageImage[] }) => { seen.push(input.pages?.length ?? 0); return alone; } }, sheet.job.id, new AbortController().signal);
    expect(seen).toEqual([2, 0]);
    expect(storedExtraction(f.db, sheet.assetId)).toContain('2');
  });

  it('fails a follower left queued when restart finds the first page already finished', async () => {
    const f = await fixture();
    const paper = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'paper.jpg', bytes: await f.jpeg('#fff'), hints: { captureMode: 'multi', pageIndex: 1, pageCount: 2 } });
    const sheet = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'sheet.jpg', bytes: await f.jpeg('#111'), hints: { captureMode: 'multi', pageIndex: 2, pageCount: 2 } });
    expect(jobInput(f.db, paper.job.id).setRole).toBe('lead');
    expect(jobInput(f.db, sheet.job.id).setRole).toBe('follow');
    f.db.prepare("UPDATE material_job SET state='succeeded' WHERE id=?").run(paper.job.id);
    await f.jobs.stop();
    const scheduler = new MobileRecognitionService(await MobileRecognitionStore.open(f.dir), { inventory: async () => ({ candidates: [], warnings: [], capacityReached: false }), recognizeQuestion: async () => { throw new Error('unused'); } });
    const admission = new AdmissionController({ jobCapacity: 4, diskProbe: async () => 10n ** 12n });
    scheduler.useAdmission(admission);
    const restarted = new MaterialJobs(f.store, scheduler, admission);
    cleanups.push(async () => { await scheduler.stop(); });
    await restarted.resume();
    expect(restarted.get(paper.job.id)?.state).toBe('succeeded');
    expect(restarted.get(sheet.job.id)?.state).toBe('failed');
    expect(jobError(f.db, sheet.job.id)).toMatchObject({ code: 'set_page_missing', retryable: true });
    expect(f.db.prepare('SELECT count(*) n FROM material_asset').get()).toEqual({ n: 2 });
  });

  it('reports a full queue from complete instead of claiming the set started', async () => {
    const f = await fixture(1);
    const saved = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'paper.jpg', bytes: await f.jpeg('#fff'), hints: { captureMode: 'multi', pageIndex: 1, pageCount: 2 } });
    expect(f.admission.tryAcquireJobCapacity().accepted).toBe(true);
    expect(f.jobs.releaseCapture(f.captureId)).toEqual({ accepted: false, queued: true });
    expect(jobInput(f.db, saved.job.id)).toEqual({ deferred: true });
    const app = express();
    app.use('/s', createMaterialsRouter({ store: f.store, uploads: f.uploads, jobs: f.jobs, admission: f.admission, draftNamespace: f.store.getWorkspace().draftNamespace }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const port = (server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/s/materials/captures/${f.captureId}/complete`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', 'x-draft-namespace': f.store.getWorkspace().draftNamespace } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, accepted: false, queued: true });
    expect(jobInput(f.db, saved.job.id)).toEqual({ deferred: true });
  });

  it('lets a late page join the set, and does not elect a new lead after the first page finished', async () => {
    const held = await fixture(2);
    const paper = await held.uploads.save({ captureId: held.captureId, uploadId: randomUUID(), filename: 'paper.jpg', bytes: await held.jpeg('#fff'), hints: { captureMode: 'multi', pageIndex: 1, pageCount: 2, pageKind: 'paper' } });
    expect(held.jobs.releaseCapture(held.captureId)).toEqual({ accepted: true, queued: false });
    expect(jobInput(held.db, paper.job.id).setRole).toBe('lead');
    const sheet = await held.uploads.save({ captureId: held.captureId, uploadId: randomUUID(), filename: 'sheet.jpg', bytes: await held.jpeg('#111'), hints: { captureMode: 'multi', pageIndex: 2, pageCount: 2, pageKind: 'answer_sheet' } });
    expect(jobInput(held.db, sheet.job.id)).toEqual({ setRole: 'follow' });
    expect(jobInput(held.db, paper.job.id).setRole).toBe('lead');
    expect(held.admission.tryAcquireJobCapacity().accepted).toBe(true); held.admission.releaseJobCapacity();
    const f = await fixture();
    const done = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'done.jpg', bytes: await f.jpeg('#444'), hints: { captureMode: 'multi', pageIndex: 1, pageCount: 2 } });
    expect(f.jobs.releaseCapture(f.captureId).accepted).toBe(true);
    f.db.prepare("UPDATE material_job SET state='succeeded' WHERE id=?").run(done.job.id);
    const late = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'late.jpg', bytes: await f.jpeg('#555'), hints: { captureMode: 'multi', pageIndex: 2, pageCount: 2 } });
    expect(jobInput(f.db, late.job.id).deferred).toBeUndefined();
    expect(jobInput(f.db, late.job.id).setRole).toBeUndefined();
    expect(jobInput(f.db, done.job.id).setRole).toBe('lead');
    f.jobs.releaseCapture(f.captureId);
    expect(jobInput(f.db, late.job.id).setRole).toBeUndefined();
    expect(f.jobs.get(done.job.id)?.state).toBe('succeeded');
  });

  it('rejects another page after the set was abandoned and keeps the saved photo', async () => {
    const f = await fixture();
    const saved = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'paper.jpg', bytes: await f.jpeg('#fff'), hints: { captureMode: 'multi', pageIndex: 1, pageCount: 2 } });
    expect(f.jobs.abandonCapture(f.captureId)).toBe(1);
    await expect(f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'sheet.jpg', bytes: await f.jpeg('#111'), hints: { captureMode: 'multi', pageIndex: 2, pageCount: 2 } })).rejects.toMatchObject({ status: 409, code: 'set_conflict' });
    expect(f.db.prepare('SELECT count(*) n FROM material_asset').get()).toEqual({ n: 1 });
    expect(f.jobs.get(saved.job.id)?.state).toBe('failed');
    expect(jobError(f.db, saved.job.id)?.code).toBe('set_abandoned');
  });

  it('does not write an extraction that finishes after the set was abandoned', async () => {
    const f = await fixture();
    const paper = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'paper.jpg', bytes: await f.jpeg('#fff'), hints: { captureMode: 'multi', pageIndex: 1, pageCount: 2 } });
    const sheet = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'sheet.jpg', bytes: await f.jpeg('#111'), hints: { captureMode: 'multi', pageIndex: 2, pageCount: 2 } });
    const lead = pageExtraction(f.uploads, paper.assetId, 'question', '应该丢掉');
    await extractMaterial(f.store, { extract: async () => { f.jobs.abandonCapture(f.captureId); return { ...lead, set: [lead, pageExtraction(f.uploads, sheet.assetId, 'student_work', '也丢掉')] }; } }, paper.job.id, new AbortController().signal);
    expect(storedExtraction(f.db, paper.assetId)).toBeNull();
    expect(storedExtraction(f.db, sheet.assetId)).toBeNull();
    expect(f.jobs.get(paper.job.id)?.state).toBe('failed');
    expect(f.jobs.get(sheet.job.id)?.state).toBe('failed');
    expect(jobError(f.db, paper.job.id)?.code).toBe('set_abandoned');
    expect(jobError(f.db, sheet.job.id)?.code).toBe('set_abandoned');
    expect(jobError(f.db, sheet.job.id)?.retryable).toBe(false);
    expect(f.db.prepare('SELECT count(*) n FROM material_asset').get()).toEqual({ n: 2 });
  });

  it('refuses to abandon a capture that is not a multi-page set and keeps the photo', async () => {
    const f = await fixture();
    const single = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'one.jpg', bytes: await f.jpeg('#fff'), hints: { captureMode: 'single' } });
    let refused: unknown; try { f.jobs.abandonCapture(f.captureId); } catch (error) { refused = error; }
    expect(refused).toMatchObject({ status: 409, code: 'set_conflict' });
    expect(f.jobs.get(single.job.id)?.state).toBe('queued');
    expect(f.db.prepare('SELECT count(*) n FROM material_asset').get()).toEqual({ n: 1 });
    const plain = f.store.createCapture(randomUUID()).id;
    const album = await f.uploads.save({ captureId: plain, uploadId: randomUUID(), filename: 'album.jpg', bytes: await f.jpeg('#111'), hints: {} });
    let plainRefused: unknown; try { f.jobs.abandonCapture(plain); } catch (error) { plainRefused = error; }
    expect(plainRefused).toMatchObject({ status: 409, code: 'set_conflict' });
    expect(f.jobs.get(album.job.id)?.state).toBe('queued');
    expect(f.db.prepare('SELECT count(*) n FROM material_asset').get()).toEqual({ n: 2 });
  });
});
