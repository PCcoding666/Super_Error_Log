/** Intake grades suggest a page verdict. They never file a notebook item by themselves. Synthetic pages only. */
import { afterEach, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import http from 'node:http';
import sharp from 'sharp';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { newId } from '../../src/db/connection.js';
import { migrateMaterials } from '../../src/materials/schema.js';
import { MaterialStore } from '../../src/materials/store.js';
import { MaterialJobs } from '../../src/materials/jobs.js';
import { MaterialUploads } from '../../src/materials/uploads.js';
import { extractMaterial } from '../../src/materials/extraction.js';
import { intakeVerdict, requestGrades, requestIntakeGrades, gradeQuestion } from '../../src/materials/grading.js';
import { createMaterialActionProvider, validateMaterialGrade } from '../../src/materials/provider.js';
import { flushIntakeSelections, readIntakeProgress } from '../../src/materials/intakeProgress.js';
import { markedRight, notYetIncluded, syncMaterialLearning } from '../../src/materials/learning.js';
import { readQuestion } from '../../src/materials/queries.js';
import { MobileRecognitionService, MobileRequestError } from '../../src/mobile/service.js';
import { MobileRecognitionStore } from '../../src/mobile/store.js';
import { AdmissionController } from '../../src/mobile/admission.js';
import { createStudentApi } from '../../src/web/api.js';
import type { Extraction, Fragment, Grade } from '../../src/materials/contracts.js';
import type { MaterialProvider } from '../../src/materials/provider.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const answerRun = { stage: 'material_answer' as const, model: 'synthetic', durationMs: 0, promptTokens: null, completionTokens: null, maxTokens: 100, thinking: false as const, promptVersion: 'test' };
const gradeRun = { stage: 'material_grade' as const, model: 'synthetic', durationMs: 0, promptTokens: null, completionTokens: null, maxTokens: 100, thinking: false as const, promptVersion: 'test' };

function resultOf(work: string): 'incorrect' | 'partial' | 'correct' | 'uncertain' {
  if (work.includes('WRONG')) return 'incorrect';
  if (work.includes('PARTIAL')) return 'partial';
  if (work.includes('RIGHT')) return 'correct';
  return 'uncertain';
}

function gradingProvider() {
  return {
    answer: async (input: { fragments: Fragment[] }) => ({ text: 'Synthetic reference: 2', fragmentIds: input.fragments.map(fragment => fragment.fragmentId), run: answerRun }),
    grade: async (input: { work: Fragment[] }) => ({
      result: resultOf(input.work.map(fragment => fragment.text).join('\n')),
      findings: [{ fragmentIds: input.work.filter(fragment => fragment.role === 'student_work').map(fragment => fragment.fragmentId), text: 'Synthetic comparison only.' }],
      score: null,
      run: gradeRun,
    }),
  };
}

async function runtime(store: MaterialStore, capacity = 8) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'intake-grade-'));
  const admission = new AdmissionController({ jobCapacity: capacity, diskProbe: async () => 10n ** 12n });
  const scheduler = new MobileRecognitionService(await MobileRecognitionStore.open(dir), {
    inventory: async () => ({ candidates: [], warnings: [], capacityReached: false }),
    recognizeQuestion: async () => { throw new Error('unused'); },
  });
  scheduler.useAdmission(admission);
  const jobs = new MaterialJobs(store, scheduler, admission);
  jobs.retryDelaysMs = [1, 2];
  const uploads = new MaterialUploads(store, jobs, admission);
  await uploads.initialize();
  cleanups.push(async () => { await scheduler.stop(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, jobs, uploads, scheduler, admission };
}

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(SCHEMA_SQL);
  migrateMaterials(db);
  db.exec("INSERT INTO student_profile(id,nickname,created_at) VALUES ('a','Synthetic','2026-11-21')");
  cleanups.push(() => db.close());
  return { db, store: new MaterialStore(db, 'a') };
}

function piece(assetId: string, sourceHash: string, role: Fragment['role'], text: string, number: string, extra: Partial<Fragment> = {}): Fragment {
  return {
    assetId, fragmentId: newId('mfr'), revision: 1, sourceHash, box: { x: 0.05, y: 0.05, width: 0.4, height: 0.1 },
    role, text, number, subpart: null, page: 1, order: 0, requiresDiagram: false, check: 'passed', uncertainties: [], ...extra,
  };
}

async function settled(jobs: MaterialJobs, id: string) {
  for (let i = 0; i < 200; i++) {
    const job = jobs.get(id);
    if (job && !['queued', 'running'].includes(job.state)) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('not settled');
}

type Candidate = { id: string; excerpt: string; verdict: string; preselected?: boolean; submitted?: boolean };
type Intake = { busy: boolean; photos: { id: string; state: string; candidates: Candidate[]; questions: { id: string; excerpt: string }[] }[] };

it('keeps a provisional result only when the stem and work are readable', () => {
  const stem = piece('asset', 'hash', 'question', 'Synthetic stem', '1');
  const work = piece('asset', 'hash', 'student_work', 'WRONG', '1');
  const output = { result: 'incorrect' as const, findings: [{ fragmentIds: [work.fragmentId], text: 'Synthetic comparison only.' }], score: null, run: gradeRun };
  expect(validateMaterialGrade(output, { stem: [stem], work: [{ ...work, check: 'low', uncertainties: ['text_mismatch'] }] }, { provisional: true }).result).toBe('incorrect');
  expect(validateMaterialGrade(output, { stem: [stem], work: [{ ...work, check: 'low' }] }).result).toBe('uncertain');
  expect(validateMaterialGrade(output, { stem: [{ ...stem, uncertainties: ['missing_diagram'], check: 'low' }], work: [work] }, { provisional: true }).result).toBe('uncertain');
  expect(validateMaterialGrade(output, { stem: [{ ...stem, check: 'failed' }], work: [work] }, { provisional: true }).result).toBe('uncertain');
  expect(validateMaterialGrade(output, { stem: [{ ...stem, text: '   ' }], work: [work] }, { provisional: true }).result).toBe('uncertain');
});

it('asks the real grader to keep a provisional result and still downgrades a strict one', async () => {
  const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#9cf' } }).jpeg().toBuffer();
  const hash = createHash('sha256').update(bytes).digest('hex');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'intake-grade-provider-'));
  const file = path.join(dir, 'page.jpg');
  writeFileSync(file, bytes);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as { messages: { content: { text?: string }[] }[] };
    const data = JSON.parse(body.messages[1]!.content[0]!.text!) as { questionId: string; attemptId: string; basisKey: string; work: { fragmentId: string }[] };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
      questionId: data.questionId, attemptId: data.attemptId, basisKey: data.basisKey, result: 'incorrect',
      findings: [{ fragmentIds: [data.work[0]!.fragmentId], text: 'Synthetic comparison only.' }], score: null,
    }) } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const provider = createMaterialActionProvider({
    mode: 'openai', chat: { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKey: 'synthetic', timeoutMs: 2000, bailianOnly: false, models: { material_extract: 'e', material_verify: 'v', material_answer: 'a', material_grade: 'g' } },
  }, { source: () => ({ sourceHash: hash, originalPath: file }), request: (_key, invoke) => invoke(new AbortController().signal) });
  const stem = piece('page', hash, 'question', 'Synthetic stem', '1');
  const work = piece('page', hash, 'student_work', 'WRONG', '1', { check: 'low', uncertainties: ['text_mismatch'] });
  const input = { questionId: 'q', attemptId: 'a', stem: [stem], work: [work], answers: [] };
  expect((await provider.grade({ ...input, basisKey: 'provisional-basis', provisional: true }, new AbortController().signal)).result).toBe('incorrect');
  expect((await provider.grade({ ...input, basisKey: 'strict-basis' }, new AbortController().signal)).result).toBe('uncertain');
});

it('grades an unmarked page after extract, preselects wrong items, and files nothing until confirm', async () => {
  const { db, store } = setup();
  const rt = await runtime(store);
  let openGrades!: () => void;
  const gradesOpen = new Promise<void>(resolve => { openGrades = resolve; });
  const provider = gradingProvider();
  rt.jobs.register('grade', (id, signal) => gradeQuestion(store, {
    answer: provider.answer,
    grade: async input => { await gradesOpen; return provider.grade(input); },
  }, id, signal));
  const app = express();
  app.use('/s/api', createStudentApi({
    mobileDataDir: rt.dir, materials: store, service: rt.scheduler, timeZone: 'Asia/Singapore', now: () => new Date(),
  }, { studentHostWorker: true, service: rt.scheduler, materialsJobs: rt.jobs, accountRoleOf: () => 'student', inviteExpiresOf: () => null }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const intake = async (): Promise<Intake> => {
    const response = await fetch(`${base}/s/api/intake`, { headers: { accept: 'application/json' } });
    expect(response.status).toBe(200);
    return response.json() as Promise<Intake>;
  };
  const bytes = await sharp({ create: { width: 80, height: 80, channels: 3, background: '#fff' } }).png().toBuffer();
  const saved = await rt.uploads.save({ captureId: store.createCapture(randomUUID()).id, uploadId: randomUUID(), filename: 'synthetic.png', bytes, hints: {} });
  const source = rt.uploads.source(saved.assetId);
  const revision = (db.prepare('SELECT revision FROM material_asset WHERE id=?').get(saved.assetId) as { revision: number }).revision;
  const spec = (number: string, stem: string, work: string | null, extra: Partial<Fragment> = {}, workExtra: Partial<Fragment> = {}, mark?: string): Fragment[] => {
    const fragments = [piece(saved.assetId, source.sourceHash, 'question', stem, number, extra)];
    if (work !== null) fragments.push(piece(saved.assetId, source.sourceHash, 'student_work', work, number, workExtra));
    if (mark) fragments.push(piece(saved.assetId, source.sourceHash, 'teacher_mark', mark, number));
    return fragments;
  };
  const fragments = [
    ...spec('1', 'STEM-WRONG', 'WRONG 3'),
    ...spec('2', 'STEM-RIGHT', 'RIGHT 4'),
    ...spec('3', 'STEM-PARTIAL', 'PARTIAL 5', { check: 'low', uncertainties: ['text_mismatch'] }, { check: 'low', uncertainties: ['text_mismatch'] }),
    ...spec('4', 'STEM-BLANK', null),
    ...spec('5', 'STEM-FAILED', 'WRONG 9', { check: 'failed' }, { check: 'failed' }),
    ...spec('6', 'STEM-DIAGRAM', 'WRONG 8', { check: 'low', requiresDiagram: true, uncertainties: ['missing_diagram'] }),
    ...spec('7', 'STEM-CROSS', 'RIGHT 1', {}, {}, '×'),
    ...spec('8', 'STEM-TICK', 'WRONG 0', {}, {}, '√'),
  ];
  const extraction = (rows: Fragment[]): Extraction => ({
    assetId: saved.assetId, revision, document: { title: 'Synthetic worksheet', subject: '数学', date: null, printedCode: null, page: 1 },
    fragments: rows, warnings: [], runs: [],
  });
  const boundary: MaterialProvider = { extract: async (input, signal) => {
    signal.throwIfAborted();
    const final = extraction(fragments);
    await input.onProgress?.({ phase: 'located', extraction: extraction(fragments.map(fragment => ({ ...fragment, text: fragment.role === 'question' ? fragment.text : '', check: 'unchecked', uncertainties: [] }))) });
    await input.onProgress?.({ phase: 'enriching', extraction: final });
    return final;
  } };
  rt.jobs.register('extract', (id, signal) => extractMaterial(store, boundary, id, signal, undefined, rt.jobs));
  // save() queued the extract before the handler existed. Resume starts it now.
  await rt.jobs.resume();
  await expect.poll(() => JSON.stringify(db.prepare('SELECT state, error FROM material_job WHERE id=?').get(saved.job.id)), { timeout: 5_000 }).toBe(JSON.stringify({ state: 'succeeded', error: null }));
  await expect.poll(() => db.prepare("SELECT count(*) n FROM material_job WHERE kind='grade' AND state IN ('queued','running')").get(), { timeout: 5_000 }).toEqual({ n: 3 });
  const before = await intake();
  const photo = before.photos.find(item => item.id === saved.assetId)!;
  expect(before.busy).toBe(true);
  expect(photo.questions).toHaveLength(1);
  expect(photo.questions[0]!.excerpt).toContain('STEM-CROSS');
  expect(photo.candidates.map(candidate => candidate.excerpt)).toEqual(expect.arrayContaining(['STEM-WRONG', 'STEM-RIGHT', 'STEM-PARTIAL', 'STEM-BLANK', 'STEM-FAILED', 'STEM-DIAGRAM']));
  expect(photo.candidates.some(candidate => candidate.excerpt.includes('STEM-TICK') || candidate.excerpt.includes('STEM-CROSS'))).toBe(false);
  expect(photo.candidates.every(candidate => candidate.verdict === 'confirm' && candidate.preselected === false)).toBe(true);
  expect(readIntakeProgress(store).get(saved.assetId)?.selected).toEqual([]);
  expect((db.prepare('SELECT count(*) n FROM error_item').get() as { n: number }).n).toBe(1);
  openGrades();
  const gradeIds = (db.prepare("SELECT id FROM material_job WHERE kind='grade'").all() as { id: string }[]).map(row => row.id);
  for (const id of gradeIds) expect((await settled(rt.jobs, id)).state).toBe('succeeded');
  expect(requestIntakeGrades(store, rt.jobs, saved.assetId)).toBeUndefined();
  expect(db.prepare("SELECT count(*) n FROM material_job WHERE kind='grade'").get()).toEqual({ n: 3 });
  const graded = (await intake()).photos.find(item => item.id === saved.assetId)!;
  const byExcerpt = new Map(graded.candidates.map(candidate => [candidate.excerpt, candidate]));
  expect(byExcerpt.get('STEM-WRONG')).toMatchObject({ verdict: 'wrong', preselected: true });
  expect(byExcerpt.get('STEM-RIGHT')).toMatchObject({ verdict: 'right', preselected: false });
  expect(byExcerpt.get('STEM-PARTIAL')).toMatchObject({ verdict: 'partial', preselected: true });
  for (const excerpt of ['STEM-BLANK', 'STEM-FAILED', 'STEM-DIAGRAM']) expect(byExcerpt.get(excerpt)).toMatchObject({ verdict: 'confirm', preselected: false });
  expect((await intake()).busy).toBe(false);
  const storedGrades = (db.prepare('SELECT content_json FROM material_grade').all() as { content_json: string }[]).map(row => JSON.parse(row.content_json) as Grade);
  expect(storedGrades.map(grade => grade.source)).toEqual(['intake', 'intake', 'intake']);
  expect(storedGrades.map(grade => grade.result).sort()).toEqual(['correct', 'incorrect', 'partial']);
  expect(readIntakeProgress(store).get(saved.assetId)?.selected).toEqual([]);
  flushIntakeSelections(store, saved.assetId);
  expect((db.prepare('SELECT count(*) n FROM error_item').get() as { n: number }).n).toBe(1);
  const wrong = byExcerpt.get('STEM-WRONG')!;
  const detail = await fetch(`${base}/s/api/intake/candidates/${wrong.id.split(':')[0]}?revision=${wrong.id.split(':')[1]}`, { headers: { accept: 'application/json' } });
  expect(detail.status).toBe(200);
  expect(await detail.json()).toMatchObject({ verdict: 'wrong', preselected: true });
  const selected = await fetch(`${base}/s/api/intake/photos/${saved.assetId}/select`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ ids: [wrong.id] }),
  });
  expect(selected.status).toBe(200);
  expect(await selected.json()).toMatchObject({ included: 1 });
  const questions = store.listQuestions();
  expect(questions.find(question => question.stem.some(fragment => fragment.text.includes('STEM-WRONG')))?.itemId).toBeTruthy();
  expect(questions.find(question => question.stem.some(fragment => fragment.text.includes('STEM-RIGHT')))?.itemId).toBeNull();
  expect(questions.find(question => question.stem.some(fragment => fragment.text.includes('STEM-PARTIAL')))?.itemId).toBeNull();
  expect(questions.find(question => question.stem.some(fragment => fragment.text.includes('STEM-TICK')))?.itemId).toBeNull();
  expect(markedRight(questions.find(question => question.stem.some(fragment => fragment.text.includes('STEM-TICK')))!)).toBe(true);
  expect(notYetIncluded(store).flatMap(group => group.questions).some(question => question.stem.some(fragment => fragment.text.includes('STEM-TICK')))).toBe(false);
  const low = questions.find(question => question.stem.some(fragment => fragment.text.includes('STEM-PARTIAL')))!;
  expect(requestGrades(store, rt.jobs, { requestId: randomUUID(), questionIds: [low.id] }).jobs).toEqual([]);
});

it('does not let an intake grade override a teacher mark or file a verified stem', () => {
  const { db, store } = setup();
  const asset = 'asset-mark';
  db.prepare('INSERT INTO source_batch(id,student_id,created_at) VALUES (?,?,?)').run('batch-mark', 'a', '2026-11-21');
  db.prepare('INSERT INTO source_asset(id,batch_id,filename,mime,size,content_hash,storage_path,created_at) VALUES (?,?,?,?,?,?,?,?)').run('src-mark', 'batch-mark', 'synthetic.jpg', 'image/jpeg', 1, 'hash', '/synthetic.jpg', '2026-11-21');
  db.prepare('INSERT INTO material_asset(id,owner_id,capture_id,source_asset_id) VALUES (?,?,?,?)').run(asset, 'a', store.createCapture(randomUUID()).id, 'src-mark');
  const make = (number: string, stem: string, mark: string) => {
    const id = store.createQuestion({ number, subject: '数学' }).id;
    const question = piece(asset, 'hash', 'question', stem, number);
    const work = piece(asset, 'hash', 'student_work', 'WRONG', number);
    const tick = piece(asset, 'hash', 'teacher_mark', mark, number);
    for (const fragment of [question, work, tick]) store.putFragment(fragment);
    const attempt = store.createAttempt(id).id;
    store.linkFragment(question.fragmentId, 1, { questionId: id, attemptId: null });
    store.linkFragment(work.fragmentId, 1, { questionId: id, attemptId: attempt });
    store.linkFragment(tick.fragmentId, 1, { questionId: id, attemptId: null });
    return { id, attempt, work };
  };
  const crossed = make('1', 'STEM-CROSS', '×');
  const ticked = make('2', 'STEM-TICK', '√');
  expect(store.getQuestion(crossed.id)!.itemId).toBeTruthy();
  expect(store.getQuestion(ticked.id)!.itemId).toBeNull();
  const insert = (question: { id: string; attempt: string; work: Fragment }, source: 'intake' | undefined, result: Grade['result']) => {
    const grade: Grade = {
      id: newId('mgr'), attemptId: question.attempt, answerIds: [], basisKey: 'synthetic', result,
      findings: [{ fragmentIds: [question.work.fragmentId], text: 'Synthetic comparison only.' }],
      score: null, stale: false, run: gradeRun, ...(source ? { source } : {}),
    };
    db.prepare('INSERT INTO material_grade(id,owner_id,attempt_id,basis_key,dependencies_json,content_json,stale) VALUES (?,?,?,?,?,?,?)')
      .run(grade.id, 'a', question.attempt, grade.basisKey, '[]', JSON.stringify(grade), 0);
  };
  insert(ticked, 'intake', 'incorrect');
  insert(crossed, 'intake', 'correct');
  syncMaterialLearning(store);
  expect(store.getQuestion(ticked.id)!.itemId).toBeNull();
  expect(markedRight(store.getQuestion(ticked.id)!)).toBe(true);
  expect(notYetIncluded(store).flatMap(group => group.questions).map(question => question.id)).not.toContain(ticked.id);
  expect(intakeVerdict(readQuestion(store, ticked.id)!)).toEqual({ verdict: 'right', preselected: false });
  expect(intakeVerdict(readQuestion(store, crossed.id)!)).toEqual({ verdict: 'wrong', preselected: true });
  expect(store.getQuestion(crossed.id)!.itemId).toBeTruthy();
  insert(ticked, undefined, 'incorrect');
  syncMaterialLearning(store);
  expect(store.getQuestion(ticked.id)!.itemId).toBeTruthy();
  expect(markedRight(store.getQuestion(ticked.id)!)).toBe(false);
});

it('leaves confirm when grading is rate-limited and still finishes extract', async () => {
  const { db, store } = setup();
  const limited = await runtime(store, 1);
  const bytes = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#fff' } }).png().toBuffer();
  const saved = await limited.uploads.save({ captureId: store.createCapture(randomUUID()).id, uploadId: randomUUID(), filename: 'synthetic.png', bytes, hints: {} });
  const source = limited.uploads.source(saved.assetId);
  const revision = (db.prepare('SELECT revision FROM material_asset WHERE id=?').get(saved.assetId) as { revision: number }).revision;
  const question = piece(saved.assetId, source.sourceHash, 'question', 'STEM-QUEUED', '1', { revision });
  const work = piece(saved.assetId, source.sourceHash, 'student_work', 'WRONG', '1', { revision });
  const extraction: Extraction = {
    assetId: saved.assetId, revision, document: { title: null, subject: '数学', date: null, printedCode: null, page: 1 },
    fragments: [question, work], warnings: [], runs: [],
  };
  limited.jobs.register('grade', () => { throw new Error('grade must not start'); });
  limited.jobs.register('extract', (id, signal) => extractMaterial(store, { extract: async () => extraction }, id, signal, undefined, limited.jobs));
  await limited.jobs.resume();
  await expect.poll(() => JSON.stringify(db.prepare('SELECT state, error FROM material_job WHERE id=?').get(saved.job.id)), { timeout: 5_000 }).toBe(JSON.stringify({ state: 'succeeded', error: null }));
  expect(db.prepare("SELECT count(*) n FROM material_job WHERE kind='grade'").get()).toEqual({ n: 0 });
  expect(db.prepare('SELECT count(*) n FROM material_grade').get()).toEqual({ n: 0 });
  expect(store.listQuestions()).toHaveLength(1);
  expect(store.listQuestions()[0]!.itemId).toBeNull();
  expect(intakeVerdict(store.listQuestions()[0])).toEqual({ verdict: 'confirm', preselected: false });

  const paused = { enqueue() { throw new MobileRequestError(503, 'service_paused', '处理服务已暂停，请稍后重试。'); } } as unknown as MaterialJobs;
  const again = piece(saved.assetId, source.sourceHash, 'question', 'STEM-PAUSED', '2', { revision });
  const againWork = piece(saved.assetId, source.sourceHash, 'student_work', 'WRONG', '2', { revision });
  db.prepare("UPDATE material_job SET state='running' WHERE owner_id=? AND id=?").run(store.studentId, saved.job.id);
  await extractMaterial(store, { extract: async () => ({ ...extraction, fragments: [...extraction.fragments, again, againWork] }) }, saved.job.id, new AbortController().signal, undefined, paused);
  expect(store.listQuestions().some(item => item.stem.some(fragment => fragment.text === 'STEM-PAUSED'))).toBe(true);
  expect(db.prepare("SELECT count(*) n FROM material_job WHERE kind='grade'").get()).toEqual({ n: 0 });
  expect(intakeVerdict(store.listQuestions().find(item => item.number === '2'))).toEqual({ verdict: 'confirm', preselected: false });
});

it('keeps workspace grading strict and lets a later workspace grade auto-file', async () => {
  const { store } = setup();
  const rt = await runtime(store);
  rt.jobs.register('grade', (id, signal) => gradeQuestion(store, gradingProvider(), id, signal));
  const asset = 'asset-workspace';
  store.db.prepare('INSERT INTO source_batch(id,student_id,created_at) VALUES (?,?,?)').run('batch-ws', 'a', '2026-11-21');
  store.db.prepare('INSERT INTO source_asset(id,batch_id,filename,mime,size,content_hash,storage_path,created_at) VALUES (?,?,?,?,?,?,?,?)').run('src-ws', 'batch-ws', 'synthetic.jpg', 'image/jpeg', 1, 'hash', '/synthetic.jpg', '2026-11-21');
  store.db.prepare('INSERT INTO material_asset(id,owner_id,capture_id,source_asset_id) VALUES (?,?,?,?)').run(asset, 'a', store.createCapture(randomUUID()).id, 'src-ws');
  const add = (number: string, text: string, check: Fragment['check']) => {
    const id = store.createQuestion({ number, subject: '数学' }).id;
    const stem = piece(asset, 'hash', 'question', text, number);
    const work = piece(asset, 'hash', 'student_work', 'WRONG', number, { check });
    store.putFragment(stem); store.putFragment(work);
    const attempt = store.createAttempt(id).id;
    store.linkFragment(stem.fragmentId, 1, { questionId: id, attemptId: null });
    store.linkFragment(work.fragmentId, 1, { questionId: id, attemptId: attempt });
    return id;
  };
  const ready = add('1', 'STEM-WORKSPACE', 'passed');
  const low = add('2', 'STEM-LOW', 'low');
  expect(requestGrades(store, rt.jobs, { requestId: randomUUID(), questionIds: [low] }).jobs).toEqual([]);
  const action = requestGrades(store, rt.jobs, { requestId: randomUUID(), questionIds: [ready] });
  expect(action.jobs).toHaveLength(1);
  expect((await settled(rt.jobs, action.jobs[0]!.id)).state).toBe('succeeded');
  const graded = readQuestion(store, ready)!;
  expect(graded.grades[0]!.result).toBe('incorrect');
  expect(graded.grades[0]!.source).toBeUndefined();
  expect(graded.itemId).toBeTruthy();
  expect(readQuestion(store, low)!.itemId).toBeNull();
  const intake = requestIntakeGrades(store, rt.jobs, asset);
  expect(intake).toBeUndefined();
  expect(store.db.prepare("SELECT count(*) n FROM material_job WHERE kind='grade' AND question_id=?").get(low)).toEqual({ n: 1 });
  expect((await settled(rt.jobs, (store.db.prepare("SELECT id FROM material_job WHERE kind='grade' AND question_id=?").get(low) as { id: string }).id)).state).toBe('succeeded');
  const provisional = readQuestion(store, low)!;
  expect(provisional.grades[0]).toMatchObject({ result: 'incorrect', source: 'intake' });
  expect(provisional.itemId).toBeNull();
  expect(intakeVerdict(provisional)).toEqual({ verdict: 'wrong', preselected: true });
});
