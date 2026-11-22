import type { CaptureHints, CapturePageKind, Fragment, QuestionBundle } from './contracts.js';
import type { MaterialStore } from './store.js';

/** A page the student tagged, or a page whose extracted roles make the kind obvious. */
export type PairingPage = {
  pageKind: CapturePageKind | null;
  roles: readonly string[];
};

export type SetPairing = 'paired' | 'worksheet';

/** Trim, fold fullwidth parentheses, and drop spaces. The stored subpart text is left unchanged. */
export function normalizeSubpart(value: string | null | undefined): string | null {
  if (value == null) return null;
  const text = value.trim().replace(/（/gu, '(').replace(/）/gu, ')').replace(/\s+/gu, '');
  return text.length ? text : null;
}

function hasRole(roles: readonly string[], role: string): boolean {
  return roles.includes(role);
}

/** Printed stems and no teacher mark: a paper page, not a marked worksheet. */
export function pageLooksLikePaper(roles: readonly string[]): boolean {
  return hasRole(roles, 'question') && !hasRole(roles, 'teacher_mark');
}

/** Marks or filled answers and no printed stem: an answer sheet. */
export function pageLooksLikeSheet(roles: readonly string[]): boolean {
  return !hasRole(roles, 'question') && (hasRole(roles, 'teacher_mark') || hasRole(roles, 'student_work'));
}

/**
 * A page that already mixes stems and teacher marks is a worksheet.
 * Guessing that it is only one side of a pair would invent a structure.
 */
function pageIsAmbiguous(page: PairingPage): boolean {
  if (page.pageKind) return false;
  return hasRole(page.roles, 'question') && hasRole(page.roles, 'teacher_mark');
}

/**
 * Paper plus answer sheet, from the student's tags when they exist.
 * Untagged pages are inferred only when every page is unambiguously one side.
 * Anything else stays a worksheet and keeps today's same-page join.
 */
export function recognizePairing(pages: readonly PairingPage[]): SetPairing {
  if (pages.length < 2) return 'worksheet';
  if (pages.some(pageIsAmbiguous)) return 'worksheet';
  const taggedPaper = pages.some(page => page.pageKind === 'paper');
  const taggedSheet = pages.some(page => page.pageKind === 'answer_sheet');
  if (taggedPaper && taggedSheet) return 'paired';
  const paperLike = pages.some(page => page.pageKind === null && pageLooksLikePaper(page.roles));
  const sheetLike = pages.some(page => page.pageKind === null && pageLooksLikeSheet(page.roles));
  if (taggedSheet && paperLike && !taggedPaper) return 'paired';
  if (taggedPaper && sheetLike && !taggedSheet) return 'paired';
  if (!taggedPaper && !taggedSheet && paperLike && sheetLike) return 'paired';
  return 'worksheet';
}

type AssetRow = { id: string; capture_id: string; hints_json: string };

function assetRow(store: MaterialStore, assetId: string): AssetRow | undefined {
  return store.db.prepare('SELECT id, capture_id, hints_json FROM material_asset WHERE owner_id=? AND id=?').get(store.studentId, assetId) as AssetRow | undefined;
}

export function pageKindOf(store: MaterialStore, assetId: string): CapturePageKind | null {
  const row = assetRow(store, assetId);
  if (!row) return null;
  try {
    const hints = JSON.parse(row.hints_json) as CaptureHints;
    return hints.pageKind ?? null;
  } catch { return null; }
}

function capturePages(store: MaterialStore, captureId: string): PairingPage[] {
  const rows = store.db.prepare(`SELECT a.id, a.hints_json FROM material_asset a
    WHERE a.owner_id=? AND a.capture_id=?`).all(store.studentId, captureId) as { id: string; hints_json: string }[];
  return rows.map(row => {
    let pageKind: CapturePageKind | null = null;
    try { pageKind = (JSON.parse(row.hints_json) as CaptureHints).pageKind ?? null; } catch { pageKind = null; }
    const fragments = store.db.prepare(`SELECT content_json FROM material_fragment f WHERE f.owner_id=? AND f.asset_id=?
      AND NOT EXISTS (SELECT 1 FROM material_fragment n WHERE n.owner_id=f.owner_id AND n.id=f.id AND n.revision>f.revision)`).all(store.studentId, row.id) as { content_json: string }[];
    const roles = fragments.map(item => (JSON.parse(item.content_json) as Fragment).role);
    return { pageKind, roles };
  });
}

export function capturePairing(store: MaterialStore, captureId: string): SetPairing {
  const count = store.db.prepare('SELECT count(*) AS n FROM material_asset WHERE owner_id=? AND capture_id=?').get(store.studentId, captureId) as { n: number };
  if (count.n < 2) return 'worksheet';
  return recognizePairing(capturePages(store, captureId));
}

export function pairingForAsset(store: MaterialStore, assetId: string): SetPairing {
  const row = assetRow(store, assetId);
  if (!row) return 'worksheet';
  return capturePairing(store, row.capture_id);
}

function captureIdOfDocument(store: MaterialStore, documentId: string | null): string | null {
  if (!documentId?.startsWith('set_')) return null;
  const captureId = documentId.slice(4);
  const row = store.db.prepare('SELECT 1 FROM material_capture WHERE owner_id=? AND id=?').get(store.studentId, captureId);
  return row ? captureId : null;
}

export function questionInPairedSet(store: MaterialStore, question: { documentId: string | null }): boolean {
  const captureId = captureIdOfDocument(store, question.documentId);
  if (!captureId) return false;
  return capturePairing(store, captureId) === 'paired';
}

/** The printed subpart of the stem, or of the mark/work when the stem was not in the upload. */
export function questionSubpart(question: QuestionBundle): string | null {
  const stem = question.stem.find(fragment => fragment.role === 'question');
  if (stem) return normalizeSubpart(stem.subpart);
  const mark = question.teacherMarks[0];
  if (mark) return normalizeSubpart(mark.subpart);
  const work = question.attempts.flatMap(attempt => attempt.fragments)[0];
  return normalizeSubpart(work?.subpart ?? null);
}

/**
 * A stem that only introduces a more specific blank: no mark and no answer of its own.
 * It stays linked, and it is not its own checkbox.
 */
export function isContextQuestion(question: QuestionBundle, siblings: readonly QuestionBundle[]): boolean {
  if (question.teacherMarks.length || question.attempts.some(attempt => attempt.fragments.length)) return false;
  if (!question.stem.some(fragment => fragment.role === 'question')) return false;
  const subpart = questionSubpart(question);
  return siblings.some(other => {
    if (other.id === question.id || other.number !== question.number || other.documentId !== question.documentId) return false;
    const otherSubpart = questionSubpart(other);
    if (otherSubpart === null || otherSubpart === subpart) return false;
    if (subpart === null) return true;
    return otherSubpart.startsWith(subpart);
  });
}

/** Parent stems whose subpart is a proper prefix of this blank, nearest last is not required. */
export function contextQuestions(question: QuestionBundle, siblings: readonly QuestionBundle[]): QuestionBundle[] {
  const subpart = questionSubpart(question);
  return siblings.filter(other => {
    if (other.id === question.id || other.number !== question.number || other.documentId !== question.documentId) return false;
    if (!other.stem.some(fragment => fragment.role === 'question')) return false;
    const parent = questionSubpart(other);
    if (parent === subpart) return false;
    if (parent === null) return subpart !== null;
    return subpart !== null && subpart.startsWith(parent);
  }).sort((a, b) => (questionSubpart(a)?.length ?? 0) - (questionSubpart(b)?.length ?? 0));
}

/** Marks that decide right/wrong. In a paired set the answer sheet wins when it has a mark. */
export function decisiveMarks(store: MaterialStore, question: QuestionBundle): Fragment[] {
  const marks = question.teacherMarks;
  if (!questionInPairedSet(store, question)) return marks;
  const sheet = marks.filter(mark => pageKindOf(store, mark.assetId) === 'answer_sheet');
  return sheet.length ? sheet : marks;
}

export function assembledQuestionTexts(store: MaterialStore, question: QuestionBundle): string[] {
  const own = question.stem.filter(fragment => fragment.role === 'question' && fragment.text.trim()).map(fragment => fragment.text.trim());
  if (!questionInPairedSet(store, question)) return own;
  const parents = contextQuestions(question, store.listQuestions());
  const seen = new Set<string>();
  const texts: string[] = [];
  for (const text of [...parents.flatMap(parent => parent.stem.filter(fragment => fragment.role === 'question' && fragment.text.trim()).map(fragment => fragment.text.trim())), ...own]) {
    if (seen.has(text)) continue;
    seen.add(text);
    texts.push(text);
  }
  return texts;
}
