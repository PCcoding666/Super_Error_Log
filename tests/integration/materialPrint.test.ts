import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { getDb, newId, now } from '../../src/db/connection.js';
import { localDayText } from '../../src/domain/calendarDay.js';
import { ensureStudentProfile } from '../../src/services/studentService.js';
import { backfillLegacyMaterials } from '../../src/materials/legacy.js';
import { MaterialStore } from '../../src/materials/store.js';
import { setQuestionIncluded } from '../../src/materials/learning.js';
import { saveManualAnswer, selectAnswerBasis, selectedAnswerIds } from '../../src/materials/answers.js';
import { getLearningPrintInput, learningPrintAnswerBlocked } from '../../src/learning/sources.js';
import { readFragmentImage } from '../../src/materials/media.js';
import { submitLearningReturns } from '../../src/v2/returnService.js';
import { createLearningPractice } from '../../src/learning/queries.js';
import { requestPrint, getPrintStatus, readPrintMedia, resumePendingSnapshots, type PrintSnapshot } from '../../src/v2/printService.js';
import type { Fragment } from '../../src/materials/contracts.js';
import type { CoachProvider } from '../../src/ai/provider.js';
const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs.splice(0))
        fs.rmSync(d, { recursive: true, force: true });
});
const coach: CoachProvider = { coachForPrint: async () => ({ hints: ['h1', 'h2'], solution: 'solution', answer: 'AI answer', source: 'ai_generated' }) };
async function fixture() {
    const db = getDb(), owner = ensureStudentProfile().id, store = new MaterialStore(db, owner), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'material-print-'));
    dirs.push(dir);
    const q = store.createQuestion({ number: '1', subject: '数学' }).id;
    async function asset(color: string, upload = false, orientation?: number) {
        const id = newId('mas'), sourceId = newId('ast'), batch = newId('bat');
        const bytes = await sharp({ create: { width: 200, height: 100, channels: 3, background: color } }).jpeg().withMetadata(orientation ? { orientation } : {}).toBuffer();
        const folder = path.join(dir, id);
        fs.mkdirSync(folder);
        const file = path.join(folder, upload ? 'original' : 'legacy-source.jpg');
        fs.writeFileSync(file, bytes);
        if (upload)
            fs.writeFileSync(path.join(folder, 'normalized.jpg'), await sharp(bytes).rotate().jpeg().toBuffer());
        const hash = createHash('sha256').update(bytes).digest('hex');
        db.prepare('INSERT INTO source_batch(id,student_id,created_at) VALUES(?,?,?)').run(batch, owner, now());
        db.prepare('INSERT INTO source_asset(id,batch_id,filename,mime,size,content_hash,storage_path,created_at) VALUES(?,?,?,?,?,?,?,?)').run(sourceId, batch, 'synthetic.jpg', 'image/jpeg', bytes.length, hash, upload ? path.join(folder, 'normalized.jpg') : file, now());
        const capture = store.createCapture(crypto.randomUUID());
        db.prepare('INSERT INTO material_asset(id,owner_id,capture_id,source_asset_id,status,upload_request_id) VALUES(?,?,?,?,?,?)').run(id, owner, capture.id, sourceId, upload ? 'saved' : 'legacy', upload ? crypto.randomUUID() : null);
        return { id, sourceId, hash, file };
    }
    function add(a: {
        id: string;
        hash: string;
    }, role: Fragment['role'], text: string, extra: Partial<Fragment> = {}, question = q) {
        const f: Fragment = { assetId: a.id, fragmentId: newId('mfr'), revision: 1, sourceHash: a.hash, box: { x: .1, y: .1, width: .7, height: .6 }, role, text, number: '1', subpart: null, page: 1, order: 0, requiresDiagram: false, check: 'passed', uncertainties: [], ...extra };
        store.putFragment(f);
        store.linkFragment(f.fragmentId, 1, { questionId: question, attemptId: role === 'student_work' ? store.createAttempt(question).id : null });
        return f;
    }
    const include = () => setQuestionIncluded(store, q, true, store.getQuestion(q)!.revision).itemId!;
    return { db, store, dir, q, asset, add, include };
}
function packet(ids: string[]) {
    for (const id of ids) {
        for (const p of getDb().prepare("SELECT p.id FROM review_packet p JOIN review_packet_item i ON i.packet_id=p.id WHERE i.item_id=? AND p.generated_at IS NOT NULL").all(id) as {
            id: string;
        }[])
            submitLearningReturns(p.id, { results: [{ itemId: id, completion: 'independent', correct: true, performedOn: localDayText(new Date()) }] });
    }
    for (const id of ids)
        getDb().prepare("UPDATE error_item SET status='eligible_for_review' WHERE id=?").run(id);
    const r = createLearningPractice({ itemIds: ids });
    expect(r.ok).toBe(true);
    if (!r.ok)
        throw Error('packet failed');
    return r.detail.id;
}
async function settled(id: string) {
    for (let i = 0; i < 200; i++) {
        const r = getPrintStatus(id, 'all');
        if (r.httpStatus === 200 && r.body.status !== 'preparing')
            return r.body;
        await new Promise(r => setTimeout(r, 5));
    }
    throw Error('print timeout');
}
function snapshot(body: Record<string, unknown>) { expect(body.status, JSON.stringify(body)).toBe('ready'); return body.snapshot as PrintSnapshot; }
function frozen(id: string) {
    return (getDb().prepare('SELECT manifest_json FROM v2_print_basis WHERE packet_id=?').get(id) as {
        manifest_json: string;
    }).manifest_json;
}
async function pixel(image: Buffer, x: number, y: number) { const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true }); return [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)]; }
describe('source-aware immutable print', () => {
    it('renders each crop from its own source without leaking answers', async () => {
        const f = await fixture(), a = await f.asset('#ff0000'), b = await f.asset('#0000ff', true);
        f.add(a, 'question', 'page-1-stem', { check: 'low' });
        f.add(b, 'question', 'page-2-stem', { page: 2, check: 'low' });
        // Same coordinates on B must not mask A. A neighboring question's answer on A must be masked.
        f.add(b, 'student_work', 'synthetic-answer-marker', { box: { x: .15, y: .2, width: .1, height: .1 } });
        const neighbor = f.store.createQuestion({ number: '2', subject: '数学' }).id;
        f.add(a, 'reference_answer', 'adjacent-answer-marker', { box: { x: .7, y: .1, width: .2, height: .6 } }, neighbor);
        const item = f.include(), input = getLearningPrintInput(item)!;
        expect(input.questionRegions.map(r => r.assetId)).toEqual([a.id, b.id]);
        const id = packet([item]);
        expect(requestPrint(id, coach, 'all').httpStatus).toBe(202);
        const s = snapshot(await settled(id));
        expect(Object.keys(s).sort()).toEqual(['answerSheet', 'cover', 'items', 'packetId', 'preparedAt', 'week']);
        expect(s.items[0]!.stemText!.split('\n\n')).toEqual(['page-1-stem', 'page-2-stem']);
        const img = readPrintMedia(id, s.items[0]!.cropMedia!, 'all')!;
        expect(img).toBeTruthy();
        expect((await pixel(img, 20, 20))[0]).toBeGreaterThan(200);
        expect((await pixel(img, 20, 20))[2]).toBeLessThan(30);
        const meta = await sharp(img).metadata();
        expect((await pixel(img, 130, 20)).every(v => v > 235)).toBe(true);
        expect((await pixel(img, 20, meta.height! - 20))[2]).toBeGreaterThan(200);
        expect(JSON.stringify(s.items)).not.toContain('answer-marker');
        expect(readPrintMedia(id, s.items[0]!.cropMedia!)).toBeNull();
    });
    it('reads exact owned revisions and verifies original bytes before oriented cropping', async () => {
        const f = await fixture(), a = await f.asset('#123456', true, 6), fragment = f.add(a, 'question', 'oriented', { box: { x: 0, y: 0, width: .4, height: .5 } });
        expect((await sharp(await readFragmentImage(f.store, fragment.fragmentId, 1)).metadata()).width).toBe(40);
        await expect(readFragmentImage(f.store, fragment.fragmentId, 2)).rejects.toThrow();
        fs.writeFileSync(a.file, 'changed');
        await expect(readFragmentImage(f.store, fragment.fragmentId, 1)).rejects.toThrow(/hash|原图/);
    });
    it('keeps an existing print immutable when later answers conflict', async () => {
        const f = await fixture(), a = await f.asset('#fff');
        f.add(a, 'question', 'stem');
        const item = f.include();
        const first = saveManualAnswer(f.store, { questionId: f.q, subpart: null, text: 'provided answer', claimedSource: '老师提供', expectedRevision: f.store.getQuestion(f.q)!.revision });
        const id = packet([item]);
        requestPrint(id, coach, 'all');
        const s = snapshot(await settled(id)), before = frozen(id), bytes = JSON.stringify(s);
        f.add(a, 'reference_answer', 'conflicting photographed answer');
        expect(f.store.getQuestion(f.q)!.answerConflict).toBe(true);
        expect(JSON.stringify(snapshot(await settled(id)))).toBe(bytes);
        expect(frozen(id)).toBe(before);
        expect(before).toContain(first.id);
        const next = packet([item]);
        let calls = 0;
        requestPrint(next, { coachForPrint: async (...args) => { calls++; return coach.coachForPrint(...args); } }, 'all');
        const unresolved = snapshot(await settled(next));
        expect(unresolved.answerSheet[0]!.answer.text).toBeNull();
        expect(calls).toBe(0);
        selectAnswerBasis(f.store, f.q, [first.id], f.store.getQuestion(f.q)!.revision);
        const third = packet([item]);
        requestPrint(third, coach, 'all');
        expect(snapshot(await settled(third)).answerSheet[0]!.answer.text).toBe('provided answer');
    });
    it('keeps missing or unchecked necessary diagrams pending', async () => {
        const f = await fixture(), a = await f.asset('#fff');
        f.add(a, 'question', 'needs diagram', { requiresDiagram: true });
        const item = f.include();
        expect(getLearningPrintInput(item)).toBeNull();
        f.add(a, 'diagram', 'unchecked diagram', { check: 'unchecked' });
        expect(getLearningPrintInput(item)).toBeNull();
    });
    it('rejects basis changes to previously completed items during asynchronous preparation', async () => {
        const f = await fixture(), a = await f.asset('#fff');
        f.add(a, 'question', 'first');
        const first = f.include();
        const g = await fixture(), b = await g.asset('#fff');
        g.add(b, 'question', 'second');
        const second = g.include();
        const id = packet([first, second]);
        let calls = 0;
        requestPrint(id, { coachForPrint: async (...args) => {
                calls++;
                if (calls === 2)
                    saveManualAnswer(f.store, { questionId: f.q, subpart: null, text: 'new reference', claimedSource: null, expectedRevision: f.store.getQuestion(f.q)!.revision });
                return coach.coachForPrint(...args);
            } }, 'all');
        expect((await settled(id)).status).toBe('failed');
        requestPrint(id, coach, 'all');
        const s = snapshot(await settled(id));
        expect(s.answerSheet[0]!.answer.text).toBe('new reference');
    });
});
async function legacy(f: Awaited<ReturnType<typeof fixture>>, a: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['asset']>>, stem: string, reference?: string | string[], badge = 'low', verified = 1) {
    const item = newId('itm'), job = crypto.randomUUID(), batch = (f.db.prepare('SELECT batch_id FROM source_asset WHERE id=?').get(a.sourceId) as {
        batch_id: string;
    }).batch_id;
    f.db.prepare('INSERT INTO error_item(id,student_id,batch_id,asset_id,item_index,status,text_excerpt,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(item, f.store.studentId, batch, a.sourceId, 1, 'eligible_for_review', stem, now(), now());
    f.db.prepare('INSERT INTO mobile_item_link(item_id,job_id,question_id,question_revision) VALUES(?,?,?,?)').run(item, job, crypto.randomUUID(), 1);
    const references = typeof reference === 'string' ? [reference] : reference ?? [];
    const regionId = (i: number) => `real-answer-region${i ? `-${i}` : ''}`;
    const evidence = { version: 1, questionNumber: '1', questionText: stem, subject: '数学', chapter: '', knowledgeTags: [], questionType: '', questionRegion: { x: .1, y: .1, width: .7, height: .6 }, requiresDiagram: false,
        regions: references.map((_, i) => ({ id: regionId(i), kind: 'reference_answer', box: { x: .8, y: .8 - i * .2, width: .1, height: .1 }, confidence: 1, cleanForPrint: false })),
        observations: references.map((text, i) => ({ id: `real-answer-observation${i ? `-${i}` : ''}`, kind: 'reference_answer', text, regionId: regionId(i), confidence: 1 })), uncertainties: [] };
    f.db.prepare('INSERT INTO evidence_record(item_id,content_json,verified,confidence_badge,updated_at) VALUES(?,?,?,?,?)').run(item, JSON.stringify(evidence), verified, badge, now());
    backfillLegacyMaterials(f.db);
    return { item, q: (f.db.prepare('SELECT question_id FROM material_item_link WHERE item_id=?').get(item) as {
            question_id: string;
        }).question_id };
}
it('prints authoritative legacy evidence with genuine supplemental legacy pages and selected references', async () => {
    const f = await fixture(), a = await f.asset('#ff0000'), b = await f.asset('#0000ff');
    const old = await legacy(f, a, 'original real evidence'), other = await legacy(f, b, 'real supplemental page');
    const second = f.store.getQuestion(other.q)!.stem[0]!;
    f.store.linkFragment(second.fragmentId, second.revision, { questionId: old.q, attemptId: null });
    // A material-region answer on the same physical source uses a distinct material_asset ID.
    f.add(a, 'reference_answer', 'neighbor marker', { box: { x: .7, y: .1, width: .2, height: .6 } }, f.q);
    const reference = saveManualAnswer(f.store, { questionId: old.q, text: 'selected supplemental reference', subpart: null, claimedSource: null, expectedRevision: f.store.getQuestion(old.q)!.revision });
    const input = getLearningPrintInput(old.item)!;
    expect(input.questionRegions.map(r => r.assetId)).toEqual([a.id, b.id]);
    expect(input.context.questionText).toBe('original real evidence\n\nreal supplemental page');
    expect(input.answers[0]!.id).toBe(reference.id);
    expect(input.redactRegions.some(r => r.assetId === a.id)).toBe(true);
    const id = packet([old.item]);
    requestPrint(id, coach, 'all');
    const s = snapshot(await settled(id));
    expect(s.answerSheet[0]!.answer.text).toBe(reference.text);
    expect((await pixel(readPrintMedia(id, s.items[0]!.cropMedia!, 'all')!, 130, 20)).every(v => v > 235)).toBe(true);
});
it('redacts answers inside separate diagrams even for a text question', async () => {
    const f = await fixture(), a = await f.asset('#ff0000'), b = await f.asset('#0000ff');
    f.add(a, 'question', 'diagram stem', { requiresDiagram: true });
    f.add(b, 'diagram', 'diagram', { page: 2 });
    f.add(b, 'student_work', 'diagram answer', { box: { x: .15, y: .2, width: .1, height: .1 } });
    const id = packet([f.include()]);
    requestPrint(id, coach, 'all');
    const s = snapshot(await settled(id));
    expect(s.items[0]!.mode).toBe('text');
    const img = readPrintMedia(id, s.items[0]!.diagramMedia[0]!, 'all')!;
    expect((await pixel(img, 15, 15)).every(v => v > 235)).toBe(true);
});
it('rejects a newly discovered adjacent answer during preparation and rechecks restart partials', async () => {
    const f = await fixture(), a = await f.asset('#ff0000');
    f.add(a, 'question', 'low stem', { check: 'low' });
    const item = f.include(), id = packet([item]);
    requestPrint(id, { coachForPrint: async (...args) => { f.add(a, 'reference_answer', 'new adjacent answer', { box: { x: .7, y: .1, width: .2, height: .6 } }, f.store.createQuestion({ number: '2', subject: '数学' }).id); return coach.coachForPrint(...args); } }, 'all');
    expect((await settled(id)).status).toBe('failed');
    requestPrint(id, coach, 'all');
    const initial = snapshot(await settled(id));
    const before = frozen(id);
    f.db.prepare("UPDATE v2_print_snapshot SET status='preparing' WHERE packet_id=?").run(id);
    saveManualAnswer(f.store, { questionId: f.q, text: 'later reference', subpart: null, claimedSource: null, expectedRevision: f.store.getQuestion(f.q)!.revision });
    resumePendingSnapshots(coach);
    expect((await settled(id)).status).toBe('failed');
    expect(frozen(id)).toBe(before);
    requestPrint(id, coach, 'all');
    expect(snapshot(await settled(id)).answerSheet[0]!.answer.text).toBe('later reference');
    expect(initial.items[0]!.mode).toBe('crop');
});
it('rejects replacement of a selected photographed answer source and freezes its real regions', async () => {
    const f = await fixture(), a = await f.asset('#fff'), b = await f.asset('#f00', true);
    f.add(a, 'question', 'stem');
    const answer = f.add(b, 'reference_answer', 'photo reference');
    const item = f.include(), id = packet([item]);
    requestPrint(id, { coachForPrint: async (...args) => { fs.writeFileSync(b.file, 'replaced answer photo'); return coach.coachForPrint(...args); } }, 'all');
    expect((await settled(id)).status).toBe('failed');
    expect(frozen(id)).toContain(answer.fragmentId);
    expect(frozen(id)).toContain(b.hash);
});
it('keeps the current real legacy answer authoritative after its original evidence revision changes', async () => {
    const f = await fixture(), a = await f.asset('#fff');
    const old = await legacy(f, a, 'stem', 'old mapped answer', 'ok');
    const record = JSON.parse((f.db.prepare('SELECT content_json FROM evidence_record WHERE item_id=?').get(old.item) as {
        content_json: string;
    }).content_json);
    record.observations = [{ id: 'real-answer-observation', kind: 'reference_answer', text: 'current real answer', regionId: null, confidence: 1 }];
    f.db.prepare('UPDATE evidence_record SET content_json=?,revision=revision+1 WHERE item_id=?').run(JSON.stringify(record), old.item);
    const id = packet([old.item]);
    requestPrint(id, coach, 'all');
    const s = snapshot(await settled(id));
    expect(s.answerSheet[0]!.answer.text).toBe('current real answer');
    expect(frozen(id)).toContain('real-answer-observation');
});
it('rejects excessive images explicitly without silently dropping pages or invoking coach', async () => {
    const f = await fixture(), a = await f.asset('#fff');
    for (let i = 0; i < 33; i++)
        f.add(a, 'question', `part ${i}`, { page: i + 1, check: 'low' });
    const id = packet([f.include()]);
    let calls = 0;
    requestPrint(id, { coachForPrint: async (...args) => { calls++; return coach.coachForPrint(...args); } }, 'all');
    const result = await settled(id);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('图片过多');
    expect(calls).toBe(0);
    expect(result.snapshot).toBeUndefined();
});
it('leaves pre-manifest ready snapshots byte-identical and refuses unverified historical partials', async () => {
    const f = await fixture(), a = await f.asset('#fff'), old = await legacy(f, a, 'historical low stem');
    const id = packet([old.item]);
    requestPrint(id, coach, 'all');
    snapshot(await settled(id));
    const bytes = (f.db.prepare('SELECT snapshot_json FROM v2_print_snapshot WHERE packet_id=?').get(id) as {
        snapshot_json: string;
    }).snapshot_json;
    f.db.prepare('DELETE FROM v2_print_basis WHERE packet_id=?').run(id);
    const original = fs.readFileSync(a.file);
    fs.unlinkSync(a.file);
    expect(requestPrint(id, coach).httpStatus).toBe(200);
    expect(getPrintStatus(id).httpStatus).toBe(200);
    expect((f.db.prepare('SELECT snapshot_json FROM v2_print_snapshot WHERE packet_id=?').get(id) as {
        snapshot_json: string;
    }).snapshot_json).toBe(bytes);
    fs.writeFileSync(a.file, original);
    f.db.prepare("UPDATE v2_print_snapshot SET status='preparing' WHERE packet_id=?").run(id);
    resumePendingSnapshots(coach);
    const result = await settled(id);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('旧准备进度无法核对');
    requestPrint(id, coach, 'all');
    expect((await settled(id)).status).toBe('ready');
});
it('keeps raw image ownership and rejects missing exact fragment versions', async () => {
    const f = await fixture(), a = await f.asset('#fff');
    const fragment = f.add(a, 'question', 'owned');
    const other = newId('stu');
    f.db.prepare('INSERT INTO student_profile(id,nickname,created_at) VALUES(?,?,?)').run(other, 'synthetic foreign', now());
    const foreign = new MaterialStore(f.db, other);
    await expect(readFragmentImage(foreign, fragment.fragmentId, 1)).rejects.toThrow('不存在');
    await expect(readFragmentImage(f.store, fragment.fragmentId, 99)).rejects.toThrow('不存在');
});
import express from 'express';
import { MobileRecognitionStore } from '../../src/mobile/store.js';
import { MobileRecognitionService } from '../../src/mobile/service.js';
import { MaterialJobs } from '../../src/materials/jobs.js';
import { MaterialUploads } from '../../src/materials/uploads.js';
import { PairingManager } from '../../src/mobile/pairing.js';
import { RateLimiter } from '../../src/mobile/rateLimit.js';
import { createWebClientRouter } from '../../src/web/router.js';
import { createV2Router } from '../../src/v2/router.js';
it('serves authenticated web page groups, exact crops, originals and mixed prints while preserving legacy gates', async () => {
    const f = await fixture(), a = await f.asset('#f00'), b = await f.asset('#00f', true);
    const one = f.add(a, 'question', 'web first page', { check: 'low' }), two = f.add(b, 'question', 'web second page', { page: 2, check: 'low' });
    const item = f.include();
    const old = await legacy(f, await f.asset('#fff'), 'legacy member');
    const id = packet([old.item, item]);
    const scheduler = new MobileRecognitionService(await MobileRecognitionStore.open(f.dir), { inventory: async () => ({ candidates: [], warnings: [] }), recognizeQuestion: async () => { throw Error('unused'); } });
    const jobs = new MaterialJobs(f.store, scheduler, null), uploads = new MaterialUploads(f.store, jobs, null);
    await uploads.initialize();
    const pairing = await PairingManager.open(f.dir, { pairingUrl: 'https://study.pccoding666.com' });
    const { token } = await pairing.redeem(pairing.createSession().payload, crypto.randomUUID(), 'synthetic');
    let release!:()=>void; const gate=new Promise<void>(r=>release=r);
    const app = express();
    app.use('/s', createWebClientRouter({ materials: { store: f.store, jobs, uploads }, mobileDataDir: f.dir, service: scheduler, pairing, limiter: new RateLimiter(), admission: null, ipOf: () => '127.0.0.1', coachProvider: {coachForPrint:async(...args)=>{await gate;return coach.coachForPrint(...args);}} }));
    app.use('/v2', createV2Router({ mobileDataDir: f.dir }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(r => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as {
        port: number;
    }).port}`;
    const headers = { cookie: `sel_device=${token}` };
    try {
        const html = await (await fetch(`${base}/s/items/${item}`, { headers })).text();
        expect(html).toContain(`${one.fragmentId}/crop?revision=1`);
        expect(html).toContain(`${two.fragmentId}/crop?revision=1`);
        expect(html).toContain(`/s/materials/assets/${b.id}/image`);
        const image = await fetch(`${base}/s/materials/fragments/${two.fragmentId}/crop?revision=1`, { headers });
        expect(image.status).toBe(200);
        expect((await sharp(Buffer.from(await image.arrayBuffer())).metadata()).width).toBe(140);
        const original = await fetch(`${base}/s/materials/assets/${a.id}/image`, { headers });
        expect(Buffer.from(await original.arrayBuffer())).toEqual(fs.readFileSync(a.file));
        expect((await fetch(`${base}/s/materials/fragments/${two.fragmentId}/crop?revision=99`, { headers })).status).toBe(404);
        expect((await fetch(`${base}/s/materials/fragments/${two.fragmentId}/crop`, { headers: { accept: 'application/json', cookie: 'sel_device=invalid-token' } })).status).toBe(401);
        const response = await fetch(`${base}/s/skip`, { method: 'POST', headers: {...headers,'content-type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({step:'why',practice:id,namespace:f.store.getWorkspace().draftNamespace}), redirect: 'manual' });
        expect(response.status).toBe(303);
        expect(response.headers.get('location')).toBe(`/s/print/${id}`);
        const preparing = await (await fetch(`${base}/s/print/${id}`, { headers })).text();
        expect(preparing).toContain('data-testid="print-preparing"');
        expect(preparing).toContain('正在准备练习纸…');
        release();
        const s = snapshot(await settled(id));
        const sheet = await (await fetch(`${base}/s/print/${id}/sheet`, { headers })).text();
        expect(sheet).toContain('web first page');
        expect(sheet).toContain('web second page');
        expect((await fetch(`${base}/s/img/print/${id}/${s.items[1]!.cropMedia}`, { headers })).status).toBe(200);
        for (const suffix of ['', '/print', `/print/media/${s.items[1]!.cropMedia}`])
            expect((await fetch(`${base}/v2/practice/${id}${suffix}`)).status).toBe(404);
    }
    finally {
        release();
        await settled(id);
        server.closeAllConnections();
        await new Promise<void>(r => server.close(() => r()));
        await scheduler.stop();
    }
});
it('never silently replaces an explicitly selected legacy answer with a newer evidence interpretation', async () => {
    const f = await fixture(), a = await f.asset('#fff'), old = await legacy(f, a, 'stem', 'explicit old answer', 'ok');
    const chosen = f.store.getQuestion(old.q)!.answers[0]!;
    selectAnswerBasis(f.store, old.q, [chosen.id], f.store.getQuestion(old.q)!.revision);
    expect(getLearningPrintInput(old.item)!.answers).toEqual([chosen]);
    const id = packet([old.item]);
    requestPrint(id, coach, 'all');
    snapshot(await settled(id));
    const before = frozen(id);
    const record = JSON.parse((f.db.prepare('SELECT content_json FROM evidence_record WHERE item_id=?').get(old.item) as {
        content_json: string;
    }).content_json);
    record.observations[0].text = 'new real interpretation';
    f.db.prepare('UPDATE evidence_record SET content_json=?,revision=revision+1 WHERE item_id=?').run(JSON.stringify(record), old.item);
    const next = packet([old.item]);
    let calls = 0;
    requestPrint(next, { coachForPrint: async (...args) => { calls++; return coach.coachForPrint(...args); } }, 'all');
    const result = snapshot(await settled(next));
    expect(result.answerSheet[0]!.answer).toEqual({ text: null, source: 'none', label: '参考答案待确定' });
    expect(calls).toBe(0);
    expect(frozen(id)).toBe(before);
});

it('verifies original bytes in the actual legacy mobile layout before cropping its normalized derivative',async()=>{
 const f=await fixture(),a=await f.asset('#f00',false,6),old=await legacy(f,a,'real mobile layout');
 const mobile=await MobileRecognitionStore.open(f.dir),bytes=fs.readFileSync(a.file);
 const normalized=await sharp(bytes).rotate().jpeg({quality:65}).toBuffer();expect(normalized).not.toEqual(bytes);
 const {job}=await mobile.createJob({idempotencyKey:crypto.randomUUID(),photoName:'synthetic.jpg',sourceBytes:bytes,normalizedBytes:normalized});
 f.db.prepare('UPDATE source_asset SET storage_path=? WHERE id=?').run(path.join(f.dir,'jobs',job.id,'media',`${job.sourceMediaId}.jpg`),a.sourceId);
 f.db.prepare('UPDATE mobile_item_link SET job_id=? WHERE item_id=?').run(job.id,old.item);
 fs.writeFileSync(path.join(f.dir,'jobs',job.id,'media',`${job.sourceMediaId}.jpg`),'damaged derivative');
 const id=packet([old.item]);requestPrint(id,coach,'all');expect((await settled(id)).status).toBe('ready');
 const fragment=f.store.getQuestion(old.q)!.stem[0]!;expect((await sharp(await readFragmentImage(f.store,fragment.fragmentId,fragment.revision)).metadata()).width).toBe(70);
 fs.writeFileSync(path.join(f.dir,'jobs',job.id,'source-original.jpg'),'replaced original');
 await expect(readFragmentImage(f.store,fragment.fragmentId,fragment.revision)).rejects.toThrow(/原图|hash/);
});

it.each([{ badge: 'low', verified: 1 }, { badge: 'ok', verified: 0 }])('retains a single original legacy answer fallback for $badge/verified=$verified', async ({ badge, verified }) => {
    const f = await fixture(), a = await f.asset('#fff');
    const old = await legacy(f, a, 'legacy stem', 'single original answer', badge, verified);
    const q = f.store.getQuestion(old.q)!;
    expect(q.answers).toHaveLength(1);
    expect(q.answers[0]!.stale).toBe(true);
    expect(q.answerConflict).toBe(false);
    expect(selectedAnswerIds(f.store, old.q)).toEqual([]);
    expect(learningPrintAnswerBlocked(old.item)).toBe(false);
    expect(getLearningPrintInput(old.item)!.answers.map(a => a.text)).toEqual(['single original answer']);
    const id = packet([old.item]);
    requestPrint(id, coach, 'all');
    expect(snapshot(await settled(id)).answerSheet[0]!.answer).toEqual({ text: 'single original answer', source: 'paper', label: '原卷参考答案' });
});
it('blocks unresolved original legacy reference conflicts and freezes a subsequent explicit choice', async () => {
    const f = await fixture(), a = await f.asset('#fff');
    const old = await legacy(f, a, 'legacy stem', ['first original answer', 'conflicting original answer'], 'ok');
    const q = f.store.getQuestion(old.q)!;
    expect(q.answers).toHaveLength(2);
    expect(q.answers.every(a => !a.stale && a.subpart === null)).toBe(true);
    expect(q.answerConflict).toBe(true);
    expect(selectedAnswerIds(f.store, old.q)).toEqual([]);
    const id = packet([old.item]);
    let calls = 0;
    const countingCoach: CoachProvider = { coachForPrint: async (...args) => { calls++; return coach.coachForPrint(...args); } };
    requestPrint(id, countingCoach, 'all');
    const pending = snapshot(await settled(id));
    expect({ answer: pending.answerSheet[0]!.answer, calls }).toEqual({ answer: { text: null, source: 'none', label: '参考答案待确定' }, calls: 0 });
    expect(learningPrintAnswerBlocked(old.item)).toBe(true);
    expect(getLearningPrintInput(old.item)!.answers).toEqual([]);
    const pendingBytes = (f.db.prepare('SELECT snapshot_json FROM v2_print_snapshot WHERE packet_id=?').get(id) as { snapshot_json: string }).snapshot_json;
    const pendingBasis = frozen(id);
    const chosen = q.answers.find(a => a.text === 'conflicting original answer')!;
    selectAnswerBasis(f.store, old.q, [chosen.id], q.revision);
    expect(f.store.getQuestion(old.q)!.answerConflict).toBe(true);
    expect(learningPrintAnswerBlocked(old.item)).toBe(false);
    expect(getLearningPrintInput(old.item)!.answers).toEqual([chosen]);
    const next = packet([old.item]);
    requestPrint(next, countingCoach, 'all');
    expect(snapshot(await settled(next)).answerSheet[0]!.answer).toEqual({ text: chosen.text, source: 'paper', label: '拍照导入参考答案' });
    expect(calls).toBe(1);
    expect(JSON.parse(frozen(next)).items[0].input.answers).toEqual([chosen]);
    expect(getPrintStatus(id, 'all').httpStatus).toBe(200);
    expect((f.db.prepare('SELECT snapshot_json FROM v2_print_snapshot WHERE packet_id=?').get(id) as { snapshot_json: string }).snapshot_json).toBe(pendingBytes);
    expect(frozen(id)).toBe(pendingBasis);
});
