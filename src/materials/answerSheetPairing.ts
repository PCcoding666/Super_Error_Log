import { newId } from '../db/connection.js';
import type { CaptureHints, CapturePageKind, Fragment, QuestionBundle } from './contracts.js';
import { fullMarksOf, teacherMarkMeansRight, teacherMarkMeansWrong } from './learning.js';
import { currentLink, latestFragments, linkedFragments, readQuestion, resolveQuestionId } from './queries.js';
import type { MaterialStore } from './store.js';

/** A mark read from an answer sheet. Unclear stays confirmable; it is not filed and not treated as right. */
export type SheetVerdict = 'wrong' | 'right' | 'unclear';
const CIRCLED = [...'①②③④⑤⑥⑦⑧⑨⑩'];

export type ItemRef = { number: string; subpart: string | null };

/** Printed item number, with a trailing subpart such as "13（1）" or "①" split out. */
export function canonicalItem(number: string | null, subpart: string | null): ItemRef | null {
  if (!number?.trim()) return null;
  let raw = number.trim().replace(/^第\s*/u, '').replace(/\s*题$/u, '').trim();
  let sub = subpart?.trim() ?? '';
  const embedded = /^(.*?)(?:[（(]\s*([^)）]+)\s*[)）])$/u.exec(raw);
  if (embedded?.[1]?.trim() && !sub) {
    raw = embedded[1].trim();
    sub = embedded[2]!.trim();
  }
  raw = raw.replace(/[．.、]+$/u, '').trim();
  if (!raw) return null;
  return { number: raw, subpart: canonicalSubpart(sub) };
}

function canonicalSubpart(raw: string): string | null {
  const text = raw.trim().replace(/^[（(]\s*/u, '').replace(/\s*[)）]$/u, '').trim();
  if (!text) return null;
  const circled = CIRCLED.indexOf(text);
  return circled >= 0 ? String(circled + 1) : text;
}

/** Question 13 part (2) blank ⑤. A circled number is a blank; （2） is a part. */
export type ItemGrain = { number: string; part: string | null; blank: string | null };

export function itemGrain(number: string | null, subpart: string | null): ItemGrain | null {
  if (!number?.trim()) return null;
  let rawNum = number.trim().replace(/^第\s*/u, '').replace(/\s*题$/u, '').trim();
  let rawSub = (subpart ?? '').trim();
  const embedded = /^(.*?)[（(]\s*([^)）]+)\s*[)）]$/u.exec(rawNum);
  if (embedded?.[1]?.trim() && !rawSub) {
    rawNum = embedded[1].trim();
    rawSub = embedded[2]!.trim();
  }
  rawNum = rawNum.replace(/[．.、]+$/u, '').trim();
  if (!rawNum) return null;
  return { number: rawNum, ...splitSub(rawSub) };
}

function splitSub(raw: string): { part: string | null; blank: string | null } {
  if (!raw) return { part: null, blank: null };
  let rest = raw.trim();
  let part: string | null = null;
  const head = /^[（(]\s*(\d+)\s*[)）]\s*/u.exec(rest);
  if (head) {
    part = head[1]!;
    rest = rest.slice(head[0].length).trim();
  }
  if (!rest) return { part, blank: null };
  if (rest.length === 1 && CIRCLED.includes(rest)) return { part, blank: String(CIRCLED.indexOf(rest) + 1) };
  const mixed = /^(\d+)\s*([①②③④⑤⑥⑦⑧⑨⑩])$/u.exec(rest);
  if (mixed && !part) return { part: mixed[1]!, blank: String(CIRCLED.indexOf(mixed[2]!) + 1) };
  if (/^\d+$/u.test(rest)) return part ? { part, blank: rest } : { part: rest, blank: null };
  return { part, blank: rest };
}

export function formatGrain(grain: ItemGrain): string {
  let text = `第 ${grain.number} 题`;
  if (grain.part) text += `（${grain.part}）`;
  if (grain.blank) {
    const n = Number(grain.blank);
    text += n >= 1 && n <= CIRCLED.length ? CIRCLED[n - 1]! : grain.blank;
  }
  return text;
}

function grainKey(grain: ItemGrain): string {
  return `${grain.number}|${grain.part ?? ''}|${grain.blank ?? ''}`;
}

function isFine(grain: ItemGrain): boolean {
  return !!(grain.part || grain.blank);
}

/** Parent stem, or the part stem that contains this blank. */
function isContext(fragment: ItemGrain, mark: ItemGrain): boolean {
  if (fragment.number !== mark.number) return false;
  if (!fragment.part && !fragment.blank) return true;
  if (fragment.part === mark.part && !fragment.blank) return !!mark.part;
  return fragment.part === mark.part && !!fragment.blank && fragment.blank === mark.blank;
}

/** Answers, marks, and paper work travel only with the marked blank, not with sibling blanks. */
function isBlankPackage(fragment: ItemGrain, mark: ItemGrain): boolean {
  if (fragment.number !== mark.number) return false;
  if (mark.blank) return fragment.part === mark.part && fragment.blank === mark.blank;
  if (mark.part) return fragment.part === mark.part;
  return true;
}

export type PageRole = 'paper' | 'answer_sheet' | 'worksheet' | 'unknown';

/** Student tagging wins. Otherwise a page of stems is paper, a page of marks or work is an answer sheet, and stems with marks stay a same-page worksheet. */
export function pageRole(kind: CapturePageKind | null | undefined, fragments: { role: string }[]): PageRole {
  if (kind === 'paper' || kind === 'answer_sheet') return kind;
  const questions = fragments.some(fragment => fragment.role === 'question');
  const marks = fragments.some(fragment => fragment.role === 'teacher_mark');
  const work = fragments.some(fragment => fragment.role === 'student_work' || fragment.role === 'correction');
  if (questions && marks) return 'worksheet';
  if (questions) return 'paper';
  if (marks || work) return 'answer_sheet';
  return 'unknown';
}

type PaperTarget = { question: QuestionBundle; number: string; subparts: Set<string | null>; assetId: string };

function paperTarget(question: QuestionBundle, paperIds: ReadonlySet<string>): PaperTarget | null {
  const stems = question.stem.filter(fragment => fragment.role === 'question' && paperIds.has(fragment.assetId));
  if (!stems.length) return null;
  const subparts = new Set<string | null>();
  let number: string | null = null;
  for (const stem of stems) {
    const item = canonicalItem(stem.number ?? question.number, stem.subpart);
    if (!item) continue;
    number ??= item.number;
    if (item.number === number) subparts.add(item.subpart);
  }
  if (!number) {
    const item = canonicalItem(question.number, null);
    if (!item) return null;
    number = item.number;
    subparts.add(item.subpart);
  }
  return { question, number, subparts, assetId: stems[0]!.assetId };
}

function matchTarget(targets: PaperTarget[], item: ItemRef): PaperTarget | null {
  const candidates = targets.filter(target => target.number === item.number);
  if (!candidates.length) return null;
  if (item.subpart) {
    const exact = candidates.filter(target => target.subparts.has(item.subpart));
    if (exact.length === 1) return exact[0]!;
    if (exact.length > 1) return null;
    if (candidates.length !== 1) return null;
    const named = [...candidates[0]!.subparts].filter((subpart): subpart is string => subpart !== null);
    if (!named.length || named.includes(item.subpart)) return candidates[0]!;
    return null;
  }
  return candidates.length === 1 ? candidates[0]! : null;
}

function verdictOf(fragment: Fragment, fullMarks: number | null): SheetVerdict | null {
  if (fragment.role !== 'teacher_mark') return null;
  const reliable = fragment.check === 'passed' && fragment.uncertainties.length === 0;
  if (reliable && teacherMarkMeansWrong(fragment.text, fullMarks)) return 'wrong';
  if (reliable && teacherMarkMeansRight(fragment.text, fullMarks)) return 'right';
  return 'unclear';
}

type CapturePage = {
  id: string;
  captureId: string;
  hints: CaptureHints;
  fragments: Fragment[];
  extracted: boolean;
  jobState: string | null;
};

function capturePages(store: MaterialStore, assetId: string): CapturePage[] {
  const owner = store.db.prepare('SELECT capture_id FROM material_asset WHERE owner_id=? AND id=?').get(store.studentId, assetId) as { capture_id: string } | undefined;
  if (!owner) return [];
  const rows = store.db.prepare(`SELECT a.id, a.hints_json, a.extraction_json,
      (SELECT j.state FROM material_job j WHERE j.owner_id=a.owner_id AND j.asset_id=a.id AND j.kind='extract' ORDER BY j.rowid DESC LIMIT 1) AS job_state
    FROM material_asset a WHERE a.owner_id=? AND a.capture_id=?
    ORDER BY CAST(json_extract(a.hints_json,'$.pageIndex') AS INTEGER), a.rowid`).all(store.studentId, owner.capture_id) as { id: string; hints_json: string; extraction_json: string | null; job_state: string | null }[];
  return rows.map(row => {
    let hints: CaptureHints = {};
    try { hints = JSON.parse(row.hints_json) as CaptureHints; } catch { hints = {}; }
    return { id: row.id, captureId: owner.capture_id, hints, fragments: latestFragments(store, row.id), extracted: !!row.extraction_json, jobState: row.job_state };
  });
}

function sheetIncomplete(pages: CapturePage[], sheetIds: ReadonlySet<string>): boolean {
  const sheets = pages.filter(page => sheetIds.has(page.id));
  if (!sheets.length) return false;
  return sheets.every(page => !page.extracted || page.jobState === 'failed' || page.jobState === 'interrupted');
}

const SHEET_PACKAGE = new Set(['teacher_mark', 'student_work', 'correction']);
const PAPER_PACKAGE = new Set(['diagram', 'teacher_mark', 'student_work', 'correction']);

function relink(store: MaterialStore, fragment: Fragment, winnerId: string, moved: Map<string, string>): void {
  const link = currentLink(store, fragment.fragmentId);
  if (!link?.question_id) return;
  const winner = resolveQuestionId(store, winnerId);
  const before = resolveQuestionId(store, link.question_id);
  if (before === winner) return;
  const attemptId = fragment.role === 'teacher_mark' || fragment.role === 'diagram' ? null : (readQuestion(store, winner)?.attempts[0]?.id ?? store.createAttempt(winner).id);
  store.linkFragment(fragment.fragmentId, fragment.revision, { questionId: winner, attemptId }, link.revision, { reason: 'answer_sheet', number: fragment.number, subpart: fragment.subpart });
  moved.set(before, winner);
}

function fragmentsNow(store: MaterialStore, pages: CapturePage[]): Fragment[] {
  return pages.flatMap(page => latestFragments(store, page.id));
}

function copyOnto(store: MaterialStore, fragment: Fragment, winnerId: string): void {
  const copy: Fragment = { ...fragment, fragmentId: newId('mfr'), revision: 1 };
  store.putFragment(copy);
  store.linkFragment(copy.fragmentId, 1, { questionId: resolveQuestionId(store, winnerId), attemptId: null }, 0, { reason: 'answer_sheet', number: fragment.number, subpart: fragment.subpart });
}

/** A second wrong blank needs the same parent stem. Copy the extracted fragment; do not write a new stem. */
function attachContext(store: MaterialStore, fragment: Fragment, winnerId: string, placed: Set<string>, moved: Map<string, string>): void {
  const winner = resolveQuestionId(store, winnerId);
  const link = currentLink(store, fragment.fragmentId);
  if (link?.question_id && resolveQuestionId(store, link.question_id) === winner) {
    placed.add(fragment.fragmentId);
    return;
  }
  if (placed.has(fragment.fragmentId)) {
    copyOnto(store, fragment, winner);
    return;
  }
  relink(store, fragment, winner, moved);
  placed.add(fragment.fragmentId);
}

function holdingQuestion(store: MaterialStore, grain: ItemGrain, holdings: Map<string, string>, sample: Fragment): string {
  const key = grainKey(grain);
  const existing = holdings.get(key);
  if (existing) return existing;
  const sourceId = currentLink(store, sample.fragmentId)?.question_id;
  const source = sourceId ? readQuestion(store, sourceId) : null;
  const id = store.createQuestion({ documentId: source?.documentId ?? null, number: grain.number, subject: source?.subject ?? null }).id;
  holdings.set(key, id);
  return id;
}

/**
 * A wrong mark on one blank becomes its own item: parent stem, that part's context, the diagrams
 * needed to read the blank, the answer-sheet answer, the mark, and paper work for that blank only.
 * Sibling blanks are moved off that item so they are not filed as wrong.
 */
function assembleMarkedBlanks(store: MaterialStore, pages: CapturePage[], paperIds: ReadonlySet<string>, sheetIds: ReadonlySet<string>, moved: Map<string, string>): Set<string> {
  const marks = fragmentsNow(store, pages).filter(fragment => fragment.role === 'teacher_mark' && sheetIds.has(fragment.assetId));
  const wholeNumbers = new Set(marks.flatMap(mark => {
    const grain = itemGrain(mark.number, mark.subpart);
    return grain && !isFine(grain) ? [grain.number] : [];
  }));
  const wrong = marks.flatMap(mark => {
    const grain = itemGrain(mark.number, mark.subpart);
    if (!grain || !isFine(grain) || wholeNumbers.has(grain.number) || !teacherMarkMeansWrong(mark.text, null)) return [];
    return [{ mark, grain }];
  });
  const fineNumbers = new Set(wrong.map(item => item.grain.number));
  const placed = new Set<string>();
  const holdings = new Map<string, string>();
  const winners = new Map<string, string>();
  for (const number of fineNumbers) {
    const grains = [...new Map(wrong.filter(item => item.grain.number === number).map(item => [grainKey(item.grain), item.grain])).values()];
    for (const grain of grains) {
      const all = fragmentsNow(store, pages);
      const context = all.filter(fragment => {
        if (!paperIds.has(fragment.assetId) || (fragment.role !== 'question' && fragment.role !== 'diagram')) return false;
        const item = itemGrain(fragment.number, fragment.subpart);
        return !!item && isContext(item, grain);
      });
      const stems = context.filter(fragment => fragment.role === 'question');
      if (!stems.length) continue;
      let winner = winners.get(grainKey(grain));
      if (!winner) {
        const parent = stems.find(fragment => {
          const item = itemGrain(fragment.number, fragment.subpart);
          return item && !item.part && !item.blank;
        }) ?? stems[0]!;
        const current = currentLink(store, parent.fragmentId)?.question_id;
        const resolved = current ? resolveQuestionId(store, current) : null;
        winner = resolved && ![...winners.values()].includes(resolved) ? resolved : holdingQuestion(store, grain, winners, parent);
        winners.set(grainKey(grain), winner);
      }
      for (const fragment of context) attachContext(store, fragment, winner, placed, moved);
      for (const fragment of fragmentsNow(store, pages)) {
        if (!SHEET_PACKAGE.has(fragment.role)) continue;
        const item = itemGrain(fragment.number, fragment.subpart);
        if (!item || item.number !== grain.number) continue;
        if (isBlankPackage(item, grain)) relink(store, fragment, winner, moved);
        else if (isFine(item)) relink(store, fragment, holdingQuestion(store, item, holdings, fragment), moved);
      }
      const keep = resolveQuestionId(store, winner);
      for (const fragment of linkedFragments(store, keep)) {
        const item = itemGrain(fragment.number, fragment.subpart);
        if (!item || item.number !== grain.number) continue;
        const stays = fragment.role === 'question' || fragment.role === 'diagram' ? isContext(item, grain) : isBlankPackage(item, grain);
        if (stays) continue;
        relink(store, fragment, holdingQuestion(store, item, holdings, fragment), moved);
      }
    }
  }
  return fineNumbers;
}

/**
 * Assemble one record per marked blank, not a verdict on the whole question number.
 * The record has the paper stem and diagrams needed to read that blank, the answer-sheet answer,
 * the teacher mark, and any work written for that blank on the paper. A same-page worksheet is left as it is.
 * An answer-sheet item with no stem in the uploaded pages stays visible. No stem is invented.
 */
export function pairAnswerSheetCapture(store: MaterialStore, assetId: string): void {
  const pages = capturePages(store, assetId);
  if (pages.length < 2 || !pages.some(page => page.hints.captureMode === 'multi')) return;
  const roles = new Map(pages.map(page => [page.id, pageRole(page.hints.pageKind, page.fragments)]));
  const paperIds = new Set([...roles].filter(([, role]) => role === 'paper').map(([id]) => id));
  const sheetIds = new Set([...roles].filter(([, role]) => role === 'answer_sheet').map(([id]) => id));
  if (!paperIds.size || !sheetIds.size) return;
  const moved = new Map<string, string>();
  const fineNumbers = assembleMarkedBlanks(store, pages, paperIds, sheetIds, moved);
  const targets = store.listQuestions().flatMap(question => {
    const target = paperTarget(question, paperIds);
    return target ? [target] : [];
  });
  const attach = (pageIds: ReadonlySet<string>, rolesToMove: ReadonlySet<string>) => {
    for (const page of pages) {
      if (!pageIds.has(page.id)) continue;
      for (const fragment of latestFragments(store, page.id)) {
        if (!rolesToMove.has(fragment.role)) continue;
        const item = itemGrain(fragment.number, fragment.subpart);
        if (!item || fineNumbers.has(item.number)) continue;
        const target = matchTarget(targets, { number: item.number, subpart: item.blank ?? item.part });
        if (!target) continue;
        relink(store, fragment, target.question.id, moved);
      }
    }
  };
  attach(sheetIds, SHEET_PACKAGE);
  attach(paperIds, PAPER_PACKAGE);
  // Sheet answers and marks that never found a paper stem stay together at the same blank. No stem is invented.
  const keepers = new Map<string, string>();
  const paperQuestionIds = new Set(store.listQuestions().flatMap(question => {
    const target = paperTarget(question, paperIds);
    return target ? [resolveQuestionId(store, target.question.id)] : [];
  }));
  for (const page of pages) {
    if (!sheetIds.has(page.id)) continue;
    for (const fragment of latestFragments(store, page.id)) {
      if (!SHEET_PACKAGE.has(fragment.role)) continue;
      const item = itemGrain(fragment.number, fragment.subpart);
      if (!item) continue;
      const link = currentLink(store, fragment.fragmentId);
      if (!link?.question_id) continue;
      const current = resolveQuestionId(store, link.question_id);
      if (paperQuestionIds.has(current)) continue;
      const key = grainKey(item);
      const keeper = keepers.get(key);
      if (!keeper) { keepers.set(key, current); continue; }
      relink(store, fragment, keeper, moved);
    }
  }
  for (const [before, winner] of moved) retireEmpty(store, before, winner);
}

function retireEmpty(store: MaterialStore, questionId: string, winnerId: string): void {
  const id = resolveQuestionId(store, questionId);
  const winner = resolveQuestionId(store, winnerId);
  if (id === winner) return;
  const question = readQuestion(store, id);
  if (!question || question.itemId || question.answers.length || question.grades.length) return;
  if (linkedFragments(store, id).length) return;
  if (store.db.prepare("SELECT 1 FROM material_legacy_map WHERE owner_id=? AND source_kind='question_alias' AND source_key=?").get(store.studentId, id)) return;
  store.db.prepare("INSERT INTO material_legacy_map(owner_id,source_kind,source_key,question_id,details_json) VALUES (?,'question_alias',?,?,?)").run(store.studentId, id, winner, JSON.stringify({ reason: 'answer_sheet' }));
}

export type UnmatchedMark = {
  questionId: string;
  assetId: string;
  /** Question revision, used as the candidate id the student confirms. */
  revision: number;
  number: string | null;
  /** Answer-sheet answers and marks, in that order, for the confirm row. */
  text: string;
  /** Filled or written answers from the answer sheet. Empty when only a mark was read. */
  answers: string[];
  /** Student-facing item heading, including part and blank when the mark names them. */
  heading: string;
  fragmentId: string;
  fragmentRevision: number;
  verdict: SheetVerdict;
};

export type IntakePairing = {
  byAsset: Map<string, { captureId: string; role: 'paper' | 'answer_sheet' }>;
  sheetIncomplete: Set<string>;
  verdicts: Map<string, SheetVerdict>;
  unmatchedQuestions: Set<string>;
  questionAsset: Map<string, string>;
  unmatchedMarks: UnmatchedMark[];
};

/** What intake can show after pairing. Same-page worksheets are absent, so their copy stays as it is. */
export function readIntakePairing(store: MaterialStore, questions: QuestionBundle[]): IntakePairing {
  const result: IntakePairing = { byAsset: new Map(), sheetIncomplete: new Set(), verdicts: new Map(), unmatchedQuestions: new Set(), questionAsset: new Map(), unmatchedMarks: [] };
  const rows = store.db.prepare(`SELECT a.id, a.capture_id, a.hints_json, a.extraction_json,
      (SELECT j.state FROM material_job j WHERE j.owner_id=a.owner_id AND j.asset_id=a.id AND j.kind='extract' ORDER BY j.rowid DESC LIMIT 1) AS job_state
    FROM material_asset a WHERE a.owner_id=?`).all(store.studentId) as { id: string; capture_id: string; hints_json: string; extraction_json: string | null; job_state: string | null }[];
  const groups = new Map<string, CapturePage[]>();
  for (const row of rows) {
    let hints: CaptureHints = {};
    try { hints = JSON.parse(row.hints_json) as CaptureHints; } catch { hints = {}; }
    const page: CapturePage = { id: row.id, captureId: row.capture_id, hints, fragments: latestFragments(store, row.id), extracted: !!row.extraction_json, jobState: row.job_state };
    groups.set(row.capture_id, [...(groups.get(row.capture_id) ?? []), page]);
  }
  for (const [captureId, pages] of groups) {
    if (pages.length < 2 || !pages.some(page => page.hints.captureMode === 'multi')) continue;
    const roles = new Map(pages.map(page => [page.id, pageRole(page.hints.pageKind, page.fragments)]));
    const paperIds = new Set([...roles].filter(([, role]) => role === 'paper').map(([id]) => id));
    const sheetIds = new Set([...roles].filter(([, role]) => role === 'answer_sheet').map(([id]) => id));
    if (!paperIds.size || !sheetIds.size) continue;
    for (const [id, role] of roles) if (role === 'paper' || role === 'answer_sheet') result.byAsset.set(id, { captureId, role });
    if (sheetIncomplete(pages, sheetIds)) result.sheetIncomplete.add(captureId);
    const targets = questions.flatMap(question => {
      const target = paperTarget(question, paperIds);
      return target ? [target] : [];
    });
    const paperQuestionIds = new Set(targets.map(target => target.question.id));
    for (const target of targets) {
      result.questionAsset.set(target.question.id, target.assetId);
      const marks = target.question.teacherMarks.filter(mark => sheetIds.has(mark.assetId));
      const full = fullMarksOf(target.question.stem.filter(fragment => fragment.role === 'question').map(fragment => fragment.text).join('\n'));
      const verdicts = marks.flatMap(mark => {
        const verdict = verdictOf(mark, full);
        return verdict ? [verdict] : [];
      });
      if (!verdicts.length) result.unmatchedQuestions.add(target.question.id);
      else if (verdicts.includes('wrong')) result.verdicts.set(target.question.id, 'wrong');
      else if (verdicts.every(verdict => verdict === 'right')) result.verdicts.set(target.question.id, 'right');
      else result.verdicts.set(target.question.id, 'unclear');
    }
    for (const question of questions) {
      if (paperQuestionIds.has(question.id)) continue;
      const answers = question.attempts.flatMap(attempt => attempt.fragments).filter(fragment => sheetIds.has(fragment.assetId) && (fragment.role === 'student_work' || fragment.role === 'correction') && fragment.text.trim());
      const marks = question.teacherMarks.filter(mark => sheetIds.has(mark.assetId) && mark.text.trim());
      if (!answers.length && !marks.length) continue;
      const primary = answers[0] ?? marks[0]!;
      const item = itemGrain(primary.number ?? question.number, primary.subpart);
      const verdicts = marks.map(mark => verdictOf(mark, null) ?? 'unclear');
      const verdict: SheetVerdict = verdicts.includes('wrong') ? 'wrong' : verdicts.length && verdicts.every(item => item === 'right') ? 'right' : 'unclear';
      result.unmatchedMarks.push({
        questionId: question.id, assetId: primary.assetId, revision: question.revision, number: item?.number ?? question.number,
        text: [...answers.map(fragment => fragment.text), ...marks.map(mark => mark.text)].join(' · '),
        answers: answers.map(fragment => fragment.text), heading: item ? formatGrain(item) : (question.number ? `第 ${question.number} 题` : '题号不清'),
        fragmentId: primary.fragmentId, fragmentRevision: primary.revision, verdict,
      });
    }
  }
  return result;
}

/** Heading for one selectable item. A single marked blank keeps its part and blank; a whole question stays a question number. */
export function itemHeading(question: { number: string | null; teacherMarks: Fragment[]; stem: Fragment[]; attempts: { fragments: Fragment[] }[] }): string {
  const marks = question.teacherMarks.map(mark => itemGrain(mark.number ?? question.number, mark.subpart)).filter((grain): grain is ItemGrain => !!grain && isFine(grain));
  if (marks.length && new Set(marks.map(grainKey)).size === 1) return formatGrain(marks[0]!);
  const own = [...question.stem, ...question.attempts.flatMap(attempt => attempt.fragments)]
    .map(fragment => itemGrain(fragment.number ?? question.number, fragment.subpart))
    .filter((grain): grain is ItemGrain => !!grain && isFine(grain));
  if (own.length && new Set(own.map(grainKey)).size === 1) return formatGrain(own[0]!);
  return question.number ? `第 ${question.number} 题` : '题号不清';
}

export function pairingCandidateLabel(number: string | null, kind: 'wrong' | 'unclear' | 'unmatched' | 'unmatched-mark'): string {
  const base = !number ? '题号不清' : number.startsWith('第 ') ? number : `第 ${number} 题`;
  if (kind === 'wrong') return `${base} · 答题卡标为错题`;
  if (kind === 'unclear') return `${base} · 答题卡对上了，请核对`;
  if (kind === 'unmatched-mark') return `${base} · 答题卡没对上试卷`;
  return `${base} · 答题卡没对上`;
}

export function pairingCopy(pairing: IntakePairing, assetId: string, filedFromSheet: boolean): { statusText: string | null; pickNote: string | null } {
  const place = pairing.byAsset.get(assetId);
  if (!place) return { statusText: null, pickNote: null };
  if (place.role === 'answer_sheet') {
    if (!pairing.unmatchedMarks.some(mark => mark.assetId === assetId)) return { statusText: null, pickNote: null };
    return { statusText: '答题卡上有没对上试卷的批改', pickNote: '这些批改在答题卡上，没有对上试卷的题号，请核对。' };
  }
  const unmatched = [...pairing.unmatchedQuestions].some(id => pairing.questionAsset.get(id) === assetId);
  if (pairing.sheetIncomplete.has(place.captureId) && unmatched) {
    return { statusText: '答题卡没读全 · 请核对错题', pickNote: '试卷上的题已经整理好。答题卡这一页不完整，请核对哪些题做错了。' };
  }
  if (unmatched) {
    return { statusText: '没对上答题卡的题，请核对', pickNote: '答题卡已经标出一部分错题。这里是没对上的，请核对后再加入。' };
  }
  if (filedFromSheet) return { statusText: '答题卡标出错题', pickNote: null };
  return { statusText: null, pickNote: null };
}
