import { describe, expect, it } from 'vitest';
import { canArchive, statusAfterAttempt, statusAfterReflection } from '../../src/domain/stateMachine.js';

describe('statusAfterAttempt', () => {
  it('延迟 4 天独立做对 → temporarily_mastered', () => {
    const t = statusAfterAttempt('packet_generated', {
      completion: 'independent',
      correct: true,
      delayDays: 4,
      isConfirmation: false,
    });
    expect(t.to).toBe('temporarily_mastered');
  });

  it('当场（<3 天）独立做对不算延迟掌握 → attempted', () => {
    const t = statusAfterAttempt('packet_generated', {
      completion: 'independent',
      correct: true,
      delayDays: 1,
      isConfirmation: false,
    });
    expect(t.to).toBe('attempted');
    expect(t.reason).toContain('不构成延迟掌握');
  });

  it('确认轮独立做对 → stably_mastered', () => {
    const t = statusAfterAttempt('temporarily_mastered', {
      completion: 'independent',
      correct: true,
      delayDays: 10,
      isConfirmation: true,
    });
    expect(t.to).toBe('stably_mastered');
  });

  it('使用提示即使做对 → needs_recheck', () => {
    const t = statusAfterAttempt('packet_generated', {
      completion: 'hint_used',
      correct: true,
      delayDays: 5,
      isConfirmation: false,
    });
    expect(t.to).toBe('needs_recheck');
  });

  it('做出但不确定 → needs_recheck', () => {
    const t = statusAfterAttempt('packet_generated', {
      completion: 'unsure',
      correct: true,
      delayDays: 5,
      isConfirmation: false,
    });
    expect(t.to).toBe('needs_recheck');
  });

  it('独立做错 → needs_recheck', () => {
    const t = statusAfterAttempt('packet_generated', {
      completion: 'independent',
      correct: false,
      delayDays: 5,
      isConfirmation: false,
    });
    expect(t.to).toBe('needs_recheck');
  });

  it('未完成 → needs_recheck（积压）', () => {
    const t = statusAfterAttempt('packet_generated', {
      completion: 'unfinished',
      correct: false,
      delayDays: 5,
      isConfirmation: false,
    });
    expect(t.to).toBe('needs_recheck');
    expect(t.reason).toContain('未完成');
  });

  it('确认轮离上次作答不足 3 天做对：保持 temporarily_mastered，不降级（P0-3）', () => {
    for (const delayDays of [0, 1, 2]) {
      const t = statusAfterAttempt('temporarily_mastered', {
        completion: 'independent',
        correct: true,
        delayDays,
        isConfirmation: true,
      });
      expect(t.to).toBe('temporarily_mastered');
    }
  });

  it('确认轮刚好隔 3 天独立做对 → stably_mastered', () => {
    const t = statusAfterAttempt('temporarily_mastered', {
      completion: 'independent',
      correct: true,
      delayDays: 3,
      isConfirmation: true,
    });
    expect(t.to).toBe('stably_mastered');
  });

  it('确认轮失败 → needs_recheck', () => {
    const t = statusAfterAttempt('temporarily_mastered', {
      completion: 'independent',
      correct: false,
      delayDays: 10,
      isConfirmation: true,
    });
    expect(t.to).toBe('needs_recheck');
  });

  it('不可作答状态保持原样', () => {
    const t = statusAfterAttempt('eligible_for_review', {
      completion: 'independent',
      correct: true,
      delayDays: 5,
      isConfirmation: false,
    });
    expect(t.to).toBe('eligible_for_review');
  });
});

describe('statusAfterReflection', () => {
  it('ready_for_reflection → eligible_for_review', () => {
    expect(statusAfterReflection('ready_for_reflection').to).toBe('eligible_for_review');
  });
  it('已稳定掌握不受反思提交影响', () => {
    expect(statusAfterReflection('stably_mastered').to).toBe('stably_mastered');
  });
});

describe('canArchive', () => {
  it('学生认为没必要且无复发 → 可归档', () => {
    expect(canArchive({ reviewValue: '没必要再做', recurrenceCount: 0, masteryFeeling: 3 }).ok).toBe(true);
  });
  it('有复发证据 → 不可归档', () => {
    const r = canArchive({ reviewValue: '没必要再做', recurrenceCount: 2, masteryFeeling: 3 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('复发');
  });
  it('学生未判定没必要 → 不可归档', () => {
    expect(canArchive({ reviewValue: '必须再做', recurrenceCount: 0, masteryFeeling: 3 }).ok).toBe(false);
  });
});
