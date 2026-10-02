import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Task 7 十张合成高分辨率照片压测（资源行为评估，不是识别质量评测）。
 * 与 mobileRecognition.test.ts 的差异：这里测【规模与资源】——10 张高分辨率（4000×3000）
 * 合成照片并发上传、队列满 429、幂等重放 202/409、磁盘门槛 503、进程中断恢复。
 * 只断言容量/磁盘/恢复语义与资源水位；任何通过都不构成识别质量或真实照片验收结论。
 * 服务跑在独立子进程（真实 dist 构建产物，先 `npm run build`），测试经真实 HTTP 访问。
 */

const NODE = process.execPath;
const PROJECT = path.resolve('.');
// verify 顺序已改为先 build 再 test；单独跑 `npm test` 时若 dist 缺失（如新 clone），显式跳过而不是误导性失败。
const DIST_READY = fs.existsSync(path.join(PROJECT, 'dist/mobile/router.js'));
const describeWithGuard = DIST_READY ? describe : describe.skip;

function makeTempDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'sel-stress-')); }

async function bigJpeg(color: string): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  return sharp({ create: { width: 4000, height: 3000, channels: 3, background: color } })
    .jpeg({ quality: 85 }).toBuffer();
}

/** 子进程服务：云端模式 + 1 题 FixtureVision + 可配容量/磁盘探测，READY 行带 port 与 redeem payload。 */
function serviceScript(): string {
  return `
import { createMobileApp } from ${JSON.stringify(path.resolve(PROJECT, 'dist/mobile/router.js'))};
import { PairingManager } from ${JSON.stringify(path.resolve(PROJECT, 'dist/mobile/pairing.js'))};
import { AdmissionController } from ${JSON.stringify(path.resolve(PROJECT, 'dist/mobile/admission.js'))};

const dataDir = process.env.SEL_STRESS_DIR;
const jobCapacity = Number(process.env.SEL_STRESS_CAPACITY ?? 5);
const diskFree = process.env.SEL_STRESS_DISK_FREE ? BigInt(process.env.SEL_STRESS_DISK_FREE) : undefined;
class FixtureVision {
  calls = 0;
  releaseGate = new Promise(resolve => { globalThis.release = resolve; });
  async inventory() { this.calls += 1; return { candidates: [{ number: '1', box: { x: 0, y: 0, width: 1, height: 1 }, selectionEvidence: 'marked_wrong', partial: false }], warnings: [] }; }
  async recognizeQuestion() { await this.releaseGate; this.calls += 1; return { evidence: { version: 1, questionNumber: '1', questionText: 'x', subject: '数学', chapter: '', knowledgeTags: [], questionType: '计算', questionRegion: { x: 0, y: 0, width: 1, height: 1 }, requiresDiagram: false, regions: [], observations: [], uncertainties: [] }, verification: { textComplete: true, questionCropComplete: true, questionCropPure: true, transcriptionMatches: true, diagramSafe: true, issues: [] }, questionCrop: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), diagramCrops: [] }; }
}
const vision = new FixtureVision();
const manager = await PairingManager.open(dataDir);
const admission = new AdmissionController({ jobCapacity, diskProbe: diskFree !== undefined ? async () => diskFree : undefined });
const app = await createMobileApp({ dataDir, vision, mode: 'cloud', pairing: manager, cloudProxy: false, admission });
const server = app.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  console.log('READY ' + port);
});
const session = manager.createSession();
console.log('SESSION ' + JSON.stringify(session.payload));
process.stdin.on('data', chunk => { if (String(chunk).trim() === 'release') globalThis.release(); });
`;
}

interface StressService {
  proc: ChildProcess;
  port: number;
  payload: string;
  token: string;
  request(url: string, init?: RequestInit): Promise<Response>;
}

async function startService(options: { capacity?: number; diskFree?: string } = {}): Promise<StressService> {
  const dataDir = makeTempDir();
  tempDirs.push(dataDir);
  const script = path.join(dataDir, 'stress-service.mjs');
  fs.writeFileSync(script, serviceScript());
  const proc = spawn(NODE, [script], {
    env: { ...process.env, SEL_STRESS_DIR: dataDir, SEL_STRESS_CAPACITY: String(options.capacity ?? 5), ...(options.diskFree ? { SEL_STRESS_DISK_FREE: options.diskFree } : {}) },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let port = 0; let payload = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('stress service did not start')), 60_000);
    let buffer = '';
    const onStdout = (chunk: Buffer): void => {
      buffer += chunk.toString();
      const ready = /READY (\d+)/.exec(buffer);
      const session = /SESSION (.*)/.exec(buffer);
      if (ready?.[1] && session?.[1] && !port) {
        port = Number(ready[1]); payload = session[1]; clearTimeout(timer); resolve();
      }
    };
    proc.stdout!.on('data', onStdout);
    proc.stderr!.on('data', (chunk: Buffer) => { process.stderr.write(chunk); });
    proc.on('exit', (code) => { if (!port) { clearTimeout(timer); reject(new Error(`stress service exited early: ${code}`)); } });
  });
  const clientId = crypto.randomUUID();
  const redeemResponse = await fetch(`http://127.0.0.1:${port}/v1/pairing/redeem`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ payload: JSON.parse(payload), clientId, deviceInfo: 'stress' })
  });
  if (redeemResponse.status !== 200) throw new Error(`redeem failed: ${redeemResponse.status} ${await redeemResponse.text()}`);
  const { token } = await redeemResponse.json() as { token: string };
  const request = (url: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}${url}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  return { proc, port, payload, token, request };
}

const tempDirs: string[] = [];
const procs: ChildProcess[] = [];
afterAll(() => {
  procs.splice(0).forEach(proc => proc.kill('SIGTERM'));
  tempDirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true }));
});

async function submit(request: StressService['request'], bytes: Buffer, key = crypto.randomUUID()): Promise<Response> {
  return request('/v1/recognitions', {
    method: 'POST', headers: { 'content-type': 'image/jpeg', 'idempotency-key': key, 'x-photo-name': 'stress.jpg' },
    body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  });
}

const release = (svc: StressService): void => { svc.proc.stdin!.write('release\n'); };

describeWithGuard('ten-photo synthetic stress (resource behaviour only)', () => {
  let svc: StressService;
  beforeAll(async () => { svc = await startService({ capacity: 5 }); procs.push(svc.proc); });

  it('10 张高分辨率照片并发上传（429 busy 自动重试）：容量 5 内 5 张受理，其余 capacity_full，同键重放 202', { timeout: 240_000 }, async () => {
    const photos = await Promise.all(Array.from({ length: 10 }, (_, index) => bigJpeg(`#${(index * 23 + 0x40).toString(16).padStart(6, '0')}`)));
    const keys = Array.from({ length: 10 }, () => crypto.randomUUID());
    // Task 3 语义：同时最多 1 个上传正文在解析——并发 10 个会收到 429 busy（槽位，可重试）。
    // 真实客户端对 busy 与瞬时 rate_limited 都退避重试；只有容量裁决 capacity_full 不可重试。
    const submitWithRetry = async (index: number): Promise<{ status: number; body: { job?: { id: string }, error?: { code?: string } } }> => {
      for (let attempt = 0; ; attempt += 1) {
        const response = await submit(svc.request, photos[index]!, keys[index]);
        const body = await response.json() as { job?: { id: string }, error?: { code?: string } };
        if (response.status === 202) return { status: response.status, body };
        const retryable = response.status === 429 && body.error?.code !== 'capacity_full';
        if (retryable && attempt < 40) {
          await new Promise(resolve => setTimeout(resolve, 250 + Math.random() * 250));
          continue;
        }
        return { status: response.status, body };
      }
    };
    const results = await Promise.all(photos.map((_, index) => submitWithRetry(index)));
    const statuses = results.map(result => result.status);
    // 容量 5：恰 5 张 202 + 5 张 429，其余状态一律不存在（多重集精确断言）；429 一律是容量裁决而非槽位/限流。
    expect(statuses.filter(status => status === 202)).toHaveLength(5);
    expect(statuses.filter(status => status === 429)).toHaveLength(5);
    expect(statuses).toHaveLength(10);
    for (const result of results) {
      if (result.status === 429) expect(result.body.error?.code).toBe('capacity_full');
    }
    // 幂等重放：同键重放已受理任务应 202（可查），同 jobId，不占新容量。
    const firstAccepted = results.findIndex(result => result.status === 202);
    const replay = await submit(svc.request, photos[firstAccepted]!, keys[firstAccepted]!);
    expect(replay.status).toBe(202);
    const replayBody = await replay.json() as { job: { id: string } };
    expect(replayBody.job.id).toBe(results[firstAccepted]!.body.job!.id);
    // 放行识别，等待全部受理任务终态（单服务串行 5 题；250ms 轮询尊重 300/分钟限流）。
    release(svc);
    const deadline = Date.now() + 30_000;
    let jobs: Array<{ status: string }> = [];
    while (Date.now() < deadline) {
      const body = await (await svc.request('/v1/recognitions')).json() as { jobs: Array<{ status: string }> };
      jobs = body.jobs;
      if (jobs.length === 5 && jobs.every(job => ['completed', 'partial', 'failed'].includes(job.status))) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    expect(jobs.length).toBe(5);
    expect(jobs.every(job => ['completed', 'partial', 'failed'].includes(job.status))).toBe(true);
    // 终态后容量归还：新照片可再次受理。
    const afterRelease = await submit(svc.request, await bigJpeg('#305a70'));
    expect(afterRelease.status).toBe(202);
    release(svc);
    const deadline2 = Date.now() + 30_000;
    let job: { status: string } | null = null;
    const { job: created } = await afterRelease.json() as { job: { id: string } };
    while (Date.now() < deadline2) {
      const body = await (await svc.request(`/v1/recognitions/${created.id}`)).json() as { job?: { status: string } };
      if (body.job && ['completed', 'partial', 'failed'].includes(body.job.status)) { job = body.job; break; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    expect(job).not.toBeNull();
  });
});

describeWithGuard('disk gate and interrupted recovery under stress', () => {
  it('磁盘门槛（系统盘 <3GiB）拒收 503，不产生半受理任务', { timeout: 120_000 }, async () => {
    const svc = await startService({ capacity: 5, diskFree: (2 * 1024 ** 3).toString() });
    procs.push(svc.proc);
    const response = await submit(svc.request, await bigJpeg('#504030'));
    expect(response.status).toBe(503);
    const body = await response.json() as { error: { code: string } };
    expect(body.error.code).toBe('disk_low');
    const list = await (await svc.request('/v1/recognitions')).json() as { jobs: unknown[] };
    expect(list.jobs).toHaveLength(0);
  });

  it('服务进程中断后重启：在途任务被自愈扫描自动恢复（无需人工重试）', { timeout: 180_000 }, async () => {
    const dataDir = makeTempDir();
    tempDirs.push(dataDir);
    const script = path.join(dataDir, 'stress-service.mjs');
    fs.writeFileSync(script, serviceScript());
    const start = (): { proc: ChildProcess; ready: Promise<{ port: number; payload: string }> } => {
      const proc = spawn(NODE, [script], { env: { ...process.env, SEL_STRESS_DIR: dataDir, SEL_STRESS_CAPACITY: '5' }, stdio: ['pipe', 'pipe', 'pipe'] });
      let buffer = '';
      const ready = new Promise<{ port: number; payload: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('restart service did not start')), 60_000);
        proc.stdout!.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const port = /READY (\d+)/.exec(buffer);
          const session = /SESSION (.*)/.exec(buffer);
          if (port?.[1] && session?.[1] && !(ready as unknown as { settled?: boolean }).settled) {
            (ready as unknown as { settled?: boolean }).settled = true;
            clearTimeout(timer); resolve({ port: Number(port[1]), payload: session[1] });
          }
        });
        proc.stderr!.on('data', (chunk: Buffer) => { process.stderr.write(chunk); });
      });
      return { proc, ready };
    };
    // 第一次启动：提交一张照片（不 release，题目挂在识别中）。
    const first = start(); procs.push(first.proc);
    const firstInfo = await first.ready;
    const redeem = await fetch(`http://127.0.0.1:${firstInfo.port}/v1/pairing/redeem`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: JSON.parse(firstInfo.payload), clientId: crypto.randomUUID(), deviceInfo: 'stress' })
    });
    const { token } = await redeem.json() as { token: string };
    const request = (port: number, url: string, init: RequestInit = {}): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}${url}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
    const bytes = await bigJpeg('#204060');
    const ok = await request(firstInfo.port, '/v1/recognitions', {
      method: 'POST', headers: { 'content-type': 'image/jpeg', 'idempotency-key': crypto.randomUUID(), 'x-photo-name': 'restart.jpg' },
      body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    });
    expect(ok.status).toBe(202);
    const { job } = await ok.json() as { job: { id: string } };
    // 等到【题目级】processing 再杀：job 级 processing 的窗口可能仍在清单阶段（两次持久化之间），
    // 杀在窗口内会让重启后 questions 为空、走清单阶段的 interrupted 路径，与"题目挂在识别中"的意图不符。
    const processing = await new Promise<boolean>(resolve => {
      const deadline = Date.now() + 30_000;
      const poll = async (): Promise<void> => {
        const body = await (await request(firstInfo.port, `/v1/recognitions/${job.id}`)).json() as { job?: { status: string; phase: string; questions: Array<{ status: string }> } };
        if (body.job?.phase === 'questions' && body.job.questions.some(question => question.status === 'processing')) { resolve(true); return; }
        if (Date.now() > deadline) { resolve(false); return; }
        // 250ms 轮询尊重云端 300 次/分钟/设备限流（200ms=300/分钟恰在边界）。
        setTimeout(poll, 250);
      };
      void poll();
    });
    expect(processing).toBe(true);
    // 硬杀进程（SIGKILL = 真中断）。
    first.proc.kill('SIGKILL');
    await new Promise(resolve => setTimeout(resolve, 500));
    // 重启：同 dataDir、同 token 应失效前的设备令牌仍有效（令牌库持久化）。
    const second = start(); procs.push(second.proc);
    const secondInfo = await second.ready;
    // 2026-09-20 起（真机验收反馈）：自愈扫描在启动时自动恢复被中断的任务，不再停在 interrupted 等人工点重试。
    const resumed = await new Promise<boolean>(resolve => {
      const deadline = Date.now() + 30_000;
      const poll = async (): Promise<void> => {
        const body = await (await request(secondInfo.port, `/v1/recognitions/${job.id}`)).json() as { job?: { status: string } };
        if (body.job && body.job.status !== 'interrupted') { resolve(true); return; }
        if (Date.now() > deadline) { resolve(false); return; }
        // 250ms 轮询尊重云端 300 次/分钟/设备限流（200ms=300/分钟恰在边界）。
        setTimeout(poll, 250);
      };
      void poll();
    });
    expect(resumed).toBe(true);
    // 整单重试仍被拒（null questionId 只适用清单阶段；questions 阶段已由自愈接管）。
    const nullRetry = await request(secondInfo.port, `/v1/recognitions/${job.id}/retry`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ questionId: null })
    });
    expect(nullRetry.status).toBe(409);
    const nullBody = await nullRetry.json() as { error: { code: string } };
    expect(nullBody.error.code).toBe('not_retryable');
    // 释放识别门（第二进程内）：自动恢复的题名直接跑完，全程无人工重试。
    second.proc.stdin!.write('release\n');
    const terminal = await new Promise<{ status: string } | null>(resolve => {
      const deadline = Date.now() + 30_000;
      const poll = async (): Promise<void> => {
        const body = await (await request(secondInfo.port, `/v1/recognitions/${job.id}`)).json() as { job?: { status: string } };
        if (body.job && ['completed', 'partial', 'failed'].includes(body.job.status)) { resolve(body.job); return; }
        if (Date.now() > deadline) { resolve(null); return; }
        setTimeout(poll, 250);
      };
      void poll();
    });
    expect(terminal).not.toBeNull();
    expect(['completed', 'partial']).toContain(terminal!.status);
  });
});
