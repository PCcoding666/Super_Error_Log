/** Student-facing intake presentation. The grading pipeline owns `verdict` and `preselected`. */

export type IntakeVerdict = 'wrong' | 'partial' | 'right' | 'confirm';

const VERDICTS: readonly IntakeVerdict[] = ['wrong', 'partial', 'right', 'confirm'];

export function readVerdict(value: unknown): IntakeVerdict | null {
  return typeof value === 'string' && (VERDICTS as readonly string[]).includes(value) ? value as IntakeVerdict : null;
}

/** Wrong and partial are the rows a student should land on first. */
export function isFocusVerdict(verdict: IntakeVerdict | null): boolean {
  return verdict === 'wrong' || verdict === 'partial';
}

/** Right answers stay on the page, but they are not offered for the notebook. */
export function canAddCandidate(verdict: IntakeVerdict | null): boolean {
  return verdict !== 'right';
}

export function outcomeLabel(verdict: IntakeVerdict | null): string | null {
  if (verdict === 'wrong') return '做错';
  if (verdict === 'partial') return '部分做错';
  if (verdict === 'right') return '做对';
  if (verdict === 'confirm') return '请确认';
  return null;
}

/** In-progress copy only. A finished row with no verdict stays blank. */
export function processLabel(status: string | undefined): string | null {
  if (status === 'preliminary') return '可以先看图勾选';
  if (status === 'verifying') return '还在整理，可以先勾选';
  return null;
}

export function pageNote(hasProgress: boolean, hasFocus: boolean): string {
  if (hasFocus) return '做错的题排在前面，勾上就能加入错题本。';
  if (hasProgress) return '可以先看图勾出做错的题，整理完成后加入错题本。';
  return '这页没有批改痕迹，勾出做错的题';
}

export function detailLead(verdict: IntakeVerdict | null, status: string | undefined): { text: string; tone: 'focus' | 'quiet' } | null {
  if (verdict === 'wrong') return { text: '做错。勾上就能加入错题本。', tone: 'focus' };
  if (verdict === 'partial') return { text: '部分做错。勾上就能加入错题本。', tone: 'focus' };
  if (verdict === 'right') return { text: '做对。这道不会加入错题本。', tone: 'quiet' };
  if (verdict === 'confirm') return { text: '请确认是不是做错了。', tone: 'quiet' };
  const process = processLabel(status);
  return process ? { text: `${process}。`, tone: 'quiet' } : null;
}

export interface OrderedCandidate<T> {
  candidate: T;
  verdict: IntakeVerdict | null;
  focus: boolean;
}

/** Keep printed order until the page has a wrong or partial verdict. Those rows then move first, stably. */
export function orderCandidates<T extends { id: string; verdict?: unknown }>(candidates: readonly T[]): OrderedCandidate<T>[] {
  const rows = candidates.map((candidate, index) => {
    const verdict = readVerdict(candidate.verdict);
    return { candidate, index, verdict, focus: isFocusVerdict(verdict) };
  });
  const ordered = rows.some(row => row.focus)
    ? rows.slice().sort((a, b) => Number(b.focus) - Number(a.focus) || a.index - b.index)
    : rows;
  return ordered.map(({ candidate, verdict, focus }) => ({ candidate, verdict, focus }));
}

/**
 * Scroll to the first focus id that this screen has not already shown.
 * Every id from the current paint is remembered, so a later poll or dock resize does not walk down the same list.
 */
export function focusScrollPlan(ids: readonly string[], seen: ReadonlySet<string>): { target: string | null; remember: string[] } {
  const remember = ids.filter(id => id.length > 0);
  return { target: remember.find(id => !seen.has(id)) ?? null, remember };
}

/** Honor a server preselection until the student toggles that row. Right rows are never preselected onto the add path. */
export function shouldPreselect(
  candidate: { id: string; verdict?: unknown; preselected?: unknown; submitted?: boolean },
  touched: boolean,
): boolean {
  if (touched || candidate.submitted === true || candidate.preselected !== true) return false;
  return canAddCandidate(readVerdict(candidate.verdict));
}
