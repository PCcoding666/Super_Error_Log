import fs from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import type { CaptureHints, Extraction } from './contracts.js';
import type { MaterialPageImage } from './provider.js';
import { MaterialStore } from './store.js';
import { reconcileAsset } from './matching.js';
import type { MaterialJobs } from './jobs.js';
import type { MaterialUploads } from './uploads.js';
import { assertMaterialProviderConfigured, createMaterialProvider, PartialMaterialExtractionError, validateMaterialExtraction, type ExtractedMaterial, type MaterialProvider, type MaterialProviderOptions } from './provider.js';

type Input = { asset_id: string; revision: number; sourceHash: string; storage_path: string; hints_json: string };
function input(store: MaterialStore, jobId: string): Input {
  const row = store.db.prepare(`SELECT j.asset_id,a.revision,s.content_hash AS sourceHash,s.storage_path,a.hints_json
    FROM material_job j JOIN material_asset a ON a.owner_id=j.owner_id AND a.id=j.asset_id
    JOIN source_asset s ON s.id=a.source_asset_id WHERE j.owner_id=? AND j.id=? AND j.kind='extract'`)
    .get(store.studentId, jobId) as Input | undefined;
  if (!row) throw new Error('material extraction job not found'); return row;
}
/** At most eight pages, in the student's order. Callers read the bytes; this only names them. */
function setPageRows(store: MaterialStore, assetId: string): { id: string; revision: number; hints_json: string; content_hash: string; storage_path: string }[] {
  const owner = store.db.prepare('SELECT capture_id FROM material_asset WHERE owner_id=? AND id=?').get(store.studentId, assetId) as { capture_id: string } | undefined;
  if (!owner) return [];
  return store.db.prepare(`SELECT a.id, a.revision, a.hints_json, s.content_hash, s.storage_path FROM material_asset a
    JOIN source_asset s ON s.id=a.source_asset_id
    WHERE a.owner_id=? AND a.capture_id=?
    ORDER BY CAST(json_extract(a.hints_json,'$.pageIndex') AS INTEGER), a.rowid
    LIMIT 8`).all(store.studentId, owner.capture_id) as { id: string; revision: number; hints_json: string; content_hash: string; storage_path: string }[];
}
async function setPages(store: MaterialStore, assetId: string): Promise<MaterialPageImage[]> {
  const pages: MaterialPageImage[] = [];
  for (const row of setPageRows(store, assetId)) {
    let hints: CaptureHints = {};
    try { hints = JSON.parse(row.hints_json) as CaptureHints; } catch { hints = {}; }
    pages.push({ assetId: row.id, revision: row.revision, sourceHash: row.content_hash, pageIndex: hints.pageIndex ?? 0, pageKind: hints.pageKind ?? null, bytes: await fs.readFile(row.storage_path) });
  }
  return pages;
}
export type MaterialReconciler = (assetId: string, extraction: Extraction) => void | Promise<void>;

/** Persists source evidence only. Question/document association belongs to the reconciler. */
export async function extractMaterial(store: MaterialStore, provider: MaterialProvider, jobId: string, signal: AbortSignal, reconcile?: MaterialReconciler): Promise<void> {
  const row = input(store, jobId); const source = { assetId: row.asset_id, revision: row.revision, sourceHash: row.sourceHash };
  let result: ExtractedMaterial; let partial: PartialMaterialExtractionError | undefined;
  const hints = JSON.parse(row.hints_json) as CaptureHints;
  const pages = hints.captureMode === 'multi' ? await setPages(store, row.asset_id) : [];
  const lead = pages[0];
  // One combined locate for the set, on the first page only. A later page is filled in by that locate.
  const leadRun = !!lead && pages.length > 1 && lead.assetId === row.asset_id;
  if (lead && pages.length > 1 && !leadRun) {
    const saved = store.db.prepare('SELECT extraction_json FROM material_asset WHERE owner_id=? AND id=?').get(store.studentId, row.asset_id) as { extraction_json: string | null } | undefined;
    if (saved?.extraction_json) return;
  }
  const sent = leadRun ? pages : undefined;
  try { result = await provider.extract({ assetId: row.asset_id, revision: row.revision, bytes: await fs.readFile(row.storage_path), hints, pages: sent }, signal); }
  catch (error) { if (!(error instanceof PartialMaterialExtractionError)) throw error; partial = error; result = error.extraction; }
  signal.throwIfAborted();
  const bundle = leadRun && result.set?.length ? result.set : [result];
  const persisted = store.transaction(() => {
    const current = input(store, jobId);
    if (current.revision !== row.revision || current.sourceHash !== row.sourceHash) {
      store.db.prepare("UPDATE material_job SET state='stale' WHERE owner_id=? AND id=?").run(store.studentId, jobId); return false;
    }
    for (const extraction of bundle) {
      const page = pages.find(item => item.assetId === extraction.assetId);
      const pageSource = page ? { assetId: page.assetId, revision: page.revision ?? row.revision, sourceHash: page.sourceHash ?? row.sourceHash } : source;
      validateMaterialExtraction(extraction, pageSource);
      // A recovered sibling (for example a diagram) can improve completeness. Preserve
      // historical fragment evidence and append only an actual content change.
      extraction.fragments = extraction.fragments.map(fragment => {
        const previous = store.db.prepare('SELECT content_json FROM material_fragment WHERE owner_id=? AND id=? ORDER BY revision DESC LIMIT 1').get(store.studentId, fragment.fragmentId) as { content_json: string } | undefined;
        const old = previous ? JSON.parse(previous.content_json) as typeof fragment : undefined;
        const next = old && isDeepStrictEqual({ ...fragment, revision: old.revision }, old) ? old : { ...fragment, revision: old ? old.revision + 1 : fragment.revision };
        store.putFragment(next); return next;
      });
      const { set: _set, ...stored } = extraction as ExtractedMaterial;
      store.db.prepare('UPDATE material_asset SET extraction_json=?,status=? WHERE owner_id=? AND id=?').run(JSON.stringify(stored), partial ? 'partial' : 'extracted', store.studentId, extraction.assetId);
      const summary = JSON.stringify({ assetId: extraction.assetId, revision: pageSource.revision, sourceHash: pageSource.sourceHash, partial: !!partial });
      if (extraction.assetId === row.asset_id) store.db.prepare('UPDATE material_job SET result_json=? WHERE owner_id=? AND id=?').run(summary, store.studentId, jobId);
      else store.db.prepare(`UPDATE material_job SET state='succeeded', error=NULL, result_json=?, updated_at=CURRENT_TIMESTAMP WHERE owner_id=? AND asset_id=? AND kind='extract' AND id!=? AND state IN ('queued','interrupted')`).run(summary, store.studentId, extraction.assetId, jobId);
    }
    return true;
  });
  if (!persisted) return;
  for (const extraction of bundle) {
    const stored = { ...extraction }; delete (stored as ExtractedMaterial).set;
    if (stored.fragments.length) {
      if (reconcile) await reconcile(extraction.assetId, stored);
      else reconcileAsset(store, extraction.assetId);
    }
  }
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
