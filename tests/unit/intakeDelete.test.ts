import { describe, expect, it } from 'vitest';
import {
  applyCandidateHide, createDeleteQueue, deleteFailureMessage, matchDismissResult, reconcileHidden, restoreCandidateHide,
} from '../../client/src/lib/intakeDelete.js';

function picks(source: Record<string, string[]>): Record<string, Set<string>> {
  return Object.fromEntries(Object.entries(source).map(([photoId, ids]) => [photoId, new Set(ids)]));
}

describe('optimistic intake delete', () => {
  it('hides the confirmed rows and drops them from the selected count immediately', () => {
    const hidden = new Set(['already']);
    const selected = picks({ photo: ['a', 'b', 'keep'], other: ['away'] });
    const applied = applyCandidateHide(hidden, selected, [{ photoId: 'photo', ids: ['a', 'b'] }]);
    expect([...applied.hidden].sort()).toEqual(['a', 'already', 'b']);
    expect([...applied.picks.photo!].sort()).toEqual(['keep']);
    expect([...applied.picks.other!]).toEqual(['away']);
    expect(applied.restorePicks).toEqual([{ photoId: 'photo', id: 'a' }, { photoId: 'photo', id: 'b' }]);
    expect(selected.photo!.has('a')).toBe(true);
    expect(hidden.has('a')).toBe(false);
  });

  it('restores only the rows the request did not remove, including an unselected per-row delete', () => {
    const hidden = new Set(['a', 'b', 'c']);
    const selected = picks({ photo: [] });
    const restored = restoreCandidateHide(hidden, selected, [
      { photoId: 'photo', id: 'a' },
      { photoId: 'photo', id: 'b' },
    ], new Set(['b', 'c']));
    expect([...restored.hidden].sort()).toEqual(['a']);
    expect([...restored.picks.photo!]).toEqual(['b']);
  });

  it('keeps a row hidden when a reload still lists it during an in-flight delete', () => {
    const hidden = new Set(['a', 'b']);
    expect(reconcileHidden(hidden, new Set(['a', 'b']), new Set(['a', 'b']))).toBeNull();
    const settled = reconcileHidden(hidden, new Set(['a']), new Set());
    expect(settled).toEqual(new Set(['b']));
    expect(reconcileHidden(hidden, new Set(), new Set())).toBeNull();
  });

  it('treats a refreshed revision id as the same removed row', () => {
    expect(matchDismissResult(['q:1', 'r:1'], ['q:2', 'r:1'], ['q:2'])).toEqual({
      kept: ['q:1'],
      failed: ['r:1'],
      hideAlso: ['q:2'],
    });
  });

  it('keeps the existing failure copy', () => {
    expect(deleteFailureMessage(0, ['请刷新后再试。'])).toBe('没有去掉，还在列表里：请刷新后再试。');
    expect(deleteFailureMessage(2, ['请刷新后再试。', '请刷新后再试。'])).toBe('已经去掉 2 道。没去掉的还在列表里：请刷新后再试。');
    expect(deleteFailureMessage(0, ['', '  '])).toBe('没有去掉，还在列表里：请刷新后再试。');
  });

  it('runs a second confirm only after the first delete settles', async () => {
    const queue = createDeleteQueue();
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const order: string[] = [];
    const first = queue.enqueue(async () => {
      order.push('first-start');
      await firstGate;
      order.push('first-end');
    });
    const second = queue.enqueue(async () => {
      order.push('second-start');
    });
    await Promise.resolve();
    expect(order).toEqual(['first-start']);
    expect(queue.pending).toBe(2);
    releaseFirst();
    await first;
    await second;
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
    expect(queue.pending).toBe(0);
  });

  it('still runs the next delete when the first one fails', async () => {
    const queue = createDeleteQueue();
    const order: string[] = [];
    const first = queue.enqueue(async () => {
      order.push('first');
      throw new Error('dismiss failed');
    });
    const second = queue.enqueue(async () => {
      order.push('second');
    });
    await expect(first).rejects.toThrow('dismiss failed');
    await second;
    expect(order).toEqual(['first', 'second']);
    expect(queue.pending).toBe(0);
  });
});
