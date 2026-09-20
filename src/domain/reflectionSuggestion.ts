import type { AttemptState, Cause, ReviewValue } from './types.js';

/**
 * 反思环节的 AI 建议（仅供学生参考，绝不自动提交、不预选）。
 * 掌握感（masteryFeeling）永远不在建议中——它是「学生自评 vs 延迟重做结果」
 * 校准信号，AI 代建议会污染该信号。
 */
export interface ReflectionSuggestion {
  attemptState?: { value: AttemptState; confidence: number };
  cause?: { value: Cause; confidence: number };
  reviewValue?: { value: ReviewValue; confidence: number };
}

/** 一键采纳的置信度门槛：与 ai/provider.ts FIELD_CONFIDENCE_THRESHOLD 保持一致 */
export const ADOPT_CONFIDENCE_THRESHOLD = 0.6;

/** 三项建议齐全且置信度均达阈值，才允许出现「一键采纳」入口 */
export function isAdoptable(s: ReflectionSuggestion | null | undefined): boolean {
  if (!s) return false;
  return [s.attemptState, s.cause, s.reviewValue].every(
    (f) => f !== undefined && f.confidence >= ADOPT_CONFIDENCE_THRESHOLD,
  );
}

/**
 * 采纳提交的防篡改/防过期校验：提交的三项必须与服务器当前建议完全一致。
 * 不一致说明建议已变化（题目被编辑、证据过期）或请求被篡改，必须让学生重新看到。
 */
export function adoptionMatches(
  s: ReflectionSuggestion | null | undefined,
  values: { attemptState: string; cause: string; reviewValue: string },
): boolean {
  if (!isAdoptable(s)) return false;
  return (
    s!.attemptState!.value === values.attemptState &&
    s!.cause!.value === values.cause &&
    s!.reviewValue!.value === values.reviewValue
  );
}
