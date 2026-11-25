/** Issue #161: a fragment verify schema miss must not hide the questions that were already boxed. Synthetic pages only. */
import { afterEach, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import sharp from 'sharp';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { migrateMaterials } from '../../src/materials/schema.js';
import { MaterialStore } from '../../src/materials/store.js';
import { MaterialJobs } from '../../src/materials/jobs.js';
import { MaterialUploads } from '../../src/materials/uploads.js';
import { registerMaterialExtraction } from '../../src/materials/extraction.js';
import { questionIntakeVerdict } from '../../src/materials/learning.js';
import { MobileRecognitionService } from '../../src/mobile/service.js';
import { MobileRecognitionStore } from '../../src/mobile/store.js';
import { createStudentApi } from '../../src/web/api.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const models = { material_extract: 'm', material_verify: 'm', material_answer: 'm', material_grade: 'm' };

it('keeps usable questions, a teacher mark, and one card when some verify payloads are malformed', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fragment-verify-'));
  const db = new DatabaseSync(path.join(dir, 'app.db'));
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(SCHEMA_SQL);
  migrateMaterials(db);
  db.exec("INSERT INTO student_profile(id,nickname,created_at) VALUES ('student','Synthetic','2026-11-25')");
  const store = new MaterialStore(db, 'student');
  const scheduler = new MobileRecognitionService(await MobileRecognitionStore.open(dir), {
    inventory: async () => ({ candidates: [], warnings: [], capacityReached: false }),
    recognizeQuestion: async () => { throw new Error('unused'); },
  });
  const jobs = new MaterialJobs(store, scheduler, null);
  jobs.retryDelaysMs = [1, 2];
  const uploads = new MaterialUploads(store, jobs, null);
  cleanups.push(async () => { await scheduler.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); });

  const calls: string[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as { messages: { role: string; content: { type: string; text?: string }[] }[] };
    const context = JSON.parse(body.messages.find(message => message.role === 'user')!.content.find(part => part.type === 'text')!.text!) as {
      operation: string; source: { assetId: string; revision: number; sourceHash: string }; candidate?: { key: string };
    };
    const { operation, source, candidate } = context;
    calls.push(`${operation}:${candidate?.key ?? ''}`);
    const region = (key: string, role: string, order: number, number: string, y: number) => ({
      key, role, box: { x: 0.05, y, width: 0.7, height: 0.08 }, number, subpart: null, page: 1, order, requiresDiagram: false,
    });
    const passed = { check: 'passed', coverage: 'complete', textMatches: true, roleMatches: true, uncertainties: [] as string[] };
    let value: unknown;
    if (operation === 'locate') {
      value = {
        source,
        document: { title: null, subject: '数学', date: null, printedCode: null, page: 1 },
        candidates: [
          region('q1', 'question', 0, '1', 0.05),
          region('q1opt', 'question', 1, '1', 0.16),
          region('q2', 'question', 2, '2', 0.30),
          region('q2work', 'student_work', 3, '2', 0.42),
          region('q3', 'question', 4, '3', 0.55),
        ],
        warnings: [],
      };
    } else if (operation === 'read') {
      const text = candidate?.key === 'q1opt' ? 'A. 2  B. 4  C. 6  D. 8' : `Synthetic stem ${candidate?.key}`;
      value = { source, candidateKey: candidate?.key, text, uncertainties: [] };
    } else if (operation === 'verify' && candidate?.key === 'q1') {
      value = [{ candidateKey: 'q1', check: 'passed', uncertainties: [], bbox: { x: 0.05, y: 0.05, width: 0.7, height: 0.08 } }];
    } else if (operation === 'verify' && candidate?.key === 'q2') {
      value = [
        { candidateKey: 'q2', check: 'passed', uncertainties: [] },
        { role: 'teacher_mark', number: '2', text: '错', check: 'passed', uncertainties: [], bbox: { x: 0.82, y: 0.30, width: 0.08, height: 0.05 } },
        { role: 'student_work', number: '2', text: '未核的笔迹', bbox: { x: 0.2, y: 0.44, width: 0.2, height: 0.04 } },
      ];
    } else if (operation === 'verify' && candidate?.key === 'q3') {
      value = { nope: true };
    } else {
      value = { source, candidateKey: candidate?.key, ...passed };
    }
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const port = (server.address() as { port: number }).port;
  registerMaterialExtraction(store, jobs, uploads, {
    mode: 'openai',
    chat: { baseUrl: `http://127.0.0.1:${port}`, apiKey: 'synthetic', timeoutMs: 1000, bailianOnly: false, models },
  });
  const bytes = await sharp({ create: { width: 120, height: 160, channels: 3, background: '#fff' } }).png().toBuffer();
  const saved = await uploads.save({ captureId: store.createCapture(randomUUID()).id, uploadId: randomUUID(), filename: 'synthetic.png', bytes, hints: {} });
  await expect.poll(() => jobs.get(saved.job.id)?.state, { timeout: 15_000 }).toBe('succeeded');

  const row = db.prepare('SELECT extraction_json,status FROM material_asset WHERE id=?').get(saved.assetId) as { extraction_json: string; status: string };
  const extraction = JSON.parse(row.extraction_json) as { fragments: { role: string; number: string | null; text: string; check: string }[]; warnings: string[] };
  expect(row.status).toBe('partial');
  expect(extraction.warnings).toContain('fragment_unavailable:q3:invalid_output');
  const questionOne = extraction.fragments.filter(fragment => fragment.role === 'question' && fragment.number === '1');
  expect(questionOne).toHaveLength(2);
  expect(questionOne.find(fragment => fragment.text.includes('Synthetic stem'))).toMatchObject({ check: 'passed' });
  expect(questionOne.find(fragment => fragment.text.includes('A. 2'))).toMatchObject({ text: 'A. 2  B. 4  C. 6  D. 8', check: 'passed' });
  expect(extraction.fragments.find(fragment => fragment.role === 'teacher_mark')).toMatchObject({ text: '错', number: '2', check: 'passed' });
  expect(extraction.fragments.find(fragment => fragment.role === 'student_work' && fragment.text === '未核的笔迹')).toMatchObject({ check: 'unchecked' });
  expect(extraction.fragments.find(fragment => fragment.role === 'student_work' && fragment.number === '2')!.check).toBe('passed');
  expect(extraction.fragments.find(fragment => fragment.role === 'question' && fragment.number === '3')!.check).toBe('failed');
  expect(calls.filter(call => call === 'verify:q3')).toHaveLength(3);
  expect(calls.filter(call => call === 'verify:q1')).toHaveLength(1);
  expect(calls.filter(call => call === 'read:q1')).toHaveLength(1);

  const wrong = store.listQuestions().find(question => question.number === '2')!;
  expect(questionIntakeVerdict(store, wrong)).toEqual({ verdict: 'wrong', preselected: true });

  const app = express();
  app.use('/s/api', createStudentApi({
    mobileDataDir: dir, materials: store, service: scheduler, timeZone: 'Asia/Singapore', now: () => new Date(),
  }, { studentHostWorker: true, service: scheduler, materialsJobs: jobs, accountRoleOf: () => 'student', inviteExpiresOf: () => null }));
  const api = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => api.once('listening', resolve));
  cleanups.push(async () => { api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve())); });
  const response = await fetch(`http://127.0.0.1:${(api.address() as { port: number }).port}/s/api/intake`, { headers: { accept: 'application/json' } });
  expect(response.status).toBe(200);
  const intake = await response.json() as { photos: { state: string; statusText: string; candidates: { label: string; excerpt: string; verdict?: string; preselected?: boolean }[] }[] };
  expect(JSON.stringify(intake)).not.toContain('没整理成功');
  const photo = intake.photos.find(item => item.state !== 'finding')!;
  expect(photo.state).not.toBe('failed');
  expect(photo.statusText).not.toBe('没整理成功');
  expect(photo.candidates.filter(candidate => candidate.label === '第 1 题')).toHaveLength(1);
  expect(photo.candidates.some(candidate => candidate.excerpt.startsWith('A. 2'))).toBe(false);
});
