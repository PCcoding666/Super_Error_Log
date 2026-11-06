import { describe, expect, it } from 'vitest';
import {
  INTAKE_SELECT_LIMIT, intakePickKey, pagePickState, prunePhotoPicks, selectDisplayedPage, selectionCountText, selectionTotals,
} from '../../src/web/intakeSelection.js';

describe('intake page selection', () => {
  it('selects and clears only the candidates on screen', () => {
    const displayed = ['a', 'b'];
    const hidden = ['kept'];
    expect(pagePickState([...hidden, 'a'], displayed)).toBe('some');
    expect(pagePickState([...hidden, 'a', 'b'], displayed)).toBe('all');
    expect(pagePickState(hidden, displayed)).toBe('none');
    expect(pagePickState([], [])).toBe('none');
    const all = selectDisplayedPage([...hidden, 'a'], displayed, 120, 'all');
    expect(all).toEqual({ ids: ['kept', 'a', 'b'], truncated: false });
    expect(selectDisplayedPage(all.ids, displayed, 120, 'none')).toEqual({ ids: ['kept'], truncated: false });
  });

  it('stops at the save cap and keeps selections that are not on this page', () => {
    const displayed = ['a', 'b', 'c', 'd'];
    const capped = selectDisplayedPage(['hidden'], displayed, 3, 'all');
    expect(capped.ids).toEqual(['hidden', 'a', 'b']);
    expect(capped.truncated).toBe(true);
    const already = selectDisplayedPage(['hidden', 'd'], displayed, 3, 'all');
    expect(already.ids).toEqual(['hidden', 'a', 'd']);
    expect(already.truncated).toBe(true);
    expect(INTAKE_SELECT_LIMIT).toEqual({ materials: 120, legacy: 30 });
  });

  it('counts hidden selections separately and does not drop them when the list is filtered', () => {
    const picks = { page: ['shown', 'hidden'], other: ['away'] };
    const visible = new Set([intakePickKey('page', 'shown')]);
    expect(selectionTotals(picks, visible)).toEqual({ total: 3, visible: 1, hidden: 2 });
    expect(selectionCountText(3, 2)).toBe('已选 3 题（其中 2 题不在当前列表，仍会保留）');
    expect(selectionCountText(1, 0)).toBe('已选 1 题');
    const filtered = prunePhotoPicks(picks, [{ id: 'page', candidateIds: ['shown'] }], false);
    expect(filtered.changed).toBe(true);
    expect(filtered.picks).toEqual({ page: ['shown'], other: ['away'] });
    const full = prunePhotoPicks(picks, [{ id: 'page', candidateIds: ['shown'] }], true);
    expect(full.picks).toEqual({ page: ['shown'] });
    expect(prunePhotoPicks({ page: ['shown'] }, [{ id: 'page', candidateIds: ['shown'] }], true).changed).toBe(false);
  });
});
