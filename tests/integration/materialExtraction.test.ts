import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import sharp from 'sharp';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { migrateMaterials } from '../../src/materials/schema.js';
import { MaterialStore } from '../../src/materials/store.js';
import { MaterialJobs } from '../../src/materials/jobs.js';
import { MaterialUploads } from '../../src/materials/uploads.js';
import { registerMaterialExtraction, extractMaterial } from '../../src/materials/extraction.js';
import type { MaterialProvider } from '../../src/materials/provider.js';
import { MobileRecognitionService } from '../../src/mobile/service.js';
import { MobileRecognitionStore } from '../../src/mobile/store.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'material-extract-'));
  const db = new DatabaseSync(path.join(dir, 'app.db')); db.exec('PRAGMA foreign_keys=ON'); db.exec(SCHEMA_SQL); migrateMaterials(db);
  db.exec("INSERT INTO student_profile(id,nickname,created_at) VALUES ('student','Synthetic','2026-10-20')");
  const store = new MaterialStore(db, 'student'); const captureId = store.createCapture(randomUUID()).id;
  const scheduler = new MobileRecognitionService(await MobileRecognitionStore.open(dir), { inventory: async () => ({ candidates: [], warnings: [], capacityReached: false }), recognizeQuestion: async () => { throw new Error('unused'); } });
  const jobs = new MaterialJobs(store, scheduler, null); jobs.retryDelaysMs = [1, 2]; const uploads = new MaterialUploads(store, jobs, null);
  cleanups.push(async () => { await scheduler.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const bytes = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#fff' } }).png().toBuffer();
  return { db, store, scheduler, jobs, uploads, input: { captureId, uploadId: randomUUID(), filename: 'synthetic.png', bytes, hints: {} } };
}

describe('material extraction persistence', () => {
  it('persists extraction and source fragments before invoking reconciliation, without grouping or paid actions', async () => {
    const f = await fixture(); const reconciled: string[] = [];
    registerMaterialExtraction(f.store, f.jobs, f.uploads, { mode: 'mock' }, async assetId => {
      expect(f.db.prepare('SELECT count(*) n FROM material_fragment').get()).toMatchObject({ n: 3 }); reconciled.push(assetId);
    });
    const saved = await f.uploads.save(f.input);
    await expect.poll(() => f.jobs.get(saved.job.id)?.state).toBe('succeeded');
    const row = f.db.prepare('SELECT extraction_json,status FROM material_asset WHERE id=?').get(saved.assetId) as { extraction_json: string; status: string };
    const extraction = JSON.parse(row.extraction_json);
    expect(row.status).toBe('extracted'); expect(extraction.assetId).toBe(saved.assetId); expect(reconciled).toEqual([saved.assetId]);
    expect(extraction.fragments.map((v: any) => v.role)).toEqual(['question', 'student_work', 'reference_answer']);
    expect(extraction.fragments.every((v: any) => v.sourceHash === createHash('sha256').update(f.input.bytes).digest('hex'))).toBe(true);
    expect(f.store.listQuestions()).toEqual([]);
    expect(f.db.prepare('SELECT count(*) n FROM material_answer').get()).toMatchObject({ n: 0 });
    expect(f.db.prepare('SELECT count(*) n FROM material_grade').get()).toMatchObject({ n: 0 });
  });

  it('rejects invented source references and leaves incomplete material saved', async () => {
    const f = await fixture();
    const provider: MaterialProvider = { extract: async input => ({ assetId: input.assetId, revision: input.revision, document: { title: null, subject: null, date: null, printedCode: null, page: null }, fragments: [{ assetId: 'invented', sourceHash: 'invented', fragmentId: 'f', revision: 1, box: { x: 0, y: 0, width: 1, height: 1 }, role: 'student_work', text: 'synthetic', number: null, subpart: null, page: null, order: 0, requiresDiagram: false, check: 'passed', uncertainties: [] }], warnings: [], runs: [] }) };
    f.jobs.register('extract', (id, signal) => extractMaterial(f.store, provider, id, signal));
    const saved = await f.uploads.save(f.input); await expect.poll(() => f.jobs.get(saved.job.id)?.state).toBe('failed');
    expect(existsSync(f.uploads.source(saved.assetId).originalPath)).toBe(true);
    expect(f.db.prepare('SELECT status FROM material_asset WHERE id=?').get(saved.assetId)).toMatchObject({ status: 'saved' });
    expect(f.db.prepare('SELECT count(*) n FROM material_fragment').get()).toMatchObject({ n: 0 });
  });

  it('preserves verified siblings and reconciles partial material before retrying only unfinished requests', async () => {
    const f = await fixture(); let failSecond = true; const seen: string[] = []; const reconciled: number[] = [];
    const server = http.createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); const c = JSON.parse(body.messages[1].content[0].text); const { operation, source, candidate } = c;
      seen.push(`${operation}:${candidate?.key ?? ''}`);
      if (operation === 'verify' && candidate.key === 'second' && failSecond) { res.statusCode = 503; res.end('{}'); return; }
      const value = operation === 'locate' ? { source, document: { title: null, subject: null, date: null, printedCode: null, page: 1 }, candidates: ['first', 'second'].map((key, i) => ({ key, role: 'question', box: { x: 0, y: i / 2, width: 1, height: .5 }, number: String(i + 1), subpart: null, page: 1, order: i, requiresDiagram: false })), warnings: [] } : operation === 'read' ? { source, candidateKey: candidate.key, text: `Synthetic ${candidate.key}`, uncertainties: [] } : { source, candidateKey: candidate.key, check: 'passed', coverage: 'complete', textMatches: true, roleMatches: true, uncertainties: [] };
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    registerMaterialExtraction(f.store, f.jobs, f.uploads, { mode: 'openai', chat: { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, apiKey: 'synthetic', timeoutMs: 1000, bailianOnly: false, models: { material_extract: 'm', material_verify: 'm', material_answer: 'm', material_grade: 'm' } } }, (_asset, extraction) => { reconciled.push(extraction.fragments.length); });
    const saved = await f.uploads.save(f.input); await expect.poll(() => f.jobs.get(saved.job.id)?.state).toBe('failed');
    const partial = f.db.prepare('SELECT extraction_json,status FROM material_asset WHERE id=?').get(saved.assetId) as { extraction_json: string; status: string };
    expect(partial.status).toBe('partial'); expect(JSON.parse(partial.extraction_json).fragments).toHaveLength(1);
    expect(JSON.parse(partial.extraction_json).warnings).toContain('fragment_unavailable:second:provider_unavailable');
    expect(f.db.prepare('SELECT count(*) n FROM material_fragment').get()).toMatchObject({ n: 1 }); expect(reconciled).toEqual([1]);
    failSecond = false; f.jobs.retry(saved.job.id, randomUUID()); await expect.poll(() => f.jobs.get(saved.job.id)?.state).toBe('succeeded');
    expect(f.db.prepare('SELECT count(*) n FROM material_fragment').get()).toMatchObject({ n: 2 }); expect(reconciled).toEqual([1, 2]);
    expect(seen.filter(k => k === 'locate:')).toHaveLength(1); expect(seen.filter(k => k === 'read:first')).toHaveLength(1); expect(seen.filter(k => k === 'verify:first')).toHaveLength(1); expect(seen.filter(k => k === 'read:second')).toHaveLength(1); expect(seen.filter(k => k === 'verify:second')).toHaveLength(4);
  });

  it('appends a fragment revision when recovered diagram evidence changes completeness', async () => {
    const f = await fixture(); const saved = await f.uploads.save(f.input); let recovered = false;
    const fragment = { assetId: saved.assetId, sourceHash: f.uploads.source(saved.assetId).sourceHash, fragmentId: 'synthetic-fragment', revision: 1, box: { x: 0, y: 0, width: 1, height: .5 }, role: 'question' as const, text: 'synthetic question with diagram', number: '1', subpart: null, page: 1, order: 0, requiresDiagram: true, check: 'low' as const, uncertainties: ['missing_diagram'] };
    const provider: MaterialProvider = { extract: async () => ({ assetId: saved.assetId, revision: 1, document: { title: null, subject: null, date: null, printedCode: null, page: 1 }, fragments: recovered ? [{ ...fragment, check: 'passed', uncertainties: [] }, { ...fragment, fragmentId: 'synthetic-diagram', role: 'diagram', order: 1, check: 'passed', requiresDiagram: false, uncertainties: [] }] : [fragment], warnings: [], runs: [] }) };
    await extractMaterial(f.store, provider, saved.job.id, new AbortController().signal); recovered = true;
    await extractMaterial(f.store, provider, saved.job.id, new AbortController().signal);
    const revisions = f.db.prepare('SELECT revision,content_json FROM material_fragment WHERE id=? ORDER BY revision').all(fragment.fragmentId) as { revision: number; content_json: string }[];
    expect(revisions.map(r => r.revision)).toEqual([1, 2]); expect(JSON.parse(revisions[0]!.content_json).check).toBe('low'); expect(JSON.parse(revisions[1]!.content_json).check).toBe('passed');
    await extractMaterial(f.store, provider, saved.job.id, new AbortController().signal);
    expect(f.db.prepare('SELECT count(*) n FROM material_fragment WHERE id=?').get(fragment.fragmentId)).toMatchObject({ n: 2 });
    const row = f.db.prepare('SELECT extraction_json FROM material_asset WHERE id=?').get(saved.assetId) as { extraction_json: string };
    expect(JSON.parse(row.extraction_json).fragments[0].revision).toBe(2);
  });

  it('does not persist or reconcile extraction whose trusted source changed during processing', async () => {
    const f = await fixture(); const saved = await f.uploads.save(f.input); let reconciled = false; const originalHash = f.uploads.source(saved.assetId).sourceHash;
    const provider: MaterialProvider = { extract: async () => {
      f.db.prepare('UPDATE source_asset SET content_hash=? WHERE id=(SELECT source_asset_id FROM material_asset WHERE id=?)').run('changed-after-request', saved.assetId);
      return { assetId: saved.assetId, revision: 1, document: { title: null, subject: null, date: null, printedCode: null, page: null }, fragments: [{ assetId: saved.assetId, sourceHash: originalHash, fragmentId: 'synthetic-stale', revision: 1, box: { x: 0, y: 0, width: 1, height: 1 }, role: 'student_work', text: 'synthetic', number: null, subpart: null, page: null, order: 0, requiresDiagram: false, check: 'passed', uncertainties: [] }], warnings: [], runs: [] };
    } };
    await extractMaterial(f.store, provider, saved.job.id, new AbortController().signal, () => { reconciled = true; });
    expect(f.jobs.get(saved.job.id)?.state).toBe('stale'); expect(reconciled).toBe(false);
    expect(f.db.prepare('SELECT extraction_json FROM material_asset WHERE id=?').get(saved.assetId)).toMatchObject({ extraction_json: null });
  });

  it.each(['transient', 'invalid_output'])('binds every actual HTTP request and reuses checkpoints after %s failure', async failureKind => {
    const f = await fixture(); let verificationFails = true; const seen: string[] = []; let jobId = '';
    const server = http.createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); const context = JSON.parse(body.messages.find((m: any) => m.role === 'user').content.find((p: any) => p.type === 'text').text);
      const { operation, source, candidate } = context; seen.push(operation);
      const stages = Object.values(f.jobs.execution(jobId).stages); expect(stages.filter(s => s.state === 'running')).toHaveLength(1);
      expect(stages.some(s => s.attempts >= 1)).toBe(true);
      if (operation === 'verify' && verificationFails) {
        if (failureKind === 'transient') { res.statusCode = 503; res.end('{}'); }
        else res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ source, candidateKey: 'invented' }) } }] }));
        return;
      }
      const value = operation === 'locate' ? { source, document: { title: null, subject: null, date: null, printedCode: null, page: null }, candidates: [{ key: 'q', role: 'question', box: { x: 0, y: 0, width: 1, height: 1 }, number: '1', subpart: null, page: null, order: 0, requiresDiagram: false }], warnings: [] } : operation === 'read' ? { source, candidateKey: candidate.key, text: 'synthetic stem', uncertainties: [] } : { source, candidateKey: candidate.key, check: 'passed', coverage: 'complete', textMatches: true, roleMatches: true, uncertainties: [] };
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const saved = await f.uploads.save(f.input); jobId = saved.job.id;
    registerMaterialExtraction(f.store, f.jobs, f.uploads, { mode: 'openai', chat: { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, apiKey: 'synthetic', timeoutMs: 1000, bailianOnly: false, models: { material_extract: 'm', material_verify: 'm', material_answer: 'm', material_grade: 'm' } } });
    await f.jobs.resume(); await expect.poll(() => f.jobs.get(jobId)?.state).toBe('failed');
    const failedCalls = failureKind === 'transient' ? ['locate', 'read', 'verify', 'verify', 'verify'] : ['locate', 'read', 'verify'];
    expect(seen).toEqual(failedCalls);
    verificationFails = false; f.jobs.retry(jobId, randomUUID()); await expect.poll(() => f.jobs.get(jobId)?.state).toBe('succeeded');
    expect(seen).toEqual([...failedCalls, 'verify']);
    const row = f.db.prepare('SELECT extraction_json FROM material_asset WHERE id=?').get(saved.assetId) as { extraction_json: string };
    expect(JSON.parse(row.extraction_json).fragments[0].sourceHash).toBe(f.uploads.source(saved.assetId).sourceHash);
  });
});
