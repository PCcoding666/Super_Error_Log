import { resetMaterials } from '../helpers/resetMaterials.js';
/**
 * T4a：本周错题卡片、删/恢复、学生设置（RED → GREEN）。
 * 真实 HTTP（回环装配，共享令牌鉴权）+ 合成识别任务 + 临时移动数据目录。
 * 不调真实模型、不读 .env 与 data/。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Evidence } from '../../src/ai/evidence.js';
import { getDb, now } from '../../src/db/connection.js';
import { isoWeekKey } from '../../src/domain/scheduling.js';
import { ensureStudentProfile } from '../../src/services/studentService.js';
import { createMobileApp } from '../../src/mobile/router.js';
import { MobileRecognitionStore } from '../../src/mobile/store.js';
import type { RecognitionQuestion, RecognitionVerification, StoredRecognitionJob } from '../../src/mobile/contracts.js';
import type { MobileVisionBoundary, VisionContext, VisionInventoryResult, VisionQuestionResult, InventoryCandidate } from '../../src/mobile/vision.js';
import type { MobileRecognitionService } from '../../src/mobile/service.js';
import { createV2Router } from '../../src/v2/router.js';

const roots: string[] = [];
const servers: Server[] = [];
const loopbackServices: MobileRecognitionService[] = [];
afterEach(async () => {
  await Promise.all(loopbackServices.splice(0).map(service => service.stop()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});

beforeAll(() => {
  ensureStudentProfile();
});

// 每个用例清空业务表（共享测试库），保留学生档案。
beforeEach(() => {
  const database = getDb();
  resetMaterials(database);
  for (const table of ['review_attempt', 'review_packet_item', 'review_packet', 'mobile_item_link', 'evidence_record', 'error_diagnosis', 'error_item', 'asset_origin', 'source_asset', 'source_batch', 'v2_photo', 'v2_setting']) {
    database.prepare(`DELETE FROM ${table}`).run();
  }
});

const box = { x: 0, y: 0, width: 1, height: 1 };
class FixtureVision implements MobileVisionBoundary {
  async inventory(_source: Buffer, _context: VisionContext): Promise<VisionInventoryResult> {
    return { candidates: [], warnings: [] };
  }
  async recognizeQuestion(_source: Buffer, _candidate: InventoryCandidate, _context: VisionContext): Promise<VisionQuestionResult> {
    throw new Error('不应被调用');
  }
}

const CHECKS: RecognitionVerification = { textComplete: true, questionCropComplete: true, questionCropPure: true, transcriptionMatches: true, diagramSafe: true, issues: [] };

async function jpeg(color = '#ffffff'): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: color } }).jpeg().toBuffer();
}

function evidence(number: string, text = '已知 x+y=3，求 x 的值。'): Evidence {
  return {
    version: 1, questionNumber: number, questionText: text, subject: '数学', chapter: '方程',
    knowledgeTags: ['一元一次方程'], questionType: '计算',
    questionRegion: { x: .1, y: .1, width: .8, height: .8 }, requiresDiagram: false,
    regions: [{ id: 's1', kind: 'student_work', box: { x: .2, y: .2, width: .2, height: .2 }, confidence: .9, cleanForPrint: false }],
    observations: [{ id: 'o1', kind: 'student_work', text: 'x=1', regionId: 's1', confidence: .9 }],
    uncertainties: [],
  };
}

let seq = 0;
function question(partial: Partial<RecognitionQuestion> & { number?: string } = {}): RecognitionQuestion {
  seq += 1;
  const number = partial.number ?? String(seq);
  return {
    id: crypto.randomUUID(), number, revision: 1, status: 'ready', selectionEvidence: 'marked_wrong',
    evidence: evidence(number), verification: { ...CHECKS }, questionMediaId: null, diagramMediaIds: [],
    error: null, confirmedAt: null, ...partial,
  };
}

async function tempDir(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-t4a-week-'));
  roots.push(dir);
  return dir;
}

/** 造一个终态（completed）识别任务，含给定题目。 */
async function makeJob(dir: string, questions: RecognitionQuestion[], sourceBytes?: Buffer): Promise<string> {
  const store = await MobileRecognitionStore.open(dir);
  const bytes = sourceBytes ?? await jpeg(`#${String((seq * 37) % 0xffffff).padStart(6, '0')}`);
  const { job } = await store.createJob({ idempotencyKey: crypto.randomUUID(), photoName: 'photo.jpg', sourceBytes: bytes, normalizedBytes: bytes });
  await store.updateJob(job.id, j => {
    j.phase = 'complete'; j.status = 'completed'; j.revision += 1;
    j.questions = questions;
  });
  return job.id;
}

const PAIRING = 't4a-shared-token-0123456789';

interface WeekItem {
  id: string; shortId: string | null; subject: string | null; knowledgeTags: string[];
  questionExcerpt: string | null; badge: 'ok' | 'low'; status: string; cropUrl: string; jobId: string;
}
interface WeekPhoto {
  jobId: string; registeredAt: string; recognition: 'processing' | 'done' | 'failed';
  bridged: boolean; bridgeError: string | null; itemCount: number;
}
interface WeekResponse { week: string; photos: WeekPhoto[]; items: WeekItem[]; backlog: WeekItem[] }

async function setupApp(): Promise<{ base: string; dataDir: string; auth: { authorization: string } }> {
  const dataDir = await tempDir();
  const app = await createMobileApp({
    dataDir, pairingToken: PAIRING, vision: new FixtureVision(),
    v2Router: () => createV2Router({ mobileDataDir: dataDir }),
  });
  loopbackServices.push(app.locals.mobileRecognitionService);
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, dataDir, auth: { authorization: `Bearer ${PAIRING}` } };
}

const getWeek = async (base: string, auth: { authorization: string }): Promise<WeekResponse> => {
  const response = await fetch(`${base}/v2/week`, { headers: auth });
  expect(response.status).toBe(200);
  return (await response.json()) as WeekResponse;
};

const registerPhoto = (base: string, auth: { authorization: string }, jobId: string) =>
  fetch(`${base}/v2/photos/${jobId}/register`, { method: 'POST', headers: auth });

describe('T4a 本周错题卡片 / 删恢复 / 学生设置', () => {
  it('RED1 未登记照片不出现在 /v2/week；登记后出现且懒桥接出的题进 items', async () => {
    const { base, dataDir, auth } = await setupApp();
    const jobId = await makeJob(dataDir, [question({ number: '1' })]);

    const before = await getWeek(base, auth);
    expect(before.week).toBe(isoWeekKey(new Date()));
    expect(before.photos).toEqual([]);
    expect(before.items).toEqual([]);
    expect(before.backlog).toEqual([]);

    const registered = await registerPhoto(base, auth, jobId);
    expect(registered.status).toBe(200);

    const after = await getWeek(base, auth);
    expect(after.photos).toHaveLength(1);
    expect(after.photos[0]).toMatchObject({ jobId, recognition: 'done', bridged: true, bridgeError: null, itemCount: 1 });
    expect(after.items).toHaveLength(1);
    const item = after.items[0]!;
    expect(item.jobId).toBe(jobId);
    expect(item.shortId).toMatch(/^M-\d+$/);
    expect(item.subject).toBe('数学');
    expect(item.knowledgeTags).toEqual(['一元一次方程']);
    expect(item.questionExcerpt).toContain('求 x 的值');
    expect(item.badge).toBe('ok');
    expect(item.status).toBe('ready_for_reflection');
    expect(item.cropUrl).toBe(`/v2/items/${item.id}/crop`);
    expect(after.backlog).toEqual([]);
  });

  it('RED2 register 对不存在的 jobId 返回 404；重复登记幂等', async () => {
    const { base, dataDir, auth } = await setupApp();
    const missing = await registerPhoto(base, auth, crypto.randomUUID());
    expect(missing.status).toBe(404);

    const jobId = await makeJob(dataDir, [question({ number: '1' })]);
    const first = await registerPhoto(base, auth, jobId);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { jobId: string; registeredAt: string };
    expect(firstBody.jobId).toBe(jobId);

    const second = await registerPhoto(base, auth, jobId);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(firstBody);
    const rows = getDb().prepare('SELECT COUNT(*) AS n FROM v2_photo WHERE job_id = ?').get(jobId) as { n: number };
    expect(rows.n).toBe(1);
  });

  it('RED3 crop 返回 JPEG；Web 来源题与不存在的题 404', async () => {
    const { base, dataDir, auth } = await setupApp();
    const jobId = await makeJob(dataDir, [question({ number: '1' })]);
    await registerPhoto(base, auth, jobId);
    const week = await getWeek(base, auth);
    const itemId = week.items[0]!.id;

    const crop = await fetch(`${base}/v2/items/${itemId}/crop`, { headers: auth });
    expect(crop.status).toBe(200);
    expect(crop.headers.get('content-type')).toContain('image/jpeg');
    expect(crop.headers.get('cache-control')).toContain('no-store');
    const bytes = Buffer.from(await crop.arrayBuffer());
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);

    // Web 来源题：直接插 error_item（无 mobile_item_link）。
    const student = ensureStudentProfile();
    const db = getDb();
    db.prepare("INSERT INTO source_batch (id, student_id, status, total_files, done_files, created_at) VALUES ('bat_web', ?, 'done', 1, 1, ?)").run(student.id, now());
    db.prepare("INSERT INTO source_asset (id, batch_id, filename, mime, size, content_hash, status, storage_path, created_at) VALUES ('ast_web', 'bat_web', 'w.jpg', 'image/jpeg', 1, 'hash-web', 'done', '/nowhere.jpg', ?)").run(now());
    db.prepare("INSERT INTO error_item (id, student_id, batch_id, asset_id, item_index, status, created_at, updated_at) VALUES ('itm_web', ?, 'bat_web', 'ast_web', 0, 'ready_for_reflection', ?, ?)").run(student.id, now(), now());
    expect((await fetch(`${base}/v2/items/itm_web/crop`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${base}/v2/items/itm_missing/crop`, { headers: auth })).status).toBe(404);
  });

  it('RED4 discard 后从 items 消失、restore 后回来；未回传练习包里的题 discard 409', async () => {
    const { base, dataDir, auth } = await setupApp();
    const jobId = await makeJob(dataDir, [question({ number: '1' }), question({ number: '2' })]);
    await registerPhoto(base, auth, jobId);
    const week = await getWeek(base, auth);
    expect(week.items).toHaveLength(2);
    const [first, second] = week.items as [WeekItem, WeekItem];

    // Web 来源题不可 discard。
    expect((await fetch(`${base}/v2/items/itm_web/discard`, { method: 'POST', headers: auth })).status).toBe(404);

    // 第二题放进未回传的练习包：discard 409（中文原因）。
    const db = getDb();
    const student = ensureStudentProfile();
    db.prepare("INSERT INTO review_packet (id, student_id, week, status, created_at) VALUES ('pkt_1', ?, ?, 'generated', ?)").run(student.id, isoWeekKey(new Date()), now());
    db.prepare("INSERT INTO review_packet_item (packet_id, item_id, position) VALUES ('pkt_1', ?, 0)").run(second.id);
    const blocked = await fetch(`${base}/v2/items/${second.id}/discard`, { method: 'POST', headers: auth });
    expect(blocked.status).toBe(409);
    const blockedBody = (await blocked.json()) as { error: { code: string; message: string } };
    expect(blockedBody.error.message).toMatch(/练习包/);

    // 第一题正常 discard：从 items 消失；重复 discard 409。
    const discarded = await fetch(`${base}/v2/items/${first.id}/discard`, { method: 'POST', headers: auth });
    expect(discarded.status).toBe(200);
    expect((await discarded.json()) as { status: string }).toMatchObject({ status: 'archived_not_worth_review' });
    expect((await getWeek(base, auth)).items.map(i => i.id)).toEqual([second.id]);
    expect((await fetch(`${base}/v2/items/${first.id}/discard`, { method: 'POST', headers: auth })).status).toBe(409);
    expect(getDb().prepare('SELECT archived_reason FROM error_item WHERE id = ?').get(first.id)).toEqual({ archived_reason: 'not_a_mistake' });

    // restore：无反思 → ready_for_reflection，items 恢复两题。
    const restored = await fetch(`${base}/v2/items/${first.id}/restore`, { method: 'POST', headers: auth });
    expect(restored.status).toBe(200);
    expect((await restored.json()) as { status: string }).toMatchObject({ status: 'ready_for_reflection' });
    expect((await getWeek(base, auth)).items).toHaveLength(2);

    // 有反思的题 restore → eligible_for_review；非 not_a_mistake 归档不可 restore。
    db.prepare("INSERT INTO error_diagnosis (id, item_id, attempt_state, cause, mastery_feeling, review_value, submitted_by, created_at) VALUES ('dia_1', ?, '其他', '计算', 2, '可以再做', 'student', ?)").run(first.id, now());
    await fetch(`${base}/v2/items/${first.id}/discard`, { method: 'POST', headers: auth });
    const restoredWithDiag = await fetch(`${base}/v2/items/${first.id}/restore`, { method: 'POST', headers: auth });
    expect((await restoredWithDiag.json()) as { status: string }).toMatchObject({ status: 'eligible_for_review' });
    db.prepare("UPDATE error_item SET status = 'archived_not_worth_review', archived_reason = '学生认为没必要再做' WHERE id = ?").run(first.id);
    expect((await fetch(`${base}/v2/items/${first.id}/restore`, { method: 'POST', headers: auth })).status).toBe(409);
    expect((await fetch(`${base}/v2/items/itm_web/restore`, { method: 'POST', headers: auth })).status).toBe(404);
  });

  it('RED5 上周登记照片的题出现在 backlog 而不在 items', async () => {
    const { base, dataDir, auth } = await setupApp();
    const jobId = await makeJob(dataDir, [question({ number: '1' })]);
    await registerPhoto(base, auth, jobId);
    expect((await getWeek(base, auth)).items).toHaveLength(1);

    // 把登记时间改到上周（10 天前必然落在上一个 ISO 周）。
    const lastWeek = new Date(Date.now() - 10 * 86400000).toISOString();
    getDb().prepare('UPDATE v2_photo SET registered_at = ? WHERE job_id = ?').run(lastWeek, jobId);

    const week = await getWeek(base, auth);
    expect(week.photos).toEqual([]);
    expect(week.items).toEqual([]);
    expect(week.backlog).toHaveLength(1);
    expect(week.backlog[0]).toMatchObject({ jobId, status: 'ready_for_reflection', cropUrl: `/v2/items/${week.backlog[0]!.id}/crop` });
  });

  it('RED6 设置：默认值、合法更新、非法值 400', async () => {
    const { base, auth } = await setupApp();
    const json = { 'content-type': 'application/json' };

    const initial = await fetch(`${base}/v2/settings`, { headers: auth });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ practiceSlot: '本周内', paperLocation: 'varies' });

    const updated = await fetch(`${base}/v2/settings`, { method: 'PUT', headers: { ...auth, ...json }, body: JSON.stringify({ practiceSlot: '周三晚自习', paperLocation: 'school' }) });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ practiceSlot: '周三晚自习', paperLocation: 'school' });
    expect(await (await fetch(`${base}/v2/settings`, { headers: auth })).json()).toEqual({ practiceSlot: '周三晚自习', paperLocation: 'school' });

    for (const body of [
      { practiceSlot: '', paperLocation: 'home' },
      { practiceSlot: 'x'.repeat(21), paperLocation: 'home' },
      { practiceSlot: '本周内', paperLocation: 'moon' },
      { practiceSlot: 7, paperLocation: 'home' },
      { paperLocation: 'home' },
      { practiceSlot: '本周内' },
    ]) {
      const response = await fetch(`${base}/v2/settings`, { method: 'PUT', headers: { ...auth, ...json }, body: JSON.stringify(body) });
      expect(response.status).toBe(400);
    }
    // 更新未被破坏。
    expect(await (await fetch(`${base}/v2/settings`, { headers: auth })).json()).toEqual({ practiceSlot: '周三晚自习', paperLocation: 'school' });
  });

  it('RED7 所有 /v2 新接口无令牌 401', async () => {
    const { base } = await setupApp();
    const jobId = crypto.randomUUID();
    const calls: Array<[string, string, string?]> = [
      ['GET', '/v2/week'],
      ['POST', `/v2/photos/${jobId}/register`],
      ['GET', '/v2/items/itm_x/crop'],
      ['POST', '/v2/items/itm_x/discard'],
      ['POST', '/v2/items/itm_x/restore'],
      ['GET', '/v2/settings'],
      ['PUT', '/v2/settings', '{}'],
    ];
    for (const [method, path, body] of calls) {
      const response = await fetch(`${base}${path}`, {
        method, headers: body ? { 'content-type': 'application/json' } : undefined, body,
      });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });
});

/** T4f：作答/订正区域在题干下方的整题证据。 */
function fullScopeEvidence(number: string): Evidence {
  return {
    ...evidence(number),
    questionRegion: { x: 0, y: 0.6, width: 1, height: 0.1 },
    regions: [
      { id: 's1', kind: 'student_work', box: { x: 0.1, y: 0.75, width: 0.5, height: 0.05 }, confidence: 0.9, cleanForPrint: false },
      { id: 'c1', kind: 'correction', box: { x: 0.1, y: 0.85, width: 0.6, height: 0.05 }, confidence: 0.9, cleanForPrint: false },
    ],
    observations: [
      { id: 'o1', kind: 'student_work', text: 'x=1', regionId: 's1', confidence: 0.9 },
      { id: 'o2', kind: 'correction', text: 'x=2', regionId: 'c1', confidence: 0.9 },
    ],
  };
}

describe('T4f crop?scope=full 整题大图', () => {
  it('scope=full 返回 200 JPEG，高度大于 scope=question；缺省与 scope=question 字节一致', async () => {
    const { base, dataDir, auth } = await setupApp();
    const jobId = await makeJob(dataDir, [question({ number: '1', evidence: fullScopeEvidence('1') })]);
    await registerPhoto(base, auth, jobId);
    const week = await getWeek(base, auth);
    const itemId = week.items[0]!.id;

    const fetchCrop = async (query: string) => {
      const response = await fetch(`${base}/v2/items/${itemId}/crop${query}`, { headers: auth });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('image/jpeg');
      expect(response.headers.get('cache-control')).toContain('no-store');
      return Buffer.from(await response.arrayBuffer());
    };

    const questionBytes = await fetchCrop('?scope=question');
    const fullBytes = await fetchCrop('?scope=full');
    const defaultBytes = await fetchCrop('');

    const questionMeta = await sharp(questionBytes).metadata();
    const fullMeta = await sharp(fullBytes).metadata();
    expect(fullMeta.height!).toBeGreaterThan(questionMeta.height!);
    // 缺省行为与改动前完全一致：与 scope=question 字节相同。
    expect(defaultBytes.equals(questionBytes)).toBe(true);
  });

  it('scope=bad 返回 400 invalid_request；scope=full 对非 v2 题 404', async () => {
    const { base, dataDir, auth } = await setupApp();
    const jobId = await makeJob(dataDir, [question({ number: '1' })]);
    await registerPhoto(base, auth, jobId);
    const week = await getWeek(base, auth);
    const itemId = week.items[0]!.id;

    const bad = await fetch(`${base}/v2/items/${itemId}/crop?scope=bad`, { headers: auth });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: { code: 'invalid_request', message: 'scope 只能是 question 或 full。' } });

    expect((await fetch(`${base}/v2/items/itm_web/crop?scope=full`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${base}/v2/items/itm_missing/crop?scope=full`, { headers: auth })).status).toBe(404);
  });
});
