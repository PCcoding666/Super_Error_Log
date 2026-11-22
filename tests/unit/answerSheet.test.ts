import { describe, expect, it } from 'vitest';
import { normalizeSubpart, pageLooksLikePaper, pageLooksLikeSheet, recognizePairing } from '../../src/materials/answerSheet.js';
import { markOutcome } from '../../src/materials/learning.js';

describe('answer sheet pairing', () => {
  it('trusts page tags and does not infer over a mixed worksheet page', () => {
    expect(recognizePairing([
      { pageKind: 'answer_sheet', roles: [] },
      { pageKind: 'paper', roles: [] },
    ])).toBe('paired');
    expect(recognizePairing([
      { pageKind: null, roles: ['question', 'teacher_mark'] },
      { pageKind: null, roles: ['teacher_mark'] },
    ])).toBe('worksheet');
    expect(recognizePairing([{ pageKind: 'paper', roles: ['question', 'teacher_mark'] }])).toBe('worksheet');
  });

  it('infers a pair only when every untagged page is unambiguously one side', () => {
    expect(pageLooksLikePaper(['question', 'diagram'])).toBe(true);
    expect(pageLooksLikeSheet(['teacher_mark', 'student_work'])).toBe(true);
    expect(recognizePairing([
      { pageKind: null, roles: ['question', 'diagram'] },
      { pageKind: null, roles: ['teacher_mark', 'student_work'] },
    ])).toBe('paired');
    expect(recognizePairing([
      { pageKind: 'answer_sheet', roles: ['teacher_mark'] },
      { pageKind: null, roles: ['question'] },
    ])).toBe('paired');
    expect(recognizePairing([
      { pageKind: null, roles: ['question'] },
      { pageKind: null, roles: ['question'] },
    ])).toBe('worksheet');
  });

  it('normalizes a printed subpart without changing a different blank into the same one', () => {
    expect(normalizeSubpart(' （2） ')).toBe('(2)');
    expect(normalizeSubpart('(2)')).not.toBe(normalizeSubpart('(2)⑤'));
    expect(normalizeSubpart(null)).toBeNull();
  });

  it('keeps a cross wrong and a deduction partial', () => {
    expect(markOutcome('×', null)).toBe('wrong');
    expect(markOutcome('√', null)).toBe('right');
    expect(markOutcome('-2', null)).toBe('partial');
    expect(markOutcome('半对', null)).toBe('partial');
    expect(markOutcome('写了步骤', null)).toBeNull();
  });
});
