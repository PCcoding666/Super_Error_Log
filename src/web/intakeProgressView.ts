import type { Fragment, QuestionBundle } from '../materials/contracts.js';
import type { SavedIntakeProgress } from '../materials/intakeProgress.js';
import { markedRight, verifiedMaterialStem } from '../materials/learning.js';
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
export function previewCandidates(progress: SavedIntakeProgress, questions: QuestionBundle[], intents: Map<string, boolean>): IntakeCandidate[] {
  if (unsupportedSubject(progress.extraction.document.subject)) return [];
  const dismissed = new Set(progress.dismissed ?? []);
  return progress.extraction.fragments.filter(f => f.role === 'question' && !dismissed.has(f.fragmentId)).flatMap(fragment => {
    const q = questions.find(q => q.stem.some(f => f.fragmentId === fragment.fragmentId));
    if (q && (q.itemId || intents.get(q.id) === false || (!progress.selected.includes(fragment.fragmentId) && markedRight(q)))) return [];
    return [{ id: `${fragment.fragmentId}:${progress.extraction.revision}`, label: fragment.number ? `第 ${fragment.number} 题` : '题号不清',
      excerpt: fragment.text.slice(0, 60), crop: previewCrop(fragment.fragmentId, progress.extraction.revision),
      status: previewStatus(progress, fragment, q), submitted: progress.selected.includes(fragment.fragmentId) }];
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
