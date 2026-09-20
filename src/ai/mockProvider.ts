import fs from 'node:fs';
import { AiError } from './errors.js';
import type {
  AiProvider,
  ExtractInput,
  ExtractResult,
  ExtractedItem,
  FieldSuggestion,
  MatchInput,
  MatchResult,
  SuggestInput,
} from './provider.js';
import { ATTEMPT_STATES, type Subject } from '../domain/types.js';

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
export class MockAiProvider implements AiProvider {
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
}
