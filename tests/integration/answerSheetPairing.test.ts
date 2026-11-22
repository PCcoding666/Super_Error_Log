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
import { assembledQuestionTexts } from '../../src/materials/answerSheet.js';
import { questionIntakeVerdict } from '../../src/materials/learning.js';
import { MobileRecognitionService } from '../../src/mobile/service.js';
import { MobileRecognitionStore } from '../../src/mobile/store.js';
import { AdmissionController } from '../../src/mobile/admission.js';
import type { CaptureHints, Extraction, Fragment } from '../../src/materials/contracts.js';
import type { MaterialUploads as Uploads } from '../../src/materials/uploads.js';
import { buildIntakeGroups } from '../../src/web/intakeGroups.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'answer-sheet-'));
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
  return { db, store, uploads, captureId, jpeg };
}

function fragment(uploads: Uploads, assetId: string, role: Fragment['role'], text: string, number: string, subpart: string | null, order: number): Fragment {
  return {
    assetId, fragmentId: newId('mfr'), revision: 1, sourceHash: uploads.source(assetId).sourceHash,
    box: { x: 0, y: order / 8, width: 1, height: 1 / 8 }, role, text, number, subpart, page: 1, order,
    requiresDiagram: false, check: 'passed', uncertainties: [],
  };
}

function extraction(assetId: string, fragments: Fragment[], page: number): Extraction {
  return { assetId, revision: 1, document: { title: null, subject: '数学', date: null, printedCode: null, page }, fragments, warnings: [], runs: [] };
}

describe('answer sheet joined to paper subparts', () => {
  it('assembles each marked blank with its stem, and leaves an unmatched number visible', async () => {
    const f = await fixture();
    const sheetHints: CaptureHints = { captureMode: 'multi', pageIndex: 1, pageCount: 3, pageKind: 'answer_sheet' };
    const paper6Hints: CaptureHints = { captureMode: 'multi', pageIndex: 2, pageCount: 3, pageKind: 'paper' };
    const paper7Hints: CaptureHints = { captureMode: 'multi', pageIndex: 3, pageCount: 3, pageKind: 'paper' };
    const sheet = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'sheet.jpg', bytes: await f.jpeg('#eee'), hints: sheetHints });
    const paper6 = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'p6.jpg', bytes: await f.jpeg('#ddd'), hints: paper6Hints });
    const paper7 = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'p7.jpg', bytes: await f.jpeg('#ccc'), hints: paper7Hints });
    const sheetExtraction = extraction(sheet.assetId, [
      fragment(f.uploads, sheet.assetId, 'teacher_mark', '×', '16', '(2)', 0),
      fragment(f.uploads, sheet.assetId, 'student_work', '合成作答甲', '16', '(2)', 1),
      fragment(f.uploads, sheet.assetId, 'teacher_mark', '√', '16', '(1)', 2),
      fragment(f.uploads, sheet.assetId, 'student_work', '合成作答乙', '16', '(1)', 3),
      fragment(f.uploads, sheet.assetId, 'teacher_mark', '-2', '17', '(2)', 4),
      fragment(f.uploads, sheet.assetId, 'student_work', '合成作答丙', '17', '(2)', 5),
      fragment(f.uploads, sheet.assetId, 'teacher_mark', '×', '99', null, 6),
      fragment(f.uploads, sheet.assetId, 'student_work', '没有题干的作答', '99', null, 7),
    ], 1);
    const page6 = extraction(paper6.assetId, [
      fragment(f.uploads, paper6.assetId, 'question', '合成大题 16 的共用题干。', '16', null, 0),
      fragment(f.uploads, paper6.assetId, 'question', '合成小问 16(1) 的题干。', '16', '(1)', 1),
      fragment(f.uploads, paper6.assetId, 'question', '合成小问 16(2) 的题干。', '16', '(2)', 2),
    ], 6);
    const page7 = extraction(paper7.assetId, [
      fragment(f.uploads, paper7.assetId, 'diagram', '合成小问 16(2) 的图', '16', '(2)', 0),
      fragment(f.uploads, paper7.assetId, 'question', '合成小问 17(2) 的题干。', '17', '(2)', 1),
    ], 7);
    await extractMaterial(f.store, { extract: async () => ({ ...sheetExtraction, set: [sheetExtraction, page6, page7] }) }, sheet.job.id, new AbortController().signal);
    const questions = f.store.listQuestions();
    const by = (number: string, subpart: string | null) => questions.find(question => question.number === number && (question.stem.find(item => item.role === 'question')?.subpart ?? question.teacherMarks[0]?.subpart ?? null) === subpart);
    const wrong = by('16', '(2)')!;
    const right = by('16', '(1)')!;
    const partial = by('17', '(2)')!;
    const missing = by('99', null)!;
    const parent = by('16', null)!;
    expect(wrong.teacherMarks.map(mark => mark.text)).toEqual(['×']);
    expect(wrong.attempts.flatMap(attempt => attempt.fragments).map(item => item.text)).toEqual(['合成作答甲']);
    expect(wrong.stem.some(item => item.role === 'diagram' && item.text.includes('16(2)'))).toBe(true);
    expect(assembledQuestionTexts(f.store, wrong)).toEqual(['合成大题 16 的共用题干。', '合成小问 16(2) 的题干。']);
    expect(questionIntakeVerdict(f.store, wrong)).toEqual({ verdict: 'wrong', preselected: true });
    expect(questionIntakeVerdict(f.store, right)).toEqual({ verdict: 'right', preselected: false });
    expect(questionIntakeVerdict(f.store, partial)).toEqual({ verdict: 'partial', preselected: true });
    expect(questionIntakeVerdict(f.store, missing)).toEqual({ verdict: 'confirm', preselected: false });
    expect(missing.stem.some(item => item.role === 'question')).toBe(false);
    expect(wrong.itemId).toBeNull();
    expect(right.itemId).toBeNull();
    expect(parent.itemId).toBeNull();
    const groups = buildIntakeGroups(f.store, questions, [], new Map());
    const card16 = groups.find(group => group.title === '第 16 题')!;
    expect(card16.status).toBe('答题卡 + 试卷第 6、7 页');
    expect(card16.candidates.map(candidate => candidate.verdict)).toEqual(['wrong', 'right']);
    expect(card16.candidates.map(candidate => candidate.preselected)).toEqual([true, false]);
    expect(card16.candidates.map(candidate => candidate.label)).toEqual(['(2)', '(1)']);
    expect(card16.thumbs.map(thumb => thumb.pageKind)).toEqual(['answer_sheet', 'paper', 'paper']);
    expect(groups.find(group => group.title === '第 99 题')?.candidates[0]?.excerpt).toBe('题干不在上传的页面里');
    expect(groups.some(group => group.candidates.some(candidate => candidate.excerpt.includes('共用题干')))).toBe(false);
  });

  it('does not join a mark when two stems share a number and subpart', async () => {
    const f = await fixture();
    const hints = (pageIndex: number, pageKind: CaptureHints['pageKind']): CaptureHints => ({ captureMode: 'multi', pageIndex, pageCount: 3, pageKind });
    const sheet = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'sheet.jpg', bytes: await f.jpeg('#111'), hints: hints(1, 'answer_sheet') });
    const first = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'a.jpg', bytes: await f.jpeg('#222'), hints: hints(2, 'paper') });
    const second = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'b.jpg', bytes: await f.jpeg('#333'), hints: hints(3, 'paper') });
    const sheetExtraction = extraction(sheet.assetId, [fragment(f.uploads, sheet.assetId, 'teacher_mark', '×', '3', '(1)', 0)], 1);
    const left = extraction(first.assetId, [fragment(f.uploads, first.assetId, 'question', '合成题干甲', '3', '(1)', 0)], 1);
    const right = extraction(second.assetId, [fragment(f.uploads, second.assetId, 'question', '合成题干乙', '3', '(1)', 0)], 2);
    await extractMaterial(f.store, { extract: async () => ({ ...sheetExtraction, set: [left, right, sheetExtraction] }) }, sheet.job.id, new AbortController().signal);
    const questions = f.store.listQuestions();
    const holdingMark = questions.filter(question => question.teacherMarks.some(mark => mark.text === '×'));
    expect(holdingMark).toHaveLength(1);
    expect(holdingMark[0]!.stem.some(item => item.role === 'question')).toBe(false);
    expect(questions.filter(question => question.stem.some(item => item.role === 'question')).every(question => question.teacherMarks.length === 0)).toBe(true);
    expect(buildIntakeGroups(f.store, questions, [], new Map()).some(group => group.candidates.some(candidate => candidate.excerpt === '题干不在上传的页面里'))).toBe(true);
  });

  it('still auto-files a cross on a same-page worksheet', async () => {
    const f = await fixture();
    const paper = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'one.jpg', bytes: await f.jpeg('#fff'), hints: { captureMode: 'single' } });
    const stem = fragment(f.uploads, paper.assetId, 'question', '1. 合成单页题干。', '1', null, 0);
    const mark = fragment(f.uploads, paper.assetId, 'teacher_mark', '×', '1', null, 1);
    await extractMaterial(f.store, { extract: async () => extraction(paper.assetId, [stem, mark], 1) }, paper.job.id, new AbortController().signal);
    const questions = f.store.listQuestions();
    expect(questions).toHaveLength(1);
    expect(questions[0]!.itemId).toBeTruthy();
    expect(questions[0]!.teacherMarks.map(item => item.text)).toEqual(['×']);
    expect(buildIntakeGroups(f.store, questions, [], new Map())).toEqual([]);
  });
});
