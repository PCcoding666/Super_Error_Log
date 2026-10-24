import type { LearningContext } from '../learning/contracts.js';
import fs from 'node:fs';
import { AiError } from './errors.js';
import type {
  AiProvider,
  CoachProvider,
  ExtractInput,
  ExtractResult,
  ExtractedItem,
  FieldSuggestion,
  FollowupProvider,
  FollowupTurn,
  CorrectionProvider,
  InsightProvider,
  InsightRequest,
  AnswerPhotoRequest,
  MatchInput,
  MatchResult,
  SuggestInput,
} from './provider.js';
import { FOLLOWUP_FALLBACK_QUESTION, validateAnswerReading, validateEvidence, validateInsight, validateLearningContext, type AnswerReading, type Coaching, type Insight, type Diagnosis, type Evidence, type FollowupAsk, type FollowupSummarize, type CorrectionProposalResult } from './evidence.js';
import { ATTEMPT_STATES, CAUSES, type Subject } from '../domain/types.js';
import type { StageResult } from './chatClient.js';

export interface FixtureManifestItem {
  filename: string;
  items: Array<{
    textExcerpt: string;
    subject: Subject;
    chapter: string;
    knowledgeTags: string[];
    questionType: string;
    hasTeacherNote: boolean;
    hasAnswer: boolean;
    confidence: number;
  }>;
}

function hashToInt(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 由哈希派生的稳定伪随机序列（同一输入永远一致） */
function derive(contentHash: string, salt: string): number {
  return hashToInt(`${contentHash}:${salt}`) % 1000;
}

const SUBJECTS: Subject[] = ['数学', '物理', '化学'];
const TAG_POOL: Record<Subject, string[]> = {
  数学: ['一元二次方程', '二次函数', '相似三角形', '圆的性质', '概率初步'],
  物理: ['欧姆定律', '力的合成', '浮力', '光的折射', '功与功率'],
  化学: ['化学方程式配平', '质量守恒', '酸碱盐', '金属活动性', '溶液计算'],
};
const TYPE_POOL = ['计算题', '选择题', '填空题', '证明题', '实验题'];

/**
 * Deterministic mock：优先命中 fixture 清单（文件名精确匹配），
 * 否则由内容哈希派生稳定结果；支持 SEL_MOCK_FAULT 注入故障（测试用）。
 */
export class MockAiProvider implements AiProvider, FollowupProvider, CorrectionProvider, CoachProvider, InsightProvider {
  readonly name = 'mock';
  private manifest: Map<string, FixtureManifestItem> | null = null;
  private fault: string;

  constructor(manifestPath?: string, fault = '') {
    this.fault = fault || process.env.SEL_MOCK_FAULT || '';
    const p = manifestPath ?? 'fixtures/assets/manifest.json';
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const list = JSON.parse(raw) as FixtureManifestItem[];
      this.manifest = new Map(list.map((m) => [m.filename, m]));
    } catch {
      this.manifest = null;
    }
  }

  private maybeFault(operation: string): void {
    if (!this.fault) return;
    if (this.fault === 'timeout' && operation === 'extract') {
      throw new AiError('timeout', 'mock 注入：provider 超时');
    }
    if (this.fault === 'invalid_json' && operation === 'extract') {
      throw new AiError('invalid_json', 'mock 注入：返回非法 JSON');
    }
  }

  async extractItems(input: ExtractInput): Promise<ExtractResult> {
    this.maybeFault('extract');
    const hit = this.manifest?.get(input.filename);
    if (hit) {
      return {
        items: hit.items.map((m, i) => ({
          itemIndex: i,
          textExcerpt: m.textExcerpt,
          subject: m.subject,
          chapter: m.chapter,
          knowledgeTags: m.knowledgeTags,
          questionType: m.questionType,
          hasTeacherNote: m.hasTeacherNote,
          hasAnswer: m.hasAnswer,
          confidence: m.confidence,
          fieldConfidence: {
            subject: m.confidence,
            knowledgeTags: m.confidence,
            questionType: Math.min(0.99, m.confidence + 0.05),
          },
        })),
      };
    }

    // 哈希派生：1–3 道，约 1/5 低置信度
    const count = 1 + (derive(input.contentHash, 'count') % 3);
    const items: ExtractedItem[] = [];
    for (let i = 0; i < count; i++) {
      const subject = SUBJECTS[derive(input.contentHash, `subj${i}`) % 3]!;
      const tags = TAG_POOL[subject];
      const tag = tags[derive(input.contentHash, `tag${i}`) % tags.length]!;
      const lowConf = derive(input.contentHash, `conf${i}`) % 5 === 0;
      const confidence = lowConf ? 0.55 : 0.85 + (derive(input.contentHash, `hi${i}`) % 14) / 100;
      items.push({
        itemIndex: i,
        textExcerpt: `【mock】${subject}·${tag} 题目摘要（文件 ${input.filename} 第 ${i + 1} 题）`,
        subject,
        chapter: `${tag} 章节`,
        knowledgeTags: [tag],
        questionType: TYPE_POOL[derive(input.contentHash, `type${i}`) % TYPE_POOL.length],
        hasTeacherNote: derive(input.contentHash, `tn${i}`) % 2 === 0,
        hasAnswer: derive(input.contentHash, `ans${i}`) % 4 !== 0,
        confidence,
        fieldConfidence: {
          subject: confidence,
          knowledgeTags: lowConf ? 0.5 : confidence,
          questionType: confidence,
        },
      });
    }
    return { items };
  }

  async suggestFields(input: SuggestInput): Promise<FieldSuggestion> {
    const base = derive(input.itemId, 'suggest');
    const subject = SUBJECTS[base % 3]!;
    const tag = TAG_POOL[subject][base % 5]!;
    // 反思三项建议：约 2/3 高置信（可一键采纳），1/3 低置信（仍需逐项判断），便于演示两条路径
    const adoptable = derive(input.itemId, 'adoptable') % 3 !== 0;
    const conf = adoptable
      ? { attempt: 0.9, cause: 0.88, review: 0.86 }
      : { attempt: 0.55, cause: 0.5, review: 0.52 };
    return {
      subject: { value: subject, confidence: 0.72 },
      knowledgeTags: { value: [tag], confidence: 0.66 },
      attemptState: { value: ATTEMPT_STATES[base % ATTEMPT_STATES.length]!, confidence: conf.attempt },
      possibleCause: { value: '方法选择', confidence: conf.cause },
      reviewValue: { value: '可以再做', confidence: conf.review },
    };
  }

  async matchReturnSheet(input: MatchInput): Promise<MatchResult> {
    if (input.candidateShortIds.length === 0) {
      return { shortId: null, confidence: 0 };
    }
    // 文件名包含短 ID（如 RET-M-03.png）则高置信匹配，否则低置信走人工
    const byName = input.candidateShortIds.find((id) => input.originalName.includes(id));
    if (byName) return { shortId: byName, confidence: 0.95 };
    const idx = derive(input.contentHash, 'match') % input.candidateShortIds.length;
    return { shortId: input.candidateShortIds[idx]!, confidence: 0.5 };
  }

  /** T4c 确定性追问：引用第一条学生作答/订正原文片段。 */
  async followupAsk(evidence: LearningContext): Promise<FollowupAsk> {
    const context=validateLearningContext(evidence);
    const target = context.observations.find(o => o.kind === 'student_work' || o.kind === 'correction');
    if (!target) return { question: FOLLOWUP_FALLBACK_QUESTION, referencedObservationIds: [] };
    const excerpt = target.text.slice(0, 20).replace(/[？?]/g, '');
    return { question: `你写的「${excerpt}」这一步，当时是怎么想的？`, referencedObservationIds: [target.id] };
  }

  /** T4c 确定性归纳：由回答内容哈希派生稳定建议；第 1 轮给第二轮追问。 */
  async followupSummarize(_evidence: LearningContext, turns: FollowupTurn[]): Promise<FollowupSummarize> {
    validateLearningContext(_evidence);
    const key = turns.map(t => t.answer).join('|');
    const base = derive(key, 'followup');
    return {
      summary: '把订正当成了新做法，漏了原来那一步的检查',
      suggestedCause: CAUSES[base % CAUSES.length]!,
      suggestedAttemptState: ATTEMPT_STATES[base % ATTEMPT_STATES.length]!,
      secondQuestion: turns.length < 2 ? '那一步你当时为什么觉得可以这样做？' : null,
    };
  }

  /**
   * T4e 确定性修订建议：按指令关键词选择字段，产出必然通过校验的修改。
   * 文字类字段附 find/replace 片段；学生原作只改最后一个字符（小幅转写纠错）；无法判断时只反问。
   */
  /** T5 确定性打印辅导：一级说考什么、二级给第一步；答案标注 AI 参考。 */
  async coachForPrint(evidence: LearningContext, _diagnosis: Diagnosis): Promise<Coaching> {
    const e = validateLearningContext(evidence);
    return {
      hints: [`先想想这题考的是「${e.knowledgeTags[0] ?? '相关知识点'}」`, '把已知条件列出来，再决定第一步怎么算'],
      solution: '按定义与已知条件逐步推导。',
      answer: `【mock】第 ${e.questionNumber} 题参考答案`,
      source: 'ai_generated',
    };
  }

  /** 确定性详情页解答：解题过程覆盖 Markdown 列表、加粗、表格和 LaTeX 公式，附一张会运行脚本的交互图；有学生原作才推测错因。 */
  async explainItem(request: InsightRequest): Promise<StageResult<Insight>> {
    const e = validateLearningContext(request.context);
    const work = e.observations.find(o => o.kind === 'student_work');
    const value = validateInsight({
      answer: `【mock】第 ${e.questionNumber} 题参考答案`,
      solution: [
        `**思路**：这题考的是「${e.knowledgeTags[0] ?? '相关知识点'}」。`,
        '',
        '1. 把已知条件列出来。',
        '2. 列式：$\\frac{x}{2} + 1 = 3$。',
        '3. 两边同乘 2：',
        '',
        '$$x + 2 = 6 \\Rightarrow x = 4$$',
        '',
        '| 步骤 | 依据 |',
        '| --- | --- |',
        '| 去分母 | 等式的性质 |',
        ...(request.providedAnswers.length ? ['', `对照你拍的答案：${request.providedAnswers[0]!.slice(0, 40)}`] : []),
      ].join('\n'),
      mistake: work ? `【mock】你写的「${work.text.slice(0, 20)}」这一步和题目条件对不上，回头看看移项。` : null,
      cause: work ? '推理步骤' : null,
      uncertain: null,
      // 有三角形的题给立体图数据（程序画、能拖动旋转），其他给一段会运行脚本的 HTML：两条路都有确定的样子可测。
      figure: /△|三角形/.test(e.questionText)
        ? { kind: 'solid', points: { A: [0, 0, 0], B: [2, 0, 0], C: [0, 2, 0], D: [0, 0, 2] }, edges: [['A', 'B'], ['B', 'C'], ['C', 'A'], ['A', 'D'], ['B', 'D'], ['C', 'D']], highlights: [{ from: 'B', to: 'D', label: 'BD' }], faces: [['A', 'B', 'C']], caption: '【mock】红线是 BD' }
        : { kind: 'html', html: '<div style="font:14px system-ui"><svg viewBox="0 0 200 80" width="100%" height="120"><line x1="10" y1="60" x2="190" y2="60" stroke="currentColor"/><circle cx="100" cy="40" r="8" fill="#0a84ff"/></svg><p id="t">mock</p><script>document.getElementById("t").textContent = "mock 交互图已运行（看到 ' + String(request.images.length) + ' 张照片）";</script></div>' },
    });
    return { value, run: { stage: 'explain', model: 'mock', durationMs: 0, promptTokens: null, completionTokens: null, maxTokens: 0, thinking: false, promptVersion: 'mock' } };
  }

  async readAnswerPhoto(request: AnswerPhotoRequest): Promise<StageResult<AnswerReading>> {
    const e = validateLearningContext(request.context);
    const value = validateAnswerReading({ found: true, text: `【mock】第 ${e.questionNumber} 题答案：$x = 4$` });
    return { value, run: { stage: 'answer_read', model: 'mock', durationMs: 0, promptTokens: null, completionTokens: null, maxTokens: 0, thinking: false, promptVersion: 'mock' } };
  }

  async proposeCorrection(evidence: LearningContext, instruction: string): Promise<CorrectionProposalResult> {
    const e = validateLearningContext(evidence);
    if (/学科/.test(instruction)) {
      const after = e.subject === '数学' ? '物理' : '数学';
      return { changes: [{ field: 'subject', before: e.subject, after }], rejected: [], clarify: null };
    }
    if (/知识点/.test(instruction)) {
      const after = JSON.stringify([`${e.knowledgeTags[0] ?? '知识点'}（订）`]);
      return { changes: [{ field: 'knowledgeTags', before: JSON.stringify(e.knowledgeTags), after }], rejected: [], clarify: null };
    }
    if (/题干/.test(instruction)) {
      const find = e.questionText.slice(-1);
      const replace = `${find}（订）`;
      return { changes: [{ field: 'questionText', before: e.questionText, after: `${e.questionText.slice(0, -1)}${replace}`, find, replace }], rejected: [], clarify: null };
    }
    const target = e.observations.find(o => o.kind === 'student_work');
    if (target) {
      const find = target.text.slice(-1);
      const replace = target.text.endsWith('1') ? '2' : '1';
      return { changes: [{ field: 'observation', observationId: target.id, before: target.text, after: `${target.text.slice(0, -1)}${replace}`, find, replace }], rejected: [], clarify: null };
    }
    return { changes: [], rejected: [], clarify: '请说明要改哪一处（题干/学科/知识点/作答）。' };
  }
}
