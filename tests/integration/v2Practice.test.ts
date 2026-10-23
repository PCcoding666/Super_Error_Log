import { resetMaterials } from '../helpers/resetMaterials.js';
/**
 * T4b：本周推荐与建练习（/v2/practice/recommend、POST /v2/practice、GET /v2/practice/:id、GET /v2/practice）。
 * 真实 HTTP（回环装配，共享令牌鉴权）+ 合成识别任务 + 临时移动数据目录。
 * 推荐完全靠可解释规则，不调真实模型、不读 .env 与 data/。
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
import type { RecognitionQuestion, RecognitionVerification } from '../../src/mobile/contracts.js';
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

function evidence(number: string, tags: string[]): Evidence {
  return {
    version: 1, questionNumber: number, questionText: `已知 x+y=${number}，求 x 的值。`, subject: '数学', chapter: '方程',
    knowledgeTags: tags, questionType: '计算',
    questionRegion: { x: .1, y: .1, width: .8, height: .8 }, requiresDiagram: false,
    regions: [{ id: 's1', kind: 'student_work', box: { x: .2, y: .2, width: .2, height: .2 }, confidence: .9, cleanForPrint: false }],
    observations: [{ id: 'o1', kind: 'student_work', text: 'x=1', regionId: 's1', confidence: .9 }],
    uncertainties: [],
  };
}

let seq = 0;
function question(partial: Partial<RecognitionQuestion> & { number?: string; tags?: string[] } = {}): RecognitionQuestion {
  seq += 1;
  const number = partial.number ?? String(seq);
  const { tags, ...rest } = partial;
  return {
    id: crypto.randomUUID(), number, revision: 1, status: 'ready', selectionEvidence: 'marked_wrong',
    evidence: evidence(number, tags ?? [`知识点${number}`]), verification: { ...CHECKS }, questionMediaId: null, diagramMediaIds: [],
    error: null, confirmedAt: null, ...rest,
  };
}

async function tempDir(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-t4b-practice-'));
  roots.push(dir);
  return dir;
}

/** 造一个终态（completed）识别任务，含给定题目。 */
async function makeJob(dir: string, questions: RecognitionQuestion[]): Promise<string> {
  const store = await MobileRecognitionStore.open(dir);
  const bytes = await jpeg(`#${String((seq * 37) % 0xffffff).padStart(6, '0')}`);
  const { job } = await store.createJob({ idempotencyKey: crypto.randomUUID(), photoName: 'photo.jpg', sourceBytes: bytes, normalizedBytes: bytes });
  await store.updateJob(job.id, j => {
    j.phase = 'complete'; j.status = 'completed'; j.revision += 1;
    j.questions = questions;
  });
  return job.id;
}

const PAIRING = 't4b-shared-token-0123456789';

interface WeekItem {
  id: string; shortId: string | null; subject: string | null; knowledgeTags: string[];
  questionExcerpt: string | null; badge: 'ok' | 'low'; status: string; cropUrl: string; jobId: string;
}
interface PracticeCard extends WeekItem { reason: string; tier: number; reflected: boolean }
interface RecommendResponse { recommended: PracticeCard[]; others: PracticeCard[]; notes: string[]; limits: { min: number; max: number } }
interface PracticeDetail {
  id: string; week: string; status: string; practiceSlot: string; createdAt: string; generatedAt: string | null;
  items: Array<PracticeCard & { position: number }>;
}

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

/** 造 n 道题（一道 job），登记并桥接，按登记顺序返回卡片。 */
async function bridgeItems(
  base: string, auth: { authorization: string }, dataDir: string,
  specs: Array<{ tags: string[] }>,
): Promise<WeekItem[]> {
  const jobId = await makeJob(dataDir, specs.map((spec, i) => question({ number: String(seq + i + 1), tags: spec.tags })));
  seq += specs.length;
  const registered = await fetch(`${base}/v2/photos/${jobId}/register`, { method: 'POST', headers: auth });
  expect(registered.status).toBe(200);
  const week = (await (await fetch(`${base}/v2/week`, { headers: auth })).json()) as { items: WeekItem[] };
  return week.items.filter(item => item.jobId === jobId);
}

const recommend = async (base: string, auth: { authorization: string }): Promise<RecommendResponse> => {
  const response = await fetch(`${base}/v2/practice/recommend`, { headers: auth });
  expect(response.status).toBe(200);
  return (await response.json()) as RecommendResponse;
};

const postPractice = (base: string, auth: { authorization: string }, body: unknown) =>
  fetch(`${base}/v2/practice`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });

const setStatus = (id: string, status: string, nextReviewAt: string | null = null): void => {
  getDb().prepare('UPDATE error_item SET status = ?, next_review_at = ?, updated_at = ? WHERE id = ?').run(status, nextReviewAt, now(), id);
};

/** 直接造一道 Web 来源题（无 mobile_item_link）。 */
function makeWebItem(id: string, status: string): void {
  const student = ensureStudentProfile();
  const db = getDb();
  db.prepare("INSERT INTO source_batch (id, student_id, status, total_files, done_files, created_at) VALUES (?, ?, 'done', 1, 1, ?)").run(`bat_${id}`, student.id, now());
  db.prepare("INSERT INTO source_asset (id, batch_id, filename, mime, size, content_hash, status, storage_path, created_at) VALUES (?, ?, 'w.jpg', 'image/jpeg', 1, ?, 'done', '/nowhere.jpg', ?)").run(`ast_${id}`, `bat_${id}`, `hash-${id}`, now());
  db.prepare("INSERT INTO error_item (id, student_id, batch_id, asset_id, item_index, status, knowledge_tags, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, '[\"一元一次方程\"]', ?, ?)").run(id, student.id, `bat_${id}`, `ast_${id}`, status, now(), now());
}

describe('T4b 本周推荐与建练习', () => {
  it('RED1 推荐只含 v2 候选；Web 题、已归档题、未回传练习包里的题都不出现', async () => {
    const { base, dataDir, auth } = await setupApp();
    const [keep, archived, inPacket] = await bridgeItems(base, auth, dataDir, [
      { tags: ['一元一次方程'] }, { tags: ['二元一次方程'] }, { tags: ['三元一次方程'] },
    ]) as [WeekItem, WeekItem, WeekItem];

    // Web 来源题（状态符合候选但不是 v2）。
    makeWebItem('itm_web', 'eligible_for_review');
    // 已归档（"不是错题"）。
    setStatus(archived.id, 'archived_not_worth_review');
    // 在未回传的练习包里。
    const student = ensureStudentProfile();
    const db = getDb();
    db.prepare("INSERT INTO review_packet (id, student_id, week, status, created_at) VALUES ('pkt_open', ?, ?, 'generated', ?)").run(student.id, isoWeekKey(new Date()), now());
    db.prepare("INSERT INTO review_packet_item (packet_id, item_id, position) VALUES ('pkt_open', ?, 0)").run(inPacket.id);

    const result = await recommend(base, auth);
    expect(result.limits).toEqual({ min: 5, max: 8 });
    const all = [...result.recommended, ...result.others].map(card => card.id);
    expect(all).toEqual([keep.id]);
    expect(result.recommended[0]).toMatchObject({ tier: 4, reflected: false, reason: '本周新错题' });
  });

  it('RED2 四层排序与理由文案', async () => {
    const { base, dataDir, auth } = await setupApp();
    const [recheck, mastered, attempted, fresh] = await bridgeItems(base, auth, dataDir, [
      { tags: ['知识点A'] }, { tags: ['知识点B'] }, { tags: ['知识点C'] }, { tags: ['知识点D'] },
    ]) as [WeekItem, WeekItem, WeekItem, WeekItem];
    setStatus(recheck.id, 'needs_recheck');
    setStatus(mastered.id, 'temporarily_mastered', new Date(Date.now() - 86400000).toISOString());
    setStatus(attempted.id, 'attempted');
    // 当场做对已过 3 天冷却（P0-3）：录入拨到 3 天前、没有更晚的作答。
    getDb().prepare('UPDATE error_item SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 3 * 86400000).toISOString(), attempted.id);
    // fresh 保持 ready_for_reflection。

    const result = await recommend(base, auth);
    expect(result.recommended.map(card => card.id)).toEqual([recheck.id, mastered.id, attempted.id, fresh.id]);
    expect(result.recommended.map(card => card.tier)).toEqual([1, 2, 3, 4]);
    expect(result.recommended.map(card => card.reason)).toEqual([
      '上次练习没独立做对',
      '上次做对了，到了再确认一次的时候',
      '上次是当场做对，已经隔了几天，可以再验证了',
      '本周新错题',
    ]);
  });

  it('RED2b 当场做对的题 3 天冷却：不进推荐、仍可手动选，理由写明哪天起再做', async () => {
    const { base, dataDir, auth } = await setupApp();
    const [cooling, fresh] = await bridgeItems(base, auth, dataDir, [{ tags: ['知识点A'] }, { tags: ['知识点B'] }]) as [WeekItem, WeekItem];
    setStatus(cooling.id, 'attempted');
    const result = await recommend(base, auth);
    expect(result.recommended.map(card => card.id)).toEqual([fresh.id]);
    const until = new Date(Date.now() + 3 * 86400000);
    expect(result.others.map(card => card.id)).toEqual([cooling.id]);
    expect(result.others[0]!.reason).toBe(`上次是当场做对，${until.getMonth() + 1} 月 ${until.getDate()} 日起再做才算数`);
  });

  it('RED3 12 道候选推荐 8 道；同知识点最多 2 道', async () => {
    const { base, dataDir, auth } = await setupApp();
    await bridgeItems(base, auth, dataDir, Array.from({ length: 12 }, (_, i) => ({ tags: [`知识点${i}`] })));
    const result = await recommend(base, auth);
    expect(result.recommended).toHaveLength(8);
    expect(result.others).toHaveLength(4);
  });

  it('RED3b 同知识点 4 道时推荐里最多 2 道', async () => {
    const { base, dataDir, auth } = await setupApp();
    const items = await bridgeItems(base, auth, dataDir, [
      { tags: ['分式'] }, { tags: ['分式'] }, { tags: ['分式'] }, { tags: ['分式'] },
      { tags: ['知识点甲'] }, { tags: ['知识点乙'] }, { tags: ['知识点丙'] }, { tags: ['知识点丁'] },
    ]);
    const result = await recommend(base, auth);
    const sameTag = result.recommended.filter(card => card.knowledgeTags.includes('分式'));
    expect(sameTag.length).toBeLessThanOrEqual(2);
    // 4 道「分式」复发分更高，选满 2 道后其余进 others。
    expect(result.recommended).toHaveLength(6);
    expect(result.others.map(card => card.id).sort()).toEqual(items.slice(0, 4).slice(2).map(item => item.id).sort());
  });

  it('RED4 3 道候选时全部推荐且 notes 提示不足 5 道', async () => {
    const { base, dataDir, auth } = await setupApp();
    const items = await bridgeItems(base, auth, dataDir, [
      { tags: ['知识点A'] }, { tags: ['知识点B'] }, { tags: ['知识点C'] },
    ]);
    const result = await recommend(base, auth);
    expect(result.recommended.map(card => card.id).sort()).toEqual(items.map(item => item.id).sort());
    expect(result.others).toEqual([]);
    expect(result.notes.some(note => note.includes('不足'))).toBe(true);
  });

  it('RED5 同知识点近 28 天 3 道：理由为「X」近四周错了 3 次', async () => {
    const { base, dataDir, auth } = await setupApp();
    await bridgeItems(base, auth, dataDir, [{ tags: ['分式'] }, { tags: ['分式'] }, { tags: ['分式'] }]);
    const result = await recommend(base, auth);
    expect(result.recommended).toHaveLength(3);
    for (const card of result.recommended) {
      expect(card.tier).toBe(4);
      expect(card.reason).toBe('「分式」近四周错了 3 次');
    }
  });

  it('RED6 建练习校验：未复盘新题可建包；空/重复/9 道/含 Web 题/含已在包里的题被拒；practiceSlot 规则', async () => {
    const { base, dataDir, auth } = await setupApp();
    const items = await bridgeItems(base, auth, dataDir, Array.from({ length: 10 }, (_, i) => ({ tags: [`知识点${i}`] })));
    const ids = items.map(item => item.id);

    // 未复盘的新题（ready_for_reflection）可以直接建包。
    const created = await postPractice(base, auth, { itemIds: [ids[0]] });
    expect(created.status).toBe(200);
    const detail = (await created.json()) as PracticeDetail;
    expect(detail.status).toBe('scheduled');
    expect(detail.practiceSlot).toBe('本周内');
    expect(detail.items).toHaveLength(1);

    // 空、重复、9 道 → 400。
    expect((await postPractice(base, auth, { itemIds: [] })).status).toBe(400);
    expect((await postPractice(base, auth, { itemIds: [ids[1], ids[1]] })).status).toBe(400);
    expect((await postPractice(base, auth, { itemIds: ids.slice(1) })).status).toBe(400);

    // 含 Web 题 → 409 并指出哪道不行。
    makeWebItem('itm_web', 'eligible_for_review');
    const withWeb = await postPractice(base, auth, { itemIds: [ids[1], 'itm_web'] });
    expect(withWeb.status).toBe(409);
    const webBody = (await withWeb.json()) as { error: { message: string } };
    expect(webBody.error.message).toContain('itm_web');

    // 含已在包里的题（ids[0] 已建包）→ 409 并指出。
    const withScheduled = await postPractice(base, auth, { itemIds: [ids[1], ids[0]] });
    expect(withScheduled.status).toBe(409);
    const scheduledBody = (await withScheduled.json()) as { error: { message: string } };
    expect(scheduledBody.error.message).toContain(ids[0]);

    // practiceSlot：设置缺省、可覆盖、超长 400。
    await fetch(`${base}/v2/settings`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ practiceSlot: '周三晚自习', paperLocation: 'school' }) });
    const defaulted = (await (await postPractice(base, auth, { itemIds: [ids[1]] })).json()) as PracticeDetail;
    expect(defaulted.practiceSlot).toBe('周三晚自习');
    const overridden = (await (await postPractice(base, auth, { itemIds: [ids[2]], practiceSlot: '周末上午' })).json()) as PracticeDetail;
    expect(overridden.practiceSlot).toBe('周末上午');
    expect((await postPractice(base, auth, { itemIds: [ids[3]], practiceSlot: 'x'.repeat(21) })).status).toBe(400);
  });

  it('RED7 建包后状态流转：普通题 scheduled、到期暂时掌握不变、week 同步、再次推荐不含', async () => {
    const { base, dataDir, auth } = await setupApp();
    const [normal, mastered] = await bridgeItems(base, auth, dataDir, [
      { tags: ['知识点A'] }, { tags: ['知识点B'] },
    ]) as [WeekItem, WeekItem];
    setStatus(mastered.id, 'temporarily_mastered', new Date(Date.now() - 86400000).toISOString());

    const created = await postPractice(base, auth, { itemIds: [normal.id, mastered.id] });
    expect(created.status).toBe(200);

    const db = getDb();
    expect(db.prepare('SELECT status FROM error_item WHERE id = ?').get(normal.id)).toEqual({ status: 'scheduled' });
    expect(db.prepare('SELECT status FROM error_item WHERE id = ?').get(mastered.id)).toEqual({ status: 'temporarily_mastered' });

    const week = (await (await fetch(`${base}/v2/week`, { headers: auth })).json()) as { items: WeekItem[] };
    expect(week.items.find(item => item.id === normal.id)?.status).toBe('scheduled');
    expect(week.items.find(item => item.id === mastered.id)?.status).toBe('temporarily_mastered');

    const again = await recommend(base, auth);
    expect([...again.recommended, ...again.others]).toEqual([]);
  });

  it('RED8 练习详情形状正确、reflected 反映是否有复盘；Web 包 404；列表新在前只含 v2 包', async () => {
    const { base, dataDir, auth } = await setupApp();
    const [first, second] = await bridgeItems(base, auth, dataDir, [
      { tags: ['知识点A'] }, { tags: ['知识点B'] },
    ]) as [WeekItem, WeekItem];
    getDb().prepare("INSERT INTO error_diagnosis (id, item_id, attempt_state, cause, mastery_feeling, review_value, submitted_by, created_at) VALUES ('dia_1', ?, '其他', '计算', 2, '可以再做', 'student', ?)").run(second.id, now());

    const created = (await (await postPractice(base, auth, { itemIds: [first.id, second.id], practiceSlot: '晚饭后' })).json()) as PracticeDetail;
    const detail = (await (await fetch(`${base}/v2/practice/${created.id}`, { headers: auth })).json()) as PracticeDetail;
    expect(detail).toMatchObject({ id: created.id, week: isoWeekKey(new Date()), status: 'scheduled', practiceSlot: '晚饭后', generatedAt: null });
    expect(typeof detail.createdAt).toBe('string');
    expect(detail.items).toHaveLength(2);
    expect(detail.items[0]).toMatchObject({ id: first.id, position: 0, reflected: false, cropUrl: `/v2/items/${first.id}/crop`, jobId: first.jobId });
    expect(detail.items[1]).toMatchObject({ id: second.id, position: 1, reflected: true });

    // Web 包（不含 v2 题）404；不存在的包 404。
    makeWebItem('itm_web', 'scheduled');
    const student = ensureStudentProfile();
    getDb().prepare("INSERT INTO review_packet (id, student_id, week, status, created_at) VALUES ('pkt_web', ?, ?, 'scheduled', ?)").run(student.id, isoWeekKey(new Date()), now());
    getDb().prepare("INSERT INTO review_packet_item (packet_id, item_id, position) VALUES ('pkt_web', 'itm_web', 0)").run();
    expect((await fetch(`${base}/v2/practice/pkt_web`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${base}/v2/practice/pkt_missing`, { headers: auth })).status).toBe(404);

    // 列表：再建一包，新的在前；Web 包不出现。
    const [third] = await bridgeItems(base, auth, dataDir, [{ tags: ['知识点C'] }]) as [WeekItem];
    const second2 = (await (await postPractice(base, auth, { itemIds: [third.id] })).json()) as PracticeDetail;
    const list = (await (await fetch(`${base}/v2/practice`, { headers: auth })).json()) as { packets: Array<{ id: string; itemCount: number; status: string; practiceSlot: string }> };
    expect(list.packets.map(packet => packet.id)).toEqual([second2.id, created.id]);
    expect(list.packets[1]).toMatchObject({ itemCount: 2, status: 'scheduled', practiceSlot: '晚饭后' });
  });

  it('R1-F1 建练习写入中途失败时整体回滚：无半份练习包、题目状态不变', async () => {
    const { base, dataDir, auth } = await setupApp();
    const [first, second] = await bridgeItems(base, auth, dataDir, [
      { tags: ['知识点A'] }, { tags: ['知识点B'] },
    ]) as [WeekItem, WeekItem];

    // 注入失败：第 2 道题（position=1）写入 review_packet_item 时触发器中止。
    const db = getDb();
    db.exec('CREATE TRIGGER fail_second_item BEFORE INSERT ON review_packet_item WHEN NEW.position = 1 BEGIN SELECT RAISE(ABORT, \'injected_failure\'); END');
    let status = 0;
    try {
      const response = await postPractice(base, auth, { itemIds: [first.id, second.id] });
      status = response.status;
    } finally {
      db.exec('DROP TRIGGER fail_second_item');
    }
    expect(status).toBe(500);
    expect(db.prepare('SELECT COUNT(*) AS n FROM review_packet').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM review_packet_item').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT status FROM error_item WHERE id = ?').get(first.id)).toEqual({ status: 'ready_for_reflection' });
    expect(db.prepare('SELECT status FROM error_item WHERE id = ?').get(second.id)).toEqual({ status: 'ready_for_reflection' });
  });

  it('R1-F2 练习详情保留建包时的层级与理由：needs_recheck 建包后仍显示 tier 1', async () => {
    const { base, dataDir, auth } = await setupApp();
    const [item] = await bridgeItems(base, auth, dataDir, [{ tags: ['知识点A'] }]) as [WeekItem];
    setStatus(item.id, 'needs_recheck');

    const created = (await (await postPractice(base, auth, { itemIds: [item.id] })).json()) as PracticeDetail;
    expect(created.items[0]).toMatchObject({ tier: 1, reason: '上次练习没独立做对' });

    const fetched = (await (await fetch(`${base}/v2/practice/${created.id}`, { headers: auth })).json()) as PracticeDetail;
    expect(fetched.items[0]).toMatchObject({ tier: 1, reason: '上次练习没独立做对' });
  });

  it('RED9 新接口无令牌 401', async () => {
    const { base } = await setupApp();
    const calls: Array<[string, string, string?]> = [
      ['GET', '/v2/practice/recommend'],
      ['POST', '/v2/practice', '{}'],
      ['GET', '/v2/practice'],
      ['GET', '/v2/practice/pkt_x'],
    ];
    for (const [method, path, body] of calls) {
      const response = await fetch(`${base}${path}`, {
        method, headers: body ? { 'content-type': 'application/json' } : undefined, body,
      });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });
});
