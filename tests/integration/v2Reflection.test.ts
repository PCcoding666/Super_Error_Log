/**
 * T4c：AI 追问与复盘（/v2/items/:id/reflection[/ask|/answer]）。
 * 真实 HTTP（回环装配，共享令牌鉴权）+ 合成识别任务 + 合成模型 HTTP 服务器（统计调用次数）。
 * 不调用真实模型、不读 .env 与 data/。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Evidence } from '../../src/ai/evidence.js';
import { ChatClient } from '../../src/ai/chatClient.js';
import { StagedProvider } from '../../src/ai/stagedProvider.js';
import { getDb, now } from '../../src/db/connection.js';
import { isoWeekKey } from '../../src/domain/scheduling.js';
import { ensureStudentProfile } from '../../src/services/studentService.js';
import { submitReflection } from '../../src/services/itemService.js';
import { parentAggregate } from '../../src/services/trendService.js';
import { createMobileApp } from '../../src/mobile/router.js';
import { MobileRecognitionStore } from '../../src/mobile/store.js';
import type { RecognitionQuestion, RecognitionVerification } from '../../src/mobile/contracts.js';
import type { MobileVisionBoundary, VisionContext, VisionInventoryResult, VisionQuestionResult, InventoryCandidate } from '../../src/mobile/vision.js';
import type { MobileRecognitionService } from '../../src/mobile/service.js';
import { createV2Router } from '../../src/v2/router.js';

const PAIRING = 't4c-shared-token-0123456789';
const FALLBACK_QUESTION = '这题你当时卡在哪一步？';
const STUDENT_ANSWER_1 = '我以为移项不用变号，直接就抄过来了';
const STUDENT_ANSWER_2 = '另一边我也加了同一个数';
const AI_SUMMARY_TEXT = '把移项当成了照抄，漏了变号';
const REWRITTEN_SUMMARY = '我把移项当成不变号直接抄，漏了符号变化';

// ---------- 合成模型服务器：按 model 与负载（ask 无 turns / summarize 有 turns）返回固定响应 ----------
const modelRequests: Array<Record<string, unknown>> = [];
let modelServer: Server;
let modelBaseUrl = '';

function askPayload(body: Record<string, unknown>): Record<string, unknown> {
  const messages = body.messages as Array<{ content: Array<{ type: string; text: string }> }>;
  return JSON.parse(messages.at(-1)!.content[0]!.text) as Record<string, unknown>;
}

function okContent(model: string, body: Record<string, unknown>): string {
  const payload = askPayload(body);
  const turns = payload.turns as Array<unknown> | undefined;
  if (model === 'fu-bad-json') return '{oops';
  if (turns === undefined) {
    // followupAsk
    if (model === 'fu-long-question') return JSON.stringify({ question: `你${'当时到底是怎么想的'.repeat(8)}？`, referencedObservationIds: ['o1'] });
    if (model === 'fu-empty-refs') return JSON.stringify({ question: '你当时是怎么想的？', referencedObservationIds: [] });
    if (model === 'fu-teacher-refs') return JSON.stringify({ question: '你原来写 x=1，这一步当时是怎么想的？', referencedObservationIds: ['o2'] });
    if (model === 'fu-correction-refs') return JSON.stringify({ question: '你在订正里写 x=2，这一步是怎么得到的？', referencedObservationIds: ['o3'] });
    return JSON.stringify({ question: '你原来写 x=1，这一步当时是怎么想的？', referencedObservationIds: ['o1'] });
  }
  // followupSummarize
  if (model === 'fu-bad-cause') {
    return JSON.stringify({ summary: AI_SUMMARY_TEXT, suggestedCause: '不存在的错因', suggestedAttemptState: '其他', secondQuestion: null });
  }
  return JSON.stringify({
    summary: AI_SUMMARY_TEXT,
    suggestedCause: '推理步骤',
    suggestedAttemptState: '方法基本正确但步骤出错',
    secondQuestion: turns.length === 1 ? '你说移项，那等号另一边你是怎么处理的？' : null,
  });
}

beforeAll(async () => {
  ensureStudentProfile();
  modelServer = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text) as Record<string, unknown>;
    modelRequests.push(body);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      model: body.model,
      choices: [{ finish_reason: 'stop', message: { content: okContent(String(body.model), body) } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }));
  });
  await new Promise<void>(resolve => modelServer.listen(0, '127.0.0.1', resolve));
  modelBaseUrl = `http://127.0.0.1:${(modelServer.address() as { port: number }).port}/v1`;
});

afterAll(() => { modelServer.close(); });

const roots: string[] = [];
const servers: Server[] = [];
const loopbackServices: MobileRecognitionService[] = [];
afterEach(async () => {
  await Promise.all(loopbackServices.splice(0).map(service => service.stop()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});

beforeEach(() => {
  modelRequests.length = 0;
  const database = getDb();
  for (const table of ['v2_reflection_turn', 'review_attempt', 'review_packet_item', 'review_packet', 'mobile_item_link', 'evidence_record', 'error_diagnosis', 'error_item', 'asset_origin', 'source_asset', 'source_batch', 'v2_photo', 'v2_setting']) {
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

function evidence(number: string, withStudentWork: boolean, withTeacherNote = false, withCorrection = false): Evidence {
  return {
    version: 1, questionNumber: number, questionText: `已知 x+y=${number}，求 x 的值。`, subject: '数学', chapter: '方程',
    knowledgeTags: [`知识点${number}`], questionType: '计算',
    questionRegion: { x: .1, y: .1, width: .8, height: .8 }, requiresDiagram: false,
    regions: [
      ...(withStudentWork ? [{ id: 's1', kind: 'student_work' as const, box: { x: .2, y: .2, width: .2, height: .2 }, confidence: .9, cleanForPrint: false }] : []),
      ...(withTeacherNote ? [{ id: 's2', kind: 'teacher_note' as const, box: { x: .5, y: .2, width: .2, height: .2 }, confidence: .9, cleanForPrint: false }] : []),
      ...(withCorrection ? [{ id: 's3', kind: 'correction' as const, box: { x: .5, y: .5, width: .2, height: .2 }, confidence: .9, cleanForPrint: false }] : []),
    ],
    observations: [
      ...(withStudentWork ? [{ id: 'o1', kind: 'student_work' as const, text: 'x=1', regionId: 's1', confidence: .9 }] : []),
      ...(withTeacherNote ? [{ id: 'o2', kind: 'teacher_note' as const, text: '移项要变号', regionId: 's2', confidence: .9 }] : []),
      ...(withCorrection ? [{ id: 'o3', kind: 'correction' as const, text: '订正：x=2', regionId: 's3', confidence: .9 }] : []),
    ],
    uncertainties: [],
  };
}

let seq = 0;
function question(partial: Partial<RecognitionQuestion> & { number?: string; withStudentWork?: boolean; withTeacherNote?: boolean; withCorrection?: boolean } = {}): RecognitionQuestion {
  seq += 1;
  const number = partial.number ?? String(seq);
  const { withStudentWork, withTeacherNote, withCorrection, ...rest } = partial;
  return {
    id: crypto.randomUUID(), number, revision: 1, status: 'ready', selectionEvidence: 'marked_wrong',
    evidence: evidence(number, withStudentWork ?? true, withTeacherNote ?? false, withCorrection ?? false), verification: { ...CHECKS }, questionMediaId: null, diagramMediaIds: [],
    error: null, confirmedAt: null, ...rest,
  };
}

async function tempDir(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-t4c-reflection-'));
  roots.push(dir);
  return dir;
}

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

function followupProvider(model: string): StagedProvider {
  return new StagedProvider(new ChatClient({ baseUrl: modelBaseUrl, apiKey: 'synthetic-test-key', models: { followup: model }, timeoutMs: 2000, bailianOnly: false }));
}

async function setupApp(model = 'fu-ok'): Promise<{ base: string; dataDir: string; auth: { authorization: string } }> {
  const dataDir = await tempDir();
  const app = await createMobileApp({
    dataDir, pairingToken: PAIRING, vision: new FixtureVision(),
    v2Router: () => createV2Router({ mobileDataDir: dataDir, followupProvider: followupProvider(model) }),
  });
  loopbackServices.push(app.locals.mobileRecognitionService);
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, dataDir, auth: { authorization: `Bearer ${PAIRING}` } };
}

interface WeekItem { id: string; jobId: string; status: string }

/** 造一道题（一道 job），登记并桥接，返回卡片。 */
async function bridgeItem(base: string, auth: { authorization: string }, dataDir: string, withStudentWork = true, withTeacherNote = false, withCorrection = false): Promise<WeekItem> {
  const jobId = await makeJob(dataDir, [question({ withStudentWork, withTeacherNote, withCorrection })]);
  const registered = await fetch(`${base}/v2/photos/${jobId}/register`, { method: 'POST', headers: auth });
  expect(registered.status).toBe(200);
  const week = (await (await fetch(`${base}/v2/week`, { headers: auth })).json()) as { items: WeekItem[] };
  const item = week.items.find(card => card.jobId === jobId);
  expect(item).toBeDefined();
  return item!;
}

const ask = (base: string, auth: { authorization: string }, id: string) =>
  fetch(`${base}/v2/items/${id}/reflection/ask`, { method: 'POST', headers: auth });
const answer = (base: string, auth: { authorization: string }, id: string, body: unknown) =>
  fetch(`${base}/v2/items/${id}/reflection/answer`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const submit = (base: string, auth: { authorization: string }, id: string, body: unknown) =>
  fetch(`${base}/v2/items/${id}/reflection`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const getReflection = (base: string, auth: { authorization: string }, id: string) =>
  fetch(`${base}/v2/items/${id}/reflection`, { headers: auth });

interface AskResponse { turn: number; question: string; source: 'ai' | 'fallback' }
interface AnswerResponse { turn: number; summary: string | null; suggestedCause: string | null; suggestedAttemptState: string | null; secondQuestion: string | null }
interface ReflectionState {
  turns: Array<{ turn: number; question: string; source: string; answer: string | null }>;
  suggestion: { summary: string; suggestedCause: string; suggestedAttemptState: string } | null;
  reflection: { attemptState: string; cause: string; masteryFeeling: number; summary: string | null; adoptedAi: boolean } | null;
}

/** 直接造一道 Web 来源题（无 mobile_item_link）。 */
function makeWebItem(id: string, status: string): void {
  const student = ensureStudentProfile();
  const db = getDb();
  db.prepare("INSERT INTO source_batch (id, student_id, status, total_files, done_files, created_at) VALUES (?, ?, 'done', 1, 1, ?)").run(`bat_${id}`, student.id, now());
  db.prepare("INSERT INTO source_asset (id, batch_id, filename, mime, size, content_hash, status, storage_path, created_at) VALUES (?, ?, 'w.jpg', 'image/jpeg', 1, ?, 'done', '/nowhere.jpg', ?)").run(`ast_${id}`, `bat_${id}`, `hash-${id}`, now());
  db.prepare("INSERT INTO error_item (id, student_id, batch_id, asset_id, item_index, status, knowledge_tags, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, '[]', ?, ?)").run(id, student.id, `bat_${id}`, `ast_${id}`, status, now(), now());
}

describe('T4c AI 追问与复盘', () => {
  it('RED1 有学生作答：ask 调模型一次且问题引用作答原文；再次 ask 幂等不再调用', async () => {
    const { base, dataDir, auth } = await setupApp();
    const item = await bridgeItem(base, auth, dataDir, true);

    const first = await ask(base, auth, item.id);
    expect(first.status).toBe(200);
    const a1 = (await first.json()) as AskResponse;
    expect(a1).toMatchObject({ turn: 1, source: 'ai' });
    expect(a1.question).toContain('x=1');
    expect(modelRequests).toHaveLength(1);

    const second = await ask(base, auth, item.id);
    expect(second.status).toBe(200);
    expect((await second.json()) as AskResponse).toEqual(a1);
    expect(modelRequests).toHaveLength(1);
  });

  it('RED2 无学生作答：ask 返回固定开放句、source=fallback，模型调用 0 次', async () => {
    const { base, dataDir, auth } = await setupApp();
    const item = await bridgeItem(base, auth, dataDir, false);

    const response = await ask(base, auth, item.id);
    expect(response.status).toBe(200);
    expect((await response.json()) as AskResponse).toEqual({ turn: 1, question: FALLBACK_QUESTION, source: 'fallback' });
    expect(modelRequests).toHaveLength(0);
  });

  it('RED3 两轮追问：secondQuestion 进入第 2 轮；第 2 轮后不再追问；第 3 次 answer 409；单题模型调用 ≤3', async () => {
    const { base, dataDir, auth } = await setupApp();
    const item = await bridgeItem(base, auth, dataDir, true);

    await ask(base, auth, item.id);
    const r1 = await answer(base, auth, item.id, { answer: STUDENT_ANSWER_1 });
    expect(r1.status).toBe(200);
    const a1 = (await r1.json()) as AnswerResponse;
    expect(a1).toMatchObject({
      turn: 1, summary: AI_SUMMARY_TEXT,
      suggestedCause: '推理步骤', suggestedAttemptState: '方法基本正确但步骤出错',
    });
    expect(a1.secondQuestion).toBeTruthy();
    expect(modelRequests).toHaveLength(2);

    // 第 2 轮问题已就位（GET 可见），回答它。
    const state = (await (await getReflection(base, auth, item.id)).json()) as ReflectionState;
    expect(state.turns).toHaveLength(2);
    expect(state.turns[1]).toMatchObject({ turn: 2, question: a1.secondQuestion, answer: null });
    expect(state.suggestion).toMatchObject({ summary: AI_SUMMARY_TEXT, suggestedCause: '推理步骤' });

    const r2 = await answer(base, auth, item.id, { answer: STUDENT_ANSWER_2 });
    expect(r2.status).toBe(200);
    const a2 = (await r2.json()) as AnswerResponse;
    expect(a2.turn).toBe(2);
    expect(a2.secondQuestion).toBeNull();
    expect(modelRequests).toHaveLength(3);

    // 没有第 3 轮。
    const r3 = await answer(base, auth, item.id, { answer: '还有吗' });
    expect(r3.status).toBe(409);
    expect(modelRequests.length).toBeLessThanOrEqual(3);
  });

  it('RED4 模型输出非法：提问退回固定句、归纳返回 summary=null，且都不重试', async () => {
    // 4a 超长问题 → fallback，调用 1 次不重试。
    {
      const { base, dataDir, auth } = await setupApp('fu-long-question');
      const item = await bridgeItem(base, auth, dataDir, true);
      const response = await ask(base, auth, item.id);
      expect(response.status).toBe(200);
      expect((await response.json()) as AskResponse).toEqual({ turn: 1, question: FALLBACK_QUESTION, source: 'fallback' });
      expect(modelRequests).toHaveLength(1);
    }
    // 4b 非法 JSON → fallback，调用 1 次不重试。
    {
      modelRequests.length = 0;
      const { base, dataDir, auth } = await setupApp('fu-bad-json');
      const item = await bridgeItem(base, auth, dataDir, true);
      const response = await ask(base, auth, item.id);
      expect((await response.json()) as AskResponse).toMatchObject({ question: FALLBACK_QUESTION, source: 'fallback' });
      expect(modelRequests).toHaveLength(1);
    }
    // 4c 枚举外错因 → summary=null、建议为空，不产生第 2 轮，不重试。
    {
      modelRequests.length = 0;
      const { base, dataDir, auth } = await setupApp('fu-bad-cause');
      const item = await bridgeItem(base, auth, dataDir, true);
      await ask(base, auth, item.id);
      const r = await answer(base, auth, item.id, { answer: STUDENT_ANSWER_1 });
      expect(r.status).toBe(200);
      expect((await r.json()) as AnswerResponse).toEqual({
        turn: 1, summary: null, suggestedCause: null, suggestedAttemptState: null, secondQuestion: null,
      });
      expect(modelRequests).toHaveLength(2);
      const state = (await (await getReflection(base, auth, item.id)).json()) as ReflectionState;
      expect(state.turns).toHaveLength(1);
      expect(state.suggestion).toBeNull();
    }
  });

  it('RED5 最终提交：状态流转、adopted_ai 判定、参数校验、非 v2 题 404', async () => {
    const { base, dataDir, auth } = await setupApp();
    const item = await bridgeItem(base, auth, dataDir, true);
    await ask(base, auth, item.id);
    await answer(base, auth, item.id, { answer: STUDENT_ANSWER_1 });

    // 与 AI 建议一致 → adopted_ai=1；ready_for_reflection → eligible_for_review。
    const s1 = await submit(base, auth, item.id, { attemptState: '方法基本正确但步骤出错', cause: '推理步骤', masteryFeeling: 2, summary: AI_SUMMARY_TEXT });
    expect(s1.status).toBe(200);
    const r1 = (await s1.json()) as { adoptedAi: boolean; status: string };
    expect(r1).toMatchObject({ adoptedAi: true, status: 'eligible_for_review' });
    const db = getDb();
    const row = db.prepare('SELECT * FROM error_diagnosis WHERE item_id = ? ORDER BY created_at DESC LIMIT 1').get(item.id) as
      { submitted_by: string; review_value: string; adopted_ai: number; source: string; student_words: string | null; ai_summary: string | null };
    expect(row).toMatchObject({ submitted_by: 'student', review_value: '必须再做', adopted_ai: 1, source: 'v2' });
    expect(row.student_words).toContain(STUDENT_ANSWER_1);
    expect(row.ai_summary).toBe(AI_SUMMARY_TEXT);
    expect(db.prepare('SELECT status FROM error_item WHERE id = ?').get(item.id)).toEqual({ status: 'eligible_for_review' });

    // 已复盘可再次提交（覆盖为新记录，保留旧记录）：改了错因 → adopted_ai=0。
    const s2 = await submit(base, auth, item.id, { attemptState: '其他', cause: '计算', masteryFeeling: 1 });
    expect(s2.status).toBe(200);
    expect(((await s2.json()) as { adoptedAi: boolean }).adoptedAi).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM error_diagnosis WHERE item_id = ?').get(item.id)).toEqual({ n: 2 });

    // 参数校验：masteryFeeling 缺失/越界、cause 枚举外 → 400。
    expect((await submit(base, auth, item.id, { attemptState: '其他', cause: '计算' })).status).toBe(400);
    expect((await submit(base, auth, item.id, { attemptState: '其他', cause: '计算', masteryFeeling: 5 })).status).toBe(400);
    expect((await submit(base, auth, item.id, { attemptState: '其他', cause: '不存在的错因', masteryFeeling: 1 })).status).toBe(400);

    // 已在练习包里的 scheduled 题：可提交，状态不变。
    const scheduled = await bridgeItem(base, auth, dataDir, true);
    const student = ensureStudentProfile();
    db.prepare("INSERT INTO review_packet (id, student_id, week, status, created_at) VALUES ('pkt_t4c', ?, ?, 'scheduled', ?)").run(student.id, isoWeekKey(new Date()), now());
    db.prepare("INSERT INTO review_packet_item (packet_id, item_id, position) VALUES ('pkt_t4c', ?, 0)").run(scheduled.id);
    db.prepare("UPDATE error_item SET status = 'scheduled', updated_at = ? WHERE id = ?").run(now(), scheduled.id);
    const s3 = await submit(base, auth, scheduled.id, { attemptState: '其他', cause: '计算', masteryFeeling: 0 });
    expect(s3.status).toBe(200);
    expect(db.prepare('SELECT status FROM error_item WHERE id = ?').get(scheduled.id)).toEqual({ status: 'scheduled' });

    // 非 v2 题：四个接口一律 404。
    makeWebItem('itm_web_t4c', 'ready_for_reflection');
    expect((await ask(base, auth, 'itm_web_t4c')).status).toBe(404);
    expect((await answer(base, auth, 'itm_web_t4c', { answer: 'x' })).status).toBe(404);
    expect((await submit(base, auth, 'itm_web_t4c', { attemptState: '其他', cause: '计算', masteryFeeling: 1 })).status).toBe(404);
    expect((await getReflection(base, auth, 'itm_web_t4c')).status).toBe(404);
  });

  it('RED6 Web 的 submitReflection 对 v2 题行为不变：仍被「须人工核对」拦住', async () => {
    const { base, dataDir, auth } = await setupApp();
    const item = await bridgeItem(base, auth, dataDir, true);
    const result = submitReflection(item.id, {
      attemptState: '其他', cause: '计算', masteryFeeling: 2, reviewValue: '必须再做',
    }, 'student');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('校对');
  });

  it('RED7 家长聚合不包含学生原话、AI 归纳与学生确认归纳', async () => {
    const { base, dataDir, auth } = await setupApp();
    const item = await bridgeItem(base, auth, dataDir, true);
    await ask(base, auth, item.id);
    await answer(base, auth, item.id, { answer: STUDENT_ANSWER_1 });
    await submit(base, auth, item.id, { attemptState: '方法基本正确但步骤出错', cause: '推理步骤', masteryFeeling: 2, summary: REWRITTEN_SUMMARY });

    const student = ensureStudentProfile();
    const aggregate = JSON.stringify(parentAggregate(student.id));
    expect(aggregate).not.toContain(STUDENT_ANSWER_1);
    expect(aggregate).not.toContain(AI_SUMMARY_TEXT);
    expect(aggregate).not.toContain(REWRITTEN_SUMMARY);
  });

  it('R1-F1 追问必须引用学生作答/订正：空数组或只引教师批注都退回固定句，调用 1 次不重试', async () => {
    // 空 referencedObservationIds → fallback。
    {
      const { base, dataDir, auth } = await setupApp('fu-empty-refs');
      const item = await bridgeItem(base, auth, dataDir, true);
      const response = await ask(base, auth, item.id);
      expect(response.status).toBe(200);
      expect((await response.json()) as AskResponse).toEqual({ turn: 1, question: FALLBACK_QUESTION, source: 'fallback' });
      expect(modelRequests).toHaveLength(1);
    }
    // 只引用 teacher_note（非学生写的内容）→ fallback。
    {
      modelRequests.length = 0;
      const { base, dataDir, auth } = await setupApp('fu-teacher-refs');
      const item = await bridgeItem(base, auth, dataDir, true, true);
      const response = await ask(base, auth, item.id);
      expect(response.status).toBe(200);
      expect((await response.json()) as AskResponse).toEqual({ turn: 1, question: FALLBACK_QUESTION, source: 'fallback' });
      expect(modelRequests).toHaveLength(1);
    }
  });

  it('R1-F2 学生改写归纳后提交：GET 返回改写版，ai_summary 仍是 AI 原文', async () => {
    const { base, dataDir, auth } = await setupApp();
    const item = await bridgeItem(base, auth, dataDir, true);
    await ask(base, auth, item.id);
    await answer(base, auth, item.id, { answer: STUDENT_ANSWER_1 });

    const s = await submit(base, auth, item.id, {
      attemptState: '方法基本正确但步骤出错', cause: '推理步骤', masteryFeeling: 2, summary: REWRITTEN_SUMMARY,
    });
    expect(s.status).toBe(200);
    expect(((await s.json()) as { summary: string }).summary).toBe(REWRITTEN_SUMMARY);

    const state = (await (await getReflection(base, auth, item.id)).json()) as ReflectionState;
    expect(state.reflection?.summary).toBe(REWRITTEN_SUMMARY);

    const row = getDb().prepare('SELECT ai_summary, confirmed_summary FROM error_diagnosis WHERE item_id = ? ORDER BY created_at DESC LIMIT 1').get(item.id) as
      { ai_summary: string | null; confirmed_summary: string | null };
    expect(row.ai_summary).toBe(AI_SUMMARY_TEXT);
    expect(row.confirmed_summary).toBe(REWRITTEN_SUMMARY);
  });

  it('R1-F2b 未提交 summary 时 confirmed_summary 落 AI 归纳；无归纳时为 null', async () => {
    const { base, dataDir, auth } = await setupApp();
    const withAi = await bridgeItem(base, auth, dataDir, true);
    await ask(base, auth, withAi.id);
    await answer(base, auth, withAi.id, { answer: STUDENT_ANSWER_1 });
    const s1 = await submit(base, auth, withAi.id, { attemptState: '方法基本正确但步骤出错', cause: '推理步骤', masteryFeeling: 2 });
    expect(s1.status).toBe(200);
    const state = (await (await getReflection(base, auth, withAi.id)).json()) as ReflectionState;
    expect(state.reflection?.summary).toBe(AI_SUMMARY_TEXT);

    // 从未追问（无 AI 归纳）直接提交：summary 为 null。
    const noAi = await bridgeItem(base, auth, dataDir, true);
    const s2 = await submit(base, auth, noAi.id, { attemptState: '其他', cause: '计算', masteryFeeling: 1 });
    expect(s2.status).toBe(200);
    const state2 = (await (await getReflection(base, auth, noAi.id)).json()) as ReflectionState;
    expect(state2.reflection?.summary).toBeNull();
  });

  it('T5R2-F3 有学生原作时模型只引订正 → 退回固定句（1 次调用不重试）；追问提示词要求针对原作最先出错步的开放问句', async () => {
    const { base, dataDir, auth } = await setupApp('fu-correction-refs');
    const item = await bridgeItem(base, auth, dataDir, true, false, true);
    const response = await ask(base, auth, item.id);
    expect(response.status).toBe(200);
    expect((await response.json()) as AskResponse).toEqual({ turn: 1, question: FALLBACK_QUESTION, source: 'fallback' });
    expect(modelRequests).toHaveLength(1);
    // 提示词：有原作必须针对原作里最先出错的那一步；用开放问句；不出现正确做法/错因判断。
    const system = (modelRequests[0]!.messages as Array<{ role: string; content: string }>)[0]!.content;
    expect(system).toContain('最先出错');
    expect(system).toContain('开放问句');
  });

  it('T5R2-F3b 归纳提示词：secondQuestion 同样要求开放问句、问当时怎么想的', async () => {
    const { base, dataDir, auth } = await setupApp();
    const item = await bridgeItem(base, auth, dataDir, true);
    await ask(base, auth, item.id);
    await answer(base, auth, item.id, { answer: STUDENT_ANSWER_1 });
    // 第 2 次模型调用是 followupSummarize。
    const system = (modelRequests[1]!.messages as Array<{ role: string; content: string }>)[0]!.content;
    expect(system).toContain('开放问句');
  });

  it('RED8 新接口无令牌 401', async () => {
    const { base } = await setupApp();
    const calls: Array<[string, string, string?]> = [
      ['POST', '/v2/items/itm_x/reflection/ask'],
      ['POST', '/v2/items/itm_x/reflection/answer', '{"answer":"x"}'],
      ['POST', '/v2/items/itm_x/reflection', '{}'],
      ['GET', '/v2/items/itm_x/reflection'],
    ];
    for (const [method, path, body] of calls) {
      const response = await fetch(`${base}${path}`, {
        method, headers: body ? { 'content-type': 'application/json' } : undefined, body,
      });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });
});
