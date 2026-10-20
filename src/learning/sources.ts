import { ensureStudentProfile } from '../services/studentService.js';
import { getDb } from '../db/connection.js';
import { getEvidence } from '../services/evidenceService.js';
import { MaterialStore } from '../materials/store.js';
import { effectiveQuestionStem, readQuestion } from '../materials/queries.js';
import { inclusionIntent, materialPracticeEligible, questionIncluded, learningObservationFragments } from '../materials/learning.js';
import { createHash } from 'node:crypto';
import { selectedAnswerIds } from '../materials/answers.js';
import { currentLink, latestFragments, diagramCovers } from '../materials/queries.js';
import type { Fragment, SourceRegion, ReferenceAnswer } from '../materials/contracts.js';
import { validateEvidence, validateLearningContext } from '../ai/evidence.js';
import { SUBJECTS, type Subject } from '../domain/types.js';
import type { LearningSource, LearningContext, LearningCard, LearningScope } from './contracts.js';

export function getLearningSource(itemId:string):LearningSource|null {
 const db=getDb();
 if(!db.prepare('SELECT 1 FROM error_item WHERE id=? AND student_id=?').get(itemId,ensureStudentProfile().id))return null;
 const legacy=db.prepare('SELECT job_id FROM mobile_item_link WHERE item_id=?').get(itemId) as {job_id:string}|undefined;
 if(legacy)return {kind:'legacy',jobId:legacy.job_id};
 const material=db.prepare(`SELECT l.question_id FROM material_item_link l JOIN error_item i ON i.id=l.item_id AND i.student_id=l.owner_id
 WHERE l.item_id=? AND NOT EXISTS (SELECT 1 FROM material_legacy_map m WHERE m.owner_id=l.owner_id AND m.source_kind='error_item' AND m.source_key=l.item_id)`).get(itemId) as {question_id:string}|undefined;
 return material?{kind:'material',questionId:material.question_id}:null;
}
export function materialStoreForItem(itemId:string):MaterialStore|null {
 const row=getDb().prepare('SELECT owner_id FROM material_item_link WHERE item_id=? AND owner_id=?').get(itemId,ensureStudentProfile().id) as {owner_id:string}|undefined;
 return row?new MaterialStore(getDb(),row.owner_id):null;
}
export function getLearningContext(itemId:string):{revision:number;context:LearningContext}|null {
 const source=getLearningSource(itemId);if(!source)return null;
 if(source.kind==='legacy'){const e=getEvidence(itemId);return e?{revision:e.revision,context:validateLearningContext(e.content)}:null;}
 const store=materialStoreForItem(itemId)!,q=readQuestion(store,source.questionId);if(!q||q.missing.includes('stem')||!SUBJECTS.includes(q.subject as Subject))return null;
 const stem=effectiveQuestionStem(store,q.id);
 const fragments=learningObservationFragments(store,q.id);
 const context:LearningContext={questionNumber:q.number??'未标号',questionText:stem.filter(f=>f.role==='question').map(f=>f.text).join('\n\n'),
  subject:q.subject as Subject,chapter:'',knowledgeTags:q.tags,questionType:'',requiresDiagram:stem.some(f=>f.requiresDiagram),
  observations:fragments.filter(f=>f.text.trim()).map(f=>({id:f.fragmentId,kind:f.role==='teacher_mark'?'teacher_note':f.role==='student_work'||f.role==='correction'||f.role==='reference_answer'?f.role:'unknown',text:f.text,regionId:null,confidence:f.check==='passed'?1:0})),
  uncertainties:[...new Set([...q.unresolved,...q.missing.filter(m=>m!=='work'),...[...stem,...fragments].flatMap(f=>f.uncertainties)])]};
 return {revision:q.revision,context:validateLearningContext(context)};
}
export function learningIncluded(itemId:string):boolean {
 const source=getLearningSource(itemId);if(!source)return false;
 const store=materialStoreForItem(itemId);
 if(source.kind==='legacy'){
  if(!store)return true;
  const link=store.db.prepare('SELECT question_id FROM material_item_link WHERE owner_id=? AND item_id=?').get(store.studentId,itemId) as {question_id:string};
  return inclusionIntent(store,link.question_id)!==false;
 }
 return !!store&&questionIncluded(store,source.questionId);
}
export function learningEligible(itemId:string):boolean {
 const source=getLearningSource(itemId);if(!source||!learningIncluded(itemId))return false;
 return source.kind==='legacy'||materialPracticeEligible(materialStoreForItem(itemId)!,source.questionId);
}
export function learningPacketAllowed(id:string,scope:LearningScope):boolean {
 const rows=getDb().prepare('SELECT item_id FROM review_packet_item WHERE packet_id=?').all(id) as {item_id:string}[];
 return rows.length>0&&rows.every(r=>{const s=getLearningSource(r.item_id);return s&&(scope==='all'||s.kind==='legacy');});
}
export function learningCard(itemId:string):LearningCard|null {
 const source=getLearningSource(itemId);if(!source)return null;
 const row=getDb().prepare('SELECT * FROM error_item WHERE id=?').get(itemId) as {id:string;short_id:string|null;subject:string|null;knowledge_tags:string;text_excerpt:string|null;status:LearningCard['status']};
 let low=false;
 if(source.kind==='legacy')low=(getDb().prepare('SELECT confidence_badge FROM evidence_record WHERE item_id=?').get(itemId) as {confidence_badge:string}|undefined)?.confidence_badge==='low';
 else {const store=materialStoreForItem(itemId)!;const q=readQuestion(store,source.questionId)!;low=q.missing.includes('stem')||q.missing.includes('diagram')||!SUBJECTS.includes(q.subject as Subject)||q.unresolved.length>0||effectiveQuestionStem(store,q.id).some(f=>f.check!=='passed'||f.uncertainties.length);}
 return {id:row.id,shortId:row.short_id,subject:row.subject,knowledgeTags:JSON.parse(row.knowledge_tags),questionExcerpt:row.text_excerpt,badge:low?'low':'ok',status:row.status,cropUrl:source.kind==='legacy'?`/v2/items/${itemId}/crop`:`/s/img/item/${itemId}`,source};
}
export function legacyCard<T extends LearningCard>(card:T):Omit<T,'source'> & {jobId:string} {
 if(card.source.kind!=='legacy')throw new Error('legacy source required');const {source,...rest}=card;return {...rest,jobId:source.jobId};
}

// Print dependencies are separate from learning text: every image retains its own
// real source and every selected answer retains its exact persisted version.
export interface LearningPrintInput {
    basisKey: string;
    context: LearningContext;
    questionRegions: SourceRegion[];
    diagramRegions: SourceRegion[];
    redactRegions: SourceRegion[];
    answers: ReferenceAnswer[];
    badge: 'ok' | 'low';
}
const regionOf = (f: SourceRegion): SourceRegion => ({ assetId: f.assetId, fragmentId: f.fragmentId, revision: f.revision, box: f.box, sourceHash: f.sourceHash });
const printOrder = (a: Fragment, b: Fragment) => (a.page ?? 0) - (b.page ?? 0) || a.assetId.localeCompare(b.assetId) || a.order - b.order || a.fragmentId.localeCompare(b.fragmentId);
const redactRoles = new Set(['student_work', 'correction', 'teacher_mark', 'reference_answer', 'unknown']);
function mappedPrintQuestion(store: MaterialStore, itemId: string) {
    const link = store.db.prepare('SELECT question_id FROM material_item_link WHERE owner_id=? AND item_id=?').get(store.studentId, itemId) as {
        question_id: string;
    } | undefined;
    return link ? readQuestion(store, link.question_id) : null;
}
function explicitPrintSelection(store: MaterialStore, questionId: string): boolean {
    return !!store.db.prepare('SELECT 1 FROM material_answer_selection WHERE owner_id=? AND question_id=?').get(store.studentId, questionId);
}
/** A pinned migrated reference remains that exact record. Original Evidence may
 * have advanced before its material projection; never silently reinterpret the pin. */
function legacySelectionMatches(store: MaterialStore, itemId: string, answer: ReferenceAnswer): boolean {
    const evidence = getEvidence(itemId)?.content;
    if (!evidence)
        return false;
    const texts: string[] = [];
    for (const id of answer.fragmentIds) {
        const first = store.db.prepare('SELECT basis_json FROM material_link_event WHERE owner_id=? AND fragment_id=? ORDER BY revision LIMIT 1').get(store.studentId, id) as {
            basis_json: string;
        } | undefined;
        const link = currentLink(store, id), row = link ? store.db.prepare('SELECT content_json FROM material_fragment WHERE owner_id=? AND id=? AND revision=?').get(store.studentId, id, link.fragment_revision) as {
            content_json: string;
        } | undefined : undefined;
        if (!first || !row)
            return false;
        const basis = JSON.parse(first.basis_json) as {
            regionId?: string;
            observationId?: string;
        };
        const fragment = JSON.parse(row.content_json) as Fragment;
        if (basis.regionId) {
            const region = evidence.regions.find(r => r.id === basis.regionId && r.kind === 'reference_answer');
            if (!region || JSON.stringify(region.box) !== JSON.stringify(fragment.box))
                return false;
            texts.push(evidence.observations.filter(o => o.kind === 'reference_answer' && o.regionId === basis.regionId).map(o => o.text).join('\n'));
        }
        else {
            const observation = evidence.observations.find(o => o.id === basis.observationId && o.kind === 'reference_answer');
            if (!observation)
                return false;
            texts.push(observation.text);
        }
    }
    return texts.join('\n') === answer.text;
}
export function learningPrintAnswerBlocked(itemId: string): boolean {
    const store = materialStoreForItem(itemId), q = store && mappedPrintQuestion(store, itemId);
    if (!q)
        return false;
    const isLegacy = getLearningSource(itemId)?.kind === 'legacy';
    const original = (a: ReferenceAnswer) => isLegacy && a.fragmentIds.length > 0 && a.fragmentIds.every(id => legacyFragmentItem(store!, id) === itemId);
    const selected = selectedAnswerIds(store!, q.id), explicit = explicitPrintSelection(store!, q.id);
    if (explicit && selected.some(id => { const answer = q.answers.find(a => a.id === id)!; return original(answer) && !legacySelectionMatches(store!, itemId, answer); }))
        return true;
    // Legacy low/unchecked projections may fall back to current Evidence, but
    // conflicting current answers still require an explicit valid selection.
    return selected.length === 0 && (q.answerConflict || q.answers.some(a => !original(a)) || explicit);
}
/** Current real regions for detail galleries; eligibility does not hide pending material. */
export function learningImageFragments(itemId: string): Fragment[] {
    const store = materialStoreForItem(itemId), q = store && mappedPrintQuestion(store, itemId);
    return q ? [...q.stem, ...learningObservationFragments(store!, q.id)].filter(f => getLearningSource(itemId)?.kind !== 'legacy' || legacyFragmentItem(store!, f.fragmentId) !== itemId).sort(printOrder) : [];
}
function legacyFragmentItem(store: MaterialStore, id: string): string | null {
    const row = store.db.prepare(`SELECT l.basis_json,m.source_key FROM material_link_event l
 LEFT JOIN material_legacy_map m ON m.owner_id=l.owner_id AND m.question_id=l.question_id AND m.source_kind='error_item'
 WHERE l.owner_id=? AND l.fragment_id=? ORDER BY l.revision LIMIT 1`).get(store.studentId, id) as {
        basis_json: string;
        source_key: string | null;
    } | undefined;
    return row && JSON.parse(row.basis_json).source === 'legacy' ? row.source_key : null;
}
/** Real photographed references may be on pages that are never rendered on the
 * question sheet. Their bytes and precise source revisions still belong to the print basis. */
export function learningPrintAnswerRegions(itemId: string, answers: ReferenceAnswer[]): SourceRegion[] {
    const store = materialStoreForItem(itemId);
    if (!store)
        return [];
    const result: SourceRegion[] = [];
    for (const answer of answers.filter(a => a.source === 'imported'))
        for (const id of answer.fragmentIds) {
            const link = currentLink(store, id);
            const row = link ? store.db.prepare('SELECT content_json FROM material_fragment WHERE owner_id=? AND id=? AND revision=?').get(store.studentId, id, link.fragment_revision) as {
                content_json: string;
            } | undefined : undefined;
            if (!row)
                throw new Error('参考答案原始片段不存在');
            const fragment = JSON.parse(row.content_json) as Fragment;
            if (fragment.check !== 'passed' || fragment.uncertainties.length)
                throw new Error('参考答案原始片段待核验');
            result.push(regionOf(fragment));
        }
    return result;
}
export function getLearningPrintInput(itemId: string): LearningPrintInput | null {
    const source = getLearningSource(itemId), current = getLearningContext(itemId);
    if (!source || !current)
        return null;
    const store = materialStoreForItem(itemId) ?? new MaterialStore(getDb(), ensureStudentProfile().id), q = mappedPrintQuestion(store, itemId);
    let context = structuredClone(current.context), badge = learningCard(itemId)!.badge;
    let questionRegions: SourceRegion[] = [], diagramRegions: SourceRegion[] = [], redactRegions: SourceRegion[] = [];
    let fragments: Fragment[] = [];
    let legacyBasis: unknown = null;
    if (source.kind === 'legacy') {
        const record = getEvidence(itemId);
        if (!record)
            return null;
        const e = validateEvidence(record.content);
        const asset = store.db.prepare(`SELECT COALESCE(m.id,a.id) id,a.content_hash FROM error_item i JOIN source_asset a ON a.id=i.asset_id LEFT JOIN material_asset m ON m.source_asset_id=a.id AND m.owner_id=i.student_id WHERE i.id=? AND i.student_id=?`).get(itemId, store.studentId) as {
            id: string;
            content_hash: string;
        };
        const region = (id: string, box: SourceRegion['box']): SourceRegion => ({ assetId: asset.id, sourceHash: asset.content_hash, fragmentId: `legacy:${itemId}:${id}`, revision: record.revision, box });
        questionRegions = [region('question', e.questionRegion)];
        diagramRegions = e.regions.filter(r => r.kind === 'diagram').map(r => region(r.id, r.box));
        legacyBasis = { revision: record.revision, evidence: e };
        fragments = q ? effectiveQuestionStem(store, q.id).filter(f => legacyFragmentItem(store, f.fragmentId) !== itemId) : [];
    }
    else {
        if (!q || q.missing.includes('stem') || q.missing.includes('diagram') || q.unresolved.length)
            return null;
        fragments = effectiveQuestionStem(store, q.id);
    }
    // Legacy original warnings retain their old behavior; new supplements need their own checks.
    if (fragments.some(f => !['passed', 'low'].includes(f.check) || f.uncertainties.includes('missing_diagram')))
        return null;
    if (fragments.some(f => f.role === 'question' && f.requiresDiagram && !fragments.some(d => diagramCovers(f, d))))
        return null;
    if (source.kind === 'legacy' && q && q.unresolved.some(u => !current.context.uncertainties.includes(u)))
        return null;
    fragments.sort(printOrder);
    if (fragments.some(f => f.check === 'low' || f.uncertainties.length))
        badge = 'low';
    questionRegions.push(...fragments.filter(f => f.role === 'question').map(regionOf));
    diagramRegions.push(...fragments.filter(f => f.role === 'diagram').map(regionOf));
    if (source.kind === 'legacy' && fragments.length)
        context = { ...context, questionText: [context.questionText, ...fragments.filter(f => f.role === 'question').map(f => f.text)].join('\n\n'), requiresDiagram: context.requiresDiagram || fragments.some(f => f.requiresDiagram) };
    if (source.kind === 'material')
        context = { ...context, questionText: fragments.filter(f => f.role === 'question').map(f => f.text).join('\n\n') };
    const assets = [...new Set([...questionRegions, ...diagramRegions].map(r => r.assetId))];
    for (const asset of assets) {
        for (const f of latestFragments(store, asset))
            if (redactRoles.has(f.role) && !legacyFragmentItem(store, f.fragmentId))
                redactRegions.push(regionOf(f));
        // Legacy and new fragment IDs can name the same physical source. Resolve the real
        // source_asset FK before collecting authoritative neighboring Evidence regions.
        const sourceId = (store.db.prepare('SELECT source_asset_id FROM material_asset WHERE owner_id=? AND id=?').get(store.studentId, asset) as {
            source_asset_id: string;
        } | undefined)?.source_asset_id ?? asset;
        const neighbors = store.db.prepare(`SELECT i.id,e.content_json,e.revision,s.content_hash FROM error_item i
   JOIN evidence_record e ON e.item_id=i.id JOIN source_asset s ON s.id=i.asset_id WHERE i.student_id=? AND i.asset_id=?`).all(store.studentId, sourceId) as {
            id: string;
            content_json: string;
            revision: number;
            content_hash: string;
        }[];
        for (const n of neighbors)
            for (const r of validateEvidence(JSON.parse(n.content_json)).regions)
                if (r.kind !== 'diagram')
                    redactRegions.push({ assetId: asset, fragmentId: `legacy:${n.id}:${r.id}`, revision: n.revision, sourceHash: n.content_hash, box: r.box });
    }
    // Only same-source redactions that could reach rendered pixels are print dependencies.
    const rendered = badge === 'low' || context.requiresDiagram && !diagramRegions.length ? [...questionRegions, ...diagramRegions] : diagramRegions;
    redactRegions = redactRegions.filter(r => rendered.some(v => v.assetId === r.assetId && v.sourceHash === r.sourceHash && boxesNear(v.box, r.box)));
    redactRegions.sort((a, b) => a.assetId.localeCompare(b.assetId) || a.fragmentId.localeCompare(b.fragmentId));
    const blocked = learningPrintAnswerBlocked(itemId);
    let answers = q && !blocked ? selectedAnswerIds(store, q.id).map(id => q.answers.find(a => a.id === id)!) : [];
    if (source.kind === 'legacy' && !(q && explicitPrintSelection(store, q.id))) {
        const original = answers.filter(a => a.fragmentIds.length && a.fragmentIds.every(id => legacyFragmentItem(store, id) === itemId));
        answers = answers.filter(a => !original.includes(a));
        if (!answers.length && !learningPrintAnswerBlocked(itemId)) {
            const record = getEvidence(itemId)!;
            let observations = record.content.observations.filter(o => o.kind === 'reference_answer');
            if (original.length) {
                const observationIds = new Set(original.flatMap(a => a.fragmentIds.flatMap(id => {
                    const row = store.db.prepare('SELECT basis_json FROM material_link_event WHERE owner_id=? AND fragment_id=? ORDER BY revision LIMIT 1').get(store.studentId, id) as {
                        basis_json: string;
                    };
                    const basis = JSON.parse(row.basis_json) as {
                        observationId?: string;
                        observationIds?: string[];
                    };
                    return basis.observationIds ?? (basis.observationId ? [basis.observationId] : []);
                })));
                observations = observations.filter(o => observationIds.has(o.id));
                if (!observations.length)
                    return null;
            }
            else
                observations = observations.slice(0, 1);
            answers = observations.map(o => ({ id: `legacy:${itemId}:${o.id}`, questionId: q?.id ?? itemId, subpart: null, revision: record.revision, source: 'imported', text: o.text, claimedSource: '原卷参考答案', fragmentIds: [], basisKey: createHash('sha256').update(JSON.stringify(legacyBasis)).digest('hex'), stale: false, run: null }));
        }
    }
    const answerRegions = learningPrintAnswerRegions(itemId, answers);
    const links = fragments.map(f => ({ id: f.fragmentId, revision: currentLink(store, f.fragmentId)?.revision }));
    const input = { context, questionRegions, diagramRegions, redactRegions, answers, badge };
    const basisKey = createHash('sha256').update(JSON.stringify({ input, links, legacyBasis, answerRegions, blocked: learningPrintAnswerBlocked(itemId) })).digest('hex');
    return { basisKey, ...input };
}
function boxesNear(a: SourceRegion['box'], b: SourceRegion['box']): boolean {
    // Includes the largest print margin and redaction padding; conservative at page edges.
    return a.x - .04 < b.x + b.width + .01 && a.x + a.width + .04 > b.x - .01 && a.y - .04 < b.y + b.height + .012 && a.y + a.height + .04 > b.y - .012;
}
