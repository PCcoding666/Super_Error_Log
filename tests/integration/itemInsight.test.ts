/**
 * 学生端详情页：AI 参考答案 / 推测错因的生成与缓存，以及学生备注。
 * 合成学习记录 + 确定性模型桩（统计调用次数），不调真实模型、不读 .env 与 data/。
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Evidence, Insight } from '../../src/ai/evidence.js';
import { AiError } from '../../src/ai/errors.js';
import type { InsightProvider } from '../../src/ai/provider.js';
import type { LearningContext } from '../../src/learning/contracts.js';
import { getDb, now } from '../../src/db/connection.js';
import { ensureStudentProfile } from '../../src/services/studentService.js';
import { getItemNote, INSIGHT_RATE_LIMIT, insightState, insightWorkPending, NOTE_MAX_CHARS, requestInsight, saveItemNote, settleInsight } from '../../src/v2/insightService.js';
import { clearPracticeFixtures, seedPracticeItems } from '../helpers/practiceTask.js';

const INSIGHT: Insight = { answer: '$x = 10$', solution: '1. 列式\n2. 求解', mistake: '你把两轮传染当成了一轮。', cause: '审题遗漏', uncertain: null };

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

class StubExplainer implements InsightProvider {
  calls: LearningContext[] = [];
  failWith: Error | null = null;
  async explainItem(context: LearningContext) {
    this.calls.push(context);
    if (this.failWith) throw this.failWith;
    return { value: INSIGHT, run: { stage: 'explain' as const, model: 'stub', durationMs: 0, promptTokens: null, completionTokens: null, maxTokens: 0, thinking: false as const, promptVersion: 'stub' } };
  }
}

beforeAll(() => { ensureStudentProfile(); });
beforeEach(() => { clearPracticeFixtures(); });

describe('详情页 AI 解答', () => {
  it('第一次请求在后台生成，之后同一内容直接用缓存、不再调用模型', async () => {
    const item = seed(evidence([WORK]));
    const stub = new StubExplainer();
    expect(insightState(item)).toEqual({ state: 'none' });
    expect(requestInsight(item, stub)).toEqual({ state: 'generating' });
    // 生成中再请求不会重复调用。
    expect(requestInsight(item, stub)).toEqual({ state: 'generating' });
    expect(insightState(item)).toEqual({ state: 'generating' });
    // 后台还在生成时 worker 算忙，不因空闲退出。
    expect(insightWorkPending()).toBe(true);
    await settleInsight(item);
    expect(insightWorkPending()).toBe(false);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.questionText).toContain('121');
    expect(insightState(item)).toEqual({ state: 'ready', insight: INSIGHT, requiresDiagram: false });
    expect(requestInsight(item, stub)).toMatchObject({ state: 'ready' });
    expect(stub.calls).toHaveLength(1);
  });

  it('题目识别结果改了，旧解答不再显示，重新请求会按新内容生成', async () => {
    const item = seed(evidence([WORK]));
    const stub = new StubExplainer();
    requestInsight(item, stub);
    await settleInsight(item);
    getDb().prepare('UPDATE evidence_record SET content_json = ?, revision = 2 WHERE item_id = ?').run(JSON.stringify(evidence([{ ...WORK, text: 'x = 10' }])), item);
    expect(insightState(item)).toEqual({ state: 'none' });
    requestInsight(item, stub);
    await settleInsight(item);
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[1]!.observations[0]!.text).toBe('x = 10');
  });

  it('没有学生原作时不推测错因，哪怕模型给了', async () => {
    const item = seed(evidence([{ id: 't1', kind: 'teacher_note', text: '✗', regionId: null, confidence: 0.9 }]));
    requestInsight(item, new StubExplainer());
    await settleInsight(item);
    expect(insightState(item)).toMatchObject({ state: 'ready', insight: { answer: INSIGHT.answer, mistake: null, cause: null } });
  });

  it('模型失败记为失败，可以重试；一小时内最多调用 6 次', async () => {
    const item = seed(evidence([WORK]));
    const stub = new StubExplainer();
    stub.failWith = new AiError('invalid_json', '模型正文不符合 JSON 契约');
    requestInsight(item, stub);
    await settleInsight(item);
    expect(insightState(item)).toEqual({ state: 'failed', rateLimited: false });
    for (let attempt = 2; attempt <= INSIGHT_RATE_LIMIT; attempt += 1) {
      expect(requestInsight(item, stub)).toEqual({ state: 'generating' });
      await settleInsight(item);
    }
    expect(stub.calls).toHaveLength(INSIGHT_RATE_LIMIT);
    expect(insightState(item)).toEqual({ state: 'failed', rateLimited: true });
    expect(requestInsight(item, stub)).toEqual({ state: 'failed', rateLimited: true });
    expect(stub.calls).toHaveLength(INSIGHT_RATE_LIMIT);
    const errors = getDb().prepare('SELECT DISTINCT error FROM item_insight WHERE item_id = ?').all(item) as Array<{ error: string }>;
    expect(errors).toEqual([{ error: 'invalid_json' }]);
  });

  it('题干还没识别出来就不生成', () => {
    const [item] = seedPracticeItems(1);
    const stub = new StubExplainer();
    expect(insightState(item!)).toEqual({ state: 'unavailable' });
    expect(requestInsight(item!, stub)).toEqual({ state: 'unavailable' });
    expect(stub.calls).toHaveLength(0);
  });

  it('mock 模式的内置实现给出带 Markdown 和公式的解答', async () => {
    const item = seed(evidence([WORK]));
    requestInsight(item);
    await settleInsight(item);
    const state = insightState(item);
    expect(state.state).toBe('ready');
    if (state.state !== 'ready') return;
    expect(state.insight.solution).toMatch(/\$\\frac\{x\}\{2\}/);
    expect(state.insight.solution).toContain('| 步骤 | 依据 |');
    expect(state.insight.mistake).toContain('(1+x)²');
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

  it('题目删除时备注和解答一起删', async () => {
    const item = seed(evidence([WORK]));
    saveItemNote(item, '备注');
    requestInsight(item, new StubExplainer());
    await settleInsight(item);
    clearPracticeFixtures();
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM item_note').get() as { n: number }).n).toBe(0);
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM item_insight').get() as { n: number }).n).toBe(0);
  });
});
