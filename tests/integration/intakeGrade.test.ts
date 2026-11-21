/** Intake grades unmarked readable work after extract, without filing those suggestions. Synthetic pages only. */
import { afterEach, expect, it } from 'vitest';
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
import { MobileRecognitionService } from '../../src/mobile/service.js';
import { MobileRecognitionStore } from '../../src/mobile/store.js';
import { AdmissionController } from '../../src/mobile/admission.js';
import { MobileRequestError } from '../../src/mobile/service.js';
import { extractMaterial } from '../../src/materials/extraction.js';
import { enqueueIntakeGrades, intakeVerdict } from '../../src/materials/intakeGrade.js';
import { requestGrades } from '../../src/materials/grading.js';
import { gradeQuestion } from '../../src/materials/grading.js';
import { validateMaterialGrade } from '../../src/materials/provider.js';
import { readQuestion } from '../../src/materials/queries.js';
import { createStudentApi } from '../../src/web/api.js';
import type { Extraction, Fragment } from '../../src/materials/contracts.js';
import type { IntakeResponse } from '../../src/web/apiTypes.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const gradeRun = { stage: 'material_grade' as const, model: 'synthetic', durationMs: 0, promptTokens: null, completionTokens: null, maxTokens: 100, thinking: false as const, promptVersion: 'test' };
const answerRun = { ...gradeRun, stage: 'material_answer' as const };

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(SCHEMA_SQL);
  migrateMaterials(db);
  db.exec("INSERT INTO student_profile(id,nickname,created_at) VALUES ('a','A','2026-11-21')");
  cleanups.push(() => db.close());
  return new MaterialStore(db, 'a');
}

async function runtime(store: MaterialStore, capacity = 10) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'intake-grade-'));
  const admission = new AdmissionController({ jobCapacity: capacity, diskProbe: async () => 10n ** 12n });
  const scheduler = new MobileRecognitionService(await MobileRecognitionStore.open(dir), {
    inventory: async () => ({ candidates: [], warnings: [], capacityReached: false }),
    recognizeQuestion: async () => { throw Error('unused'); },
  });
  scheduler.useAdmission(admission);
  const jobs = new MaterialJobs(store, scheduler, admission);
  const uploads = new MaterialUploads(store, jobs, admission);
  await uploads.initialize();
  cleanups.push(async () => { await scheduler.stop(); rmSync(dir, { recursive: true, force: true }); });
  return { jobs, uploads, scheduler, dir };
}

async function settled(jobs: MaterialJobs, id: string) {
  for (let i = 0; i < 200; i++) {
    const job = jobs.get(id);
    if (job && !['queued', 'running'].includes(job.state)) return job;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error('not settled');
}

function resultFor(text: string): 'correct' | 'partial' | 'incorrect' | 'uncertain' {
  if (text.includes('RIGHT')) return 'correct';
  if (text.includes('PARTIAL')) return 'partial';
  if (text.includes('UNSURE')) return 'uncertain';
  return 'incorrect';
}

function registerGrader(store: MaterialStore, jobs: MaterialJobs) {
  jobs.register('grade', (id, signal) => gradeQuestion(store, {
    answer: async input => ({ text: '2', fragmentIds: input.fragments.map(fragment => fragment.fragmentId), run: answerRun }),
    grade: async input => ({ result: resultFor(input.work.map(fragment => fragment.text).join('\n')), findings: [{ fragmentIds: input.work.filter(fragment => fragment.role === 'student_work').map(fragment => fragment.fragmentId), text: 'synthetic judgment' }], score: null, run: gradeRun }),
  }, id, signal));
}

type Part = { role: Fragment['role']; number: string; text: string; check?: Fragment['check']; uncertainties?: string[] };

function extraction(assetId: string, sourceHash: string, parts: Part[]): Extraction {
  return {
    assetId, revision: 1, warnings: [], runs: [],
    document: { title: 'Synthetic worksheet', subject: '数学', date: null, printedCode: null, page: 1 },
    fragments: parts.map((part, order) => ({
      assetId, sourceHash, fragmentId: newId('mfr'), revision: 1,
      box: { x: 0, y: order / parts.length, width: 1, height: 1 / parts.length },
      role: part.role, text: part.text, number: part.number, subpart: null, page: 1, order,
      requiresDiagram: false, check: part.check ?? 'passed', uncertainties: part.uncertainties ?? [],
    })),
  };
}

it('keeps a provisional wrong/right result when text is readable, and refuses one when it is not', () => {
  const stem = { role: 'question' as const, text: '1+1=?', check: 'low' as const, uncertainties: ['blurry'], fragmentId: 'stem', assetId: 'a', revision: 1, sourceHash: 'h', box: { x: 0, y: 0, width: 1, height: 1 }, number: '1', subpart: null, page: 1, order: 0, requiresDiagram: false };
  const work = { ...stem, fragmentId: 'work', role: 'student_work' as const, text: '3' };
  const output = { result: 'incorrect' as const, findings: [{ fragmentIds: ['work'], text: 'not 2' }], score: null, run: gradeRun };
  expect(validateMaterialGrade(output, { stem: [{ ...stem, check: 'passed', uncertainties: [] }], work: [{ ...work, check: 'passed', uncertainties: [] }] }).result).toBe('incorrect');
  expect(validateMaterialGrade(output, { stem: [stem], work: [work] }).result).toBe('uncertain');
  expect(validateMaterialGrade(output, { stem: [stem], work: [work] }, { provisional: true }).result).toBe('incorrect');
  expect(validateMaterialGrade(output, { stem: [{ ...stem, uncertainties: ['missing_diagram'] }], work: [work] }, { provisional: true }).result).toBe('uncertain');
  expect(validateMaterialGrade(output, { stem: [stem], work: [{ ...work, check: 'failed', uncertainties: [] }] }, { provisional: true }).result).toBe('uncertain');
});

it('grades an unmarked page after extract, preselects wrong items, and files them only when the student confirms', async () => {
  const store = setup();
  const rt = await runtime(store);
  registerGrader(store, rt.jobs);
  const bytes = await sharp({ create: { width: 80, height: 120, channels: 3, background: '#fff' } }).jpeg().toBuffer();
  const saved = await rt.uploads.save({ captureId: store.createCapture(randomUUID()).id, uploadId: randomUUID(), filename: 'synthetic.jpg', bytes, hints: { label: 'synthetic' } });
  const sourceHash = rt.uploads.source(saved.assetId).sourceHash;
  const page = extraction(saved.assetId, sourceHash, [
    { role: 'question', number: '1', text: '1. WRONG stem' },
    { role: 'student_work', number: '1', text: 'WRONG 3' },
    { role: 'question', number: '2', text: '2. RIGHT stem' },
    { role: 'student_work', number: '2', text: 'RIGHT 2' },
    { role: 'question', number: '3', text: '3. PARTIAL stem' },
    { role: 'student_work', number: '3', text: 'PARTIAL 1' },
    { role: 'question', number: '4', text: '4. blank stem' },
    { role: 'question', number: '5', text: '5. crossed stem' },
    { role: 'student_work', number: '5', text: 'WRONG crossed' },
    { role: 'teacher_mark', number: '5', text: '×' },
    { role: 'question', number: '6', text: '6. ticked stem' },
    { role: 'student_work', number: '6', text: 'WRONG ticked' },
    { role: 'teacher_mark', number: '6', text: '√' },
    { role: 'question', number: '7', text: '7. low stem', check: 'low', uncertainties: ['blurry'] },
    { role: 'student_work', number: '7', text: 'WRONG low', check: 'low', uncertainties: ['blurry'] },
    { role: 'question', number: '8', text: '8. failed work' },
    { role: 'student_work', number: '8', text: 'WRONG failed', check: 'failed' },
  ]);
  await extractMaterial(store, { extract: async () => page }, saved.job.id, new AbortController().signal, undefined, assetIds => enqueueIntakeGrades(store, rt.jobs, assetIds));
  store.db.prepare("UPDATE material_job SET state='succeeded' WHERE owner_id=? AND id=?").run(store.studentId, saved.job.id);
  const gradeJobs = store.db.prepare("SELECT id, question_id FROM material_job WHERE owner_id=? AND kind='grade'").all(store.studentId) as { id: string; question_id: string }[];
  expect(gradeJobs.length).toBeGreaterThan(0);
  for (const job of gradeJobs) expect((await settled(rt.jobs, job.id)).state).toBe('succeeded');
  const byNumber = new Map(store.listQuestions().map(question => [question.number, readQuestion(store, question.id)!]));
  const stored = (number: string) => byNumber.get(number)!.grades.find(grade => !grade.stale);
  expect(stored('1')).toMatchObject({ source: 'intake', result: 'incorrect' });
  expect(stored('2')).toMatchObject({ source: 'intake', result: 'correct' });
  expect(stored('3')).toMatchObject({ source: 'intake', result: 'partial' });
  expect(stored('7')).toMatchObject({ source: 'intake', result: 'incorrect' });
  expect(byNumber.get('4')!.grades).toEqual([]);
  expect(byNumber.get('5')!.grades).toEqual([]);
  expect(byNumber.get('6')!.grades).toEqual([]);
  expect(byNumber.get('8')!.grades).toEqual([]);
  expect(byNumber.get('5')!.itemId).toBeTruthy();
  for (const number of ['1', '2', '3', '4', '6', '7', '8']) expect(byNumber.get(number)!.itemId, number).toBeNull();
  expect(intakeVerdict(readQuestion(store, byNumber.get('1')!.id)!)).toEqual({ verdict: 'wrong', preselected: true });
  expect(intakeVerdict(readQuestion(store, byNumber.get('6')!.id)!)).toEqual({ verdict: 'right', preselected: false });
  expect(intakeVerdict(readQuestion(store, byNumber.get('8')!.id)!)).toEqual({ verdict: 'confirm', preselected: false });
  const before = gradeJobs.map(job => job.id).sort();
  enqueueIntakeGrades(store, rt.jobs, [saved.assetId]);
  expect((store.db.prepare("SELECT id FROM material_job WHERE owner_id=? AND kind='grade' ORDER BY id").all(store.studentId) as { id: string }[]).map(job => job.id).sort()).toEqual(before);
  expect(requestGrades(store, rt.jobs, { requestId: randomUUID(), questionIds: [byNumber.get('8')!.id] }).jobs).toEqual([]);
  expect(requestGrades(store, rt.jobs, { requestId: randomUUID(), questionIds: [byNumber.get('7')!.id] }).jobs).toEqual([]);

  const app = express();
  app.use('/s/api', createStudentApi({
    mobileDataDir: rt.dir, materials: store, service: rt.scheduler, timeZone: 'Asia/Singapore', now: () => new Date(),
  }, { studentHostWorker: true, service: rt.scheduler, materialsJobs: rt.jobs, accountRoleOf: () => 'student', inviteExpiresOf: () => null }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const intake = await (await fetch(`${base}/s/api/intake`, { headers: { accept: 'application/json' } })).json() as IntakeResponse;
  const photo = intake.photos.find(item => item.id === saved.assetId)!;
  const verdictOf = (excerpt: string) => photo.candidates.find(candidate => candidate.excerpt.includes(excerpt))!;
  expect(verdictOf('WRONG stem')).toMatchObject({ verdict: 'wrong', preselected: true });
  expect(verdictOf('RIGHT stem')).toMatchObject({ verdict: 'right', preselected: false });
  expect(verdictOf('PARTIAL stem')).toMatchObject({ verdict: 'partial', preselected: true });
  expect(verdictOf('blank stem')).toMatchObject({ verdict: 'confirm', preselected: false });
  expect(verdictOf('ticked stem')).toMatchObject({ verdict: 'right', preselected: false });
  expect(verdictOf('low stem')).toMatchObject({ verdict: 'wrong', preselected: true });
  expect(verdictOf('failed work')).toMatchObject({ verdict: 'confirm', preselected: false });
  expect(photo.candidates.some(candidate => candidate.excerpt.includes('crossed stem'))).toBe(false);
  expect(photo.questions.some(question => question.excerpt.includes('crossed'))).toBe(true);
  expect(store.db.prepare('SELECT count(*) n FROM error_item').get()).toEqual({ n: 1 });

  const wrong = verdictOf('WRONG stem');
  const selected = await fetch(`${base}/s/api/intake/photos/${saved.assetId}/select`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', origin: base },
    body: JSON.stringify({ ids: [wrong.id] }),
  });
  expect(selected.status).toBe(200);
  expect(readQuestion(store, byNumber.get('1')!.id)!.itemId).toBeTruthy();
  expect(readQuestion(store, byNumber.get('3')!.id)!.itemId).toBeNull();
  expect(readQuestion(store, byNumber.get('2')!.id)!.itemId).toBeNull();
});

it('still lets a workspace grade auto-include, and still saves the extract when grading cannot start', async () => {
  const store = setup();
  const rt = await runtime(store, 1);
  const bytes = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#eee' } }).jpeg().toBuffer();
  const saved = await rt.uploads.save({ captureId: store.createCapture(randomUUID()).id, uploadId: randomUUID(), filename: 'full.jpg', bytes, hints: {} });
  const sourceHash = rt.uploads.source(saved.assetId).sourceHash;
  const page = extraction(saved.assetId, sourceHash, [
    { role: 'question', number: '1', text: '1. would grade' },
    { role: 'student_work', number: '1', text: 'WRONG 9' },
    { role: 'question', number: '2', text: '2. would also grade' },
    { role: 'student_work', number: '2', text: 'RIGHT 2' },
  ]);
  await extractMaterial(store, { extract: async () => page }, saved.job.id, new AbortController().signal, undefined, () => { throw new MobileRequestError(429, 'capacity_full', '处理队列已满，请稍后重试。'); });
  const savedExtract = store.db.prepare('SELECT extraction_json FROM material_asset WHERE owner_id=? AND id=?').get(store.studentId, saved.assetId) as { extraction_json: string };
  expect(savedExtract.extraction_json).toContain('would grade');
  expect(store.db.prepare("SELECT count(*) n FROM material_job WHERE kind='grade'").get()).toEqual({ n: 0 });
  expect(store.listQuestions().every(question => question.itemId === null || question.number === null)).toBe(true);

  const open = await runtime(store, 4);
  registerGrader(store, open.jobs);
  const questionId = store.listQuestions().find(question => question.number === '1')!.id;
  const action = requestGrades(store, open.jobs, { requestId: randomUUID(), questionIds: [questionId] });
  expect(action.jobs).toHaveLength(1);
  expect((await settled(open.jobs, action.jobs[0]!.id)).state).toBe('succeeded');
  const graded = readQuestion(store, questionId)!;
  expect(graded.grades[0]!.source).toBeUndefined();
  expect(graded.grades[0]!.result).toBe('incorrect');
  expect(graded.itemId).toBeTruthy();
});
