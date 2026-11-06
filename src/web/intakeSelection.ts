/** One 加入 request. Materials keeps 120; the legacy handler used to keep 30 by slicing quietly. */
export const INTAKE_SELECT_LIMIT = { materials: 120, legacy: 30 } as const;

export type PagePickState = 'none' | 'some' | 'all';

/** Stable across candidate ids that themselves contain colons (`questionId:revision`). */
export function intakePickKey(photoId: string, candidateId: string): string {
  return `${photoId}\u0000${candidateId}`;
}

/** `displayed` is only the candidates on screen for one source page. */
export function pagePickState(selected: readonly string[], displayed: readonly string[]): PagePickState {
  if (!displayed.length) return 'none';
  const picked = new Set(selected);
  let count = 0;
  for (const id of displayed) if (picked.has(id)) count += 1;
  if (count === 0) return 'none';
  return count === displayed.length ? 'all' : 'some';
}

/**
 * Select or clear the displayed ids. Ids that are not displayed stay.
 * Selecting never drops an id the student already chose, and never grows past `limit`.
 * `truncated` means at least one displayed candidate was left unselected because of that cap.
 */
export function selectDisplayedPage(
  selected: readonly string[],
  displayed: readonly string[],
  limit: number,
  mode: 'all' | 'none',
): { ids: string[]; truncated: boolean } {
  const shown = new Set(displayed);
  const hidden = selected.filter(id => !shown.has(id));
  if (mode === 'none') return { ids: hidden, truncated: false };
  const picked = new Set(selected);
  const already = displayed.filter(id => picked.has(id));
  const rest = displayed.filter(id => !picked.has(id));
  const room = Math.max(0, limit - hidden.length - already.length);
  const added = new Set(rest.slice(0, room));
  const ids = [...hidden, ...displayed.filter(id => picked.has(id) || added.has(id))];
  return { ids, truncated: added.size < rest.length };
}

export function selectionTotals(
  picks: Record<string, Iterable<string>>,
  visible: ReadonlySet<string>,
): { total: number; visible: number; hidden: number } {
  let total = 0;
  let shown = 0;
  for (const [photoId, ids] of Object.entries(picks)) {
    for (const id of ids) {
      total += 1;
      if (visible.has(intakePickKey(photoId, id))) shown += 1;
    }
  }
  return { total, visible: shown, hidden: total - shown };
}

/** Hidden picks stay selected. The note says so instead of pretending the count is only what is on screen. */
export function selectionCountText(total: number, hidden: number): string {
  if (hidden > 0) return `已选 ${total} 题（其中 ${hidden} 题不在当前列表，仍会保留）`;
  return `已选 ${total} 题`;
}

/**
 * Drop ids the latest list no longer offers for a photo we can see.
 * Photos absent from this response are removed only when the response is the full list
 * (`dropMissingPhotos`). A date page must not wipe selections that belong to another day.
 */
export function prunePhotoPicks(
  picks: Record<string, Iterable<string>>,
  photos: readonly { id: string; candidateIds: readonly string[] }[],
  dropMissingPhotos: boolean,
): { picks: Record<string, string[]>; changed: boolean } {
  const allowed = new Map(photos.map(photo => [photo.id, new Set(photo.candidateIds)]));
  const next: Record<string, string[]> = {};
  let changed = false;
  for (const [photoId, ids] of Object.entries(picks)) {
    const list = [...ids];
    const valid = allowed.get(photoId);
    if (!valid) {
      if (dropMissingPhotos) {
        if (list.length) changed = true;
        continue;
      }
      next[photoId] = list;
      continue;
    }
    const kept = list.filter(id => valid.has(id));
    if (kept.length !== list.length) changed = true;
    next[photoId] = kept;
  }
  return { picks: next, changed };
}
