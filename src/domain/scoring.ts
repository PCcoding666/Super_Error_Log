import type { Cause, MasteryFeeling, ReviewValue } from './types.js';

const DEEP_CAUSES: readonly Cause[] = ['知识概念', '方法选择', '推理步骤'];
const SHALLOW_CAUSES: readonly Cause[] = ['计算', '审题遗漏', '表达规范', '时间注意力状态'];

export interface ScoreInput {
  cause: Cause | null;
  reviewValue: ReviewValue | null;
  /** 同知识点或同错因的历史复发次数（不含本题） */
  recurrenceCount: number;
  /** 是否代表关键方法/前置知识缺口 */
  isKeyGap: boolean;
  masteryFeeling: MasteryFeeling | null;
  /** 曾被安排但未完成（积压） */
  backlogMissed: boolean;
}

export interface ScoreResult {
  score: number;
  reasons: string[];
  /** 学生认为没必要但系统证据显示复发 */
  conflict: boolean;
}

/** 可解释的复习价值评分（PRD §9.3），0–100 封顶 */
export function scoreItem(input: ScoreInput): ScoreResult {
  let score = 0;
  const reasons: string[] = [];
  let conflict = false;

  if (input.cause && DEEP_CAUSES.includes(input.cause)) {
    score += 30;
    reasons.push(`错因「${input.cause}」属于知识/方法类，值得延迟重做`);
  } else if (input.cause && SHALLOW_CAUSES.includes(input.cause)) {
    score += 10;
    reasons.push(`错因「${input.cause}」偏一次性失误，权重较低`);
  }

  if (input.recurrenceCount > 0) {
    const add = Math.min(30, input.recurrenceCount * 15);
    score += add;
    reasons.push(`同知识点/错因已复发 ${input.recurrenceCount} 次（+${add}）`);
  }

  if (input.reviewValue === '必须再做') {
    score += 15;
    reasons.push('学生自评「必须再做」');
  } else if (input.reviewValue === '可以再做') {
    score += 5;
    reasons.push('学生自评「可以再做」');
  }

  if (input.reviewValue === '没必要再做' && input.recurrenceCount > 0) {
    score += 20;
    conflict = true;
    reasons.push('冲突提示：学生认为没必要，但同类错误近期复发，建议保留');
  }

  if (input.isKeyGap) {
    score += 10;
    reasons.push('涉及关键方法或前置知识缺口');
  }

  if (input.masteryFeeling !== null && input.masteryFeeling <= 1) {
    score += 10;
    reasons.push('学生当前掌握感低');
  }

  if (input.backlogMissed) {
    score += 20;
    reasons.push('此前已安排但未完成（积压）');
  }

  if (reasons.length === 0) {
    reasons.push('无显著加分因素，复习价值较低');
  }

  return { score: Math.min(100, score), reasons, conflict };
}
