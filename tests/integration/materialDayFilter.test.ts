/** 上传材料按新加坡自然日筛选：默认列表不变；单日含日界；空日不报错；筛选和分页一起算，且只看本人的。 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { migrateMaterials } from '../../src/materials/schema.js';
import { MaterialStore } from '../../src/materials/store.js';
import { MaterialJobs } from '../../src/materials/jobs.js';
import { MaterialUploads } from '../../src/materials/uploads.js';
import { MobileRecognitionService } from '../../src/mobile/service.js';
import { MobileRecognitionStore } from '../../src/mobile/store.js';
import { AdmissionController } from '../../src/mobile/admission.js';
import { createMaterialsRouter } from '../../src/web/materialsRouter.js';
import { createStudentApi } from '../../src/web/api.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'material-day-'));
const db = new DatabaseSync(path.join(dir, 'app.db'));
db.exec('PRAGMA foreign_keys=ON');
db.exec(SCHEMA_SQL);
migrateMaterials(db);
db.exec("INSERT INTO student_profile(id,nickname,created_at) VALUES ('a','Synthetic A','2026-10-20'),('b','Synthetic B','2026-10-20')");
const store = new MaterialStore(db, 'a');
const other = new MaterialStore(db, 'b');

function addAsset(owner: MaterialStore, id: string, at: string): void {
  const batch = `${id}_bat`;
  const source = `${id}_src`;
  db.prepare('INSERT INTO source_batch(id,student_id,created_at) VALUES (?,?,?)').run(batch, owner.studentId, at);
  db.prepare('INSERT INTO source_asset(id,batch_id,filename,mime,size,content_hash,storage_path,created_at) VALUES (?,?,?,?,?,?,?,?)').run(source, batch, 's.jpg', 'image/jpeg', 1, id, '/synthetic.jpg', at);
  const capture = owner.createCapture(id);
  db.prepare('INSERT INTO material_asset(id,owner_id,capture_id,source_asset_id,created_at) VALUES (?,?,?,?,?)').run(id, owner.studentId, capture.id, source, at);
}

const january = Array.from({ length: 9 }, (_, i) => [`seq${i}`, `2026-01-01 00:00:0${i}`] as const);
const november = [
  ['eve', '2026-11-03 15:59:59'],
  ['midnight', '2026-11-03 16:00:00'],
  ['iso', '2026-11-03T16:00:01.000Z'],
  ['morning', '2026-11-04 03:00:00'],
  ['late', '2026-11-04 15:59:59'],
  ['next', '2026-11-04 16:00:00'],
] as const;
const sixth = Array.from({ length: 9 }, (_, i) => [`p${i}`, `2026-11-05 16:00:0${i}`] as const);
for (const [id, at] of [...january, ...november, ...sixth]) addAsset(store, id, at);
addAsset(other, 'other-midnight', '2026-11-04 03:00:01');

const asc = [...january, ...november, ...sixth].map(([id]) => id);
const desc = [...asc].reverse();

let base = '';
let scheduler: MobileRecognitionService | undefined;
let server: ReturnType<express.Express['listen']> | undefined;

beforeAll(async () => {
  const admission = new AdmissionController({ jobCapacity: 1, diskProbe: async () => 10n ** 12n });
  scheduler = new MobileRecognitionService(await MobileRecognitionStore.open(dir), { inventory: async () => ({ candidates: [], warnings: [], capacityReached: false }), recognizeQuestion: async () => { throw Error('unused'); } });
  scheduler.useAdmission(admission);
  const jobs = new MaterialJobs(store, scheduler, admission);
  const uploads = new MaterialUploads(store, jobs, admission);
  await uploads.initialize();
  const app = express();
  app.use('/s/api', createStudentApi(
    { mobileDataDir: dir, materials: store, service: scheduler, timeZone: 'Asia/Singapore', now: () => new Date('2026-11-04T03:00:00Z') },
    { studentHostWorker: true, service: scheduler, accountRoleOf: () => 'student', inviteExpiresOf: () => null },
  ));
  app.use('/s', createMaterialsRouter({ store, jobs, uploads, admission, draftNamespace: store.getWorkspace().draftNamespace }));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server!.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/s`;
});

afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server!.close(() => resolve()));
  }
  if (scheduler) await scheduler.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function assetIds(html: string): string[] {
  const ids = [...html.matchAll(/\/s\/materials\/assets\/([^"/]+)\/image/g)].map(match => match[1]!);
  return ids.filter((id, index) => ids.indexOf(id) === index);
}

async function html(path: string): Promise<{ status: number; text: string }> {
  const response = await fetch(base + path);
  return { status: response.status, text: await response.text() };
}

async function intake(path: string): Promise<{ status: number; body: { photos?: { id: string; number: number }[]; filter?: unknown; page?: number; total?: number; hasMore?: boolean; error?: { message: string } } }> {
  const response = await fetch(base + '/api/intake' + path, { headers: { accept: 'application/json' } });
  return { status: response.status, body: await response.json() };
}

it('筛选关闭时，原图仍按 created_at 升序每页 8 条，录入列表仍是全部、新的在前', async () => {
  const page = await html('/materials');
  expect(page.status).toBe(200);
  expect(assetIds(page.text)).toEqual(asc.slice(0, 8));
  expect(page.text).toContain('href="/s/materials?page=1"');
  expect(page.text).not.toContain('date=');
  const next = await html('/materials?page=1');
  expect(assetIds(next.text).slice(0, 1)).toEqual(['seq8']);
  const all = await intake('');
  expect(all.status).toBe(200);
  expect(all.body.photos?.map(photo => photo.id)).toEqual(desc);
  expect(all.body.photos?.[0]?.number).toBe(desc.length);
  expect(all.body.photos?.at(-1)?.number).toBe(1);
  expect(all.body.filter).toBeUndefined();
  expect(all.body.page).toBeUndefined();
  expect(all.body.photos?.some(photo => photo.id === 'other-midnight')).toBe(false);
});

it('单日只含新加坡那一天，23:59:59 算当天、次日 00:00 不算，ISO 时间戳也算', async () => {
  const page = await html('/materials?date=2026-11-04');
  expect(page.status).toBe(200);
  expect(assetIds(page.text)).toEqual(['midnight', 'iso', 'morning', 'late']);
  expect(page.text).not.toContain('other-midnight');
  const listed = await intake('?date=2026-11-04');
  expect(listed.status).toBe(200);
  expect(listed.body.photos?.map(photo => photo.id)).toEqual(['late', 'morning', 'iso', 'midnight']);
  expect(listed.body.filter).toEqual({ date: '2026-11-04', from: null, to: null });
  expect(listed.body.total).toBe(4);
  expect(listed.body.hasMore).toBe(false);
  expect(listed.body.photos?.map(photo => photo.number)).toEqual([4, 3, 2, 1]);
});

it('这一天没有材料时是空列表，不是错误', async () => {
  const page = await html('/materials?date=2020-01-01');
  expect(page.status).toBe(200);
  expect(assetIds(page.text)).toEqual([]);
  expect(page.text).not.toContain('出了点问题');
  const listed = await intake('?date=2020-01-01&page=1');
  expect(listed.status).toBe(200);
  expect(listed.body.photos).toEqual([]);
  expect(listed.body.total).toBe(0);
  expect(listed.body.hasMore).toBe(false);
  expect(listed.body.error).toBeUndefined();
});

it('筛选后的分页按同一天计算，翻页链接留着日期，换一天不会带上另一天的页', async () => {
  const first = await html('/materials?date=2026-11-06');
  expect(assetIds(first.text)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
  expect(first.text).toMatch(/href="\/s\/materials\?page=1(?:&|&amp;)date=2026-11-06"/);
  const second = await html('/materials?date=2026-11-06&page=1');
  expect(assetIds(second.text)).toEqual(['p8']);
  expect(second.text).toMatch(/href="\/s\/materials\?page=0(?:&|&amp;)date=2026-11-06"/);
  const intakeFirst = await intake('?date=2026-11-06&page=0');
  expect(intakeFirst.body.photos?.map(photo => photo.id)).toEqual(['p8', 'p7', 'p6', 'p5', 'p4', 'p3', 'p2', 'p1']);
  expect(intakeFirst.body.total).toBe(9);
  expect(intakeFirst.body.hasMore).toBe(true);
  const intakeSecond = await intake('?date=2026-11-06&page=1');
  expect(intakeSecond.body.photos?.map(photo => photo.id)).toEqual(['p0']);
  expect(intakeSecond.body.hasMore).toBe(false);
  const otherDay = await intake('?date=2020-01-01&page=1');
  expect(otherDay.body.photos).toEqual([]);
});

it('起止日含两端的新加坡自然日；写错的日期是 400，不把列表倒空成 500', async () => {
  const span = await html('/materials?from=2026-11-03&to=2026-11-04');
  expect(assetIds(span.text)).toEqual(['eve', 'midnight', 'iso', 'morning', 'late']);
  const onlyNext = await intake('?date=2026-11-05&from=2026-01-01&to=2026-12-31');
  expect(onlyNext.body.photos?.map(photo => photo.id)).toEqual(['next']);
  for (const path of ['/materials?date=2026-02-31', '/materials?date=昨天', '/materials?from=2026-11-06&to=2026-11-05']) {
    const response = await html(path);
    expect(response.status, path).toBe(400);
    expect(response.text).toContain('日期要写成 2026-11-04 这样。');
  }
  for (const path of ['?date=2026-02-31', '?from=2026-11-06&to=2026-11-05']) {
    const response = await intake(path);
    expect(response.status, path).toBe(400);
    expect(response.body.error?.message).toContain('日期要写成');
  }
});
