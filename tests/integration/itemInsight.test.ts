/**
 * 学生端详情页：AI 参考答案 / 推测错因在后台排队生成、按内容缓存，拍照录入答案，学生备注。
 * 合成学习记录 + 确定性模型桩（统计调用次数），不调真实模型、不读 .env 与 data/。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AnswerReading, Evidence, Insight } from '../../src/ai/evidence.js';
import { AiError } from '../../src/ai/errors.js';
import { PreemptedError } from '../../src/studentHost/parentPermit.js';
import type { AnswerPhotoRequest, InsightProvider, InsightRequest } from '../../src/ai/provider.js';
import { getDb, now } from '../../src/db/connection.js';
import { ensureStudentProfile } from '../../src/services/studentService.js';
import {
  addAnswerPhoto, deleteAnswerPhoto, drainInsightQueue, editAnswerPhoto, getItemNote, INSIGHT_RATE_LIMIT, insightState, listAnswerPhotos, NOTE_MAX_CHARS,
  requestInsight, resetInsightQueueForTest, retryAnswerPhoto, saveItemNote, startInsightQueue,
} from '../../src/v2/insightService.js';
import { clearPracticeFixtures, seedPracticeItems } from '../helpers/practiceTask.js';

const INSIGHT: Insight = { answer: '$x = 10$', solution: '1. 列式\n2. 求解', mistake: '你把两轮传染当成了一轮。', cause: '审题遗漏', uncertain: null, figure: null };

function evidence(observations: Evidence['observations'], questionText = '有一个人患了流感，经过两轮传染后共有 121 个人患了流感，每轮传染中平均一个人传染了几个人？'): Evidence {
  return {
    version: 1, questionNumber: '1', questionText, subject: '数学', chapter: '', knowledgeTags: ['传播问题'], questionType: '填空',
    questionRegion: { x: 0, y: 0, width: 1, height: 1 }, requiresDiagram: false, regions: [], observations, uncertainties: [],
  };
}
const WORK = { id: 'o1', kind: 'student_work' as const, text: '(1+x)² = 121，x = 11', regionId: null, confidence: 0.9 };

function seed(content: Evidence): string {
  const [item] = seedPracticeItems(1);
  getDb().prepare('INSERT INTO evidence_record (item_id, content_json, confidence_badge, updated_at) VALUES (?,?,?,?)').run(item!, JSON.stringify(content), 'ok', now());
  return item!;
}

class StubProvider implements InsightProvider {
  explains: InsightRequest[] = [];
  reads: AnswerPhotoRequest[] = [];
  explainError: Error | null = null;
  reading: AnswerReading = { found: true, text: '答案：$x = 10$' };
  async explainItem(request: InsightRequest) {
    this.explains.push(request);
    if (this.explainError) throw this.explainError;
    return { value: INSIGHT, run: { stage: 'explain' as const, model: 'stub', durationMs: 0, promptTokens: null, completionTokens: null, maxTokens: 0, thinking: false as const, promptVersion: 'stub' } };
  }
  async readAnswerPhoto(request: AnswerPhotoRequest) {
    this.reads.push(request);
    return { value: this.reading, run: { stage: 'answer_read' as const, model: 'stub', durationMs: 0, promptTokens: null, completionTokens: null, maxTokens: 0, thinking: false as const, promptVersion: 'stub' } };
  }
}

let stub: StubProvider;
let busy = false;
let stop: () => void = () => undefined;
const jpeg = (): Promise<Buffer> => sharp({ create: { width: 40, height: 30, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();

beforeAll(() => { ensureStudentProfile(); });
beforeEach(() => {
  clearPracticeFixtures();
  resetInsightQueueForTest();
  stub = new StubProvider();
  busy = false;
  stop = startInsightQueue({ busy: () => busy, provider: stub, intervalMs: 0, backfillDays: 30 });
});
afterEach(() => { stop(); });

describe('详情页 AI 解答在后台排队生成', () => {
  it('新收的题不用打开详情页，空闲时就生成；同一内容只调用一次模型', async () => {
    const item = seed(evidence([WORK]));
    expect(insightState(item)).toEqual({ state: 'none' });
    await drainInsightQueue();
    expect(stub.explains).toHaveLength(1);
    expect(stub.explains[0]!.context.questionText).toContain('121');
    expect(stub.explains[0]!.background).toBe(true);
    expect(insightState(item)).toEqual({ state: 'ready', insight: INSIGHT, requiresDiagram: false, images: 0 });
    await drainInsightQueue();
    expect(requestInsight(item)).toMatchObject({ state: 'ready' });
    expect(stub.explains).toHaveLength(1);
  });

  it('看题目照片：旧流程的题把整题图（题目和作答区域）缩到长边 1600 发给模型', async () => {
    const item = seed({ ...evidence([WORK]), regions: [{ id: 'r1', kind: 'student_work', box: { x: 0.5, y: 0.5, width: 0.4, height: 0.4 }, confidence: 0.9, cleanForPrint: false }], questionRegion: { x: 0, y: 0, width: 0.6, height: 0.5 } });
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sel-insight-')), 'page.jpg');
    fs.writeFileSync(file, await sharp({ create: { width: 3000, height: 4000, channels: 3, background: '#f0f0f0' } }).jpeg().toBuffer());
    getDb().prepare('UPDATE source_asset SET storage_path = ? WHERE id = (SELECT asset_id FROM error_item WHERE id = ?)').run(file, item);
    await drainInsightQueue();
    expect(stub.explains[0]!.images).toHaveLength(1);
    const meta = await sharp(stub.explains[0]!.images[0]!).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1600);
    expect(insightState(item)).toMatchObject({ state: 'ready', images: 1 });
  });

  it('学生正在上传 / 识别时不做，忙完再做', async () => {
    const item = seed(evidence([WORK]));
    busy = true;
    await drainInsightQueue();
    expect(stub.explains).toHaveLength(0);
    busy = false;
    await drainInsightQueue();
    expect(insightState(item)).toMatchObject({ state: 'ready' });
  });

  it('早于自动处理范围的题不自动做；打开详情页才排到最前', async () => {
    const item = seed(evidence([WORK]));
    getDb().prepare('UPDATE error_item SET created_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', item);
    await drainInsightQueue();
    expect(stub.explains).toHaveLength(0);
    expect(requestInsight(item)).toEqual({ state: 'queued' });
    expect(insightState(item)).toEqual({ state: 'queued' });
    await drainInsightQueue();
    expect(insightState(item)).toMatchObject({ state: 'ready' });
  });

  it('移出错题本的题不做', async () => {
    const item = seed(evidence([WORK]));
    getDb().prepare("UPDATE error_item SET status = 'archived_not_worth_review', archived_reason = 'not_a_mistake' WHERE id = ?").run(item);
    await drainInsightQueue();
    expect(stub.explains).toHaveLength(0);
  });

  it('题目识别结果改了，旧解答不再显示，后台按新内容重新生成', async () => {
    const item = seed(evidence([WORK]));
    await drainInsightQueue();
    getDb().prepare('UPDATE evidence_record SET content_json = ?, revision = 2 WHERE item_id = ?').run(JSON.stringify(evidence([{ ...WORK, text: 'x = 10' }])), item);
    expect(insightState(item)).toEqual({ state: 'none' });
    resetInsightQueueForTest();
    await drainInsightQueue();
    expect(stub.explains).toHaveLength(2);
    expect(stub.explains[1]!.context.observations[0]!.text).toBe('x = 10');
  });

  it('没有学生原作时不推测错因，哪怕模型给了', async () => {
    const item = seed(evidence([{ id: 't1', kind: 'teacher_note', text: '✗', regionId: null, confidence: 0.9 }]));
    await drainInsightQueue();
    expect(insightState(item)).toMatchObject({ state: 'ready', insight: { answer: INSIGHT.answer, mistake: null, cause: null } });
  });

  it('失败先自动再试一次，还不行等学生点重试；一小时内最多 6 次', async () => {
    const item = seed(evidence([WORK]));
    stub.explainError = new AiError('invalid_json', '模型正文不符合 JSON 契约');
    await drainInsightQueue();
    expect(stub.explains).toHaveLength(1);
    // 第一次失败后显示「排着」，过一会儿自动再试。
    expect(insightState(item)).toEqual({ state: 'queued' });
    await drainInsightQueue();
    expect(stub.explains).toHaveLength(1);
    getDb().prepare("UPDATE item_insight SET created_at = '2020-01-01T00:00:00.000Z' WHERE item_id = ?").run(item);
    resetInsightQueueForTest();
    await drainInsightQueue();
    expect(stub.explains).toHaveLength(2);
    expect(insightState(item)).toEqual({ state: 'failed', rateLimited: false });
    // 自动次数用完不再自己试；没点重试的打开详情页也不重试。
    resetInsightQueueForTest();
    await drainInsightQueue();
    expect(requestInsight(item)).toEqual({ state: 'failed', rateLimited: false });
    expect(stub.explains).toHaveLength(2);
    // 第一次的时间改到了很久以前，不算进这一小时：这一小时里已有 1 次，再点 5 次重试就到上限。
    for (let attempt = 2; attempt <= INSIGHT_RATE_LIMIT; attempt += 1) {
      expect(requestInsight(item, { retry: true })).toEqual({ state: 'queued' });
      await drainInsightQueue();
    }
    expect(stub.explains).toHaveLength(1 + INSIGHT_RATE_LIMIT);
    expect(requestInsight(item, { retry: true })).toEqual({ state: 'failed', rateLimited: true });
    await drainInsightQueue();
    expect(stub.explains).toHaveLength(1 + INSIGHT_RATE_LIMIT);
    const errors = getDb().prepare('SELECT DISTINCT error FROM item_insight WHERE item_id = ?').all(item) as Array<{ error: string }>;
    expect(errors).toEqual([{ error: 'invalid_json' }]);
  });

  it('名额被前台请求要走：不算失败、不计次数，排回最前，下次空闲再做', async () => {
    const item = seed(evidence([WORK]));
    stub.explainError = new PreemptedError();
    busy = false;
    let calls = 0;
    const original = stub.explainItem.bind(stub);
    stub.explainItem = async request => { calls += 1; if (calls === 1) return original(request); stub.explainError = null; return original(request); };
    await drainInsightQueue();
    expect(calls).toBe(2);
    expect(insightState(item)).toMatchObject({ state: 'ready' });
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM item_insight WHERE item_id = ? AND content_json IS NULL').get(item)).toEqual({ n: 0 });
  });

  it('题干还没识别出来就不生成', async () => {
    const [item] = seedPracticeItems(1);
    await drainInsightQueue();
    expect(stub.explains).toHaveLength(0);
    expect(insightState(item!)).toEqual({ state: 'unavailable' });
    expect(requestInsight(item!)).toEqual({ state: 'unavailable' });
  });

  it('mock 模式的内置实现给出带 Markdown、公式和交互图的解答', async () => {
    stop();
    stop = startInsightQueue({ busy: () => false, intervalMs: 0 });
    const item = seed(evidence([WORK]));
    await drainInsightQueue();
    const state = insightState(item);
    expect(state.state).toBe('ready');
    if (state.state !== 'ready') return;
    expect(state.insight.solution).toMatch(/\$\\frac\{x\}\{2\}/);
    expect(state.insight.solution).toContain('| 步骤 | 依据 |');
    expect(state.insight.mistake).toContain('(1+x)²');
    expect(state.insight.figure).toMatchObject({ kind: 'html', html: expect.stringContaining('<svg') });
    const solid = seed(evidence([WORK], '△ABC 中，AB = 3，求 BC。'));
    await drainInsightQueue();
    expect(insightState(solid)).toMatchObject({ state: 'ready', insight: { figure: { kind: 'solid', highlights: [{ from: 'B', to: 'D' }] } } });
  });
});

describe('拍照录入答案', () => {
  it('后台先转写这道题的答案，再拿它当参考生成解答', async () => {
    const item = seed(evidence([WORK]));
    const added = await addAnswerPhoto(item, await jpeg());
    expect(added).toMatchObject({ status: 'reading', text: null });
    await drainInsightQueue();
    expect(stub.reads).toHaveLength(1);
    expect(stub.reads[0]!.context.questionNumber).toBe('1');
    expect(listAnswerPhotos(item)).toMatchObject([{ status: 'done', text: '答案：$x = 10$' }]);
    expect(stub.explains.at(-1)!.providedAnswers).toEqual(['答案：$x = 10$']);
  });

  it('没找到可以自己填；改了文字、删掉照片都会按新内容重新生成', async () => {
    const item = seed(evidence([WORK]));
    stub.reading = { found: false, text: null };
    const photo = await addAnswerPhoto(item, await jpeg());
    if (typeof photo === 'string') throw new Error(photo);
    await drainInsightQueue();
    expect(listAnswerPhotos(item)).toMatchObject([{ status: 'not_found', text: null }]);
    const before = stub.explains.length;
    expect(editAnswerPhoto(item, photo.id, '  x = 10  ')).toMatchObject({ status: 'done', text: 'x = 10' });
    await drainInsightQueue();
    expect(stub.explains).toHaveLength(before + 1);
    expect(stub.explains.at(-1)!.providedAnswers).toEqual(['x = 10']);
    // 删掉照片就回到没录答案时的内容：那一版已经解过，直接用，不再调用模型。
    expect(deleteAnswerPhoto(item, photo.id)).toBe(true);
    await drainInsightQueue();
    expect(stub.explains).toHaveLength(before + 1);
    expect(insightState(item)).toMatchObject({ state: 'ready' });
    expect(editAnswerPhoto(item, photo.id, 'x')).toBeNull();
  });

  it('没找到可以重新识别；每题最多 3 张；读不出的图拒收', async () => {
    const item = seed(evidence([WORK]));
    stub.reading = { found: false, text: null };
    const photo = await addAnswerPhoto(item, await jpeg());
    if (typeof photo === 'string') throw new Error(photo);
    await drainInsightQueue();
    stub.reading = { found: true, text: '10' };
    expect(retryAnswerPhoto(item, photo.id)).toBe(true);
    await drainInsightQueue();
    expect(listAnswerPhotos(item)[0]).toMatchObject({ status: 'done', text: '10' });
    expect(retryAnswerPhoto(item, photo.id)).toBe(false);
    await addAnswerPhoto(item, await jpeg());
    await addAnswerPhoto(item, await jpeg());
    expect(await addAnswerPhoto(item, await jpeg())).toMatch(/最多录 3 张/);
    const other = seed(evidence([WORK]));
    expect(await addAnswerPhoto(other, Buffer.from('not an image'))).toMatch(/读不出来/);
  });
});

describe('学生备注', () => {
  it('保存、覆盖、清空；超长拒绝', () => {
    const [item] = seedPracticeItems(1);
    expect(getItemNote(item!)).toEqual({ text: '', updatedAt: null });
    expect(saveItemNote(item!, '两轮是平方，不是乘 2')).toMatchObject({ text: '两轮是平方，不是乘 2' });
    expect(saveItemNote(item!, '下次先列式')?.text).toBe('下次先列式');
    expect(getItemNote(item!).text).toBe('下次先列式');
    expect(getItemNote(item!).updatedAt).not.toBeNull();
    expect(saveItemNote(item!, 'x'.repeat(NOTE_MAX_CHARS + 1))).toBeNull();
    expect(saveItemNote(item!, 42)).toBeNull();
    expect(getItemNote(item!).text).toBe('下次先列式');
    expect(saveItemNote(item!, '  ')).toEqual({ text: '', updatedAt: null });
    expect(getItemNote(item!)).toEqual({ text: '', updatedAt: null });
  });

  it('题目删除时备注、解答、答案照片一起删', async () => {
    const item = seed(evidence([WORK]));
    saveItemNote(item, '备注');
    await addAnswerPhoto(item, await jpeg());
    await drainInsightQueue();
    clearPracticeFixtures();
    for (const table of ['item_note', 'item_insight', 'item_answer_photo']) {
      expect((getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0);
    }
  });
});
