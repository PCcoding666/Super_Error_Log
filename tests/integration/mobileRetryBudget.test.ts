/**
 * 自动重试预算统一（Task 01-C）：真实适配器 + service + 合成 HTTP 故障服务器。
 * 旧结构：适配器内 while(attempt<3) 自转 × service 外层退避重试 → 同阶段最多 9 次调用。
 * 新预算：同一识别轮次、同一题目及阶段，累计最多 3 次模型调用（首次 + 两次重试），不跨层相乘。
 * 全部走真实 HTTP 边界（本地合成服务器按模型名分流），不 stub MobileVisionBoundary 计数。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMobileApp } from '../../src/mobile/router.js';
import type { MobileRecognitionService } from '../../src/mobile/service.js';
import { BailianMobileVision } from '../../src/mobile/vision.js';
import { MobileRecognitionStore } from '../../src/mobile/store.js';
import { assembleCloudService } from '../../src/mobile/cloudAssembly.js';
import type { MobileConfiguration } from '../../src/mobile/configuration.js';
import { AdmissionController } from '../../src/mobile/admission.js';

const roots: string[] = [];
const servers: Server[] = [];
const services: MobileRecognitionService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.stop()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});

type RequestFn = (url: string, init?: RequestInit) => Promise<Response>;

const INVENTORY_OK = { candidates: [{ number: '1', box: { x: 0, y: 0, width: 1, height: 1 }, confidence: .8, selectionEvidence: 'marked_wrong', partial: false }], warnings: [], capacityReached: false };
const EVIDENCE_OK = { version: 1, questionNumber: '1', questionText: '求 x 的值。', subject: '数学', chapter: '', knowledgeTags: [], questionType: '计算',
  questionRegion: { x: 0, y: 0, width: 1, height: 1 }, requiresDiagram: false, regions: [], observations: [], uncertainties: [] };
const VERIFY_OK = { textComplete: true, questionCropComplete: true, questionCropPure: true, transcriptionMatches: true, diagramSafe: true, issues: [] };

interface SyntheticModelServer {
  baseUrl: string;
  calls: { inventory: number; transcribe: number; verify: number; ground: number };
  /** transcribe 前 N 次返回 503（之后正常）。 */
  failTranscribeTimes: number;
  /** verify 前 N 次返回 503（之后正常）。 */
  failVerifyTimes: number;
  verifyScript?: Array<'fail' | 'content' | 'pass'>;
  suspend?: keyof SyntheticModelServer['calls'];
  release?: () => void;
  failInventoryTimes?: number;
  candidates?: typeof INVENTORY_OK.candidates;
  suspendAtCall?: number;
}

/** 合成模型服务：按请求体里的模型名分流计数；503 模拟瞬时故障（非密钥、非真实调用）。 */
async function startModelServer(): Promise<SyntheticModelServer> {
  const state: SyntheticModelServer = { baseUrl: '', calls: { inventory: 0, transcribe: 0, verify: 0, ground: 0 }, failTranscribeTimes: 0, failVerifyTimes: 0 };
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as { model?: string; messages?: Array<{ content: any }> };
    const stage = (body.model ?? '').replace('-model', '') as keyof SyntheticModelServer['calls'];
    if (stage in state.calls) state.calls[stage] += 1;
    if (state.suspend === stage && (!state.suspendAtCall || state.calls[stage] === state.suspendAtCall)) await new Promise<void>(resolve => { state.release = resolve; });
    const scripted = stage === 'verify' ? state.verifyScript?.shift() : undefined;
    const transient = (stage === 'inventory' && state.calls.inventory <= (state.failInventoryTimes ?? 0)) || (stage === 'transcribe' && state.calls.transcribe <= state.failTranscribeTimes)
      || (stage === 'verify' && state.calls.verify <= state.failVerifyTimes);
    if (transient || scripted === 'fail') { res.writeHead(503).end('{"error":"busy"}'); return; }
    const candidatePart = body.messages?.flatMap(message => Array.isArray(message.content) ? message.content : []).find(part => part.type === 'text' && part.text.startsWith('{"candidate":'));
    const number = candidatePart ? JSON.parse(candidatePart.text).candidate.number : '1';
    const value = stage === 'inventory' ? { ...INVENTORY_OK, candidates: state.candidates ?? INVENTORY_OK.candidates } : stage === 'transcribe' || stage === 'ground' ? { ...EVIDENCE_OK, questionNumber: number } : scripted === 'content' ? { ...VERIFY_OK, textComplete: false, issues: ['缺少条件'] } : VERIFY_OK;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  state.baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  return state;
}

async function setup(model: SyntheticModelServer, dataDir?: string, genericBoundary = false) {
  const root = dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sel-mobile-budget-'));
  if (!dataDir) roots.push(root);
  const vision = new BailianMobileVision({ baseUrl: model.baseUrl, apiKey: 'synthetic-budget-key', timeoutMs: 2000, bailianOnly: false,
    models: { inventory: 'inventory-model', transcribe: 'transcribe-model', verify: 'verify-model', ground: 'ground-model' } });
  const boundary = genericBoundary ? { inventory: vision.inventory.bind(vision), recognizeQuestion: vision.recognizeQuestion.bind(vision) } : vision;
  const app = await createMobileApp({ dataDir: root, pairingToken: 'pairing-token-for-tests', vision: boundary });
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request: RequestFn = (url, init = {}) => fetch(`${base}${url}`, { ...init, headers: { authorization: 'Bearer pairing-token-for-tests', ...init.headers } });
  const service = app.locals.mobileRecognitionService as MobileRecognitionService;
  services.push(service);
  service.autoRetryDelaysMs = [10, 20]; // 预算语义不变，只压缩退避等待
  return { root, app, server, request, service };
}
async function jpeg(): Promise<Buffer> {
  return sharp({ create: { width: 24, height: 16, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
}
async function submit(request: RequestFn, bytes: Buffer, key = crypto.randomUUID()) {
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return request('/v1/recognitions', { method: 'POST', headers: { 'content-type': 'image/jpeg', 'idempotency-key': key, 'x-photo-name': 'budget.jpg' }, body });
}
async function json(response: Response) { return response.json() as Promise<any>; }
async function waitFor(request: RequestFn, id: string, status: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const body = await json(await request(`/v1/recognitions/${id}`));
    if (body.job.status === status) return body.job;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`等待任务进入 ${status} 超时`);
}

describe('自动重试预算统一（Task 01-C）', () => {
  it.each(['reservation', 'checkpoint', 'trace', 'generic-trace'] as const)('stop joins an already-started durable %s write before reopen', async kind => {
    const model = await startModelServer(); const first = await setup(model, undefined, kind === 'generic-trace');
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let entered = false;
    const rename = fs.promises.rename.bind(fs.promises);
    const blocked = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (!entered && String(to).startsWith(first.root) && (String(to).endsWith('/job.json') || String(to).includes('/attempts/'))) {
        const payload = JSON.parse(await fs.promises.readFile(from, 'utf8'));
        const match = kind === 'trace' || kind === 'generic-trace' ? String(to).includes('/attempts/') && payload.stage === 'transcribe'
          : String(to).endsWith('/job.json') && (kind === 'reservation'
            ? payload.attemptBudgets?.inventory?.rounds[0]?.reservations.length === 1
            : Object.keys(payload.questionCheckpoints ?? {}).length === 1);
        if (match) { entered = true; await gate; }
      }
      await rename(from, to);
    });
    let stopped: Promise<void> | undefined;
    try {
      const accepted = await json(await submit(first.request, await jpeg()));
      await vi.waitFor(() => expect(entered).toBe(true));
      let settled = false; stopped = first.service.stop().then(() => { settled = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled, 'stop returned while durable rename was still blocked').toBe(false);
      release(); await stopped; blocked.mockRestore();
      const before = (await first.service.store.getStoredJob(accepted.job.id))!;
      expect(before.attemptBudgets!.inventory!.rounds[0]!.reservations).toHaveLength(1);
      if (kind === 'checkpoint') expect(Object.values(before.questionCheckpoints)[0]?.nextStage).toBe('verify');
      const second = await setup(model, first.root);
      await waitFor(second.request, accepted.job.id, 'completed');
      if (kind === 'checkpoint') expect(model.calls.transcribe).toBe(1);
      const after = (await second.service.store.getStoredJob(accepted.job.id))!;
      expect(JSON.parse(fs.readFileSync(path.join(first.root, 'jobs', accepted.job.id, 'job.json'), 'utf8'))).toEqual(after);
    } finally { release(); await stopped; blocked.mockRestore(); }
  });

  it('stop joins the real adapter promise after abort, including its final settlement', async () => {
    const model = await startModelServer(); model.suspend = 'inventory';
    const first = await setup(model);
    let finish!: () => void; const finalGate = new Promise<void>(resolve => { finish = resolve; }); let entered = false;
    const inventory = first.service.vision.inventory.bind(first.service.vision);
    first.service.vision.inventory = async (...args) => {
      try { return await inventory(...args); }
      finally { entered = true; await finalGate; }
    };
    let stopped: Promise<void> | undefined;
    try {
      await json(await submit(first.request, await jpeg())); await vi.waitFor(() => expect(model.release).toBeTypeOf('function'));
      let settled = false; stopped = first.service.stop().then(() => { settled = true; });
      await vi.waitFor(() => expect(entered).toBe(true));
      expect(settled).toBe(false);
      finish(); await stopped;
    } finally { finish(); await stopped; model.release?.(); }
    expect(model.calls.transcribe).toBe(0);
  });

  it.each(['duplicate', 'empty'])('an %s current round identity requires manual recovery without erasing old evidence', async kind => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-round-id-')); roots.push(root);
    const bytes = await jpeg(); const store = await MobileRecognitionStore.open(root);
    const { job } = await store.createJob({ idempotencyKey: crypto.randomUUID(), photoName: 'ambiguous.jpg', sourceBytes: bytes, normalizedBytes: bytes });
    const file = path.join(root, 'jobs', job.id, 'job.json'); const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const id = kind === 'empty' ? '' : 'duplicate-round';
    const round = { id, reservations: [], retryCount: 0, retryNotBefore: null };
    const oldRounds = kind === 'empty' ? [round] : [round, { ...round, reservations: [1, 2, 3].map(n => ({ id: `used-${n}`, stage: 'inventory', reservedAt: new Date().toISOString() })) }];
    raw.attemptBudgets.inventory = { currentRoundId: id, rounds: oldRounds }; fs.writeFileSync(file, JSON.stringify(raw));
    const model = await startModelServer(); const instance = await setup(model, root);
    await vi.waitFor(async () => expect(['completed', 'failed']).toContain((await instance.service.getJob(job.id)).status));
    expect((await instance.service.getJob(job.id)).error).toMatchObject({ code: 'attempt_budget_unknown', recoverable: true });
    expect(model.calls.inventory).toBe(0);
    await instance.service.retry(job.id, null); await waitFor(instance.request, job.id, 'completed');
    const budget = (await instance.service.store.getStoredJob(job.id))!.attemptBudgets!.inventory!;
    expect(budget.rounds.slice(0, oldRounds.length)).toEqual(oldRounds);
    expect(budget.currentRoundId).not.toBe(id); expect(model.calls.inventory).toBe(1);
  });
  it('an upload suspended during image admission cannot create a job after stop', async () => {
    const model = await startModelServer(); const { service, request } = await setup(model);
    const admission = new AdmissionController(); service.useAdmission(admission);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let entered = false;
    const original = admission.withImage.bind(admission);
    admission.withImage = async section => { entered = true; await gate; return original(section); };
    const pending = submit(request, await jpeg());
    await vi.waitFor(() => expect(entered).toBe(true));
    await service.stop(); release();
    expect((await pending).status).toBe(503);
    expect(await service.listJobs()).toHaveLength(0); expect(model.calls.inventory).toBe(0);
  });
  it('production cloud close drains and cancels an active model request before returning', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-close-')); roots.push(root);
    const bytes = await jpeg(); const store = await MobileRecognitionStore.open(root);
    await store.createJob({ idempotencyKey: crypto.randomUUID(), photoName: 'close.jpg', sourceBytes: bytes, normalizedBytes: bytes });
    const model = await startModelServer(); model.suspend = 'inventory';
    const cloud = await assembleCloudService({ host: '127.0.0.1', port: 0, mode: 'cloud', dataDir: root, pairingToken: '',
      vision: { baseUrl: model.baseUrl, apiKey: 'synthetic', bailianOnly: false, timeoutMs: 1_800_000,
        models: { inventory: 'inventory-model', transcribe: 'transcribe-model', verify: 'verify-model', ground: 'ground-model' } } } as unknown as MobileConfiguration);
    try {
      await cloud.listen(); await vi.waitFor(() => expect(model.release).toBeTypeOf('function'));
    } finally { await cloud.close(); model.release?.(); }
    expect(model.calls).toEqual({ inventory: 1, transcribe: 0, verify: 0, ground: 0 });
    expect(fs.existsSync(cloud.admin!.socketPath)).toBe(false);
  });
  it('a reserved request whose trace could not persist remains consumed after reopen', async () => {
    const model = await startModelServer(); model.failVerifyTimes = 100;
    const first = await setup(model);
    const original = first.service.store.writeAttempt.bind(first.service.store);
    first.service.store.writeAttempt = async (jobId, questionId, attempt: any) => {
      if (attempt.stage === 'verify') throw new Error('synthetic crash before trace persist');
      await original(jobId, questionId, attempt);
    };
    const accepted = await json(await submit(first.request, await jpeg()));
    await vi.waitFor(() => expect(first.service.isStorageAvailable()).toBe(false)); await first.service.stop();
    const saved = await first.service.store.getStoredJob(accepted.job.id);
    const questionId = saved!.questions[0]!.id;
    expect(saved!.attemptBudgets![questionId]!.rounds[0]!.reservations.filter(r => r.stage === 'verify')).toHaveLength(1);
    const second = await setup(model, first.root);
    await waitFor(second.request, accepted.job.id, 'failed');
    expect(model.calls.verify).toBe(3); expect(model.calls.transcribe).toBe(1);
  });

  it('manual inventory retry creates a durable new round and retains original traces', async () => {
    const model = await startModelServer(); model.failInventoryTimes = 100;
    const first = await setup(model);
    const accepted = await json(await submit(first.request, await jpeg()));
    await waitFor(first.request, accepted.job.id, 'failed');
    const before = (await first.service.store.getStoredJob(accepted.job.id))!.attemptBudgets!.inventory!;
    model.failInventoryTimes = 0; await first.service.retry(accepted.job.id, null);
    await waitFor(first.request, accepted.job.id, 'completed');
    const after = (await first.service.store.getStoredJob(accepted.job.id))!.attemptBudgets!.inventory!;
    expect(after.currentRoundId).not.toBe(before.currentRoundId); expect(after.rounds[0]).toEqual(before.rounds[0]);
    expect(after.rounds).toHaveLength(2);
    const traces = fs.readdirSync(path.join(first.root, 'jobs', accepted.job.id, 'attempts')).map(file => JSON.parse(fs.readFileSync(path.join(first.root, 'jobs', accepted.job.id, 'attempts', file), 'utf8')));
    expect(new Set(traces.filter(t => t.stage === 'inventory').map(t => t.roundId)).size).toBe(2);
  });

  it('manual failed-question retry starts a new round while its sibling is still processing', async () => {
    const model = await startModelServer(); model.candidates = [INVENTORY_OK.candidates[0]!, { ...INVENTORY_OK.candidates[0]!, number: '2' }];
    model.failTranscribeTimes = 1; model.suspend = 'transcribe'; model.suspendAtCall = 2;
    const first = await setup(model); first.service.autoRetryDelaysMs = [];
    const accepted = await json(await submit(first.request, await jpeg()));
    await vi.waitFor(() => expect(model.release).toBeTypeOf('function'));
    const before = (await first.service.store.getStoredJob(accepted.job.id))!; const id = before.questions[0]!.id;
    expect(before.questions.map(q => q.status)).toEqual(['failed', 'processing']);
    await first.service.retry(before.id, id);
    const during = (await first.service.store.getStoredJob(before.id))!;
    expect(during.attemptBudgets![id]!.rounds).toHaveLength(2);
    expect(during.attemptBudgets![id]!.rounds[0]).toEqual(before.attemptBudgets![id]!.rounds[0]);
    model.release!(); const done = await waitFor(first.request, before.id, 'completed');
    expect(done.questions.map((q: any) => q.status)).toEqual(['ready', 'ready']);
    expect(model.calls.transcribe).toBe(3);
  });
  it('reservation persist failure prevents the first actual HTTP request', async () => {
    const model = await startModelServer(); const { service, request } = await setup(model);
    const update = service.store.updateJob.bind(service.store);
    vi.spyOn(service.store, 'updateJob').mockImplementation(async (id, change) => update(id, job => {
      change(job);
      if ((JSON.stringify((job as any).attemptBudgets) ?? '').includes('reservedAt')) throw new Error('synthetic reservation EIO');
    }));
    await json(await submit(request, await jpeg()));
    await vi.waitFor(() => expect(service.isStorageAvailable()).toBe(false));
    expect(model.calls.inventory).toBe(0);
  });

  it.each(['missing', 'corrupt', 'primitive'])('legacy %s attempt budget stops automatic work and permits explicit retry', async kind => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-mobile-legacy-')); roots.push(root);
    const bytes = await jpeg(); const store = await MobileRecognitionStore.open(root);
    const { job } = await store.createJob({ idempotencyKey: crypto.randomUUID(), photoName: 'legacy.jpg', sourceBytes: bytes, normalizedBytes: bytes });
    const file = path.join(root, 'jobs', job.id, 'job.json'); const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (kind === 'missing') delete raw.attemptBudgets; else raw.attemptBudgets = kind === 'primitive' ? 42 : { inventory: { rounds: 'corrupt' } };
    fs.writeFileSync(file, JSON.stringify(raw));
    const model = await startModelServer(); const instance = await setup(model, root);
    const failed = await waitFor(instance.request, job.id, 'failed');
    expect(failed.error).toMatchObject({ code: 'attempt_budget_unknown', recoverable: true });
    expect(model.calls.inventory).toBe(0);
    await instance.service.retry(job.id, null);
    await waitFor(instance.request, job.id, 'completed'); expect(model.calls.inventory).toBe(1);
  });
  it('restart during backoff preserves deadline, reservations and completed transcribe', async () => {
    const model = await startModelServer(); model.failVerifyTimes = 100;
    const first = await setup(model); first.service.autoRetryDelaysMs = [300, 300];
    const accepted = await json(await submit(first.request, await jpeg()));
    await vi.waitFor(async () => expect((await first.service.getJob(accepted.job.id)).questions[0]).toMatchObject({ status: 'queued', error: { stage: 'verify' } }));
    expect(model.calls.verify).toBe(1);
    await first.service.stop();
    const second = await setup(model, first.root);
    await second.service.resumeIncompleteJobs();
    await second.service.resumeIncompleteJobs();
    expect((await second.service.getJob(accepted.job.id)).status).not.toBe('failed');
    expect(model.calls.verify).toBe(1);
    await waitFor(second.request, accepted.job.id, 'failed');
    expect(model.calls.verify).toBe(3); expect(model.calls.transcribe).toBe(1);
  });

  it('content corrections and transient failures share the same three verification attempts', async () => {
    const model = await startModelServer(); model.verifyScript = ['content', 'fail', 'content', 'pass'];
    const { request } = await setup(model);
    const accepted = await json(await submit(request, await jpeg()));
    const job = await waitFor(request, accepted.job.id, 'failed');
    expect(model.calls).toEqual({ inventory: 1, transcribe: 1, verify: 3, ground: 2 });
    expect(job.questions[0].error).toMatchObject({ code: 'attempt_budget_exhausted', recoverable: true });
    expect(job.questions[0].evidence.questionText).toBe(EVIDENCE_OK.questionText);
  });

  it.each(['inventory', 'transcribe', 'ground', 'verify'] as const)('stop cancels suspended %s and forbids the next HTTP stage', async stage => {
    const model = await startModelServer(); model.suspend = stage;
    model.candidates = [INVENTORY_OK.candidates[0]!, { ...INVENTORY_OK.candidates[0]!, number: '2' }];
    if (stage === 'ground') model.verifyScript = ['content'];
    const { request, service } = await setup(model);
    await json(await submit(request, await jpeg()));
    await vi.waitFor(() => expect(model.release).toBeTypeOf('function'));
    const stopped = service.stop(); expect(stopped).toBeInstanceOf(Promise); await stopped; model.release!();
    await service.resumeIncompleteJobs();
    expect(model.calls.verify).toBe(stage === 'ground' || stage === 'verify' ? 1 : 0);
    if (stage === 'inventory') expect(model.calls.transcribe).toBe(0);
    else expect(model.calls.transcribe).toBe(1);
  });

  it.each(['inventory', 'transcribe', 'ground', 'verify'] as const)('storage failure during suspended %s cancels work before another HTTP call', async stage => {
    const model = await startModelServer(); model.suspend = stage;
    model.candidates = [INVENTORY_OK.candidates[0]!, { ...INVENTORY_OK.candidates[0]!, number: '2' }];
    if (stage === 'ground') model.verifyScript = ['content'];
    const { request, service } = await setup(model);
    const accepted = await json(await submit(request, await jpeg()));
    await vi.waitFor(() => expect(model.release).toBeTypeOf('function'));
    service.store.readMedia = async () => { throw new Error('synthetic independent media EIO'); };
    await expect(service.getMedia(accepted.job.id, accepted.job.sourceMediaId)).rejects.toMatchObject({ code: 'storage_unavailable' });
    await service.stop(); model.release!();
    expect(model.calls.verify).toBe(stage === 'ground' || stage === 'verify' ? 1 : 0);
    expect(model.calls.transcribe).toBe(stage === 'inventory' ? 0 : 1);
  });
  it('持续瞬时失败：同一题目同一阶段累计模型调用不超过三次（首次+两次重试），不跨层相乘', async () => {
    const model = await startModelServer();
    model.failTranscribeTimes = 100; // transcribe 一直 503（持续瞬时故障）
    const { request } = await setup(model);
    const accepted = await json(await submit(request, await jpeg()));
    await waitFor(request, accepted.job.id, 'failed');
    // 旧结构：适配器内 3 次 × service 重试 3 轮 = 最多 9 次；预算统一后必须 ≤3。
    expect(model.calls.transcribe).toBeLessThanOrEqual(3);
    expect(model.calls.inventory).toBe(1);
  });

  it('一次瞬时失败后成功：恰好两次调用，不产生多余请求', async () => {
    const model = await startModelServer();
    model.failTranscribeTimes = 1; // 第一次 503，之后正常
    const { request } = await setup(model);
    const accepted = await json(await submit(request, await jpeg()));
    const done = await waitFor(request, accepted.job.id, 'completed');
    expect(done.questions[0].status).toBe('ready');
    expect(model.calls.transcribe).toBe(2); // 首次失败 + 一次重试成功
    expect(model.calls.verify).toBe(1);
  });

  it('持续瞬时失败后进入明确终态，保留人工重试入口', async () => {
    const model = await startModelServer();
    model.failVerifyTimes = 100; // transcribe 正常，verify 一直 503
    const { request } = await setup(model);
    const accepted = await json(await submit(request, await jpeg()));
    const failed = await waitFor(request, accepted.job.id, 'failed');
    expect(failed.questions[0].error).toMatchObject({ retryable: true });
    expect(model.calls.transcribe).toBe(1); // transcribe 一次成功，不被重跑
    expect(model.calls.verify).toBeLessThanOrEqual(3); // 失败阶段最多 3 次
    // 人工重试开启新轮次：预算重新可用
    model.failVerifyTimes = 0;
    const retry = await request(`/v1/recognitions/${failed.id}/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ questionId: failed.questions[0].id }) });
    expect(retry.status).toBe(202);
    const done = await waitFor(request, failed.id, 'completed');
    expect(done.questions[0].status).toBe('ready');
    expect(model.calls.transcribe).toBe(1); // 已完成阶段（断点持久化）不重跑
    expect(model.calls.verify).toBe(4); // 旧轮 3 次 + 新轮 1 次成功
  });

  it('看门狗恢复卡死任务不重复消耗已完成的阶段', async () => {
    const model = await startModelServer();
    model.failVerifyTimes = 100;
    const { root, request, service } = await setup(model);
    const accepted = await json(await submit(request, await jpeg()));
    await waitFor(request, accepted.job.id, 'failed');
    const verifyBefore = model.calls.verify;
    // 终态任务重复扫描：不得再发起任何模型调用
    await service.resumeIncompleteJobs();
    await service.resumeIncompleteJobs();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(model.calls.transcribe).toBe(1);
    expect(model.calls.verify).toBe(verifyBefore);
    expect(root).toBeTruthy();
  });
});
