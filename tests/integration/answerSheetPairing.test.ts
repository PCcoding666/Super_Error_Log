import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
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
import { canonicalItem, formatGrain, itemGrain, itemHeading, pairingCandidateLabel, pairingCopy, readIntakePairing } from '../../src/materials/answerSheetPairing.js';
import { markedRight, notYetIncluded } from '../../src/materials/learning.js';
import { MobileRecognitionService } from '../../src/mobile/service.js';
import { MobileRecognitionStore } from '../../src/mobile/store.js';
import { AdmissionController } from '../../src/mobile/admission.js';
import type { CaptureHints, Extraction, Fragment } from '../../src/materials/contracts.js';
import { createMaterialProvider, type MaterialSource } from '../../src/materials/provider.js';

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
  return { db, store, jobs, uploads, captureId, jpeg };
}

function page(uploads: MaterialUploads, assetId: string, parts: Partial<Fragment>[]): Extraction {
  const sourceHash = uploads.source(assetId).sourceHash;
  return {
    assetId, revision: 1, document: { title: '合成练习', subject: '化学', date: null, printedCode: null, page: 1 }, warnings: [], runs: [],
    fragments: parts.map((part, order): Fragment => ({
      assetId, fragmentId: newId('mfr'), revision: 1, sourceHash, box: { x: 0, y: 0, width: 1, height: 1 },
      role: 'question', text: '合成题目', number: '1', subpart: null, page: 1, order, requiresDiagram: false, check: 'passed', uncertainties: [], ...part,
    })),
  };
}

describe('answer sheet paired with paper pages', () => {
  it('associates wrong items from an answer sheet with the matching numbers on two paper pages', async () => {
    const f = await fixture();
    const hints = (pageIndex: number, pageKind: 'answer_sheet' | 'paper'): CaptureHints => ({ captureMode: 'multi', pageIndex, pageCount: 3, pageKind });
    const sheet = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'sheet.jpg', bytes: await f.jpeg('#eee'), hints: hints(1, 'answer_sheet') });
    const paperA = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'paper-a.jpg', bytes: await f.jpeg('#fff'), hints: hints(2, 'paper') });
    const paperB = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'paper-b.jpg', bytes: await f.jpeg('#ddd'), hints: hints(3, 'paper') });
    // Printed pages 3 and 5 of a longer paper. Item 6 and item 15 are on the answer sheet only.
    const sheetPage = page(f.uploads, sheet.assetId, [
      { role: 'teacher_mark', text: '√', number: '1' },
      { role: 'teacher_mark', text: '×', number: '2' },
      { role: 'student_work', text: 'B', number: '2' },
      { role: 'student_work', text: 'C', number: '6' },
      { role: 'teacher_mark', text: '×', number: '6' },
      { role: 'teacher_mark', text: '×', number: '8' },
      { role: 'teacher_mark', text: '-1', number: '13.', subpart: '①' },
      { role: 'teacher_mark', text: '已阅', number: '14' },
      { role: 'student_work', text: '合成书写答案', number: '15' },
      { role: 'teacher_mark', text: '×', number: '15' },
      { role: 'teacher_mark', text: '×', number: '99' },
    ]);
    const firstPaper = page(f.uploads, paperA.assetId, [
      { text: '1. 下列物质属于氧化物的是。', number: '1', page: 3 },
      { text: '2. 下列实验操作正确的是。', number: '2', page: 3 },
      { role: 'diagram', text: '第2题装置图', number: '2', page: 3 },
      { role: 'student_work', text: '纸上的演算', number: '2', page: 3 },
      { role: 'diagram', text: '第8题装置图', number: '8', subpart: '1', page: 3 },
    ]);
    const secondPaper = page(f.uploads, paperB.assetId, [
      { text: '7. 水的组成。', number: '7', page: 5 },
      { text: '8. 实验室制取氧气。', number: '8', page: 5 },
      { text: '13.（6分）计算相对分子质量。', number: '13', page: 5 },
      { text: '14.（7分）解释现象。', number: '14', page: 5 },
    ]);
    await extractMaterial(f.store, { extract: async () => ({ ...sheetPage, set: [sheetPage, firstPaper, secondPaper] }) }, sheet.job.id, new AbortController().signal);
    const questions = f.store.listQuestions();
    const byNumber = (number: string) => questions.find(question => question.stem.some(fragment => fragment.role === 'question' && fragment.number === number))
      ?? questions.find(question => question.number === number);
    const right = byNumber('1')!;
    const wrong = byNumber('2')!;
    const plain = byNumber('7')!;
    const crossed = byNumber('8')!;
    const deducted = byNumber('13')!;
    const unclear = byNumber('14')!;
    const unmatched = byNumber('99')!;
    expect(right.stem[0]!.assetId).toBe(paperA.assetId);
    expect(right.teacherMarks[0]!.assetId).toBe(sheet.assetId);
    expect(wrong.stem[0]!.assetId).toBe(paperA.assetId);
    expect(deducted.stem[0]!.assetId).toBe(paperB.assetId);
    expect(deducted.teacherMarks[0]!.assetId).toBe(sheet.assetId);
    expect(right.teacherMarks.map(mark => mark.text)).toEqual(['√']);
    expect(markedRight(right)).toBe(true);
    expect(right.itemId).toBeNull();
    expect(wrong.itemId).toBeTruthy();
    expect(wrong.stem.map(fragment => fragment.role).sort()).toEqual(['diagram', 'question']);
    expect(wrong.stem.find(fragment => fragment.role === 'diagram')!.assetId).toBe(paperA.assetId);
    expect(wrong.teacherMarks.map(mark => mark.text)).toEqual(['×']);
    expect(wrong.teacherMarks[0]!.assetId).toBe(sheet.assetId);
    expect(wrong.attempts.flatMap(attempt => attempt.fragments.map(fragment => fragment.text)).sort()).toEqual(['B', '纸上的演算']);
    expect(wrong.attempts.flatMap(attempt => attempt.fragments).find(fragment => fragment.text === 'B')!.assetId).toBe(sheet.assetId);
    expect(wrong.attempts.flatMap(attempt => attempt.fragments).find(fragment => fragment.text === '纸上的演算')!.assetId).toBe(paperA.assetId);
    expect(crossed.itemId).toBeTruthy();
    expect(crossed.stem.map(fragment => fragment.role).sort()).toEqual(['diagram', 'question']);
    expect(crossed.stem.find(fragment => fragment.role === 'diagram')!.text).toBe('第8题装置图');
    expect(deducted.itemId).toBeTruthy();
    expect(deducted.teacherMarks.map(mark => mark.text)).toEqual(['-1']);
    expect(unclear.itemId).toBeNull();
    expect(plain.itemId).toBeNull();
    expect(unmatched.itemId).toBeNull();
    expect(unmatched.stem).toEqual([]);
    const objectiveOnly = byNumber('6')!;
    const writtenOnly = byNumber('15')!;
    for (const stemless of [objectiveOnly, writtenOnly, unmatched]) {
      expect(stemless.stem.filter(fragment => fragment.role === 'question')).toEqual([]);
      expect(stemless.itemId).toBeNull();
    }
    expect(objectiveOnly.attempts.flatMap(attempt => attempt.fragments.map(fragment => fragment.text))).toEqual(['C']);
    expect(objectiveOnly.teacherMarks.map(mark => mark.text)).toEqual(['×']);
    expect(writtenOnly.attempts.flatMap(attempt => attempt.fragments.map(fragment => fragment.text))).toEqual(['合成书写答案']);
    expect(writtenOnly.teacherMarks.map(mark => mark.text)).toEqual(['×']);
    expect(questions.some(question => question.stem.some(fragment => fragment.role === 'question' && ['6', '15', '99'].includes(fragment.number ?? '')))).toBe(false);
    const pending = notYetIncluded(f.store).flatMap(group => group.questions.map(question => question.id));
    expect(pending).toEqual(expect.arrayContaining([plain.id, unclear.id]));
    expect(pending).not.toEqual(expect.arrayContaining([right.id, wrong.id, crossed.id, deducted.id]));
    const pairing = readIntakePairing(f.store, questions);
    expect(pairing.verdicts.get(wrong.id)).toBe('wrong');
    expect(pairing.verdicts.get(deducted.id)).toBe('wrong');
    expect(pairing.verdicts.get(right.id)).toBe('right');
    expect(pairing.verdicts.get(unclear.id)).toBe('unclear');
    expect(pairing.unmatchedQuestions.has(plain.id)).toBe(true);
    expect(pairing.unmatchedMarks.map(mark => mark.number).sort()).toEqual(['15', '6', '99']);
    expect(pairing.unmatchedMarks.find(mark => mark.number === '15')).toMatchObject({ answers: ['合成书写答案'], verdict: 'wrong', text: '合成书写答案 · ×' });
    expect(pairing.unmatchedMarks.find(mark => mark.number === '6')).toMatchObject({ answers: ['C'], verdict: 'wrong' });
    expect(pairingCandidateLabel('7', 'unmatched')).toBe('第 7 题 · 答题卡没对上');
    expect(pairingCandidateLabel('14', 'unclear')).toBe('第 14 题 · 答题卡对上了，请核对');
    expect(pairingCandidateLabel('99', 'unmatched-mark')).toBe('第 99 题 · 答题卡没对上试卷');
    expect(pairingCandidateLabel('2', 'wrong')).toBe('第 2 题 · 答题卡标为错题');
    expect(pairingCopy(pairing, paperB.assetId, true).pickNote).toContain('答题卡');
    expect(pairingCopy(pairing, sheet.assetId, false).statusText).toContain('没对上试卷');
    expect(canonicalItem('13.', '①')).toEqual({ number: '13', subpart: '1' });
    expect(itemGrain('13', '（2）⑤')).toEqual({ number: '13', part: '2', blank: '5' });
    expect(formatGrain({ number: '13', part: '2', blank: '5' })).toBe('第 13 题（2）⑤');
  });

  it('builds one wrong item for the marked blank and does not mark sibling blanks wrong', async () => {
    const f = await fixture();
    const hints = (pageIndex: number, pageKind: 'answer_sheet' | 'paper'): CaptureHints => ({ captureMode: 'multi', pageIndex, pageCount: 2, pageKind });
    const sheet = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'sheet.jpg', bytes: await f.jpeg('#eee'), hints: hints(1, 'answer_sheet') });
    const paper = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'paper.jpg', bytes: await f.jpeg('#fff'), hints: hints(2, 'paper') });
    const sheetPage = page(f.uploads, sheet.assetId, [
      { role: 'student_work', text: '卡上第⑤空', number: '13', subpart: '（2）⑤' },
      { role: 'teacher_mark', text: '×', number: '13', subpart: '（2）⑤' },
      { role: 'student_work', text: '卡上第④空', number: '13', subpart: '（2）④' },
      { role: 'teacher_mark', text: '√', number: '13', subpart: '（2）④' },
    ]);
    const paperPage = page(f.uploads, paper.assetId, [
      { text: '13. 合成题干', number: '13', subpart: null },
      { text: '（2）合成小问', number: '13', subpart: '（2）' },
      { role: 'diagram', text: '合成图', number: '13', subpart: null },
      { role: 'student_work', text: '纸上第⑤空', number: '13', subpart: '（2）⑤' },
      { role: 'student_work', text: '纸上第④空', number: '13', subpart: '（2）④' },
    ]);
    await extractMaterial(f.store, { extract: async () => ({ ...sheetPage, set: [sheetPage, paperPage] }) }, sheet.job.id, new AbortController().signal);
    const questions = f.store.listQuestions();
    const wrong = questions.find(question => question.teacherMarks.some(mark => mark.text === '×'))!;
    const sibling = questions.find(question => question.teacherMarks.some(mark => mark.text === '√') || question.attempts.some(attempt => attempt.fragments.some(fragment => fragment.text.includes('④'))))!;
    expect(wrong.stem.map(fragment => fragment.text).sort()).toEqual(['（2）合成小问', '13. 合成题干', '合成图'].sort());
    expect(wrong.stem.filter(fragment => fragment.role === 'question').map(fragment => fragment.assetId)).toEqual([paper.assetId, paper.assetId]);
    expect(wrong.stem.find(fragment => fragment.role === 'diagram')!.assetId).toBe(paper.assetId);
    expect(wrong.teacherMarks.map(mark => mark.text)).toEqual(['×']);
    expect(wrong.attempts.flatMap(attempt => attempt.fragments.map(fragment => fragment.text)).sort()).toEqual(['卡上第⑤空', '纸上第⑤空']);
    expect(wrong.itemId).toBeTruthy();
    expect(itemHeading(wrong)).toBe('第 13 题（2）⑤');
    expect(sibling.id).not.toBe(wrong.id);
    expect(sibling.itemId).toBeNull();
    expect(sibling.teacherMarks.map(mark => mark.text)).not.toContain('×');
    expect(sibling.attempts.flatMap(attempt => attempt.fragments.map(fragment => fragment.text)).sort()).toEqual(['卡上第④空', '纸上第④空']);
    expect(markedRight(sibling) || sibling.teacherMarks.every(mark => mark.text !== '×')).toBe(true);
    expect(questions.some(question => question.stem.some(fragment => fragment.text.includes('编造')))).toBe(false);
    const pairing = readIntakePairing(f.store, questions);
    expect(pairing.verdicts.get(wrong.id)).toBe('wrong');
    expect(pairing.verdicts.get(sibling.id)).not.toBe('wrong');
  });

  it('still extracts the paper pages when the answer-sheet locate is invalid', async () => {
    const f = await fixture();
    const hints = (pageIndex: number, pageKind: 'answer_sheet' | 'paper'): CaptureHints => ({ captureMode: 'multi', pageIndex, pageCount: 3, pageKind });
    const sheet = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'sheet.jpg', bytes: await f.jpeg('#111'), hints: hints(1, 'answer_sheet') });
    const paperA = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'paper-a.jpg', bytes: await f.jpeg('#fff'), hints: hints(2, 'paper') });
    const paperB = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'paper-b.jpg', bytes: await f.jpeg('#ddd'), hints: hints(3, 'paper') });
    const calls: string[] = [];
    const server = http.createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw) as { messages: { content: { type: string; text?: string }[] }[] };
      const payload = JSON.parse(body.messages[1]!.content.find(part => part.type === 'text')!.text!) as { operation: string; source: MaterialSource; candidate?: { key: string }; submission?: { pageKind?: string | null } };
      calls.push(`${payload.operation}:${payload.source.assetId}`);
      const document = { title: null, subject: '化学', date: null, printedCode: null, page: 1 };
      const value = payload.operation === 'locate-set' && payload.submission?.pageKind === 'answer_sheet'
        ? { pages: [{ assetId: payload.source.assetId, document, candidates: [{ key: 'bad', role: 'teacher_mark', box: { x: 3, y: 0, width: 1, height: 0.2 }, number: '1', subpart: null, page: 1, order: 0, requiresDiagram: false }], warnings: [] }] }
        : payload.operation === 'locate-set'
          ? { pages: [{ assetId: payload.source.assetId, document, candidates: [{ key: 'q', role: 'question', box: { x: 0, y: 0, width: 1, height: 0.2 }, number: payload.source.assetId === paperA.assetId ? '3' : '5', subpart: null, page: 1, order: 0, requiresDiagram: false }], warnings: [] }] }
          : payload.operation === 'read'
            ? { source: payload.source, candidateKey: payload.candidate!.key, text: `合成题干 ${payload.source.assetId}`, uncertainties: [] }
            : { source: payload.source, candidateKey: payload.candidate!.key, check: 'passed', coverage: 'complete', textMatches: true, roleMatches: true, uncertainties: [] };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }], usage: { prompt_tokens: 10, completion_tokens: 20 } }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const port = (server.address() as { port: number }).port;
    const chat = { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'synthetic', timeoutMs: 5000, bailianOnly: false, models: { material_extract: 'extract', material_verify: 'verify', material_answer: 'answer', material_grade: 'grade' } };
    const source = { assetId: sheet.assetId, revision: 1, sourceHash: f.uploads.source(sheet.assetId).sourceHash };
    const provider = createMaterialProvider({ mode: 'openai', chat }, { source, request: async (_key, invoke) => invoke(new AbortController().signal) });
    await expect(extractMaterial(f.store, provider, sheet.job.id, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_output' });
    expect(calls.filter(call => call.startsWith('locate-set:')).map(call => call.slice('locate-set:'.length)).sort()).toEqual([sheet.assetId, paperA.assetId, paperB.assetId].sort());
    expect(f.db.prepare('SELECT extraction_json FROM material_asset WHERE id=?').get(sheet.assetId)).toEqual({ extraction_json: null });
    const stored = (id: string) => f.db.prepare('SELECT extraction_json,status FROM material_asset WHERE id=?').get(id) as { extraction_json: string; status: string };
    expect(stored(paperA.assetId).status).toBe('extracted');
    expect(stored(paperB.assetId).status).toBe('extracted');
    expect(stored(paperA.assetId).extraction_json).toContain('合成题干');
    expect(stored(paperB.assetId).extraction_json).toContain('合成题干');
    expect(f.jobs.get(paperA.job.id)?.state).toBe('succeeded');
    expect(f.jobs.get(paperB.job.id)?.state).toBe('succeeded');
    const questions = f.store.listQuestions();
    expect(questions.map(question => question.number).sort()).toEqual(['3', '5']);
    expect(questions.every(question => !question.itemId)).toBe(true);
    const pairing = readIntakePairing(f.store, questions);
    expect([...pairing.unmatchedQuestions].sort()).toEqual(questions.map(question => question.id).sort());
    expect(pairingCopy(pairing, paperA.assetId, false).statusText).toContain('答题卡没读全');
    expect(pairingCopy(pairing, paperA.assetId, false).pickNote).not.toContain('不确定');
  });

  it('keeps unmatched marks and paper questions confirmable', async () => {
    const f = await fixture();
    const hints = (pageIndex: number, pageKind: 'answer_sheet' | 'paper'): CaptureHints => ({ captureMode: 'multi', pageIndex, pageCount: 2, pageKind });
    const sheet = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'sheet.jpg', bytes: await f.jpeg('#eee'), hints: hints(1, 'answer_sheet') });
    const paper = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'paper.jpg', bytes: await f.jpeg('#fff'), hints: hints(2, 'paper') });
    const sheetPage = page(f.uploads, sheet.assetId, [{ role: 'teacher_mark', text: '×', number: '4' }]);
    const paperPage = page(f.uploads, paper.assetId, [{ text: '9. 合成题干，答题卡上没有这一题。', number: '9' }]);
    await extractMaterial(f.store, { extract: async () => ({ ...sheetPage, set: [sheetPage, paperPage] }) }, sheet.job.id, new AbortController().signal);
    const questions = f.store.listQuestions();
    const orphan = questions.find(question => question.number === '4')!;
    const missing = questions.find(question => question.stem.some(fragment => fragment.number === '9'))!;
    expect(orphan.itemId).toBeNull();
    expect(orphan.stem).toEqual([]);
    expect(missing.itemId).toBeNull();
    expect(missing.teacherMarks).toEqual([]);
    const pairing = readIntakePairing(f.store, questions);
    expect(pairing.unmatchedMarks.map(mark => [mark.number, mark.verdict])).toEqual([['4', 'wrong']]);
    expect(pairing.unmatchedQuestions.has(missing.id)).toBe(true);
    expect(pairing.verdicts.has(missing.id)).toBe(false);
    expect(notYetIncluded(f.store).flatMap(group => group.questions.map(question => question.id))).toContain(missing.id);
    expect(pairingCandidateLabel(null, 'unmatched-mark')).toBe('题号不清 · 答题卡没对上试卷');
  });

  it('leaves a same-page worksheet unchanged', async () => {
    const f = await fixture();
    const paper = await f.uploads.save({ captureId: f.captureId, uploadId: randomUUID(), filename: 'worksheet.jpg', bytes: await f.jpeg('#abc'), hints: { captureMode: 'single' } });
    const worksheet = page(f.uploads, paper.assetId, [
      { text: '1. 求 x 的值。', number: '1' },
      { role: 'teacher_mark', text: '×', number: '1' },
    ]);
    await extractMaterial(f.store, { extract: async () => worksheet }, paper.job.id, new AbortController().signal);
    const before = f.store.listQuestions();
    expect(before).toHaveLength(1);
    expect(before[0]!.itemId).toBeTruthy();
    expect(before[0]!.teacherMarks.map(mark => mark.text)).toEqual(['×']);
    expect(before[0]!.stem).toHaveLength(1);
    const pairing = readIntakePairing(f.store, before);
    expect(pairing.byAsset.size).toBe(0);
    expect(pairing.verdicts.size).toBe(0);
    expect(pairing.unmatchedMarks).toEqual([]);
    expect(pairingCopy(pairing, paper.assetId, false)).toEqual({ statusText: null, pickNote: null });
    expect(f.store.listQuestions().map(question => question.id)).toEqual(before.map(question => question.id));
  });
});
