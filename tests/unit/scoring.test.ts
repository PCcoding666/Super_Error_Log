import { describe, expect, it } from 'vitest';
import { scoreItem } from '../../src/domain/scoring.js';

describe('scoreItem', () => {
  it('知识/方法类错因（+30）高于计算失误（+10）', () => {
    const deep = scoreItem({
      cause: '知识概念', reviewValue: '可以再做', recurrenceCount: 0, isKeyGap: false, masteryFeeling: 2, backlogMissed: false,
    });
    const shallow = scoreItem({
      cause: '计算', reviewValue: '可以再做', recurrenceCount: 0, isKeyGap: false, masteryFeeling: 2, backlogMissed: false,
    });
    expect(deep.score).toBe(35);
    expect(shallow.score).toBe(15);
    expect(deep.score).toBeGreaterThan(shallow.score);
  });

  it('复发加分并封顶 +30', () => {
    const r = scoreItem({
      cause: null, reviewValue: null, recurrenceCount: 5, isKeyGap: false, masteryFeeling: 3, backlogMissed: false,
    });
    expect(r.score).toBe(30);
    expect(r.reasons.join('')).toContain('复发 5 次');
  });

  it('学生认为没必要但有复发 → 冲突标记 +20', () => {
    const r = scoreItem({
      cause: null, reviewValue: '没必要再做', recurrenceCount: 1, isKeyGap: false, masteryFeeling: 3, backlogMissed: false,
    });
    expect(r.conflict).toBe(true);
    expect(r.score).toBe(15 + 20);
    expect(r.reasons.join('')).toContain('冲突提示');
  });

  it('积压与低掌握感加分；总分封顶 100', () => {
    const r = scoreItem({
      cause: '方法选择', reviewValue: '必须再做', recurrenceCount: 3, isKeyGap: true, masteryFeeling: 0, backlogMissed: true,
    });
    expect(r.score).toBe(100);
    expect(r.reasons.length).toBeGreaterThanOrEqual(6);
  });

  it('无任何因素时给出低分与说明', () => {
    const r = scoreItem({
      cause: null, reviewValue: null, recurrenceCount: 0, isKeyGap: false, masteryFeeling: 3, backlogMissed: false,
    });
    expect(r.score).toBe(0);
    expect(r.reasons.join('')).toContain('复习价值较低');
  });
});
