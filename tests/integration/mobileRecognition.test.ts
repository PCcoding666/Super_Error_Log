import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import type { Evidence } from '../../src/ai/evidence.js';
import { createMobileApp } from '../../src/mobile/router.js';
import type { MobileRecognitionService } from '../../src/mobile/service.js';
import { MobileRecognitionStore } from '../../src/mobile/store.js';
import { BailianMobileVision, type InventoryCandidate, type MobileVisionBoundary, type VisionContext, type VisionQuestionResult } from '../../src/mobile/vision.js';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});

const box = { x: 0, y: 0, width: 1, height: 1 };
function evidence(number: string, uncertainty = false): Evidence {
  return { version: 1 as const, questionNumber: number, questionText: '求 x 的值。', subject: '数学' as const, chapter: '', knowledgeTags: [], questionType: '计算', questionRegion: box,
    requiresDiagram: false, regions: [], observations: [], uncertainties: uncertainty ? ['末尾字符不清'] : [] };
}
class FixtureVision implements MobileVisionBoundary {
  inventoryCalls = 0;
  questionCalls: string[] = [];
  candidates: InventoryCandidate[] = [
    { number: '1', box, selectionEvidence: 'marked_wrong', partial: false },
    { number: '2', box, selectionEvidence: 'unclear', partial: false },
  ];
  fail = new Set(['2']);
  checks = { textComplete: true, questionCropComplete: true, questionCropPure: true, transcriptionMatches: true, diagramSafe: true, issues: [] as string[] };
  active = 0;
  maximumActive = 0;
  delayMs = 0;
  transcribeCalls = 0;
  checkpointFailure = false;
  beforeCheckpoint: Promise<void> | null = null;
  afterCheckpoint: Promise<void> | null = null;
  recordSyntheticAttempt = false;
  resultEvidence: (number: string) => ReturnType<typeof evidence> = number => evidence(number);
  async inventory(_source: Buffer, _context: VisionContext) { this.inventoryCalls += 1; return { candidates: this.candidates, warnings: [] }; }
  async recognizeQuestion(source: Buffer, candidate: InventoryCandidate, context: VisionContext): Promise<VisionQuestionResult> {
    this.questionCalls.push(candidate.number); this.active += 1; this.maximumActive = Math.max(this.maximumActive, this.active);
    try {
      let extracted = context.resumeCheckpoint?.evidence;
      if (!extracted) {
        this.transcribeCalls += 1; extracted = this.resultEvidence(candidate.number);
        await this.beforeCheckpoint;
        await context.checkpoint?.({ evidence: extracted, verification: null, nextStage: 'verify', groundingPasses: 0 });
      }
      if (this.recordSyntheticAttempt) await context.recordAttempt?.({ stage: 'transcribe', attempt: 1, request: {}, responseRaw: '{}', httpStatus: 200, usage: { prompt_tokens: 1, completion_tokens: 1 }, error: null });
      await this.afterCheckpoint;
      if (this.checkpointFailure) throw Object.assign(new Error('合成校验失败'), { code: 'network', stage: 'verify', retryable: true });
      if (this.delayMs) await new Promise(resolve => setTimeout(resolve, this.delayMs));
      if (this.fail.has(candidate.number)) throw Object.assign(new Error('合成失败'), { code: 'network', stage: 'transcribe', retryable: true });
      return { evidence: extracted, verification: this.checks, questionCrop: source, diagramCrops: [] };
    } finally { this.active -= 1; }
  }
}
type RequestFn = (url: string, init?: RequestInit) => Promise<Response>;

async function setup(vision: MobileVisionBoundary, dataDir?: string) {
  const root = dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sel-mobile-http-'));
  if (!dataDir) roots.push(root);
  const token = 'pairing-token-for-tests';
  const app = await createMobileApp({ dataDir: root, pairingToken: token, vision });
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request: RequestFn = (url, init = {}) => fetch(`${base}${url}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });
  return { root, app, server, base, request };
}
async function jpeg(color = '#ffffff'): Promise<Buffer> {
  return sharp({ create: { width: 24, height: 16, channels: 3, background: color } }).jpeg().toBuffer();
}
async function submit(request: RequestFn, bytes: Buffer, key = crypto.randomUUID()) {
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return request('/v1/recognitions', { method: 'POST', headers: { 'content-type': 'image/jpeg', 'idempotency-key': key, 'x-photo-name': encodeURIComponent('练习 一.jpg') }, body });
}
async function json(response: Response) { return response.json() as Promise<any>; }
async function waitFor(request: RequestFn, id: string, status: string) {
  let last: any = null;
  for (let i = 0; i < 200; i += 1) {
    const body = await json(await request(`/v1/recognitions/${id}`));
    last = body.job;
    if (body.job.status === status) return body.job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`job ${id} did not reach ${status}; last=${JSON.stringify(last)}`);
}
async function waitForJob(request: RequestFn, id: string, predicate: (job: any) => boolean) {
  let last: any = null;
  for (let i = 0; i < 200; i += 1) {
    last = (await json(await request(`/v1/recognitions/${id}`))).job;
    if (predicate(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`job ${id} did not reach predicate; last=${JSON.stringify(last)}`);
}
async function waitForStorageUnavailable(request: RequestFn): Promise<Response> {
  let response = await request('/v1/health');
  for (let i = 0; i < 100 && response.status !== 503; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 10)); response = await request('/v1/health');
  }
  return response;
}

describe('mobile recognition HTTP contract', () => {
  it('requires the pairing token, validates raw JPEG requests and uses private no-store responses', async () => {
    const { base, request } = await setup(new FixtureVision());
    expect((await fetch(`${base}/v1/health`)).status).toBe(401);
    expect((await request('/v1/recognitions', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }, body: '{}' })).status).toBe(415);
    expect((await submit(request, Buffer.from('not jpeg'))).status).toBe(400);
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ffffff' } }).png().toBuffer();
    expect((await submit(request, png)).status).toBe(400);
    const health = await request('/v1/health');
    expect(await json(health)).toEqual({ version: 1, realVisionConfigured: true });
    expect(health.headers.get('cache-control')).toBe('private, no-store');
  });

  it('persists before 202, deduplicates concurrent retries, and reports idempotency conflicts', async () => {
    const vision = new FixtureVision(); const { request } = await setup(vision); const bytes = await jpeg(); const key = crypto.randomUUID();
    const [a, b] = await Promise.all([submit(request, bytes, key), submit(request, bytes, key)]);
    const [first, repeated] = await Promise.all([json(a), json(b)]);
    expect(a.status).toBe(202); expect(b.status).toBe(202);
    expect(first.job.id).toBe(repeated.job.id);
    expect(first.job.photoName).toBe('练习 一.jpg');
    expect((await submit(request, await jpeg('#ff0000'), key)).status).toBe(409);
    await waitFor(request, first.job.id, 'partial');
    expect(vision.inventoryCalls).toBe(1);
  });

  it('keeps successful candidates when another question fails and retries only the named failed question', async () => {
    const vision = new FixtureVision(); const { request } = await setup(vision); const accepted = await json(await submit(request, await jpeg()));
    const partial = await waitFor(request, accepted.job.id, 'partial');
    expect(partial.questions[0]).toMatchObject({ number: '1', status: 'ready', evidence: { questionText: '求 x 的值。' } });
    expect(partial.questions[1]).toMatchObject({ number: '2', status: 'failed' });
    const firstId = partial.questions[0].id;
    vision.fail.clear();
    const retry = await request(`/v1/recognitions/${partial.id}/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ questionId: partial.questions[1].id }) });
    expect(retry.status).toBe(202);
    const complete = await waitFor(request, partial.id, 'completed');
    expect(complete.questions[0]).toMatchObject({ id: firstId, status: 'ready', revision: partial.questions[0].revision });
    expect(vision.questionCalls).toEqual(['1', '2', '2']);
  });

  it('publishes a valid transcription checkpoint and retries only the unfinished verification stage', async () => {
    const vision = new FixtureVision(); vision.fail.clear(); vision.candidates = [vision.candidates[0]!]; vision.checkpointFailure = true;
    const { request } = await setup(vision); const accepted = await json(await submit(request, await jpeg())); const failed = await waitFor(request, accepted.job.id, 'failed');
    expect(failed.questions[0]).toMatchObject({ status: 'failed', evidence: { questionText: '求 x 的值。' }, verification: null, error: { stage: 'verify' } });
    expect(vision.transcribeCalls).toBe(1);
    vision.checkpointFailure = false;
    const retry = await request(`/v1/recognitions/${failed.id}/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ questionId: failed.questions[0].id }) });
    expect(retry.status).toBe(202);
    const completed = await waitFor(request, failed.id, 'completed');
    expect(completed.questions[0]).toMatchObject({ status: 'ready', evidence: { questionText: '求 x 的值。' } });
    expect(vision.transcribeCalls).toBe(1);
  });

  it('recovers a persisted next-stage checkpoint after restart without retranscribing', async () => {
    let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
    const firstVision = new FixtureVision(); firstVision.fail.clear(); firstVision.candidates = [firstVision.candidates[0]!]; firstVision.afterCheckpoint = blocked;
    const first = await setup(firstVision); const accepted = await json(await submit(first.request, await jpeg()));
    const processing = await waitForJob(first.request, accepted.job.id, job => job.questions[0]?.evidence?.questionText === '求 x 的值。' && job.questions[0]?.status === 'processing');
    const secondVision = new FixtureVision(); secondVision.fail.clear(); secondVision.candidates = [secondVision.candidates[0]!];
    const second = await setup(secondVision, first.root); const recovered = await json(await second.request(`/v1/recognitions/${processing.id}`));
    expect(recovered.job.questions[0]).toMatchObject({ status: 'failed', evidence: { questionText: '求 x 的值。' }, error: { code: 'interrupted' } });
    await second.request(`/v1/recognitions/${processing.id}/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ questionId: processing.questions[0].id }) });
    await waitFor(second.request, processing.id, 'completed');
    expect(secondVision.transcribeCalls).toBe(0);
    release();
    await waitFor(first.request, processing.id, 'completed');
  });

  it('rejects confirmation until every independent check passes, requires source comparison, and rejects stale revisions', async () => {
    const vision = new FixtureVision(); vision.candidates = [vision.candidates[0]!]; vision.checks = { ...vision.checks, transcriptionMatches: false, issues: ['转写不匹配'] };
    const { request } = await setup(vision); const accepted = await json(await submit(request, await jpeg())); const job = await waitFor(request, accepted.job.id, 'completed');
    const question = job.questions[0];
    const endpoint = `/v1/recognitions/${job.id}/questions/${question.id}/confirm`;
    expect((await request(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: question.revision, action: 'confirm', sourceCompared: true }) })).status).toBe(409);
    const skipped = await request(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: question.revision, action: 'skip' }) });
    expect(skipped.status).toBe(200);
    expect((await json(skipped)).job.questions[0].status).toBe('skipped');
    expect((await request(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: question.revision, action: 'skip' }) })).status).toBe(409);
  });

  it('accepts only one of two concurrent confirmations for the same question revision', async () => {
    const vision = new FixtureVision(); vision.fail.clear(); vision.candidates = [vision.candidates[0]!];
    const { request } = await setup(vision); const accepted = await json(await submit(request, await jpeg())); const job = await waitFor(request, accepted.job.id, 'completed');
    const question = job.questions[0]; const endpoint = `/v1/recognitions/${job.id}/questions/${question.id}/confirm`;
    const confirmation = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: question.revision, action: 'confirm', sourceCompared: true }) };
    const responses = await Promise.all([request(endpoint, confirmation), request(endpoint, confirmation)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
  });

  it('does not finalize a job while another retried question is still queued or processing', async () => {
    const vision = new FixtureVision(); vision.fail = new Set(['1', '2']); const { request } = await setup(vision); const accepted = await json(await submit(request, await jpeg())); const failed = await waitFor(request, accepted.job.id, 'failed');
    vision.fail.clear(); let releaseFirst!: () => void; const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const original = vision.recognizeQuestion.bind(vision);
    vision.recognizeQuestion = async (source, candidate, context) => { if (candidate.number === '1') await firstGate; return original(source, candidate, context); };
    await request(`/v1/recognitions/${failed.id}/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ questionId: failed.questions[0].id }) });
    await waitForJob(request, failed.id, job => job.questions[0].status === 'processing');
    await request(`/v1/recognitions/${failed.id}/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ questionId: failed.questions[1].id }) });
    releaseFirst();
    const inFlight = await waitForJob(request, failed.id, job => job.questions[0].status === 'ready' && ['queued', 'processing'].includes(job.questions[1].status));
    expect(inFlight).toMatchObject({ status: 'processing', phase: 'questions' });
    await waitFor(request, failed.id, 'completed');
  });

  it('rejects skip while a question is actively processing so completion cannot overwrite the user action', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const vision = new FixtureVision(); vision.fail.clear(); vision.candidates = [vision.candidates[0]!]; vision.afterCheckpoint = gate;
    const { request } = await setup(vision); const accepted = await json(await submit(request, await jpeg())); const active = await waitForJob(request, accepted.job.id, job => job.questions[0]?.status === 'processing');
    const response = await request(`/v1/recognitions/${active.id}/questions/${active.questions[0].id}/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: active.questions[0].revision, action: 'skip' }) });
    expect(response.status).toBe(409); release(); await waitFor(request, active.id, 'completed');
  });

  it('never confirms an edge-partial candidate even when it has no optional warning text', async () => {
    const vision = new FixtureVision(); vision.fail.clear(); vision.candidates = [{ number: '1', box, selectionEvidence: 'unclear', partial: true }];
    const { request } = await setup(vision); const accepted = await json(await submit(request, await jpeg())); const job = await waitFor(request, accepted.job.id, 'completed'); const question = job.questions[0];
    expect(question.status).toBe('needs_check');
    const response = await request(`/v1/recognitions/${job.id}/questions/${question.id}/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: question.revision, action: 'confirm', sourceCompared: true }) });
    expect(response.status).toBe(409);
  });

  it('blocks both disjoint same-number candidates collapsed onto one occurrence but allows a lone expanded box', async () => {
    const vision = new FixtureVision(); vision.fail.clear();
    vision.candidates = [
      { number: '4', box: { x: 0, y: 0, width: .4, height: 1 }, selectionEvidence: 'unmarked', partial: false },
      { number: '4', box: { x: .6, y: 0, width: .4, height: 1 }, selectionEvidence: 'unmarked', partial: false },
    ];
    vision.resultEvidence = number => ({ ...evidence(number), questionRegion: { x: 0, y: 0, width: .4, height: 1 } });
    const { request } = await setup(vision); const accepted = await json(await submit(request, await jpeg()));
    const job = await waitFor(request, accepted.job.id, 'completed');
    expect(job.questions.map((question: any) => question.status)).toEqual(['needs_check', 'needs_check']);
    expect(job.questions.map((question: any) => question.candidateBox)).toEqual([{ x: 0, y: 0, width: .4, height: 1 }, { x: .6, y: 0, width: .4, height: 1 }]);
    for (const question of job.questions) {
      expect(question.verification.issues.join('')).toContain('同题号');
      expect((await request(`/v1/recognitions/${job.id}/questions/${question.id}/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: question.revision, action: 'confirm', sourceCompared: true }) })).status).toBe(409);
    }
    const single = new FixtureVision(); single.fail.clear(); single.candidates = [vision.candidates[0]!];
    const other = await setup(single); const submitted = await json(await submit(other.request, await jpeg()));
    expect((await waitFor(other.request, submitted.job.id, 'completed')).questions[0].status).toBe('ready');
  });

  it('rejects wrong-occurrence ready results from the real adapter even when the synthetic verifier says all checks pass', async () => {
    const verified: any[] = []; const left = { x: 0, y: 0, width: .4, height: 1 }, right = { x: .6, y: 0, width: .4, height: 1 };
    const provider = http.createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw);
      if (body.model === 'verify') verified.push(JSON.parse(body.messages[1].content[0].text));
      const value = body.model === 'inventory'
        ? { candidates: [left, right].map(box => ({ number: '4', box, selectionEvidence: 'unmarked', partial: false })), warnings: [], capacityReached: false }
        : body.model === 'transcribe' ? { ...evidence('4'), questionRegion: left }
          : { textComplete: true, questionCropComplete: true, questionCropPure: true, transcriptionMatches: true, diagramSafe: true, issues: [] };
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }));
    });
    servers.push(provider); await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const vision = new BailianMobileVision({ baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`, apiKey: 'synthetic-key', timeoutMs: 2000, bailianOnly: false,
      models: { inventory: 'inventory', transcribe: 'transcribe', verify: 'verify', ground: 'ground' } });
    const { request } = await setup(vision); const accepted = await json(await submit(request, await jpeg()));
    const job = await waitFor(request, accepted.job.id, 'completed');
    expect(job.questions.map((question: any) => question.status)).toEqual(['needs_check', 'needs_check']);
    expect(verified).toHaveLength(2);
    expect(new Set(verified.map(value => value.candidateId)).size).toBe(2);
    expect(verified.map(value => value.candidate.box.x).sort()).toEqual([0, .6]);
    expect(verified.every(value => value.evidence.questionRegion.x === 0)).toBe(true);
    for (const question of job.questions) expect((await request(`/v1/recognitions/${job.id}/questions/${question.id}/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: question.revision, action: 'confirm', sourceCompared: true }) })).status).toBe(409);
  });

  it.each(['invalid_output', 'authentication', 'permission', 'unsupported'])('explicitly recovers repaired %s at saved verify stage without automatic or sibling reruns', async code => {
    let repaired = false; const calls: Array<{ stage: string; number?: string }> = [];
    const provider = http.createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw);
      const stage = body.model; const input = JSON.parse(body.messages[1].content[0].text.startsWith('{') ? body.messages[1].content[0].text : '{}');
      const number = input.candidate?.number ?? input.evidence?.questionNumber;
      calls.push({ stage, number });
      if (stage === 'verify' && number === '2' && !repaired && code !== 'invalid_output') {
        res.writeHead(code === 'authentication' ? 401 : code === 'permission' ? 403 : 400).end('{"error":"synthetic repair needed"}'); return;
      }
      const value = stage === 'inventory' ? { candidates: [{ number: '1', box, selectionEvidence: 'unmarked', partial: false }, { number: '2', box, selectionEvidence: 'unmarked', partial: false }], warnings: [], capacityReached: false }
        : stage === 'transcribe' ? evidence(number)
          : stage === 'verify' && number === '2' && !repaired ? []
            : { textComplete: true, questionCropComplete: true, questionCropPure: true, transcriptionMatches: true, diagramSafe: true, issues: [] };
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }));
    });
    servers.push(provider); await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const adapter = () => new BailianMobileVision({ baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`, apiKey: 'synthetic-key', timeoutMs: 2000, bailianOnly: false,
      models: { inventory: 'inventory', transcribe: 'transcribe', verify: 'verify', ground: 'ground' } });
    const first = await setup(adapter()); const accepted = await json(await submit(first.request, await jpeg()));
    const job = await waitFor(first.request, accepted.job.id, 'partial');
    expect(job.questions[1].error).toMatchObject({ code, retryable: false, recoverable: true });
    expect(calls.filter(call => call.stage === 'verify' && call.number === '2')).toHaveLength(1);
    const attemptsDir = path.join(first.root, 'jobs', job.id, 'attempts');
    const retained = fs.readdirSync(attemptsDir).map(name => [name, fs.readFileSync(path.join(attemptsDir, name))] as const);
    (first.app.locals.mobileRecognitionService as MobileRecognitionService).stop();
    const reopened = await setup(adapter(), first.root); repaired = true;
    await new Promise(resolve => setTimeout(resolve, 35)); const count = calls.length;
    expect((await json(await reopened.request(`/v1/recognitions/${job.id}`))).job.questions[1].status).toBe('failed');
    const retry = await reopened.request(`/v1/recognitions/${job.id}/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ questionId: job.questions[1].id }) });
    expect(retry.status).toBe(202);
    const complete = await waitFor(reopened.request, job.id, 'completed');
    expect(calls.slice(count)).toEqual([{ stage: 'verify', number: '2' }]);
    expect(complete.questions[0]).toEqual(job.questions[0]);
    expect(complete.questions[1]).toMatchObject({ id: job.questions[1].id, status: 'ready' });
    for (const [name, bytes] of retained) expect(fs.readFileSync(path.join(attemptsDir, name))).toEqual(bytes);
  });

  it('recovers old inventory schema records explicitly while internal storage image and crop failures stay blocked', async () => {
    const vision = new FixtureVision(); vision.fail.clear();
    const inventory = vision.inventory.bind(vision); let broken = true;
    vision.inventory = async (...args) => {
      if (broken) throw Object.assign(new Error('合成空警告失败'), { code: 'invalid_output', stage: 'warning', retryable: false });
      return inventory(...args);
    };
    const first = await setup(vision); const submitted = await json(await submit(first.request, await jpeg()));
    const failed = await waitFor(first.request, submitted.job.id, 'failed');
    expect(failed.error).toMatchObject({ retryable: false, recoverable: true });
    broken = false;
    expect((await first.request(`/v1/recognitions/${failed.id}/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"questionId":null}' })).status).toBe(202);
    expect((await waitFor(first.request, failed.id, 'completed')).id).toBe(failed.id);
    const service = first.app.locals.mobileRecognitionService as MobileRecognitionService;
    for (const [code, stage] of [['internal', 'verify'], ['storage_unavailable', 'verify'], ['invalid_image', 'inventory'], ['invalid_output', 'crop']]) {
      await service.store.updateJob(failed.id, job => { job.phase = 'inventory'; job.status = 'failed'; job.error = { code: code!, stage: stage!, message: '合成不支持恢复', retryable: false }; });
      expect((await first.request(`/v1/recognitions/${failed.id}/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"questionId":null}' })).status).toBe(409);
    }
  });

  it('fails confirmation closed when the internal inventory candidate is missing', async () => {
    const vision = new FixtureVision(); vision.fail.clear(); vision.candidates = [vision.candidates[0]!];
    const { app, request } = await setup(vision); const accepted = await json(await submit(request, await jpeg())); const job = await waitFor(request, accepted.job.id, 'completed'); const question = job.questions[0];
    const service = app.locals.mobileRecognitionService as MobileRecognitionService;
    await service.store.updateJob(job.id, stored => { delete stored.inventoryCandidates[question.id]; });
    const response = await request(`/v1/recognitions/${job.id}/questions/${question.id}/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: question.revision, action: 'confirm', sourceCompared: true }) });
    expect(response.status).toBe(409);
  });

  it('requires a real allocated diagram crop when the evidence says the question needs a diagram', async () => {
    const vision = new FixtureVision(); vision.fail.clear(); vision.candidates = [vision.candidates[0]!];
    vision.resultEvidence = number => ({ ...evidence(number), requiresDiagram: true, regions: [{ id: 'd1', kind: 'diagram' as const, box, confidence: 1, cleanForPrint: false }] });
    const { request } = await setup(vision); const accepted = await json(await submit(request, await jpeg())); const job = await waitFor(request, accepted.job.id, 'completed'); const question = job.questions[0];
    expect(question).toMatchObject({ status: 'needs_check', diagramMediaIds: [] });
    const response = await request(`/v1/recognitions/${job.id}/questions/${question.id}/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: question.revision, action: 'confirm', sourceCompared: true }) });
    expect(response.status).toBe(409);
  });

  it('lists persisted jobs and serves only their allocated media IDs', async () => {
    const vision = new FixtureVision(); vision.candidates = [vision.candidates[0]!]; const { request } = await setup(vision); const accepted = await json(await submit(request, await jpeg()));
    const job = await waitFor(request, accepted.job.id, 'completed');
    const listed = await json(await request('/v1/recognitions'));
    expect(listed.jobs.map((item: any) => item.id)).toContain(job.id);
    const media = await request(`/v1/recognitions/${job.id}/media/${job.questions[0].questionMediaId}`);
    expect(media.status).toBe(200); expect(media.headers.get('content-type')).toBe('image/jpeg'); expect((await media.arrayBuffer()).byteLength).toBeGreaterThan(10);
    expect((await request(`/v1/recognitions/${job.id}/media/..%2Fjob.json`)).status).toBe(404);
  });

  it('runs one photo job with only one simultaneous per-question model boundary (Task 3 concurrency=1)', async () => {
    const vision = new FixtureVision(); vision.fail.clear(); vision.delayMs = 30;
    vision.candidates = Array.from({ length: 5 }, (_, index) => ({ number: String(index + 1), box, selectionEvidence: 'unmarked' as const, partial: false }));
    const { request } = await setup(vision); const accepted = await json(await submit(request, await jpeg())); await waitFor(request, accepted.job.id, 'completed');
    // Task 3：逐题并发降为 1（云端 2GB 机器资源保护；回环同样收敛）。
    expect(vision.maximumActive).toBe(1);
  });

  it('marks unfinished work interrupted after process restart and never calls vision until explicit retry', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-mobile-restart-')); roots.push(root); const bytes = await jpeg();
    const store = await MobileRecognitionStore.open(root); const { job } = await store.createJob({ idempotencyKey: crypto.randomUUID(), photoName: 'restart.jpg', sourceBytes: bytes, normalizedBytes: bytes });
    job.status = 'processing'; await store.saveJob(job);
    const vision = new FixtureVision(); const { request } = await setup(vision, root);
    const recovered = await json(await request(`/v1/recognitions/${job.id}`));
    expect(recovered.job.status).toBe('interrupted'); expect(vision.inventoryCalls).toBe(0);
    const retry = await request(`/v1/recognitions/${job.id}/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ questionId: null }) });
    expect(retry.status).toBe(202);
    await waitFor(request, job.id, 'partial'); expect(vision.inventoryCalls).toBe(1);
  });

  it('marks pending questions interrupted even if a stale parent status says completed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-mobile-stale-parent-')); roots.push(root); const bytes = await jpeg(); const store = await MobileRecognitionStore.open(root);
    const { job } = await store.createJob({ idempotencyKey: crypto.randomUUID(), photoName: 'stale.jpg', sourceBytes: bytes, normalizedBytes: bytes });
    job.status = 'completed'; job.phase = 'complete'; job.questions = [{ id: crypto.randomUUID(), number: '1', revision: 1, status: 'processing', selectionEvidence: 'unmarked', evidence: null, verification: null, questionMediaId: null, diagramMediaIds: [], error: null, confirmedAt: null }];
    await store.saveJob(job); const vision = new FixtureVision(); const { request } = await setup(vision, root); const recovered = await json(await request(`/v1/recognitions/${job.id}`));
    expect(recovered.job).toMatchObject({ status: 'interrupted', phase: 'questions', questions: [{ status: 'failed', error: { code: 'interrupted' } }] });
    expect(vision.inventoryCalls).toBe(0);
  });

  it('stops reporting healthy or accepting submissions after an asynchronous storage fault', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const vision = new FixtureVision(); vision.afterCheckpoint = gate;
    const { root, request } = await setup(vision); const accepted = await json(await submit(request, await jpeg()));
    await waitForJob(request, accepted.job.id, job => job.questions[0]?.status === 'processing');
    fs.renameSync(path.join(root, 'jobs', accepted.job.id), path.join(root, 'jobs', `${accepted.job.id}.unavailable`)); release();
    expect((await waitForStorageUnavailable(request)).status).toBe(503);
    expect((await submit(request, await jpeg('#ff0000'))).status).toBe(503);
  });

  it('fails closed on a question source read fault instead of saving it as an ordinary model failure', async () => {
    const vision = new FixtureVision(); vision.fail.clear(); vision.candidates = [vision.candidates[0]!]; const { app, request } = await setup(vision);
    const service = app.locals.mobileRecognitionService as MobileRecognitionService; const readSource = service.store.readSource.bind(service.store); let reads = 0;
    service.store.readSource = async id => { reads += 1; if (reads === 2) throw Object.assign(new Error('synthetic EIO'), { code: 'EIO' }); return readSource(id); };
    await submit(request, await jpeg());
    expect((await waitForStorageUnavailable(request)).status).toBe(503);
  });

  it('fails closed on a question media write fault even if the later job record write would succeed', async () => {
    const vision = new FixtureVision(); vision.fail.clear(); vision.candidates = [vision.candidates[0]!]; const { app, request } = await setup(vision);
    const service = app.locals.mobileRecognitionService as MobileRecognitionService;
    service.store.writeMedia = async () => { throw Object.assign(new Error('synthetic EIO'), { code: 'EIO' }); };
    await submit(request, await jpeg());
    expect((await waitForStorageUnavailable(request)).status).toBe(503);
  });

  it('fails closed when retaining a model attempt hits storage EIO', async () => {
    const vision = new FixtureVision(); vision.fail.clear(); vision.candidates = [vision.candidates[0]!]; vision.recordSyntheticAttempt = true; const { app, request } = await setup(vision);
    const service = app.locals.mobileRecognitionService as MobileRecognitionService;
    service.store.writeAttempt = async () => { throw Object.assign(new Error('synthetic EIO'), { code: 'EIO' }); };
    await submit(request, await jpeg());
    expect((await waitForStorageUnavailable(request)).status).toBe(503);
  });

  it('preserves a real adapter attempt-write EIO as recoverable interrupted work after restart', async () => {
    const provider = http.createServer(async (providerRequest, providerResponse) => {
      let raw = ''; for await (const chunk of providerRequest) raw += chunk; const body = JSON.parse(raw);
      const value = body.model === 'inventory-model'
        ? { candidates: [{ number: '1', box, confidence: 1, selectionEvidence: 'marked_wrong', partial: false }], warnings: [], capacityReached: false }
        : body.model === 'transcribe-model' ? evidence('1')
          : body.model === 'ground-model' ? evidence('1')
            : { textComplete: true, questionCropComplete: true, questionCropPure: true, transcriptionMatches: true, diagramSafe: true, issues: [] };
      providerResponse.setHeader('content-type', 'application/json');
      providerResponse.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
    });
    servers.push(provider); await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const providerBaseUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
    const adapter = () => new BailianMobileVision({ baseUrl: providerBaseUrl, apiKey: 'synthetic-key', timeoutMs: 2000, bailianOnly: false,
      models: { inventory: 'inventory-model', transcribe: 'transcribe-model', verify: 'verify-model', ground: 'ground-model' } });
    const first = await setup(adapter()); const service = first.app.locals.mobileRecognitionService as MobileRecognitionService;
    const writeAttempt = service.store.writeAttempt.bind(service.store); let failQuestionAttempt = true;
    service.store.writeAttempt = async (jobId, questionId, record) => {
      if (questionId !== null && failQuestionAttempt) { failQuestionAttempt = false; throw Object.assign(new Error('synthetic EIO'), { code: 'EIO' }); }
      return writeAttempt(jobId, questionId, record);
    };
    const accepted = await json(await submit(first.request, await jpeg()));
    expect((await waitForStorageUnavailable(first.request)).status).toBe(503);
    await new Promise(resolve => setTimeout(resolve, 50));
    const beforeRestart = (await json(await first.request(`/v1/recognitions/${accepted.job.id}`))).job;
    expect(beforeRestart).toMatchObject({ status: 'processing', phase: 'questions', questions: [{ status: 'processing', error: null }] });
    const questionAttempts = fs.readdirSync(path.join(first.root, 'jobs', accepted.job.id, 'attempts')).filter(filename => filename.includes(beforeRestart.questions[0].id));
    expect(questionAttempts).toEqual([]);
    service.stop();
    const second = await setup(adapter(), first.root); const recovered = (await json(await second.request(`/v1/recognitions/${accepted.job.id}`))).job;
    expect(recovered).toMatchObject({ status: 'interrupted', phase: 'questions', questions: [{ status: 'failed', error: { code: 'interrupted', retryable: true } }] });
    const retry = await second.request(`/v1/recognitions/${accepted.job.id}/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ questionId: recovered.questions[0].id }) });
    expect(retry.status).toBe(202);
    await waitFor(second.request, accepted.job.id, 'completed');
  });

  it('fails closed when persisting a model checkpoint hits storage EIO', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const vision = new FixtureVision(); vision.fail.clear(); vision.candidates = [vision.candidates[0]!]; vision.beforeCheckpoint = gate; const { app, request } = await setup(vision);
    const service = app.locals.mobileRecognitionService as MobileRecognitionService; const accepted = await json(await submit(request, await jpeg()));
    await waitForJob(request, accepted.job.id, job => job.questions[0]?.status === 'processing');
    const updateJob = service.store.updateJob.bind(service.store); let failNext = true;
    service.store.updateJob = async (...args) => { if (failNext) { failNext = false; throw Object.assign(new Error('synthetic EIO'), { code: 'EIO' }); } return updateJob(...args); };
    release();
    expect((await waitForStorageUnavailable(request)).status).toBe(503);
  });

  it('fails closed when a public retry cannot persist its state transition', async () => {
    const vision = new FixtureVision(); vision.candidates = [vision.candidates[1]!];
    const { app, request } = await setup(vision); const accepted = await json(await submit(request, await jpeg())); const failed = await waitFor(request, accepted.job.id, 'failed');
    const service = app.locals.mobileRecognitionService as MobileRecognitionService;
    service.store.updateJob = async () => { throw new Error('synthetic disk fault'); };
    const retry = await request(`/v1/recognitions/${failed.id}/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ questionId: failed.questions[0].id }) });
    expect(retry.status).toBe(503);
    expect(await json(retry)).toEqual({ error: { code: 'storage_unavailable', message: '本地存储暂时不可用，未接受新的识别任务。' } });
    expect((await request('/v1/health')).status).toBe(503);
  });
});
