/** Read-only intake candidate details. Synthetic rows only; no model calls. */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { newId } from '../../src/db/connection.js';
import { migrateMaterials } from '../../src/materials/schema.js';
import { MaterialStore } from '../../src/materials/store.js';
import type { Fragment, Grade, ReferenceAnswer } from '../../src/materials/contracts.js';
import { MobileRecognitionService } from '../../src/mobile/service.js';
import { MobileRecognitionStore } from '../../src/mobile/store.js';
import { AdmissionController } from '../../src/mobile/admission.js';
import { createStudentApi } from '../../src/web/api.js';
import { readQuestion } from '../../src/materials/queries.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'intake-detail-'));
const db = new DatabaseSync(path.join(dir, 'app.db'));
db.exec('PRAGMA foreign_keys=ON');
db.exec(SCHEMA_SQL);
migrateMaterials(db);
db.exec("INSERT INTO student_profile(id,nickname,created_at) VALUES ('a','Synthetic A','2026-11-06'),('b','Synthetic B','2026-11-06')");
const store = new MaterialStore(db, 'a');
const other = new MaterialStore(db, 'b');

function addAsset(owner: MaterialStore, id: string): void {
  const batch = `${id}_bat`;
  const source = `${id}_src`;
  db.prepare('INSERT INTO source_batch(id,student_id,created_at) VALUES (?,?,?)').run(batch, owner.studentId, '2026-11-06 01:00:00');
  db.prepare('INSERT INTO source_asset(id,batch_id,filename,mime,size,content_hash,storage_path,created_at) VALUES (?,?,?,?,?,?,?,?)').run(source, batch, 'synthetic.jpg', 'image/jpeg', 1, 'hash', '/synthetic.jpg', '2026-11-06 01:00:00');
  const capture = owner.createCapture(id);
  db.prepare('INSERT INTO material_asset(id,owner_id,capture_id,source_asset_id,created_at) VALUES (?,?,?,?,?)').run(id, owner.studentId, capture.id, source, '2026-11-06 01:00:00');
}

function piece(asset: string, role: Fragment['role'], text: string, extra: Partial<Fragment> = {}): Fragment {
  return {
    assetId: asset, fragmentId: newId('mfr'), revision: 1, box: { x: 0, y: 0, width: 1, height: 1 }, sourceHash: 'hash',
    role, text, number: extra.number ?? '1', subpart: null, page: 1, order: 0, requiresDiagram: false, check: 'passed', uncertainties: [], ...extra,
  };
}

const asset = 'asset-a';
addAsset(store, asset);
const longStem = `1. PAGE-A-ONE ${'甲'.repeat(80)}`;
const richId = store.createQuestion({ number: '1', subject: '数学' }).id;
const plainId = store.createQuestion({ number: '2', subject: '数学' }).id;
const stem = piece(asset, 'question', longStem, { number: '1' });
const work = piece(asset, 'student_work', 'PAGE-A-WORK', { number: '1' });
const mark = piece(asset, 'teacher_mark', '已阅 PAGE-A-MARK', { number: '1' });
const reference = piece(asset, 'reference_answer', 'PAGE-A-ANSWER', { number: '1' });
const plain = piece(asset, 'question', '2. PAGE-A-TWO 看不清的式子', { number: '2', check: 'low', uncertainties: ['blurry'] });
for (const fragment of [stem, work, mark, reference, plain]) store.putFragment(fragment);
const attempt = store.createAttempt(richId).id;
store.linkFragment(stem.fragmentId, 1, { questionId: richId, attemptId: null });
store.linkFragment(work.fragmentId, 1, { questionId: richId, attemptId: attempt });
store.linkFragment(mark.fragmentId, 1, { questionId: richId, attemptId: null });
store.linkFragment(reference.fragmentId, 1, { questionId: richId, attemptId: null });
store.linkFragment(plain.fragmentId, 1, { questionId: plainId, attemptId: null });

const leakedModel = 'synthetic-model-should-not-leak';
const aiAnswer: ReferenceAnswer = {
  id: 'man_ai_detail', questionId: richId, subpart: null, revision: 1, source: 'ai', text: 'AI 已经有的答案',
  claimedSource: '课本第 12 页', fragmentIds: [], basisKey: 'synthetic', stale: true, run: null,
};
db.prepare('INSERT INTO material_answer(id,revision,owner_id,question_id,source,basis_key,dependencies_json,content_json,stale) VALUES (?,?,?,?,?,?,?,?,?)')
  .run(aiAnswer.id, 1, 'a', richId, 'ai', 'synthetic', '{}', JSON.stringify({ ...aiAnswer, run: { model: leakedModel } }), 1);
const grade: Grade = {
  id: 'grd_detail', attemptId: attempt, answerIds: [], basisKey: 'synthetic', result: 'incorrect',
  findings: [{ fragmentIds: [work.fragmentId], text: '移项时符号没有变。' }],
  score: { earned: 2, total: 6, rubricFragmentIds: [] }, stale: false,
  run: { stage: 'material_grade', model: leakedModel, durationMs: 0, promptTokens: null, completionTokens: null, maxTokens: 1, thinking: false, promptVersion: 'test' },
};
db.prepare('INSERT INTO material_grade(id,revision,owner_id,attempt_id,basis_key,dependencies_json,content_json,stale) VALUES (?,?,?,?,?,?,?,?)')
  .run(grade.id, 1, 'a', attempt, 'synthetic', '[]', JSON.stringify(grade), 0);

const richRevision = readQuestion(store, richId)!.revision;
const plainRevision = readQuestion(store, plainId)!.revision;

addAsset(other, 'asset-b');
const foreignId = other.createQuestion({ number: '9', subject: '数学' }).id;
const foreignStem = piece('asset-b', 'question', 'Only student B may read this stem.', { number: '9' });
other.putFragment(foreignStem);
other.linkFragment(foreignStem.fragmentId, 1, { questionId: foreignId, attemptId: null });
const foreignRevision = readQuestion(other, foreignId)!.revision;

let base = '';
let scheduler: MobileRecognitionService | undefined;
let server: ReturnType<express.Express['listen']> | undefined;

function fingerprint(): unknown {
  return {
    questions: db.prepare('SELECT id, revision FROM material_question ORDER BY id').all(),
    answers: db.prepare('SELECT count(*) n FROM material_answer').get(),
    grades: db.prepare('SELECT count(*) n FROM material_grade').get(),
    jobs: db.prepare('SELECT count(*) n FROM material_job').get(),
    inclusions: db.prepare('SELECT count(*) n FROM material_inclusion').get(),
    events: db.prepare('SELECT count(*) n FROM material_inclusion_event').get(),
    links: db.prepare('SELECT count(*) n FROM material_link_event').get(),
  };
}

beforeAll(async () => {
  const admission = new AdmissionController({ jobCapacity: 1, diskProbe: async () => 10n ** 12n });
  scheduler = new MobileRecognitionService(await MobileRecognitionStore.open(dir), { inventory: async () => ({ candidates: [], warnings: [], capacityReached: false }), recognizeQuestion: async () => { throw Error('unused'); } });
  scheduler.useAdmission(admission);
  const options = { studentHostWorker: true, service: scheduler, accountRoleOf: () => 'student' as const, inviteExpiresOf: () => null };
  const app = express();
  app.use('/s/api', createStudentApi({ mobileDataDir: dir, materials: store, service: scheduler, timeZone: 'Asia/Singapore', now: () => new Date('2026-11-06T03:00:00Z') }, options));
  app.use('/legacy/api', createStudentApi({ mobileDataDir: dir, service: scheduler, timeZone: 'Asia/Singapore', now: () => new Date('2026-11-06T03:00:00Z') }, options));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server!.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server!.close(() => resolve()));
  }
  if (scheduler) await scheduler.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function get(url: string): Promise<{ status: number; text: string; body: Record<string, unknown> }> {
  const response = await fetch(base + url, { headers: { accept: 'application/json' } });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as Record<string, unknown> };
}

it('returns the stored question, answer and judgment for an unsaved candidate and does not write', async () => {
  const before = fingerprint();
  const response = await get(`/s/api/intake/candidates/${richId}?revision=${richRevision}`);
  expect(response.status).toBe(200);
  expect(response.text).not.toContain(leakedModel);
  expect(response.body).toMatchObject({
    id: richId,
    revision: richRevision,
    label: '第 1 题',
    subject: '数学',
  });
  const stem = response.body.stem as { text: string; check: string }[];
  expect(stem.map(fragment => fragment.text).join('\n')).toBe(longStem);
  expect((response.body.work as { text: string }[]).map(line => line.text)).toEqual(['PAGE-A-WORK']);
  expect((response.body.marks as { text: string }[]).map(line => line.text)).toEqual(['已阅 PAGE-A-MARK']);
  const answers = response.body.answers as { text: string; source: string; stale: boolean; fromPhoto: boolean; claimedSource: string | null }[];
  expect(answers.filter(answer => answer.text === 'PAGE-A-ANSWER')).toEqual([{ text: 'PAGE-A-ANSWER', source: 'imported', stale: false, fromPhoto: true, claimedSource: null }]);
  expect(answers).toContainEqual({ text: 'AI 已经有的答案', source: 'ai', stale: true, fromPhoto: false, claimedSource: '课本第 12 页' });
  expect(response.body.grades).toEqual([{
    result: 'incorrect', findings: ['移项时符号没有变。'], score: { earned: 2, total: 6 }, stale: false,
  }]);
  expect(String(response.body.crop)).toMatch(/\/s\/materials\/fragments\/mfr_[0-9a-f]+\/crop\?revision=1/);
  expect(response.body.source).toBe(`/s/materials/assets/${asset}/image`);
  expect(readQuestion(store, richId)!.itemId).toBeNull();
  expect(fingerprint()).toEqual(before);
});

it('says when no answer or judgment exists and keeps the recognition uncertainty', async () => {
  const response = await get(`/s/api/intake/candidates/${plainId}?revision=${plainRevision}`);
  expect(response.status).toBe(200);
  expect(response.body.answers).toEqual([]);
  expect(response.body.grades).toEqual([]);
  expect(response.body.work).toEqual([]);
  expect(response.body.marks).toEqual([]);
  expect(response.body.stem).toMatchObject([{ text: '2. PAGE-A-TWO 看不清的式子', check: 'low', uncertainties: ['blurry'] }]);
});

it('rejects another student, a stale revision and a legacy workspace without copying the question', async () => {
  const before = fingerprint();
  const foreign = await get(`/s/api/intake/candidates/${foreignId}?revision=${foreignRevision}`);
  expect(foreign.status).toBe(404);
  expect(foreign.text).not.toContain('Only student B');
  expect(foreign.body).toMatchObject({ error: { code: 'not_found' } });
  const stale = await get(`/s/api/intake/candidates/${richId}?revision=${richRevision + 1}`);
  expect(stale.status).toBe(409);
  expect(stale.text).not.toContain('PAGE-A-ONE');
  expect(stale.body).toMatchObject({ error: { code: 'revision_conflict' } });
  const missing = await get(`/s/api/intake/candidates/${richId}`);
  expect(missing.status).toBe(400);
  const malformed = await get(`/s/api/intake/candidates/${encodeURIComponent('bad.id')}?revision=1`);
  expect(malformed.status).toBe(400);
  const legacy = await get(`/legacy/api/intake/candidates/${richId}?revision=${richRevision}`);
  expect(legacy.status).toBe(404);
  expect(legacy.text).not.toContain('PAGE-A-ONE');
  expect(fingerprint()).toEqual(before);
});
