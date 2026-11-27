/** Optimistic intake deletes: hide on confirm, then serialize the requests. */

export interface CandidateDeleteBatch {
  photoId: string;
  ids: string[];
}

export type PickMap = Record<string, Set<string>>;

export interface CandidateHide {
  hidden: Set<string>;
  picks: PickMap;
  /** Selected ids to put back if this delete does not remove them. */
  restorePicks: { photoId: string; id: string }[];
}

/** Hide every requested row and drop it from the selected count. Does not mutate the inputs. */
export function applyCandidateHide(
  hidden: ReadonlySet<string>,
  picks: Readonly<Record<string, ReadonlySet<string>>>,
  batches: readonly CandidateDeleteBatch[],
): CandidateHide {
  const nextHidden = new Set(hidden);
  const nextPicks: PickMap = {};
  for (const [photoId, ids] of Object.entries(picks)) nextPicks[photoId] = new Set(ids);
  const restorePicks: { photoId: string; id: string }[] = [];
  for (const batch of batches) {
    const set = nextPicks[batch.photoId] ?? new Set<string>();
    nextPicks[batch.photoId] = set;
    for (const id of batch.ids) {
      nextHidden.add(id);
      if (set.delete(id)) restorePicks.push({ photoId: batch.photoId, id });
    }
  }
  return { hidden: nextHidden, picks: nextPicks, restorePicks };
}

/**
 * Put failed rows back. Ids that were not selected stay unselected.
 * Successful ids are left hidden. Does not mutate the inputs.
 */
export function restoreCandidateHide(
  hidden: ReadonlySet<string>,
  picks: Readonly<Record<string, ReadonlySet<string>>>,
  restorePicks: readonly { photoId: string; id: string }[],
  failedIds: ReadonlySet<string>,
): { hidden: Set<string>; picks: PickMap } {
  const nextHidden = new Set(hidden);
  for (const id of failedIds) nextHidden.delete(id);
  const nextPicks: PickMap = {};
  for (const [photoId, ids] of Object.entries(picks)) nextPicks[photoId] = new Set(ids);
  for (const pick of restorePicks) {
    if (!failedIds.has(pick.id)) continue;
    const set = nextPicks[pick.photoId] ?? new Set<string>();
    set.add(pick.id);
    nextPicks[pick.photoId] = set;
  }
  return { hidden: nextHidden, picks: nextPicks };
}

/**
 * A 409 retry can remove a newer revision id than the one the student confirmed.
 * `kept` is the requested ids that were removed. `hideAlso` is a replacement id the list might still paint.
 */
export function matchDismissResult(
  requested: readonly string[],
  sent: readonly string[],
  removed: readonly string[],
): { kept: string[]; failed: string[]; hideAlso: string[] } {
  const gone = new Set(removed);
  const kept: string[] = [];
  const failed: string[] = [];
  const hideAlso: string[] = [];
  for (let index = 0; index < requested.length; index += 1) {
    const asked = requested[index]!;
    const actual = sent[index] ?? asked;
    if (gone.has(asked) || gone.has(actual)) {
      kept.push(asked);
      if (actual !== asked) hideAlso.push(actual);
    } else failed.push(asked);
  }
  return { kept, failed, hideAlso };
}

/**
 * A newer list that still contains an id shows that row again.
 * Ids in `inFlight` stay hidden so a poll cannot undo a confirm that has not finished.
 * Returns null when nothing changes, so the caller can keep the same set.
 */
export function reconcileHidden(
  hidden: ReadonlySet<string>,
  present: ReadonlySet<string>,
  inFlight: ReadonlySet<string>,
): Set<string> | null {
  let changed = false;
  const next = new Set<string>();
  for (const id of hidden) {
    if (present.has(id) && !inFlight.has(id)) {
      changed = true;
      continue;
    }
    next.add(id);
  }
  return changed ? next : null;
}

export function deleteFailureMessage(removedCount: number, failures: readonly string[]): string {
  const details = [...new Set(failures.map(message => message.trim()).filter(Boolean))];
  const detail = details.join(' ') || '请刷新后再试。';
  if (removedCount > 0) return `已经去掉 ${removedCount} 道。没去掉的还在列表里：${detail}`;
  return `没有去掉，还在列表里：${detail}`;
}

export interface DeleteQueue {
  readonly pending: number;
  enqueue<T>(task: () => Promise<T>): Promise<T>;
}

/** Run deletes one at a time. A rejection does not drop the next task. */
export function createDeleteQueue(): DeleteQueue {
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;
  return {
    get pending() { return pending; },
    enqueue<T>(task: () => Promise<T>): Promise<T> {
      pending += 1;
      const run = tail.then(task, task);
      tail = run.then(() => {
        pending -= 1;
      }, () => {
        pending -= 1;
      });
      return run;
    },
  };
}
