/**
 * 识别队列自愈与自动重试（2026-09-20：真实验收暴露「僵尸任务卡死无进展，只能手动重试」）。
 * 覆盖：可重试失败的自动退避重试（题级/清单级）、重试耗尽后落 failed、不可重试不重试、
 * 启动恢复扫描（从未入队的僵尸任务）、服务停收时 submit 明确 503 不产僵尸、终态任务不被重复处理。
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Evidence } from '../../src/ai/evidence.js';
import { createMobileApp } from '../../src/mobile/router.js';
import type { MobileRecognitionService } from '../../src/mobile/service.js';
import { MobileRecognitionStore } from '../../src/mobile/store.js';
import type { InventoryCandidate, MobileVisionBoundary, VisionQuestionResult } from '../../src/mobile/vision.js';

const roots: string[] = [];
const servers: Server[] = [];
const services: MobileRecognitionService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.stop()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});

const box = { x: 0, y: 0, width: 1, height: 1 };
function evidence(number: string): Evidence {
  return { version: 1 as const, questionNumber: number, questionText: '求 x 的值。', subject: '数学' as const, chapter: '', knowledgeTags: [], questionType: '计算', questionRegion: box,
    requiresDiagram: false, regions: [], observations: [], uncertainties: [] };
}
const CHECKS_OK = { textComplete: true, questionCropComplete: true, questionCropPure: true, transcriptionMatches: true, diagramSafe: true, issues: [] as string[] };
const retryableTimeout = () => Object.assign(new Error('合成瞬时超时'), { code: 'timeout', stage: 'transcribe', retryable: true });

class RecoveryVision implements MobileVisionBoundary {
  candidates: InventoryCandidate[] = [{ number: '1', box, selectionEvidence: 'marked_wrong', partial: false }];
  inventoryFailures: Error[] = [];
  questionFailures = new Map<string, Error[]>();
  inventoryCalls = 0;
  questionCalls: string[] = [];
  async inventory() {
    this.inventoryCalls += 1;
    const error = this.inventoryFailures.shift();
    if (error) throw error;
    return { candidates: this.candidates, warnings: [] };
  }
  async recognizeQuestion(source: Buffer, candidate: InventoryCandidate): Promise<VisionQuestionResult> {
    this.questionCalls.push(candidate.number);
    const queue = this.questionFailures.get(candidate.number);
    const error = queue?.shift();
    if (error) throw error;
    return { evidence: evidence(candidate.number), verification: { ...CHECKS_OK }, questionCrop: source, diagramCrops: [] };
  }
}

type RequestFn = (url: string, init?: RequestInit) => Promise<Response>;

async function setup(vision: MobileVisionBoundary, dataDir?: string) {
  const root = dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sel-mobile-recovery-'));
  if (!dataDir) roots.push(root);
  const app = await createMobileApp({ dataDir: root, pairingToken: 'pairing-token-for-tests', vision });
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request: RequestFn = (url, init = {}) => fetch(`${base}${url}`, { ...init, headers: { authorization: 'Bearer pairing-token-for-tests', ...init.headers } });
  const service = app.locals.mobileRecognitionService as MobileRecognitionService;
  services.push(service);
  service.autoRetryDelaysMs = [20, 50];
  return { root, app, server, request, service };
}
async function jpeg(): Promise<Buffer> {
  return sharp({ create: { width: 24, height: 16, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
}
async function submit(request: RequestFn, bytes: Buffer, key = crypto.randomUUID()) {
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return request('/v1/recognitions', { method: 'POST', headers: { 'content-type': 'image/jpeg', 'idempotency-key': key, 'x-photo-name': 'recovery.jpg' }, body });
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
async function waitForJob(request: RequestFn, id: string, predicate: (job: any) => boolean) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const body = await json(await request(`/v1/recognitions/${id}`));
    if (body.job && predicate(body.job)) return body.job;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('等待任务状态超时');
}

describe('识别队列自愈与自动重试', () => {
  it('overlapping recovery scans share execution ownership across a blocked persistence boundary', async () => {
    const vision = new RecoveryVision(); vision.questionFailures.set('1', [Object.assign(new Error('initial'), { code: 'invalid_output', stage: 'transcribe', retryable: false })]);
    const { request, service } = await setup(vision);
    const accepted = await json(await submit(request, await jpeg()));
    const failed = await waitFor(request, accepted.job.id, 'failed');
    await service.store.updateJob(failed.id, job => {
      job.status = 'interrupted'; job.phase = 'questions'; job.questions[0]!.error = { code: 'interrupted', stage: 'question', retryable: true, message: 'interrupted' };
    });
    vision.questionFailures.set('1', [retryableTimeout()]); service.autoRetryDelaysMs = [30_000, 30_000];
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let entered = false; const original = service.store.updateJob.bind(service.store);
    const spy = vi.spyOn(service.store, 'updateJob').mockImplementation(async (id, change) => {
      if (!entered) { entered = true; await gate; }
      return original(id, change);
    });
    const first = service.resumeIncompleteJobs();
    await vi.waitFor(() => expect(entered).toBe(true));
    const second = service.resumeIncompleteJobs(); release(); await Promise.all([first, second]); spy.mockRestore();
    await vi.waitFor(async () => expect((await service.getJob(failed.id)).questions[0]).toMatchObject({ status: 'queued', error: { code: 'timeout' } }));
    await service.resumeIncompleteJobs();
    expect(vision.questionCalls).toEqual(['1', '1']);
    await service.stop();
  });
  it('可重试的题目失败自动退避重试，全程无需人工点击', async () => {
    const vision = new RecoveryVision();
    vision.questionFailures.set('1', [retryableTimeout(), retryableTimeout()]);
    const { request } = await setup(vision);
    const accepted = await json(await submit(request, await jpeg()));
    const done = await waitFor(request, accepted.job.id, 'completed');
    expect(done.questions[0]).toMatchObject({ number: '1', status: 'ready' });
    expect(vision.questionCalls).toEqual(['1', '1', '1']); // 首次 + 两次自动重试
  });

  it('自动重试耗尽后才标记 failed，仍保留人工重试通道', async () => {
    const vision = new RecoveryVision();
    vision.questionFailures.set('1', [retryableTimeout(), retryableTimeout(), retryableTimeout()]);
    const { request } = await setup(vision);
    const accepted = await json(await submit(request, await jpeg()));
    const failed = await waitFor(request, accepted.job.id, 'failed');
    expect(failed.questions[0].error).toMatchObject({ code: 'timeout', retryable: true });
    expect(vision.questionCalls).toEqual(['1', '1', '1']); // 自动重试两次后停止
    vision.questionFailures.clear();
    const retry = await request(`/v1/recognitions/${failed.id}/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ questionId: failed.questions[0].id }) });
    expect(retry.status).toBe(202);
    await waitFor(request, failed.id, 'completed');
  });

  it('不可重试的失败立即标记 failed，不做任何自动重试', async () => {
    const vision = new RecoveryVision();
    vision.questionFailures.set('1', [Object.assign(new Error('合成硬失败'), { code: 'invalid_output', stage: 'transcribe', retryable: false })]);
    const { request } = await setup(vision);
    const accepted = await json(await submit(request, await jpeg()));
    const failed = await waitFor(request, accepted.job.id, 'failed');
    expect(failed.questions[0].error.code).toBe('invalid_output');
    expect(vision.questionCalls).toEqual(['1']);
  });

  it('清单阶段的可重试失败自动重试一次', async () => {
    const vision = new RecoveryVision();
    vision.inventoryFailures = [Object.assign(new Error('合成清单超时'), { code: 'timeout', stage: 'inventory', retryable: true })];
    const { request } = await setup(vision);
    const accepted = await json(await submit(request, await jpeg()));
    await waitFor(request, accepted.job.id, 'completed');
    expect(vision.inventoryCalls).toBe(2);
  });

  it('启动恢复：从未入队的僵尸任务（队列卡死/进程重启遗留）自动跑完', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-mobile-zombie-')); roots.push(root);
    const bytes = await jpeg();
    // 直接在存储层建任务：持久化为 queued 但从未进入任何进程内队列（模拟 d652922f 类僵尸）。
    const store = await MobileRecognitionStore.open(root);
    const { job } = await store.createJob({ idempotencyKey: crypto.randomUUID(), photoName: 'zombie.jpg', sourceBytes: bytes, normalizedBytes: bytes });
    expect(job.status).toBe('queued');
    const vision = new RecoveryVision();
    const { request } = await setup(vision, root);
    const done = await waitFor(request, job.id, 'completed');
    expect(done.questions[0].status).toBe('ready');
    expect(vision.inventoryCalls).toBe(1);
  });

  it('启动恢复跳过终态任务，不重复调用模型', async () => {
    const vision = new RecoveryVision();
    const { request, root, service } = await setup(vision);
    const accepted = await json(await submit(request, await jpeg()));
    await waitFor(request, accepted.job.id, 'completed');
    await service.stop(); // 模拟进程退出
    const vision2 = new RecoveryVision();
    await setup(vision2, root);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(vision2.inventoryCalls).toBe(0);
    expect(vision2.questionCalls).toHaveLength(0);
  });

  it('服务停止接收后 submit 明确 503，不产出 queued 僵尸任务', async () => {
    const vision = new RecoveryVision();
    const { request, service } = await setup(vision);
    await service.stop();
    const response = await submit(request, await jpeg());
    expect(response.status).toBe(503);
    const listed = await json(await request('/v1/recognitions'));
    expect(listed.jobs).toHaveLength(0);
  });

  it('长任务跨越看门狗扫描周期不被误判僵尸：不重置、不重复入队', async () => {
    // 门闩 vision：题目模型调用挂起直到放行（模拟横跨多个 60s 看门狗周期的长任务）。
    class BarrierVision implements MobileVisionBoundary {
      questionCalls: string[] = [];
      private readonly gate: Promise<void>; private releaseFn!: () => void;
      constructor() { this.gate = new Promise<void>(resolve => { this.releaseFn = resolve; }); }
      release(): void { this.releaseFn(); }
      async inventory() { return { candidates: [{ number: '1', box, selectionEvidence: 'marked_wrong' as const, partial: false }], warnings: [] }; }
      async recognizeQuestion(source: Buffer, candidate: InventoryCandidate): Promise<VisionQuestionResult> {
        this.questionCalls.push(candidate.number);
        await this.gate;
        return { evidence: evidence(candidate.number), verification: { ...CHECKS_OK }, questionCrop: source, diagramCrops: [] };
      }
    }
    const vision = new BarrierVision();
    const { request, service } = await setup(vision);
    const accepted = await json(await submit(request, await jpeg()));
    const processing = await waitForJob(request, accepted.job.id, job => job.questions[0]?.status === 'processing');
    const revisionBefore = processing.questions[0].revision;
    // 模拟两个看门狗周期（直接调用恢复扫描，不真等 60s）。
    await service.resumeIncompleteJobs();
    await service.resumeIncompleteJobs();
    const during = (await json(await request(`/v1/recognitions/${accepted.job.id}`))).job;
    expect(during.questions[0].status).toBe('processing');
    expect(during.questions[0].revision).toBe(revisionBefore);
    vision.release();
    await waitFor(request, accepted.job.id, 'completed');
    expect(vision.questionCalls).toEqual(['1']);
  });

  it('自动退避计时器挂起期间，看门狗不得把待重试题目提前入队', async () => {
    const vision = new RecoveryVision();
    vision.questionFailures.set('1', [retryableTimeout()]);
    const { request, service } = await setup(vision);
    service.autoRetryDelaysMs = [300, 800]; // 首次退避 300ms：足够覆盖下面的两次扫描窗口
    const accepted = await json(await submit(request, await jpeg()));
    // 等首次失败落定：题目回到 queued 并挂起退避计时器（错误文案含「自动重试」）。
    await waitForJob(request, accepted.job.id, job => job.questions[0]?.status === 'queued'
      && typeof job.questions[0]?.error?.message === 'string' && job.questions[0].error.message.includes('自动重试'));
    const callsBeforeScan = vision.questionCalls.length;
    await service.resumeIncompleteJobs();
    await service.resumeIncompleteJobs();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(vision.questionCalls.length).toBe(callsBeforeScan); // 退避窗口内不得提前重跑
    const done = await waitFor(request, accepted.job.id, 'completed');
    expect(done.questions[0].status).toBe('ready');
    expect(vision.questionCalls).toEqual(['1', '1']); // 首次 + 一次自动重试，无重复
  });

  it('看门狗重复扫描同一任务不产生重复队列工作', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-mobile-scan-idem-')); roots.push(root);
    const bytes = await jpeg();
    const store = await MobileRecognitionStore.open(root);
    const { job } = await store.createJob({ idempotencyKey: crypto.randomUUID(), photoName: 'scan.jpg', sourceBytes: bytes, normalizedBytes: bytes });
    const vision = new RecoveryVision();
    const { request, service } = await setup(vision, root);
    const done = await waitFor(request, job.id, 'completed');
    expect(done.questions[0].status).toBe('ready');
    expect(vision.inventoryCalls).toBe(1);
    // 终态后追加扫描（含并发自身）：不得再触发任何模型调用。
    await Promise.all([service.resumeIncompleteJobs(), service.resumeIncompleteJobs()]);
    await service.resumeIncompleteJobs();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(vision.inventoryCalls).toBe(1);
    expect(vision.questionCalls).toEqual(['1']);
  });
});
