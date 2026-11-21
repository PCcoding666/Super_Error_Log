import { describe, expect, it } from 'vitest';
import { assignUniqueSideDiagramNumbers, intakeGroupKey, isRejectedQuestion, selectableQuestion } from '../../src/materials/regionPolicy.js';

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

  it('leaves the diagram unnumbered when two questions could own it', () => {
    const upper = { role: 'question', number: '4', page: 1, subpart: null, box: { x: 0.02, y: 0.20, width: 0.68, height: 0.20 } };
    const lower = { role: 'question', number: '5', page: 1, subpart: null, box: { x: 0.02, y: 0.35, width: 0.68, height: 0.20 } };
    const diagram = { role: 'diagram', number: null as string | null, page: 1, subpart: null, box: { x: 0.72, y: 0.25, width: 0.24, height: 0.25 } };
    assignUniqueSideDiagramNumbers([upper, lower, diagram]);
    expect(diagram.number).toBeNull();
  });
});
