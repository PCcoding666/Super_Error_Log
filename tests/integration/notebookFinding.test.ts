/** A queued material extract with no questions yet must raise notebook finding. Failed jobs stay out. Synthetic only. */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { getDb, newId, now } from '../../src/db/connection.js';
import { materialIntakeSummary } from '../../src/materials/learning.js';
import { MaterialStore } from '../../src/materials/store.js';
import { MobileRecognitionService } from '../../src/mobile/service.js';
import { MobileRecognitionStore } from '../../src/mobile/store.js';
import { ensureStudentProfile } from '../../src/services/studentService.js';
import { createStudentApi } from '../../src/web/api.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'notebook-finding-'));
let owner = '';
let store: MaterialStore;
let scheduler: MobileRecognitionService;
let server: ReturnType<express.Express['listen']>;
let base = '';

function addAsset(): string {
  const db = getDb();
  const batch = newId('bat');
  const asset = newId('ast');
  db.prepare('INSERT INTO source_batch(id,student_id,created_at) VALUES (?,?,?)').run(batch, owner, now());
  db.prepare('INSERT INTO source_asset(id,batch_id,filename,mime,size,content_hash,storage_path,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(asset, batch, 'synthetic.jpg', 'image/jpeg', 1, asset, '/synthetic.jpg', now());
  const capture = store.createCapture(randomUUID());
  db.prepare('INSERT INTO material_asset(id,owner_id,capture_id,source_asset_id) VALUES (?,?,?,?)').run(asset, owner, capture.id, asset);
  return asset;
}

function addJob(assetId: string, state: string): void {
  getDb().prepare('INSERT INTO material_job(id,owner_id,request_id,kind,asset_id,state) VALUES (?,?,?,?,?,?)')
    .run(newId('mjb'), owner, randomUUID(), 'extract', assetId, state);
}

beforeAll(async () => {
  owner = ensureStudentProfile().id;
  store = new MaterialStore(getDb(), owner);
  scheduler = new MobileRecognitionService(await MobileRecognitionStore.open(dir), {
    inventory: async () => ({ candidates: [], warnings: [], capacityReached: false }),
    recognizeQuestion: async () => { throw new Error('unused'); },
  });
  const app = express();
  app.use('/s/api', createStudentApi(
    { mobileDataDir: dir, materials: store, service: scheduler, timeZone: 'Asia/Singapore', now: () => new Date('2026-11-21T03:00:00Z') },
    { studentHostWorker: true, service: scheduler, accountRoleOf: () => 'student', inviteExpiresOf: () => null },
  ));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  if (scheduler) await scheduler.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function notebook(query = ''): Promise<{ finding: number; pendingIntake: number; total: number }> {
  const response = await fetch(`${base}/s/api/notebook${query}`, { headers: { accept: 'application/json' } });
  expect(response.status).toBe(200);
  return response.json();
}

it('a queued extract with zero questions makes finding > 0 and leaves pendingIntake at 0; a failed job does not', async () => {
  expect(await notebook()).toMatchObject({ finding: 0, pendingIntake: 0, total: 0 });
  const asset = addAsset();
  addJob(asset, 'queued');
  expect(materialIntakeSummary(store)).toMatchObject({ processing: 1, pending: 0 });
  expect((getDb().prepare('SELECT count(*) n FROM material_question').get() as { n: number }).n).toBe(0);
  expect(await notebook()).toMatchObject({ finding: 1, pendingIntake: 0, total: 0 });
  // Subject filters do not clear the in-progress count. An empty chemistry notebook still shows the hint.
  expect(await notebook('?subject=' + encodeURIComponent('化学'))).toMatchObject({ finding: 1, pendingIntake: 0, total: 0 });

  getDb().prepare("UPDATE material_job SET state='running' WHERE asset_id=?").run(asset);
  expect(materialIntakeSummary(store).processing).toBe(1);
  expect((await notebook()).finding).toBe(1);

  getDb().prepare("UPDATE material_job SET state='failed' WHERE asset_id=?").run(asset);
  expect(materialIntakeSummary(store).processing).toBe(0);
  expect(await notebook()).toMatchObject({ finding: 0, pendingIntake: 0, total: 0 });

  getDb().prepare("UPDATE material_job SET state='interrupted' WHERE asset_id=?").run(asset);
  expect((await notebook()).finding).toBe(0);

  getDb().prepare("UPDATE material_job SET state='queued' WHERE asset_id=?").run(asset);
  // A legacy photo still being read is added to the material count, not replaced by it.
  getDb().prepare('INSERT INTO v2_photo(job_id, student_id, registered_at) VALUES (?,?,?)').run('synthetic-processing', owner, now());
  expect((await notebook()).finding).toBe(2);

  addJob(asset, 'succeeded');
  expect(materialIntakeSummary(store).processing).toBe(0);
  expect((await notebook()).finding).toBe(1);
});
