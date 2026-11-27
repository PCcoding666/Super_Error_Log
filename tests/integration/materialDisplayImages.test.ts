/** Display-sized materials images. Synthetic pixels only. */
import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import sharp from 'sharp';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { migrateMaterials } from '../../src/materials/schema.js';
import { MaterialStore } from '../../src/materials/store.js';
import { MaterialJobs } from '../../src/materials/jobs.js';
import { MaterialUploads } from '../../src/materials/uploads.js';
import { MobileRecognitionService } from '../../src/mobile/service.js';
import { MobileRecognitionStore } from '../../src/mobile/store.js';
import { acquireProcessImage, AdmissionController } from '../../src/mobile/admission.js';
import { createMaterialsRouter } from '../../src/web/materialsRouter.js';
import { assetImageUrl, fragmentCropUrl } from '../../src/materials/displayDerivatives.js';
import type { Fragment } from '../../src/materials/contracts.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'material-display-'));
  const db = new DatabaseSync(path.join(dir, 'app.db'));
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(SCHEMA_SQL);
  migrateMaterials(db);
  db.exec("INSERT INTO student_profile(id,nickname,created_at) VALUES ('a','Synthetic','2026-11-27')");
  const store = new MaterialStore(db, 'a');
  const admission = new AdmissionController({ jobCapacity: 2, diskProbe: async () => 10n ** 12n });
  const scheduler = new MobileRecognitionService(await MobileRecognitionStore.open(dir), {
    inventory: async () => ({ candidates: [], warnings: [], capacityReached: false }),
    recognizeQuestion: async () => { throw new Error('unused'); },
  });
  scheduler.useAdmission(admission);
  const jobs = new MaterialJobs(store, scheduler, admission);
  const uploads = new MaterialUploads(store, jobs, admission);
  await uploads.initialize();
  const app = express();
  app.use('/s', createMaterialsRouter({ store, uploads, jobs, admission, draftNamespace: store.getWorkspace().draftNamespace }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await scheduler.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const bytes = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: '#246' } }).jpeg().toBuffer();
  const saved = await uploads.save({ captureId: store.createCapture(randomUUID()).id, uploadId: randomUUID(), filename: 'synthetic.jpg', bytes, hints: {} });
  const source = uploads.source(saved.assetId);
  const fragment: Fragment = {
    assetId: saved.assetId, fragmentId: 'mfr_display', revision: 1, sourceHash: source.sourceHash,
    box: { x: 0, y: 0, width: 1, height: 1 }, role: 'question', text: 'synthetic', number: '1', subpart: null,
    page: 1, order: 0, requiresDiagram: false, check: 'passed', uncertainties: [],
  };
  store.putFragment(fragment);
  return { base, saved, source, fragment, bytes };
}

async function jpeg(response: Response): Promise<{ width: number; height: number; bytes: number; cache: string | null; type: string | null }> {
  const body = Buffer.from(await response.arrayBuffer());
  const meta = await sharp(body).metadata();
  return { width: meta.width ?? 0, height: meta.height ?? 0, bytes: body.length, cache: response.headers.get('cache-control'), type: response.headers.get('content-type') };
}

it('serves display JPEGs from disk and keeps the original uncached', async () => {
  const f = await fixture();
  const bigUrl = assetImageUrl(f.saved.assetId, f.source.sourceHash, 'big');
  const thumbUrl = assetImageUrl(f.saved.assetId, f.source.sourceHash, 'thumb');
  const originalUrl = assetImageUrl(f.saved.assetId, null, null);
  const first = await jpeg(await fetch(f.base + bigUrl));
  expect(first.type).toContain('image/jpeg');
  expect(first.width).toBeLessThanOrEqual(1088);
  expect(first.bytes).toBeLessThan(f.bytes.length);
  expect(first.cache).toBe('private, max-age=31536000, immutable');
  const thumb = await jpeg(await fetch(f.base + thumbUrl));
  expect(Math.max(thumb.width, thumb.height)).toBeLessThanOrEqual(168);
  expect(thumb.cache).toContain('immutable');
  const release = await acquireProcessImage();
  try {
    const again = await jpeg(await fetch(f.base + bigUrl));
    expect(again.bytes).toBe(first.bytes);
    expect(again.width).toBe(first.width);
  } finally { release(); }
  renameSync(f.source.originalPath, `${f.source.originalPath}.held`);
  const fromDisk = await jpeg(await fetch(f.base + bigUrl));
  expect(fromDisk.bytes).toBe(first.bytes);
  renameSync(`${f.source.originalPath}.held`, f.source.originalPath);
  const original = await jpeg(await fetch(f.base + originalUrl));
  expect(original.width).toBe(2400);
  expect(original.cache).toBe('private, no-store');
  expect(original.bytes).toBeGreaterThan(first.bytes);
  const bare = await fetch(f.base + `${bigUrl.split('?')[0]}?s=big`);
  expect(bare.headers.get('cache-control')).toBe('private, no-store');
});

it('writes a missing crop derivative once and then serves that file', async () => {
  const f = await fixture();
  const url = fragmentCropUrl(f.fragment, 'big');
  const first = await jpeg(await fetch(f.base + url));
  expect(first.type).toContain('image/jpeg');
  expect(first.width).toBeLessThanOrEqual(1088);
  expect(first.width).toBeLessThan(2400);
  expect(first.cache).toContain('immutable');
  const release = await acquireProcessImage();
  try {
    const again = await jpeg(await fetch(f.base + url));
    expect(again.bytes).toBe(first.bytes);
  } finally { release(); }
  const full = await jpeg(await fetch(f.base + url.replace(/[?&]s=big/, '').replace(/[?&]v=[^&]+/, '')));
  expect(full.width).toBe(2400);
  expect(full.cache).toContain('no-store');
});
