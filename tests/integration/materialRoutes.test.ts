import { afterEach, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import sharp from 'sharp';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { migrateMaterials } from '../../src/materials/schema.js';
import { MaterialStore } from '../../src/materials/store.js';
import { MaterialJobs } from '../../src/materials/jobs.js';
import { MaterialUploads } from '../../src/materials/uploads.js';
import { MobileRecognitionService } from '../../src/mobile/service.js';
import { MobileRecognitionStore } from '../../src/mobile/store.js';
import { AdmissionController } from '../../src/mobile/admission.js';
import { createMaterialsRouter } from '../../src/web/materialsRouter.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const c of cleanups.splice(0).reverse())
        await c();
});
async function fixture() {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'material-routes-'));
    const db = new DatabaseSync(path.join(dir, 'app.db'));
    db.exec('PRAGMA foreign_keys=ON');
    db.exec(SCHEMA_SQL);
    migrateMaterials(db);
    db.exec("INSERT INTO student_profile(id,nickname,created_at) VALUES ('a','Synthetic A','2026-10-20'),('b','Synthetic B','2026-10-20')");
    const store = new MaterialStore(db, 'a');
    const other = new MaterialStore(db, 'b');
    const admission = new AdmissionController({ jobCapacity: 1, diskProbe: async () => 10n ** 12n });
    const scheduler = new MobileRecognitionService(await MobileRecognitionStore.open(dir), { inventory: async () => ({ candidates: [], warnings: [], capacityReached: false }), recognizeQuestion: async () => { throw Error('unused'); } });
    scheduler.useAdmission(admission);
    const jobs = new MaterialJobs(store, scheduler, admission);
    const uploads = new MaterialUploads(store, jobs, admission);
    await uploads.initialize();
    const namespace = store.getWorkspace().draftNamespace;
    const app = express();
    app.use('/s', createMaterialsRouter({ store, jobs, uploads, admission, draftNamespace: namespace }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(r => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as {
        port: number;
    }).port}/s`;
    cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await scheduler.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); });
    const headers = { 'content-type': 'application/json', accept: 'application/json', 'x-draft-namespace': namespace };
    const post = (url: string, body: unknown, ns = namespace) => fetch(base + url, { method: 'POST', headers: { ...headers, 'x-draft-namespace': ns }, body: JSON.stringify(body), redirect: 'manual' });
    const photo = await sharp({ create: { width: 24, height: 16, channels: 3, background: '#fff' } }).jpeg().toBuffer();
    const upload = (captureId: string, uploadId = randomUUID(), ns = namespace) => { const form = new FormData(); form.append('captureId', captureId); form.append('hints', '{}'); form.append('photo', new Blob([new Uint8Array(photo)]), 'synthetic.jpg'); return fetch(base + '/materials/uploads', { method: 'POST', headers: { accept: 'application/json', 'x-draft-namespace': ns, 'x-upload-id': uploadId }, body: form, redirect: 'manual' }); };
    return { db, store, other, namespace, base, post, upload, photo, headers, admission };
}
it('GET capture, grouped results and namespace are read-only', async () => {
    const f = await fixture();
    const before = f.db.prepare('SELECT total_changes() n').get();
    for (const p of ['/capture', '/materials', '/materials/session'])
        expect((await fetch(f.base + p)).status).toBe(200);
    expect(f.db.prepare('SELECT total_changes() n').get()).toEqual(before);
});
it('rejects stale identity before any capture or multipart write', async () => { const f = await fixture(); expect((await f.post('/materials/captures', { requestId: randomUUID() }, f.other.getWorkspace().draftNamespace)).status).toBe(409); expect((await f.upload('bad', randomUUID(), f.other.getWorkspace().draftNamespace)).status).toBe(409); expect(f.db.prepare('SELECT count(*) n FROM material_capture').get()).toEqual({ n: 0 }); expect(f.db.prepare('SELECT count(*) n FROM material_asset').get()).toEqual({ n: 0 }); });
it('acknowledges durable upload and replays the same request even at full capacity', async () => { const f = await fixture(); const capture = await (await f.post('/materials/captures', { requestId: randomUUID() })).json(); const id = randomUUID(); const first = await f.upload(capture.id, id); expect(first.status).toBe(200); const saved = await first.json(); expect(saved).toMatchObject({ ok: true, assetId: expect.any(String), job: { kind: 'extract' } }); expect((await f.upload(capture.id, id)).status).toBe(200); expect((await f.upload(capture.id)).status).toBe(429); expect(f.db.prepare('SELECT count(*) n FROM material_asset').get()).toEqual({ n: 1 }); expect((await fetch(f.base + `/materials/assets/${saved.assetId}/image`)).status).toBe(200); });
it('validates hints, owners and cross-site posts, and a stale consent cookie does not block capture', async () => { const f = await fixture(); expect((await f.post('/materials/captures', { requestId: 'bad' })).status).toBe(400); expect((await fetch(f.base + '/materials/captures', { method: 'POST', headers: { ...f.headers, origin: 'https://evil.example' }, body: JSON.stringify({ requestId: randomUUID() }) })).status).toBe(403); expect((await fetch(f.base + '/materials/captures', { method: 'POST', headers: { ...f.headers, cookie: 'sel_consent=v1' }, body: JSON.stringify({ requestId: randomUUID() }) })).status).toBe(200); const page = await (await fetch(f.base + '/capture', { headers: { cookie: 'sel_consent=v2' } })).text(); expect(page).toContain('data-testid="capture-examples"'); expect(page).toContain('平放、拍全、光线均匀'); expect(page).not.toContain('阿里云'); expect(page).not.toContain('上传前看一下'); expect(page).not.toContain('整页拍全，别裁边'); expect((await f.post('/materials/assets/missing/hints', { roles: ['made_up'] })).status).toBe(400); const q = f.other.createQuestion(); expect((await fetch(f.base + '/materials/questions/' + q.id)).status).toBe(404); });
it('no-JS single-photo POST creates a real capture and material without a legacy job', async () => { const f = await fixture(); const body = new FormData(); body.append('photo', new Blob([new Uint8Array(f.photo)]), 'page.jpg'); const response = await fetch(f.base + `/materials/uploads?namespace=${f.namespace}&uploadId=${randomUUID()}`, { method: 'POST', body, redirect: 'manual' }); expect(response.status).toBe(303); expect(f.db.prepare('SELECT count(*) n FROM material_asset').get()).toEqual({ n: 1 }); expect(f.db.prepare('SELECT kind FROM material_job').get()).toEqual({ kind: 'extract' }); });
it('voluntary unnamed paper bootstrap is atomic and uses asset link CAS', async () => { const f = await fixture(); const c = await (await f.post('/materials/captures', { requestId: randomUUID() })).json(); const a = await (await f.upload(c.id)).json(); expect((await f.post(`/materials/assets/${a.assetId}/document`, { newDocument: true, expectedRevision: 1 })).status).toBe(200); expect((await f.post(`/materials/assets/${a.assetId}/document`, { newDocument: true, expectedRevision: 1 })).status).toBe(409); expect(f.db.prepare('SELECT count(*) n FROM material_document').get()).toEqual({ n: 1 }); expect(f.db.prepare('SELECT revision,link_revision FROM material_asset').get()).toEqual({ revision: 1, link_revision: 2 }); });
it('batch hints can be cleared without changing extraction revisions or starting answer/grade jobs', async () => {
    const f = await fixture();
    const c = await (await f.post('/materials/captures', { requestId: randomUUID() })).json();
    const a = await (await f.upload(c.id)).json();
    expect((await f.post(`/materials/assets/${a.assetId}/hints`, { roles: ['question', 'reference_answer'], marking: 'unmarked', label: 'optional' })).status).toBe(200);
    expect(JSON.parse((f.db.prepare('SELECT hints_json FROM material_asset').get() as {
        hints_json: string;
    }).hints_json)).toEqual({ roles: ['question', 'reference_answer'], marking: 'unmarked', label: 'optional' });
    expect((await f.post(`/materials/assets/${a.assetId}/hints`, {})).status).toBe(200);
    expect(f.db.prepare('SELECT hints_json,revision FROM material_asset').get()).toEqual({ hints_json: '{}', revision: 1 });
    expect(f.db.prepare("SELECT count(*) n FROM material_job WHERE kind!='extract'").get()).toEqual({ n: 0 });
});
it('manual new-attempt and undo use workspace link CAS and keep original work', async () => {
    const f = await fixture();
    const c = await (await f.post('/materials/captures', { requestId: randomUUID() })).json();
    const a = await (await f.upload(c.id)).json();
    const q = f.store.createQuestion();
    const attempt = f.store.createAttempt(q.id);
    const source = f.db.prepare('SELECT s.content_hash FROM source_asset s JOIN material_asset a ON a.source_asset_id=s.id WHERE a.id=?').get(a.assetId) as {
        content_hash: string;
    };
    const fragment = { assetId: a.assetId, fragmentId: 'mfr_synthetic', revision: 1, sourceHash: source.content_hash, box: { x: 0, y: 0, width: 1, height: 1 }, role: 'student_work' as const, text: 'x=1', number: '1', subpart: null, page: 1, order: 0, requiresDiagram: false, check: 'passed' as const, uncertainties: [] };
    f.store.putFragment(fragment);
    f.store.linkFragment(fragment.fragmentId, 1, { questionId: q.id, attemptId: attempt.id });
    const before = f.store.getQuestion(q.id)!;
    expect(before.revision).not.toBe(1);
    expect((await f.post('/materials/links', { fragmentIds: [fragment.fragmentId], questionId: q.id, newAttempt: true, expectedRevision: before.revision })).status).toBe(409);
    const moved = await f.post('/materials/links', { fragmentIds: [fragment.fragmentId], questionId: q.id, newAttempt: true, expectedRevision: 1 });
    expect(moved.status).toBe(200);
    const body = await moved.json();
    expect(f.store.getQuestion(q.id)!.attempts).toHaveLength(2);
    expect((await f.post(`/materials/links/${body.change.id}/undo`, { expectedRevision: body.change.revision })).status).toBe(200);
    expect(f.store.getQuestion(q.id)!.attempts.find(x => x.id === attempt.id)!.fragments).toHaveLength(1);
    expect(f.db.prepare('SELECT count(*) n FROM material_fragment').get()).toEqual({ n: 1 });
});
it('whole-page candidate bootstraps a shared document and rejects other owners atomically', async () => { const f = await fixture(); const c = await (await f.post('/materials/captures', { requestId: randomUUID() })).json(); const a = await (await f.upload(c.id)).json(); const foreign = f.other.createQuestion(); expect((await f.post(`/materials/assets/${a.assetId}/document`, { candidateAssetId: foreign.id, expectedRevision: 1, candidateRevision: 1 })).status).toBe(404); expect(f.db.prepare('SELECT count(*) n FROM material_document').get()).toEqual({ n: 0 }); });
it('no-JS upload retains optional hints and serves the original validated image bytes', async () => {
    const f = await fixture();
    const png = await sharp({ create: { width: 24, height: 16, channels: 3, background: '#ccf' } }).png().toBuffer();
    const body = new FormData();
    body.append('photo', new Blob([new Uint8Array(png)]), 'page.png');
    body.append('roles', 'student_work');
    body.append('marking', 'unmarked');
    const response = await fetch(f.base + `/materials/uploads?namespace=${f.namespace}&uploadId=${randomUUID()}`, { method: 'POST', body, redirect: 'manual' });
    expect(response.status).toBe(303);
    const row = f.db.prepare('SELECT id,hints_json FROM material_asset').get() as {
        id: string;
        hints_json: string;
    };
    expect(JSON.parse(row.hints_json)).toEqual({ roles: ['student_work'], marking: 'unmarked' });
    const image = await fetch(f.base + `/materials/assets/${row.id}/image`);
    expect(image.headers.get('content-type')).toContain('image/png');
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
});
it('new-paper button creates a new document even when an old choice is selected', async () => {
    const f = await fixture();
    const c = await (await f.post('/materials/captures', { requestId: randomUUID() })).json();
    const a = await (await f.upload(c.id)).json();
    await f.post(`/materials/assets/${a.assetId}/document`, { newDocument: true, expectedRevision: 1 });
    const old = f.db.prepare('SELECT document_id FROM material_asset').get() as {
        document_id: string;
    };
    expect((await f.post(`/materials/assets/${a.assetId}/document`, { newDocument: true, documentId: old.document_id, expectedRevision: 2 })).status).toBe(200);
    expect(f.db.prepare('SELECT count(*) n FROM material_document').get()).toEqual({ n: 2 });
});
it('capture supplementation validates question/attempt ownership and preserves context in no-JS uploads', async () => {
    const f = await fixture();
    const q = f.store.createQuestion();
    const a = f.store.createAttempt(q.id);
    const other = f.other.createQuestion();
    expect((await fetch(f.base + `/capture?questionId=${other.id}`)).status).toBe(404);
    const page = await fetch(f.base + `/capture?questionId=${q.id}&attemptId=${a.id}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(`name="questionId" value="${q.id}"`);
    expect(html).toContain(`name="attemptId" value="${a.id}"`);
    const wrong = f.store.createAttempt(f.store.createQuestion().id);
    expect((await fetch(f.base + `/capture?questionId=${q.id}&attemptId=${wrong.id}`)).status).toBe(404);
    const body = new FormData();
    body.append('photo', new Blob([new Uint8Array(f.photo)]), 'page.jpg');
    body.append('questionId', q.id);
    body.append('attemptId', a.id);
    expect((await fetch(f.base + `/materials/uploads?namespace=${f.namespace}&uploadId=${randomUUID()}`, { method: 'POST', body, redirect: 'manual' })).status).toBe(303);
    expect(JSON.parse((f.db.prepare('SELECT hints_json FROM material_asset').get() as {
        hints_json: string;
    }).hints_json)).toEqual({ questionId: q.id, attemptId: a.id });
});
it('many-asset results and focused comparisons render bounded lazy original images', async () => {
    const f = await fixture();
    const c = await (await f.post('/materials/captures', { requestId: randomUUID() })).json();
    const first = await (await f.upload(c.id)).json();
    for (let i = 0; i < 30; i++) {
        const source = 'ast_synthetic_' + i;
        f.db.prepare('INSERT INTO source_asset(id,batch_id,filename,mime,size,content_hash,status,storage_path,created_at) SELECT ?,batch_id,filename,mime,size,content_hash,status,storage_path,created_at FROM source_asset LIMIT 1').run(source);
        f.db.prepare('INSERT INTO material_asset(id,owner_id,capture_id,source_asset_id) VALUES (?,?,?,?)').run('mas_synthetic_' + i, f.store.studentId, c.id, source);
    }
    const html = await (await fetch(f.base + '/materials')).text();
    expect((html.match(/<img /g) || []).length).toBeLessThanOrEqual(8);
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('下一页原图');
    const compare = await fetch(f.base + `/materials/assets/${first.assetId}/match`);
    expect(compare.status).toBe(200);
    const comparison = await compare.text();
    expect((comparison.match(/<img /g) || []).length).toBeLessThanOrEqual(9);
    expect(comparison).toContain('下一页候选');
});
it('question details retain raw reference-answer evidence without presenting a verified answer', async () => {
    const f = await fixture();
    const c = await (await f.post('/materials/captures', { requestId: randomUUID() })).json();
    const a = await (await f.upload(c.id)).json();
    const q = f.store.createQuestion();
    const source = f.db.prepare('SELECT content_hash FROM source_asset LIMIT 1').get() as {
        content_hash: string;
    };
    f.store.putFragment({ assetId: a.assetId, fragmentId: 'mfr_reference', revision: 1, sourceHash: source.content_hash, box: { x: 0, y: 0, width: 1, height: 1 }, role: 'reference_answer', text: 'Synthetic reference evidence', number: '1', subpart: null, page: 1, order: 0, requiresDiagram: false, check: 'passed', uncertainties: [] });
    f.store.linkFragment('mfr_reference', 1, { questionId: q.id, attemptId: null });
    const html = await (await fetch(f.base + '/materials/questions/' + q.id)).text();
    expect(html).toContain('Synthetic reference evidence');
    expect(html).toContain('待核验');
    expect(f.db.prepare('SELECT source FROM material_answer').get()).toEqual({ source: 'imported' });
});

it('known-upload replay still reserves a multipart parsing slot before reading the body',async()=>{const f=await fixture();const c=await(await f.post('/materials/captures',{requestId:randomUUID()})).json();const uploadId=randomUUID();expect((await f.upload(c.id,uploadId)).status).toBe(200);expect(f.admission.tryAcquireUploadSlot('upload').accepted).toBe(true);try{expect((await f.upload(c.id,uploadId)).status).toBe(429)}finally{f.admission.releaseUploadSlot('upload')}expect((await f.upload(c.id,uploadId)).status).toBe(200);});

it('keeps original replay identity through hint edits, clearing and whole-page document assignment', async () => {
    const f = await fixture();
    const capture = await (await f.post('/materials/captures', { requestId: randomUUID() })).json();
    const uploadId = randomUUID();
    const saved = await (await f.upload(capture.id, uploadId)).json();
    for (const hints of [{ label: 'later label', roles: ['reference_answer'], marking: 'unmarked' }, {}]) {
        expect((await f.post(`/materials/assets/${saved.assetId}/hints`, hints)).status).toBe(200);
        const replay = await f.upload(capture.id, uploadId);
        expect(replay.status).toBe(200);
        expect(await replay.json()).toMatchObject({ assetId: saved.assetId, job: { id: saved.job.id }, created: false });
        expect(JSON.parse((f.db.prepare('SELECT hints_json FROM material_asset').get() as { hints_json: string }).hints_json)).toEqual(hints);
    }
    expect((await f.post(`/materials/assets/${saved.assetId}/document`, { newDocument: true, expectedRevision: 1 })).status).toBe(200);
    const before = f.db.prepare('SELECT document_id,hints_json,upload_request_fingerprint FROM material_asset').get();
    expect((await f.upload(capture.id, uploadId)).status).toBe(200);
    expect(f.db.prepare('SELECT document_id,hints_json,upload_request_fingerprint FROM material_asset').get()).toEqual(before);
    expect(f.db.prepare('SELECT count(*) n FROM material_asset').get()).toEqual({ n: 1 });
    expect(f.db.prepare('SELECT count(*) n FROM material_job').get()).toEqual({ n: 1 });
});

it('returns an actionable 409 for pre-fingerprint saved uploads without guessing or duplicating', async () => {
    const f = await fixture();
    const capture = await (await f.post('/materials/captures', { requestId: randomUUID() })).json();
    const uploadId = randomUUID();
    const saved = await (await f.upload(capture.id, uploadId)).json();
    f.db.exec('DROP TRIGGER material_upload_fingerprint_immutable; ALTER TABLE material_asset DROP COLUMN upload_request_fingerprint');
    expect((await f.post(`/materials/assets/${saved.assetId}/hints`, { label: 'edited before migration' })).status).toBe(200);
    migrateMaterials(f.db);
    const replay = await f.upload(capture.id, uploadId);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ error: { code: 'upload_identity_unavailable', message: expect.stringMatching(/已保留在服务器.*查看已经保存的材料.*删除这条待传记录/) } });
    expect(f.db.prepare('SELECT count(*) n FROM material_asset').get()).toEqual({ n: 1 });
    expect(f.db.prepare('SELECT count(*) n FROM material_job').get()).toEqual({ n: 1 });
    expect((await fetch(f.base + `/materials/assets/${saved.assetId}/image`)).status).toBe(200);
});
it('saves inclusion intent with owner/namespace/CAS boundaries and read-only material pages',async()=>{
 const f=await fixture();const q=f.store.createQuestion({subject:'数学'}).id;const foreign=f.other.createQuestion({subject:'数学'}).id;
 expect((await f.post(`/materials/questions/${foreign}/inclusion`,{included:true,expectedRevision:1})).status).toBe(404);
 expect((await f.post(`/materials/questions/${q}/inclusion`,{included:true,expectedRevision:1},f.other.getWorkspace().draftNamespace)).status).toBe(409);
 expect((await fetch(f.base+`/materials/questions/${q}/inclusion`,{method:'POST',headers:{...f.headers,origin:'https://foreign.example'},body:JSON.stringify({included:true,expectedRevision:1})})).status).toBe(403);
 const saved=await f.post(`/materials/questions/${q}/inclusion`,{included:true,expectedRevision:1});expect(saved.status).toBe(200);expect(await saved.json()).toEqual({itemId:null,revision:2});
 expect((await f.post(`/materials/questions/${q}/inclusion`,{included:false,expectedRevision:1})).status).toBe(409);
 const before=f.db.prepare('SELECT total_changes() n').get();const html=await (await fetch(f.base+`/materials/questions/${q}`)).text();expect(html).toContain('收录意愿已保存');expect(html).toContain('今天先到这里');expect(html).toContain('安排本周练习');
 expect(f.db.prepare('SELECT total_changes() n').get()).toEqual(before);expect(f.db.prepare('SELECT * FROM error_item').all()).toHaveLength(0);
});

// P0-4 / P1-2: batch inclusion, inclusion markers, polling while photos are processed, one-tap re-extraction, other subjects.
async function intakeFixture() {
 const f=await fixture();const c=await(await f.post('/materials/captures',{requestId:randomUUID()})).json();
 const saved=await(await f.upload(c.id)).json() as {assetId:string};const assetId=saved.assetId;
 const hash=(f.db.prepare('SELECT s.content_hash h FROM material_asset a JOIN source_asset s ON s.id=a.source_asset_id WHERE a.id=?').get(assetId) as {h:string}).h;
 const question=(number:string,text:string,mark?:string)=>{const id=f.store.createQuestion({number,subject:'数学'}).id;
  for(const [role,body] of [['question',text],...(mark?[['teacher_mark',mark]]:[])] as const){const fragmentId=`mfr_${randomUUID().slice(0,8)}`;
   f.store.putFragment({assetId,fragmentId,revision:1,box:{x:0,y:0,width:1,height:1},sourceHash:hash,role:role as 'question'|'teacher_mark',text:body,number,subpart:null,page:1,order:0,requiresDiagram:false,check:'passed',uncertainties:[]});
   f.store.linkFragment(fragmentId,1,{questionId:id,attemptId:null});}
  return id;};
 const form=(url:string,fields:[string,string][])=>fetch(f.base+url,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','x-draft-namespace':f.namespace},body:new URLSearchParams(fields),redirect:'manual'});
 return {...f,assetId,question,form};
}
it('lists subject, first stem sentence and inclusion marks, and includes a whole page or ticked questions in one step',async()=>{
 const f=await intakeFixture();
 const a=f.question('1','1. 计算 1+1（6分）。写出过程。'),b=f.question('2','2. 解方程 x+2=5。'),c=f.question('3','3. 求 2+2。');const marked=f.question('4','4. 求 3+3（4分）','-2');
 expect(f.store.getQuestion(marked)!.itemId).toBeTruthy();
 const html=await(await fetch(f.base+'/materials')).text();
 expect(html).toContain('照片 1：本页还有 3 道没收录');expect(html).toContain('数学 · 计算 1+1（6分）。');expect(html).toContain('>已收录<');expect(html).toContain('>未收录<');
 expect(html).toContain('data-poll="4"');expect(html).toContain('正在整理 1 张照片');
 const rev=(id:string)=>`${id}:${f.store.getQuestion(id)!.revision}`;
 // A stale pick (revision changed after the page was rendered) is skipped rather than guessed.
 const stale=`${c}:${f.store.getQuestion(c)!.revision-1}`;
 const ticked=await f.form('/materials/inclusions',[['namespace',f.namespace],['pick',rev(b)],['pick',stale]]);
 expect(ticked.status).toBe(303);expect(ticked.headers.get('location')).toBe('/s/materials?included=1&skipped=1');
 expect(f.store.getQuestion(b)!.itemId).toBeTruthy();expect(f.store.getQuestion(c)!.itemId).toBeNull();
 const done=await(await fetch(f.base+'/materials?included=1&skipped=1')).text();expect(done).toContain('已收进错题本 1 道。');expect(done).toContain('去错题本看看');expect(done).toContain('有 1 道刚刚有变化');
 const page=await f.form('/materials/inclusions',[['allOf',f.assetId],[`page_${f.assetId}`,rev(a)],[`page_${f.assetId}`,rev(c)]]);
 expect(page.headers.get('location')).toBe('/s/materials?included=2&skipped=0');
 expect(f.db.prepare('SELECT count(*) n FROM error_item').get()).toEqual({n:4});
 expect(await(await fetch(f.base+'/materials')).text()).not.toContain('没收录');
 expect((await f.form('/materials/inclusions',[['pick','not a pick']])).status).toBe(400);
 // The single-question button stays on the question and confirms.
 const one=f.question('5','5. 求 5+5。');const single=await f.form(`/materials/questions/${one}/inclusion`,[['namespace',f.namespace],['included','true'],['expectedRevision',String(f.store.getQuestion(one)!.revision)]]);
 expect(single.headers.get('location')).toBe(`/s/materials/questions/${one}?included=1`);
 expect(await(await fetch(f.base+single.headers.get('location')!.slice(2))).text()).toContain('已收进错题本。');
});
it('summarizes failed photos at the top, retries all retryable ones in one tap, and explains other subjects',async()=>{
 const f=await intakeFixture();
 const job=(f.db.prepare("SELECT id FROM material_job WHERE kind='extract'").get() as {id:string}).id;
 f.db.prepare("UPDATE material_job SET state='failed',error=? WHERE id=?").run(JSON.stringify({code:'provider_unavailable',message:'合成失败',retryable:true}),job);
 let html=await(await fetch(f.base+'/materials')).text();
 expect(html).toContain('1 张照片没整理成功，原图已保留。');expect(html).toContain('一键重新整理');expect(html).not.toContain('data-poll');expect(html).not.toContain('正在整理 1 张');
 const requestId=randomUUID();
 const retried=await f.form('/materials/jobs/retry-all',[['namespace',f.namespace],['requestId',requestId]]);
 expect(retried.headers.get('location')).toBe('/s/materials?retried=1');
 expect(f.db.prepare('SELECT state FROM material_job WHERE id=?').get(job)).toEqual({state:'queued'});
 expect(await(await fetch(f.base+'/materials?retried=1')).text()).toContain('已重新开始整理 1 张照片。');
 // A photo that cannot be read is not offered a doomed retry.
 f.db.prepare("UPDATE material_job SET state='failed',error=? WHERE id=?").run(JSON.stringify({code:'invalid_image',message:'坏图',retryable:false}),job);
 html=await(await fetch(f.base+'/materials')).text();expect(html).toContain('其中 1 张看不清或格式不对，请重拍这几张。');expect(html).not.toContain('一键重新整理');
 expect((await f.form('/materials/jobs/retry-all',[['namespace',f.namespace],['requestId',randomUUID()]])).headers.get('location')).toBe('/s/materials?retried=0');
 f.db.prepare("UPDATE material_job SET state='succeeded',error=NULL WHERE id=?").run(job);
 f.db.prepare('UPDATE material_asset SET extraction_json=? WHERE id=?').run(JSON.stringify({assetId:f.assetId,revision:1,document:{title:null,subject:'高三英语',date:null,printedCode:null,page:1},fragments:[],warnings:['unsupported_subject'],runs:[]}),f.assetId);
 html=await(await fetch(f.base+'/materials')).text();expect(html).toContain('目前只支持数学、物理、化学。');expect(html).toContain('照片 1（英语）不会整理成错题');expect(html).not.toContain('没整理成功');
});
it('keeps every batch form bounded with more than 400 pending questions across photos, and syncs learning once per batch',async()=>{
 const f=await intakeFixture();const assets=[f.assetId];
 // Two more synthetic photos cloned from the first saved one (job capacity in this fixture is 1).
 for(let i=0;i<2;i++){const src=`src_${randomUUID().slice(0,8)}`,id=`mas_${randomUUID().slice(0,8)}`,cap=f.store.createCapture(randomUUID()).id;
  f.db.prepare('INSERT INTO source_asset(id,batch_id,filename,mime,size,content_hash,storage_path,created_at) SELECT ?,batch_id,filename,mime,size,content_hash,storage_path,created_at FROM source_asset WHERE id=(SELECT source_asset_id FROM material_asset WHERE id=?)').run(src,f.assetId);
  f.db.prepare('INSERT INTO material_asset(id,owner_id,capture_id,source_asset_id) VALUES (?,?,?,?)').run(id,f.store.studentId,cap,src);assets.push(id);}
 // Seed 3×150 plain questions directly (bulk synthetic rows); no learning projection runs here.
 const hashOf=(a:string)=>(f.db.prepare('SELECT s.content_hash h FROM material_asset a JOIN source_asset s ON s.id=a.source_asset_id WHERE a.id=?').get(a) as {h:string}).h;
 f.db.exec('BEGIN');
 for(const a of assets){const h=hashOf(a);for(let n=1;n<=150;n++){const q=f.store.createQuestion({number:String(n),subject:'数学'}).id;const fr=`mfr_${randomUUID().slice(0,12)}`;
  f.db.prepare('INSERT INTO material_fragment(id,revision,owner_id,asset_id,content_json) VALUES (?,?,?,?,?)').run(fr,1,f.store.studentId,a,JSON.stringify({assetId:a,fragmentId:fr,revision:1,box:{x:0,y:0,width:1,height:1},sourceHash:h,role:'question',text:`${n}. 求 ${n}+1。`,number:String(n),subpart:null,page:1,order:n,requiresDiagram:false,check:'passed',uncertainties:[]}));
  f.db.prepare('INSERT INTO material_link_event(id,owner_id,fragment_id,fragment_revision,revision,question_id) VALUES (?,?,?,?,?,?)').run(`mlk_${randomUUID().slice(0,12)}`,f.store.studentId,fr,1,1,q);}}
 f.db.exec('COMMIT');
 const html=await(await fetch(f.base+'/materials')).text();
 const forms=[...html.matchAll(/<form[^>]*action="\/s\/materials\/inclusions"[^>]*>([\s\S]*?)<\/form>/g)].map(m=>m[1]!);
 expect(forms).toHaveLength(6); // 150 per photo → two bounded parts each
 const fieldsOf=(body:string)=>[...body.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)].map(m=>[m[1]!,m[2]!] as [string,string]);
 for(const body of forms)expect(fieldsOf(body).length+2).toBeLessThan(200);
 // "本页全部收录" on one part submits only that part's revisions.
 const first=fieldsOf(forms[0]!).filter(([n])=>n!=='pick');const page=/<button[^>]*value="([^"]+)"[^>]*name="allOf"|<button[^>]*name="allOf"[^>]*value="([^"]+)"/.exec(forms[0]!)!.slice(1).find(Boolean)!;
 const all=await f.form('/materials/inclusions',[...first,['allOf',page]]);
 expect(all.status).toBe(303);expect(all.headers.get('location')).toBe('/s/materials?included=120&skipped=0');
 const picks=fieldsOf(forms[5]!).filter(([n])=>n==='pick').slice(0,30);
 const ticked=await f.form('/materials/inclusions',[['namespace',f.namespace],...picks]);
 expect(ticked.headers.get('location')).toBe('/s/materials?included=30&skipped=0');
 expect(f.db.prepare('SELECT count(*) n FROM material_item_link').get()).toEqual({n:150});
},60_000);
