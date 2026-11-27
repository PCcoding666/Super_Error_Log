import { describe, expect, it } from 'vitest';
import { assignUniqueSideDiagramNumbers, coveredOptionRow, intakeGroupKey, isOptionOnlyText, isRejectedQuestion, mergeOptionOnlyFragments, selectableQuestion } from '../../src/materials/regionPolicy.js';

const box = { x: 0.02, y: 0.28, width: 0.68, height: 0.15 };

describe('question admission', () => {
  it('rejects only a question the verifier says is the wrong role', () => {
    const heading = { role: 'question', uncertainties: ['role_mismatch'] };
    expect(isRejectedQuestion(heading)).toBe(true);
    expect(selectableQuestion(heading)).toBe(false);
    expect(intakeGroupKey({ ...heading, fragmentId: 'mfr_heading', number: '4' })).toBe('rejected:mfr_heading');
  });

  it('keeps a short unnumbered question and a text mismatch selectable', () => {
    const short = { role: 'question', uncertainties: [] as string[], fragmentId: 'mfr_short', number: null };
    const mismatched = { role: 'question', uncertainties: ['text_mismatch'], fragmentId: 'mfr_text', number: '3' };
    expect(selectableQuestion(short)).toBe(true);
    expect(selectableQuestion(mismatched)).toBe(true);
    expect(intakeGroupKey(short)).toBe('unknown:mfr_short');
    expect(intakeGroupKey(mismatched)).toBe('number:3');
  });
});

describe('side diagram association', () => {
  it('copies the printed number onto one right-hand diagram and does not move either box', () => {
    const question = { role: 'question', number: '4', page: 1, subpart: null, box: { ...box } };
    const diagram = { role: 'diagram', number: null as string | null, page: 1, subpart: null, box: { x: 0.72, y: 0.30, width: 0.24, height: 0.12 } };
    const before = { question: { ...question.box }, diagram: { ...diagram.box } };
    assignUniqueSideDiagramNumbers([question, diagram]);
    expect(diagram.number).toBe('4');
    expect(question.box).toEqual(before.question);
    expect(diagram.box).toEqual(before.diagram);
  });

  it('keeps an options row beside its stem and does not raise a shared options line above a weaker check', () => {
    expect(isOptionOnlyText('A. 2  B. 4  C. 6  D. 8')).toBe(true);
    expect(isOptionOnlyText('A．2\nB．4\nC．6\nD．8')).toBe(true);
    expect(isOptionOnlyText('1. 求 x 的值\nA. 1\nB. 2')).toBe(false);
    const stem = { role: 'question', text: '1. 求 x 的值。', number: '1', subpart: null, page: 1, order: 0, check: 'passed' as const, uncertainties: [] as string[] };
    const options = { role: 'question', text: 'A. 2  B. 4  C. 6  D. 8', number: '1', subpart: null, page: 1, order: 1, check: 'failed' as const, uncertainties: ['text_mismatch'] };
    const other = { role: 'question', text: '2. 求 y。', number: '2', subpart: null, page: 1, order: 2, check: 'passed' as const, uncertainties: [] as string[] };
    const merged = mergeOptionOnlyFragments([stem, options, other]);
    expect(merged).toEqual([stem, options, other]);
    expect(stem.text).toBe('1. 求 x 的值。');
    expect(stem.check).toBe('passed');
    expect(options.check).toBe('failed');
    expect(coveredOptionRow(options, merged)).toBe(true);
    expect(coveredOptionRow(stem, merged)).toBe(false);
    const first = { role: 'question', text: 'A. 1  B. 2', number: '3', subpart: null, page: 1, order: 0, check: 'passed' as const, uncertainties: [] as string[] };
    const second = { role: 'question', text: 'C. 3  D. 4', number: '3', subpart: null, page: 1, order: 1, check: 'low' as const, uncertainties: ['text_mismatch'] };
    mergeOptionOnlyFragments([first, second]);
    expect(first.text).toBe('A. 1  B. 2\nC. 3  D. 4');
    expect(first.check).toBe('low');
    expect(first.uncertainties).toEqual(['text_mismatch']);
    expect(second.check).toBe('low');
    expect(coveredOptionRow(second, [first, second])).toBe(true);
    expect(coveredOptionRow(first, [first, second])).toBe(false);
  });

  it('leaves the diagram unnumbered when two questions could own it', () => {
    const upper = { role: 'question', number: '4', page: 1, subpart: null, box: { x: 0.02, y: 0.20, width: 0.68, height: 0.20 } };
    const lower = { role: 'question', number: '5', page: 1, subpart: null, box: { x: 0.02, y: 0.35, width: 0.68, height: 0.20 } };
    const diagram = { role: 'diagram', number: null as string | null, page: 1, subpart: null, box: { x: 0.72, y: 0.25, width: 0.24, height: 0.25 } };
    assignUniqueSideDiagramNumbers([upper, lower, diagram]);
    expect(diagram.number).toBeNull();
  });
});
