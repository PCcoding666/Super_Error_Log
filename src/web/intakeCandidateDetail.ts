import type { QuestionBundle, ReferenceAnswer } from '../materials/contracts.js';
import { learningObservationFragments } from '../materials/learning.js';
import { readQuestion } from '../materials/queries.js';
import type { MaterialStore } from '../materials/store.js';
import type { IntakeCandidateDetail, IntakeCandidateFragment } from './apiTypes.js';

const QUESTION_ID = /^[A-Za-z0-9_-]{1,80}$/;

export type IntakeDetailResult =
  | { ok: true; detail: IntakeCandidateDetail }
  | { ok: false; status: number; code: string; message: string };

/**
 * Read what extraction already stored for one of this student's questions.
 * Does not start an answer or grade job, and does not write.
 */
export function readIntakeCandidateDetail(store: MaterialStore, questionId: string, revision: number): IntakeDetailResult {
  if (!QUESTION_ID.test(questionId) || !Number.isSafeInteger(revision) || revision < 1) {
    return { ok: false, status: 400, code: 'invalid_request', message: '勾选信息不可用，请刷新后再试。' };
  }
  const question = readQuestion(store, questionId);
  if (!question) return { ok: false, status: 404, code: 'not_found', message: '题目不存在。' };
  if (question.revision !== revision) return { ok: false, status: 409, code: 'revision_conflict', message: '材料已更新，请刷新后再试。' };
  return { ok: true, detail: toDetail(store, question) };
}

function toDetail(store: MaterialStore, question: QuestionBundle): IntakeCandidateDetail {
  const primary = question.stem.find(fragment => fragment.role === 'question') ?? question.stem[0] ?? null;
  const stem: IntakeCandidateFragment[] = question.stem
    .filter(fragment => fragment.role === 'question' || fragment.role === 'diagram')
    .map(fragment => ({
      role: fragment.role === 'diagram' ? 'diagram' : 'question',
      text: fragment.text,
      number: fragment.number,
      check: fragment.check,
      uncertainties: [...fragment.uncertainties],
      requiresDiagram: fragment.requiresDiagram,
    }));
  const answers = question.answers.filter(answer => answer.text.trim()).map(toAnswer);
  const seen = new Set(answers.map(answer => answer.text.trim()));
  for (const fragment of learningObservationFragments(store, question.id)) {
    if (fragment.role !== 'reference_answer') continue;
    const text = fragment.text.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    answers.push({
      text: fragment.text,
      source: 'imported',
      stale: fragment.check !== 'passed' || fragment.uncertainties.length > 0,
      claimedSource: null,
      fromPhoto: true,
    });
  }
  return {
    id: question.id,
    revision: question.revision,
    label: question.number ? `第 ${question.number} 题` : '题号不清',
    subject: question.subject,
    stem,
    crop: primary ? `/s/materials/fragments/${primary.fragmentId}/crop?revision=${primary.revision}` : null,
    source: primary ? `/s/materials/assets/${primary.assetId}/image` : null,
    work: question.attempts.flatMap(attempt => attempt.fragments.flatMap((fragment): IntakeCandidateDetail['work'] => {
      if (!fragment.text.trim()) return [];
      if (fragment.role === 'student_work') return [{ text: fragment.text, label: null }];
      if (fragment.role === 'correction') return [{ text: fragment.text, label: '订正' }];
      return [];
    })),
    marks: question.teacherMarks.filter(fragment => fragment.text.trim()).map(fragment => ({ text: fragment.text })),
    answers,
    grades: question.grades.map(grade => ({
      result: grade.result,
      findings: grade.findings.map(finding => finding.text).filter(text => text.trim()),
      score: grade.score && Number.isFinite(grade.score.earned) && Number.isFinite(grade.score.total)
        ? { earned: grade.score.earned, total: grade.score.total }
        : null,
      stale: grade.stale,
    })),
  };
}

function toAnswer(answer: ReferenceAnswer): IntakeCandidateDetail['answers'][number] {
  return {
    text: answer.text,
    source: answer.source,
    stale: answer.stale,
    claimedSource: answer.claimedSource,
    fromPhoto: answer.fragmentIds.length > 0,
  };
}
