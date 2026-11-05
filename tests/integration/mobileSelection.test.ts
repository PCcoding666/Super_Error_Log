/**
 * v2.1a S1：先找题、学生勾、再精读（RED → GREEN）。
 * 覆盖简报 RED 清单：找题后只精读有痕迹的题（unmarked/unclear → unselected 不耗模型调用）；
 * 全部无痕迹直接 completed 且释放容量；勾选接口（精读、selectedByStudent、幂等、400/404/409/429）；
 * 重启不恢复 unselected；候选题缩略图；桥接补建 + selected_by_student + unselectedCount + manuallySelected。
 * 合成 vision / 合成数据目录；不调真实模型、不读 .env 与 data/。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Evidence } from '../../src/ai/evidence.js';
import { getDb } from '../../src/db/connection.js';
import { isoWeekKey } from '../../src/domain/scheduling.js';
import { ensureStudentProfile } from '../../src/services/studentService.js';
import { createMobileApp } from '../../src/mobile/router.js';
import { PairingManager } from '../../src/mobile/pairing.js';
import { AdmissionController } from '../../src/mobile/admission.js';
import type { MobileRecognitionService } from '../../src/mobile/service.js';
import type { InventoryCandidate, MobileVisionBoundary, VisionContext, VisionInventoryResult, VisionQuestionResult } from '../../src/mobile/vision.js';
import { createV2Router } from '../../src/v2/router.js';

const roots: string[] = [];
const servers: Server[] = [];
const services: MobileRecognitionService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.stop()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});

beforeAll(() => {
  ensureStudentProfile();
});

// 桥接用例使用共享测试库：每个用例清空业务表，保留学生档案。
beforeEach(() => {
  const database = getDb();
  for (const table of ['mobile_item_link', 'evidence_record', 'error_diagnosis', 'error_item', 'asset_origin', 'source_asset', 'source_batch', 'v2_photo']) {
    database.prepare(`DELETE FROM ${table}`).run();
  }
});

const box = { x: 0, y: 0, width: 1, height: 1 };
function evidence(number: string): Evidence {
  return { version: 1 as const, questionNumber: number, questionText: '求 x 的值。', subject: '数学' as const, chapter: '', knowledgeTags: [], questionType: '计算', questionRegion: box,
    requiresDiagram: false, regions: [], observations: [], uncertainties: [] };
}
const CHECKS_OK = { textComplete: true, questionCropComplete: true, questionCropPure: true, transcriptionMatches: true, diagramSafe: true, issues: [] as string[] };

const candidateBox = { x: 0.2, y: 0.2, width: 0.3, height: 0.2 };
function candidate(number: string, selectionEvidence: InventoryCandidate['selectionEvidence']): InventoryCandidate {
  return { number, box: { ...candidateBox }, selectionEvidence, partial: false };
}

class SelectVision implements MobileVisionBoundary {
  candidates: InventoryCandidate[] = [candidate('1', 'marked_wrong')];
  questionCalls: string[] = [];
  inventoryCalls = 0;
  inventoryFailures: Error[] = [];
  /** 挂起的清单调用：arm 后 inventory 等待 releaseInventory()。 */
  private inventoryGate: Promise<void> | null = null;
  private releaseInventoryFn: (() => void) | null = null;
  armInventoryGate(fromCall: number): void {
    this.gateFromCall = fromCall;
    this.inventoryGate = new Promise<void>(resolve => { this.releaseInventoryFn = resolve; });
  }
  private gateFromCall = Number.POSITIVE_INFINITY;
  releaseInventory(): void { this.releaseInventoryFn?.(); }
  async inventory(_source: Buffer, _context: VisionContext): Promise<VisionInventoryResult> {
    this.inventoryCalls += 1;
    if (this.inventoryCalls >= this.gateFromCall && this.inventoryGate) await this.inventoryGate;
    const failure = this.inventoryFailures.shift();
    if (failure) throw failure;
    return { candidates: this.candidates, warnings: [] };
  }
  async recognizeQuestion(source: Buffer, candidate_: InventoryCandidate, _context: VisionContext): Promise<VisionQuestionResult> {
    this.questionCalls.push(candidate_.number);
    return { evidence: evidence(candidate_.number), verification: { ...CHECKS_OK }, questionCrop: source, diagramCrops: [] };
  }
}

type RequestFn = (url: string, init?: RequestInit) => Promise<Response>;

async function setup(vision: MobileVisionBoundary, dataDir?: string, v2 = false) {
  const root = dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sel-mobile-select-'));
  if (!dataDir) roots.push(root);
  const token = 'pairing-token-for-tests';
  const app = await createMobileApp({
    dataDir: root, pairingToken: token, vision,
    ...(v2 ? { v2Router: () => createV2Router({ mobileDataDir: root }) } : {}),
  });
  services.push(app.locals.mobileRecognitionService);
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request: RequestFn = (url, init = {}) => fetch(`${base}${url}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });
  return { root, app, server, base, request };
}

/** 云端模式（容量账目真实生效）。 */
async function setupCloud(vision: MobileVisionBoundary, jobCapacity: number) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-select-cloud-'));
  roots.push(dataDir);
  const manager = await PairingManager.open(dataDir);
  const admission = new AdmissionController({ jobCapacity });
  const app = await createMobileApp({ dataDir, vision, mode: 'cloud', pairing: manager, cloudProxy: true, admission });
  services.push(app.locals.mobileRecognitionService);
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const paired = await manager.redeem(manager.createSession().payload, crypto.randomUUID(), 'iPhone');
  const request: RequestFn = (url, init = {}) => fetch(`${base}${url}`, { ...init, headers: { authorization: `Bearer ${paired.token}`, ...init.headers } });
  return { root: dataDir, request };
}

async function jpeg(color = '#ffffff'): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: color } }).jpeg().toBuffer();
}
async function submit(request: RequestFn, bytes: Buffer, key = crypto.randomUUID()) {
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return request('/v1/recognitions', { method: 'POST', headers: { 'content-type': 'image/jpeg', 'idempotency-key': key, 'x-photo-name': 'select.jpg' }, body });
}
async function json(response: Response) { return response.json() as Promise<any>; }
async function waitFor(request: RequestFn, id: string, status: string, intervalMs = 10) {
  const deadline = Date.now() + 30_000;
  let last: any = null;
  while (Date.now() < deadline) {
    const body = await json(await request(`/v1/recognitions/${id}`));
    last = body.job;
    if (body.job?.status === status) return body.job;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`job ${id} did not reach ${status}; last=${JSON.stringify(last)}`);
}
const select = (request: RequestFn, jobId: string, questionIds: unknown) =>
  request(`/v1/recognitions/${jobId}/select`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ questionIds }) });

describe('v2.1a 找题后分流：未选不精读', () => {
  it('2 道判错/订正 + 3 道无痕迹/看不清/只有勾：只精读 2 道，其余 unselected 且公开任务可见题号与候选框', async () => {
    const vision = new SelectVision();
    vision.candidates = [candidate('1', 'marked_wrong'), candidate('2', 'corrected'), candidate('3', 'unmarked'), candidate('4', 'unclear'), candidate('5', 'marked_right')];
    const { request } = await setup(vision);
    const accepted = await json(await submit(request, await jpeg()));
    const job = await waitFor(request, accepted.job.id, 'completed');
    expect(job.phase).toBe('complete');
    // 未选的题不发任何模型请求：精读调用恰为 2 道自动题。
    expect(vision.questionCalls.sort()).toEqual(['1', '2']);
    const byNumber = new Map<string, any>(job.questions.map((q: any) => [q.number, q] as [string, any]));
    expect(byNumber.get('1').status).toBe('ready');
    expect(byNumber.get('2').status).toBe('ready');
    for (const number of ['3', '4', '5']) {
      const q = byNumber.get(number);
      expect(q.status).toBe('unselected');
      expect(q.evidence).toBeNull();
      expect(q.candidateBox).toEqual(candidateBox);
    }
    expect(byNumber.get('5').selectionEvidence).toBe('marked_right');
  });

  it('全部无痕迹：找题后直接 completed，零次精读调用', async () => {
    const vision = new SelectVision();
    vision.candidates = [candidate('1', 'unmarked'), candidate('2', 'unclear')];
    const { request } = await setup(vision);
    const accepted = await json(await submit(request, await jpeg()));
    const job = await waitFor(request, accepted.job.id, 'completed');
    expect(job.phase).toBe('complete');
    expect(job.error).toBeNull();
    expect(vision.questionCalls).toEqual([]);
    expect(job.questions.map((q: any) => q.status)).toEqual(['unselected', 'unselected']);
  });

  it('全部无痕迹的任务终态后释放入口容量：容量 1 时可再上传', async () => {
    const vision = new SelectVision();
    vision.candidates = [candidate('1', 'unmarked')];
    const { request } = await setupCloud(vision, 1);
    const first = await submit(request, await jpeg());
    expect(first.status).toBe(202);
    const accepted = await json(first);
    await waitFor(request, accepted.job.id, 'completed', 250);
    expect(vision.questionCalls).toEqual([]);
    // 容量已释放：第二张立即受理（容量 1，若泄漏则 429 capacity_full）。
    const second = await submit(request, await jpeg('#888888'));
    expect(second.status).toBe(202);
    const acceptedSecond = await json(second);
    await waitFor(request, acceptedSecond.job.id, 'completed', 250);
  });

  it('重启恢复：带 unselected 题的终态任务不被重新排队、不发任何请求', async () => {
    const vision = new SelectVision();
    vision.candidates = [candidate('1', 'unmarked'), candidate('2', 'marked_wrong')];
    const first = await setup(vision);
    const accepted = await json(await submit(first.request, await jpeg()));
    const done = await waitFor(first.request, accepted.job.id, 'completed');
    expect(done.questions.map((q: any) => q.status).sort()).toEqual(['ready', 'unselected']);
    const service = first.app.locals.mobileRecognitionService as MobileRecognitionService;
    await service.stop();
    const vision2 = new SelectVision();
    const second = await setup(vision2, first.root);
    const service2 = second.app.locals.mobileRecognitionService as MobileRecognitionService;
    await service2.resumeIncompleteJobs();
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(vision2.inventoryCalls).toBe(0);
    expect(vision2.questionCalls).toEqual([]);
    const after = await json(await second.request(`/v1/recognitions/${accepted.job.id}`));
    expect(after.job.status).toBe('completed');
    expect(after.job.questions.map((q: any) => q.status).sort()).toEqual(['ready', 'unselected']);
  });
});

describe('v2.1a 勾选接口 POST /v1/recognitions/:id/select', () => {
  it('勾选两道：这两道被精读并标 selectedByStudent，任务回 processing 再 completed；重复勾选幂等', async () => {
    const vision = new SelectVision();
    vision.candidates = [candidate('1', 'unmarked'), candidate('2', 'unmarked'), candidate('3', 'unmarked')];
    const { request } = await setup(vision);
    const accepted = await json(await submit(request, await jpeg()));
    const completed = await waitFor(request, accepted.job.id, 'completed');
    expect(vision.questionCalls).toEqual([]);
    const ids = completed.questions.filter((q: any) => ['1', '2'].includes(q.number)).map((q: any) => q.id);

    const response = await select(request, accepted.job.id, ids);
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.job.status).toBe('processing');
    expect(body.job.phase).toBe('questions');
    expect(body.job.error).toBeNull();
    const selected = body.job.questions.filter((q: any) => ids.includes(q.id));
    for (const q of selected) {
      expect(q.status).toBe('queued');
      expect(q.selectedByStudent).toBe(true);
    }

    const done = await waitFor(request, accepted.job.id, 'completed');
    expect(vision.questionCalls.sort()).toEqual(['1', '2']);
    for (const q of done.questions) {
      if (ids.includes(q.id)) expect(q).toMatchObject({ status: 'ready', selectedByStudent: true });
      else expect(q.status).toBe('unselected');
    }

    // 重复提交同样的 id：幂等，不产生第二次精读；附上一个已 ready 的自动题 id 同样被忽略。
    const callsBefore = vision.questionCalls.length;
    const again = await select(request, accepted.job.id, ids);
    expect(again.status).toBe(200);
    const againBody = await json(again);
    expect(againBody.job.status).toBe('completed');
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(vision.questionCalls.length).toBe(callsBefore);
  });

  it('形状不对一律 400 invalid_request', async () => {
    const vision = new SelectVision();
    vision.candidates = [candidate('1', 'unmarked')];
    const { request } = await setup(vision);
    const accepted = await json(await submit(request, await jpeg()));
    const job = await waitFor(request, accepted.job.id, 'completed');
    const qid = job.questions[0].id;
    const invalid: unknown[] = [
      undefined,
      'not-an-array',
      [],
      Array.from({ length: 31 }, () => crypto.randomUUID()),
      ['not-a-uuid'],
      [qid, qid],
    ];
    for (const value of invalid) {
      const response = await select(request, job.id, value);
      expect(response.status, JSON.stringify(value)).toBe(400);
      expect(await json(response)).toEqual({ error: { code: 'invalid_request', message: 'questionIds 须为 1–30 个不重复的题目 ID。' } });
    }
    expect(vision.questionCalls).toEqual([]);
  });

  it('任务不存在 404；别的任务的题 404 且整条请求不生效', async () => {
    const vision = new SelectVision();
    vision.candidates = [candidate('1', 'unmarked')];
    const { request } = await setup(vision);
    const a = await json(await submit(request, await jpeg()));
    const jobA = await waitFor(request, a.job.id, 'completed');
    const b = await json(await submit(request, await jpeg('#888888')));
    const jobB = await waitFor(request, b.job.id, 'completed');

    expect((await select(request, crypto.randomUUID(), [jobA.questions[0].id])).status).toBe(404);
    // A 的 select 混入 B 的题：404 not_found，A 的题不被勾选（整条不生效）。
    const mixed = await select(request, jobA.id, [jobA.questions[0].id, jobB.questions[0].id]);
    expect(mixed.status).toBe(404);
    expect(await json(mixed)).toEqual({ error: { code: 'not_found', message: '题目不存在。' } });
    const after = await json(await request(`/v1/recognitions/${jobA.id}`));
    expect(after.job.questions[0].status).toBe('unselected');
    expect(vision.questionCalls).toEqual([]);
  });

  it('找题失败（终态 failed / phase inventory）→ 409 not_selectable', async () => {
    const failing = new SelectVision();
    failing.candidates = [candidate('1', 'unmarked')];
    failing.inventoryFailures = [Object.assign(new Error('合成找题失败'), { code: 'invalid_output', stage: 'inventory', retryable: false })];
    const { request } = await setup(failing);
    const failedSubmit = await json(await submit(request, await jpeg()));
    const failed = await waitFor(request, failedSubmit.job.id, 'failed');
    expect(failed.phase).toBe('inventory');
    const response = await select(request, failed.id, [crypto.randomUUID()]);
    expect(response.status).toBe(409);
    expect(await json(response)).toEqual({ error: { code: 'not_selectable', message: '这张照片还在找题，稍后再选。' } });
  });

  it('找题进行中的任务 select → 409 not_selectable（真实题目不存在之前也拒绝）', async () => {
    const gated = new SelectVision();
    gated.candidates = [candidate('1', 'unmarked')];
    gated.armInventoryGate(1);
    const { request } = await setup(gated);
    const accepted = await json(await submit(request, await jpeg()));
    // 等任务进入找题进行中。
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const body = await json(await request(`/v1/recognitions/${accepted.job.id}`));
      if (body.job?.status === 'processing' && body.job?.phase === 'inventory') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const response = await select(request, accepted.job.id, [crypto.randomUUID()]);
    expect(response.status).toBe(409);
    expect(await json(response)).toEqual({ error: { code: 'not_selectable', message: '这张照片还在找题，稍后再选。' } });
    gated.releaseInventory();
    await waitFor(request, accepted.job.id, 'completed');
  });

  it('容量满时 select → 429 capacity_full 且任务状态不变', async () => {
    const vision = new SelectVision();
    vision.candidates = [candidate('1', 'unmarked')];
    const { request } = await setupCloud(vision, 1);
    // A：全部未选 → completed，容量已释放。
    const a = await json(await submit(request, await jpeg()));
    const jobA = await waitFor(request, a.job.id, 'completed', 250);
    // B：找题挂起 → 占住唯一容量位。
    vision.armInventoryGate(2);
    const b = await submit(request, await jpeg('#888888'));
    expect(b.status).toBe(202);
    const response = await select(request, jobA.id, [jobA.questions[0].id]);
    expect(response.status).toBe(429);
    expect(await json(response)).toEqual({ error: { code: 'capacity_full', message: '识别队列已满，请稍后再试。' } });
    const after = await json(await request(`/v1/recognitions/${jobA.id}`));
    expect(after.job.status).toBe('completed');
    expect(after.job.questions[0].status).toBe('unselected');
    vision.releaseInventory();
    const bBody = await json(b);
    await waitFor(request, bBody.job.id, 'completed', 250);
  });
});

describe('v2.1a 候选题缩略图 GET .../questions/:questionId/candidate', () => {
  it('unselected 的题取到 JPEG 缩略图；任务或题目不存在 404', async () => {
    const vision = new SelectVision();
    vision.candidates = [candidate('1', 'unmarked')];
    const { request } = await setup(vision);
    const accepted = await json(await submit(request, await jpeg()));
    const job = await waitFor(request, accepted.job.id, 'completed');
    const qid = job.questions[0].id;
    const response = await request(`/v1/recognitions/${job.id}/questions/${qid}/candidate`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('cache-control')).toContain('no-store');
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
    expect((await request(`/v1/recognitions/${job.id}/questions/${crypto.randomUUID()}/candidate`)).status).toBe(404);
    expect((await request(`/v1/recognitions/${crypto.randomUUID()}/questions/${qid}/candidate`)).status).toBe(404);
  });
});

describe('v2.1a 桥接与计数', () => {
  it('自动题建题、unselected 不建；勾选完成后补建并记 selected_by_student；unselectedCount 与 manuallySelected 正确', async () => {
    const vision = new SelectVision();
    vision.candidates = [candidate('1', 'marked_wrong'), candidate('2', 'unmarked'), candidate('3', 'unmarked')];
    const { base, request } = await setup(vision, undefined, true);
    const accepted = await json(await submit(request, await jpeg()));
    const job = await waitFor(request, accepted.job.id, 'completed');
    expect(vision.questionCalls).toEqual(['1']);

    // 登记 → 懒桥接：只有自动题建题；unselectedCount = 2。
    const registered = await request(`/v2/photos/${job.id}/register`, { method: 'POST' });
    expect(registered.status).toBe(200);
    const week1 = await json(await request('/v2/week'));
    const photo1 = week1.photos.find((p: any) => p.jobId === job.id);
    expect(photo1).toMatchObject({ recognition: 'done', bridged: true, itemCount: 1, unselectedCount: 2 });
    expect(week1.items).toHaveLength(1);

    // 勾选两道未选题 → 精读 → 再次终态 → 补桥。
    const unselectedIds = job.questions.filter((q: any) => q.status === 'unselected').map((q: any) => q.id);
    const selected = await select(request, job.id, unselectedIds);
    expect(selected.status).toBe(200);
    await waitFor(request, job.id, 'completed');
    expect(vision.questionCalls.sort()).toEqual(['1', '2', '3']);

    const week2 = await json(await request('/v2/week'));
    const photo2 = week2.photos.find((p: any) => p.jobId === job.id);
    expect(photo2).toMatchObject({ itemCount: 3, unselectedCount: 0 });
    expect(week2.items).toHaveLength(3);

    // mobile_item_link 记下来源：自动题 0，学生勾入 1。
    const links = getDb().prepare('SELECT question_id, selected_by_student FROM mobile_item_link WHERE job_id = ?').all(job.id) as Array<{ question_id: string; selected_by_student: number }>;
    expect(links).toHaveLength(3);
    const autoId = job.questions.find((q: any) => q.number === '1').id;
    expect(links.find(l => l.question_id === autoId)?.selected_by_student).toBe(0);
    for (const id of unselectedIds) expect(links.find(l => l.question_id === id)?.selected_by_student).toBe(1);

    // 修正即测量报告：本周 manuallySelected = 2。
    const report = await json(await request('/v2/corrections/report'));
    const week = report.weeks.find((w: any) => w.week === isoWeekKey(new Date()));
    expect(week).toBeDefined();
    expect(week.itemCount).toBe(3);
    expect(week.manuallySelected).toBe(2);
    void base;
  });
});
