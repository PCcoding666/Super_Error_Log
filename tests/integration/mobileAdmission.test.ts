import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMobileApp } from '../../src/mobile/router.js';
import { PairingManager } from '../../src/mobile/pairing.js';
import type { MobileVisionBoundary, VisionContext, VisionInventoryResult, VisionQuestionResult, InventoryCandidate } from '../../src/mobile/vision.js';
import type { MobileRecognitionService } from '../../src/mobile/service.js';
import { AdmissionController } from '../../src/mobile/admission.js';
import { MobileRecognitionStore } from '../../src/mobile/store.js';

const roots: string[] = [];
const servers: Server[] = [];
const services: MobileRecognitionService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.stop()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});

const box = { x: 0, y: 0, width: 1, height: 1 };
const evidence = (number: string) => ({ version: 1 as const, questionNumber: number, questionText: '求 x 的值。', subject: '数学' as const, chapter: '', knowledgeTags: [], questionType: '计算', questionRegion: box, requiresDiagram: false, regions: [], observations: [], uncertainties: [] });

/** 慢速 vision：处理期间保持任务非终态，占住容量。 */
class SlowVision implements MobileVisionBoundary {
  active = 0; maximumActive = 0; cropActive = 0; cropMaximumActive = 0;
  private release: (() => void) | null = null;
  private gate: Promise<void> = new Promise(resolve => { this.release = resolve; });
  finish(): void { this.release?.(); }
  async inventory(_source: Buffer, _context: VisionContext): Promise<VisionInventoryResult> {
    this.active += 1; this.maximumActive = Math.max(this.maximumActive, this.active);
    await this.gate; this.active -= 1;
    return { candidates: [{ number: '1', box, selectionEvidence: 'marked_wrong', partial: false }], warnings: [] };
  }
  async recognizeQuestion(source: Buffer, candidate: InventoryCandidate, _context: VisionContext): Promise<VisionQuestionResult> {
    this.active += 1; this.maximumActive = Math.max(this.maximumActive, this.active);
    await this.gate; this.active -= 1;
    return { evidence: evidence(candidate.number), verification: { textComplete: true, questionCropComplete: true, questionCropPure: true, transcriptionMatches: true, diagramSafe: true, issues: [] }, questionCrop: source, diagramCrops: [] };
  }
}

type RequestFn = (url: string, init?: RequestInit) => Promise<Response>;

interface SetupOptions { jobCapacity?: number; diskFreeBytes?: bigint; dataDirBytes?: bigint; dataDir?: string }

async function tempRoot(): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-admission-'));
  roots.push(root);
  return root;
}

async function setupCloud(vision: MobileVisionBoundary, options: SetupOptions = {}): Promise<{ request: RequestFn; manager: PairingManager; base: string; token: string; app: import('express').Express }> {
  const dataDir = options.dataDir ?? await tempRoot();
  const manager = await PairingManager.open(dataDir);
  const admission = new AdmissionController({
    jobCapacity: options.jobCapacity ?? 10,
    diskProbe: options.diskFreeBytes !== undefined ? async () => options.diskFreeBytes! : undefined,
    dataUsageProbe: options.dataDirBytes !== undefined ? async () => options.dataDirBytes! : undefined,
  });
  const app = await createMobileApp({ dataDir, vision, mode: 'cloud', pairing: manager, cloudProxy: true, admission });
  services.push(app.locals.mobileRecognitionService);
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const paired = await manager.redeem(manager.createSession().payload, crypto.randomUUID(), 'iPhone');
  const request: RequestFn = (url, init = {}) => fetch(`${base}${url}`, { ...init, headers: { authorization: `Bearer ${paired.token}`, ...init.headers } });
  return { request, manager, base, token: paired.token, app };
}

async function jpeg(color = '#ffffff'): Promise<Buffer> {
  return sharp({ create: { width: 24, height: 16, channels: 3, background: color } }).jpeg().toBuffer();
}
async function submit(request: RequestFn, bytes: Buffer, key = crypto.randomUUID()): Promise<Response> {
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return request('/v1/recognitions', { method: 'POST', headers: { 'content-type': 'image/jpeg', 'idempotency-key': key, 'x-photo-name': encodeURIComponent('练习.jpg') }, body });
}
const idOf = async (response: Response): Promise<string> => ((await response.json() as { job: { id: string } }).job).id;

describe('job capacity admission', () => {
  it.each([10, 12])('reserves all %i restored jobs before uploads while recovery persistence is blocked', async count => {
    const dataDir = await tempRoot(); const bytes = await jpeg();
    const store = await MobileRecognitionStore.open(dataDir);
    const key = crypto.randomUUID();
    for (let i = 0; i < count; i++) await store.createJob({ idempotencyKey: i === 0 ? key : crypto.randomUUID(), photoName: 'pending.jpg', sourceBytes: bytes, normalizedBytes: bytes });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const original = MobileRecognitionStore.prototype.updateJob;
    const blocked = vi.spyOn(MobileRecognitionStore.prototype, 'updateJob').mockImplementation(async function (this: MobileRecognitionStore, id, change) {
      await gate; return original.call(this, id, change);
    });
    try {
      const { request, app } = await setupCloud(new SlowVision(), { dataDir });
      // No health polling: the first request while recovery is at an await boundary must be rejected.
      expect((await submit(request, bytes)).status).toBe(429);
      expect(await (app.locals.mobileRecognitionService as MobileRecognitionService).listJobs()).toHaveLength(count);
      expect((await submit(request, bytes, key)).status).toBe(202);
    } finally { release(); blocked.mockRestore(); }
  });
  it('容量满时拒绝新任务而不是假装成功', async () => {
    const vision = new SlowVision();
    const { request } = await setupCloud(vision, { jobCapacity: 1 });
    const first = await submit(request, await jpeg());
    expect(first.status).toBe(202);
    const second = await submit(request, await jpeg('#888888'));
    expect(second.status).toBe(429);
    expect((await second.json() as { error: { code: string } }).error.code).toBe('capacity_full');
    expect((await request(`/v1/recognitions/${await idOf(first)}`)).status).toBe(200);
    vision.finish();
  });

  it('满队列时相同幂等键的旧任务仍可查询并按字节恢复', async () => {
    const vision = new SlowVision();
    const { request } = await setupCloud(vision, { jobCapacity: 1 });
    const key = crypto.randomUUID();
    const first = await submit(request, await jpeg(), key);
    expect(first.status).toBe(202);
    const repeat = await submit(request, await jpeg(), key);
    expect(repeat.status).toBe(202);
    expect((await repeat.json() as { job: { id: string } }).job.id).toBe((await first.json() as { job: { id: string } }).job.id);
    const third = await submit(request, await jpeg('#666666'));
    expect((await third.json() as { error: { code: string } }).error.code).toBe('capacity_full');
    vision.finish();
  });

  it('幂等键相同内容不同：409 冲突不占新容量', async () => {
    const vision = new SlowVision();
    const { request } = await setupCloud(vision, { jobCapacity: 1 });
    const key = crypto.randomUUID();
    await submit(request, await jpeg(), key);
    // 满队列（容量 1 已占）：同键同字节的幂等重放可恢复，不同字节的同键 409。
    const conflict = await submit(request, await jpeg('#9c9c9c'), key);
    expect(conflict.status).toBe(409);
    // 冲突被拒：不占新容量，也不放走别的照片。
    const another = await submit(request, await jpeg('#333333'));
    expect((await another.json() as { error: { code: string } }).error.code).toBe('capacity_full');
    vision.finish();
  });
});

describe('upload slot admission', () => {
  it('同时最多 1 个上传正文在解析：槽位满返回 429 busy 可重试，不排队', async () => {
    const vision = new SlowVision();
    const { request, base, token } = await setupCloud(vision, { jobCapacity: 10 });
    // 慢速流式 body：分块发送且中途挂起，占用解析槽位。
    const firstBody = new ReadableStream({
      async start(controller) {
        const bytes = await jpeg();
        controller.enqueue(bytes.subarray(0, 100));
        await new Promise(resolve => setTimeout(resolve, 400));
        controller.enqueue(bytes.subarray(100));
        controller.close();
      },
    });
    const first = fetch(`${base}/v1/recognitions`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'image/jpeg', 'idempotency-key': crypto.randomUUID(), 'x-photo-name': 'a.jpg' }, body: firstBody, duplex: 'half' } as RequestInit);
    await new Promise(resolve => setTimeout(resolve, 150));
    const second = await submit(request, await jpeg('#777777'));
    expect(second.status).toBe(429);
    const body = await second.json() as { error: { code: string } };
    expect(['busy', 'capacity_full']).toContain(body.error.code);
    const firstDone = await first;
    expect(firstDone.status).toBe(202);
    vision.finish();
  });

  it('槽位在异常路径不泄漏：空 body / 损坏图片后仍可继续上传', async () => {
    const vision = new SlowVision();
    const { request } = await setupCloud(vision, { jobCapacity: 5 });
    const empty = await request('/v1/recognitions', { method: 'POST', headers: { 'content-type': 'image/jpeg', 'idempotency-key': crypto.randomUUID() }, body: new Uint8Array(0) });
    expect(empty.status).toBe(400);
    const corrupt = await submit(request, Buffer.from('not-a-jpeg'));
    expect(corrupt.status).toBe(400);
    const valid = await submit(request, await jpeg());
    expect(valid.status).toBe(202);
    vision.finish();
  });
});

describe('storage gates', () => {
  it('系统盘 <3GiB 拒收新上传，提示管理', async () => {
    const vision = new SlowVision();
    const { request } = await setupCloud(vision, { diskFreeBytes: 2n * 1024n ** 3n });
    const response = await submit(request, await jpeg());
    expect(response.status).toBe(503);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('disk_low');
    expect(body.error.message).toContain('磁盘');
    vision.finish();
  });

  it('数据目录达到 10GiB 拒收，提示管理', async () => {
    const vision = new SlowVision();
    const { request } = await setupCloud(vision, { dataDirBytes: 10n * 1024n ** 3n });
    const response = await submit(request, await jpeg());
    expect(response.status).toBe(503);
    const body = await response.json() as { error: { code: string } };
    expect(body.error.code).toBe('data_quota');
    vision.finish();
  });

  it('磁盘门槛翻转 health.acceptingJobs', async () => {
    let free = 8n * 1024n ** 3n;
    const dataDir = await tempRoot();
    const manager = await PairingManager.open(dataDir);
    const admission = new AdmissionController({ jobCapacity: 5, diskProbe: async () => free });
    const app = await createMobileApp({ dataDir, vision: new SlowVision(), mode: 'cloud', pairing: manager, cloudProxy: true, admission });
    services.push(app.locals.mobileRecognitionService);
    const server = app.listen(0, '127.0.0.1'); servers.push(server);
    await new Promise<void>(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const paired = await manager.redeem(manager.createSession().payload, crypto.randomUUID(), 'iPhone');
    const request: RequestFn = (url, init = {}) => fetch(`${base}${url}`, { ...init, headers: { authorization: `Bearer ${paired.token}`, ...init.headers } });
    expect((await (await request('/v1/health')).json() as { acceptingJobs: boolean }).acceptingJobs).toBe(true);
    free = 1n * 1024n ** 3n;
    expect((await (await request('/v1/health')).json() as { acceptingJobs: boolean }).acceptingJobs).toBe(false);
  });
});

describe('per-question concurrency and image semaphore', () => {
  it('逐题并发降为 1（沿用 maximumActive 断言方式）', async () => {
    // SlowVision 多候选：并发为 1 意味着 maximumActive 恒 1。
    class MultiVision extends SlowVision {
      async inventory(_source: Buffer, _context: VisionContext): Promise<VisionInventoryResult> {
        return { candidates: Array.from({ length: 4 }, (_, index) => ({ number: String(index + 1), box, selectionEvidence: 'marked_wrong' as const, partial: false })), warnings: [] };
      }
    }
    const vision = new MultiVision();
    const { request } = await setupCloud(vision, { jobCapacity: 5 });
    const accepted = await submit(request, await jpeg());
    expect(accepted.status).toBe(202);
    const jobId = await idOf(accepted);
    vision.finish();
    // 等任务完成后断言峰值并发。墙钟预算 30s。
    // 轮询间隔必须尊重云端真实限流（300 次/分钟/设备）：20ms 轮询 ~6s 就打满 429，
    // 之后响应无 job 字段（限流体），任务状态永远读不到。250ms 间隔 ≈ 240 次/分钟 < 300。
    // 瞬时限流/错误响应（无 job 字段）跳过该轮。
    let job: { job: { status: string } } | null = null;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const polled = await (await request(`/v1/recognitions/${jobId}`)).json() as { job?: { status: string } };
      if (polled?.job) job = polled as { job: { status: string } };
      if (job && ['completed', 'partial', 'failed'].includes(job.job.status)) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    expect(['completed', 'partial', 'failed']).toContain(job?.job.status);
    expect(vision.maximumActive).toBe(1);
  });

  it('图像信号量跨请求互斥：normalizePhoto 与裁切互不重叠', async () => {
    // admission 层信号量：两次并发上传的图像处理不重叠。
    // 用 admission.acquireImage 的公开行为断言（slow normalize 模拟）。
    const admission = new AdmissionController({ jobCapacity: 5 });
    let active = 0; let peak = 0;
    const tasks = Array.from({ length: 4 }, async () => {
      const release = await admission.acquireImage();
      active += 1; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 15));
      active -= 1; release();
    });
    await Promise.all(tasks);
    expect(peak).toBe(1);
  });

  it('vision 裁切路径走共享图像信号量（service.context 注入 withImage）', async () => {
    // 真实链路：service.runQuestion → vision.recognizeQuestion(context.withImage) → renderCrops。
    // 用真实 BailianMobileVision 的裁切路径验证 withImage 注入后的互斥语义。
    // 观测点：context.withImage 是否在真实调用链中被构造（service.context 存在 admission 时注入）。
    // 这里用间接但真实的方式：两个并发 question 裁切都经由 withImage 包装。
    const seenWithImage: boolean[] = [];
    class WrappingVision extends SlowVision {
      async recognizeQuestion(source: Buffer, candidate: InventoryCandidate, context: VisionContext): Promise<VisionQuestionResult> {
        seenWithImage.push(typeof context.withImage === 'function');
        await context.withImage?.(async () => { await new Promise(resolve => setTimeout(resolve, 5)); return 0; });
        return { evidence: evidence(candidate.number), verification: { textComplete: true, questionCropComplete: true, questionCropPure: true, transcriptionMatches: true, diagramSafe: true, issues: [] }, questionCrop: source, diagramCrops: [] };
      }
    }
    const vision = new WrappingVision();
    const { request } = await setupCloud(vision, { jobCapacity: 5 });
    const accepted = await submit(request, await jpeg());
    expect(accepted.status).toBe(202);
    vision.finish();
    const jobId = await idOf(accepted);
    {
      // 同上：轮询间隔 250ms 尊重云端限流（300 次/分钟/设备）；瞬时限流响应跳过。
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const polled = await (await request(`/v1/recognitions/${jobId}`)).json() as { job?: { status: string } };
        if (polled?.job && ['completed', 'partial', 'failed'].includes(polled.job.status)) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    // service.context 在 admission 接通时注入 withImage：真实调用链覆盖 vision 裁切。
    expect(seenWithImage.length).toBeGreaterThanOrEqual(1);
    expect(seenWithImage.every(seen => seen)).toBe(true);
  });

  it('并发逐题重试不泄漏容量：每任务恰好占 1，终态释放（R1/R2 回归）', async () => {
    class GatedFlakyVision implements MobileVisionBoundary {
      private calls = 0;
      private gates: Array<() => void> = [];
      /** 释放一个挂起的重试题目（按调用顺序）。 */
      releaseOne(): void { this.gates.shift()?.(); }
      /** 等待下一个题目真正挂起后再放行（顺序 drain：题目 2 只在题目 1 完成后才开始）。 */
      async releaseNextWhenPending(): Promise<void> {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          if (this.gates.length > 0) { this.gates.shift()?.(); return; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
      async inventory(_source: Buffer, _context: VisionContext): Promise<VisionInventoryResult> {
        return { candidates: Array.from({ length: 2 }, (_, index) => ({ number: String(index + 1), box, selectionEvidence: 'marked_wrong' as const, partial: false })), warnings: [] };
      }
      async recognizeQuestion(source: Buffer, candidate: InventoryCandidate, _context: VisionContext): Promise<VisionQuestionResult> {
        this.calls += 1;
        if (this.calls <= 2) {
          // 初始运行：两题 retryable 失败（canRecover=true，可走 /retry）。
          throw Object.assign(new Error('model overloaded'), { code: 'rate_limited', stage: 'transcribe', retryable: true });
        }
        // 重试运行：挂起等待测试逐个放行，观测容量保持。
        await new Promise<void>(resolve => { this.gates.push(resolve); });
        return { evidence: evidence(candidate.number), verification: { textComplete: true, questionCropComplete: true, questionCropPure: true, transcriptionMatches: true, diagramSafe: true, issues: [] }, questionCrop: source, diagramCrops: [] };
      }
    }
    const vision = new GatedFlakyVision();
    const { app, request } = await setupCloud(vision, { jobCapacity: 1 });
    // 本测试聚焦人工重试的容量账目：关闭自动重试（自动重试由 mobileRecovery.test.ts 覆盖）。
    (app.locals.mobileRecognitionService as MobileRecognitionService).autoRetryDelaysMs = [];
    const accepted = await submit(request, await jpeg());
    expect(accepted.status).toBe(202);
    const jobId = await idOf(accepted);
    // 等待初始运行到达终态（两题失败：容量 0/1）。
    const waitForStatus = async (statuses: string[]): Promise<{ status: string; questions: Array<{ id: string; status: string }> }> => {
      let current: { job: { status: string; questions: Array<{ id: string; status: string }> } } | undefined;
      // 同上：250ms 轮询间隔尊重云端限流；瞬时限流/错误响应（无 job 字段）跳过该轮。
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const polled = await (await request(`/v1/recognitions/${jobId}`)).json() as typeof current;
        if (polled?.job) current = polled;
        if (current && statuses.includes(current.job.status)) return current.job;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (!current) throw new Error('任务状态轮询失败');
      return current.job;
    };
    const initial = await waitForStatus(['failed', 'partial']);
    expect(initial.status).toBe('failed');
    const failedQuestions: Array<{ id: string; status: string }> = initial.questions.filter((question: { status: string }) => question.status === 'failed');
    expect(failedQuestions.length).toBe(2);
    // 并发重试两个失败题目：都必须 202。容量 1 已被首个重试占用（jobId 去重），
    // 第二个重试若重复预约（R2 缺陷）会得到 429 capacity_full。
    const retries = await Promise.all(failedQuestions.map((question: { id: string }) =>
      request(`/v1/recognitions/${jobId}/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ questionId: question.id }) })));
    expect(retries.map((response: Response) => response.status)).toEqual([202, 202]);
    // 重试运行中（题目挂起）：容量必须保持占用。
    const during = await submit(request, await jpeg('#5a5a5a'));
    expect((await during.json() as { error: { code: string } }).error.code).toBe('capacity_full');
    // 放行第一题：完成后 finalize 非终态（第二题仍 queued）——R1 缺陷会提前释放容量。
    await vision.releaseNextWhenPending();
    await new Promise(resolve => setTimeout(resolve, 150));
    const afterFirst = await submit(request, await jpeg('#6e6e6e'));
    expect((await afterFirst.json() as { error: { code: string } }).error.code).toBe('capacity_full');
    // 放行第二题：任务终态 → 容量完整释放，无泄漏。
    await vision.releaseNextWhenPending();
    const terminal = await waitForStatus(['completed']);
    expect(terminal.status).toBe('completed');
    const afterTerminal = await submit(request, await jpeg('#7a7a7a'));
    expect(afterTerminal.status).toBe(202);
  });
});

describe('restart capacity accounting (Task 01-B)', () => {
  /** 门闩清单 vision：inventory 逐次放行，question 秒过（观测容量账目的时间窗）。 */
  class GatedInventoryVision implements MobileVisionBoundary {
    inventoryCalls = 0;
    private gates: Array<() => void> = [];
    async releaseNextWhenPending(): Promise<void> {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (this.gates.length > 0) { this.gates.shift()!(); return; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error('没有挂起的清单调用可放行');
    }
    async inventory(): Promise<VisionInventoryResult> {
      this.inventoryCalls += 1;
      await new Promise<void>(resolve => { this.gates.push(resolve); });
      return { candidates: [{ number: '1', box, selectionEvidence: 'marked_wrong' as const, partial: false }], warnings: [] };
    }
    async recognizeQuestion(source: Buffer, candidate: InventoryCandidate): Promise<VisionQuestionResult> {
      return { evidence: evidence(candidate.number), verification: { textComplete: true, questionCropComplete: true, questionCropPure: true, transcriptionMatches: true, diagramSafe: true, issues: [] }, questionCrop: source, diagramCrops: [] };
    }
  }

  it('重启恢复先建容量账目：满额旧任务在恢复时占位，第十一张新照片被拒；一个旧任务终态恰好释放一个名额', async () => {
    // 预置 10 个未完成任务（模拟重启前遗留；新建即 queued/inventory，重启加载后转 interrupted 待恢复）。
    const dataDir = await tempRoot();
    const store = await MobileRecognitionStore.open(dataDir);
    for (let index = 0; index < 10; index += 1) {
      const bytes = await jpeg(index % 2 === 0 ? '#dddddd' : '#eeeeee');
      await store.createJob({ idempotencyKey: crypto.randomUUID(), photoName: `遗留-${index}.jpg`, sourceBytes: bytes, normalizedBytes: bytes });
    }
    const vision = new GatedInventoryVision();
    const { request } = await setupCloud(vision, { jobCapacity: 10, dataDir });
    // 等恢复扫描把 10 个旧任务挂到容量账目上（health 翻转为不接收）。
    const deadline = Date.now() + 30_000;
    let accepting = true;
    while (Date.now() < deadline) {
      accepting = (await (await request('/v1/health')).json() as { acceptingJobs: boolean }).acceptingJobs;
      if (!accepting) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(accepting, '恢复的旧任务必须占用容量名额').toBe(false);
    // 第十一张：满额拒收（旧实现恢复不预约容量 → 会错误地 202）。
    const eleventh = await submit(request, await jpeg('#111111'));
    expect(eleventh.status).toBe(429);
    expect((await eleventh.json() as { error: { code: string } }).error.code).toBe('capacity_full');
    // 放行一个旧任务跑完 → 恰好释放一个名额 → 新照片可入；再下一张仍被拒（只释放一个）。
    await vision.releaseNextWhenPending();
    const admitDeadline = Date.now() + 30_000;
    let admitted = false;
    while (Date.now() < admitDeadline) {
      const response = await submit(request, await jpeg('#222222'));
      if (response.status === 202) { admitted = true; break; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    expect(admitted, '一个旧任务终态后应恰好释放一个名额').toBe(true);
    const twelfth = await submit(request, await jpeg('#333333'));
    expect((await twelfth.json() as { error: { code: string } }).error.code).toBe('capacity_full');
  });

  it('对无遗留容量的收拢任务重复 finalize 不释放在途任务的容量', async () => {
    // jobCapacity=1：B 在途占位；A 是「题目已有结论但任务卡住」的遗留记录（无容量预约）。
    const vision = new SlowVision();
    const { request, app } = await setupCloud(vision, { jobCapacity: 1 });
    const held = await submit(request, await jpeg('#aaaaaa'));
    expect(held.status).toBe(202);
    const service = app.locals.mobileRecognitionService as MobileRecognitionService;
    // 遗留卡住任务：全部题目已失败（非中断，不可恢复）但任务状态停留 interrupted。
    const bytes = await jpeg('#bbbbbb');
    const { job: stuck } = await service.store.createJob({ idempotencyKey: crypto.randomUUID(), photoName: 'stuck.jpg', sourceBytes: bytes, normalizedBytes: bytes });
    await service.store.updateJob(stuck.id, current => {
      current.phase = 'questions'; current.status = 'interrupted';
      current.questions = [{ id: crypto.randomUUID(), number: '1', revision: 1, status: 'failed', selectionEvidence: 'unmarked', evidence: null, verification: null,
        questionMediaId: null, diagramMediaIds: [],
        error: { code: 'invalid_output', message: '历史失败记录', stage: 'transcribe', retryable: false }, confirmedAt: null }];
    });
    // 看门狗对 A 只做 finalize 收拢；A 从未在本进程预约容量，收拢不得释放 B 占的名额。
    await service.resumeIncompleteJobs();
    const third = await submit(request, await jpeg('#cccccc'));
    expect((await third.json() as { error: { code: string } }).error.code, 'B 在途时新照片仍须被拒').toBe('capacity_full');
    vision.finish();
  });

  it('重试的容量预约在状态迁移失败时回滚，不泄漏名额', async () => {
    // 题目可恢复失败（rate_limited）终态 → 容量已释放；重试时预约成功但持久化故障 → 预约必须回滚。
    class RetryableFailVision implements MobileVisionBoundary {
      async inventory(): Promise<VisionInventoryResult> {
        return { candidates: [{ number: '1', box, selectionEvidence: 'marked_wrong' as const, partial: false }], warnings: [] };
      }
      async recognizeQuestion(): Promise<VisionQuestionResult> {
        throw Object.assign(new Error('合成限流'), { code: 'rate_limited', stage: 'transcribe', retryable: true });
      }
    }
    const vision = new RetryableFailVision();
    const { request, app } = await setupCloud(vision, { jobCapacity: 1 });
    const service = app.locals.mobileRecognitionService as MobileRecognitionService;
    service.autoRetryDelaysMs = []; // 关闭自动重试：题目一次性落到 failed 终态
    const accepted = await submit(request, await jpeg());
    expect(accepted.status).toBe(202);
    const jobId = await idOf(accepted);
    const deadline = Date.now() + 30_000;
    let failedJob: { status: string; questions: Array<{ id: string; status: string }> } | undefined;
    while (Date.now() < deadline) {
      const polled = await (await request(`/v1/recognitions/${jobId}`)).json() as { job?: typeof failedJob };
      if (polled?.job && polled.job.status === 'failed') { failedJob = polled.job; break; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    expect(failedJob?.status).toBe('failed');
    // 注入一次性持久化故障：重试的 updateJob 抛 EIO（服务随后 fail-closed 是既有语义）。
    const original = service.store.updateJob.bind(service.store);
    service.store.updateJob = async () => { throw Object.assign(new Error('synthetic EIO'), { code: 'EIO' }); };
    const retry = await request(`/v1/recognitions/${jobId}/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ questionId: failedJob!.questions[0]!.id }) });
    expect(retry.status).toBe(503);
    service.store.updateJob = original;
    // 直接观测容量账目：泄漏的预约会让 pendingJobs 卡在 1（满），回滚后应为 0。
    // 通过 admission.accepting() 侧信道验证（storageGate 正常 + 未满 → true）。
    // 注意：storage 故障后服务 fail-closed 是既有语义，这里只验证 admission 计数器本身。
    const admission = (service as unknown as { admission: AdmissionController | null }).admission;
    expect(admission).not.toBeNull();
    const probe = await admission!.accepting();
    expect(probe, '重试迁移失败必须回滚容量预约').toBe(true);
  });
});
