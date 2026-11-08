import type { Extraction, Fragment, QuestionBundle } from './contracts.js';
import type { MaterialStore } from './store.js';

export type IntakeProgress = {
  extraction: Extraction;
  phase: 'located' | 'enriching' | 'done';
  sourceHash: string;
  selected: string[];
  locatedAt: number;
  firstSelectableAt: number | null;
  completedAt: number | null;
};
export type SavedIntakeProgress = IntakeProgress & { jobId: string; jobState: string; createdAt: string };
type Job = { id: string; state: string; input_json: string; created_at: string };
export const active = (state: string) => ['queued', 'running', 'interrupted'].includes(state);
export function sourceOf(store: MaterialStore, assetId: string) {
  return store.db.prepare(`SELECT a.revision,s.content_hash AS sourceHash FROM material_asset a
    JOIN source_asset s ON s.id=a.source_asset_id WHERE a.owner_id=? AND a.id=?`).get(store.studentId, assetId) as { revision: number; sourceHash: string } | undefined;
}
export function jobOf(store: MaterialStore, jobId: string): Job | undefined {
  return store.db.prepare('SELECT id,state,input_json,created_at FROM material_job WHERE owner_id=? AND id=? AND kind=\'extract\'').get(store.studentId, jobId) as Job | undefined;
}
export function current(store: MaterialStore, progress: IntakeProgress): boolean {
  const source = sourceOf(store, progress.extraction.assetId);
  return !!source && source.revision === progress.extraction.revision && source.sourceHash === progress.sourceHash;
}
export function write(store: MaterialStore, job: Job, progress: IntakeProgress): void {
  // Always read the latest input, preserving both student picks and model checkpoints.
  const input = JSON.parse(job.input_json);
  input.intakeProgress ??= {};
  const { extraction, phase, sourceHash, selected, locatedAt, firstSelectableAt, completedAt } = progress;
  input.intakeProgress[extraction.assetId] = { extraction, phase, sourceHash, selected, locatedAt, firstSelectableAt, completedAt };
  store.db.prepare('UPDATE material_job SET input_json=? WHERE owner_id=? AND id=?').run(JSON.stringify(input), store.studentId, job.id);
}
export function readIntakeProgress(store: MaterialStore): Map<string, SavedIntakeProgress> {
  const rows = store.db.prepare(`SELECT id,state,input_json,created_at FROM material_job WHERE owner_id=? AND kind='extract'
    AND state!='stale' AND COALESCE(json_extract(error,'$.code'),'')!='set_abandoned' AND json_type(input_json,'$.intakeProgress')='object' ORDER BY rowid DESC`).all(store.studentId) as Job[];
  const result = new Map<string, SavedIntakeProgress>();
  for (const job of rows) {
    const pages = JSON.parse(job.input_json).intakeProgress as Record<string, IntakeProgress>;
    for (const progress of Object.values(pages)) {
      if (result.has(progress.extraction.assetId) || !current(store, progress)) continue;
      result.set(progress.extraction.assetId, { ...progress, jobId: job.id, jobState: job.state, createdAt: job.created_at });
    }
  }
  return result;
}
/** Expected stem includes the final extraction, even while links are still being
 * applied, plus located regions omitted by a partial extraction. */
export function expectedIntakeStem(store: MaterialStore, question: QuestionBundle): Fragment[] {
  const expected: Fragment[] = [];
  const previews = readIntakeProgress(store);
  for (const assetId of new Set(question.stem.map(f => f.assetId))) {
    const row = store.db.prepare(`SELECT a.revision,a.extraction_json,s.content_hash FROM material_asset a
      JOIN source_asset s ON s.id=a.source_asset_id WHERE a.owner_id=? AND a.id=?`).get(store.studentId, assetId) as {revision:number;extraction_json:string|null;content_hash:string}|undefined;
    if (!row) continue;
    if (row.extraction_json) {
      const extraction = JSON.parse(row.extraction_json) as Extraction;
      if (extraction.revision === row.revision) expected.push(...extraction.fragments.filter(f => f.sourceHash === row.content_hash));
    }
    expected.push(...(previews.get(assetId)?.extraction.fragments ?? []));
  }
  return expected.filter(f => (f.role === 'question' || f.role === 'diagram') &&
    question.stem.some(s => s.assetId === f.assetId && s.sourceHash === f.sourceHash &&
      (s.fragmentId === f.fragmentId || (s.number !== null && s.number === f.number))));
}
