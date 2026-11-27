import { contextQuestions, isContextQuestion, pageKindOf, questionInPairedSet, questionSubpart } from '../materials/answerSheet.js';
import type { CaptureHints, QuestionBundle } from '../materials/contracts.js';
import { assetImageUrl, fragmentCropUrl } from '../materials/displayDerivatives.js';
import { intakeVerdict } from '../materials/grading.js';
import { inclusionIntents } from '../materials/learning.js';
import type { MaterialStore } from '../materials/store.js';
import { stemFirstSentence } from './views/materials.js';
import type { IntakeCandidate, IntakeGroup, IntakeQuestion } from './apiTypes.js';

type AssetFace = {
  id: string;
  captureId: string;
  sourceHash: string;
  pageKind: 'paper' | 'answer_sheet' | null;
  pageIndex: number | null;
  printedPage: number | null;
};

function faces(store: MaterialStore): Map<string, AssetFace> {
  const rows = store.db.prepare(`SELECT a.id, a.capture_id, a.hints_json, a.extraction_json, s.content_hash FROM material_asset a JOIN source_asset s ON s.id=a.source_asset_id WHERE a.owner_id=?`).all(store.studentId) as { id: string; capture_id: string; hints_json: string; extraction_json: string | null; content_hash: string }[];
  const map = new Map<string, AssetFace>();
  for (const row of rows) {
    let hints: CaptureHints = {};
    try { hints = JSON.parse(row.hints_json) as CaptureHints; } catch { hints = {}; }
    let printed: number | null = null;
    if (row.extraction_json) {
      try {
        const page = (JSON.parse(row.extraction_json) as { document?: { page?: number | null } }).document?.page;
        if (typeof page === 'number' && Number.isSafeInteger(page) && page > 0) printed = page;
      } catch { printed = null; }
    }
    map.set(row.id, { id: row.id, captureId: row.capture_id, sourceHash: row.content_hash, pageKind: hints.pageKind ?? pageKindOf(store, row.id), pageIndex: hints.pageIndex ?? null, printedPage: printed });
  }
  return map;
}

function assetIds(question: QuestionBundle): string[] {
  const ids = [
    ...question.stem.map(fragment => fragment.assetId),
    ...question.teacherMarks.map(fragment => fragment.assetId),
    ...question.attempts.flatMap(attempt => attempt.fragments.map(fragment => fragment.assetId)),
  ];
  return [...new Set(ids)];
}

function photoOf(question: QuestionBundle): string | null {
  return question.stem.find(fragment => fragment.role === 'question')?.assetId
    ?? question.stem[0]?.assetId
    ?? question.teacherMarks[0]?.assetId
    ?? question.attempts.flatMap(attempt => attempt.fragments)[0]?.assetId
    ?? null;
}

function cropOf(question: QuestionBundle): string | null {
  const fragment = question.stem.find(item => item.role === 'question') ?? question.stem[0] ?? question.teacherMarks[0] ?? question.attempts.flatMap(attempt => attempt.fragments)[0];
  return fragment ? fragmentCropUrl(fragment, 'list') : null;
}

function statusLine(used: AssetFace[]): string {
  const sheet = used.some(face => face.pageKind === 'answer_sheet');
  const papers = used.filter(face => face.pageKind !== 'answer_sheet');
  const pages = [...new Set(papers.map(face => face.printedPage ?? face.pageIndex).filter((page): page is number => page !== null))].sort((a, b) => a - b);
  const paper = pages.length ? `试卷第 ${pages.join('、')} 页` : papers.length ? '试卷' : '';
  if (sheet && paper) return `答题卡 + ${paper}`;
  if (sheet) return '答题卡';
  return paper || '试卷';
}

/**
 * One card per printed question number for a paper + answer-sheet set.
 * Same-page worksheets are not grouped; their photo cards stay as they are.
 */
export function buildIntakeGroups(store: MaterialStore, questions: readonly QuestionBundle[], filed: IntakeQuestion[], filedByQuestion: Map<string, string>): IntakeGroup[] {
  const known = faces(store);
  const intents = inclusionIntents(store);
  const paired = questions.filter(question => questionInPairedSet(store, question));
  const byKey = new Map<string, QuestionBundle[]>();
  for (const question of paired) {
    const key = `${question.documentId ?? ''}\0${question.number ?? ''}`;
    byKey.set(key, [...(byKey.get(key) ?? []), question]);
  }
  const groups: IntakeGroup[] = [];
  for (const [key, members] of byKey) {
    const rows = members.filter(question => !isContextQuestion(question, paired));
    if (!rows.length) continue;
    const number = rows[0]!.number;
    const related = new Set<string>();
    for (const question of rows) {
      for (const id of assetIds(question)) related.add(id);
      for (const parent of contextQuestions(question, paired)) for (const id of assetIds(parent)) related.add(id);
    }
    const used = [...related].map(id => known.get(id)).filter((face): face is AssetFace => !!face)
      .sort((a, b) => Number(b.pageKind === 'answer_sheet') - Number(a.pageKind === 'answer_sheet') || (a.printedPage ?? a.pageIndex ?? 0) - (b.printedPage ?? b.pageIndex ?? 0) || a.id.localeCompare(b.id));
    const candidates: IntakeCandidate[] = [];
    const questionsInGroup: IntakeQuestion[] = [];
    const ordered = rows.map(question => ({ question, verdict: intakeVerdict(question, store) }))
      .sort((a, b) => {
        const focus = (verdict: string) => verdict === 'wrong' || verdict === 'partial';
        return Number(focus(b.verdict.verdict)) - Number(focus(a.verdict.verdict))
          || (questionSubpart(a.question) ?? '').localeCompare(questionSubpart(b.question) ?? '', 'zh-CN', { numeric: true })
          || a.question.id.localeCompare(b.question.id);
      });
    for (const row of ordered) {
      const question = row.question;
      if (question.itemId && intents.get(question.id) !== false) {
        const filedQuestion = filed.find(item => item.id === filedByQuestion.get(question.id));
        if (filedQuestion) questionsInGroup.push(filedQuestion);
        continue;
      }
      if (intents.get(question.id) === false) continue;
      const photoId = photoOf(question);
      if (!photoId) continue;
      const subpart = questionSubpart(question);
      const unmatched = !question.stem.some(fragment => fragment.role === 'question' && fragment.text.trim());
      const excerpt = unmatched
        ? '题干不在上传的页面里'
        : stemFirstSentence(question, 60);
      candidates.push({
        id: `${question.id}:${question.revision}`,
        label: subpart ? subpart : (number ? `第 ${number} 题` : '题号不清'),
        excerpt,
        crop: cropOf(question),
        photoId,
        verdict: row.verdict.verdict,
        preselected: row.verdict.preselected,
      });
    }
    if (!candidates.length && !questionsInGroup.length) continue;
    const photoIds = [...new Set(used.map(face => face.id))];
    groups.push({
      id: key,
      title: number ? `第 ${number} 题` : '题号不清',
      status: statusLine(used),
      thumbs: used.map(face => ({ src: assetImageUrl(face.id, face.sourceHash, 'thumb'), pageKind: face.pageKind === 'answer_sheet' ? 'answer_sheet' : 'paper' })),
      photoIds,
      questions: questionsInGroup,
      candidates,
    });
  }
  const numbered = new Intl.Collator('zh-CN', { numeric: true });
  return groups.sort((a, b) => numbered.compare(a.title, b.title) || a.id.localeCompare(b.id));
}
