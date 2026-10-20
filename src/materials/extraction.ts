import fs from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import type { Extraction } from './contracts.js';
import { MaterialStore } from './store.js';
import type { MaterialJobs } from './jobs.js';
import type { MaterialUploads } from './uploads.js';
import { assertMaterialProviderConfigured, createMaterialProvider, PartialMaterialExtractionError, validateMaterialExtraction, type MaterialProvider, type MaterialProviderOptions } from './provider.js';

type Input = { asset_id: string; revision: number; sourceHash: string; storage_path: string; hints_json: string };
function input(store: MaterialStore, jobId: string): Input {
  const row = store.db.prepare(`SELECT j.asset_id,a.revision,s.content_hash AS sourceHash,s.storage_path,a.hints_json
    FROM material_job j JOIN material_asset a ON a.owner_id=j.owner_id AND a.id=j.asset_id
    JOIN source_asset s ON s.id=a.source_asset_id WHERE j.owner_id=? AND j.id=? AND j.kind='extract'`)
    .get(store.studentId, jobId) as Input | undefined;
  if (!row) throw new Error('material extraction job not found'); return row;
}
export type MaterialReconciler = (assetId: string, extraction: Extraction) => void | Promise<void>;

/** Persists source evidence only. Question/document association belongs to the reconciler. */
export async function extractMaterial(store: MaterialStore, provider: MaterialProvider, jobId: string, signal: AbortSignal, reconcile?: MaterialReconciler): Promise<void> {
  const row = input(store, jobId); const source = { assetId: row.asset_id, revision: row.revision, sourceHash: row.sourceHash };
  let result: Extraction; let partial: PartialMaterialExtractionError | undefined;
  try { result = await provider.extract({ assetId: row.asset_id, revision: row.revision, bytes: await fs.readFile(row.storage_path), hints: JSON.parse(row.hints_json) }, signal); }
  catch (error) { if (!(error instanceof PartialMaterialExtractionError)) throw error; partial = error; result = error.extraction; }
  signal.throwIfAborted(); validateMaterialExtraction(result, source);
  const persisted = store.transaction(() => {
    const current = input(store, jobId);
    if (current.revision !== row.revision || current.sourceHash !== row.sourceHash) {
      store.db.prepare("UPDATE material_job SET state='stale' WHERE owner_id=? AND id=?").run(store.studentId, jobId); return false;
    }
    // A recovered sibling (for example a diagram) can improve completeness. Preserve
    // historical fragment evidence and append only an actual content change.
    result = { ...result, fragments: result.fragments.map(fragment => {
      const previous = store.db.prepare('SELECT content_json FROM material_fragment WHERE owner_id=? AND id=? ORDER BY revision DESC LIMIT 1').get(store.studentId, fragment.fragmentId) as { content_json: string } | undefined;
      const old = previous ? JSON.parse(previous.content_json) as typeof fragment : undefined;
      const next = old && isDeepStrictEqual({ ...fragment, revision: old.revision }, old) ? old : { ...fragment, revision: old ? old.revision + 1 : fragment.revision };
      store.putFragment(next); return next;
    }) };
    store.db.prepare('UPDATE material_asset SET extraction_json=?,status=? WHERE owner_id=? AND id=?').run(JSON.stringify(result), partial ? 'partial' : 'extracted', store.studentId, row.asset_id);
    store.db.prepare('UPDATE material_job SET result_json=? WHERE owner_id=? AND id=?').run(JSON.stringify({ assetId: row.asset_id, revision: row.revision, partial: !!partial }), store.studentId, jobId);
    return true;
  });
  if (!persisted) return;
  if (result.fragments.length) await reconcile?.(row.asset_id, result);
  if (partial) throw partial.failure;
}

/** Configure before jobs.resume(): a fresh closure binds each job's source and durable request executor. */
export function registerMaterialExtraction(store: MaterialStore, jobs: MaterialJobs, uploads: MaterialUploads, options: MaterialProviderOptions, reconcile?: MaterialReconciler): void {
  assertMaterialProviderConfigured(options);
  jobs.register('extract', async (jobId, signal) => {
    const row = input(store, jobId); const source = uploads.source(row.asset_id);
    const provider = createMaterialProvider(options, { source: { assetId: row.asset_id, revision: row.revision, sourceHash: source.sourceHash }, request: (key, invoke) => jobs.request(jobId, key, invoke) });
    await extractMaterial(store, provider, jobId, signal, reconcile);
  });
}
