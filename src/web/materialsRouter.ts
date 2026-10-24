import { setQuestionIncluded, inclusionIntent, inclusionIntents, includeQuestions, markedRight, notYetIncluded, sortQuestions, unplacedMaterial, unsupportedSubject } from '../materials/learning.js';
import { createHash } from 'node:crypto';
import { canRecover } from '../mobile/contracts.js';
import { requestGrades } from '../materials/grading.js';
import { saveManualAnswer, importAnswerText, requestAnswers, selectAnswerBasis, selectedAnswerIds } from '../materials/answers.js';
import express, { Router, type Request, type Response } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { readFragmentImage, readSourceBytes } from '../materials/media.js';
import { randomUUID } from 'node:crypto';
import { newId } from '../db/connection.js';
import type { MaterialStore } from '../materials/store.js';
import type { MaterialUploads } from '../materials/uploads.js';
import type { MaterialJobs } from '../materials/jobs.js';
import type { CaptureHints, MaterialRole } from '../materials/contracts.js';
import { assignDocument, assetLinkRevision, linkRevision, relink, relinkNewAttempt, undoLink } from '../materials/links.js';
import { answerHistory, latestFragments, linkedFragments } from '../materials/queries.js';
import type { AdmissionController } from '../mobile/admission.js';
import { acquireUploadAdmission, releaseUploadAdmission, trackUploadAdmission } from '../mobile/router.js';
import { MobileRequestError } from '../mobile/service.js';
import { sendHtml } from '../views/render.js';
import { type MaterialInclusionMark, type MaterialJobView, type MaterialUnplacedGroup, MaterialGradeActionPage, MaterialAnswerHistoryPage, MaterialImportHistoryPage, MaterialAnswerActionPage, MaterialCapturePage, MaterialsPage, MaterialQuestionPage, MaterialMatchPage, type MaterialAssetView } from './views/materials.js';
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
    const assets = (page = 0, exclude = ''): MaterialAssetView[] => (store.db.prepare('SELECT id,hints_json,document_id,status,link_revision FROM material_asset WHERE owner_id=? AND id!=? ORDER BY created_at,rowid LIMIT 8 OFFSET ?').all(store.studentId, exclude, page * 8) as {
        id: string;
        hints_json: string;
        document_id: string | null;
        status: string;
        link_revision: number;
    }[]).map(a => ({ ...a, hints: JSON.parse(a.hints_json), fragments: latestFragments(store, a.id) }));
    /** Latest extraction job per photo: failed ones are summarized at the top, separate from photos still in progress. */
    const extractJobs = (): { failed: MaterialJobView[]; processing: number } => {
        const rows = store.db.prepare(`SELECT j.id,j.state,j.asset_id,j.error FROM material_job j WHERE j.owner_id=? AND j.kind='extract'
          AND NOT EXISTS (SELECT 1 FROM material_job n WHERE n.owner_id=j.owner_id AND n.kind='extract' AND n.asset_id=j.asset_id AND n.rowid>j.rowid)`).all(store.studentId) as { id: string; state: string; asset_id: string | null; error: string | null }[];
        const failed = rows.filter(r => r.state === 'failed' || r.state === 'interrupted').map(r => {
            let retryable = true;
            try { if (r.error) retryable = canRecover({ ...JSON.parse(r.error), stage: 'transcribe' }); } catch { retryable = false; }
            return { id: r.id, state: r.state, assetId: r.asset_id, retryable };
        });
        return { failed, processing: rows.filter(r => r.state === 'queued' || r.state === 'running').length };
    };
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
    r.use('/materials/answers', express.json({ limit: '512kb' }), express.urlencoded({ extended: false, limit: '512kb', parameterLimit: 400 }));
    r.use(express.json({ limit: '64kb' }), express.urlencoded({ extended: false, limit: '64kb', parameterLimit: 400 }));
    r.use((req, res, next) => {
        try {
            if (req.method === 'POST') {
                const origin = req.headers.origin;
                if (req.headers['sec-fetch-site'] === 'cross-site' || (origin && (origin === 'null' || new URL(origin).host !== req.headers.host)))
                    throw new MobileRequestError(403, 'forbidden', '请从自己的页面提交。');
                check(req);
            }
            next();
        }
        catch (e) {
            next(e);
        }
    });
    r.post('/materials/questions/:id/inclusion', (req,res,next)=>{
      try {
        const raw=req.body.included;if(![true,false,'true','false'].includes(raw))bad('请选择是否收录。');
        const wanted=raw===true||raw==='true';
        const saved=setQuestionIncluded(store,String(req.params.id),wanted,revision(req.body.expectedRevision));
        // Stay on the question and say what happened, instead of jumping back to the long list.
        if(json(req))res.json(saved);else res.redirect(303,`/s/materials/questions/${encodeURIComponent(String(req.params.id))}?${wanted?(saved.itemId?'included=1':'included=later'):'included=0'}`);
      }catch(error){next(error);}
    });
    // Batch inclusion: "本页 N 道全部收录" (allOf=<assetId>) or the ticked picks. Values are "<questionId>:<revision>".
    r.post('/materials/inclusions', (req,res,next)=>{
      try {
        const allOf=text(req.body.allOf);
        const values=allOf?list(req.body[`page_${allOf}`]).flatMap(v=>v.split(',')).filter(Boolean):list(req.body.pick);
        if(values.length>500)bad();
        const picks=values.map(v=>{const m=/^([A-Za-z0-9_-]{1,80}):([0-9]{1,9})$/.exec(v);if(!m)bad();return {questionId:m[1]!,revision:Number(m[2])};});
        const saved=picks.length?includeQuestions(store,picks):{included:0,skipped:0};
        if(json(req))res.json({ok:true,...saved});else res.redirect(303,`/s/materials?included=${saved.included}&skipped=${saved.skipped}`);
      }catch(error){next(error);}
    });
    r.get('/materials/session', (_req, res) => res.json({ draftNamespace, assetCount: assetCount() }));
    r.get('/capture', (req, res) => {
        const context: CaptureHints = {};
        const questionId = text(req.query.questionId);
        const attemptId = text(req.query.attemptId);
        // The Ionic app at /s/new is the single plain-capture surface now. A bare /s/capture — an old
        // bookmark, or a stale link — must not open a second uploader that races the app for the one
        // per-student upload slot; that collision is what turned uploads into 502「网络没连上」. Targeted
        // supplement links carry ?questionId= (补拍/补充), and the no-script fallback uses ?legacy=1;
        // both still render the SSR page. Everything else goes to the app.
        if (!questionId && !attemptId && text(req.query.legacy) !== '1') { res.redirect(303, '/s/new'); return; }
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
        sendHtml(res, MaterialCapturePage({ namespace: draftNamespace, count: assetCount(), uploadId: randomUUID(), context }));
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
        const all = sortQuestions(store, store.listQuestions());
        const questions = all.filter(q => !unplacedMaterial(q));
        const allAssets = store.db.prepare("SELECT id,json_extract(extraction_json,'$.document.subject') AS subject FROM material_asset WHERE owner_id=? ORDER BY created_at,rowid").all(store.studentId) as { id: string; subject: string | null }[];
        const photoNumbers = Object.fromEntries(allAssets.map((a, i) => [a.id, i + 1]));
        const unsupported = allAssets.flatMap(a => { const other = unsupportedSubject(a.subject); return other ? [{ assetId: a.id, subject: other }] : []; });
        const intents = inclusionIntents(store);
        const marks: Record<string, MaterialInclusionMark> = Object.fromEntries(questions.map(q => [q.id, intents.get(q.id) === false ? 'removed' : q.itemId ? 'included' : markedRight(q) ? 'correct' : 'pending']));
        const pending = notYetIncluded(store, questions, intents).map(g => ({ ...g, photo: photoNumbers[g.assetId] ?? 0 }));
        // Unplaced material is summarized per photo (in photo order), never guessed into a question.
        const unplacedByPhoto = new Map<string, MaterialUnplacedGroup>();
        for (const q of all.filter(unplacedMaterial)) for (const fragment of linkedFragments(store, q.id)) {
            const group = unplacedByPhoto.get(fragment.assetId) ?? { assetId: fragment.assetId, photo: photoNumbers[fragment.assetId] ?? 0, items: [] };
            group.items.push({ questionId: q.id, fragment });
            unplacedByPhoto.set(fragment.assetId, group);
        }
        const unplaced = [...unplacedByPhoto.values()].sort((a, b) => a.photo - b.photo).map(g => ({ ...g, items: g.items.sort((x, y) => (x.fragment.page ?? 0) - (y.fragment.page ?? 0) || x.fragment.order - y.fragment.order) }));
        const included = Number(req.query.included), skipped = Number(req.query.skipped) || 0, retried = Number(req.query.retried);
        const notice = Number.isSafeInteger(retried) && retried >= 0 && req.query.retried !== undefined ? { included: 0, skipped: 0, retried } : Number.isSafeInteger(included) && included >= 0 && req.query.included !== undefined ? { included, skipped: Number.isSafeInteger(skipped) && skipped >= 0 ? skipped : 0 } : null;
        sendHtml(res, MaterialsPage({ namespace: draftNamespace, questions, assets: assets(page), page, hasMore: (page + 1) * 8 < assetCount(), documents, changes, jobs: extractJobs().failed, processing: extractJobs().processing, assetCount: allAssets.length, photoNumbers, unsupported, pending, unplaced, marks, notice, revision: linkRevision(store) }));
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
    r.get('/materials/answers/imports', (req,res) => {const page=pageNumber(req.query.page);const imports=store.db.prepare('SELECT original_text,pending_json,created_at FROM material_answer_import WHERE owner_id=? ORDER BY rowid DESC LIMIT 20 OFFSET ?').all(store.studentId,page*20) as {original_text:string;pending_json:string;created_at:string}[];sendHtml(res,MaterialImportHistoryPage({imports,page}));});
    r.get('/materials/questions/:id/answers', (req,res) => {const q=store.getQuestion(text(req.params.id));if(!q)throw new MobileRequestError(404,'not_found','题目不存在。');const page=pageNumber(req.query.page);sendHtml(res,MaterialAnswerHistoryPage({questionId:q.id,history:answerHistory(store,q.id,page),page}));});
    r.get('/materials/questions/:id', (req, res) => {
        const q = store.getQuestion(text(req.params.id));
        if (!q)
            throw new MobileRequestError(404, 'not_found', '题目不存在。');
        const flag = text(req.query.included);
        const notice = flag === '1' && q.itemId ? '已收进错题本。可以接着看下一题，也可以去错题本看看。' : flag === 'later' ? '已记下要收录，题目补齐后会进入错题本。' : flag === '0' ? '已移出错题本，原材料仍保留。' : null;
        sendHtml(res, MaterialQuestionPage({ namespace: draftNamespace, notice, question: q, included: inclusionIntent(store,q.id), legacy: !!(q.itemId&&store.db.prepare('SELECT 1 FROM mobile_item_link WHERE item_id=?').get(q.itemId)), gradeJobs: store.db.prepare("SELECT id,state,error FROM material_job WHERE owner_id=? AND question_id=? AND kind='grade' ORDER BY rowid DESC LIMIT 20").all(store.studentId,q.id) as {id:string;state:string;error:string|null}[], answerJobs: store.db.prepare("SELECT id,state,error FROM material_job WHERE owner_id=? AND question_id=? AND kind='answer' ORDER BY rowid DESC LIMIT 20").all(store.studentId,q.id) as {id:string;state:string;error:string|null}[], selectedAnswerIds: selectedAnswerIds(store,q.id), questions: sortQuestions(store, store.listQuestions().filter(o => !unplacedMaterial(o))), unplaced: unplacedMaterial(q), revision: linkRevision(store),
            materials: linkedFragments(store, q.id).sort((a, b) => (a.page ?? 0) - (b.page ?? 0) || a.order - b.order || a.fragmentId.localeCompare(b.fragmentId)) }));
    });
    r.get('/materials/fragments/:id/crop', async (req,res)=>{
        const id=text(req.params.id);
        const row=store.db.prepare('SELECT revision FROM material_fragment WHERE owner_id=? AND id=? ORDER BY revision DESC LIMIT 1').get(store.studentId,id) as {revision:number}|undefined;
        const revision=req.query.revision===undefined?row?.revision:Number(req.query.revision);
        if(!row||!Number.isSafeInteger(revision)||!store.db.prepare('SELECT 1 FROM material_fragment WHERE owner_id=? AND id=? AND revision=?').get(store.studentId,id,revision!))throw new MobileRequestError(404,'not_found','材料片段版本不存在。');
        res.type('image/jpeg').send(await readFragmentImage(store,id,revision!));
    });
    r.get('/materials/assets/:id/image', async (req,res)=>{
        const id=text(req.params.id),row=store.db.prepare('SELECT s.content_hash FROM material_asset a JOIN source_asset s ON s.id=a.source_asset_id WHERE a.owner_id=? AND a.id=?').get(store.studentId,id) as {content_hash:string}|undefined;
        if(!row)throw new MobileRequestError(404,'not_found','材料不存在。');
        const bytes=readSourceBytes(store,{assetId:id,sourceHash:row.content_hash}),metadata=await sharp(bytes,{limitInputPixels:40_000_000}).metadata();
        res.type(metadata.format==='png'?'image/png':metadata.format==='webp'?'image/webp':metadata.format==='heif'?'image/heic':'image/jpeg').send(bytes);
    });
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
    r.post('/materials/grades', (req,res) => {
        if(('documentId' in req.body)===('questionIds' in req.body))bad();
        let attemptByQuestion:Record<string,string>|undefined;
        if(req.body.attemptByQuestion!==undefined){if(!req.body.attemptByQuestion||typeof req.body.attemptByQuestion!=='object'||Array.isArray(req.body.attemptByQuestion))bad();attemptByQuestion=req.body.attemptByQuestion;}
        if(req.body.attemptId){const ids=list(req.body.questionIds);if(ids.length!==1||attemptByQuestion)bad();attemptByQuestion={[ids[0]!]:text(req.body.attemptId)};}
        const action=requestGrades(store,jobs,{...('documentId' in req.body?{requestId:text(req.body.requestId),documentId:text(req.body.documentId)}:{requestId:text(req.body.requestId),questionIds:list(req.body.questionIds)}),...(attemptByQuestion?{attemptByQuestion}:{})});
        const single='questionIds' in req.body&&list(req.body.questionIds).length===1?list(req.body.questionIds)[0]:undefined;
        if(json(req))res.json({ok:true,...action});else sendHtml(res,MaterialGradeActionPage({namespace:draftNamespace,action,questionId:single}));
    });
    r.post('/materials/answers/manual', (req,res) => result(req,res,{ok:true,answer:saveManualAnswer(store,{questionId:text(req.body.questionId),subpart:text(req.body.subpart)||null,text:text(req.body.text),claimedSource:text(req.body.claimedSource)||null,expectedRevision:revision(req.body.expectedRevision)})}));
    r.post('/materials/answers/import', (req,res) => { const imported=importAnswerText(store,text(req.body.documentId),text(req.body.text)); if(json(req))res.json({ok:true,...imported});else sendHtml(res, MaterialAnswerActionPage({namespace:draftNamespace,imported})); });
    r.post('/materials/answers/generate', (req,res) => { if(('documentId' in req.body)===('questionIds' in req.body))bad(); const action=requestAnswers(store,jobs,'documentId' in req.body?{requestId:text(req.body.requestId),documentId:text(req.body.documentId)}:{requestId:text(req.body.requestId),questionIds:list(req.body.questionIds)}); const single='questionIds' in req.body&&list(req.body.questionIds).length===1?list(req.body.questionIds)[0]:undefined; if(json(req))res.json({ok:true,...action});else sendHtml(res,MaterialAnswerActionPage({namespace:draftNamespace,action,questionId:single})); });
    r.post('/materials/answers/basis', (req,res) => {selectAnswerBasis(store,text(req.body.questionId),list(req.body.answerIds),revision(req.body.expectedRevision));result(req,res,{ok:true});});
    r.post('/materials/links', (req, res) => { const input = { fragmentIds: list(req.body.fragmentIds), questionId: text(req.body.questionId), expectedRevision: revision(req.body.expectedRevision) }; const change = req.body.newAttempt === '1' || req.body.newAttempt === true ? relinkNewAttempt(store, input) : relink(store, { ...input, target: { questionId: input.questionId, attemptId: text(req.body.attemptId) || null } }); result(req, res, { ok: true, change }); });
    r.post('/materials/links/:id/undo', (req, res) => result(req, res, { ok: true, change: undoLink(store, text(req.params.id), revision(req.body.expectedRevision)) }));
    // One tap re-extracts every failed photo. Each job gets a request key derived from the form's key, so a resubmitted form is idempotent.
    r.post('/materials/jobs/retry-all', (req, res) => {
        const requestId = text(req.body.requestId);
        if (!UUID.test(requestId))
            bad();
        let retried = 0;
        for (const job of extractJobs().failed.filter(j => j.retryable !== false)) {
            const h = createHash('sha256').update(`${requestId}:${job.id}`).digest('hex');
            const derived = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${(8 + (parseInt(h[16]!, 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
            try { jobs.retry(job.id, derived); retried++; }
            catch (error) { if (!(error instanceof MobileRequestError) || error.code !== 'not_retryable') throw error; }
        }
        if (json(req)) res.json({ ok: true, retried });
        else res.redirect(303, `/s/materials?retried=${retried}`);
    });
    r.post('/materials/jobs/:id/retry', (req, res) => {
        if (!UUID.test(text(req.body.requestId)))
            bad();
        result(req, res, { ok: true, job: jobs.retry(text(req.params.id), req.body.requestId) });
    });
    r.use(((err: unknown, req: Request, res: Response, _next: express.NextFunction) => {
        const status = err instanceof MobileRequestError ? err.status : (err as {type?:string})?.type === 'entity.too.large' ? 413 : err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE' ? 413 : err instanceof SyntaxError || err instanceof multer.MulterError ? 400 : 500;
        const message = err instanceof MobileRequestError ? err.message : status === 413 ? '照片超过 15 MB，请换一张。' : status === 400 ? '照片或填写的内容不完整，请重选后再试。' : '暂时没保存好，请稍后再试。';
        res.status(status);
        if (json(req))
            res.json({ error: { code: err instanceof MobileRequestError ? err.code : 'invalid_request', message } });
        else
            res.type('html').send(`<!doctype html><html lang="zh"><meta name="viewport" content="width=device-width,initial-scale=1"><p>${message}</p><a href="/s/capture">返回拍照</a> · <a href="/s/materials">刷新材料</a></html>`);
    }) as express.ErrorRequestHandler);
    return r;
}
