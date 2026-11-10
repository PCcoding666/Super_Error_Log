import fs from 'node:fs/promises';
import { saveIntakeProgress, completeIntakeProgress } from './intakeProgress.js';
import { isDeepStrictEqual } from 'node:util';
import { SET_PAGE_MISSING } from './captureHints.js';
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

function jobRole(store: MaterialStore, jobId: string): string | undefined {
  const row = store.db.prepare('SELECT input_json FROM material_job WHERE owner_id=? AND id=?').get(store.studentId, jobId) as { input_json: string } | undefined;
  if (!row) return undefined;
  try {
    const value = JSON.parse(row.input_json) as { setRole?: unknown };
    return typeof value.setRole === 'string' ? value.setRole : undefined;
  } catch { return undefined; }
}

/** Followers the lead did not write stay retryable instead of queued forever. A retry reads that page alone. */
function settleUncoveredFollowers(store: MaterialStore, leadAssetId: string, covered: ReadonlySet<string>): void {
  const owner = store.db.prepare('SELECT capture_id FROM material_asset WHERE owner_id=? AND id=?').get(store.studentId, leadAssetId) as { capture_id: string } | undefined;
  if (!owner) return;
  const rows = store.db.prepare(`SELECT j.id, j.input_json, j.asset_id AS assetId FROM material_job j
    JOIN material_asset a ON a.owner_id=j.owner_id AND a.id=j.asset_id
    WHERE j.owner_id=? AND j.kind='extract' AND a.capture_id=? AND j.state IN ('queued','interrupted')`).all(store.studentId, owner.capture_id) as { id: string; input_json: string; assetId: string }[];
  for (const row of rows) {
    if (row.assetId === leadAssetId || covered.has(row.assetId)) continue;
    let input: Record<string, unknown> = {};
    try {
      const value = JSON.parse(row.input_json) as unknown;
      input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    } catch { input = {}; }
    if (input.deferred === true || input.setRole !== 'follow') continue;
    delete input.deferred;
    delete input.setRole;
    store.db.prepare(`UPDATE material_job SET state='failed', error=?, input_json=?, updated_at=CURRENT_TIMESTAMP WHERE owner_id=? AND id=? AND state IN ('queued','interrupted')`)
      .run(JSON.stringify(SET_PAGE_MISSING), JSON.stringify(input), store.studentId, row.id);
  }
}

/** Persists source evidence only. Question/document association belongs to the reconciler. */
export async function extractMaterial(store: MaterialStore, provider: MaterialProvider, jobId: string, signal: AbortSignal, reconcile?: MaterialReconciler): Promise<void> {
  const row = input(store, jobId); const source = { assetId: row.asset_id, revision: row.revision, sourceHash: row.sourceHash };
  const hints = JSON.parse(row.hints_json) as CaptureHints;
  const pages = hints.captureMode === 'multi' ? await setPages(store, row.asset_id) : [];
  // The chosen lead reads the set, even if a later page sorts first. Other pages are filled in by that read.
  const leadRun = jobRole(store, jobId) === 'lead' && pages.length > 1;
  if (pages.length > 1 && !leadRun) {
    const saved = store.db.prepare('SELECT extraction_json FROM material_asset WHERE owner_id=? AND id=?').get(store.studentId, row.asset_id) as { extraction_json: string | null } | undefined;
    if (saved?.extraction_json) return;
  }
  const covered = new Set<string>();
  try {
    let result: ExtractedMaterial; let partial: PartialMaterialExtractionError | undefined;
    const sent = leadRun ? pages : undefined;
    try { result = await provider.extract({ assetId: row.asset_id, revision: row.revision, bytes: await fs.readFile(row.storage_path), hints, pages: sent, onProgress: update => {
      signal.throwIfAborted();
      const target = update.extraction.assetId === source.assetId ? source : sent?.find(page => page.assetId === update.extraction.assetId);
      if (!target?.sourceHash) throw new Error('Progress named a page outside this extraction');
      const current = input(store, jobId);
      if (current.revision !== row.revision || current.sourceHash !== row.sourceHash) throw new Error('Extraction source changed');
      saveIntakeProgress(store, jobId, update, target.sourceHash);
    } }, signal); }
    catch (error) { if (!(error instanceof PartialMaterialExtractionError)) throw error; partial = error; result = error.extraction; }
    signal.throwIfAborted();
    const bundle = leadRun && result.set?.length ? result.set : [result];
    const persisted = store.transaction(() => {
      const current = input(store, jobId);
      if (current.revision !== row.revision || current.sourceHash !== row.sourceHash) {
        store.db.prepare("UPDATE material_job SET state='stale' WHERE owner_id=? AND id=?").run(store.studentId, jobId); return null;
      }
      const job = store.db.prepare('SELECT state FROM material_job WHERE owner_id=? AND id=?').get(store.studentId, jobId) as { state: string } | undefined;
      // Abandon (or another terminal write) can land while the model call is in flight. Do not publish over it.
      if (!job || !['queued', 'running', 'interrupted'].includes(job.state)) return null;
      const wrote: string[] = [];
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
        wrote.push(extraction.assetId);
      }
      return wrote;
    });
    if (!persisted) return;
    for (const assetId of persisted) covered.add(assetId);
    const storedBundle = bundle.map(extraction => {
      const stored = { ...extraction }; delete (stored as ExtractedMaterial).set;
      return stored;
    });
    for (const extraction of storedBundle) {
      if (extraction.fragments.length) {
        if (reconcile) await reconcile(extraction.assetId, extraction);
        else reconcileAsset(store, extraction.assetId);
      }
    }
    // A later page may attach a same-question diagram or continuation. Evaluate
    // saved selections only after every page in this result has been reconciled.
    for (const extraction of storedBundle) completeIntakeProgress(store, jobId, extraction, !!partial);
    if (partial) throw partial.failure;
  } finally {
    if (leadRun && !signal.aborted) settleUncoveredFollowers(store, row.asset_id, covered);
  }
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
