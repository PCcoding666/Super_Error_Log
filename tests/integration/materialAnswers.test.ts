import { afterEach, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import http from 'node:http';
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { createWebClientRouter } from '../../src/web/router.js';
import { PairingManager } from '../../src/mobile/pairing.js';
import { RateLimiter } from '../../src/mobile/rateLimit.js';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { migrateMaterials } from '../../src/materials/schema.js';
import { MaterialStore } from '../../src/materials/store.js';
import { MaterialJobs } from '../../src/materials/jobs.js';
import { MaterialUploads } from '../../src/materials/uploads.js';
import { MobileRecognitionService } from '../../src/mobile/service.js';
import { MobileRecognitionStore } from '../../src/mobile/store.js';
import { AdmissionController } from '../../src/mobile/admission.js';
import { createMaterialsRouter } from '../../src/web/materialsRouter.js';
import { CONSENT_VERSION } from '../../src/web/session.js';
import { backfillImportedAnswers, saveManualAnswer, importAnswerText, requestAnswers, selectAnswerBasis, selectedAnswerIds, generateAnswer, generateAnswerForBasis, registerMaterialAnswers } from '../../src/materials/answers.js';
import { createMaterialActionProvider } from '../../src/materials/provider.js';
import { gradeBasis, answerHistory, answerBasis, readQuestion } from '../../src/materials/queries.js';
import { assignDocument, assetLinkRevision, relink, undoLink, linkRevision } from '../../src/materials/links.js';
import type { Fragment } from '../../src/materials/contracts.js';
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const c of cleanups.splice(0).reverse())
        await c();
});
function setup() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    db.exec(SCHEMA_SQL);
    migrateMaterials(db);
    db.exec("INSERT INTO student_profile(id,nickname,created_at) VALUES ('a','A','2026-10-20'),('b','B','2026-10-20')");
    cleanups.push(() => db.close());
    return new MaterialStore(db, 'a');
}
function question(store: MaterialStore, number = '12', subpart: string | null = null) {
    const q = store.createQuestion({ number });
    const id = randomUUID();
    const cap = store.createCapture(randomUUID());
    store.db.prepare('INSERT INTO source_batch(id,student_id,created_at) VALUES (?,?,?)').run(id, store.studentId, '2026-10-20');
    store.db.prepare('INSERT INTO source_asset(id,batch_id,filename,mime,size,content_hash,storage_path,created_at) VALUES (?,?,?,?,?,?,?,?)').run(id, id, 'synthetic.jpg', 'image/jpeg', 1, id, '/synthetic.jpg', '2026-10-20');
    store.db.prepare('INSERT INTO material_asset(id,owner_id,capture_id,source_asset_id) VALUES (?,?,?,?)').run(id, store.studentId, cap.id, id);
    const stem: Fragment = { assetId: id, fragmentId: randomUUID(), revision: 1, sourceHash: id, box: { x: 0, y: 0, width: 1, height: 1 }, role: 'question', text: '1+1=?', number, subpart, page: 1, order: 0, requiresDiagram: false, check: 'passed', uncertainties: [] };
    store.putFragment(stem);
    store.linkFragment(stem.fragmentId, 1, { questionId: q.id, attemptId: null });
    return { id: q.id, stem };
}
const manual = (s: MaterialStore, id: string, text = '2', subpart: string | null = null) => saveManualAnswer(s, { questionId: id, subpart, text, claimedSource: '老师提供', expectedRevision: readQuestion(s, id)!.revision });
async function runtime(store: MaterialStore, capacity = 10) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'answers-'));
    const admission = new AdmissionController({ jobCapacity: capacity, diskProbe: async () => 10n ** 12n });
    const scheduler = new MobileRecognitionService(await MobileRecognitionStore.open(dir), { inventory: async () => ({ candidates: [], warnings: [], capacityReached: false }), recognizeQuestion: async () => {
            throw Error('unused');
        } });
    scheduler.useAdmission(admission);
    const jobs = new MaterialJobs(store, scheduler, admission);
    const uploads = new MaterialUploads(store, jobs, admission);
    await uploads.initialize();
    cleanups.push(async () => {
        await scheduler.stop();
        rmSync(dir, { recursive: true, force: true });
    });
    return { jobs, uploads, admission, scheduler, dir };
}
async function settled(jobs: MaterialJobs, id: string) {
    for (let i = 0; i < 200; i++) {
        const j = jobs.get(id)!;
        if (!['queued', 'running'].includes(j.state))
            return j;
        await new Promise(r => setTimeout(r, 5));
    }
    throw Error('not settled');
}
it('retains imported manual and AI answers with their real provenance', async () => {
    const s = setup();
    const q = question(s);
    const a = s.createAttempt(q.id);
    const work = { ...q.stem, fragmentId: randomUUID(), role: 'student_work' as const, text: 'original work' };
    s.putFragment(work);
    s.linkFragment(work.fragmentId, 1, { questionId: q.id, attemptId: a.id });
    const before = readQuestion(s, q.id)!.attempts;
    const rt = await runtime(s);
    registerMaterialAnswers(s, rt.jobs, rt.uploads, { mode: 'mock' });
    const result = requestAnswers(s, rt.jobs, { requestId: randomUUID(), questionIds: [q.id] });
    await settled(rt.jobs, result.jobs[0]!.id);
    const m = manual(s, q.id);
    const imported = { ...q.stem, fragmentId: randomUUID(), role: 'reference_answer' as const, text: 'teacher answer' };
    s.putFragment(imported);
    s.linkFragment(imported.fragmentId, 1, { questionId: q.id, attemptId: null });
    const bundle = readQuestion(s, q.id)!;
    expect(bundle.answers.map(a => a.source)).toEqual(expect.arrayContaining(['imported', 'manual', 'ai']));
    expect(m.source).toBe('manual');
    expect(bundle.answers.find(a => a.source === 'imported')!.fragmentIds).toEqual([imported.fragmentId]);
    expect(bundle.attempts).toEqual(before);
    expect(bundle.answerConflict).toBe(true);
});
it('versions manual edits and selects current answers explicitly without grading', () => {
    const s = setup();
    const q = question(s);
    const first = manual(s, q.id, ' 2 ');
    expect(manual(s, q.id, '2').id).toBe(first.id);
    const next = manual(s, q.id, '3');
    expect(next.id).toBe(first.id);
    expect(next.revision).toBe(2);
    expect(s.db.prepare('SELECT count(*) n FROM material_answer').get()).toEqual({ n: 2 });
    expect(selectedAnswerIds(s, q.id)).toEqual([next.id]);
    selectAnswerBasis(s, q.id, [next.id], readQuestion(s, q.id)!.revision);
    expect(s.db.prepare('SELECT count(*) n FROM material_grade').get()).toEqual({ n: 0 });
    expect(() => selectAnswerBasis(s, q.id, ['missing'], readQuestion(s, q.id)!.revision)).toThrow();
});
it('keeps ambiguous pasted full-number/subpart rows pending with original text and no fake fragments', () => {
    const s = setup();
    s.db.exec("INSERT INTO material_document(id,owner_id) VALUES ('doc','a')");
    const q = question(s, '12', 'a');
    const b = question(s, '12', 'b');
    for (const id of [q.id, b.id])
        s.db.prepare("UPDATE material_question SET document_id='doc' WHERE id=?").run(id);
    const raw = '12(a): alpha\n12: ambiguous\n13: unmatched';
    const imported = importAnswerText(s, 'doc', raw);
    expect(imported.saved).toHaveLength(1);
    expect(imported.saved[0]).toMatchObject({ questionId: q.id, source: 'imported', subpart: 'a', fragmentIds: [] });
    expect(imported.pending).toHaveLength(2);
    expect(JSON.stringify(s.db.prepare('SELECT * FROM material_answer_import').all())).toContain('ambiguous');
    expect(() => importAnswerText(s, 'foreign', '1: no')).toThrow();
});
it('accounts for capacity, eligible and missing questions and rejects changed replay selection', async () => {
    const s = setup();
    const one = question(s);
    const two = question(s);
    const missing = s.createQuestion();
    const { jobs } = await runtime(s, 1);
    const requestId = randomUUID();
    const result = requestAnswers(s, jobs, { requestId, questionIds: [one.id, two.id, missing.id] });
    expect(result.jobs).toHaveLength(1);
    expect(result.skipped).toHaveLength(2);
    expect(requestAnswers(s, jobs, { requestId, questionIds: [one.id, two.id, missing.id] })).toEqual(result);
    expect(() => requestAnswers(s, jobs, { requestId, questionIds: [two.id] })).toThrow();
});
it('does not silently publish stale AI output and GET never generates', async () => {
    const s = setup();
    const q = question(s);
    const { jobs } = await runtime(s);
    let completed!: () => void;
    const done = new Promise<void>(r => completed = r);
    let calls = 0;
    let finish!: (v: any) => void;
    let began!: () => void;
    const started = new Promise<void>(r => began = r);
    jobs.register('answer', async (id, signal) => {
        await generateAnswer(s, { answer: async (input) => {
                calls++;
                began();
                return new Promise(r => finish = r);
            } }, id, signal);
        completed();
    });
    const ticket = requestAnswers(s, jobs, { requestId: randomUUID(), questionIds: [q.id] }).jobs[0]!;
    await started;
    const next = { ...q.stem, revision: 2, text: '2+2=?' };
    s.putFragment(next);
    s.linkFragment(next.fragmentId, 2, { questionId: q.id, attemptId: null });
    finish({ text: '2', fragmentIds: [q.stem.fragmentId], run: { stage: 'material_answer', model: 'local', durationMs: 1, promptTokens: null, completionTokens: null, maxTokens: 100, thinking: false, promptVersion: 'test' } });
    await done;
    await settled(jobs, ticket.id);
    expect(jobs.get(ticket.id)!.state).toBe('stale');
    expect(readQuestion(s, q.id)!.answers[0]!.stale).toBe(true);
    const n = calls;
    readQuestion(s, q.id);
    readQuestion(s, q.id);
    expect(calls).toBe(n);
});
it('projects photographed answers on relink and undo and keeps history and raw source', () => {
    const s = setup();
    const q = question(s);
    const other = question(s);
    const f = { ...q.stem, fragmentId: randomUUID(), role: 'reference_answer' as const, text: 'answer' };
    s.putFragment(f);
    s.linkFragment(f.fragmentId, 1, { questionId: q.id, attemptId: null });
    expect(readQuestion(s, q.id)!.answers).toHaveLength(1);
    const change = relink(s, { fragmentIds: [f.fragmentId], target: { questionId: other.id, attemptId: null }, expectedRevision: linkRevision(s) });
    expect(readQuestion(s, q.id)!.answers[0]!.stale).toBe(true);
    expect(readQuestion(s, other.id)!.answers[0]!.stale).toBe(false);
    undoLink(s, change.id, linkRevision(s));
    expect(readQuestion(s, q.id)!.answers.find(a => !a.stale)).toBeTruthy();
    expect(s.db.prepare('SELECT count(*) n FROM material_fragment WHERE id=?').get(f.fragmentId)).toEqual({ n: 1 });
});
it('supports 40000 Chinese characters over bounded HTTP while retaining ownership and CSRF', async () => {
    const s = setup();
    const q = question(s);
    const rt = await runtime(s);
    const namespace = s.getWorkspace().draftNamespace;
    const app = express();
    app.use('/s', createMaterialsRouter({ store: s, ...rt, draftNamespace: namespace }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(r => server.once('listening', r));
    cleanups.push(async () => {
        server.closeAllConnections();
        await new Promise<void>(r => server.close(() => r()));
    });
    const base = `http://127.0.0.1:${(server.address() as {
        port: number;
    }).port}`;
    const body = new URLSearchParams({ namespace, questionId: q.id, text: '中'.repeat(40000), claimedSource: '老师提供', expectedRevision: String(readQuestion(s, q.id)!.revision) });
    const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', cookie: `sel_consent=${CONSENT_VERSION}` };
    expect((await fetch(base + '/s/materials/answers/manual', { method: 'POST', headers, body })).status).toBe(200);
    expect(readQuestion(s, q.id)!.answers[0]!.text).toHaveLength(40000);
    expect((await fetch(base + '/s/materials/answers/manual', { method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body })).status).toBe(403);
    const before = s.db.prepare('SELECT total_changes() n').get();
    expect((await fetch(base + '/s/materials/questions/' + q.id)).status).toBe(200);
    expect(s.db.prepare('SELECT total_changes() n').get()).toEqual(before);
});
it('passes the authenticated parent router for long Chinese forms and rejects over-limit/foreign inputs', async () => {
    const s = setup();
    const q = question(s);
    const rt = await runtime(s);
    const manager = await PairingManager.open(rt.dir, { pairingUrl: 'https://study.pccoding666.com' });
    const { token } = await manager.redeem(manager.createSession().payload, randomUUID(), 'synthetic');
    const namespace = s.getWorkspace().draftNamespace;
    const app = express();
    app.use('/s', createWebClientRouter({ materials: { store: s, jobs: rt.jobs, uploads: rt.uploads }, mobileDataDir: rt.dir, service: rt.scheduler, pairing: manager, limiter: new RateLimiter(), admission: rt.admission, ipOf: () => '127.0.0.1' }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(r => server.once('listening', r));
    cleanups.push(async () => {
        server.closeAllConnections();
        await new Promise<void>(r => server.close(() => r()));
    });
    const base = `http://127.0.0.1:${(server.address() as {
        port: number;
    }).port}`;
    const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', cookie: `sel_device=${token}; sel_consent=${CONSENT_VERSION}` };
    const post = (fields: Record<string, string>, extra = {}) => fetch(base + '/s/materials/answers/manual', { method: 'POST', headers: { ...headers, ...extra }, body: new URLSearchParams({ namespace, questionId: q.id, text: '中'.repeat(40000), expectedRevision: String(readQuestion(s, q.id)!.revision), ...fields }), redirect: 'manual' });
    expect((await post({})).status).toBe(200);
    expect((await post({ text: '中'.repeat(40001) })).status).toBe(400);
    expect((await post({ claimedSource: '中'.repeat(201) })).status).toBe(400);
    const other = new MaterialStore(s.db, 'b').createQuestion();
    expect((await post({ questionId: other.id })).status).toBe(404);
    expect((await post({ namespace: 'other' })).status).toBe(409);
    expect((await post({}, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post({}, { cookie: `sel_consent=${CONSENT_VERSION}` })).status).toBe(401);
    expect((await post({ text: '中'.repeat(70000) })).status).toBe(413);
});
it('rolls job admission and batch accounting back together and recovers a partial batch on replay', async () => {
    const s = setup();
    const one = question(s), two = question(s);
    const { jobs, admission } = await runtime(s, 2);
    const request = { requestId: randomUUID(), questionIds: [one.id, two.id] };
    s.db.exec("CREATE TRIGGER fail_batch BEFORE UPDATE ON material_action_batch BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END");
    expect(() => requestAnswers(s, jobs, request)).toThrow('synthetic storage failure');
    expect(s.db.prepare("SELECT count(*) n FROM material_job WHERE kind='answer'").get()).toEqual({ n: 0 });
    s.db.exec('DROP TRIGGER fail_batch');
    const result = requestAnswers(s, jobs, request);
    expect(result.jobs).toHaveLength(2);
    for (const job of result.jobs) {
        const row = s.db.prepare('SELECT input_json,dependencies_json FROM material_job WHERE id=?').get(job.id) as {
            input_json: string;
            dependencies_json: string;
        };
        expect(JSON.parse(row.input_json).stem).toHaveLength(1);
        expect(JSON.parse(row.dependencies_json).version).toBe(1);
    }
    expect(requestAnswers(s, jobs, request).jobs.map(x => x.id)).toEqual(result.jobs.map(x => x.id));
});
it('keeps inline answer operation identity across grading retry and commits result atomically', async () => {
    const s = setup();
    const q = question(s);
    let calls = 0;
    const provider = { answer: async () => {
            calls++;
            return { text: '2', fragmentIds: [q.stem.fragmentId], run: { stage: 'material_answer' as const, model: 'synthetic', durationMs: 1, promptTokens: null, completionTokens: null, maxTokens: 100, thinking: false as const, promptVersion: 'test' } };
        } };
    const input = { operationId: 'grade-parent-answer', questionId: q.id, stem: [q.stem], basis: answerBasis(s, q.id) };
    const signal = new AbortController().signal;
    await expect(generateAnswerForBasis(s, provider, input, signal, () => {
        throw Error('atomic result failure');
    })).rejects.toThrow();
    expect(s.db.prepare('SELECT count(*) n FROM material_answer').get()).toEqual({ n: 0 });
    const a = await generateAnswerForBasis(s, provider, input, signal);
    const before = calls;
    expect(await generateAnswerForBasis(s, provider, input, signal)).toEqual(a);
    expect(calls).toBe(before);
    expect(s.db.prepare('SELECT count(*) n FROM material_answer').get()).toEqual({ n: 1 });
});
it('uses owned real diagram crops and rejects bad references before a successful checkpoint', async () => {
    const s = setup();
    const q = question(s);
    const rt = await runtime(s);
    const original = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#f00' } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const imagePath = path.join(rt.dir, 'diagram.jpg');
    writeFileSync(imagePath, original);
    q.stem.sourceHash = createHash('sha256').update(original).digest('hex');
    const diagram = { ...q.stem, fragmentId: randomUUID(), role: 'diagram' as const, box: { x: 0, y: 0, width: 0.5, height: 1 } };
    const secondPath = path.join(rt.dir, 'second.jpg');
    const secondBytes = await sharp({ create: { width: 80, height: 80, channels: 3, background: '#00f' } }).jpeg().toBuffer();
    writeFileSync(secondPath, secondBytes);
    const second = { ...diagram, assetId: 'second-owned', fragmentId: randomUUID(), sourceHash: createHash('sha256').update(secondBytes).digest('hex') };
    let imageCount = 0;
    let bad = true;
    let calls = 0;
    let imageSeen = false;
    let imageWidth = 0;
    const server = http.createServer(async (req, res) => {
        let raw = '';
        for await (const chunk of req)
            raw += chunk;
        const body = JSON.parse(raw);
        const content = body.messages[1].content;
        const data = JSON.parse(content[0].text);
        const image = content.find((p: any) => p.type === 'image_url');
        imageSeen = !!image;
        imageCount = content.filter((p: any) => p.type === 'image_url').length;
        const metadata = await sharp(Buffer.from(image.image_url.url.split(',')[1], 'base64')).metadata();
        imageWidth = metadata.width!;
        calls++;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ questionId: data.questionId, basisKey: data.basisKey, text: 'Diagram answer', fragmentIds: bad ? ['invented'] : data.fragments.map((f: any) => f.fragmentId) }) } }] }));
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    cleanups.push(async () => {
        server.closeAllConnections();
        await new Promise<void>(r => server.close(() => r()));
    });
    const checkpoint = new Map<string, unknown>();
    const keys: string[] = [];
    const provider = createMaterialActionProvider({ mode: 'openai', chat: { baseUrl: `http://127.0.0.1:${(server.address() as {
                port: number;
            }).port}/v1`, apiKey: 'synthetic', models: { material_extract: 'e', material_verify: 'v', material_answer: 'a', material_grade: 'g' }, timeoutMs: 2000, bailianOnly: false } }, { source: id => {
            if (id === second.assetId)
                return { sourceHash: second.sourceHash, originalPath: secondPath };
            expect(id).toBe(q.stem.assetId);
            return { sourceHash: q.stem.sourceHash, originalPath: imagePath };
        }, request: async (key, invoke) => {
            keys.push(key);
            if (checkpoint.has(key))
                return checkpoint.get(key) as any;
            const value = await invoke(new AbortController().signal);
            checkpoint.set(key, value);
            return value;
        } });
    const input = { questionId: q.id, basisKey: 'basis', fragments: [q.stem, diagram, second] };
    await expect(provider.answer(input, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_output' });
    expect(checkpoint.size).toBe(0);
    bad = false;
    await provider.answer(input, new AbortController().signal);
    await provider.answer(input, new AbortController().signal);
    expect(calls).toBe(2);
    expect(imageSeen).toBe(true);
    expect(imageWidth).toBe(40);
    expect(imageCount).toBe(2);
    expect(new Set(keys).size).toBe(1);
    writeFileSync(imagePath, Buffer.from('replaced'));
    await expect(provider.answer({ ...input, basisKey: 'changed' }, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_output' });
    expect(calls).toBe(2);
});
it('invalidates adopted-answer grading on edits and preserves unrelated subpart answers', () => {
    const s = setup();
    const q = question(s);
    const a = manual(s, q.id, 'a', 'a');
    const b = manual(s, q.id, 'b', 'b');
    expect(readQuestion(s, q.id)!.answerConflict).toBe(false);
    expect(selectedAnswerIds(s, q.id).sort()).toEqual([a.id, b.id].sort());
    const attempt = s.createAttempt(q.id);
    s.db.prepare('INSERT INTO material_grade(id,owner_id,attempt_id,basis_key,content_json) VALUES (?,?,?,?,?)').run('g', s.studentId, attempt.id, 'old', '{}');
    manual(s, q.id, 'new a', 'a');
    expect(s.db.prepare("SELECT stale FROM material_grade WHERE id='g'").get()).toEqual({ stale: 1 });
    expect(readQuestion(s, q.id)!.answers.find(x => x.id === b.id)).toEqual(b);
});
it('does not append low-confidence imported versions on repeated initialization', () => {
    const s = setup();
    const q = question(s);
    const f = { ...q.stem, fragmentId: randomUUID(), role: 'reference_answer' as const, text: 'uncertain answer', check: 'low' as const };
    s.putFragment(f);
    s.linkFragment(f.fragmentId, 1, { questionId: q.id, attemptId: null });
    const before = readQuestion(s, q.id);
    backfillImportedAnswers(s);
    backfillImportedAnswers(s);
    expect(readQuestion(s, q.id)).toEqual(before);
    expect(s.db.prepare('SELECT count(*) n FROM material_answer').get()).toEqual({ n: 1 });
});
it('matches the complete compound printed number rather than its prefix', () => {
    const s = setup();
    s.db.exec("INSERT INTO material_document(id,owner_id) VALUES ('d','a')");
    const q = question(s, '12'), compound = question(s, '12.1');
    for (const id of [q.id, compound.id])
        s.db.prepare("UPDATE material_question SET document_id='d' WHERE id=?").run(id);
    const result = importAnswerText(s, 'd', '12.1: compound answer');
    expect(result.saved[0]!.questionId).toBe(compound.id);
    expect(readQuestion(s, q.id)!.answers).toHaveLength(0);
});
it('only exempts a running same-owner same-question grade parent during its inline answer stage', async () => {
    const s = setup();
    const q = question(s), other = question(s);
    const input = { operationId: 'inline-answer', questionId: q.id, stem: [q.stem], basis: answerBasis(s, q.id), parentJobId: 'parent' };
    const provider = { answer: async () => ({ text: '2', fragmentIds: [q.stem.fragmentId], run: { stage: 'material_answer' as const, model: 'mock', durationMs: 0, promptTokens: null, completionTokens: null, maxTokens: 100, thinking: false as const, promptVersion: 'test' } }) };
    const signal = new AbortController().signal;
    s.db.prepare("INSERT INTO material_job(id,owner_id,request_id,kind,question_id,state) VALUES ('parent','a',?,'grade',?,'running')").run(randomUUID(), q.id);
    await generateAnswerForBasis(s, provider, input, signal);
    expect(s.db.prepare("SELECT state FROM material_job WHERE id='parent'").get()).toEqual({ state: 'running' });
    for (const state of ['queued', 'failed', 'stale']) {
        s.db.prepare("UPDATE material_job SET state=? WHERE id='parent'").run(state);
        await expect(generateAnswerForBasis(s, provider, input, signal)).rejects.toMatchObject({ code: 'stale_basis' });
    }
    s.db.prepare("UPDATE material_job SET state='running',question_id=? WHERE id='parent'").run(other.id);
    await expect(generateAnswerForBasis(s, provider, input, signal)).rejects.toMatchObject({ code: 'stale_basis' });
    const foreign = new MaterialStore(s.db, 'b');
    const fq = foreign.createQuestion();
    s.db.prepare("INSERT INTO material_job(id,owner_id,request_id,kind,question_id,state) VALUES ('foreign','b',?,'grade',?,'running')").run(randomUUID(), fq.id);
    await expect(generateAnswerForBasis(s, provider, { ...input, parentJobId: 'foreign' }, signal)).rejects.toMatchObject({ code: 'stale_basis' });
});
it('does not exempt a parent invalidated by an external answer while its model call is in flight', async()=>{const s=setup(),q=question(s);s.db.prepare("INSERT INTO material_job(id,owner_id,request_id,kind,question_id,state) VALUES ('inflight','a',?,'grade',?,'running')").run(randomUUID(),q.id);let release!:(value:any)=>void;const response=new Promise<any>(r=>release=r);const promise=generateAnswerForBasis(s,{answer:async()=>response},{operationId:'inflight:answer',parentJobId:'inflight',questionId:q.id,stem:[q.stem],basis:answerBasis(s,q.id)},new AbortController().signal);manual(s,q.id,'provided');release({text:'AI result',fragmentIds:[q.stem.fragmentId],run:{stage:'material_answer',model:'mock',durationMs:0,promptTokens:null,completionTokens:null,maxTokens:100,thinking:false,promptVersion:'test'}});await expect(promise).rejects.toMatchObject({code:'stale_basis'});expect(readQuestion(s,q.id)!.answers.map(a=>a.source)).toEqual(['manual']);expect(s.db.prepare("SELECT state FROM material_job WHERE id='inflight'").get()).toEqual({state:'stale'});});
it('resumes the unaccounted remainder after storage fails midway through a batch',async()=>{const s=setup();const one=question(s),two=question(s);const{jobs}=await runtime(s,2);const request={requestId:randomUUID(),questionIds:[one.id,two.id]};s.db.exec("CREATE TRIGGER fail_second BEFORE UPDATE ON material_action_batch WHEN json_array_length(NEW.result_json,'$.jobs')=2 BEGIN SELECT RAISE(ABORT,'second item failed'); END");expect(()=>requestAnswers(s,jobs,request)).toThrow('second item failed');const first=s.db.prepare("SELECT id FROM material_job WHERE kind='answer'").all();expect(first).toHaveLength(1);s.db.exec('DROP TRIGGER fail_second');const replay=requestAnswers(s,jobs,request);expect(replay.jobs).toHaveLength(2);expect(replay.jobs.map(j=>j.id)).toContain((first[0] as {id:string}).id);expect(s.db.prepare("SELECT count(*) n FROM material_job WHERE kind='answer'").get()).toEqual({n:2});});
it('keeps blank colon and dot payloads pending verbatim beside valid imported answers',()=>{
 const s=setup();s.db.exec("INSERT INTO material_document(id,owner_id) VALUES ('blank-doc','a')");const blank=question(s,'12'),valid=question(s,'13');for(const q of[blank,valid])s.db.prepare("UPDATE material_question SET document_id='blank-doc' WHERE id=?").run(q.id);
 const lines=['12:    ','12：\t  ','12.    ','12、\t','12:','13: real answer'];const raw=lines.join('\n');const imported=importAnswerText(s,'blank-doc',raw);
 expect(imported.saved.map(a=>a.text)).toEqual(['real answer']);expect(imported.pending.map(p=>p.text)).toEqual(lines.slice(0,-1));expect(selectedAnswerIds(s,blank.id)).toEqual([]);expect(readQuestion(s,blank.id)!.answers).toEqual([]);expect(s.db.prepare('SELECT original_text FROM material_answer_import').get()).toEqual({original_text:raw});
});
it('shows merged photo history through old URLs with owner-scoped global pagination and read-only GET',async()=>{
 const s=setup();s.db.exec("INSERT INTO material_document(id,owner_id) VALUES ('history-doc','a')");const stem=question(s),photo=question(s);s.db.prepare("UPDATE material_question SET document_id='history-doc' WHERE id=?").run(stem.id);
 let fragment={...photo.stem,role:'reference_answer' as const,text:'historical photo version 1',revision:2};s.putFragment(fragment);s.linkFragment(fragment.fragmentId,fragment.revision,{questionId:photo.id,attemptId:null});const oldId=readQuestion(s,photo.id)!.answers[0]!.id;
 for(let i=2;i<=22;i++){fragment={...fragment,text:`historical photo version ${i}`,revision:i+1};s.putFragment(fragment);s.linkFragment(fragment.fragmentId,fragment.revision,{questionId:photo.id,attemptId:null});}
 s.db.prepare('UPDATE material_asset SET extraction_json=? WHERE id=?').run(JSON.stringify({assetId:fragment.assetId,revision:1,document:{title:null,subject:null,date:null,printedCode:null,page:1},fragments:[fragment],warnings:[],runs:[]}),fragment.assetId);
 const changes=assignDocument(s,{assetId:fragment.assetId,documentId:'history-doc',expectedRevision:assetLinkRevision(s,fragment.assetId)});const page0=answerHistory(s,stem.id,0),page1=answerHistory(s,stem.id,1);expect(page0).toHaveLength(20);expect(page1.length).toBeGreaterThan(0);expect(new Set([...page0,...page1].map(h=>`${h.answer.id}:${h.answer.revision}`)).size).toBe(page0.length+page1.length);expect(page1.some(h=>h.answer.id===oldId&&h.answer.revision===1)).toBe(true);
 const foreign=new MaterialStore(s.db,'b'),fq=foreign.createQuestion();saveManualAnswer(foreign,{questionId:fq.id,subpart:null,text:'FOREIGN HISTORY',claimedSource:null,expectedRevision:1});s.db.prepare("INSERT INTO material_legacy_map(owner_id,source_kind,source_key,question_id) VALUES ('b','question_alias',?,?)").run(photo.id,fq.id);expect([...page0,...page1].some(h=>h.answer.text==='FOREIGN HISTORY')).toBe(false);
 const rt=await runtime(s),namespace=s.getWorkspace().draftNamespace,app=express();app.use('/s',createMaterialsRouter({store:s,...rt,draftNamespace:namespace}));const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));cleanups.push(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/s/materials/questions/`;
 const before=s.db.prepare('SELECT total_changes() n').get();const response=await fetch(base+photo.id+'/answers?page=1');expect(response.status).toBe(200);const html=await response.text();expect(html).toContain('historical photo version 1');expect(html).not.toContain('FOREIGN HISTORY');expect(s.db.prepare('SELECT total_changes() n').get()).toEqual(before);
 undoLink(s,changes[0]!.id,linkRevision(s));expect(answerHistory(s,stem.id).some(h=>h.answer.id===oldId)).toBe(false);expect((await fetch(base+photo.id+'/answers?page=1')).status).toBe(200);
});
it.each(['update','unlink','move'])('invalidates the projected source version and dependent grade on reference %s',action=>{
 const s=setup(),q=question(s),other=question(s);const fragment={...q.stem,fragmentId:randomUUID(),role:'reference_answer' as const,text:'original reference'};s.putFragment(fragment);s.linkFragment(fragment.fragmentId,1,{questionId:q.id,attemptId:null});const old=readQuestion(s,q.id)!.answers[0]!;const attempt=s.createAttempt(q.id);const basis=gradeBasis(s,q.id,attempt.id,[old.id]);s.db.prepare('INSERT INTO material_grade(id,owner_id,attempt_id,basis_key,dependencies_json,content_json) VALUES (?,?,?,?,?,?)').run('source-grade',s.studentId,attempt.id,basis.basisKey,JSON.stringify(basis.dependencies),'{}');
 if(action==='update'){s.putFragment({...fragment,revision:2,text:'changed reference'});s.linkFragment(fragment.fragmentId,2,{questionId:q.id,attemptId:null});}else s.linkFragment(fragment.fragmentId,1,action==='unlink'?null:{questionId:other.id,attemptId:null});
 expect(s.db.prepare('SELECT stale FROM material_answer WHERE id=? AND revision=?').get(old.id,old.revision)).toEqual({stale:1});expect(s.db.prepare("SELECT stale FROM material_grade WHERE id='source-grade'").get()).toEqual({stale:1});expect(readQuestion(s,q.id)!.answers.some(a=>a.id===old.id&&!a.stale)).toBe(action==='update');
});
