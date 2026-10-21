import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import type { Evidence } from '../../src/ai/evidence.js';
import { RateLimiter } from '../../src/mobile/rateLimit.js';
import { MobileRecognitionService } from '../../src/mobile/service.js';
import { IdempotencyConflictError, MobileRecognitionStore } from '../../src/mobile/store.js';
import type { InventoryCandidate, MobileVisionBoundary, VisionContext, VisionInventoryResult, VisionQuestionResult } from '../../src/mobile/vision.js';
import { PermitPool } from '../../src/studentHost/permits.js';

/**
 * 一个学生一次上传多张照片时，识别通道可以重叠，但：
 * - 同时处理的照片数不超过 SEL_STUDENT_AI_CONCURRENCY；
 * - 模型段和图片段仍分别受全局名额限制（与父进程相同的 PermitPool）；
 * - 同一张照片里的题保持原来的顺序；
 * - 每张照片的结果只写回自己的任务。
 */

const roots: string[] = [];
const services: MobileRecognitionService[] = [];
const releases: Array<() => void> = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.all(services.splice(0).map(service => service.stop()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const box = { x: 0, y: 0, width: 1, height: 1 };
function sha(bytes: Buffer): string { return crypto.createHash('sha256').update(bytes).digest('hex'); }
async function jpeg(color: string): Promise<Buffer> {
  return sharp({ create: { width: 24, height: 16, channels: 3, background: color } }).jpeg().toBuffer();
}
function tempDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-photo-batch-'));
  roots.push(root);
  return root;
}
function evidence(number: string, text: string): Evidence {
  return {
    version: 1, questionNumber: number, questionText: text, subject: '数学', chapter: '', knowledgeTags: [], questionType: '计算',
    questionRegion: box, requiresDiagram: false, regions: [], observations: [], uncertainties: [],
  };
}
const checks = { textComplete: true, questionCropComplete: true, questionCropPure: true, transcriptionMatches: true, diagramSafe: true, issues: [] as string[] };

class BlockingInventory implements MobileVisionBoundary {
  readonly configured = true;
  entered = 0;
  peakEntered = 0;
  readonly attempts = new Map<string, number>();
  /** 第一次进入清单、还没放行时调用。可以抛出可重试错误。 */
  onFirstPass: ((hash: string) => void) | null = null;
  /** 放行之后、离开通道之前。用来占用全局图片/模型名额。 */
  afterGate: ((source: Buffer) => Promise<void>) | null = null;
  private released = false;
  private readonly blocked: Array<() => void> = [];
  private readonly arrived: Array<() => void> = [];

  release(): void {
    this.released = true;
    for (const resolve of this.blocked.splice(0)) resolve();
  }

  whenEntered(count: number): Promise<void> {
    if (this.entered >= count) return Promise.resolve();
    return new Promise(resolve => {
      const arm = (): void => { if (this.entered >= count) resolve(); else this.arrived.push(arm); };
      this.arrived.push(arm);
    });
  }

  async inventory(source: Buffer): Promise<VisionInventoryResult> {
    const hash = sha(source);
    const attempt = (this.attempts.get(hash) ?? 0) + 1;
    this.attempts.set(hash, attempt);
    if (attempt === 1) {
      this.entered += 1;
      this.peakEntered = Math.max(this.peakEntered, this.entered);
      for (const waiter of this.arrived.splice(0)) waiter();
      try {
        if (!this.released) await new Promise<void>(resolve => this.blocked.push(resolve));
        this.onFirstPass?.(hash);
        if (this.afterGate) await this.afterGate(source);
      } finally {
        this.entered -= 1;
      }
    }
    return { candidates: [], warnings: [hash] };
  }

  async recognizeQuestion(): Promise<VisionQuestionResult> { throw new Error('这组夹具没有自动精读题'); }
}

function hold(pool: PermitPool, peak: { now: number; max: number }, ms: number): Promise<void> {
  const id = crypto.randomUUID();
  return new Promise(resolve => {
    pool.acquire('student', id, () => {
      peak.now += 1;
      peak.max = Math.max(peak.max, peak.now);
      setTimeout(() => {
        peak.now -= 1;
        pool.release('student', id);
        resolve();
      }, ms);
    });
  });
}

async function openService(vision: MobileVisionBoundary, studentAiConcurrency: number, dataDir = tempDir()): Promise<{ service: MobileRecognitionService; store: MobileRecognitionStore }> {
  const store = await MobileRecognitionStore.open(dataDir);
  const service = new MobileRecognitionService(store, vision, { studentAiConcurrency });
  services.push(service);
  await service.initialize();
  return { service, store };
}

async function submitPhoto(service: MobileRecognitionService, color: string, key = crypto.randomUUID()) {
  const bytes = await jpeg(color);
  const submitted = await service.submit({ idempotencyKey: key, photoName: `${key}.jpg`, sourceBytes: bytes });
  return { bytes, key, job: submitted.job, created: submitted.created };
}

async function waitTerminal(store: MobileRecognitionStore, id: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const job = await store.getStoredJob(id);
    if (job && ['completed', 'partial', 'failed'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`job ${id} did not finish`);
}

describe('photo batch concurrency', () => {
  it('overlaps N photos up to the per-student limit and keeps each result on its own photo', async () => {
    const vision = new BlockingInventory();
    releases.push(() => vision.release());
    const { service, store } = await openService(vision, 3);
    const first = await submitPhoto(service, '#101010');
    const second = await submitPhoto(service, '#202020');
    const third = await submitPhoto(service, '#303030');
    const fourth = await submitPhoto(service, '#404040');
    await vision.whenEntered(3);
    expect(vision.peakEntered).toBe(3);
    expect(vision.entered).toBe(3);
    const sources = await Promise.all([first, second, third, fourth].map(item => store.readSource(item.job.id)));
    const sourceHashes = sources.map(sha);
    expect(new Set(vision.attempts.keys())).toEqual(new Set(sourceHashes.slice(0, 3)));
    expect(vision.attempts.has(sourceHashes[3]!)).toBe(false);
    const replay = await service.submit({ idempotencyKey: first.key, photoName: `${first.key}.jpg`, sourceBytes: first.bytes });
    expect(replay.created).toBe(false);
    expect(replay.job.id).toBe(first.job.id);
    await expect(service.submit({ idempotencyKey: first.key, photoName: 'other.jpg', sourceBytes: second.bytes })).rejects.toBeInstanceOf(IdempotencyConflictError);
    vision.release();
    const jobs = await Promise.all([first, second, third, fourth].map(item => waitTerminal(store, item.job.id)));
    expect(jobs.map(job => job.status)).toEqual(['completed', 'completed', 'completed', 'completed']);
    jobs.forEach((job, index) => expect(job.inventoryWarnings).toEqual([sourceHashes[index]]));
    expect(vision.peakEntered).toBe(3);
  });

  it('keeps a per-student limit of 1 fully serial', async () => {
    const vision = new BlockingInventory();
    releases.push(() => vision.release());
    const { service } = await openService(vision, 1);
    await submitPhoto(service, '#111111');
    await submitPhoto(service, '#222222');
    await submitPhoto(service, '#333333');
    await vision.whenEntered(1);
    expect(vision.entered).toBe(1);
    expect(vision.peakEntered).toBe(1);
    expect(vision.attempts.size).toBe(1);
  });

  it('caps the model and image sections with the global permits while three photos are in the pipeline', async () => {
    const ai = new PermitPool(1);
    const image = new PermitPool(1);
    const aiPeak = { now: 0, max: 0 };
    const imagePeak = { now: 0, max: 0 };
    const vision = new BlockingInventory();
    releases.push(() => vision.release());
    vision.afterGate = async () => {
      await hold(image, imagePeak, 20);
      await hold(ai, aiPeak, 20);
    };
    const { service, store } = await openService(vision, 3);
    const submitted = [];
    for (const color of ['#010101', '#020202', '#030303', '#040404']) submitted.push(await submitPhoto(service, color));
    await vision.whenEntered(3);
    expect(vision.peakEntered).toBe(3);
    expect(imagePeak.max).toBe(0);
    expect(aiPeak.max).toBe(0);
    vision.release();
    const jobs = await Promise.all(submitted.map(item => waitTerminal(store, item.job.id)));
    expect(jobs.every(job => job.status === 'completed')).toBe(true);
    expect(imagePeak.max).toBe(1);
    expect(aiPeak.max).toBe(1);
    expect(vision.peakEntered).toBe(3);
    const sources = await Promise.all(submitted.map(item => store.readSource(item.job.id)));
    jobs.forEach((job, index) => expect(job.inventoryWarnings).toEqual([sha(sources[index]!)]));
  });

  it('runs questions inside one photo in order even when the student limit is 3', async () => {
    let active = 0;
    let maximumActive = 0;
    const order: string[] = [];
    const vision: MobileVisionBoundary = {
      configured: true,
      async inventory(): Promise<VisionInventoryResult> {
        return {
          candidates: [1, 2, 3, 4].map(number => ({ number: String(number), box, selectionEvidence: 'marked_wrong' as const, partial: false })),
          warnings: [],
        };
      },
      async recognizeQuestion(source: Buffer, candidate: InventoryCandidate, _context: VisionContext): Promise<VisionQuestionResult> {
        order.push(candidate.number);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise(resolve => setTimeout(resolve, 30));
        active -= 1;
        return { evidence: evidence(candidate.number, `photo-${sha(source)}-${candidate.number}`), verification: checks, questionCrop: source, diagramCrops: [] };
      },
    };
    const { service, store } = await openService(vision, 3);
    const submitted = await submitPhoto(service, '#abcdef');
    const job = await waitTerminal(store, submitted.job.id);
    const sourceHash = sha(await store.readSource(job.id));
    expect(maximumActive).toBe(1);
    expect(order).toEqual(['1', '2', '3', '4']);
    expect(job.questions.map(question => question.evidence?.questionText)).toEqual([
      `photo-${sourceHash}-1`,
      `photo-${sourceHash}-2`,
      `photo-${sourceHash}-3`,
      `photo-${sourceHash}-4`,
    ]);
  });

  it('retries one photo without mixing results into the others', async () => {
    const vision = new BlockingInventory();
    releases.push(() => vision.release());
    let flaky = '';
    vision.onFirstPass = hash => {
      if (hash !== flaky) return;
      throw Object.assign(new Error('busy'), { code: 'rate_limited', stage: 'inventory', message: 'busy', retryable: true });
    };
    const { service, store } = await openService(vision, 3);
    service.autoRetryDelaysMs = [20];
    const submitted = [];
    for (const color of ['#111100', '#222200', '#333300', '#444400']) submitted.push(await submitPhoto(service, color));
    await vision.whenEntered(3);
    flaky = sha(await store.readSource(submitted[0]!.job.id));
    vision.release();
    const jobs = await Promise.all(submitted.map(item => waitTerminal(store, item.job.id)));
    expect(vision.peakEntered).toBe(3);
    expect(vision.attempts.get(flaky)).toBe(2);
    for (const item of submitted.slice(1)) expect(vision.attempts.get(sha(await store.readSource(item.job.id)))).toBe(1);
    const sources = await Promise.all(submitted.map(item => store.readSource(item.job.id)));
    jobs.forEach((job, index) => {
      expect(job.status).toBe('completed');
      expect(job.inventoryWarnings).toEqual([sha(sources[index]!)]);
    });
  });

  it('resumes interrupted on-disk photos in parallel and keeps their association', async () => {
    const dir = tempDir();
    const store = await MobileRecognitionStore.open(dir);
    const ids: string[] = [];
    for (const color of ['#0a0a0a', '#0b0b0b', '#0c0c0c']) {
      const bytes = await jpeg(color);
      const { job } = await store.createJob({ idempotencyKey: crypto.randomUUID(), photoName: 'page.jpg', sourceBytes: bytes, normalizedBytes: bytes });
      const stored = (await store.getStoredJob(job.id))!;
      stored.status = 'processing';
      await store.saveJob(stored);
      ids.push(job.id);
    }
    const vision = new BlockingInventory();
    releases.push(() => vision.release());
    const restored = await MobileRecognitionStore.open(dir);
    const service = new MobileRecognitionService(restored, vision, { studentAiConcurrency: 3 });
    services.push(service);
    await service.initialize();
    await vision.whenEntered(3);
    expect(vision.peakEntered).toBe(3);
    expect(vision.attempts.size).toBe(3);
    vision.release();
    const jobs = await Promise.all(ids.map(id => waitTerminal(restored, id)));
    expect(vision.attempts.size).toBe(3);
    for (const job of jobs) {
      expect(job.status).toBe('completed');
      expect(job.inventoryWarnings).toEqual([sha(await restored.readSource(job.id))]);
    }
  });

  it('still rejects the 31st photo upload in a minute for one device', () => {
    const limiter = new RateLimiter({ now: () => 1_000 });
    for (let index = 0; index < 30; index += 1) expect(limiter.upload('device-a').allowed).toBe(true);
    const blocked = limiter.upload('device-a');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(limiter.upload('device-b').allowed).toBe(true);
  });
});
