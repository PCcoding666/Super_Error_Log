import { resetMaterials } from '../helpers/resetMaterials.js';
/**
 * T5b：端到端串联——按 docs/mobile-v2-api.md §5 的"学生的一周"时序把所有 /v2 接口串一遍。
 * 真实 HTTP（回环装配，共享令牌鉴权）+ 直接构造终态识别任务 + 注入的合成模型
 * （followup / correction / coach 均为确定性桩，不走 HTTP、不调真实模型、不读 .env 与 data/）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Evidence } from '../../src/ai/evidence.js';
import type { CoachProvider, CorrectionProvider, FollowupProvider, FollowupTurn } from '../../src/ai/provider.js';
import { getDb, now } from '../../src/db/connection.js';
import { isoWeekKey } from '../../src/domain/scheduling.js';
import { ensureStudentProfile } from '../../src/services/studentService.js';
import { createMobileApp } from '../../src/mobile/router.js';
import { MobileRecognitionStore } from '../../src/mobile/store.js';
import type { RecognitionQuestion, RecognitionVerification, StoredRecognitionJob } from '../../src/mobile/contracts.js';
import type { MobileVisionBoundary, VisionContext, VisionInventoryResult, VisionQuestionResult, InventoryCandidate } from '../../src/mobile/vision.js';
import type { MobileRecognitionService } from '../../src/mobile/service.js';
import { createV2Router } from '../../src/v2/router.js';

const PAIRING = 't5b-shared-token-0123456789';
const FALLBACK_NOTE = '对照原卷查看解析';
const DAY_MS = 86400000;

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
  for (const table of ['v2_print_snapshot', 'correction', 'correction_proposal', 'v2_reflection_turn', 'mastery_event', 'review_attempt', 'review_packet_item', 'review_packet', 'mobile_item_link', 'evidence_record', 'error_diagnosis', 'error_item', 'asset_origin', 'source_asset', 'source_batch', 'v2_photo', 'v2_setting']) {
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

// ---------- 合成模型桩（确定性，直接实现 provider 接口） ----------

const AI_QUESTION = '你原来写 x=1，这一步当时是怎么想的？';
const AI_SECOND_QUESTION = '等号另一边你是怎么处理的？';
const AI_SUMMARY = '把移项当成了照抄，漏了变号';

const followupStub: FollowupProvider = {
  async followupAsk() {
    return { question: AI_QUESTION, referencedObservationIds: ['o1'] };
  },
  async followupSummarize(_evidence: Evidence, turns: FollowupTurn[]) {
    return {
      summary: AI_SUMMARY,
      suggestedCause: '推理步骤' as const,
      suggestedAttemptState: '方法基本正确但步骤出错' as const,
      secondQuestion: turns.length === 1 ? AI_SECOND_QUESTION : null,
    };
  },
};

const correctionStub: CorrectionProvider = {
  async proposeCorrection(evidence: Evidence) {
    return {
      changes: [{
        field: 'questionText' as const,
        before: evidence.questionText,
        after: evidence.questionText.replace('求 x 的值', '求 y 的值'),
        find: '求 x 的值',
        replace: '求 y 的值',
      }],
      rejected: [],
      clarify: null,
    };
  },
};

const coachStub: CoachProvider = {
  async coachForPrint() {
    return {
      hints: ['一级提示：先移项', '二级提示：两边同时减 y'],
      solution: '移项后合并同类项。',
      answer: 'x = 1 - y',
      source: 'ai_generated',
    };
  },
};

// ---------- 识别任务夹具 ----------

const CHECKS: RecognitionVerification = { textComplete: true, questionCropComplete: true, questionCropPure: true, transcriptionMatches: true, diagramSafe: true, issues: [] };

async function jpeg(color = '#ffffff'): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: color } }).jpeg().toBuffer();
}

interface QuestionSpec { tags: string[]; needsCheck?: boolean; referenceAnswer?: boolean; unlocatedNote?: boolean }

function evidence(number: string, spec: QuestionSpec): Evidence {
  return {
    version: 1, questionNumber: number, questionText: `已知 x+y=${number}，求 x 的值。`, subject: '数学', chapter: '方程',
    knowledgeTags: spec.tags, questionType: '计算',
    questionRegion: { x: .1, y: .1, width: .8, height: .8 }, requiresDiagram: false,
    regions: [{ id: 's1', kind: 'student_work', box: { x: .2, y: .2, width: .2, height: .2 }, confidence: .9, cleanForPrint: false }],
    observations: [
      { id: 'o1', kind: 'student_work', text: 'x=1', regionId: 's1', confidence: .9 },
      ...(spec.referenceAnswer ? [{ id: 'o4', kind: 'reference_answer' as const, text: 'x = (1-y)/2', regionId: null, confidence: .9 }] : []),
      ...(spec.unlocatedNote ? [{ id: 'o2', kind: 'teacher_note' as const, text: '移项要变号', regionId: null, confidence: .9 }] : []),
    ],
    uncertainties: [],
  };
}

function question(number: string, spec: QuestionSpec): RecognitionQuestion {
  return {
    id: crypto.randomUUID(), number, revision: 1, status: spec.needsCheck ? 'needs_check' : 'ready',
    selectionEvidence: 'marked_wrong',
    evidence: evidence(number, spec), verification: { ...CHECKS }, questionMediaId: null, diagramMediaIds: [],
    error: null, confirmedAt: null,
  };
}

async function tempDir(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-t5b-journey-'));
  roots.push(dir);
  return dir;
}

/** 直接构造一个终态（completed）识别任务目录，含给定题目。 */
async function makeJob(dir: string, specs: QuestionSpec[]): Promise<string> {
  const store = await MobileRecognitionStore.open(dir);
  const bytes = await jpeg('#fefefe');
  const { job } = await store.createJob({ idempotencyKey: crypto.randomUUID(), photoName: 'photo.jpg', sourceBytes: bytes, normalizedBytes: bytes });
  await store.updateJob(job.id, (j: StoredRecognitionJob) => {
    j.phase = 'complete'; j.status = 'completed'; j.revision += 1;
    j.questions = specs.map((spec, i) => question(String(i + 1), spec));
  });
  return job.id;
}

// ---------- HTTP 辅助 ----------

interface WeekItem {
  id: string; shortId: string | null; subject: string | null; knowledgeTags: string[];
  questionExcerpt: string | null; badge: 'ok' | 'low'; status: string; cropUrl: string; jobId: string;
}
interface WeekPhoto { jobId: string; registeredAt: string; recognition: string; bridged: boolean; bridgeError: string | null; itemCount: number }
interface PracticeCard extends WeekItem { reason: string; tier: number; reflected: boolean }
interface PracticeDetail {
  id: string; week: string; status: string; practiceSlot: string | null; createdAt: string; generatedAt: string | null;
  items: Array<PracticeCard & { position: number }>;
}
interface SnapshotItem {
  itemId: string; shortId: string | null; position: number; subject: string | null; knowledgeTags: string[];
  mode: 'text' | 'crop'; stemText: string | null; cropMedia: string | null; diagramMedia: string[];
  keyStepPrompt: string; checkboxes: string[]; needsGlance: boolean; glanceReason: string | null;
}
interface AnswerEntry { shortId: string | null; hint1: string | null; hint2: string | null; answer: { text: string | null; source: string; label: string | null }; fallbackNote: string }
interface PrintSnapshot {
  packetId: string; week: string; preparedAt: string;
  cover: { title: string; practiceSlot: string; rules: string[]; itemList: Array<{ shortId: string | null; sourceLabel: string }> };
  items: SnapshotItem[]; answerSheet: AnswerEntry[];
}
interface PrintStatusBody { status: string; progress: { done: number; total: number }; snapshot?: PrintSnapshot; error?: string | null }
interface ReturnItemResult { itemId: string; ok: boolean; toStatus?: string; reason?: string; error?: string }
interface ReturnSummary {
  answered: number; total: number; independentCorrect: number;
  masteredNow: WeekItem[]; again: Array<WeekItem & { reason: string }>;
  calibration: { confidentTotal: number; missedCount: number; text: string | null; items: WeekItem[] };
  nextConfirmOn: string | null;
}

function localDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function setupApp(): Promise<{ base: string; dataDir: string; auth: { authorization: string }; json: Record<string, string> }> {
  const dataDir = await tempDir();
  const app = await createMobileApp({
    dataDir, pairingToken: PAIRING, vision: new FixtureVision(),
    v2Router: () => createV2Router({ mobileDataDir: dataDir, followupProvider: followupStub, correctionProvider: correctionStub, coachProvider: coachStub }),
  });
  loopbackServices.push(app.locals.mobileRecognitionService);
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const auth = { authorization: `Bearer ${PAIRING}` };
  return { base, dataDir, auth, json: { ...auth, 'content-type': 'application/json' } };
}

const getJson = async (base: string, auth: { authorization: string }, path_: string) => fetch(`${base}${path_}`, { headers: auth });
const postJson = (base: string, headers: Record<string, string>, path_: string, body?: unknown) =>
  fetch(`${base}${path_}`, { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });

/** 轮询打印快照直到 ready/failed。 */
async function pollPrint(base: string, auth: { authorization: string }, packetId: string): Promise<PrintStatusBody> {
  for (let i = 0; i < 400; i += 1) {
    const body = (await (await getJson(base, auth, `/v2/practice/${packetId}/print`)).json()) as PrintStatusBody;
    if (body.status === 'ready' || body.status === 'failed') return body;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('打印快照准备超时');
}

describe('T5b 端到端串联：学生的一周', () => {
  it('按文档 §5 时序串完全部 /v2 接口', async () => {
    const { base, dataDir, auth, json } = await setupApp();

    // 0. 协议版本与鉴权：无令牌 401；health 返回 protocolVersion 2。
    expect((await fetch(`${base}/v2/health`)).status).toBe(401);
    const health = await getJson(base, auth, '/v2/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ protocolVersion: 2 });

    // 1–2.（对应文档 §2 前两步的 v1 上传/轮询由 v1 接口完成；这里直接构造终态任务目录。）
    const jobId = await makeJob(dataDir, [
      { tags: ['一元一次方程'] },                              // 题1：复盘 + 回传独立做对
      { tags: ['分式'], referenceAnswer: true },             // 题2：删/恢复 + 修改识别
      { tags: ['比例'], needsCheck: true, unlocatedNote: true }, // 题3：low 徽标 → 遮白裁图 + needsGlance
    ]);

    // 3. 登记照片。
    const registered = await postJson(base, auth, `/v2/photos/${jobId}/register`);
    expect(registered.status).toBe(200);
    const registeredBody = (await registered.json()) as { jobId: string; registeredAt: string };
    expect(registeredBody.jobId).toBe(jobId);
    expect(typeof registeredBody.registeredAt).toBe('string');
    // 重复登记幂等。
    expect(await (await postJson(base, auth, `/v2/photos/${jobId}/register`)).json()).toEqual(registeredBody);

    // 4. 本周错题卡片：懒桥接出 3 道题。
    const week = await getJson(base, auth, '/v2/week');
    expect(week.status).toBe(200);
    const weekBody = (await week.json()) as { week: string; photos: WeekPhoto[]; items: WeekItem[]; backlog: WeekItem[] };
    expect(weekBody.week).toBe(isoWeekKey(new Date()));
    expect(weekBody.photos).toHaveLength(1);
    expect(weekBody.photos[0]).toMatchObject({ jobId, registeredAt: registeredBody.registeredAt, recognition: 'done', bridged: true, bridgeError: null, itemCount: 3 });
    expect(weekBody.items).toHaveLength(3);
    expect(weekBody.backlog).toEqual([]);
    const [item1, item2, item3] = weekBody.items as [WeekItem, WeekItem, WeekItem];
    expect(item1).toMatchObject({
      shortId: expect.stringMatching(/^M-\d+$/), subject: '数学', knowledgeTags: ['一元一次方程'],
      badge: 'ok', status: 'ready_for_reflection', cropUrl: `/v2/items/${item1.id}/crop`, jobId,
    });
    expect(item1.questionExcerpt).toContain('求 x 的值');
    expect(item3.badge).toBe('low');

    // 整题裁图（cropUrl 带令牌可取）。
    const crop = await getJson(base, auth, item1.cropUrl);
    expect(crop.status).toBe(200);
    expect(crop.headers.get('content-type')).toContain('image/jpeg');
    expect(crop.headers.get('cache-control')).toContain('no-store');
    const cropBytes = Buffer.from(await crop.arrayBuffer());
    expect(cropBytes[0]).toBe(0xff);
    expect(cropBytes[1]).toBe(0xd8);

    // 删/恢复：题2"不是错题"→ 从 items 消失 → 恢复回来。
    const discarded = await postJson(base, auth, `/v2/items/${item2.id}/discard`);
    expect(discarded.status).toBe(200);
    expect(await discarded.json()).toEqual({ id: item2.id, status: 'archived_not_worth_review' });
    const weekAfterDiscard = (await (await getJson(base, auth, '/v2/week')).json()) as { items: WeekItem[] };
    expect(weekAfterDiscard.items.map(card => card.id)).toEqual([item1.id, item3.id]);
    const restored = await postJson(base, auth, `/v2/items/${item2.id}/restore`);
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual({ id: item2.id, status: 'ready_for_reflection' });

    // 5. 学生设置：默认值 → 更新。
    const settingsBefore = await getJson(base, auth, '/v2/settings');
    expect(await settingsBefore.json()).toEqual({ practiceSlot: '本周内', paperLocation: 'varies' });
    const settingsUpdated = await fetch(`${base}/v2/settings`, { method: 'PUT', headers: json, body: JSON.stringify({ practiceSlot: '周三晚自习', paperLocation: 'school' }) });
    expect(settingsUpdated.status).toBe(200);
    expect(await settingsUpdated.json()).toEqual({ practiceSlot: '周三晚自习', paperLocation: 'school' });
    const settingsBad = await fetch(`${base}/v2/settings`, { method: 'PUT', headers: json, body: JSON.stringify({ practiceSlot: '本周内', paperLocation: 'moon' }) });
    expect(settingsBad.status).toBe(400);
    expect(((await settingsBad.json()) as { error: { code: string; message: string } }).error)
      .toEqual({ code: 'invalid_request', message: 'paperLocation 只能是 school / home / varies。' });

    // 6. 本周推荐：3 道候选全部入选，附不足提示。
    const recommend = await getJson(base, auth, '/v2/practice/recommend');
    expect(recommend.status).toBe(200);
    const recommendBody = (await recommend.json()) as { recommended: PracticeCard[]; others: PracticeCard[]; notes: string[]; limits: { min: number; max: number } };
    expect(recommendBody.limits).toEqual({ min: 5, max: 8 });
    expect(recommendBody.recommended.map(card => card.id)).toEqual([item1.id, item2.id, item3.id]);
    expect(recommendBody.others).toEqual([]);
    expect(recommendBody.notes.some(note => note.includes('不足'))).toBe(true);
    expect(recommendBody.recommended[0]).toMatchObject({ tier: 4, reason: '本周新错题', reflected: false, badge: 'ok', status: 'ready_for_reflection' });

    // 7. 建练习（practiceSlot 缺省取设置）；详情与列表。
    const created = await postJson(base, json, '/v2/practice', { itemIds: [item1.id, item2.id, item3.id] });
    expect(created.status).toBe(200);
    const practice = (await created.json()) as PracticeDetail;
    expect(practice).toMatchObject({ week: isoWeekKey(new Date()), status: 'scheduled', practiceSlot: '周三晚自习', generatedAt: null });
    expect(typeof practice.createdAt).toBe('string');
    expect(practice.items.map(card => card.position)).toEqual([0, 1, 2]);
    expect(practice.items[0]).toMatchObject({ id: item1.id, tier: 4, reason: '本周新错题', reflected: false, status: 'scheduled', cropUrl: `/v2/items/${item1.id}/crop`, jobId });

    const detail = (await (await getJson(base, auth, `/v2/practice/${practice.id}`)).json()) as PracticeDetail;
    expect(detail).toMatchObject({ id: practice.id, status: 'scheduled', practiceSlot: '周三晚自习' });
    expect(detail.items).toHaveLength(3);
    const list = (await (await getJson(base, auth, '/v2/practice')).json()) as { packets: Array<{ id: string; week: string; status: string; practiceSlot: string; createdAt: string; generatedAt: string | null; itemCount: number }> };
    expect(list.packets).toHaveLength(1);
    expect(list.packets[0]).toMatchObject({ id: practice.id, week: isoWeekKey(new Date()), status: 'scheduled', practiceSlot: '周三晚自习', generatedAt: null, itemCount: 3 });

    // 8. 题1复盘：ask（幂等）→ answer 第 1 轮（出第二问）→ answer 第 2 轮 → 提交 → 回看。
    const ask1 = await postJson(base, auth, `/v2/items/${item1.id}/reflection/ask`);
    expect(ask1.status).toBe(200);
    const askBody = (await ask1.json()) as { turn: number; question: string; source: string };
    expect(askBody).toEqual({ turn: 1, question: AI_QUESTION, source: 'ai' });
    expect(await (await postJson(base, auth, `/v2/items/${item1.id}/reflection/ask`)).json()).toEqual(askBody);

    const answer1 = await postJson(base, json, `/v2/items/${item1.id}/reflection/answer`, { answer: '我以为移项不用变号，直接就抄过来了' });
    expect(answer1.status).toBe(200);
    expect(await answer1.json()).toEqual({
      turn: 1, summary: AI_SUMMARY, suggestedCause: '推理步骤', suggestedAttemptState: '方法基本正确但步骤出错', secondQuestion: AI_SECOND_QUESTION,
    });
    const answerBad = await postJson(base, json, `/v2/items/${item1.id}/reflection/answer`, { answer: '' });
    expect(answerBad.status).toBe(400);
    expect(((await answerBad.json()) as { error: { message: string } }).error.message).toBe('回答需要 1–300 字。');
    const answer2 = await postJson(base, json, `/v2/items/${item1.id}/reflection/answer`, { answer: '等号另一边我减了同一个数' });
    expect(answer2.status).toBe(200);
    expect(((await answer2.json()) as { turn: number; secondQuestion: string | null })).toMatchObject({ turn: 2, secondQuestion: null });

    const submitted = await postJson(base, json, `/v2/items/${item1.id}/reflection`, {
      attemptState: '方法基本正确但步骤出错', cause: '推理步骤', masteryFeeling: 3,
    });
    expect(submitted.status).toBe(200);
    const submittedBody = (await submitted.json()) as { id: string; attemptState: string; cause: string; masteryFeeling: number; summary: string | null; adoptedAi: boolean; source: string; createdAt: string; status: string };
    expect(submittedBody).toMatchObject({
      attemptState: '方法基本正确但步骤出错', cause: '推理步骤', masteryFeeling: 3,
      summary: AI_SUMMARY, adoptedAi: true, source: 'v2', status: 'scheduled',
    });
    expect(submittedBody.id).toMatch(/^dia_/);
    expect(typeof submittedBody.createdAt).toBe('string');
    const submitBad = await postJson(base, json, `/v2/items/${item1.id}/reflection`, { attemptState: '其他', cause: '计算', masteryFeeling: 4 });
    expect(submitBad.status).toBe(400);
    expect(((await submitBad.json()) as { error: { message: string } }).error.message).toBe('把握程度需要 0–3。');

    const reflection = (await (await getJson(base, auth, `/v2/items/${item1.id}/reflection`)).json()) as {
      turns: Array<{ turn: number; question: string; source: string; answer: string | null }>;
      suggestion: { summary: string; suggestedCause: string; suggestedAttemptState: string } | null;
      reflection: { id: string; attemptState: string; cause: string; masteryFeeling: number; summary: string | null; adoptedAi: boolean; source: string; createdAt: string } | null;
    };
    expect(reflection.turns).toEqual([
      { turn: 1, question: AI_QUESTION, source: 'ai', answer: '我以为移项不用变号，直接就抄过来了' },
      { turn: 2, question: AI_SECOND_QUESTION, source: 'ai', answer: '等号另一边我减了同一个数' },
    ]);
    expect(reflection.suggestion).toEqual({ summary: AI_SUMMARY, suggestedCause: '推理步骤', suggestedAttemptState: '方法基本正确但步骤出错' });
    expect(reflection.reflection).toMatchObject({ id: submittedBody.id, adoptedAi: true, masteryFeeling: 3, summary: AI_SUMMARY });

    // 9. 题2修改识别：evidence 视图 → 生成建议（幂等重放）→ 接受 → 重复接受 409。
    const evidenceView = (await (await getJson(base, auth, `/v2/items/${item2.id}/evidence`)).json()) as {
      questionText: string; subject: string; knowledgeTags: string[];
      observations: Array<{ id: string; kind: string; text: string }>; badge: string; revision: number;
    };
    expect(evidenceView).toMatchObject({ questionText: '已知 x+y=2，求 x 的值。', subject: '数学', knowledgeTags: ['分式'], badge: 'ok', revision: 1 });
    expect(evidenceView.observations).toContainEqual({ id: 'o1', kind: 'student_work', text: 'x=1' });
    expect(evidenceView.observations).toContainEqual({ id: 'o4', kind: 'reference_answer', text: 'x = (1-y)/2' });

    const proposeBody = { instruction: '题干最后识别错了', method: 'keyboard', revision: 1, clientRequestId: crypto.randomUUID() };
    const proposed = await postJson(base, json, `/v2/items/${item2.id}/correct`, proposeBody);
    expect(proposed.status).toBe(200);
    const proposedResult = (await proposed.json()) as { proposalId: string; revision: number; changes: Array<{ field: string; before: string; after: string; find?: string; replace?: string }>; clarify: string | null };
    expect(proposedResult.proposalId).toMatch(/^crp_/);
    expect(proposedResult.revision).toBe(1);
    expect(proposedResult.changes).toEqual([{ field: 'questionText', before: '已知 x+y=2，求 x 的值。', after: '已知 x+y=2，求 y 的值。', find: '求 x 的值', replace: '求 y 的值' }]);
    expect(proposedResult.clarify).toBeNull();
    // 同一 clientRequestId 重放返回同一建议。
    const replayed = (await (await postJson(base, json, `/v2/items/${item2.id}/correct`, proposeBody)).json()) as { proposalId: string };
    expect(replayed.proposalId).toBe(proposedResult.proposalId);

    const accepted = await postJson(base, json, `/v2/items/${item2.id}/correct/accept`, { proposalId: proposedResult.proposalId, revision: 1 });
    expect(accepted.status).toBe(200);
    const acceptedBody = (await accepted.json()) as { revision: number; card: WeekItem };
    expect(acceptedBody.revision).toBe(2);
    expect(acceptedBody.card).toMatchObject({ id: item2.id, badge: 'ok', status: 'scheduled', cropUrl: `/v2/items/${item2.id}/crop`, jobId });
    expect(acceptedBody.card.questionExcerpt).toContain('求 y 的值');
    // 重复接受 409（错误信封 code=conflict）。
    const acceptAgain = await postJson(base, json, `/v2/items/${item2.id}/correct/accept`, { proposalId: proposedResult.proposalId, revision: 1 });
    expect(acceptAgain.status).toBe(409);
    expect(((await acceptAgain.json()) as { error: { code: string; message: string } }).error)
      .toEqual({ code: 'conflict', message: '该建议已被接受。' });
    const evidenceAfter = (await (await getJson(base, auth, `/v2/items/${item2.id}/evidence`)).json()) as { questionText: string; revision: number };
    expect(evidenceAfter).toMatchObject({ questionText: '已知 x+y=2，求 y 的值。', revision: 2 });

    // 10. 打印快照：none → 202 preparing → 轮询 ready → 再 POST 幂等 200 → 取媒体。
    const printNone = (await (await getJson(base, auth, `/v2/practice/${practice.id}/print`)).json()) as PrintStatusBody;
    expect(printNone).toEqual({ status: 'none', progress: { done: 0, total: 3 } });
    const printRequested = await postJson(base, auth, `/v2/practice/${practice.id}/print`);
    expect(printRequested.status).toBe(202);
    expect(await printRequested.json()).toEqual({ status: 'preparing' });

    const printReady = await pollPrint(base, auth, practice.id);
    expect(printReady.status).toBe('ready');
    expect(printReady.progress).toEqual({ done: 3, total: 3 });
    const snapshot = printReady.snapshot!;
    expect(snapshot.packetId).toBe(practice.id);
    expect(snapshot.week).toBe(isoWeekKey(new Date()));
    expect(typeof snapshot.preparedAt).toBe('string');
    expect(snapshot.cover).toMatchObject({ title: '本周练习', practiceSlot: '' });
    expect(snapshot.cover.rules).toEqual(['不看答案，独立做', '卡住先看一级提示，再看二级', '做完打勾，写上做题日期']);
    expect(snapshot.cover.itemList).toHaveLength(3);
    expect(snapshot.cover.itemList[0]).toMatchObject({ shortId: item1.shortId, sourceLabel: '原题' });

    expect(snapshot.items.map(item => item.position)).toEqual([0, 1, 2]);
    const snap1 = snapshot.items[0]!;
    expect(snap1).toMatchObject({
      itemId: item1.id, shortId: item1.shortId, subject: '数学', knowledgeTags: ['一元一次方程'],
      mode: 'text', cropMedia: null, diagramMedia: [],
      keyStepPrompt: '这题的关键一步是：', needsGlance: false, glanceReason: null,
    });
    expect(snap1.stemText).toContain('求 x 的值');
    expect(snap1.checkboxes).toEqual(['独立做出', '看了一级提示', '看了二级提示', '没做出来']);
    // 题2印的是修改后的题干。
    expect(snapshot.items[1]!.stemText).toContain('求 y 的值');
    // 题3徽标 low → 遮白裁图 + 识别题干文字一起给（T5-R2）；无定位批注 → needsGlance。
    const snap3 = snapshot.items[2]!;
    expect(snap3).toMatchObject({
      itemId: item3.id, mode: 'crop', stemText: '已知 x+y=3，求 x 的值。', cropMedia: 'p2-crop.jpg',
      needsGlance: true, glanceReason: '这题的手写内容可能没有遮全，打印前请看一眼',
    });

    expect(snapshot.answerSheet).toHaveLength(3);
    expect(snapshot.answerSheet[0]).toMatchObject({
      shortId: item1.shortId, hint1: '一级提示：先移项', hint2: '二级提示：两边同时减 y',
      answer: { text: 'x = 1 - y', source: 'ai', label: 'AI 参考，未经老师核验' },
    });
    expect(snapshot.answerSheet[0]!.fallbackNote).toBe(FALLBACK_NOTE);
    // 题2有原卷参考答案 → paper 优先于 coach。
    expect(snapshot.answerSheet[1]!.answer).toEqual({ text: 'x = (1-y)/2', source: 'paper', label: '原卷参考答案' });

    // 再 POST 幂等返回同一份快照；练习状态已 generated。
    const printAgain = await postJson(base, auth, `/v2/practice/${practice.id}/print`);
    expect(printAgain.status).toBe(200);
    expect((await printAgain.json()) as PrintStatusBody).toMatchObject({ status: 'ready' });
    const afterPrint = (await (await getJson(base, auth, `/v2/practice/${practice.id}`)).json()) as PracticeDetail;
    expect(afterPrint.status).toBe('generated');
    expect(typeof afterPrint.generatedAt).toBe('string');

    // 取媒体：登记过的裁图可取；未登记名字 404。
    const media = await getJson(base, auth, `/v2/practice/${practice.id}/print/media/p2-crop.jpg`);
    expect(media.status).toBe(200);
    expect(media.headers.get('content-type')).toContain('image/jpeg');
    const mediaBytes = Buffer.from(await media.arrayBuffer());
    expect(mediaBytes[0]).toBe(0xff);
    expect(mediaBytes[1]).toBe(0xd8);
    expect((await getJson(base, auth, `/v2/practice/${practice.id}/print/media/p9-crop.jpg`)).status).toBe(404);

    // 11. 把 generated_at 调到 4 天前（延迟重做窗口），然后回传。
    const generatedAt = new Date(Date.now() - 4 * DAY_MS);
    getDb().prepare("UPDATE review_packet SET generated_at = ? WHERE id = ?").run(generatedAt.toISOString(), practice.id);
    const today = localDay(new Date());

    // 形状错误整体 400（不产生记录）。
    const returnBad = await postJson(base, json, `/v2/practice/${practice.id}/return`, {
      results: [{ itemId: item1.id, completion: 'independent', correct: true }],
    });
    expect(returnBad.status).toBe(400);
    expect(((await returnBad.json()) as { error: { code: string; message: string } }).error)
      .toEqual({ code: 'invalid_request', message: 'performedOn 必须是 YYYY-MM-DD 文本（纸上实际作答日期）。' });

    const returned = await postJson(base, json, `/v2/practice/${practice.id}/return`, {
      results: [
        { itemId: item1.id, completion: 'independent', correct: true, performedOn: today },
        { itemId: item2.id, completion: 'hint1', correct: true, performedOn: today, stuckStep: '第二步配方' },
        { itemId: item3.id, completion: 'not_solved', performedOn: today },
      ],
    });
    expect(returned.status).toBe(200);
    const returnResults = ((await returned.json()) as { results: ReturnItemResult[] }).results;
    const byItem = new Map(returnResults.map(result => [result.itemId, result]));
    expect(byItem.get(item1.id)).toMatchObject({ ok: true, toStatus: 'temporarily_mastered', reason: '延迟 3–7 天独立做对，进入暂时掌握' });
    expect(byItem.get(item2.id)).toMatchObject({ ok: true, toStatus: 'needs_recheck' });
    expect(byItem.get(item3.id)).toMatchObject({ ok: true, toStatus: 'needs_recheck' });
    // 重复回传同一题：HTTP 200，该条 ok:false。
    const returnedAgain = await postJson(base, json, `/v2/practice/${practice.id}/return`, {
      results: [{ itemId: item1.id, completion: 'independent', correct: true, performedOn: today }],
    });
    expect(returnedAgain.status).toBe(200);
    const againResult = ((await returnedAgain.json()) as { results: ReturnItemResult[] }).results[0]!;
    expect(againResult.ok).toBe(false);
    expect(againResult.error).toBeTruthy();

    // 12. 回报。
    const summaryResponse = await getJson(base, auth, `/v2/practice/${practice.id}/summary`);
    expect(summaryResponse.status).toBe(200);
    const summary = (await summaryResponse.json()) as ReturnSummary;
    expect(summary.answered).toBe(3);
    expect(summary.total).toBe(3);
    expect(summary.independentCorrect).toBe(1);
    expect(summary.masteredNow.map(card => card.id)).toEqual([item1.id]);
    expect(summary.masteredNow[0]).toMatchObject({ status: 'temporarily_mastered', cropUrl: `/v2/items/${item1.id}/crop`, jobId });
    expect(summary.again.map(card => card.id)).toEqual([item2.id, item3.id]);
    expect(summary.again.map(card => card.reason)).toEqual(['看了提示', '没做出来']);
    expect(summary.calibration).toMatchObject({ confidentTotal: 1, missedCount: 0, text: '你说有把握的 1 道里，0 道没独立做出来', items: [] });
    expect(summary.nextConfirmOn).toBe(localDay(new Date(Date.now() + 10 * DAY_MS)));
    expect(summary.nextConfirmOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // 13. 修正即测量报告：只出计数。
    const report = (await (await getJson(base, auth, '/v2/corrections/report')).json()) as {
      weeks: Array<{ week: string; itemCount: number; fields: Array<{ field: string; corrected: number; total: number; rate: number }>; notAMistake: { count: number; rate: number } }>;
    };
    expect(report.weeks).toHaveLength(1);
    const weekReport = report.weeks[0]!;
    expect(weekReport.week).toBe(isoWeekKey(new Date()));
    expect(weekReport.itemCount).toBe(3);
    const fieldOf = (field: string) => weekReport.fields.find(entry => entry.field === field)!;
    expect(weekReport.fields.map(entry => entry.field)).toEqual(['questionText', 'student_work', 'correction', 'teacher_note', 'reference_answer', 'subject', 'knowledgeTags']);
    expect(fieldOf('questionText')).toMatchObject({ corrected: 1, total: 3 });
    expect(fieldOf('questionText').rate).toBeCloseTo(1 / 3);
    expect(fieldOf('student_work')).toMatchObject({ corrected: 0, total: 3 });
    expect(fieldOf('reference_answer')).toMatchObject({ corrected: 0, total: 1 });
    expect(fieldOf('teacher_note')).toMatchObject({ corrected: 0, total: 1 });
    expect(weekReport.notAMistake).toEqual({ count: 0, rate: 0 });
  });
});
