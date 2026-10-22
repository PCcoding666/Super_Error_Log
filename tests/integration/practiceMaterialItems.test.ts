import crypto, { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDb, newId, now } from '../../src/db/connection.js';
import { localDayText } from '../../src/domain/calendarDay.js';
import { ensureStudentProfile } from '../../src/services/studentService.js';
import { MaterialStore } from '../../src/materials/store.js';
import { setQuestionIncluded } from '../../src/materials/learning.js';
import { createLearningPractice } from '../../src/learning/queries.js';
import { getPrintStatus, requestPrint } from '../../src/v2/printService.js';
import { practiceProgress, revealPracticeHint, savePracticeCursor } from '../../src/v2/practiceProgress.js';
import { attachWork, latestWork, recognizeWork } from '../../src/v2/practiceWork.js';
import { attachSubmission, confirmSubmission, recordReviewFailure, reviewSubmission, submissionState } from '../../src/v2/practiceSubmission.js';
import { getLearningReturnSummary, submitLearningReturns } from '../../src/v2/returnService.js';
import type { PracticeReviewer } from '../../src/ai/practiceReview.js';
import type { CoachProvider } from '../../src/ai/provider.js';
import type { Fragment } from '../../src/materials/contracts.js';

/**
 * Since material intake (#45) every web photo becomes a material-sourced item. The
 * practice loop (cursor, hints, per-item work, whole-task photo review, confirmation)
 * must accept those items, not only the legacy recognition source.
 * Synthetic data only; no model calls.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });
const coach: CoachProvider = { coachForPrint: async () => ({ hints: ['提示一', '提示二'], solution: '合成解析', answer: 'x=2', source: 'ai_generated' }) };

async function materialItems(count: number): Promise<string[]> {
  const db = getDb(), owner = ensureStudentProfile().id, store = new MaterialStore(db, owner);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'practice-material-')); dirs.push(dir);
  const id = newId('mas'), sourceId = newId('ast'), batch = newId('bat');
  const bytes = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
  fs.mkdirSync(path.join(dir, id));
  const file = path.join(dir, id, 'legacy-source.jpg'); fs.writeFileSync(file, bytes);
  const hash = createHash('sha256').update(bytes).digest('hex');
  db.prepare('INSERT INTO source_batch(id,student_id,created_at) VALUES(?,?,?)').run(batch, owner, now());
  db.prepare('INSERT INTO source_asset(id,batch_id,filename,mime,size,content_hash,storage_path,created_at) VALUES(?,?,?,?,?,?,?,?)').run(sourceId, batch, 'synthetic.jpg', 'image/jpeg', bytes.length, hash, file, now());
  const capture = store.createCapture(crypto.randomUUID());
  db.prepare('INSERT INTO material_asset(id,owner_id,capture_id,source_asset_id,status,upload_request_id) VALUES(?,?,?,?,?,?)').run(id, owner, capture.id, sourceId, 'legacy', null);
  return Array.from({ length: count }, (_, index) => {
    const q = store.createQuestion({ number: String(index + 1), subject: '数学' }).id;
    const f: Fragment = { assetId: id, fragmentId: newId('mfr'), revision: 1, sourceHash: hash, box: { x: .1, y: .1 + index * .25, width: .7, height: .2 }, role: 'question', text: `合成题 ${index + 1}：求解 x+${index}=${index + 2}`, number: String(index + 1), subpart: null, page: 1, order: index, requiresDiagram: false, check: 'passed', uncertainties: [] };
    store.putFragment(f);
    store.linkFragment(f.fragmentId, 1, { questionId: q, attemptId: null });
    return setQuestionIncluded(store, q, true, store.getQuestion(q)!.revision).itemId!;
  });
}
async function preparedPacket(count = 2) {
  const ids = await materialItems(count);
  const r = createLearningPractice({ itemIds: ids }, 'all');
  if (!r.ok) throw new Error(r.message);
  const pid = r.detail.id;
  expect(requestPrint(pid, coach, 'all').httpStatus).toBe(202);
  for (let i = 0; i < 400; i++) {
    const s = getPrintStatus(pid, 'all');
    if (s.httpStatus === 200 && s.body.status === 'ready') return { pid, ids };
    await new Promise(res => setTimeout(res, 5));
  }
  throw new Error('print timeout: ' + JSON.stringify(getPrintStatus(pid, 'all')));
}
const photo = () => sharp({ create: { width: 40, height: 40, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
const attempts = (pid: string) => (getDb().prepare('SELECT COUNT(*) n FROM review_attempt WHERE packet_id=?').get(pid) as { n: number }).n;

describe('practice loop for material-sourced items', () => {
  it('saves cursor, hints and per-item results for material items', async () => {
    const { pid, ids } = await preparedPacket(2);
    expect(() => savePracticeCursor(pid, ids[1]!)).not.toThrow();
    revealPracticeHint(pid, ids[1]!, 1);
    expect(practiceProgress(pid)).toMatchObject({ cursor: ids[1], hints: { [ids[1]!]: 1 } });
    const result = submitLearningReturns(pid, { results: [{ itemId: ids[0]!, completion: 'independent', correct: true, performedOn: localDayText(new Date()) }] }, 'all');
    expect(result).toMatchObject({ ok: true, results: [{ ok: true }] });
    expect(attempts(pid)).toBe(1);
    expect(getLearningReturnSummary(pid, 'all')).toMatchObject({ answered: 1, total: 2 });
    // Same-day correct is still not mastery.
    expect(getDb().prepare('SELECT status FROM error_item WHERE id=?').get(ids[0]!)).toEqual({ status: 'attempted' });
  });

  it('attaches per-item work photos for material items', async () => {
    const { pid, ids } = await preparedPacket(1);
    const work = await attachWork(pid, ids[0]!, crypto.randomUUID(), await photo());
    await recognizeWork(work.id, { recognize: async () => ({ text: 'x=2', uncertain: false }) });
    expect(latestWork(pid, ids[0]!)).toMatchObject({ status: 'ready', text: 'x=2' });
  });

  it('reviews a whole-task photo and confirms results for material items', async () => {
    const { pid, ids } = await preparedPacket(2);
    await attachSubmission(pid, crypto.randomUUID(), await photo());
    let seen = 0;
    const reviewer: PracticeReviewer = { review: async input => { seen = input.questions.length; return { findings: [{ questionNumber: 1, photoNumbers: [1], text: 'x=2', complete: true, uncertain: false, suggestedCorrect: true, feedback: '与参考答案一致。' }] }; } };
    await reviewSubmission(pid, reviewer);
    expect(seen).toBe(2);
    const state = submissionState(pid);
    expect(state.status).toBe('ready');
    expect(state.findings[0]?.itemId).toBe(ids[0]);
    const confirmed = confirmSubmission(pid, { revision: state.revision, performedOn: localDayText(new Date()), help: 'independent', results: [{ itemId: ids[0], outcome: 'correct' }, { itemId: ids[1], outcome: 'incorrect' }] });
    expect(confirmed).toMatchObject({ ok: true });
    expect(attempts(pid)).toBe(2);
  });

  it('logs a failed review and marks it failed instead of leaving it silently pending', async () => {
    const { pid } = await preparedPacket(1);
    await attachSubmission(pid, crypto.randomUUID(), await photo());
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken: PracticeReviewer = { review: async () => { throw new Error('synthetic provider failure'); } };
    await reviewSubmission(pid, broken);
    expect(submissionState(pid).status).toBe('failed');
    expect(log.mock.calls.flat().join(' ')).toContain('synthetic provider failure');

    // A job that rejects before its own handling (here: frozen questions missing).
    await attachSubmission(pid, crypto.randomUUID(), await photo());
    getDb().prepare('DELETE FROM v2_print_snapshot WHERE packet_id=?').run(pid);
    const job = reviewSubmission(pid, broken);
    await expect(job).rejects.toThrow();
    await job.catch(error => recordReviewFailure(pid, error));
    expect(submissionState(pid).status).toBe('failed');
    expect(log.mock.calls.flat().join(' ')).toContain(pid);
  });
});
