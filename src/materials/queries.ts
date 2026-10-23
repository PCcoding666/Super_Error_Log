import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { SUBJECTS, type Subject } from '../domain/types.js';
import type { Extraction, Fragment, QuestionBundle } from './contracts.js';
import type { MaterialStore } from './store.js';

export type CurrentLink = { id: string; fragment_id: string; fragment_revision: number; revision: number; question_id: string | null; attempt_id: string | null; basis_json: string };
export function currentLink(store: MaterialStore, fragmentId: string): CurrentLink | undefined {
  return store.db.prepare('SELECT * FROM material_link_event WHERE owner_id=? AND fragment_id=? ORDER BY revision DESC LIMIT 1').get(store.studentId,fragmentId) as CurrentLink | undefined;
}
export function latestFragments(store: MaterialStore, assetId: string): Fragment[] {
  const rows=store.db.prepare(`SELECT f.content_json FROM material_fragment f WHERE f.owner_id=? AND f.asset_id=? AND NOT EXISTS
    (SELECT 1 FROM material_fragment n WHERE n.owner_id=f.owner_id AND n.id=f.id AND n.revision>f.revision) ORDER BY f.id`).all(store.studentId,assetId) as {content_json:string}[];
  return rows.map(row=>JSON.parse(row.content_json) as Fragment);
}
/** Every fragment currently linked to the question, including reference answers and unknown material. */
export function linkedFragments(store: MaterialStore, questionId: string): Fragment[] {
  const rows=store.db.prepare(`SELECT f.content_json FROM material_link_event l JOIN material_fragment f ON f.owner_id=l.owner_id AND f.id=l.fragment_id AND f.revision=l.fragment_revision
    WHERE l.owner_id=? AND l.question_id=? AND NOT EXISTS (SELECT 1 FROM material_link_event n WHERE n.owner_id=l.owner_id AND n.fragment_id=l.fragment_id AND n.revision>l.revision)`).all(store.studentId,questionId) as {content_json:string}[];
  return rows.map(row=>JSON.parse(row.content_json) as Fragment);
}
export function resolveQuestionId(store: MaterialStore, id: string): string {
  const visited=new Set<string>();
  while (!visited.has(id)) {
    visited.add(id);
    const alias=store.db.prepare("SELECT question_id FROM material_legacy_map WHERE owner_id=? AND source_kind='question_alias' AND source_key=?").get(store.studentId,id) as {question_id:string}|undefined;
    if (!alias) return id; id=alias.question_id;
  }
  throw new Error('question alias cycle');
}
/** Same printed number and exact subpart are required; shared/unknown scopes are not inferred. */
export function diagramCovers(question: Fragment, diagram: Fragment): boolean {
  return diagram.role==='diagram' && diagram.check==='passed' && diagram.uncertainties.length===0 &&
    question.number===diagram.number && question.subpart===diagram.subpart &&
    question.number!==null;
}
/** Fill only absent metadata from currently linked stem origins. Never persist the
 * inference: moving/undoing its supporting links must remove it as well. Stored
 * classification (including unsupported model output) remains authoritative. */
export function effectiveSubject(store: MaterialStore, stored: string | null, stem: Fragment[]): string | null {
  if (stored !== null) return stored;
  const subjects = new Set<string>();
  for (const f of stem) {
    if (f.role !== 'question' || !['passed', 'low'].includes(f.check)) continue;
    const row = store.db.prepare(`SELECT a.extraction_json,a.revision,s.content_hash FROM material_asset a
      JOIN source_asset s ON s.id=a.source_asset_id JOIN source_batch b ON b.id=s.batch_id
      WHERE a.owner_id=? AND b.student_id=? AND a.id=?`).get(store.studentId,store.studentId,f.assetId) as
      {extraction_json:string|null;revision:number;content_hash:string}|undefined;
    if (!row?.extraction_json || row.content_hash !== f.sourceHash) continue;
    const extraction = JSON.parse(row.extraction_json) as Extraction;
    if (extraction.assetId !== f.assetId || extraction.revision !== row.revision || !SUBJECTS.includes(extraction.document.subject as Subject)) continue;
    // Transcript corrections retain their actual region's classification origin;
    // an unrelated fragment or replaced source cannot borrow this page's subject.
    const fields = ['fragmentId','assetId','sourceHash','role','box','number','subpart'] as const;
    if (extraction.fragments.some(origin => fields.every(key => isDeepStrictEqual(origin[key],f[key])))) subjects.add(extraction.document.subject!);
  }
  return subjects.size === 1 ? [...subjects][0]! : null;
}
export function readQuestion(store: MaterialStore, questionId: string): QuestionBundle | null {
  const q=store.getQuestion(resolveQuestionId(store,questionId)); if (!q) return null;
  const requires=q.stem.filter(f=>f.role==='question'&&f.requiresDiagram);
  q.missing=q.missing.filter(value=>value!=='diagram');
  if (requires.some(question=>!q.stem.some(diagram=>diagramCovers(question,diagram)))) q.missing.push('diagram');
  // Association establishes availability, not a new extraction verification. Keep raw checks/uncertainties.
  return q;
}

/** Resolve association-only incompleteness using actual Task3 request checkpoints, never low+reason alone.
 * Historical checkpoints without the trusted original source hash remain low. Raw evidence is never rewritten.
 */
export function effectiveFragmentCheck(store:MaterialStore,questionId:string,fragmentId:string):Fragment['check'] {
  const q=readQuestion(store,questionId); if (!q) return 'unchecked';
  const f=[...q.stem,...q.attempts.flatMap(a=>a.fragments),...q.teacherMarks].find(fragment=>fragment.fragmentId===fragmentId);
  if (!f) return 'unchecked';
  if (f.check!=='low'||f.role!=='question'||!f.requiresDiagram||!f.uncertainties.length||f.uncertainties.some(u=>u!=='missing_diagram')||!q.stem.some(d=>diagramCovers(f,d))) return f.check;
  const source=store.db.prepare(`SELECT s.content_hash FROM material_asset a JOIN source_asset s ON s.id=a.source_asset_id WHERE a.owner_id=? AND a.id=?`).get(store.studentId,f.assetId) as {content_hash:string}|undefined;
  if (source?.content_hash!==f.sourceHash) return f.check;
  const jobs=store.db.prepare("SELECT input_json,result_json FROM material_job WHERE owner_id=? AND asset_id=? AND kind='extract' AND result_json IS NOT NULL").all(store.studentId,f.assetId) as {input_json:string;result_json:string}[];
  type Checkpoint={state:string;result?:{value?:Record<string,unknown>}};
  for (const job of jobs) {
    const result=JSON.parse(job.result_json) as {assetId?:string;sourceHash?:string;revision?:number};
    if (result.assetId!==f.assetId||result.sourceHash!==f.sourceHash||!Number.isSafeInteger(result.revision)) continue;
    const stages=(JSON.parse(job.input_json).execution?.stages??{}) as Record<string,Checkpoint>;
    const prefix=`material-v1:${result.revision}`; const locate=stages[`${prefix}:locate`];
    if (locate?.state!=='succeeded'||!Array.isArray(locate.result?.value?.candidates)) continue;
    const candidate=locate.result.value.candidates.find((c:Record<string,unknown>)=>c.fragmentId===f.fragmentId) as Record<string,unknown>|undefined;
    if (!candidate||typeof candidate.key!=='string') continue;
    const fields=['fragmentId','role','box','number','subpart','page','order','requiresDiagram'] as const;
    if (!fields.every(key=>isDeepStrictEqual(candidate[key],f[key]))) continue;
    const read=stages[`${prefix}:read:${candidate.key}`]; const verify=stages[`${prefix}:verify:${candidate.key}`];
    if (read?.state==='succeeded'&&verify?.state==='succeeded'&&read.result?.value?.text===f.text&&
      isDeepStrictEqual(read.result.value.uncertainties,[])&&verify.result?.value?.check==='passed'&&isDeepStrictEqual(verify.result.value.uncertainties,[])) return 'passed';
  }
  return f.check;
}

/** Derived action input only: retain raw extraction/history in storage. The sole promoted case
 * is association-only missing_diagram backed by effectiveFragmentCheck's durable provenance. */
export function effectiveQuestionStem(store:MaterialStore,questionId:string):Fragment[] {
 const q=readQuestion(store,questionId);if(!q)throw new Error('question not found');
 return q.stem.map(f=>f.check==='low'&&effectiveFragmentCheck(store,q.id,f.fragmentId)==='passed'?{...f,check:'passed',uncertainties:[]}:structuredClone(f));
}

type FragmentDependency = { id:string; revision:number; sourceHash:string; box:Fragment['box']; linkRevision:number; questionId:string; attemptId:string|null };
export type MaterialDependencies = { version:1; kind:'answer'|'grade'; questionId:string; attemptId:string|null; answerIds:string[]; fragments:FragmentDependency[]; answers:{id:string;revision:number;basisKey:string;stale:boolean}[] };
export type MaterialBasis = { basisKey:string; dependencies:MaterialDependencies };
function basis(store:MaterialStore, questionId:string, attemptId:string|null, answerIds:string[], kind:'answer'|'grade'):MaterialBasis {
  const q=readQuestion(store,questionId); if (!q) throw new Error('question not found');
  if (kind==='grade'&&!q.attempts.some(a=>a.id===attemptId)) throw new Error('attempt not found');
  const selected=[...q.stem,...(kind==='grade'?q.attempts.find(a=>a.id===attemptId)!.fragments:[])];
  const fragments=selected.map(f=>{ const link=currentLink(store,f.fragmentId)!; return {id:f.fragmentId,revision:f.revision,sourceHash:f.sourceHash,box:f.box,linkRevision:link.revision,questionId:q.id,attemptId:link.attempt_id}; }).sort((a,b)=>a.id.localeCompare(b.id));
  const ids=[...new Set(answerIds)].sort();
  const answers=ids.map(id=>{const answer=q.answers.find(a=>a.id===id); if (!answer) throw new Error('answer not found'); return {id,revision:answer.revision,basisKey:answer.basisKey,stale:answer.stale};});
  const dependencies:MaterialDependencies={version:1,kind,questionId:q.id,attemptId,answerIds:ids,fragments,answers};
  return {basisKey:createHash('sha256').update(JSON.stringify(dependencies)).digest('hex'),dependencies};
}
/** Persist both fields on the answer/job. Labels, capture order, unrelated work and question counters are excluded. */
export function answerBasis(store:MaterialStore,questionId:string):MaterialBasis { return basis(store,questionId,null,[],'answer'); }
export function gradeBasis(store:MaterialStore,questionId:string,attemptId:string,answerIds:string[]):MaterialBasis { return basis(store,questionId,attemptId,answerIds,'grade'); }
/** Running handlers must check this again inside their result-persistence transaction. */
export function dependenciesCurrent(store:MaterialStore,basisKey:string,dependencies:unknown):boolean {
  const d=dependencies as Partial<MaterialDependencies>|null;
  if (d?.version!==1 || !d.questionId || !Array.isArray(d.answerIds)) return false;
  try { return (d.kind==='answer'?answerBasis(store,d.questionId):d.kind==='grade'&&d.attemptId?gradeBasis(store,d.questionId,d.attemptId,d.answerIds):null)?.basisKey===basisKey; }
  catch { return false; }
}
/** Called in the same transaction as the link event. A stale running row cannot be promoted by the worker. */
export function invalidateLinkDependencies(store:MaterialStore,questionIds:string[],fragment:Fragment,attemptIds:string[]):void {
  const questions=new Set(questionIds);
  const stem=fragment.role==='question'||fragment.role==='diagram';
  for (const table of ['material_answer','material_grade','material_job'] as const) {
    const rows=store.db.prepare(`SELECT rowid AS row_id,* FROM ${table} WHERE owner_id=? ${table==='material_job'?"AND kind!='extract' AND state IN ('queued','running','interrupted','failed')":'AND stale=0'}`).all(store.studentId) as {row_id:number;question_id?:string;attempt_id?:string;kind?:string;basis_key:string;dependencies_json:string}[];
    for (const row of rows) {
      const parsed=JSON.parse(row.dependencies_json);
      // Photo projections depend on their own region/link, maintained atomically by linkFragment.
      // Adding or reaffirming the receiving stem must not invalidate a newly supplemented answer.
      if (table==='material_answer'&&parsed?.version===2&&parsed.kind==='imported') continue;
      const d=parsed as Partial<MaterialDependencies>;
      const attemptQuestion=row.attempt_id?(store.db.prepare('SELECT question_id FROM material_attempt WHERE owner_id=? AND id=?').get(store.studentId,row.attempt_id) as {question_id:string}|undefined)?.question_id:undefined;
      const relevant=d?.version===1?questions.has(d.questionId!):row.question_id?questions.has(row.question_id):attemptIds.includes(row.attempt_id!)||stem&&questions.has(attemptQuestion!);
      if (!relevant) continue;
      const isAnswer=table==='material_answer'||row.kind==='answer';
      // Legacy/unbound dependency rows get a conservative role-specific fallback.
      const stale=d?.version===1?!dependenciesCurrent(store,row.basis_key,d):stem||!isAnswer;
      if (stale) store.db.prepare(`UPDATE ${table} SET ${table==='material_job'?"state='stale'":'stale=1'} WHERE owner_id=? AND rowid=?`).run(store.studentId,row.row_id);
    }
  }
}

/** Historical versions remain readable; no answer projection or model work occurs here. */
export function answerHistory(store:MaterialStore,questionId:string,page=0):{answer:import('./contracts.js').ReferenceAnswer;createdAt:string}[]{
  const q=readQuestion(store,questionId);if(!q)return [];
  // UNION deduplicates IDs even if malformed historical aliases contain a cycle.
  // Pagination is over the complete current alias family, never per original question.
  const rows=store.db.prepare(`WITH RECURSIVE family(id) AS (
    SELECT ? UNION SELECT m.source_key FROM material_legacy_map m JOIN family f ON m.question_id=f.id
    WHERE m.owner_id=? AND m.source_kind='question_alias'
  ) SELECT a.content_json,a.stale,a.created_at FROM material_answer a
    WHERE a.owner_id=? AND a.question_id IN (SELECT id FROM family) ORDER BY a.rowid DESC LIMIT 20 OFFSET ?`)
    .all(q.id,store.studentId,store.studentId,Math.max(0,page)*20) as {content_json:string;stale:number;created_at:string}[];
  return rows.map(row=>({answer:{...JSON.parse(row.content_json),stale:!!row.stale},createdAt:row.created_at}));
}
