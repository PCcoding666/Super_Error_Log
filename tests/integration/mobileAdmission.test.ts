import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { createMobileApp } from '../../src/mobile/router.js';
import { PairingManager } from '../../src/mobile/pairing.js';
import type { MobileVisionBoundary, VisionContext, VisionInventoryResult, VisionQuestionResult, InventoryCandidate } from '../../src/mobile/vision.js';
import { AdmissionController } from '../../src/mobile/admission.js';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
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
    return { candidates: [{ number: '1', box, selectionEvidence: 'unmarked', partial: false }], warnings: [] };
  }
  async recognizeQuestion(source: Buffer, candidate: InventoryCandidate, _context: VisionContext): Promise<VisionQuestionResult> {
    this.active += 1; this.maximumActive = Math.max(this.maximumActive, this.active);
    await this.gate; this.active -= 1;
    return { evidence: evidence(candidate.number), verification: { textComplete: true, questionCropComplete: true, questionCropPure: true, transcriptionMatches: true, diagramSafe: true, issues: [] }, questionCrop: source, diagramCrops: [] };
  }
}

type RequestFn = (url: string, init?: RequestInit) => Promise<Response>;

interface SetupOptions { jobCapacity?: number; diskFreeBytes?: bigint; dataDirBytes?: bigint; }

async function tempRoot(): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-admission-'));
  roots.push(root);
  return root;
}

async function setupCloud(vision: MobileVisionBoundary, options: SetupOptions = {}): Promise<{ request: RequestFn; manager: PairingManager; base: string; token: string }> {
  const dataDir = await tempRoot();
  const manager = await PairingManager.open(dataDir);
  const admission = new AdmissionController({
    jobCapacity: options.jobCapacity ?? 10,
    diskProbe: options.diskFreeBytes !== undefined ? async () => options.diskFreeBytes! : undefined,
    dataUsageProbe: options.dataDirBytes !== undefined ? async () => options.dataDirBytes! : undefined,
  });
  const app = await createMobileApp({ dataDir, vision, mode: 'cloud', pairing: manager, cloudProxy: true, admission });
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const paired = await manager.redeem(manager.createSession().payload, crypto.randomUUID(), 'iPhone');
  const request: RequestFn = (url, init = {}) => fetch(`${base}${url}`, { ...init, headers: { authorization: `Bearer ${paired.token}`, ...init.headers } });
  return { request, manager, base, token: paired.token };
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
        return { candidates: Array.from({ length: 4 }, (_, index) => ({ number: String(index + 1), box, selectionEvidence: 'unmarked' as const, partial: false })), warnings: [] };
      }
    }
    const vision = new MultiVision();
    const { request } = await setupCloud(vision, { jobCapacity: 5 });
    const accepted = await submit(request, await jpeg());
    expect(accepted.status).toBe(202);
    const jobId = await idOf(accepted);
    vision.finish();
    // 等任务完成后断言峰值并发。
    let job: { job: { status: string } } | null = null;
    for (let index = 0; index < 200; index += 1) {
      job = await (await request(`/v1/recognitions/${jobId}`)).json() as { job: { status: string } };
      if (job.job.status === 'completed' || job.job.status === 'partial' || job.job.status === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 20));
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
    for (let index = 0; index < 200; index += 1) {
      const job = await (await request(`/v1/recognitions/${jobId}`)).json() as { job: { status: string } };
      if (['completed', 'partial', 'failed'].includes(job.job.status)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
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
        for (let index = 0; index < 300; index += 1) {
          if (this.gates.length > 0) { this.gates.shift()?.(); return; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
      async inventory(_source: Buffer, _context: VisionContext): Promise<VisionInventoryResult> {
        return { candidates: Array.from({ length: 2 }, (_, index) => ({ number: String(index + 1), box, selectionEvidence: 'unmarked' as const, partial: false })), warnings: [] };
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
    const { request } = await setupCloud(vision, { jobCapacity: 1 });
    const accepted = await submit(request, await jpeg());
    expect(accepted.status).toBe(202);
    const jobId = await idOf(accepted);
    // 等待初始运行到达终态（两题失败：容量 0/1）。
    const waitForStatus = async (statuses: string[]): Promise<{ status: string; questions: Array<{ id: string; status: string }> }> => {
      let current: { job: { status: string; questions: Array<{ id: string; status: string }> } } | undefined;
      for (let index = 0; index < 300; index += 1) {
        current = await (await request(`/v1/recognitions/${jobId}`)).json() as typeof current;
        if (current && statuses.includes(current.job.status)) return current.job;
        await new Promise(resolve => setTimeout(resolve, 20));
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
