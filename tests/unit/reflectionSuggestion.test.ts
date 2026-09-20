import { describe, expect, it } from 'vitest';
import {
  adoptionMatches,
  isAdoptable,
  type ReflectionSuggestion,
} from '../../src/domain/reflectionSuggestion.js';

describe('反思 AI 建议的可采纳规则', () => {
  const high: ReflectionSuggestion = {
    attemptState: { value: '本来会但审题计算书写失误', confidence: 0.9 },
    cause: { value: '计算', confidence: 0.88 },
    reviewValue: { value: '可以再做', confidence: 0.86 },
  };

  it('三项齐全且置信度均达阈值 → 可一键采纳', () => {
    expect(isAdoptable(high)).toBe(true);
  });

  it('任一项缺失 → 不可采纳（掌握感永远不在建议中）', () => {
    expect(isAdoptable({ ...high, attemptState: undefined })).toBe(false);
    expect(isAdoptable({ ...high, cause: undefined })).toBe(false);
    expect(isAdoptable({ ...high, reviewValue: undefined })).toBe(false);
    expect(isAdoptable(null)).toBe(false);
    expect(isAdoptable({})).toBe(false);
  });

  it('任一项低于阈值 → 不可采纳（低置信仍需学生逐项判断）', () => {
    expect(isAdoptable({ ...high, cause: { value: '计算', confidence: 0.5 } })).toBe(false);
    expect(isAdoptable({ ...high, attemptState: { value: '其他', confidence: 0.59 } })).toBe(false);
  });

  it('采纳提交必须与当前建议一致（防篡改/防过期）', () => {
    expect(adoptionMatches(high, {
      attemptState: '本来会但审题计算书写失误', cause: '计算', reviewValue: '可以再做',
    })).toBe(true);
    expect(adoptionMatches(high, {
      attemptState: '完全不会', cause: '计算', reviewValue: '可以再做',
    })).toBe(false);
    expect(adoptionMatches(high, {
      attemptState: '本来会但审题计算书写失误', cause: '知识概念', reviewValue: '可以再做',
    })).toBe(false);
    expect(adoptionMatches(high, {
      attemptState: '本来会但审题计算书写失误', cause: '计算', reviewValue: '必须再做',
    })).toBe(false);
    expect(adoptionMatches(null, {
      attemptState: '本来会但审题计算书写失误', cause: '计算', reviewValue: '可以再做',
    })).toBe(false);
  });
});
