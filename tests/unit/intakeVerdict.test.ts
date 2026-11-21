import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  canAddCandidate, detailLead, orderCandidates, outcomeLabel, pageNote, processLabel, readVerdict, shouldPreselect,
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
    expect(outcomeLabel(null)).toBeNull();
    expect(outcomeLabel('wrong')).toBe('做错');
    expect(outcomeLabel('partial')).toBe('部分做错');
    expect(outcomeLabel('right')).toBe('做对');
    expect(outcomeLabel('confirm')).toBe('请确认');
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

  it('never uses recognition-confidence wording in intake copy', () => {
    const lines = [
      outcomeLabel('wrong'), outcomeLabel('partial'), outcomeLabel('right'), outcomeLabel('confirm'),
      processLabel('preliminary'), processLabel('verifying'),
      pageNote(false, false), pageNote(true, false), pageNote(true, true),
      detailLead('wrong', 'needs_review')?.text,
      detailLead('partial', 'needs_review')?.text,
      detailLead('right', 'verified')?.text,
      detailLead('confirm', 'needs_review')?.text,
      detailLead(null, 'preliminary')?.text,
      detailLead(null, 'needs_review')?.text,
    ];
    for (const line of lines) expect(line ?? '').not.toContain(banned);
    expect(detailLead(null, 'needs_review')).toBeNull();
    expect(detailLead('confirm', 'needs_review')?.text).toBe('请确认是不是做错了。');
    expect(detailLead('wrong', 'needs_review')?.tone).toBe('focus');
    for (const file of [
      'client/src/lib/intakeVerdict.ts',
      'client/src/pages/IntakePage.tsx',
      'client/src/components/CandidateDetailModal.tsx',
    ]) {
      expect(readFileSync(file, 'utf8')).not.toContain(banned);
    }
  });
});
