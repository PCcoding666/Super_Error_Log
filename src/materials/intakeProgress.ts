import { active, sourceOf, jobOf, current, write, readIntakeProgress, expectedIntakeStem, type IntakeProgress, type SavedIntakeProgress } from './intakeProgressState.js';
export { readIntakeProgress, expectedIntakeStem, type IntakeProgress, type SavedIntakeProgress } from './intakeProgressState.js';
import { isDeepStrictEqual } from 'node:util';
import type { Extraction, Fragment, QuestionBundle } from './contracts.js';
import type { MaterialStore } from './store.js';
import { validateMaterialExtraction, type MaterialExtractionProgress } from './provider.js';
import { inclusionIntent, setQuestionIncluded, verifiedMaterialStem } from './learning.js';
import { MobileRequestError } from '../mobile/service.js';

/** A UI projection, not learning evidence. Stored alongside durable model checkpoints;
 * no schema migration and no second locate call. Never returned as raw job JSON. */
export function saveIntakeProgress(store: MaterialStore, jobId: string, update: MaterialExtractionProgress, expectedSourceHash: string): void {
  store.transaction(() => {
    const job = jobOf(store, jobId);
    if (!job || !active(job.state)) throw new MobileRequestError(409, 'stale_basis', '材料已更新，请重新整理。');
    const source = sourceOf(store, update.extraction.assetId);
    if (!source || source.revision !== update.extraction.revision || source.sourceHash !== expectedSourceHash)
      throw new MobileRequestError(409, 'stale_basis', '材料已更新，请重新整理。');
    validateMaterialExtraction(update.extraction, { assetId: update.extraction.assetId, ...source });
    const old: IntakeProgress | undefined = JSON.parse(job.input_json).intakeProgress?.[update.extraction.assetId];
    const same = old && current(store, old);
    // A replayed locate must not erase already visible text or a submitted selection.
    const fragments = update.extraction.fragments.map(f => {
      const before = same ? old.extraction.fragments.find(p => p.fragmentId === f.fragmentId && isDeepStrictEqual(p.box, f.box) && p.role === f.role) : undefined;
      return before && update.phase === 'located' ? before : f;
    });
    const time = Date.now();
    const dismissed = same ? (old.dismissed ?? []).filter(id => fragments.some(f => f.fragmentId === id && f.role === 'question')) : [];
    write(store, job, {
      extraction: { ...structuredClone(update.extraction), fragments }, sourceHash: source.sourceHash,
      phase: same && old.phase !== 'located' ? 'enriching' : update.phase,
      selected: same ? old.selected.filter(id => !dismissed.includes(id) && fragments.some(f => f.fragmentId === id && f.role === 'question')) : [],
      dismissed,
      locatedAt: same ? old.locatedAt : time,
      firstSelectableAt: (same ? old.firstSelectableAt : null) ?? (fragments.some(f => f.role === 'question') ? time : null),
      completedAt: null,
    });
  });
}
export function progressQuestion(progress: IntakeProgress, q: QuestionBundle): boolean {
  return q.stem.some(f => f.role === 'question' && progress.extraction.fragments.some(p => p.fragmentId === f.fragmentId));
}
export function findPreview(store: MaterialStore, fragmentId: string, revision: number): { progress: SavedIntakeProgress; fragment: Fragment } | null {
  for (const progress of readIntakeProgress(store).values()) {
    if (progress.extraction.revision !== revision) continue;
    const fragment = progress.extraction.fragments.find(f => f.fragmentId === fragmentId && f.role === 'question');
    if (fragment) return { progress, fragment };
  }
  return null;
}
/** The final source-backed question must be complete and verified. A selection is
 * durable even when this gate cannot yet be met; neither GET nor retry invents trust. */
export function flushIntakeSelections(store: MaterialStore, assetId: string): void {
  const progress = readIntakeProgress(store).get(assetId);
  if (!progress) return;
  const dismissed = new Set(progress.dismissed ?? []);
  for (const q of store.listQuestions()) {
    if (!q.stem.some(f => progress.selected.includes(f.fragmentId) && !dismissed.has(f.fragmentId)) || !verifiedMaterialStem(q, expectedIntakeStem(store, q))) continue;
    if (q.itemId || inclusionIntent(store, q.id) === false) continue;
    setQuestionIncluded(store, q.id, true, q.revision);
  }
}
export function completeIntakeProgress(store: MaterialStore, jobId: string, extraction: Extraction, partial: boolean): void {
  const job = jobOf(store, jobId);
  const old: IntakeProgress | undefined = job && JSON.parse(job.input_json).intakeProgress?.[extraction.assetId];
  if (!job || !old || !current(store, old) || !active(job.state)) return;
  const byId = new Map(extraction.fragments.map(f => [f.fragmentId, f]));
  write(store, job, { ...old, phase: partial ? 'enriching' : 'done', completedAt: partial ? null : Date.now(),
    extraction: { ...extraction, fragments: old.extraction.fragments.map(f => byId.get(f.fragmentId) ?? { ...f, check: 'failed' }) },
  });
  flushIntakeSelections(store, extraction.assetId);
}
export function selectPreviewCandidates(store: MaterialStore, assetId: string, picks: { questionId: string; revision: number }[]): { included: number; pending: number; skipped: number } {
  return store.transaction(() => {
    const progress = readIntakeProgress(store).get(assetId);
    if (!progress) return { included: 0, pending: 0, skipped: picks.length };
    const dismissed = new Set(progress.dismissed ?? []);
    const accepted = picks.filter(p => p.revision === progress.extraction.revision && !dismissed.has(p.questionId) && progress.extraction.fragments.some(f => f.fragmentId === p.questionId && f.role === 'question'));
    const job = jobOf(store, progress.jobId)!;
    write(store, job, { ...progress, selected: [...new Set([...progress.selected, ...accepted.map(p => p.questionId)])] });
    flushIntakeSelections(store, assetId);
    const questions = store.listQuestions();
    const included = accepted.filter(p => questions.some(q => q.itemId && q.stem.some(f => f.fragmentId === p.questionId))).length;
    return { included, pending: accepted.length - included, skipped: picks.length - accepted.length };
  });
}

/**
 * Drop preview candidates from the intake list. Removes any pending selection so a later
 * flush cannot file them. If the question row does not exist yet, only the fragment is
 * remembered; syncMaterialLearning records the exclusion once extraction creates the question.
 * A question that already has a notebook item is left alone.
 */
export function dismissPreviewCandidates(store: MaterialStore, assetId: string, picks: { questionId: string; revision: number }[]): { dismissed: string[]; skipped: string[] } {
  return store.transaction(() => {
    const progress = readIntakeProgress(store).get(assetId);
    if (!progress) return { dismissed: [], skipped: picks.map(p => p.questionId) };
    const dismissed = new Set(progress.dismissed ?? []);
    const gone: string[] = [];
    const skipped: string[] = [];
    for (const pick of picks) {
      const fragment = progress.extraction.fragments.find(f => f.fragmentId === pick.questionId && f.role === 'question');
      if (!fragment || pick.revision !== progress.extraction.revision) { skipped.push(pick.questionId); continue; }
      const q = store.listQuestions().find(item => item.stem.some(f => f.fragmentId === pick.questionId));
      if (q?.itemId) { skipped.push(pick.questionId); continue; }
      if (q && inclusionIntent(store, q.id) !== false) {
        try { setQuestionIncluded(store, q.id, false, q.revision); }
        catch (error) {
          if (error instanceof MobileRequestError && [400, 404, 409].includes(error.status)) { skipped.push(pick.questionId); continue; }
          throw error;
        }
      }
      dismissed.add(pick.questionId);
      gone.push(pick.questionId);
    }
    const latest = readIntakeProgress(store).get(assetId);
    const job = latest ? jobOf(store, latest.jobId) : undefined;
    if (latest && job) {
      write(store, job, {
        ...latest,
        selected: latest.selected.filter(id => !dismissed.has(id)),
        dismissed: [...dismissed],
      });
    }
    return { dismissed: gone, skipped };
  });
}
