/**
 * T4d：回传与回报（POST /v2/practice/:id/return、GET /v2/practice/:id/summary）。
 * 真实 HTTP（回环装配，共享令牌鉴权）+ 合成识别任务 + 临时移动数据目录。
 * 掌握判定完全走 Web 的 recordAttempt；测试里直接把 review_packet 置为 generated（PDF 由 T5 负责）。
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
  for (const table of ['mastery_event', 'review_attempt', 'review_packet_item', 'review_packet', 'mobile_item_link', 'evidence_record', 'error_diagnosis', 'error_item', 'asset_origin', 'source_asset', 'source_batch', 'v2_photo', 'v2_setting']) {
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-t4d-return-'));
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

const PAIRING = 't4d-shared-token-0123456789';

interface WeekItem {
  id: string; shortId: string | null; subject: string | null; knowledgeTags: string[];
  questionExcerpt: string | null; badge: 'ok' | 'low'; status: string; cropUrl: string; jobId: string;
}
interface PracticeDetail { id: string; status: string; generatedAt: string | null; items: Array<WeekItem & { position: number }> }
interface ReturnItemResult { itemId: string; ok: boolean; toStatus?: string; reason?: string; error?: string }
interface SummaryCard extends WeekItem { reason?: string }
interface ReturnSummary {
  answered: number; total: number; independentCorrect: number;
  masteredNow: SummaryCard[]; again: SummaryCard[]; pending: SummaryCard[];
  calibration: { confidentTotal: number; missedCount: number; text: string | null; items: SummaryCard[] };
  nextConfirmOn: string | null;
}

const setStatus = (id: string, status: string, nextReviewAt: string | null = null): void => {
  getDb().prepare('UPDATE error_item SET status = ?, next_review_at = ?, updated_at = ? WHERE id = ?').run(status, nextReviewAt, now(), id);
};

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

/** 建练习包（itemIds ≤ 8），返回详情。 */
async function makePractice(base: string, auth: { authorization: string }, itemIds: string[]): Promise<PracticeDetail> {
  const response = await fetch(`${base}/v2/practice`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ itemIds }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as PracticeDetail;
}

/** 把包置为"已打印"：status=generated，generated_at 为 daysAgo 天前；返回打印日（本地 YYYY-MM-DD）。 */
function printPacket(packetId: string, daysAgo: number): string {
  const generatedAt = new Date(Date.now() - daysAgo * 86400000);
  getDb().prepare("UPDATE review_packet SET status = 'generated', generated_at = ? WHERE id = ?").run(generatedAt.toISOString(), packetId);
  return localDay(generatedAt);
}

function localDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const TODAY = (): string => localDay(new Date());

const postReturn = (base: string, auth: { authorization: string }, packetId: string, body: unknown) =>
  fetch(`${base}/v2/practice/${packetId}/return`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

const getSummary = (base: string, auth: { authorization: string }, packetId: string) =>
  fetch(`${base}/v2/practice/${packetId}/summary`, { headers: auth });

/** 直接造一道 Web 来源题（无 mobile_item_link）。 */
function makeWebItem(id: string, status: string): void {
  const student = ensureStudentProfile();
  const db = getDb();
  db.prepare("INSERT INTO source_batch (id, student_id, status, total_files, done_files, created_at) VALUES (?, ?, 'done', 1, 1, ?)").run(`bat_${id}`, student.id, now());
  db.prepare("INSERT INTO source_asset (id, batch_id, filename, mime, size, content_hash, status, storage_path, created_at) VALUES (?, ?, 'w.jpg', 'image/jpeg', 1, ?, 'done', '/nowhere.jpg', ?)").run(`ast_${id}`, `bat_${id}`, `hash-${id}`, now());
  db.prepare("INSERT INTO error_item (id, student_id, batch_id, asset_id, item_index, status, knowledge_tags, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, '[\"一元一次方程\"]', ?, ?)").run(id, student.id, `bat_${id}`, `ast_${id}`, status, now(), now());
}

function addDiagnosis(id: string, itemId: string, masteryFeeling: number): void {
  getDb().prepare("INSERT INTO error_diagnosis (id, item_id, attempt_state, cause, mastery_feeling, review_value, submitted_by, created_at) VALUES (?, ?, '其他', '计算', ?, '可以再做', 'student', ?)").run(id, itemId, masteryFeeling, now());
}

describe('T4d 回传与回报', () => {
  it('RED1 未打印的包回传：每条 ok:false，错误为复习包尚未生成 PDF', async () => {
    const { base, dataDir, auth } = await setupApp();
    const items = await bridgeItems(base, auth, dataDir, [{ tags: ['知识点A'] }, { tags: ['知识点B'] }]);
    const practice = await makePractice(base, auth, items.map(item => item.id));

    const response = await postReturn(base, auth, practice.id, {
      results: items.map(item => ({ itemId: item.id, completion: 'independent', correct: true, performedOn: TODAY() })),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { results: ReturnItemResult[] };
    expect(body.results).toHaveLength(2);
    for (const result of body.results) {
      expect(result.ok).toBe(false);
      expect(result.error).toContain('复习包尚未生成 PDF');
    }
    // 未产生任何回传记录。
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM review_attempt WHERE packet_id = ?').get(practice.id)).toEqual({ n: 0 });
  });

  it('RED2 打印 4 天后独立做对 → temporarily_mastered 且 next_review_at 已写；打印当天做对 → attempted 不进掌握', async () => {
    const { base, dataDir, auth } = await setupApp();
    const [delayed, sameDay] = await bridgeItems(base, auth, dataDir, [{ tags: ['知识点A'] }, { tags: ['知识点B'] }]) as [WeekItem, WeekItem];
    const practice = await makePractice(base, auth, [delayed.id, sameDay.id]);
    const printDay = printPacket(practice.id, 4);

    const response = await postReturn(base, auth, practice.id, {
      results: [
        { itemId: delayed.id, completion: 'independent', correct: true, performedOn: TODAY() },
        { itemId: sameDay.id, completion: 'independent', correct: true, performedOn: printDay },
      ],
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { results: ReturnItemResult[] };
    const byId = new Map(body.results.map(result => [result.itemId, result]));
    expect(byId.get(delayed.id)).toMatchObject({ ok: true, toStatus: 'temporarily_mastered' });
    expect(byId.get(sameDay.id)).toMatchObject({ ok: true, toStatus: 'attempted' });

    const db = getDb();
    const delayedRow = db.prepare('SELECT status, next_review_at FROM error_item WHERE id = ?').get(delayed.id) as { status: string; next_review_at: string | null };
    expect(delayedRow.status).toBe('temporarily_mastered');
    expect(delayedRow.next_review_at).toBe(localDay(new Date(Date.now() + 10 * 86400000)));
    const sameDayRow = db.prepare('SELECT status, next_review_at FROM error_item WHERE id = ?').get(sameDay.id) as { status: string; next_review_at: string | null };
    expect(sameDayRow.status).toBe('attempted');
    expect(sameDayRow.next_review_at).toBeNull();
    // 延迟做对产生暂时掌握事件；当天做对不产生掌握事件（mastery_event 也记录普通流转，故只查掌握态）。
    expect(db.prepare("SELECT COUNT(*) AS n FROM mastery_event WHERE item_id = ? AND to_status = 'temporarily_mastered'").get(delayed.id)).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM mastery_event WHERE item_id = ? AND to_status IN ('temporarily_mastered', 'stably_mastered')").get(sameDay.id)).toEqual({ n: 0 });
  });

  it('RED3 hint1/hint2 做对 → needs_recheck 且 hint_level 落库 1/2；not_solved/not_done → needs_recheck', async () => {
    const { base, dataDir, auth } = await setupApp();
    const [hint1, hint2, notSolved, notDone] = await bridgeItems(base, auth, dataDir, [
      { tags: ['知识点A'] }, { tags: ['知识点B'] }, { tags: ['知识点C'] }, { tags: ['知识点D'] },
    ]) as [WeekItem, WeekItem, WeekItem, WeekItem];
    const practice = await makePractice(base, auth, [hint1.id, hint2.id, notSolved.id, notDone.id]);
    printPacket(practice.id, 4);

    const response = await postReturn(base, auth, practice.id, {
      results: [
        { itemId: hint1.id, completion: 'hint1', correct: true, performedOn: TODAY() },
        { itemId: hint2.id, completion: 'hint2', correct: true, performedOn: TODAY(), stuckStep: '第二步配方' },
        { itemId: notSolved.id, completion: 'not_solved', performedOn: TODAY() },
        { itemId: notDone.id, completion: 'not_done', performedOn: TODAY() },
      ],
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { results: ReturnItemResult[] };
    for (const result of body.results) {
      expect(result.ok, result.itemId).toBe(true);
      expect(result.toStatus, result.itemId).toBe('needs_recheck');
    }

    const rows = getDb().prepare('SELECT item_id, completion, correct, hint_level, stuck_step FROM review_attempt WHERE packet_id = ?').all(practice.id) as
      Array<{ item_id: string; completion: string; correct: number; hint_level: number; stuck_step: string | null }>;
    const byItem = new Map(rows.map(row => [row.item_id, row]));
    expect(byItem.get(hint1.id)).toMatchObject({ completion: 'hint_used', correct: 1, hint_level: 1 });
    expect(byItem.get(hint2.id)).toMatchObject({ completion: 'hint_used', correct: 1, hint_level: 2, stuck_step: '第二步配方' });
    expect(byItem.get(notSolved.id)).toMatchObject({ completion: 'failed', correct: 0, hint_level: 0 });
    expect(byItem.get(notDone.id)).toMatchObject({ completion: 'unfinished', correct: 0, hint_level: 0 });
  });

  it('RED4 分两次回传（先 2 道后 3 道）均成功；全部回传后包状态 returned；再回传已回传的题 ok:false', async () => {
    const { base, dataDir, auth } = await setupApp();
    const items = await bridgeItems(base, auth, dataDir, Array.from({ length: 5 }, (_, i) => ({ tags: [`知识点${i}`] })));
    const practice = await makePractice(base, auth, items.map(item => item.id));
    printPacket(practice.id, 4);

    const first = await postReturn(base, auth, practice.id, {
      results: items.slice(0, 2).map(item => ({ itemId: item.id, completion: 'independent', correct: true, performedOn: TODAY() })),
    });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { results: ReturnItemResult[] }).results.every(result => result.ok)).toBe(true);
    expect(getDb().prepare('SELECT status FROM review_packet WHERE id = ?').get(practice.id)).toEqual({ status: 'generated' });

    const second = await postReturn(base, auth, practice.id, {
      results: items.slice(2).map(item => ({ itemId: item.id, completion: 'not_solved', performedOn: TODAY() })),
    });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { results: ReturnItemResult[] }).results.every(result => result.ok)).toBe(true);
    expect(getDb().prepare('SELECT status FROM review_packet WHERE id = ?').get(practice.id)).toEqual({ status: 'returned' });

    // 再回传已回传的题：该题 ok:false，不影响 HTTP 200。
    const again = await postReturn(base, auth, practice.id, {
      results: [{ itemId: items[0]!.id, completion: 'independent', correct: true, performedOn: TODAY() }],
    });
    expect(again.status).toBe(200);
    const againBody = (await again.json()) as { results: ReturnItemResult[] };
    expect(againBody.results[0]!.ok).toBe(false);
    expect(againBody.results[0]!.error).toBeTruthy();
  });

  it('RED5 入参不合法：缺 performedOn/枚举外 completion/缺 correct/not_solved 给 correct:true/空数组/9 条 → 400；未来日期、早于打印日 → 逐条 ok:false', async () => {
    const { base, dataDir, auth } = await setupApp();
    const [item] = await bridgeItems(base, auth, dataDir, [{ tags: ['知识点A'] }]) as [WeekItem];
    const practice = await makePractice(base, auth, [item.id]);
    const printDay = printPacket(practice.id, 4);

    // 形状错误 → 400，且不产生任何回传记录。
    const badShapes: unknown[] = [
      { results: [{ itemId: item.id, completion: 'independent', correct: true }] },
      { results: [{ itemId: item.id, completion: 'whatever', correct: true, performedOn: TODAY() }] },
      { results: [{ itemId: item.id, completion: 'independent', performedOn: TODAY() }] },
      { results: [{ itemId: item.id, completion: 'not_solved', correct: true, performedOn: TODAY() }] },
      { results: [{ itemId: item.id, completion: 'not_done', correct: true, performedOn: TODAY() }] },
      { results: [{ completion: 'independent', correct: true, performedOn: TODAY() }] },
      { results: [] },
      { results: Array.from({ length: 9 }, () => ({ itemId: item.id, completion: 'not_done', performedOn: TODAY() })) },
      {},
    ];
    for (const body of badShapes) {
      const response = await postReturn(base, auth, practice.id, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM review_attempt WHERE packet_id = ?').get(practice.id)).toEqual({ n: 0 });

    // 规则错误 → 200 且逐条 ok:false。
    const future = localDay(new Date(Date.now() + 86400000));
    const before = localDay(new Date(Date.now() - 5 * 86400000));
    expect(before < printDay).toBe(true);
    const ruled = await postReturn(base, auth, practice.id, {
      results: [
        { itemId: item.id, completion: 'independent', correct: true, performedOn: future },
        { itemId: item.id, completion: 'independent', correct: true, performedOn: before },
      ],
    });
    expect(ruled.status).toBe(200);
    const ruledBody = (await ruled.json()) as { results: ReturnItemResult[] };
    expect(ruledBody.results[0]).toMatchObject({ ok: false });
    expect(ruledBody.results[0]!.error).toContain('未来');
    expect(ruledBody.results[1]).toMatchObject({ ok: false });
    expect(ruledBody.results[1]!.error).toContain('早于');
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM review_attempt WHERE packet_id = ?').get(practice.id)).toEqual({ n: 0 });
  });

  it('RED6 回报：answered/independentCorrect/masteredNow/again 与原因/calibration 文案与题数/nextConfirmOn', async () => {
    const { base, dataDir, auth } = await setupApp();
    const [masteredConfident, masteredPlain, hintConfident, failedConfident, wrong] = await bridgeItems(base, auth, dataDir, [
      { tags: ['知识点A'] }, { tags: ['知识点B'] }, { tags: ['知识点C'] }, { tags: ['知识点D'] }, { tags: ['知识点E'] },
    ]) as [WeekItem, WeekItem, WeekItem, WeekItem, WeekItem];
    // 三道题复盘时把握 ≥ 2（其中 masteredConfident 把握 3 且独立做对；hintConfident 把握 3、failedConfident 把握 2 但没独立做对）。
    addDiagnosis('dia_1', masteredConfident.id, 3);
    addDiagnosis('dia_2', hintConfident.id, 3);
    addDiagnosis('dia_3', failedConfident.id, 2);
    addDiagnosis('dia_4', wrong.id, 1);

    const practice = await makePractice(base, auth, [masteredConfident.id, masteredPlain.id, hintConfident.id, failedConfident.id, wrong.id]);
    printPacket(practice.id, 4);
    const returned = await postReturn(base, auth, practice.id, {
      results: [
        { itemId: masteredConfident.id, completion: 'independent', correct: true, performedOn: TODAY() },
        { itemId: masteredPlain.id, completion: 'independent', correct: true, performedOn: TODAY() },
        { itemId: hintConfident.id, completion: 'hint2', correct: true, performedOn: TODAY() },
        { itemId: failedConfident.id, completion: 'not_solved', performedOn: TODAY() },
        { itemId: wrong.id, completion: 'independent', correct: false, performedOn: TODAY() },
      ],
    });
    expect(returned.status).toBe(200);

    const response = await getSummary(base, auth, practice.id);
    expect(response.status).toBe(200);
    const summary = (await response.json()) as ReturnSummary;

    expect(summary.answered).toBe(5);
    expect(summary.total).toBe(5);
    expect(summary.independentCorrect).toBe(2);

    expect(summary.masteredNow.map(card => card.id).sort()).toEqual([masteredConfident.id, masteredPlain.id].sort());
    // 卡片沿用 /v2/week 形状。
    expect(summary.masteredNow[0]).toMatchObject({ status: 'temporarily_mastered' });
    expect(summary.masteredNow[0]!.cropUrl).toBe(`/v2/items/${summary.masteredNow[0]!.id}/crop`);
    expect(typeof summary.masteredNow[0]!.jobId).toBe('string');

    expect(summary.again.map(card => card.id)).toEqual([hintConfident.id, failedConfident.id, wrong.id]);
    expect(summary.again.map(card => card.reason)).toEqual(['看了提示', '没做出来', '做错']);

    expect(summary.calibration.confidentTotal).toBe(3);
    expect(summary.calibration.missedCount).toBe(2);
    expect(summary.calibration.text).toBe('你说有把握的 3 道里，2 道没独立做出来');
    expect(summary.calibration.items.map(card => card.id).sort()).toEqual([hintConfident.id, failedConfident.id].sort());

    expect(summary.nextConfirmOn).toBe(localDay(new Date(Date.now() + 10 * 86400000)));
    // F3：nextConfirmOn 只返回日期（YYYY-MM-DD，不带时间）。
    expect(summary.nextConfirmOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('RED6b 回报：部分回传时 answered/total 反映进度，未回传题不进 again/masteredNow', async () => {
    const { base, dataDir, auth } = await setupApp();
    const [done, pending] = await bridgeItems(base, auth, dataDir, [{ tags: ['知识点A'] }, { tags: ['知识点B'] }]) as [WeekItem, WeekItem];
    const practice = await makePractice(base, auth, [done.id, pending.id]);
    printPacket(practice.id, 4);
    await postReturn(base, auth, practice.id, {
      results: [{ itemId: done.id, completion: 'not_done', performedOn: TODAY() }],
    });

    const summary = (await (await getSummary(base, auth, practice.id)).json()) as ReturnSummary;
    expect(summary.answered).toBe(1);
    expect(summary.total).toBe(2);
    expect(summary.independentCorrect).toBe(0);
    expect(summary.masteredNow).toEqual([]);
    expect(summary.again.map(card => card.id)).toEqual([done.id]);
    expect(summary.again[0]!.reason).toBe('没做');
    // F1：基数为 0 时 text 为 null，不输出"0 道里 0 道"。
    expect(summary.calibration.confidentTotal).toBe(0);
    expect(summary.calibration.missedCount).toBe(0);
    expect(summary.calibration.text).toBeNull();
    expect(summary.nextConfirmOn).toBeNull();
  });

  it('R1-F1 校准只算本包已回传的题、按最近一次复盘判定把握、基数为 0 时 text 为 null', async () => {
    const { base, dataDir, auth } = await setupApp();
    const [a, b, c, d, e, f] = await bridgeItems(base, auth, dataDir, [
      { tags: ['知识点A'] }, { tags: ['知识点B'] }, { tags: ['知识点C'] },
      { tags: ['知识点D'] }, { tags: ['知识点E'] }, { tags: ['知识点F'] },
    ]) as [WeekItem, WeekItem, WeekItem, WeekItem, WeekItem, WeekItem];
    // 5 道把握 ≥ 2（a/b=3，c/d=2）；e 先复盘把握 3、后又复盘把握 1 → 最近一次 < 2，不计入基数；f 无复盘。
    addDiagnosis('dia_a', a.id, 3);
    addDiagnosis('dia_b', b.id, 3);
    addDiagnosis('dia_c', c.id, 2);
    addDiagnosis('dia_d', d.id, 2);
    addDiagnosis('dia_e1', e.id, 3);
    addDiagnosis('dia_e2', e.id, 1);

    const practice = await makePractice(base, auth, [a.id, b.id, c.id, d.id, e.id, f.id]);
    printPacket(practice.id, 4);

    // 全部未回传：基数为 0，text 为 null。
    const before = (await (await getSummary(base, auth, practice.id)).json()) as ReturnSummary;
    expect(before.calibration).toMatchObject({ confidentTotal: 0, missedCount: 0, text: null, items: [] });

    // 只回传 2 道：a 独立做对、b 看了提示；c/d/e/f 未回传不得计入基数。
    const returned = await postReturn(base, auth, practice.id, {
      results: [
        { itemId: a.id, completion: 'independent', correct: true, performedOn: TODAY() },
        { itemId: b.id, completion: 'hint1', correct: true, performedOn: TODAY() },
      ],
    });
    expect(returned.status).toBe(200);

    const after = (await (await getSummary(base, auth, practice.id)).json()) as ReturnSummary;
    expect(after.calibration.confidentTotal).toBe(2);
    expect(after.calibration.missedCount).toBe(1);
    expect(after.calibration.text).toBe('你说有把握的 2 道里，1 道没独立做出来');
    expect(after.calibration.items.map(card => card.id)).toEqual([b.id]);
  });

  it('R1-F2 masteredNow 只含本包已回传的题：确认轮未回传的暂时掌握题不出现，回传做对后才出现', async () => {
    const { base, dataDir, auth } = await setupApp();
    const [confirm, normal] = await bridgeItems(base, auth, dataDir, [{ tags: ['知识点A'] }, { tags: ['知识点B'] }]) as [WeekItem, WeekItem];
    // confirm 以确认轮身份入包：暂时掌握且已到确认日期（D7：建包后保持该状态）。
    setStatus(confirm.id, 'temporarily_mastered', new Date(Date.now() - 86400000).toISOString());

    const practice = await makePractice(base, auth, [confirm.id, normal.id]);
    expect(practice.items.find(item => item.id === confirm.id)?.status).toBe('temporarily_mastered');
    printPacket(practice.id, 4);

    // 只回传 normal；confirm 尚未回传，不得出现在"这次真会了"。
    await postReturn(base, auth, practice.id, {
      results: [{ itemId: normal.id, completion: 'not_done', performedOn: TODAY() }],
    });
    const before = (await (await getSummary(base, auth, practice.id)).json()) as ReturnSummary;
    expect(before.masteredNow).toEqual([]);

    // confirm 回传独立做对（延迟 ≥3 天的确认轮）→ 稳定掌握，此时才进 masteredNow。
    const returned = await postReturn(base, auth, practice.id, {
      results: [{ itemId: confirm.id, completion: 'independent', correct: true, performedOn: TODAY() }],
    });
    const results = ((await returned.json()) as { results: ReturnItemResult[] }).results;
    expect(results[0]).toMatchObject({ ok: true, toStatus: 'stably_mastered' });

    const after = (await (await getSummary(base, auth, practice.id)).json()) as ReturnSummary;
    expect(after.masteredNow.map(card => card.id)).toEqual([confirm.id]);
    expect(after.masteredNow[0]!.status).toBe('stably_mastered');
  });

  it('T4g 回报 pending：当天独立做对进 pending 带固定文案；延迟做对进 masteredNow；提示/没做出来只在 again；未回传三组都不在；三组互不重叠', async () => {
    const { base, dataDir, auth } = await setupApp();
    const [sameDay, delayed, hinted, unsolved, unreturned] = await bridgeItems(base, auth, dataDir, [
      { tags: ['知识点A'] }, { tags: ['知识点B'] }, { tags: ['知识点C'] }, { tags: ['知识点D'] }, { tags: ['知识点E'] },
    ]) as [WeekItem, WeekItem, WeekItem, WeekItem, WeekItem];
    const practice = await makePractice(base, auth, [sameDay.id, delayed.id, hinted.id, unsolved.id, unreturned.id]);
    const printDay = printPacket(practice.id, 4);

    const returned = await postReturn(base, auth, practice.id, {
      results: [
        // 打印当天独立做对 → attempted（不算掌握，隔几天再验证）。
        { itemId: sameDay.id, completion: 'independent', correct: true, performedOn: printDay },
        // 打印 4 天后独立做对 → temporarily_mastered。
        { itemId: delayed.id, completion: 'independent', correct: true, performedOn: TODAY() },
        { itemId: hinted.id, completion: 'hint1', correct: true, performedOn: TODAY() },
        { itemId: unsolved.id, completion: 'not_solved', performedOn: TODAY() },
      ],
    });
    expect(returned.status).toBe(200);

    const response = await getSummary(base, auth, practice.id);
    expect(response.status).toBe(200);
    const summary = (await response.json()) as ReturnSummary;

    // 当天独立做对 → pending，带固定文案；卡片沿用 /v2/week 形状。
    expect(summary.pending.map(card => card.id)).toEqual([sameDay.id]);
    expect(summary.pending[0]!.reason).toBe('当天做对，隔几天再独立做对才算掌握');
    expect(summary.pending[0]).toMatchObject({ status: 'attempted' });
    expect(summary.pending[0]!.cropUrl).toBe(`/v2/items/${sameDay.id}/crop`);

    // 延迟独立做对 → masteredNow，不在 pending。
    expect(summary.masteredNow.map(card => card.id)).toEqual([delayed.id]);
    // 看了提示 / 没做出来 → 只在 again。
    expect(summary.again.map(card => card.id)).toEqual([hinted.id, unsolved.id]);

    // 未回传的题三组都不在。
    expect(summary.masteredNow.some(card => card.id === unreturned.id)).toBe(false);
    expect(summary.again.some(card => card.id === unreturned.id)).toBe(false);
    expect(summary.pending.some(card => card.id === unreturned.id)).toBe(false);

    // 三组互不重叠。
    const masteredIds = new Set(summary.masteredNow.map(card => card.id));
    const againIds = new Set(summary.again.map(card => card.id));
    for (const card of summary.pending) {
      expect(masteredIds.has(card.id)).toBe(false);
      expect(againIds.has(card.id)).toBe(false);
    }
    for (const id of againIds) {
      expect(masteredIds.has(id)).toBe(false);
    }
  });

  it('RED7 Web 练习包对两个接口 404；无令牌 401', async () => {
    const { base, auth } = await setupApp();
    makeWebItem('itm_web', 'packet_generated');
    const student = ensureStudentProfile();
    const db = getDb();
    db.prepare("INSERT INTO review_packet (id, student_id, week, status, generated_at, created_at) VALUES ('pkt_web', ?, ?, 'generated', ?, ?)").run(student.id, isoWeekKey(new Date()), now(), now());
    db.prepare("INSERT INTO review_packet_item (packet_id, item_id, position) VALUES ('pkt_web', 'itm_web', 0)").run();

    const returnBody = { results: [{ itemId: 'itm_web', completion: 'independent', correct: true, performedOn: TODAY() }] };
    expect((await postReturn(base, auth, 'pkt_web', returnBody)).status).toBe(404);
    expect((await getSummary(base, auth, 'pkt_web')).status).toBe(404);
    expect((await postReturn(base, auth, 'pkt_missing', returnBody)).status).toBe(404);
    expect((await getSummary(base, auth, 'pkt_missing')).status).toBe(404);

    const noAuthReturn = await fetch(`${base}/v2/practice/pkt_web/return`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(returnBody),
    });
    expect(noAuthReturn.status).toBe(401);
    const noAuthSummary = await fetch(`${base}/v2/practice/pkt_web/summary`);
    expect(noAuthSummary.status).toBe(401);
  });
});
