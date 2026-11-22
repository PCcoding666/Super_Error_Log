/** How a question-grouped intake row is offered. The server owns the verdict. */

export type IntakeVerdict = 'wrong' | 'partial' | 'right' | 'confirm';

const VERDICTS: readonly IntakeVerdict[] = ['wrong', 'partial', 'right', 'confirm'];

export function readVerdict(value: unknown): IntakeVerdict | null {
  return typeof value === 'string' && (VERDICTS as readonly string[]).includes(value) ? value as IntakeVerdict : null;
}

export function isFocusVerdict(verdict: IntakeVerdict | null): boolean {
  return verdict === 'wrong' || verdict === 'partial';
}

/** Right answers stay on the card and are not offered for the notebook. */
export function canAddCandidate(verdict: IntakeVerdict | null): boolean {
  return verdict !== 'right';
}

export function groupNote(hasFocus: boolean): string {
  return hasFocus ? '做错的题排在前面，勾上就能加入错题本。' : '勾出做错的题';
}

/** Honor a server preselection until the student toggles that row. */
export function shouldPreselect(
  candidate: { verdict?: unknown; preselected?: unknown; submitted?: boolean },
  touched: boolean,
): boolean {
  if (touched || candidate.submitted === true || candidate.preselected !== true) return false;
  return canAddCandidate(readVerdict(candidate.verdict));
}
