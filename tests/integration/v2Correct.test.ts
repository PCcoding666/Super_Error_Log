/**
 * T4e：修改识别结果（"不对，改一下"）与修改记录。
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
import { eventsLogPath } from '../../src/config.js';
import { getDb, now } from '../../src/db/connection.js';
import { isoWeekKey } from '../../src/domain/scheduling.js';
import { ensureStudentProfile } from '../../src/services/studentService.js';
import { createMobileApp } from '../../src/mobile/router.js';
import { MobileRecognitionStore } from '../../src/mobile/store.js';
import type { RecognitionQuestion, RecognitionVerification } from '../../src/mobile/contracts.js';
import type { MobileVisionBoundary, VisionContext, VisionInventoryResult, VisionQuestionResult, InventoryCandidate } from '../../src/mobile/vision.js';
import type { MobileRecognitionService } from '../../src/mobile/service.js';
import { createV2Router } from '../../src/v2/router.js';

const PAIRING = 't4e-shared-token-0123456789';
const INSTRUCTION_MARK = 'T4E指令标记-题干识别多了一个字';
const BIG_REWRITE = 'x=(1-y)/2，先移项再合并同类项，这是完全正确的解答过程';
const BAD_PROPOSE_MESSAGE = '这次没生成出可用的修改，请换个说法或用键盘直接改';

// ---------- 合成模型服务器：correct 阶段按 model 名返回固定响应 ----------
const modelRequests: Array<Record<string, unknown>> = [];
let modelServer: Server;
let modelBaseUrl = '';

interface CurrentView {
  questionText: string; subject: string; knowledgeTags: string[];
  observations: Array<{ id: string; kind: string; text: string }>;
}

function askPayload(body: Record<string, unknown>): { instruction: string; current: CurrentView } {
  const messages = body.messages as Array<{ content: Array<{ type: string; text: string }> }>;
  return JSON.parse(messages.at(-1)!.content[0]!.text) as { instruction: string; current: CurrentView };
}

function correctContent(model: string, body: Record<string, unknown>): string {
  const { current } = askPayload(body);
  const studentWork = current.observations.find(o => o.kind === 'student_work');
  const workText = studentWork?.text ?? 'x=1';
  if (model === 'cor-bad-json') return '{oops';
  if (model === 'cor-bad-field') return JSON.stringify({ changes: [{ field: 'questionRegion', before: 'a', after: 'b' }], clarify: null });
  if (model === 'cor-empty-no-clarify') return JSON.stringify({ changes: [], clarify: null });
  if (model === 'cor-clarify') return JSON.stringify({ changes: [], clarify: '请问要改题干还是作答？' });
  // T5R2-F4：超长 clarify（100 字）应被截断到 80 字而不是判失败。
  if (model === 'cor-clarify-long') return JSON.stringify({ changes: [], clarify: '您'.repeat(100) });
  // F1：文字类字段（questionText/observation）模型只给 find/replace 片段。
  if (model === 'cor-fragment') return JSON.stringify({ changes: [{ field: 'questionText', find: '减三', replace: '加三' }], clarify: null });
  if (model === 'cor-fragment-dup') return JSON.stringify({ changes: [{ field: 'questionText', find: 'abc', replace: '甲' }], clarify: null });
  if (model === 'cor-fragment-missing') return JSON.stringify({ changes: [{ field: 'questionText', find: '不存在的片段', replace: '甲' }], clarify: null });
  if (model === 'cor-mismatch') return JSON.stringify({
    changes: [
      { field: 'questionText', find: '。', replace: '。（改）' },
      { field: 'observation', observationId: 'o1', find: '纸上根本没有的片段', replace: 'x=2' },
    ],
    clarify: null,
  });
  if (model === 'cor-rewrite') return JSON.stringify({
    changes: [{ field: 'observation', observationId: 'o1', find: workText, replace: BIG_REWRITE }],
    clarify: null,
  });
  if (model === 'cor-smallfix') return JSON.stringify({
    changes: [{ field: 'observation', observationId: 'o1', find: '1', replace: '2' }],
    clarify: null,
  });
  return JSON.stringify({
    changes: [{ field: 'questionText', find: '。', replace: '。（改）' }],
    clarify: null,
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
      choices: [{ finish_reason: 'stop', message: { content: correctContent(String(body.model), body) } }],
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
  for (const table of ['correction', 'correction_proposal', 'v2_reflection_turn', 'review_attempt', 'review_packet_item', 'review_packet', 'mobile_item_link', 'evidence_record', 'error_diagnosis', 'error_item', 'asset_origin', 'source_asset', 'source_batch', 'v2_photo', 'v2_setting']) {
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

function evidence(number: string): Evidence {
  return {
    version: 1, questionNumber: number, questionText: `已知 x+y=${number}，求 x 的值。`, subject: '数学', chapter: '方程',
    knowledgeTags: [`知识点${number}`], questionType: '计算',
    questionRegion: { x: .1, y: .1, width: .8, height: .8 }, requiresDiagram: false,
    regions: [{ id: 's1', kind: 'student_work', box: { x: .2, y: .2, width: .2, height: .2 }, confidence: .9, cleanForPrint: false }],
    observations: [{ id: 'o1', kind: 'student_work', text: 'x=1', regionId: 's1', confidence: .9 }],
    uncertainties: [],
  };
}

/** F1：300 字题干；'减三' 恰好出现一次，'abc' 出现多次。 */
const LONG_TEXT = `${'abcdefghij'.repeat(14)}abcdefghi减三${'abcdefghij'.repeat(14)}abcdefghi`;
function longEvidence(): Evidence {
  return { ...evidence('L'), questionText: LONG_TEXT };
}

let seq = 0;
function question(partial: Partial<RecognitionQuestion> & { number?: string } = {}): RecognitionQuestion {
  seq += 1;
  const number = partial.number ?? String(seq);
  const { number: _n, ...rest } = partial;
  return {
    id: crypto.randomUUID(), number, revision: 1, status: 'ready', selectionEvidence: 'marked_wrong',
    evidence: evidence(number), verification: { ...CHECKS }, questionMediaId: null, diagramMediaIds: [],
    error: null, confirmedAt: null, ...rest,
  };
}

async function tempDir(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-t4e-correct-'));
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

function correctionProvider(model: string): StagedProvider {
  return new StagedProvider(new ChatClient({ baseUrl: modelBaseUrl, apiKey: 'synthetic-test-key', models: { correct: model }, timeoutMs: 2000, bailianOnly: false }));
}

async function setupApp(model = 'cor-ok'): Promise<{ base: string; dataDir: string; auth: { authorization: string } }> {
  const dataDir = await tempDir();
  const app = await createMobileApp({
    dataDir, pairingToken: PAIRING, vision: new FixtureVision(),
    v2Router: () => createV2Router({ mobileDataDir: dataDir, correctionProvider: correctionProvider(model) }),
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
async function bridgeItem(base: string, auth: { authorization: string }, dataDir: string, partial: Partial<RecognitionQuestion> = {}): Promise<WeekItem> {
  const jobId = await makeJob(dataDir, [question(partial)]);
  const registered = await fetch(`${base}/v2/photos/${jobId}/register`, { method: 'POST', headers: auth });
  expect(registered.status).toBe(200);
  const week = (await (await fetch(`${base}/v2/week`, { headers: auth })).json()) as { items: WeekItem[] };
  const item = week.items.find(card => card.jobId === jobId);
  expect(item).toBeDefined();
  return item!;
}

type Auth = { authorization: string };
const post = (base: string, auth: Auth | Record<string, never>, path: string, body?: unknown) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { ...auth, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
const propose = (base: string, auth: Auth, id: string, body: unknown) => post(base, auth, `/v2/items/${id}/correct`, body);
const accept = (base: string, auth: Auth, id: string, body: unknown) => post(base, auth, `/v2/items/${id}/correct/accept`, body);
const direct = (base: string, auth: Auth, id: string, body: unknown) => post(base, auth, `/v2/items/${id}/correct/direct`, body);
const getEvidenceView = (base: string, auth: Auth, id: string) => fetch(`${base}/v2/items/${id}/evidence`, { headers: auth });
const getReport = (base: string, auth: Auth) => fetch(`${base}/v2/corrections/report`, { headers: auth });

function proposeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { instruction: INSTRUCTION_MARK, method: 'voice', revision: 1, clientRequestId: crypto.randomUUID(), ...overrides };
}

interface ProposeResponse { proposalId: string; revision: number; changes: Array<{ field: string; observationId?: string; before: string; after: string }>; clarify: string | null }
interface EvidenceView { questionText: string; subject: string; knowledgeTags: string[]; observations: Array<{ id: string; kind: string; text: string }>; badge: string; revision: number }
interface AcceptResponse { revision: number; card: { id: string; badge: string; status: string; questionExcerpt: string | null; knowledgeTags: string[] } }
interface CorrectionRow { item_id: string; field: string; observation_id: string | null; before_text: string; after_text: string; method: string; proposal_id: string | null }

/** 直接造一道 Web 来源题（无 mobile_item_link）。 */
function makeWebItem(id: string, status: string): void {
  const student = ensureStudentProfile();
  const db = getDb();
  db.prepare("INSERT INTO source_batch (id, student_id, status, total_files, done_files, created_at) VALUES (?, ?, 'done', 1, 1, ?)").run(`bat_${id}`, student.id, now());
  db.prepare("INSERT INTO source_asset (id, batch_id, filename, mime, size, content_hash, status, storage_path, created_at) VALUES (?, ?, 'w.jpg', 'image/jpeg', 1, ?, 'done', '/nowhere.jpg', ?)").run(`ast_${id}`, `bat_${id}`, `hash-${id}`, now());
  db.prepare("INSERT INTO error_item (id, student_id, batch_id, asset_id, item_index, status, knowledge_tags, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, '[]', ?, ?)").run(id, student.id, `bat_${id}`, `ast_${id}`, status, now(), now());
}

describe('T4e 修改识别结果与修改记录', () => {
  it('RED1 提出建议：模型调用 1 次；find 片段定位不到的修改被剔除并说明；重放不再调用；revision 不符 409', async () => {
    const { base, dataDir, auth } = await setupApp('cor-mismatch');
    const item = await bridgeItem(base, auth, dataDir);
    const body = proposeBody();

    const first = await propose(base, auth, item.id, body);
    expect(first.status).toBe(200);
    const p1 = (await first.json()) as ProposeResponse;
    expect(p1.proposalId).toBeTruthy();
    expect(p1.revision).toBe(1);
    // find 片段在 o1 当前文字中不存在的 observation 修改被剔除，只留题干修改，并在 clarify 中说明。
    expect(p1.changes).toHaveLength(1);
    expect(p1.changes[0]).toMatchObject({ field: 'questionText', find: '。', replace: '。（改）' });
    expect(p1.changes[0]!.after).toContain('（改）');
    expect(p1.changes[0]!.before).toBe(`已知 x+y=${seq}，求 x 的值。`);
    expect(p1.clarify).toContain('请说得更具体');
    expect(modelRequests).toHaveLength(1);

    // 同一 clientRequestId 重放：同一结果、不再调用模型。
    const replay = await propose(base, auth, item.id, body);
    expect(replay.status).toBe(200);
    expect((await replay.json()) as ProposeResponse).toEqual(p1);
    expect(modelRequests).toHaveLength(1);

    // revision 不符：409 且返回当前 revision，不调用模型。
    const stale = await propose(base, auth, item.id, proposeBody({ revision: 999 }));
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { revision: number }).revision).toBe(1);
    expect(modelRequests).toHaveLength(1);

    // 修改指令与修改文字不得写入日志。
    const log = fs.readFileSync(eventsLogPath(), 'utf8');
    expect(log).not.toContain(INSTRUCTION_MARK);
    expect(log).not.toContain('（改）');
  });

  it('RED2 接受：证据更新、revision+1、徽标 ok、error_item 同步、状态不变、correction 落库；重复/过期/revision 已变均 409', async () => {
    const { base, dataDir, auth } = await setupApp('cor-ok');
    // needs_check 桥接后徽标为 low，用于验证接受后置为 ok。
    const item = await bridgeItem(base, auth, dataDir, { status: 'needs_check' });
    const db = getDb();
    const beforeRow = db.prepare('SELECT confidence_badge, auto_checks_json FROM evidence_record WHERE item_id = ?').get(item.id) as { confidence_badge: string; auto_checks_json: string | null };
    expect(beforeRow.confidence_badge).toBe('low');
    expect(beforeRow.auto_checks_json).not.toBeNull();

    const p = (await (await propose(base, auth, item.id, proposeBody())).json()) as ProposeResponse;
    const accepted = await accept(base, auth, item.id, { proposalId: p.proposalId, revision: 1 });
    expect(accepted.status).toBe(200);
    const a = (await accepted.json()) as AcceptResponse;
    expect(a.revision).toBe(2);
    expect(a.card).toMatchObject({ id: item.id, badge: 'ok', status: 'ready_for_reflection' });
    expect(a.card.questionExcerpt).toContain('（改）');

    const view = (await (await getEvidenceView(base, auth, item.id)).json()) as EvidenceView;
    expect(view.questionText).toContain('（改）');
    expect(view.revision).toBe(2);
    expect(view.badge).toBe('ok');

    const afterRow = db.prepare('SELECT revision, confidence_badge, auto_checks_json, diagnosis_json, coaching_json FROM evidence_record WHERE item_id = ?').get(item.id) as
      { revision: number; confidence_badge: string; auto_checks_json: string | null; diagnosis_json: string | null; coaching_json: string | null };
    expect(afterRow).toMatchObject({ revision: 2, confidence_badge: 'ok', auto_checks_json: null, diagnosis_json: null, coaching_json: null });
    // 不改题目状态；error_item 同步。
    const itemRow = db.prepare('SELECT status, text_excerpt, subject FROM error_item WHERE id = ?').get(item.id) as { status: string; text_excerpt: string; subject: string };
    expect(itemRow.status).toBe('ready_for_reflection');
    expect(itemRow.text_excerpt).toContain('（改）');
    expect(itemRow.subject).toBe('数学');
    // correction 逐条落库。
    const corrections = db.prepare('SELECT * FROM correction WHERE item_id = ?').all(item.id) as unknown as CorrectionRow[];
    expect(corrections).toHaveLength(1);
    expect(corrections[0]).toMatchObject({ field: 'questionText', method: 'voice', proposal_id: p.proposalId });
    expect(corrections[0]!.after_text).toContain('（改）');

    // 再次接受同一建议 409。
    expect((await accept(base, auth, item.id, { proposalId: p.proposalId, revision: 2 })).status).toBe(409);

    // 接受时 revision 已变 409。
    const p2 = (await (await propose(base, auth, item.id, proposeBody({ revision: 2 }))).json()) as ProposeResponse;
    expect((await accept(base, auth, item.id, { proposalId: p2.proposalId, revision: 1 })).status).toBe(409);

    // 过期建议（10 分钟）409。
    db.prepare("UPDATE correction_proposal SET created_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 11 * 60 * 1000).toISOString(), p2.proposalId);
    expect((await accept(base, auth, item.id, { proposalId: p2.proposalId, revision: 2 })).status).toBe(409);
  });

  it('RED3 规则3：student_work 大幅改写被拒绝并说明；小幅改字通过并记 student_work 字段', async () => {
    // 大幅改写：建议中被剔除，clarify 说明拒绝原因。
    {
      const { base, dataDir, auth } = await setupApp('cor-rewrite');
      const item = await bridgeItem(base, auth, dataDir);
      const response = await propose(base, auth, item.id, proposeBody());
      expect(response.status).toBe(200);
      const p = (await response.json()) as ProposeResponse;
      expect(p.changes).toHaveLength(0);
      expect(p.clarify).toContain('拒绝');
      expect(modelRequests).toHaveLength(1);
    }
    // 键盘直改大幅改写：400，不落库。
    {
      modelRequests.length = 0;
      const { base, dataDir, auth } = await setupApp();
      const item = await bridgeItem(base, auth, dataDir);
      const response = await direct(base, auth, item.id, {
        revision: 1,
        changes: [{ field: 'observation', observationId: 'o1', before: 'x=1', after: BIG_REWRITE }],
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: { message: string } }).error.message).toContain('拒绝');
      expect(getDb().prepare('SELECT COUNT(*) AS n FROM correction WHERE item_id = ?').get(item.id)).toEqual({ n: 0 });
      expect(modelRequests).toHaveLength(0);
    }
    // 小幅改字：通过，correction 记 field=student_work、observation_id=o1。
    {
      const { base, dataDir, auth } = await setupApp('cor-smallfix');
      const item = await bridgeItem(base, auth, dataDir);
      const p = (await (await propose(base, auth, item.id, proposeBody())).json()) as ProposeResponse;
      expect(p.changes).toHaveLength(1);
      expect(p.changes[0]).toMatchObject({ field: 'observation', observationId: 'o1', before: 'x=1', after: 'x=2' });
      const accepted = await accept(base, auth, item.id, { proposalId: p.proposalId, revision: 1 });
      expect(accepted.status).toBe(200);
      const view = (await (await getEvidenceView(base, auth, item.id)).json()) as EvidenceView;
      expect(view.observations.find(o => o.id === 'o1')?.text).toBe('x=2');
      const corrections = getDb().prepare('SELECT * FROM correction WHERE item_id = ?').all(item.id) as unknown as CorrectionRow[];
      expect(corrections).toHaveLength(1);
      expect(corrections[0]).toMatchObject({ field: 'student_work', observation_id: 'o1', before_text: 'x=1', after_text: 'x=2' });
    }
  });

  it('RED4 键盘直改：不调用模型，直接生效并记 method=direct', async () => {
    const { base, dataDir, auth } = await setupApp();
    const item = await bridgeItem(base, auth, dataDir);
    const tagsAfter = JSON.stringify(['一元一次方程', '移项']);
    const response = await direct(base, auth, item.id, {
      revision: 1,
      changes: [{ field: 'knowledgeTags', before: JSON.stringify([`知识点${seq}`]), after: tagsAfter }],
    });
    expect(response.status).toBe(200);
    const a = (await response.json()) as AcceptResponse;
    expect(a.revision).toBe(2);
    expect(a.card.knowledgeTags).toEqual(['一元一次方程', '移项']);
    expect(modelRequests).toHaveLength(0);

    const view = (await (await getEvidenceView(base, auth, item.id)).json()) as EvidenceView;
    expect(view.knowledgeTags).toEqual(['一元一次方程', '移项']);
    const corrections = getDb().prepare('SELECT * FROM correction WHERE item_id = ?').all(item.id) as unknown as CorrectionRow[];
    expect(corrections).toHaveLength(1);
    expect(corrections[0]).toMatchObject({ field: 'knowledgeTags', method: 'direct', proposal_id: null });
    const itemRow = getDb().prepare('SELECT knowledge_tags FROM error_item WHERE id = ?').get(item.id) as { knowledge_tags: string };
    expect(JSON.parse(itemRow.knowledge_tags)).toEqual(['一元一次方程', '移项']);

    // before 不匹配当前值：400，不生效。
    const stale = await direct(base, auth, item.id, {
      revision: 2,
      changes: [{ field: 'knowledgeTags', before: JSON.stringify(['知识点X']), after: tagsAfter }],
    });
    expect(stale.status).toBe(400);
  });

  it('RED5 已在练习包里的题也能修改（证据更新），review_packet_item 不被触碰', async () => {
    const { base, dataDir, auth } = await setupApp();
    const item = await bridgeItem(base, auth, dataDir);
    const db = getDb();
    const student = ensureStudentProfile();
    db.prepare("INSERT INTO review_packet (id, student_id, week, status, created_at) VALUES ('pkt_t4e', ?, ?, 'scheduled', ?)").run(student.id, isoWeekKey(new Date()), now());
    db.prepare("INSERT INTO review_packet_item (packet_id, item_id, position, hint_text, answer_text) VALUES ('pkt_t4e', ?, 0, '提示原文', '答案原文')").run(item.id);
    db.prepare("UPDATE error_item SET status = 'scheduled', updated_at = ? WHERE id = ?").run(now(), item.id);

    const response = await direct(base, auth, item.id, {
      revision: 1,
      changes: [{ field: 'questionText', before: `已知 x+y=${seq}，求 x 的值。`, after: `已知 x+y=${seq}，求 x 的值。（改）` }],
    });
    expect(response.status).toBe(200);
    const a = (await response.json()) as AcceptResponse;
    expect(a.revision).toBe(2);
    expect(a.card.status).toBe('scheduled');

    const view = (await (await getEvidenceView(base, auth, item.id)).json()) as EvidenceView;
    expect(view.questionText).toContain('（改）');
    // 包内内容不动。
    const packetItem = db.prepare("SELECT hint_text, answer_text FROM review_packet_item WHERE packet_id = 'pkt_t4e' AND item_id = ?").get(item.id) as { hint_text: string; answer_text: string };
    expect(packetItem).toEqual({ hint_text: '提示原文', answer_text: '答案原文' });
  });

  it('RED6 限流：同一题 1 小时内第 7 次建议 429，不再调用模型', async () => {
    const { base, dataDir, auth } = await setupApp('cor-ok');
    const item = await bridgeItem(base, auth, dataDir);
    for (let i = 0; i < 6; i++) {
      const response = await propose(base, auth, item.id, proposeBody());
      expect(response.status).toBe(200);
    }
    expect(modelRequests).toHaveLength(6);
    const seventh = await propose(base, auth, item.id, proposeBody());
    expect(seventh.status).toBe(429);
    expect(modelRequests).toHaveLength(6);
  });

  it('RED7 修改报告：按周按字段统计正确，不含题目文字', async () => {
    const { base, dataDir, auth } = await setupApp();
    const itemA = await bridgeItem(base, auth, dataDir);
    const itemB = await bridgeItem(base, auth, dataDir);
    const itemC = await bridgeItem(base, auth, dataDir);
    const itemD = await bridgeItem(base, auth, dataDir);

    const textOf = (n: number) => `已知 x+y=${n}，求 x 的值。`;
    // A、B 改题干；C 改知识点；D 标"不是错题"。
    for (const [item, n] of [[itemA, seq - 3], [itemB, seq - 2]] as Array<[WeekItem, number]>) {
      const r = await direct(base, auth, item.id, { revision: 1, changes: [{ field: 'questionText', before: textOf(n), after: `${textOf(n)}（改）` }] });
      expect(r.status).toBe(200);
    }
    const rc = await direct(base, auth, itemC.id, { revision: 1, changes: [{ field: 'knowledgeTags', before: JSON.stringify([`知识点${seq - 1}`]), after: JSON.stringify(['一元一次方程']) }] });
    expect(rc.status).toBe(200);
    const discard = await post(base, auth, `/v2/items/${itemD.id}/discard`);
    expect(discard.status).toBe(200);

    const response = await getReport(base, auth);
    expect(response.status).toBe(200);
    const report = (await response.json()) as {
      weeks: Array<{ week: string; itemCount: number; fields: Array<{ field: string; corrected: number; total: number; rate: number }>; notAMistake: { count: number; rate: number } }>;
    };
    const thisWeek = report.weeks.find(w => w.week === isoWeekKey(new Date()));
    expect(thisWeek).toBeDefined();
    expect(thisWeek!.itemCount).toBe(4);
    const field = (name: string) => thisWeek!.fields.find(f => f.field === name);
    expect(field('questionText')).toEqual({ field: 'questionText', corrected: 2, total: 4, rate: 0.5 });
    expect(field('knowledgeTags')).toEqual({ field: 'knowledgeTags', corrected: 1, total: 4, rate: 0.25 });
    expect(field('subject')).toEqual({ field: 'subject', corrected: 0, total: 4, rate: 0 });
    expect(field('student_work')).toEqual({ field: 'student_work', corrected: 0, total: 4, rate: 0 });
    expect(field('teacher_note')).toEqual({ field: 'teacher_note', corrected: 0, total: 0, rate: 0 });
    expect(field('correction')).toEqual({ field: 'correction', corrected: 0, total: 0, rate: 0 });
    expect(field('reference_answer')).toEqual({ field: 'reference_answer', corrected: 0, total: 0, rate: 0 });
    expect(thisWeek!.notAMistake).toEqual({ count: 1, rate: 0.25 });

    // 报告不含任何题目文字（题干、观察记录原文、修改后文字、知识点名）。
    const raw = JSON.stringify(report);
    expect(raw).not.toContain('已知 x+y=');
    expect(raw).not.toContain('x=1');
    expect(raw).not.toContain('（改）');
    expect(raw).not.toContain('一元一次方程');
    expect(raw).not.toContain('知识点');
  });

  it('RED8 模型返回非法结构：502 级错误信息，调用次数不增加（不重试）', async () => {
    for (const model of ['cor-bad-json', 'cor-bad-field', 'cor-empty-no-clarify']) {
      modelRequests.length = 0;
      const { base, dataDir, auth } = await setupApp(model);
      const item = await bridgeItem(base, auth, dataDir);
      const response = await propose(base, auth, item.id, proposeBody());
      expect(response.status, model).toBe(502);
      expect(((await response.json()) as { error: { message: string } }).error.message).toBe(BAD_PROPOSE_MESSAGE);
      expect(modelRequests, model).toHaveLength(1);
      // F2：失败的模型调用也落一条失败记录（计入限流、标记失败、不可接受）。
      const failed = getDb().prepare('SELECT error, accepted_at FROM correction_proposal WHERE item_id = ?').all(item.id) as Array<{ error: string | null; accepted_at: string | null }>;
      expect(failed).toHaveLength(1);
      expect(failed[0]!.error).toBeTruthy();
      expect(failed[0]!.accepted_at).toBeNull();
    }
  });

  it('RED9 新接口无令牌 401；非 v2 题 404', async () => {
    const { base, dataDir, auth } = await setupApp();
    const body = JSON.stringify(proposeBody());
    const calls: Array<[string, string, string?]> = [
      ['POST', '/v2/items/itm_x/correct', body],
      ['POST', '/v2/items/itm_x/correct/accept', '{}'],
      ['POST', '/v2/items/itm_x/correct/direct', '{}'],
      ['GET', '/v2/items/itm_x/evidence'],
      ['GET', '/v2/corrections/report'],
    ];
    for (const [method, path, payload] of calls) {
      const response = await fetch(`${base}${path}`, {
        method, headers: payload ? { 'content-type': 'application/json' } : undefined, body: payload,
      });
      expect(response.status, `${method} ${path}`).toBe(401);
    }

    makeWebItem('itm_web_t4e', 'ready_for_reflection');
    // 非 v2 题：按题接口一律 404（report 为全局聚合接口，不在此列）。
    const perItemCalls = calls.filter(([, path]) => path.includes('itm_x'));
    for (const [method, path, payload] of perItemCalls) {
      const response = await fetch(`${base}${path.replace('itm_x', 'itm_web_t4e')}`, {
        method, headers: { ...auth, ...(payload ? { 'content-type': 'application/json' } : {}) }, body: payload,
      });
      expect(response.status, `${method} ${path} (web)`).toBe(404);
    }
  });

  it('T5R2-F4 clarify 超 80 字截断不判失败；提示词要求"你"称呼、不超过 40 字、直说能改什么', async () => {
    const { base, dataDir, auth } = await setupApp('cor-clarify-long');
    const item = await bridgeItem(base, auth, dataDir);
    const response = await propose(base, auth, item.id, proposeBody());
    expect(response.status).toBe(200);
    const p = (await response.json()) as ProposeResponse;
    expect(p.changes).toHaveLength(0);
    expect(p.clarify).toHaveLength(80);
    expect(modelRequests).toHaveLength(1);
    const system = (modelRequests[0]!.messages as Array<{ role: string; content: string }>)[0]!.content;
    expect(system).toContain('用"你"称呼');
    expect(system).toContain('不超过40字');
  });

  it('R1-F1 模型只给 find/replace 片段：服务器生成完整 before/after；片段多次或不存在即剔除并提示', async () => {
    expect(LONG_TEXT).toHaveLength(300);
    // 3 字 find 命中 300 字题干：建议的 before/after 是服务器生成的全文，并附 find/replace 供高亮。
    {
      const { base, dataDir, auth } = await setupApp('cor-fragment');
      const item = await bridgeItem(base, auth, dataDir, { evidence: longEvidence() });
      const response = await propose(base, auth, item.id, proposeBody());
      expect(response.status).toBe(200);
      const p = (await response.json()) as ProposeResponse;
      expect(p.changes).toHaveLength(1);
      expect(p.changes[0]).toMatchObject({ field: 'questionText', find: '减三', replace: '加三', before: LONG_TEXT });
      expect(p.changes[0]!.after).toBe(LONG_TEXT.replace('减三', '加三'));
      expect(modelRequests).toHaveLength(1);
    }
    // find 出现多次 → 该条被剔除，clarify 含原因。
    {
      modelRequests.length = 0;
      const { base, dataDir, auth } = await setupApp('cor-fragment-dup');
      const item = await bridgeItem(base, auth, dataDir, { evidence: longEvidence() });
      const response = await propose(base, auth, item.id, proposeBody());
      expect(response.status).toBe(200);
      const p = (await response.json()) as ProposeResponse;
      expect(p.changes).toHaveLength(0);
      expect(p.clarify).toContain('请说得更具体');
      expect(p.clarify).toContain('多次');
      expect(modelRequests).toHaveLength(1);
    }
    // find 不存在 → 该条被剔除，clarify 含原因。
    {
      const { base, dataDir, auth } = await setupApp('cor-fragment-missing');
      const item = await bridgeItem(base, auth, dataDir, { evidence: longEvidence() });
      const response = await propose(base, auth, item.id, proposeBody());
      expect(response.status).toBe(200);
      const p = (await response.json()) as ProposeResponse;
      expect(p.changes).toHaveLength(0);
      expect(p.clarify).toContain('请说得更具体');
    }
  });

  it('R1-F2 限流计入失败的模型调用：连续 6 次非法输出后第 7 次 429，模型调用不再增加；失败重放不调用模型', async () => {
    const { base, dataDir, auth } = await setupApp('cor-bad-json');
    const item = await bridgeItem(base, auth, dataDir);
    const bodies = Array.from({ length: 6 }, () => proposeBody());
    for (const body of bodies) {
      expect((await propose(base, auth, item.id, body)).status).toBe(502);
    }
    expect(modelRequests).toHaveLength(6);
    // 重放失败的 clientRequestId：返回同一 502，不再调用模型、不计数。
    expect((await propose(base, auth, item.id, bodies[0])).status).toBe(502);
    expect(modelRequests).toHaveLength(6);
    // 第 7 次新请求：429，不再调用模型。
    expect((await propose(base, auth, item.id, proposeBody())).status).toBe(429);
    expect(modelRequests).toHaveLength(6);
    const rows = getDb().prepare('SELECT error FROM correction_proposal WHERE item_id = ?').all(item.id) as Array<{ error: string | null }>;
    expect(rows).toHaveLength(6);
    expect(rows.every(r => r.error)).toBe(true);
  });

  it('R1-F3 只有改过题干才把徽标设为 ok：只改知识点徽标与自动检查保持不变', async () => {
    const { base, dataDir, auth } = await setupApp();
    const db = getDb();
    // 只改知识点：徽标保持 low，auto_checks 保留（诊断/教练缓存仍照常清空）。
    const itemK = await bridgeItem(base, auth, dataDir, { status: 'needs_check' });
    const rK = await direct(base, auth, itemK.id, {
      revision: 1,
      changes: [{ field: 'knowledgeTags', before: JSON.stringify([`知识点${seq}`]), after: JSON.stringify(['一元一次方程']) }],
    });
    expect(rK.status).toBe(200);
    expect(((await rK.json()) as AcceptResponse).card.badge).toBe('low');
    const rowK = db.prepare('SELECT confidence_badge, auto_checks_json FROM evidence_record WHERE item_id = ?').get(itemK.id) as { confidence_badge: string; auto_checks_json: string | null };
    expect(rowK.confidence_badge).toBe('low');
    expect(rowK.auto_checks_json).not.toBeNull();

    // 改题干：徽标变 ok，auto_checks 置空。
    const itemQ = await bridgeItem(base, auth, dataDir, { status: 'needs_check' });
    const rQ = await direct(base, auth, itemQ.id, {
      revision: 1,
      changes: [{ field: 'questionText', before: `已知 x+y=${seq}，求 x 的值。`, after: `已知 x+y=${seq}，求 x 的值。（改）` }],
    });
    expect(rQ.status).toBe(200);
    expect(((await rQ.json()) as AcceptResponse).card.badge).toBe('ok');
    const rowQ = db.prepare('SELECT confidence_badge, auto_checks_json FROM evidence_record WHERE item_id = ?').get(itemQ.id) as { confidence_badge: string; auto_checks_json: string | null };
    expect(rowQ.confidence_badge).toBe('ok');
    expect(rowQ.auto_checks_json).toBeNull();
  });
});
