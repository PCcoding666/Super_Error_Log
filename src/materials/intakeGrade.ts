import { createHash } from 'node:crypto';
import { MobileRequestError } from '../mobile/service.js';
import { answersConflict, selectedAnswerIds } from './answers.js';
import type { Fragment, Grade, QuestionBundle } from './contracts.js';
import type { MaterialJobs } from './jobs.js';
import { fullMarksOf, teacherMarkMeansRight, teacherMarkMeansWrong } from './learning.js';
import { answerBasis, effectiveQuestionStem, gradeBasis, readQuestion } from './queries.js';
import type { MaterialStore } from './store.js';

export type IntakeVerdict = 'wrong' | 'partial' | 'right' | 'confirm';

const BLOCKING_UNCERTAINTY = 'missing_diagram';

/** A passed teacher mark with no uncertainties that already says wrong or right. Intake does not ask a model to override it. */
export function decisiveTeacherVerdict(q: QuestionBundle): 'wrong' | 'right' | null {
  const full = fullMarksOf(q.stem.filter(f => f.role === 'question').map(f => f.text).join('\n'));
  const certain = q.teacherMarks.filter(f => f.check === 'passed' && !f.uncertainties.length);
  if (certain.some(f => teacherMarkMeansWrong(f.text, full))) return 'wrong';
  if (q.teacherMarks.length > 0 && certain.length === q.teacherMarks.length && certain.every(f => teacherMarkMeansRight(f.text, full))) return 'right';
  return null;
}

function preferredGrade(q: QuestionBundle): Grade | undefined {
  const fresh = q.grades.filter(g => !g.stale);
  const workspace = fresh.filter(g => g.source !== 'intake');
  const pool = workspace.length ? workspace : fresh;
  return pool.find(g => g.result === 'incorrect' || g.result === 'partial')
    ?? pool.find(g => g.result === 'correct')
    ?? pool[0];
}

/** Student-facing judgment. Teacher marks win. A running grade stays confirm. AI wrong/partial is only a suggestion. */
export function intakeVerdict(q: QuestionBundle, grading = false): { verdict: IntakeVerdict; preselected: boolean } {
  const teacher = decisiveTeacherVerdict(q);
  if (teacher === 'wrong') return { verdict: 'wrong', preselected: true };
  if (teacher === 'right') return { verdict: 'right', preselected: false };
  if (grading) return { verdict: 'confirm', preselected: false };
  const grade = preferredGrade(q);
  if (!grade) return { verdict: 'confirm', preselected: false };
  if (grade.result === 'incorrect') return { verdict: 'wrong', preselected: true };
  if (grade.result === 'partial') return { verdict: 'partial', preselected: true };
  if (grade.result === 'correct') return { verdict: 'right', preselected: false };
  return { verdict: 'confirm', preselected: false };
}

function readable(f: Fragment): boolean {
  return !!f.text.trim() && (f.check === 'passed' || f.check === 'low') && !f.uncertainties.includes(BLOCKING_UNCERTAINTY);
}

type Prepared = {
  basis: ReturnType<typeof gradeBasis>;
  input: {
    questionId: string;
    attemptId: string;
    stem: Fragment[];
    work: Fragment[];
    answers: QuestionBundle['answers'];
    original: ReturnType<typeof gradeBasis>;
    answerBasis: ReturnType<typeof answerBasis>;
    source: 'intake';
    provisional: boolean;
  };
};

/** Null means "do not grade": no readable work, a decisive mark, or text that cannot support even a provisional result. */
export function prepareIntakeGrade(store: MaterialStore, questionId: string): Prepared | null {
  const q = readQuestion(store, questionId);
  if (!q || q.unresolved.length || decisiveTeacherVerdict(q)) return null;
  const stem = effectiveQuestionStem(store, q.id);
  const questions = stem.filter(f => f.role === 'question');
  if (!questions.length || !questions.every(readable)) return null;
  if (stem.some(f => f.check === 'failed' || f.check === 'unchecked' || f.uncertainties.includes(BLOCKING_UNCERTAINTY))) return null;
  if (q.missing.includes('stem') || q.missing.includes('diagram')) return null;
  const attempts = q.attempts.filter(a => a.fragments.some(f => f.role === 'student_work' && f.text.trim()));
  if (attempts.length !== 1) return null;
  const attempt = attempts[0]!;
  const work = attempt.fragments.filter(f => f.role === 'student_work' || f.role === 'correction');
  const student = work.filter(f => f.role === 'student_work');
  if (!student.length || !student.every(readable)) return null;
  if (work.some(f => f.role === 'correction' && f.text.trim() && (f.check === 'failed' || f.check === 'unchecked' || f.uncertainties.includes(BLOCKING_UNCERTAINTY)))) return null;
  if (stem.filter(f => f.role === 'diagram').length + work.length > 16 || stem.length + work.length > 32) return null;
  const ids = selectedAnswerIds(store, q.id);
  const answers = ids.map(id => q.answers.find(a => a.id === id)!);
  if (!ids.length && (q.answers.some(a => a.source !== 'ai' || !a.stale) || store.db.prepare('SELECT 1 FROM material_answer_selection WHERE owner_id=? AND question_id=?').get(store.studentId, q.id))) return null;
  if (answersConflict(answers)) return null;
  const scopes = new Set([...questions, ...work].map(f => f.subpart));
  if (answers.length && ![...scopes].every(scope => answers.some(a => a.subpart === null || a.subpart === scope))) return null;
  if ([...stem, ...work].reduce((n, f) => n + f.text.length, 0) + answers.reduce((n, a) => n + a.text.length, 0) > 40000) return null;
  const basis = gradeBasis(store, q.id, attempt.id, ids);
  const provisional = [...stem, ...work].some(f => f.check !== 'passed' || f.uncertainties.length > 0);
  return {
    basis,
    input: {
      questionId: q.id, attemptId: attempt.id, stem, work, answers, original: basis,
      answerBasis: answerBasis(store, q.id), source: 'intake', provisional,
    },
  };
}

function intakeGradeRequestId(questionId: string, basisKey: string): string {
  const hex = createHash('sha256').update(`intake-grade\0${questionId}\0${basisKey}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function questionsOnAsset(store: MaterialStore, assetId: string): QuestionBundle[] {
  return store.listQuestions().filter(q => q.stem.some(f => f.assetId === assetId)
    || q.teacherMarks.some(f => f.assetId === assetId)
    || q.attempts.some(a => a.fragments.some(f => f.assetId === assetId)));
}

/**
 * After a photo's extract has succeeded, queue the existing grade path for questions
 * that have readable work and no decisive teacher mark. Admission failures skip that
 * question. This never throws, so a full or paused queue cannot fail the extract.
 */
export function enqueueIntakeGrades(store: MaterialStore, jobs: MaterialJobs, assetIds: readonly string[]): void {
  const seen = new Set<string>();
  for (const assetId of assetIds) {
    for (const question of questionsOnAsset(store, assetId)) {
      if (seen.has(question.id)) continue;
      seen.add(question.id);
      try {
        const prepared = prepareIntakeGrade(store, question.id);
        if (!prepared) continue;
        if (question.grades.some(g => !g.stale && g.basisKey === prepared.basis.basisKey)) continue;
        const requestId = intakeGradeRequestId(question.id, prepared.basis.basisKey);
        jobs.enqueue('grade', question.id, requestId, prepared.basis.basisKey, {
          input: prepared.input,
          dependencies: prepared.basis.dependencies,
        });
      } catch (error) {
        // A full queue, a pause, or a reused request key skips this question. Anything else is a bug.
        if (error instanceof MobileRequestError && [409, 429, 503].includes(error.status)) continue;
        throw error;
      }
    }
  }
}
