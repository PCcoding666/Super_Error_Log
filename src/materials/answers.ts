import { createHash } from 'node:crypto';
import { newId } from '../db/connection.js';
import { MobileRequestError } from '../mobile/service.js';
import type { BatchAction, BatchRequest, Fragment, ReferenceAnswer } from './contracts.js';
import type { MaterialStore } from './store.js';
import type { MaterialJobs } from './jobs.js';
import type { MaterialUploads } from './uploads.js';
import { answerBasis, currentLink, dependenciesCurrent, effectiveFragmentCheck, readQuestion, type MaterialBasis } from './queries.js';
import { createMaterialActionProvider, validateMaterialAnswer, type MaterialAnswerProvider, type MaterialProviderOptions } from './provider.js';
const norm = (s: string) => s.replace(/\s+/gu, '');
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const invalid = (message = '填写的答案或范围不完整。'): never => {
    throw new MobileRequestError(400, 'invalid_request', message);
};
function requireQuestion(store: MaterialStore, id: string) {
    const q = readQuestion(store, id);
    if (!q)
        throw new MobileRequestError(404, 'not_found', '题目不存在。');
    return q;
}
function cas(store: MaterialStore, id: string, revision: number) {
    const q = requireQuestion(store, id);
    if (!Number.isSafeInteger(revision) || q.revision !== revision)
        throw new MobileRequestError(409, 'conflict', '题目材料已变化，请刷新后再试。');
    return q;
}
function validText(text: string, claimed: string | null) {
    if (typeof text !== 'string' || !text.trim() || text.length > 40000 || claimed !== null && (typeof claimed !== 'string' || claimed.length > 200))
        invalid('答案需要1–40000字，来源说明最多200字。');
}
function scope(s: string | null) {
    if (s !== null && (typeof s !== 'string' || !s.trim() || s.length > 64 || /[\r\n]/.test(s)))
        invalid();
}
export function answersConflict(answers: ReferenceAnswer[]): boolean {
    const valid = answers.filter(a => !a.stale);
    return valid.some(a => valid.some(b => a.id !== b.id && (a.subpart === b.subpart || a.subpart === null || b.subpart === null) && norm(a.text) !== norm(b.text)));
}
/** Empty means an explicit choice is needed, or no current reference exists. */
export function selectedAnswerIds(store: MaterialStore, questionId: string): string[] {
    const q = requireQuestion(store, questionId);
    const selection = store.db.prepare('SELECT answers_json FROM material_answer_selection WHERE owner_id=? AND question_id=?').get(store.studentId, q.id) as {
        answers_json: string;
    } | undefined;
    if (selection) {
        const saved = JSON.parse(selection.answers_json) as {
            id: string;
            revision: number;
        }[];
        if (saved.every(x => q.answers.some(a => a.id === x.id && a.revision === x.revision && !a.stale)))
            return saved.map(x => x.id);
        return [];
    }
    if (answersConflict(q.answers))
        return [];
    const provided = q.answers.filter(a => !a.stale && a.source !== 'ai');
    const candidates = provided.length ? provided : q.answers.filter(a => !a.stale);
    const scopes = new Map<string | null, ReferenceAnswer>();
    for (const a of candidates)
        if (!scopes.has(a.subpart))
            scopes.set(a.subpart, a);
    return [...scopes.values()].map(a => a.id).sort();
}
function invalidateGrades(store: MaterialStore, id: string, activeJobId?: string) {
    store.db.prepare('UPDATE material_grade SET stale=1 WHERE owner_id=? AND attempt_id IN (SELECT id FROM material_attempt WHERE owner_id=? AND question_id=?)').run(store.studentId, store.studentId, id);
    store.db.prepare("UPDATE material_job SET state='stale' WHERE owner_id=? AND question_id=? AND kind='grade' AND state IN ('queued','running','failed','interrupted') AND id!=?").run(store.studentId, id, activeJobId ?? '');
}
function selectionSignature(store: MaterialStore, id: string) {
    const q = requireQuestion(store, id);
    return JSON.stringify(selectedAnswerIds(store, id).map(id => {
        const a = q.answers.find(a => a.id === id)!;
        return { id, revision: a.revision };
    }));
}
function changed(store: MaterialStore, id: string, before: string, activeJobId?: string) {
    store.db.prepare('UPDATE material_question SET revision=revision+1 WHERE owner_id=? AND id=?').run(store.studentId, id);
    if (before !== selectionSignature(store, id))
        invalidateGrades(store, id, activeJobId);
}
function insert(store: MaterialStore, answer: ReferenceAnswer, dependencies: unknown) {
    store.db.prepare('INSERT INTO material_answer(id,revision,owner_id,question_id,source,basis_key,dependencies_json,content_json,stale) VALUES (?,?,?,?,?,?,?,?,?)').run(answer.id, answer.revision, store.studentId, answer.questionId, answer.source, answer.basisKey, JSON.stringify(dependencies), JSON.stringify(answer), Number(answer.stale));
}
export function saveManualAnswer(store: MaterialStore, input: {
    questionId: string;
    subpart: string | null;
    text: string;
    claimedSource: string | null;
    expectedRevision: number;
}): ReferenceAnswer {
    validText(input.text, input.claimedSource);
    scope(input.subpart);
    return store.transaction(() => {
        const q = cas(store, input.questionId, input.expectedRevision);
        const before = selectionSignature(store, q.id);
        const old = q.answers.find(a => a.source === 'manual' && a.subpart === input.subpart);
        if (old && !old.stale && norm(old.text) === norm(input.text) && old.claimedSource === input.claimedSource)
            return old;
        const basis = answerBasis(store, q.id);
        const a: ReferenceAnswer = { id: old?.id ?? newId('man'), questionId: q.id, subpart: input.subpart, revision: (old?.revision ?? 0) + 1, source: 'manual', text: input.text, claimedSource: input.claimedSource, fragmentIds: [], basisKey: basis.basisKey, stale: false, run: null };
        insert(store, a, basis.dependencies);
        changed(store, q.id, before);
        return a;
    });
}
export function selectAnswerBasis(store: MaterialStore, questionId: string, answerIds: string[], expectedRevision: number): void {
    store.transaction(() => {
        const q = cas(store, questionId, expectedRevision);
        if (!Array.isArray(answerIds) || !answerIds.length || answerIds.length > 128 || new Set(answerIds).size !== answerIds.length)
            invalid();
        const answers = answerIds.map(id => q.answers.find(a => a.id === id && !a.stale));
        if (answers.some(a => !a) || answersConflict(answers as ReferenceAnswer[]))
            invalid('请选择当前有效且互不冲突的答案。');
        const before = selectionSignature(store, q.id);
        store.db.prepare('INSERT INTO material_answer_selection(owner_id,question_id,answers_json) VALUES (?,?,?) ON CONFLICT(owner_id,question_id) DO UPDATE SET answers_json=excluded.answers_json').run(store.studentId, q.id, JSON.stringify(answers.map(a => ({ id: a!.id, revision: a!.revision }))));
        changed(store, q.id, before);
    });
}
/** Called only by mutations/backfill; GET/readQuestion never materializes answers. */
export function projectImportedFragment(store: MaterialStore, fragmentId: string): void {
    const link = currentLink(store, fragmentId);
    const rows = store.db.prepare("SELECT a.* FROM material_answer a WHERE owner_id=? AND source='imported' AND NOT EXISTS(SELECT 1 FROM material_answer n WHERE n.owner_id=a.owner_id AND n.id=a.id AND n.revision>a.revision) AND EXISTS(SELECT 1 FROM json_each(a.content_json,'$.fragmentIds') WHERE value=?)").all(store.studentId, fragmentId) as {
        id: string;
        revision: number;
        question_id: string;
        content_json: string;
        stale: number;
    }[];
    const f = link ? store.db.prepare('SELECT content_json FROM material_fragment WHERE owner_id=? AND id=? AND revision=?').get(store.studentId, fragmentId, link.fragment_revision) as {
        content_json: string;
    } | undefined : undefined;
    const fragment = f ? JSON.parse(f.content_json) as Fragment : undefined;
    const target = fragment?.role === 'reference_answer' && fragment.text.trim() ? link?.question_id : null;
    for (const row of rows)
        if (row.question_id !== target && !row.stale) {
            const before = selectionSignature(store, row.question_id);
            store.db.prepare('UPDATE material_answer SET stale=1 WHERE owner_id=? AND id=?').run(store.studentId, row.id);
            changed(store, row.question_id, before);
        }
    if (!target || !fragment)
        return;
    const before = selectionSignature(store, target);
    const old = rows.find(r => r.question_id === target);
    const key = hash({ fragment, linkRevision: link!.revision, questionId: target });
    if (old && (JSON.parse(old.content_json) as ReferenceAnswer).basisKey === key)
        return;
    const a: ReferenceAnswer = { id: old?.id ?? newId('man'), revision: (old?.revision ?? 0) + 1, questionId: target, subpart: fragment.subpart, source: 'imported', text: fragment.text, claimedSource: null, fragmentIds: [fragmentId], basisKey: key, stale: fragment.check !== 'passed' || fragment.uncertainties.length > 0, run: null };
    insert(store, a, { version: 2, kind: 'imported', fragmentId, revision: fragment.revision, linkRevision: link!.revision });
    changed(store, target, before);
}
export function backfillImportedAnswers(store: MaterialStore): void {
    let cursor = 0;
    for (;;) {
        const rows = store.db.prepare('SELECT rowid AS cursor,fragment_id FROM material_link_event WHERE owner_id=? AND rowid>? ORDER BY rowid LIMIT 200').all(store.studentId, cursor) as {
            cursor: number;
            fragment_id: string;
        }[];
        if (!rows.length)
            return;
        store.transaction(() => {
            for (const row of rows)
                projectImportedFragment(store, row.fragment_id);
        });
        cursor = rows.at(-1)!.cursor;
    }
}
export function importAnswerText(store: MaterialStore, documentId: string, text: string): {
    saved: ReferenceAnswer[];
    pending: {
        number: string;
        text: string;
    }[];
} {
    validText(text, null);
    if (!store.db.prepare('SELECT 1 FROM material_document WHERE owner_id=? AND id=?').get(store.studentId, documentId))
        throw new MobileRequestError(404, 'not_found', '试卷不存在。');
    return store.transaction(() => {
        const questions = store.listQuestions().filter(q => q.documentId === documentId);
        const saved: ReferenceAnswer[] = [];
        const pending: {
            number: string;
            text: string;
        }[] = [];
        const importId = newId('mai');
        store.db.prepare('INSERT INTO material_answer_import(id,owner_id,document_id,original_text,pending_json) VALUES (?,?,?,?,?)').run(importId, store.studentId, documentId, text, '[]');
        const chunks = text.split(/\r?\n/);
        for (const line of chunks) {
            if (!line.trim())
                continue;
            const m = /^\s*([^\s:：()（）]+)(?:[（(]([^()（）]+)[)）])?\s*[:：]\s*(.+)$/.exec(line) ?? /^\s*(\d+)(?:[（(]([^()（）]+)[)）])?[.．、]\s+(.+)$/.exec(line);
            if (!m) {
                pending.push({ number: '', text: line });
                continue;
            }
            const number = m[1]!, subpart = m[2] ?? null;
            const matches = questions.filter(q => q.number === number && q.stem.some(f => f.role === 'question' && f.subpart === subpart));
            if (matches.length !== 1) {
                pending.push({ number: subpart ? `${number}(${subpart})` : number, text: line });
                continue;
            }
            const q = requireQuestion(store, matches[0]!.id), before = selectionSignature(store, q.id);
            const old = q.answers.find(a => a.source === 'imported' && !a.fragmentIds.length && a.subpart === subpart && !a.stale && norm(a.text) === norm(m[3]!));
            if (old) {
                saved.push(old);
                continue;
            }
            const basis = answerBasis(store, q.id);
            const answer: ReferenceAnswer = { id: newId('man'), questionId: q.id, subpart, revision: 1, source: 'imported', text: m[3]!, claimedSource: null, fragmentIds: [], basisKey: basis.basisKey, stale: false, run: null };
            insert(store, answer, basis.dependencies);
            store.db.prepare('INSERT INTO material_answer_origin(owner_id,answer_id,revision,import_id) VALUES (?,?,?,?)').run(store.studentId, answer.id, answer.revision, importId);
            changed(store, q.id, before);
            saved.push(answer);
        }
        store.db.prepare('UPDATE material_answer_import SET pending_json=? WHERE owner_id=? AND id=?').run(JSON.stringify(pending), store.studentId, importId);
        return { saved, pending };
    });
}
export function answerEligibility(store: MaterialStore, questionId: string): string | null {
    const q = requireQuestion(store, questionId);
    if (q.missing.includes('stem'))
        return '缺少题干';
    if (q.missing.includes('diagram'))
        return '缺少所需图形';
    if (q.unresolved.length)
        return '材料关联待确定';
    if (q.stem.some(f => effectiveFragmentCheck(store, q.id, f.fragmentId) !== 'passed'))
        return '题干或图形尚未通过检查';
    if (q.stem.length > 32 || q.stem.reduce((n, f) => n + f.text.length, 0) > 40000 || q.stem.filter(f => f.role === 'diagram').length > 8)
        return '题目材料超过单次处理上限，请拆分材料';
    return null;
}
export function requestAnswers(store: MaterialStore, jobs: MaterialJobs, input: BatchRequest): BatchAction {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId))
        invalid('请求键必须是 UUID。');
    if (('documentId' in input) === ('questionIds' in input))
        invalid();
    let ids: string[];
    if ('documentId' in input) {
        if (!store.db.prepare('SELECT 1 FROM material_document WHERE owner_id=? AND id=?').get(store.studentId, input.documentId!))
            throw new MobileRequestError(404, 'not_found', '试卷不存在。');
        ids = store.listQuestions().filter(q => q.documentId === input.documentId).map(q => q.id);
    }
    else {
        if (!Array.isArray(input.questionIds) || !input.questionIds.length || input.questionIds.length > 200)
            invalid();
        ids = input.questionIds.map(id => requireQuestion(store, id).id);
    }
    ids = [...new Set(ids)].sort();
    if (ids.length > 200)
        invalid('每次最多处理200道题。');
    const bases = ids.map(id => ({ id, ...answerBasis(store, id) }));
    const fingerprint = hash({ target: 'documentId' in input ? { documentId: input.documentId } : { questionIds: ids }, bases });
    const prior = store.db.prepare("SELECT fingerprint,result_json FROM material_action_batch WHERE owner_id=? AND kind='answer' AND request_id=?").get(store.studentId, input.requestId) as {
        fingerprint: string;
        result_json: string;
    } | undefined;
    if (prior && prior.fingerprint !== fingerprint)
        throw new MobileRequestError(409, 'idempotency_conflict', '请求键已用于不同题目或材料。');
    const result: BatchAction = prior ? JSON.parse(prior.result_json) : { jobs: [], skipped: [] };
    if (!prior)
        store.db.prepare("INSERT INTO material_action_batch(owner_id,kind,request_id,fingerprint,result_json) VALUES (?,'answer',?,?,?)").run(store.studentId, input.requestId, fingerprint, JSON.stringify(result));
    const save = (next: BatchAction) => store.db.prepare("UPDATE material_action_batch SET result_json=? WHERE owner_id=? AND kind='answer' AND request_id=?").run(JSON.stringify(next), store.studentId, input.requestId);
    const accounted = new Set([...result.skipped.map(x => x.questionId), ...result.jobs.map(j => (store.db.prepare('SELECT question_id FROM material_job WHERE owner_id=? AND id=?').get(store.studentId, j.id) as {
            question_id: string;
        }).question_id)]);
    for (const basis of bases) {
        if (accounted.has(basis.id))
            continue;
        const reason = answerEligibility(store, basis.id);
        if (reason) {
            const next = { ...result, skipped: [...result.skipped, { questionId: basis.id, reason }] };
            save(next);
            result.skipped = next.skipped;
            continue;
        }
        try {
            const job = jobs.enqueue('answer', basis.id, input.requestId, basis.basisKey, { input: { questionId: basis.id, stem: requireQuestion(store, basis.id).stem }, dependencies: basis.dependencies, persistJob: job => save({ ...result, jobs: [...result.jobs, job] }) });
            result.jobs.push(job);
        }
        catch (error) {
            if (error instanceof MobileRequestError && [429, 503].includes(error.status)) {
                const next = { ...result, skipped: [...result.skipped, { questionId: basis.id, reason: error.message }] };
                save(next);
                result.skipped = next.skipped;
            }
            else
                throw error;
        }
    }
    result.jobs = result.jobs.map(j => jobs.get(j.id) ?? j);
    return result;
}
/** Reusable inline stage for grading: bind request() to the running parent job; never queue/wait for a child. */
export async function generateAnswerForBasis(store: MaterialStore, provider: MaterialAnswerProvider, input: {
    operationId: string;
    questionId: string;
    stem: Fragment[];
    basis: MaterialBasis;
    parentJobId?: string;
}, signal: AbortSignal, persist?: (answer: ReferenceAnswer) => void): Promise<ReferenceAnswer> {
    const snapshot = structuredClone(input);
    if (!snapshot.operationId)
        throw new Error('answer operation ID required');
    const checkParent = () => {
        if (snapshot.parentJobId && !store.db.prepare("SELECT 1 FROM material_job WHERE owner_id=? AND id=? AND question_id=? AND kind='grade' AND state='running'").get(store.studentId, snapshot.parentJobId, snapshot.questionId))
            throw new MobileRequestError(409, 'stale_basis', '批改任务已变化，请重新发起。');
    };
    checkParent();
    const existing = store.db.prepare('SELECT o.basis_key,a.content_json,a.stale FROM material_answer_operation o JOIN material_answer a ON a.owner_id=o.owner_id AND a.id=o.answer_id AND a.revision=o.revision WHERE o.owner_id=? AND o.operation_id=?').get(store.studentId, snapshot.operationId) as {
        basis_key: string;
        content_json: string;
        stale: number;
    } | undefined;
    if (existing) {
        if (existing.basis_key !== snapshot.basis.basisKey)
            throw new MobileRequestError(409, 'idempotency_conflict', '答案操作已用于不同材料。');
        const answer = { ...JSON.parse(existing.content_json), stale: !!existing.stale } as ReferenceAnswer;
        store.transaction(() => {
            checkParent();
            persist?.(answer);
        });
        return answer;
    }
    if (!dependenciesCurrent(store, snapshot.basis.basisKey, snapshot.basis.dependencies))
        throw new MobileRequestError(409, 'stale_basis', '题目材料已变化。');
    const output = validateMaterialAnswer(await provider.answer({ questionId: snapshot.questionId, basisKey: snapshot.basis.basisKey, fragments: snapshot.stem }, signal), snapshot.stem);
    signal.throwIfAborted();
    return store.transaction(() => {
        checkParent();
        const before = selectionSignature(store, snapshot.questionId);
        const stale = !dependenciesCurrent(store, snapshot.basis.basisKey, snapshot.basis.dependencies);
        const q = requireQuestion(store, snapshot.questionId);
        const old = q.answers.find(a => a.source === 'ai' && a.subpart === null && !a.stale) ?? q.answers.find(a => a.source === 'ai' && a.subpart === null);
        const a: ReferenceAnswer = { id: stale ? newId('man') : old?.id ?? newId('man'), questionId: snapshot.questionId, subpart: null, revision: stale ? 1 : (old?.revision ?? 0) + 1, source: 'ai', text: output.text, claimedSource: null, fragmentIds: output.fragmentIds, basisKey: snapshot.basis.basisKey, stale, run: output.run };
        insert(store, a, snapshot.basis.dependencies);
        store.db.prepare('INSERT INTO material_answer_operation(owner_id,operation_id,basis_key,answer_id,revision) VALUES (?,?,?,?,?)').run(store.studentId, snapshot.operationId, snapshot.basis.basisKey, a.id, a.revision);
        changed(store, q.id, before, snapshot.parentJobId);
        persist?.(a);
        return a;
    });
}
export async function generateAnswer(store: MaterialStore, provider: MaterialAnswerProvider, jobId: string, signal: AbortSignal): Promise<void> {
    const row = store.db.prepare("SELECT question_id,basis_key,dependencies_json,input_json FROM material_job WHERE owner_id=? AND id=? AND kind='answer'").get(store.studentId, jobId) as {
        question_id: string;
        basis_key: string;
        dependencies_json: string;
        input_json: string;
    } | undefined;
    if (!row)
        throw new Error('answer job not found');
    const basis = { basisKey: row.basis_key, dependencies: JSON.parse(row.dependencies_json) };
    if (!dependenciesCurrent(store, basis.basisKey, basis.dependencies)) {
        store.db.prepare("UPDATE material_job SET state='stale' WHERE owner_id=? AND id=?").run(store.studentId, jobId);
        return;
    }
    await generateAnswerForBasis(store, provider, { operationId: jobId, questionId: row.question_id, stem: JSON.parse(row.input_json).stem, basis }, signal, answer => {
        store.db.prepare("UPDATE material_job SET result_json=?,state=CASE WHEN ? THEN 'stale' ELSE state END WHERE owner_id=? AND id=?").run(JSON.stringify({ answerId: answer.id, revision: answer.revision }), Number(answer.stale), store.studentId, jobId);
    });
}
export function registerMaterialAnswers(store: MaterialStore, jobs: MaterialJobs, uploads: MaterialUploads, options: MaterialProviderOptions): void {
    backfillImportedAnswers(store);
    jobs.register('answer', async (jobId, signal) => {
        const provider = createMaterialActionProvider(options, { request: (key, invoke) => jobs.request(jobId, key, invoke), source: assetId => uploads.source(assetId) });
        await generateAnswer(store, provider, jobId, signal);
    });
}
