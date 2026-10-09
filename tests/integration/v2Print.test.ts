/**
 * T5：打印快照（POST/GET /v2/practice/:id/print、GET /v2/practice/:id/print/media/:name）。
 * 真实 HTTP（回环装配，共享令牌鉴权）+ 合成识别任务 + sharp 合成图 + 注入的计数 coach。
 * 不调用真实模型、不读 .env 与 data/。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Coaching, Diagnosis, Evidence } from '../../src/ai/evidence.js';
import type { CoachProvider } from '../../src/ai/provider.js';
import { getDb, now } from '../../src/db/connection.js';
import { isoWeekKey } from '../../src/domain/scheduling.js';
import { ensureStudentProfile } from '../../src/services/studentService.js';
import { createMobileApp } from '../../src/mobile/router.js';
import { MobileRecognitionStore } from '../../src/mobile/store.js';
import type { RecognitionQuestion, RecognitionVerification } from '../../src/mobile/contracts.js';
import type { MobileVisionBoundary, VisionContext, VisionInventoryResult, VisionQuestionResult, InventoryCandidate } from '../../src/mobile/vision.js';
import type { MobileRecognitionService } from '../../src/mobile/service.js';
import { createV2Router } from '../../src/v2/router.js';

const PAIRING = 't5-shared-token-0123456789';

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

// 每个用例清空业务表（共享测试库），保留学生档案。v2_print_snapshot 依赖 review_packet，先删。
beforeEach(() => {
  const database = getDb();
  for (const table of ['v2_print_snapshot', 'correction', 'correction_proposal', 'v2_reflection_turn', 'review_attempt', 'review_packet_item', 'review_packet', 'mobile_item_link', 'evidence_record', 'error_diagnosis', 'error_item', 'asset_origin', 'source_asset', 'source_batch', 'v2_photo', 'v2_setting']) {
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

/** 计数 coach：记录每次调用的证据与诊断；failFor 命中的题抛错（不阻塞快照，只留空提示）。 */
class CountingCoach implements CoachProvider {
  calls: Array<{ evidence: Evidence; diagnosis: Diagnosis }> = [];
  failFor: ((evidence: Evidence) => boolean) | null = null;
  async coachForPrint(evidence: Evidence, diagnosis: Diagnosis): Promise<Coaching> {
    this.calls.push({ evidence, diagnosis });
    if (this.failFor?.(evidence)) throw new Error('注入的 coach 失败');
    return {
      hints: ['一级提示：想想考什么', '二级提示：先列已知条件'],
      solution: '按定义逐步推导。',
      answer: 'AI参考答案',
      source: 'ai_generated',
    };
  }
}

const CHECKS: RecognitionVerification = { textComplete: true, questionCropComplete: true, questionCropPure: true, transcriptionMatches: true, diagramSafe: true, issues: [] };

let seq = 0;

/** 合成题图：白底，(40,40) 黑块=题干区（不遮），(200,200) 黑块=学生作答区（遮白），右下角变化黑块避免判重。 */
async function patternedJpeg(): Promise<Buffer> {
  const black = async (size: number) => sharp({ create: { width: size, height: size, channels: 3, background: '#000000' } }).png().toBuffer();
  return sharp({ create: { width: 400, height: 400, channels: 3, background: '#ffffff' } })
    .composite([
      { input: await black(80), left: 40, top: 40 },
      { input: await black(80), left: 200, top: 200 },
      { input: await black(6), left: 4 + (seq % 45) * 8, top: 388 },
    ])
    .jpeg().toBuffer();
}

interface EvidenceOptions { stem?: string; referenceAnswer?: boolean; diagram?: boolean; diagramMissing?: boolean; located?: boolean }

function evidence(number: string, tags: string[], options: EvidenceOptions = {}): Evidence {
  // located：所有手写类观察记录都有定位区域（遮得住）；缺省 o2/o3 无定位（regionId null，遮不住）。
  const locatedRegions = options.located
    ? [
        { id: 't1', kind: 'teacher_note' as const, box: { x: .1, y: .7, width: .2, height: .1 }, confidence: .9, cleanForPrint: false },
        { id: 'c1', kind: 'correction' as const, box: { x: .1, y: .8, width: .2, height: .1 }, confidence: .9, cleanForPrint: false },
      ]
    : [];
  return {
    version: 1, questionNumber: number,
    questionText: options.stem ?? `第${number}题题干：已知 x+y=${number}，求 x 的值。`,
    subject: '数学', chapter: '方程', knowledgeTags: tags, questionType: '计算',
    questionRegion: { x: 0, y: 0, width: 1, height: 1 }, requiresDiagram: options.diagram === true || options.diagramMissing === true,
    regions: [
      { id: 's1', kind: 'student_work', box: { x: .5, y: .5, width: .2, height: .2 }, confidence: .9, cleanForPrint: false },
      ...locatedRegions,
      ...(options.diagram ? [{ id: 'd1', kind: 'diagram' as const, box: { x: .1, y: .1, width: .2, height: .2 }, confidence: .9, cleanForPrint: true }] : []),
    ],
    observations: [
      { id: 'o1', kind: 'student_work', text: '学生作答标记', regionId: 's1', confidence: .9 },
      { id: 'o2', kind: 'teacher_note', text: '教师批注标记', regionId: options.located ? 't1' : null, confidence: .9 },
      { id: 'o3', kind: 'correction', text: '订正标记', regionId: options.located ? 'c1' : null, confidence: .9 },
      ...(options.referenceAnswer ? [{ id: 'o4', kind: 'reference_answer' as const, text: '原卷答案标记', regionId: null, confidence: .9 }] : []),
    ],
    uncertainties: [],
  };
}

interface QuestionSpec { tags: string[]; needsCheck?: boolean; referenceAnswer?: boolean; diagram?: boolean; diagramMissing?: boolean; located?: boolean; stem?: string; number?: string }

function question(number: string, spec: QuestionSpec): RecognitionQuestion {
  return {
    id: crypto.randomUUID(), number: spec.number ?? number, revision: 1, status: spec.needsCheck ? 'needs_check' : 'ready', selectionEvidence: 'marked_wrong',
    evidence: evidence(spec.number ?? number, spec.tags, spec), verification: { ...CHECKS }, questionMediaId: null, diagramMediaIds: [],
    error: null, confirmedAt: null,
  };
}

async function tempDir(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-t5-print-'));
  roots.push(dir);
  return dir;
}

/** 造一个终态（completed）识别任务，含给定题目与合成题图。 */
async function makeJob(dir: string, specs: QuestionSpec[]): Promise<string> {
  const store = await MobileRecognitionStore.open(dir);
  const bytes = await patternedJpeg();
  const { job } = await store.createJob({ idempotencyKey: crypto.randomUUID(), photoName: 'photo.jpg', sourceBytes: bytes, normalizedBytes: bytes });
  const questions = specs.map((spec, i) => question(String(seq + i + 1), spec));
  seq += specs.length;
  await store.updateJob(job.id, j => {
    j.phase = 'complete'; j.status = 'completed'; j.revision += 1;
    j.questions = questions;
  });
  return job.id;
}

interface WeekItem { id: string; shortId: string | null; badge: 'ok' | 'low'; status: string; jobId: string }
interface PracticeDetail { id: string; week: string; status: string; practiceSlot: string; generatedAt: string | null; items: Array<{ id: string; position: number }> }
interface SnapshotItem {
  itemId: string; shortId: string | null; position: number; subject: string | null; knowledgeTags: string[];
  mode: 'text' | 'crop'; stemText: string | null; cropMedia: string | null; diagramMedia: string[];
  keyStepPrompt: string; checkboxes: string[]; needsGlance: boolean; glanceReason: string | null;
}
interface AnswerEntry { shortId: string | null; hint1: string | null; hint2: string | null; answer: { text: string | null; source: 'paper' | 'ai' | 'none' }; fallbackNote: string }
interface PrintSnapshot {
  packetId: string; week: string; preparedAt: string;
  cover: { title: string; practiceSlot: string; rules: string[]; itemList: Array<{ shortId: string | null; sourceLabel: string }> };
  items: SnapshotItem[]; answerSheet: AnswerEntry[];
}
interface PrintStatusBody { status: 'none' | 'preparing' | 'ready' | 'failed'; progress: { done: number; total: number }; snapshot?: PrintSnapshot; error?: string | null }

async function setupApp(coach: CoachProvider = new CountingCoach()): Promise<{ base: string; dataDir: string; auth: { authorization: string } }> {
  const dataDir = await tempDir();
  const app = await createMobileApp({
    dataDir, pairingToken: PAIRING, vision: new FixtureVision(),
    v2Router: () => createV2Router({ mobileDataDir: dataDir, coachProvider: coach }),
  });
  loopbackServices.push(app.locals.mobileRecognitionService);
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, dataDir, auth: { authorization: `Bearer ${PAIRING}` } };
}

/** 造题、登记并桥接，按登记顺序返回卡片。 */
async function bridgeItems(base: string, auth: { authorization: string }, dataDir: string, specs: QuestionSpec[]): Promise<WeekItem[]> {
  const jobId = await makeJob(dataDir, specs);
  const registered = await fetch(`${base}/v2/photos/${jobId}/register`, { method: 'POST', headers: auth });
  expect(registered.status).toBe(200);
  const week = (await (await fetch(`${base}/v2/week`, { headers: auth })).json()) as { items: WeekItem[] };
  return week.items.filter(item => item.jobId === jobId);
}

async function makePractice(base: string, auth: { authorization: string }, itemIds: string[]): Promise<PracticeDetail> {
  const response = await fetch(`${base}/v2/practice`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ itemIds }) });
  expect(response.status).toBe(200);
  return (await response.json()) as PracticeDetail;
}

const postPrint = (base: string, auth: { authorization: string }, id: string) =>
  fetch(`${base}/v2/practice/${id}/print`, { method: 'POST', headers: auth });

const getPrint = async (base: string, auth: { authorization: string }, id: string): Promise<PrintStatusBody> =>
  (await (await fetch(`${base}/v2/practice/${id}/print`, { headers: auth })).json()) as PrintStatusBody;

/** 轮询直到 ready/failed。 */
async function pollPrint(base: string, auth: { authorization: string }, id: string): Promise<PrintStatusBody> {
  for (let i = 0; i < 400; i += 1) {
    const body = await getPrint(base, auth, id);
    if (body.status === 'ready' || body.status === 'failed') return body;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('打印快照准备超时');
}

/** POST 并轮询到 ready，返回快照。 */
async function prepareReady(base: string, auth: { authorization: string }, id: string): Promise<PrintSnapshot> {
  const response = await postPrint(base, auth, id);
  expect([200, 202]).toContain(response.status);
  const body = await pollPrint(base, auth, id);
  expect(body.status).toBe('ready');
  expect(body.snapshot).toBeDefined();
  return body.snapshot!;
}

const setStatus = (id: string, status: string, nextReviewAt: string | null = null): void => {
  getDb().prepare('UPDATE error_item SET status = ?, next_review_at = ?, updated_at = ? WHERE id = ?').run(status, nextReviewAt, now(), id);
};

const setPaperLocation = (base: string, auth: { authorization: string }, paperLocation: 'school' | 'home' | 'varies') =>
  fetch(`${base}/v2/settings`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ practiceSlot: '本周内', paperLocation }) });

/** 直接造一个 Web 来源练习包（无 mobile_item_link）。 */
function makeWebPacket(packetId: string): void {
  const student = ensureStudentProfile();
  const db = getDb();
  db.prepare("INSERT INTO source_batch (id, student_id, status, total_files, done_files, created_at) VALUES (?, ?, 'done', 1, 1, ?)").run(`bat_${packetId}`, student.id, now());
  db.prepare("INSERT INTO source_asset (id, batch_id, filename, mime, size, content_hash, status, storage_path, created_at) VALUES (?, ?, 'w.jpg', 'image/jpeg', 1, ?, 'done', '/nowhere.jpg', ?)").run(`ast_${packetId}`, `bat_${packetId}`, `hash-${packetId}`, now());
  db.prepare("INSERT INTO error_item (id, student_id, batch_id, asset_id, item_index, status, knowledge_tags, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 'eligible_for_review', '[\"一元一次方程\"]', ?, ?)").run(`itm_${packetId}`, student.id, `bat_${packetId}`, `ast_${packetId}`, now(), now());
  db.prepare("INSERT INTO review_packet (id, student_id, week, status, created_at) VALUES (?, ?, ?, 'scheduled', ?)").run(packetId, student.id, isoWeekKey(new Date()), now());
  db.prepare('INSERT INTO review_packet_item (packet_id, item_id, position) VALUES (?, ?, 0)').run(packetId, `itm_${packetId}`);
}

describe('T5 打印快照', () => {
  it('RED1 POST 202 → 轮询 ready；快照形状正确；generated_at、包与题目状态流转', async () => {
    const { base, dataDir, auth } = await setupApp();
    const [withDiagram, , mastered] = await bridgeItems(base, auth, dataDir, [
      { tags: ['知识点A'], diagram: true }, { tags: ['知识点B'] }, { tags: ['知识点C'] },
    ]) as [WeekItem, WeekItem, WeekItem];
    setStatus(mastered.id, 'temporarily_mastered', new Date(Date.now() - 86400000).toISOString());
    const practice = await makePractice(base, auth, [withDiagram.id, mastered.id]);

    // 未请求过：status none。
    const none = await getPrint(base, auth, practice.id);
    expect(none).toMatchObject({ status: 'none', progress: { done: 0, total: 2 } });

    const created = await postPrint(base, auth, practice.id);
    expect(created.status).toBe(202);
    expect((await created.json()) as PrintStatusBody).toMatchObject({ status: 'preparing' });

    const body = await pollPrint(base, auth, practice.id);
    expect(body.status).toBe('ready');
    const snapshot = body.snapshot!;
    expect(snapshot.packetId).toBe(practice.id);
    expect(snapshot.week).toBe(isoWeekKey(new Date()));
    expect(typeof snapshot.preparedAt).toBe('string');
    expect(snapshot.cover).toMatchObject({
      title: '本周练习',
      practiceSlot: '本周内',
      rules: ['不看答案，独立做', '卡住先看一级提示，再看二级', '做完打勾，写上做题日期'],
    });
    expect(snapshot.cover.itemList).toHaveLength(2);
    expect(snapshot.cover.itemList[0]).toMatchObject({ sourceLabel: '原题' });

    expect(snapshot.items).toHaveLength(2);
    const first = snapshot.items[0]!;
    expect(first).toMatchObject({
      itemId: withDiagram.id, position: 0, subject: '数学', knowledgeTags: ['知识点A'],
      mode: 'text', keyStepPrompt: '这题的关键一步是：',
      checkboxes: ['独立做出', '看了一级提示', '看了二级提示', '没做出来'],
    });
    expect(typeof first.stemText).toBe('string');
    expect(first.cropMedia).toBeNull();
    // text 模式且 requiresDiagram：裁出 diagram 区域。
    expect(first.diagramMedia).toHaveLength(1);

    expect(snapshot.answerSheet).toHaveLength(2);
    expect(snapshot.answerSheet[0]).toMatchObject({ shortId: first.shortId });

    // 状态流转：generated_at 仅首次写、包 generated、scheduled → packet_generated、暂时掌握保持。
    const db = getDb();
    const packet = db.prepare('SELECT status, generated_at FROM review_packet WHERE id = ?').get(practice.id) as { status: string; generated_at: string | null };
    expect(packet.status).toBe('generated');
    expect(typeof packet.generated_at).toBe('string');
    expect(db.prepare('SELECT status FROM error_item WHERE id = ?').get(withDiagram.id)).toEqual({ status: 'packet_generated' });
    expect(db.prepare('SELECT status FROM error_item WHERE id = ?').get(mastered.id)).toEqual({ status: 'temporarily_mastered' });
  });

  it('RED2 low 徽标题为 crop 模式：stemText 与遮白裁图同时给出；ok 题为 text 模式无裁图', async () => {
    const { base, dataDir, auth } = await setupApp();
    const [low, ok] = await bridgeItems(base, auth, dataDir, [
      { tags: ['知识点A'], needsCheck: true, stem: '低把握题题干标记' }, { tags: ['知识点B'] },
    ]) as [WeekItem, WeekItem];
    expect(low.badge).toBe('low');
    const practice = await makePractice(base, auth, [low.id, ok.id]);
    const snapshot = await prepareReady(base, auth, practice.id);

    const lowItem = snapshot.items.find(item => item.itemId === low.id)!;
    const okItem = snapshot.items.find(item => item.itemId === ok.id)!;
    expect(lowItem.mode).toBe('crop');
    // T5R2-F1：没把握的题同时印文字和截图——截图有问题还有文字，文字有问题还有截图。
    expect(lowItem.stemText).toBe('低把握题题干标记');
    expect(typeof lowItem.cropMedia).toBe('string');
    expect(okItem.mode).toBe('text');
    expect(okItem.cropMedia).toBeNull();

    // 取回裁图：学生作答区（原图 200..280）已遮白；题干区（40..120）保持非全白。
    const media = await fetch(`${base}/v2/practice/${practice.id}/print/media/${lowItem.cropMedia}`, { headers: auth });
    expect(media.status).toBe(200);
    const bytes = Buffer.from(await media.arrayBuffer());
    const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
    const pixelAt = (x: number, y: number): number => data[(y * info.width + x) * info.channels]!;
    expect(pixelAt(230, 230)).toBeGreaterThan(200);
    expect(pixelAt(60, 60)).toBeLessThan(60);
  });

  it('RED3 题面不含学生作答/订正/批注/参考答案文字', async () => {
    const { base, dataDir, auth } = await setupApp();
    const [item] = await bridgeItems(base, auth, dataDir, [{ tags: ['知识点A'], referenceAnswer: true }]) as [WeekItem];
    const practice = await makePractice(base, auth, [item.id]);
    const snapshot = await prepareReady(base, auth, practice.id);
    const itemsJson = JSON.stringify(snapshot.items);
    expect(itemsJson).not.toContain('学生作答标记');
    expect(itemsJson).not.toContain('教师批注标记');
    expect(itemsJson).not.toContain('订正标记');
    expect(itemsJson).not.toContain('原卷答案');
    expect(snapshot.items[0]!.stemText).toContain('题干');
  });

  it('RED4 答案三种来源；coach 失败提示为空且 fallbackNote 随 paperLocation 变化；每题恰好 1 次 coach', async () => {
    const coach = new CountingCoach();
    coach.failFor = e => e.questionText.includes('失败题');
    const { base, dataDir, auth } = await setupApp(coach);
    const items = await bridgeItems(base, auth, dataDir, [
      { tags: ['知识点A'], referenceAnswer: true }, { tags: ['知识点B'] }, { tags: ['知识点C'], stem: '失败题：求 y。' },
      { tags: ['知识点D'], stem: '失败题：求 z。' }, { tags: ['知识点E'], stem: '失败题：求 w。' },
    ]);

    // school：三种答案来源同包。
    await setPaperLocation(base, auth, 'school');
    const practiceA = await makePractice(base, auth, [items[0]!.id, items[1]!.id, items[2]!.id]);
    const snapshotA = await prepareReady(base, auth, practiceA.id);
    const byShortId = new Map(snapshotA.answerSheet.map(entry => [entry.shortId, entry]));
    const sheetOf = (itemId: string): AnswerEntry =>
      byShortId.get(snapshotA.items.find(item => item.itemId === itemId)!.shortId)!;

    const paper = sheetOf(items[0]!.id);
    expect(paper.answer).toMatchObject({ text: '原卷答案标记', source: 'paper' });
    const ai = sheetOf(items[1]!.id);
    expect(ai.answer.source).toBe('ai');
    expect(ai.answer.text).toBe('AI参考答案');
    expect(ai.hint1).toBe('一级提示：想想考什么');
    expect(ai.hint2).toBe('二级提示：先列已知条件');
    const failed = sheetOf(items[2]!.id);
    expect(failed).toMatchObject({ hint1: null, hint2: null });
    expect(failed.answer).toMatchObject({ text: null, source: 'none' });
    // fallbackNote 的题号取该题证据里的 questionNumber（从 coach 调用记录回查，避免夹具编号耦合）。
    const numberOf = (stemFragment: string): string => coach.calls.find(call => call.evidence.questionText.includes(stemFragment))!.evidence.questionNumber;
    expect(failed.fallbackNote).toBe(`对照原卷第 ${numberOf('失败题：求 y。')} 题`);

    // home / varies：措辞随设置变化。
    await setPaperLocation(base, auth, 'home');
    const practiceB = await makePractice(base, auth, [items[3]!.id]);
    const snapshotB = await prepareReady(base, auth, practiceB.id);
    expect(snapshotB.answerSheet[0]!.fallbackNote).toBe(`回家后对照原卷第 ${numberOf('失败题：求 z。')} 题`);

    await setPaperLocation(base, auth, 'varies');
    const practiceC = await makePractice(base, auth, [items[4]!.id]);
    const snapshotC = await prepareReady(base, auth, practiceC.id);
    expect(snapshotC.answerSheet[0]!.fallbackNote).toBe(`对照原卷第 ${numberOf('失败题：求 w。')} 题（原卷不在手边就回家再对）`);

    // coach 每题恰好 1 次、不重试（含失败题）。
    expect(coach.calls).toHaveLength(5);
    expect(new Set(coach.calls.map(call => call.evidence.questionNumber)).size).toBe(5);

    // coach 诊断对象：无复盘 possibleCause=null；有复盘取复盘错因与学生确认的归纳。
    expect(coach.calls[0]!.diagnosis).toMatchObject({ possibleCause: null, confidence: 0.5, findings: [], clarificationQuestion: null });
  });

  it('RED4b 有 v2 复盘时 coach 诊断带复盘错因与确认归纳', async () => {
    const coach = new CountingCoach();
    const { base, dataDir, auth } = await setupApp(coach);
    const [item] = await bridgeItems(base, auth, dataDir, [{ tags: ['知识点A'] }]) as [WeekItem];
    const reflection = await fetch(`${base}/v2/items/${item.id}/reflection`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ attemptState: '本来会但审题计算书写失误', cause: '计算', masteryFeeling: 2, summary: '抄错了数字' }),
    });
    expect(reflection.status).toBe(200);
    const practice = await makePractice(base, auth, [item.id]);
    await prepareReady(base, auth, practice.id);
    expect(coach.calls).toHaveLength(1);
    expect(coach.calls[0]!.diagnosis).toMatchObject({ summary: '抄错了数字', possibleCause: '计算', confidence: 0.5, findings: [], clarificationQuestion: null });
  });

  it('RED5 冻结：ready 后修改证据，快照不变且 coach 不再调用', async () => {
    const coach = new CountingCoach();
    const { base, dataDir, auth } = await setupApp(coach);
    const [item] = await bridgeItems(base, auth, dataDir, [{ tags: ['知识点A'] }]) as [WeekItem];
    const practice = await makePractice(base, auth, [item.id]);
    const before = await prepareReady(base, auth, practice.id);
    expect(coach.calls).toHaveLength(1);

    // 直改证据（T4e 直改接口）：题干完全换掉。
    const revision = (getDb().prepare('SELECT revision FROM evidence_record WHERE item_id = ?').get(item.id) as { revision: number }).revision;
    const corrected = await fetch(`${base}/v2/items/${item.id}/correct/direct`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ revision, changes: [{ field: 'questionText', before: before.items[0]!.stemText, after: '改动后的全新题干，与快照无关。' }] }),
    });
    expect(corrected.status).toBe(200);

    const after = await getPrint(base, auth, practice.id);
    expect(after.status).toBe('ready');
    expect(JSON.stringify(after.snapshot)).toBe(JSON.stringify(before));

    // 再次 POST 返回同一份快照（200），不重新准备。
    const again = await postPrint(base, auth, practice.id);
    expect(again.status).toBe(200);
    const againBody = (await again.json()) as PrintStatusBody;
    expect(JSON.stringify(againBody.snapshot)).toBe(JSON.stringify(before));
    expect(coach.calls).toHaveLength(1);
  });

  it('RED6 并发两个 POST 只准备一次；preparing 快照续做时已完成题不重做', async () => {
    const coach = new CountingCoach();
    const { base, dataDir, auth } = await setupApp(coach);
    const items = await bridgeItems(base, auth, dataDir, [{ tags: ['知识点A'] }, { tags: ['知识点B'] }]);
    const practice = await makePractice(base, auth, items.map(item => item.id));

    // 并发：两个 POST 同时发出，coach 总共只按题数调用一次。
    const [first, second] = await Promise.all([postPrint(base, auth, practice.id), postPrint(base, auth, practice.id)]);
    expect([202, 200]).toContain(first.status);
    expect([202, 200]).toContain(second.status);
    const ready = await pollPrint(base, auth, practice.id);
    expect(ready.status).toBe('ready');
    expect(coach.calls).toHaveLength(2);
    const snapshot = ready.snapshot!;

    // 模拟重启：状态改回 preparing、只保留第 1 题进度；item 状态回到 scheduled 以便重新收尾。
    const db = getDb();
    const partial = { ...snapshot, items: snapshot.items.slice(0, 1), answerSheet: snapshot.answerSheet.slice(0, 1) };
    db.prepare("UPDATE v2_print_snapshot SET status = 'preparing', snapshot_json = ?, progress_done = 1, progress_total = 2, ready_at = NULL, error = NULL WHERE packet_id = ?")
      .run(JSON.stringify(partial), practice.id);
    db.prepare("UPDATE error_item SET status = 'scheduled', updated_at = ? WHERE id = ?").run(now(), items[1]!.id);
    coach.calls.length = 0;

    // 调用启动续做函数：只补第 2 题，最终快照与原来一致。
    const { resumePendingSnapshots } = await import('../../src/v2/printService.js');
    resumePendingSnapshots(coach);
    const resumed = await pollPrint(base, auth, practice.id);
    expect(resumed.status).toBe('ready');
    expect(coach.calls).toHaveLength(1);
    // 只有第 2 题被重做（其题面文字与快照第 2 项一致）。
    expect(coach.calls[0]!.evidence.questionText).toBe(snapshot.items[1]!.stemText);
    expect(JSON.stringify(resumed.snapshot)).toBe(JSON.stringify(snapshot));
  });

  it('RED7 原图缺失 → failed 且不写 generated_at；修复后再 POST 成功', async () => {
    const { base, dataDir, auth } = await setupApp();
    const [item] = await bridgeItems(base, auth, dataDir, [{ tags: ['知识点A'] }]) as [WeekItem];
    const practice = await makePractice(base, auth, [item.id]);

    const db = getDb();
    const asset = db.prepare('SELECT sa.storage_path FROM source_asset sa JOIN error_item ei ON ei.asset_id = sa.id WHERE ei.id = ?').get(item.id) as { storage_path: string };
    const saved = fs.readFileSync(asset.storage_path);
    fs.rmSync(asset.storage_path);

    const response = await postPrint(base, auth, practice.id);
    expect(response.status).toBe(202);
    const failed = await pollPrint(base, auth, practice.id);
    expect(failed.status).toBe('failed');
    const packet = db.prepare('SELECT status, generated_at FROM review_packet WHERE id = ?').get(practice.id) as { status: string; generated_at: string | null };
    expect(packet.status).toBe('scheduled');
    expect(packet.generated_at).toBeNull();
    expect(db.prepare('SELECT status FROM error_item WHERE id = ?').get(item.id)).toEqual({ status: 'scheduled' });
    const row = db.prepare('SELECT status, error FROM v2_print_snapshot WHERE packet_id = ?').get(practice.id) as { status: string; error: string | null };
    expect(row.status).toBe('failed');
    expect(row.error).toBeTruthy();

    // 修复原图后再次 POST：重新准备并成功。
    fs.writeFileSync(asset.storage_path, saved);
    const retry = await postPrint(base, auth, practice.id);
    expect(retry.status).toBe(202);
    const ok = await pollPrint(base, auth, practice.id);
    expect(ok.status).toBe('ready');
    expect((db.prepare('SELECT generated_at FROM review_packet WHERE id = ?').get(practice.id) as { generated_at: string | null }).generated_at).toBeTruthy();
  });

  it('RED8 媒体接口只认登记名字；Web 包 404；无令牌 401', async () => {
    const { base, dataDir, auth } = await setupApp();
    const [item] = await bridgeItems(base, auth, dataDir, [{ tags: ['知识点A'], needsCheck: true }]) as [WeekItem];
    const practice = await makePractice(base, auth, [item.id]);
    const snapshot = await prepareReady(base, auth, practice.id);
    const name = snapshot.items[0]!.cropMedia!;
    expect(typeof name).toBe('string');

    const media = await fetch(`${base}/v2/practice/${practice.id}/print/media/${name}`, { headers: auth });
    expect(media.status).toBe(200);
    expect(media.headers.get('content-type')).toContain('image/jpeg');
    expect(media.headers.get('cache-control')).toBe('private, no-store');

    // 未登记的名字 404（含路径穿越样式）。
    expect((await fetch(`${base}/v2/practice/${practice.id}/print/media/unknown.jpg`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${base}/v2/practice/${practice.id}/print/media/..%2F..%2Fapp.db`, { headers: auth })).status).toBe(404);

    // Web 练习包：三个接口一律 404。
    makeWebPacket('pkt_web_t5');
    expect((await postPrint(base, auth, 'pkt_web_t5')).status).toBe(404);
    expect((await fetch(`${base}/v2/practice/pkt_web_t5/print`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${base}/v2/practice/pkt_web_t5/print/media/${name}`, { headers: auth })).status).toBe(404);

    // 无令牌 401。
    expect((await fetch(`${base}/v2/practice/${practice.id}/print`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${base}/v2/practice/${practice.id}/print`)).status).toBe(401);
    expect((await fetch(`${base}/v2/practice/${practice.id}/print/media/${name}`)).status).toBe(401);
  });

  it('R1-F1 ok 徽标题 requiresDiagram 但没有 diagram 区域时改用 crop 模式（同时给 stemText）', async () => {
    const { base, dataDir, auth } = await setupApp();
    const [missing, withDiagram, plain] = await bridgeItems(base, auth, dataDir, [
      { tags: ['知识点A'], diagramMissing: true, stem: '缺图示题题干标记' }, { tags: ['知识点B'], diagram: true }, { tags: ['知识点C'] },
    ]) as [WeekItem, WeekItem, WeekItem];
    const practice = await makePractice(base, auth, [missing.id, withDiagram.id, plain.id]);
    const snapshot = await prepareReady(base, auth, practice.id);

    const byItemId = new Map(snapshot.items.map(item => [item.itemId, item]));
    // 需要图示却没有 diagram 区域 → crop 模式（遮白裁图），不是只印文字；T5R2-F1：同样给出 stemText。
    expect(byItemId.get(missing.id)).toMatchObject({ mode: 'crop', stemText: '缺图示题题干标记' });
    expect(typeof byItemId.get(missing.id)!.cropMedia).toBe('string');
    // 有 diagram 区域的保持 text 模式并裁出图示；不需要图示的保持 text 模式。
    expect(byItemId.get(withDiagram.id)).toMatchObject({ mode: 'text', cropMedia: null });
    expect(byItemId.get(withDiagram.id)!.diagramMedia).toHaveLength(1);
    expect(byItemId.get(plain.id)).toMatchObject({ mode: 'text', cropMedia: null });
  });

  it('R1-F2 crop 模式 needsGlance：low 徽标恒提示；无法定位手写沿用旧文案，否则提示 AI 没把握；text 恒 false', async () => {
    const { base, dataDir, auth } = await setupApp();
    const [unlocated, located, textItem, diagramMissingLocated] = await bridgeItems(base, auth, dataDir, [
      { tags: ['知识点A'], needsCheck: true }, { tags: ['知识点B'], needsCheck: true, located: true },
      { tags: ['知识点C'] }, { tags: ['知识点D'], diagramMissing: true, located: true },
    ]) as [WeekItem, WeekItem, WeekItem, WeekItem];
    const practice = await makePractice(base, auth, [unlocated.id, located.id, textItem.id, diagramMissingLocated.id]);
    const snapshot = await prepareReady(base, auth, practice.id);

    const byItemId = new Map(snapshot.items.map(item => [item.itemId, item]));
    // 无定位（regionId null 的批注/订正）→ 可能没遮全，沿用旧文案。
    expect(byItemId.get(unlocated.id)).toMatchObject({
      mode: 'crop', needsGlance: true, glanceReason: '这题的手写内容可能没有遮全，打印前请看一眼',
    });
    // T5R2-F1：low 徽标即使全部有定位也提示（余量加宽可能带进相邻题目），用新文案。
    expect(byItemId.get(located.id)).toMatchObject({
      mode: 'crop', needsGlance: true, glanceReason: '这题 AI 没把握，打印前看一眼截图是否完整',
    });
    // text 模式恒为 false / null（本条观察记录同样无定位，但文字题面不含手写内容）。
    expect(byItemId.get(textItem.id)).toMatchObject({ mode: 'text', needsGlance: false, glanceReason: null });
    // ok 徽标、因缺图示进 crop 且全部有定位：不需要。
    expect(byItemId.get(diagramMissingLocated.id)).toMatchObject({ mode: 'crop', needsGlance: false, glanceReason: null });
  });

  it('T5R2-F2 fallbackNote 题号规整：带标点/括号的题号印成"第 N 题"', async () => {
    const { base, dataDir, auth } = await setupApp();
    const items = await bridgeItems(base, auth, dataDir, [
      { tags: ['知识点A'], number: '2.' }, { tags: ['知识点B'], number: '（3）' },
      { tags: ['知识点C'], number: '第4题' }, { tags: ['知识点D'], number: '13' },
    ]);
    await setPaperLocation(base, auth, 'school');
    const practice = await makePractice(base, auth, items.map(item => item.id));
    const snapshot = await prepareReady(base, auth, practice.id);
    expect(snapshot.answerSheet.map(entry => entry.fallbackNote)).toEqual([
      '对照原卷第 2 题', '对照原卷第 3 题', '对照原卷第 4 题', '对照原卷第 13 题',
    ]);
    // 证据里的题号保持原值，不改。
    const row = getDb().prepare('SELECT content_json FROM evidence_record WHERE item_id = ?').get(items[0]!.id) as { content_json: string };
    expect((JSON.parse(row.content_json) as { questionNumber: string }).questionNumber).toBe('2.');
  });

  // 2026-10-09 学生网页版（/s/）挂进生产入口：SSR 视图用 react / react-dom，拍照表单上传用 multer。
  // 三者本来就在 package.json 的 dependencies 里（npm ci --omit=dev 会装）；白名单只加这三个，并另查任何 devDependency 都不可达。
  it('RED9 生产入口依赖守卫：dist/main.js 可达第三方包只有 express、sharp 与学生网页版的 react、react-dom、multer', () => {
    const entry = path.resolve('dist/main.js');
    if (!fs.existsSync(entry)) {
      // verify 顺序下测试先于 build 执行时允许跳过；门禁跑 build 后必须真实通过。
      console.warn('dist/main.js 不存在，跳过依赖守卫（先执行 npm run build）');
      return;
    }
    const seen = new Set<string>();
    const bare = new Set<string>();
    const visit = (file: string): void => {
      const resolved = path.resolve(file);
      if (seen.has(resolved) || !fs.existsSync(resolved)) return;
      seen.add(resolved);
      const source = fs.readFileSync(resolved, 'utf8');
      for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        const spec = match[1]!;
        if (spec.startsWith('node:')) continue;
        if (spec.startsWith('.')) { visit(path.join(path.dirname(resolved), spec)); continue; }
        const parts = spec.split('/');
        bare.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!);
      }
    };
    visit(entry);
    const allowed = ['express', 'sharp', 'react', 'react-dom', 'multer'];
    const manifest = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    for (const name of allowed) expect(Object.keys(manifest.dependencies), `${name} 必须是生产依赖`).toContain(name);
    for (const name of bare) {
      expect(allowed, `dist/main.js 依赖链出现第三方包：${name}`).toContain(name);
      expect(Object.keys(manifest.devDependencies), `dist/main.js 依赖链出现开发依赖：${name}`).not.toContain(name);
    }
  });
});
