import type { Fragment, QuestionBundle } from '../materials/contracts.js';
import { intakeVerdict } from '../materials/intakeGrade.js';
import type { SavedIntakeProgress } from '../materials/intakeProgress.js';
import { verifiedMaterialStem } from '../materials/learning.js';
import { selectableQuestion } from '../materials/regionPolicy.js';
import { unsupportedSubject } from '../materials/subjects.js';
import type { IntakeCandidate, IntakePhoto } from './apiTypes.js';

export function previewCrop(fragmentId: string, revision: number): string {
  return `/s/api/intake/candidates/${fragmentId}/crop?revision=${revision}`;
}
export function previewStatus(progress: SavedIntakeProgress, fragment: Fragment, question?: QuestionBundle): NonNullable<IntakeCandidate['status']> {
  if (question && verifiedMaterialStem(question, progress.extraction.fragments.filter(f => (f.role === 'question' || f.role === 'diagram') && (f.fragmentId === fragment.fragmentId || (f.number !== null && f.number === fragment.number))))) return 'verified';
  if (['failed', 'interrupted'].includes(progress.jobState) || fragment.check === 'failed' || fragment.check === 'low' || progress.phase === 'done') return 'needs_review';
  return fragment.text || progress.phase === 'enriching' ? 'verifying' : 'preliminary';
}
export function verdictFields(question: QuestionBundle | undefined, grading = false): Pick<IntakeCandidate, 'verdict' | 'preselected'> {
  if (!question) return { verdict: 'confirm', preselected: false };
  return intakeVerdict(question, grading);
}
export function previewCandidates(progress: SavedIntakeProgress, questions: QuestionBundle[], intents: Map<string, boolean>, grading: ReadonlySet<string> = new Set()): IntakeCandidate[] {
  if (unsupportedSubject(progress.extraction.document.subject)) return [];
  const dismissed = new Set(progress.dismissed ?? []);
  return progress.extraction.fragments.filter(f => selectableQuestion(f) && !dismissed.has(f.fragmentId)).flatMap(fragment => {
    const q = questions.find(q => q.stem.some(f => f.fragmentId === fragment.fragmentId));
    // Filed and explicitly removed questions leave the list. A right item stays visible, unchecked.
    if (q && (q.itemId || intents.get(q.id) === false)) return [];
    return [{ id: `${fragment.fragmentId}:${progress.extraction.revision}`, label: fragment.number ? `第 ${fragment.number} 题` : '题号不清',
      excerpt: fragment.text.slice(0, 60), crop: previewCrop(fragment.fragmentId, progress.extraction.revision),
      status: previewStatus(progress, fragment, q), submitted: progress.selected.includes(fragment.fragmentId),
      ...verdictFields(q, !!q && grading.has(q.id)) }];
  });
}
export function photoProgress(progress: SavedIntakeProgress): NonNullable<IntakePhoto['progress']> {
  const start = Date.parse(progress.createdAt.includes('T') ? progress.createdAt : progress.createdAt.replace(' ', 'T') + 'Z');
  const elapsed = (time: number | null) => time === null ? null : Math.max(0, time - start);
  return { stage: progress.phase, total: progress.extraction.fragments.length,
    verified: progress.extraction.fragments.filter(f => f.check === 'passed').length,
    firstBatchCount: progress.extraction.fragments.filter(f => f.role === 'question').length,
    tLocateDoneMs: elapsed(progress.locatedAt)!, tFirstSelectableMs: elapsed(progress.firstSelectableAt), tFullExtractMs: elapsed(progress.completedAt) };
}
