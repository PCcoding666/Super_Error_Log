import express, { Router, type Request, type Response } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { newId } from '../db/connection.js';
import type { MaterialStore } from '../materials/store.js';
import type { MaterialUploads } from '../materials/uploads.js';
import type { MaterialJobs } from '../materials/jobs.js';
import type { CaptureHints, MaterialRole, Fragment } from '../materials/contracts.js';
import { assignDocument, assetLinkRevision, linkRevision, relink, relinkNewAttempt, undoLink } from '../materials/links.js';
import { latestFragments } from '../materials/queries.js';
import type { AdmissionController } from '../mobile/admission.js';
import { acquireUploadAdmission, releaseUploadAdmission, trackUploadAdmission } from '../mobile/router.js';
import { MobileRequestError } from '../mobile/service.js';
import { sendHtml } from '../views/render.js';
import { hasConsent } from './session.js';
import { MaterialCapturePage, MaterialConsentPage, MaterialsPage, MaterialQuestionPage, MaterialMatchPage, type MaterialAssetView } from './views/materials.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const roles: MaterialRole[] = ['question', 'diagram', 'student_work', 'correction', 'teacher_mark', 'reference_answer', 'unknown'];
const text = (v: unknown): string => typeof v === 'string' ? v : '';
const list = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' && v ? [v] : [];
function bad(message = '填写的内容不完整，请刷新后再试。'): never { throw new MobileRequestError(400, 'invalid_request', message); }
function hints(value: unknown): CaptureHints {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        bad();
    const v = value as Record<string, unknown>;
    const result: CaptureHints = {};
    const chosen = list(v.roles);
    if (chosen.some(x => !roles.includes(x as MaterialRole)))
        bad();
    if (chosen.length)
        result.roles = [...new Set(chosen)] as MaterialRole[];
    if (v.marking) {
        if (!['unmarked', 'marked', 'partial'].includes(text(v.marking)))
            bad();
        result.marking = v.marking as CaptureHints['marking'];
    }
    if (v.label) {
        if (typeof v.label !== 'string' || v.label.length > 120)
            bad();
        result.label = v.label.trim();
    }
    for (const k of ['documentId', 'questionId', 'attemptId'] as const)
        if (v[k]) {
            if (typeof v[k] !== 'string')
                bad();
            result[k] = v[k];
        }
    return result;
}
function pageNumber(value: unknown): number { const n = Number(value ?? 0); return Number.isSafeInteger(n) && n >= 0 ? Math.min(n, 100000) : 0; }
function revision(value: unknown): number {
    if (!/^[0-9]+$/.test(String(value)))
        bad();
    const n = Number(value);
    if (!Number.isSafeInteger(n))
        bad();
    return n;
}
export function createMaterialsRouter(options: {
    store: MaterialStore;
    uploads: MaterialUploads;
    jobs: MaterialJobs;
    draftNamespace: string;
    admission: AdmissionController | null;
}): Router {
    const { store, uploads, jobs, draftNamespace, admission } = options;
    const r = Router();
    const json = (req: Request) => req.headers.accept?.includes('application/json');
    const assetCount = (): number => (store.db.prepare('SELECT count(*) n FROM material_asset WHERE owner_id=?').get(store.studentId) as {
        n: number;
    }).n;
    const assets = (page = 0, exclude = ''): MaterialAssetView[] => (store.db.prepare('SELECT id,hints_json,document_id,status,link_revision FROM material_asset WHERE owner_id=? AND id!=? ORDER BY created_at,id LIMIT 8 OFFSET ?').all(store.studentId, exclude, page * 8) as {
        id: string;
        hints_json: string;
        document_id: string | null;
        status: string;
        link_revision: number;
    }[]).map(a => ({ ...a, hints: JSON.parse(a.hints_json), fragments: latestFragments(store, a.id) }));
    const result = (req: Request, res: Response, value: unknown) => {
        if (json(req))
            res.json(value);
        else
            res.redirect(303, '/s/materials');
    };
    const expectedNamespace = (req: Request) => text(req.headers['x-draft-namespace']) || text(req.query.namespace) || text(req.body?.namespace);
    const check = (req: Request) => {
        if (expectedNamespace(req) !== draftNamespace)
            throw new MobileRequestError(409, 'draft_identity_changed', '登录的账号已变化，请重新打开页面。');
    };
    r.use((req, res, next) => {
        if (req.path !== '/capture' && !req.path.startsWith('/materials')) {
            next('router');
            return;
        }
        next();
    });
    r.use((req, res, next) => { res.setHeader('cache-control', 'private, no-store'); next(); });
    r.use(express.json({ limit: '64kb' }), express.urlencoded({ extended: false, limit: '64kb', parameterLimit: 400 }));
    r.use((req, res, next) => {
        try {
            if (req.method === 'POST') {
                const origin = req.headers.origin;
                if (req.headers['sec-fetch-site'] === 'cross-site' || (origin && (origin === 'null' || new URL(origin).host !== req.headers.host)))
                    throw new MobileRequestError(403, 'forbidden', '请从自己的页面提交。');
                check(req);
                if (!hasConsent(req))
                    throw new MobileRequestError(403, 'consent_required', '第一次上传前，先看一下上传说明。');
            }
            next();
        }
        catch (e) {
            next(e);
        }
    });
    r.get('/materials/session', (_req, res) => res.json({ draftNamespace, assetCount: assetCount() }));
    r.get('/capture', (req, res) => {
        const context: CaptureHints = {};
        const questionId = text(req.query.questionId);
        const attemptId = text(req.query.attemptId);
        if (questionId) {
            const q = store.getQuestion(questionId);
            if (!q || attemptId && !q.attempts.some(a => a.id === attemptId))
                throw new MobileRequestError(404, 'not_found', '补充的题目或作答不存在。');
            context.questionId = q.id;
            if (attemptId)
                context.attemptId = attemptId;
        }
        else if (attemptId)
            bad();
        sendHtml(res, hasConsent(req) ? MaterialCapturePage({ namespace: draftNamespace, count: assetCount(), uploadId: randomUUID(), context }) : MaterialConsentPage({ namespace: draftNamespace, context }));
    });
    r.post('/capture', () => bad('请重新打开拍照页面再上传。'));
    r.post('/materials/captures', (req, res) => {
        if (!UUID.test(text(req.body.requestId)))
            bad();
        res.json(store.createCapture(req.body.requestId));
    });
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 2, fields: 12, parts: 16 } }).single('photo');
    r.post('/materials/uploads', async (req, res, next) => {
        const reserve = admission ? trackUploadAdmission(admission, res) : undefined;
        try {
            const uploadId = text(req.headers['x-upload-id']) || text(req.query.uploadId);
            if (!UUID.test(uploadId))
                bad();
            if (admission && reserve && uploads.hasUpload(uploadId)) {
                // Replay bypasses job capacity, never the bounded multipart parsing slot.
                const slot = admission.tryAcquireUploadSlot('upload');
                if (!slot.accepted) { res.setHeader('retry-after', String(slot.retryAfterSeconds)); throw new MobileRequestError(429, 'busy', '服务器正在处理另一个上传，请稍后再试。'); }
                reserve.slot = true;
            } else if (admission && reserve) {
                const rejection = await acquireUploadAdmission(admission, reserve);
                if (rejection) {
                    res.setHeader('retry-after', String(rejection.retryAfterSeconds ?? 5));
                    throw new MobileRequestError(rejection.status, rejection.code, rejection.message);
                }
            }
            await new Promise<void>((resolve, reject) => upload(req, res, e => e ? reject(e) : resolve()));
            check(req);
            if (!req.file)
                bad('先选一张照片。');
            const parsed = req.body.hints ? JSON.parse(text(req.body.hints)) : req.body;
            const captureHints = hints(parsed);
            // A form POST is the only place the no-JS path creates its capture; GET never writes.
            const captureId = text(req.body.captureId) || store.createCapture(uploadId).id;
            const saved = await uploads.save({ captureId, uploadId, bytes: req.file.buffer, filename: req.file.originalname, hints: captureHints }, reserve);
            result(req, res, { ok: true, ...saved });
        }
        catch (e) {
            next(e);
        }
        finally {
            if (admission && reserve)
                releaseUploadAdmission(admission, reserve);
        }
    });
    r.get('/materials', (req, res) => {
        const page = pageNumber(req.query.page);
        const documents = store.db.prepare('SELECT id,label FROM material_document WHERE owner_id=? ORDER BY created_at,id').all(store.studentId) as {
            id: string;
            label: string | null;
        }[];
        const changes = store.db.prepare("SELECT id FROM material_link_event WHERE owner_id=? AND decision='manual' AND json_extract(basis_json,'$.operation') IS NOT NULL ORDER BY rowid DESC LIMIT 5").all(store.studentId) as {
            id: string;
        }[];
        const tickets = store.db.prepare("SELECT id,state FROM material_job WHERE owner_id=? AND kind='extract' AND state IN ('failed','interrupted')").all(store.studentId) as {
            id: string;
            state: string;
        }[];
        sendHtml(res, MaterialsPage({ namespace: draftNamespace, questions: store.listQuestions(), assets: assets(page), page, hasMore: (page + 1) * 8 < assetCount(), documents, changes, jobs: tickets, revision: linkRevision(store) }));
    });
    r.get('/materials/assets/:id/match', (req, res) => {
        const id = text(req.params.id);
        assetLinkRevision(store, id);
        const page = pageNumber(req.query.page);
        const row = store.db.prepare('SELECT id,hints_json,document_id,status,link_revision FROM material_asset WHERE owner_id=? AND id=?').get(store.studentId, id) as Omit<MaterialAssetView, 'hints' | 'fragments'> & {
            hints_json: string;
        };
        const asset = { ...row, hints: JSON.parse(row.hints_json), fragments: latestFragments(store, id) };
        sendHtml(res, MaterialMatchPage({ namespace: draftNamespace, asset, candidates: assets(page, id), page, hasMore: (page + 1) * 8 < assetCount() - 1 }));
    });
    r.get('/materials/questions/:id', (req, res) => {
        const q = store.getQuestion(text(req.params.id));
        if (!q)
            throw new MobileRequestError(404, 'not_found', '题目不存在。');
        sendHtml(res, MaterialQuestionPage({ namespace: draftNamespace, question: q, questions: store.listQuestions(), revision: linkRevision(store), materials: (store.db.prepare('SELECT f.content_json FROM material_link_event l JOIN material_fragment f ON f.owner_id=l.owner_id AND f.id=l.fragment_id AND f.revision=l.fragment_revision WHERE l.owner_id=? AND l.question_id=? AND NOT EXISTS (SELECT 1 FROM material_link_event n WHERE n.owner_id=l.owner_id AND n.fragment_id=l.fragment_id AND n.revision>l.revision)').all(store.studentId, q.id) as {
                content_json: string;
            }[]).map(row => JSON.parse(row.content_json) as Fragment) }));
    });
    r.get('/materials/assets/:id/image', async (req, res) => { const source = uploads.source(text(req.params.id)); const metadata = await sharp(source.originalPath).metadata(); res.type(metadata.format === 'png' ? 'image/png' : metadata.format === 'webp' ? 'image/webp' : metadata.format === 'heif' ? 'image/heic' : 'image/jpeg').sendFile(source.originalPath); });
    r.post('/materials/assets/:id/hints', (req, res) => {
        const selected = hints(req.body);
        const ids = [...new Set([text(req.params.id), ...list(req.body.assetIds)])];
        if (ids.length > 100)
            bad();
        // Hints edit display/role suggestions only. Association has separate checked actions.
        if (selected.documentId || selected.questionId || selected.attemptId)
            bad();
        store.transaction(() => {
            for (const id of ids) {
                assetLinkRevision(store, id);
                const row = store.db.prepare('SELECT hints_json FROM material_asset WHERE owner_id=? AND id=?').get(store.studentId, id) as {
                    hints_json: string;
                };
                const old = JSON.parse(row.hints_json) as CaptureHints;
                delete old.roles;
                delete old.marking;
                delete old.label;
                store.db.prepare('UPDATE material_asset SET hints_json=? WHERE owner_id=? AND id=?').run(JSON.stringify({ ...old, ...selected }), store.studentId, id);
            }
        });
        result(req, res, { ok: true });
    });
    r.post('/materials/assets/:id/document', (req, res) => {
        const assetId = text(req.params.id);
        const expectedRevision = revision(req.body.expectedRevision);
        const changes = store.transaction(() => {
            // Check before creating the optional unnamed paper, so a stale form cannot leave an empty row.
            if (assetLinkRevision(store, assetId) !== expectedRevision)
                throw new MobileRequestError(409, 'conflict', '材料已变化，请刷新后再试。');
            let documentId = req.body.newDocument === true || req.body.newDocument === '1' ? '' : text(req.body.documentId);
            const candidate = text(req.body.candidateAssetId);
            if (candidate) {
                const row = store.db.prepare('SELECT document_id FROM material_asset WHERE owner_id=? AND id=?').get(store.studentId, candidate) as {
                    document_id: string | null;
                } | undefined;
                if (!row)
                    throw new MobileRequestError(404, 'not_found', '材料不存在。');
                documentId = row.document_id ?? '';
            }
            if (!documentId && (req.body.newDocument === true || req.body.newDocument === '1' || candidate)) {
                documentId = newId('mdoc');
                store.db.prepare('INSERT INTO material_document(id,owner_id,label) VALUES (?,?,?)').run(documentId, store.studentId, null);
            }
            if (!documentId)
                bad('选一份试卷，或新建一份。');
            const changes = [];
            if (candidate && candidate !== assetId)
                changes.push(...assignDocument(store, { assetId: candidate, documentId, expectedRevision: revision(req.body.candidateRevision) }));
            changes.push(...assignDocument(store, { assetId, documentId, expectedRevision: assetLinkRevision(store, assetId) }));
            return changes;
        });
        result(req, res, { ok: true, changes });
    });
    r.post('/materials/links', (req, res) => { const input = { fragmentIds: list(req.body.fragmentIds), questionId: text(req.body.questionId), expectedRevision: revision(req.body.expectedRevision) }; const change = req.body.newAttempt === '1' || req.body.newAttempt === true ? relinkNewAttempt(store, input) : relink(store, { ...input, target: { questionId: input.questionId, attemptId: text(req.body.attemptId) || null } }); result(req, res, { ok: true, change }); });
    r.post('/materials/links/:id/undo', (req, res) => result(req, res, { ok: true, change: undoLink(store, text(req.params.id), revision(req.body.expectedRevision)) }));
    r.post('/materials/jobs/:id/retry', (req, res) => {
        if (!UUID.test(text(req.body.requestId)))
            bad();
        result(req, res, { ok: true, job: jobs.retry(text(req.params.id), req.body.requestId) });
    });
    r.use(((err: unknown, req: Request, res: Response, _next: express.NextFunction) => {
        const status = err instanceof MobileRequestError ? err.status : err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE' ? 413 : err instanceof SyntaxError || err instanceof multer.MulterError ? 400 : 500;
        const message = err instanceof MobileRequestError ? err.message : status === 413 ? '照片超过 15 MB，请换一张。' : status === 400 ? '照片或填写的内容不完整，请重选后再试。' : '暂时没保存好，请稍后再试。';
        res.status(status);
        if (json(req))
            res.json({ error: { code: err instanceof MobileRequestError ? err.code : 'invalid_request', message } });
        else
            res.type('html').send(`<!doctype html><html lang="zh"><meta name="viewport" content="width=device-width,initial-scale=1"><p>${message}</p><a href="/s/capture">返回拍照</a> · <a href="/s/materials">刷新材料</a></html>`);
    }) as express.ErrorRequestHandler);
    return r;
}
