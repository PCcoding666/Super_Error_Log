import type { Box } from '../media/images.js';
import type { MaterialRole } from './contracts.js';

/** Reads of these regions must not fail a page whose question stems were extracted. */
export const AUXILIARY_ROLES = ['teacher_mark', 'student_work', 'correction'] as const satisfies readonly MaterialRole[];

export function isAuxiliaryRole(role: string): boolean {
  return (AUXILIARY_ROLES as readonly string[]).includes(role);
}

/**
 * The verifier said this region is not a question. That is the only automatic
 * reason a model "question" leaves the selectable list. Height and a missing
 * printed number are not enough: a real short or unnumbered question stays.
 */
export function isRejectedQuestion(fragment: { role: string; uncertainties: readonly string[] }): boolean {
  return fragment.role === 'question' && fragment.uncertainties.includes('role_mismatch');
}

export function selectableQuestion(fragment: { role: string; uncertainties: readonly string[] }): boolean {
  return fragment.role === 'question' && !isRejectedQuestion(fragment);
}

/** Rejected headings keep their stored text, box, number and role_mismatch note, but never join a numbered question. */
export function intakeGroupKey(fragment: { fragmentId: string; number: string | null; role: string; uncertainties: readonly string[] }): string {
  if (isRejectedQuestion(fragment)) return `rejected:${fragment.fragmentId}`;
  return fragment.number === null ? `unknown:${fragment.fragmentId}` : `number:${fragment.number}`;
}

type SideRegion = {
  role: string;
  number: string | null;
  page: number | null;
  subpart: string | null;
  box: Box;
};

/**
 * A diagram with no printed number that sits to the right of exactly one numbered
 * question, and overlaps that question vertically, inherits that question's number.
 * Boxes are not changed. Ambiguous or absent diagrams are left alone.
 */
export function assignUniqueSideDiagramNumbers<T extends SideRegion>(regions: T[]): void {
  const questions = regions.filter(region => region.role === 'question' && region.number !== null);
  for (const region of regions) {
    if (region.role !== 'diagram' || region.number !== null) continue;
    const matches = questions.filter(question => sitsBeside(question, region));
    if (matches.length !== 1) continue;
    const question = matches[0]!;
    if (region.subpart !== null && region.subpart !== question.subpart) continue;
    region.number = question.number;
  }
}

function sitsBeside(question: SideRegion, diagram: SideRegion): boolean {
  if (question.page !== null && diagram.page !== null && question.page !== diagram.page) return false;
  const overlap = Math.min(question.box.y + question.box.height, diagram.box.y + diagram.box.height) - Math.max(question.box.y, diagram.box.y);
  const smaller = Math.min(question.box.height, diagram.box.height);
  if (!(overlap > 0 && smaller > 0 && overlap >= smaller * 0.5)) return false;
  return diagram.box.x >= question.box.x + question.box.width - 0.02;
}

const OPTION_CLAUSE = /^[（(]?[A-DＡ-Ｄ][)）.．、]\s*\S/u;

/** Text that is only choice lines (A. … B. …), with no stem sentence left beside them. */
export function isOptionOnlyText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 4_000) return false;
  const clauses = trimmed.split(/\n+/u).flatMap(line => line.split(/(?=(?:^|\s)[（(]?[A-DＡ-Ｄ][)）.．、])/u)).map(clause => clause.trim()).filter(Boolean);
  return clauses.length > 0 && clauses.every(clause => OPTION_CLAUSE.test(clause));
}

type OptionRow = { role: string; text: string; number: string | null; subpart: string | null; page: number | null };

/**
 * An options-only question row with the same printed number is part of that question.
 * Its text is appended to the stem (or to the first options row when the stem was not boxed)
 * and the extra row is dropped so intake does not show a second card.
 */
export function mergeOptionOnlyFragments<T extends OptionRow>(fragments: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const fragment of fragments) {
    if (fragment.role !== 'question' || fragment.number === null) continue;
    const key = `${fragment.number}\0${fragment.subpart ?? ''}\0${fragment.page ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), fragment]);
  }
  const dropped = new Set<T>();
  for (const group of groups.values()) {
    const optionRows = group.filter(fragment => isOptionOnlyText(fragment.text));
    const host = group.find(fragment => !isOptionOnlyText(fragment.text)) ?? (optionRows.length > 1 ? optionRows[0] : undefined);
    if (!host) continue;
    for (const option of optionRows) {
      if (option === host) continue;
      const extra = option.text.trim();
      if (extra && !host.text.includes(extra)) host.text = `${host.text.trim()}\n${extra}`;
      dropped.add(option);
    }
  }
  return fragments.filter(fragment => !dropped.has(fragment));
}
