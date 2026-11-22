import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  canAddCandidate, detailLead, focusScrollPlan, orderCandidates, pageNote, processLabel, readVerdict, shouldPreselect,
} from '../../client/src/lib/intakeVerdict.js';

const banned = '不确定处';

describe('intake verdict presentation', () => {
  it('reads only the four student-facing verdicts', () => {
    expect(readVerdict('wrong')).toBe('wrong');
    expect(readVerdict('partial')).toBe('partial');
    expect(readVerdict('right')).toBe('right');
    expect(readVerdict('confirm')).toBe('confirm');
    expect(readVerdict('needs_review')).toBeNull();
    expect(readVerdict(undefined)).toBeNull();
  });

  it('keeps printed order when the page has no wrong verdict', () => {
    const page = [
      { id: '1', verdict: 'confirm' },
      { id: '2' },
      { id: '3', verdict: 'right' },
      { id: '4', verdict: 'confirm' },
    ];
    expect(orderCandidates(page).map(row => row.candidate.id)).toEqual(['1', '2', '3', '4']);
    expect(orderCandidates(page).every(row => !row.focus)).toBe(true);
  });

  it('sorts wrong and partial first and leaves the rest in printed order', () => {
    const page = [
      { id: '1', verdict: 'partial' },
      { id: '2', verdict: 'right' },
      { id: '3', verdict: 'confirm' },
      { id: '4' },
      { id: '8', verdict: 'wrong' },
    ];
    const ordered = orderCandidates(page);
    expect(ordered.map(row => row.candidate.id)).toEqual(['1', '8', '2', '3', '4']);
    expect(ordered.filter(row => row.focus).map(row => row.verdict)).toEqual(['partial', 'wrong']);
    expect(ordered.find(row => row.candidate.id === '2')?.verdict).toBe('right');
  });

  it('does not offer a right row on the add path, and does not treat an uncertain mark as wrong', () => {
    expect(canAddCandidate('right')).toBe(false);
    expect(canAddCandidate('wrong')).toBe(true);
    expect(canAddCandidate('partial')).toBe(true);
    expect(canAddCandidate('confirm')).toBe(true);
    expect(canAddCandidate(null)).toBe(true);
    expect(shouldPreselect({ id: 'w', verdict: 'wrong', preselected: true }, false)).toBe(true);
    expect(shouldPreselect({ id: 'p', verdict: 'partial', preselected: true }, false)).toBe(true);
    expect(shouldPreselect({ id: 'r', verdict: 'right', preselected: true }, false)).toBe(false);
    expect(shouldPreselect({ id: 'c', verdict: 'confirm', preselected: true }, false)).toBe(true);
    expect(shouldPreselect({ id: 't', verdict: 'wrong', preselected: true }, true)).toBe(false);
    expect(shouldPreselect({ id: 's', verdict: 'wrong', preselected: true, submitted: true }, false)).toBe(false);
    expect(shouldPreselect({ id: 'n', verdict: 'wrong', preselected: 'yes' }, false)).toBe(false);
    expect(shouldPreselect({ id: 'u', preselected: true }, false)).toBe(true);
  });

  it('scrolls only the first new wrong row and remembers the rest of that paint', () => {
    const first = focusScrollPlan(['a', 'b', 'c'], new Set());
    expect(first).toEqual({ target: 'a', remember: ['a', 'b', 'c'] });
    const seen = new Set(first.remember);
    expect(focusScrollPlan(['a', 'b', 'c'], seen)).toEqual({ target: null, remember: ['a', 'b', 'c'] });
    expect(focusScrollPlan(['a', 'b', 'c', 'd'], seen)).toEqual({ target: 'd', remember: ['a', 'b', 'c', 'd'] });
    expect(focusScrollPlan(['', 'b'], new Set())).toEqual({ target: 'b', remember: ['b'] });
  });

  it('uses a page prompt instead of a repeated outcome when nothing is wrong', () => {
    expect(pageNote(false, false)).toContain('勾出做错的题');
    expect(pageNote(true, false)).toContain('勾出做错的题');
    expect(pageNote(false, true)).toContain('排在前面');
    expect(processLabel('preliminary')).toBe('可以先看图勾选');
    expect(processLabel('verifying')).toBe('还在整理，可以先勾选');
    expect(processLabel('needs_review')).toBeNull();
    expect(processLabel('verified')).toBeNull();
    expect(processLabel(undefined)).toBeNull();
  });

  it('never stamps a row or detail sheet with an AI verdict, or with recognition-confidence wording', () => {
    const lines = [
      processLabel('preliminary'), processLabel('verifying'),
      processLabel('needs_review'), processLabel('verified'),
      detailLead('preliminary'), detailLead('verifying'), detailLead('needs_review'), detailLead('verified'),
    ];
    for (const line of lines) {
      expect(line ?? '').not.toContain(banned);
      expect(line ?? '').not.toContain('部分做错');
      expect(line ?? '').not.toContain('做对');
      expect(line ?? '').not.toContain('请确认');
    }
    expect(detailLead('needs_review')).toBeNull();
    expect(detailLead('preliminary')).toBe('可以先看图勾选。');
    expect(pageNote(true, true)).toContain('排在前面');
    expect(pageNote(true, true)).not.toContain('部分做错');
    expect(pageNote(true, true)).not.toContain('做对');
    expect(pageNote(true, true)).not.toContain('请确认');
    const rowStamps = ['部分做错', '做对', '请确认'];
    for (const file of [
      'client/src/lib/intakeVerdict.ts',
      'client/src/pages/IntakePage.tsx',
      'client/src/components/CandidateDetailModal.tsx',
    ]) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toContain(banned);
      for (const stamp of rowStamps) expect(source).not.toContain(stamp);
    }
  });
});
