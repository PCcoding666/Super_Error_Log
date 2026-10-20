import { syncMaterialLearning } from './learning.js';
import { newId } from '../db/connection.js';
import { MobileRequestError } from '../mobile/service.js';
import type { LinkChange, LinkTarget } from './contracts.js';
import type { MaterialStore } from './store.js';
import { currentLink, latestFragments, readQuestion, resolveQuestionId } from './queries.js';
import { materialAsset, mergeQuestions, reconcileAsset } from './matching.js';

const conflict=()=>new MobileRequestError(409,'link_conflict','材料关联已更新，请刷新后重试。');
/** Workspace-wide append-only link clock. NOT QuestionBundle.revision and never a paid-result dependency. */
export function linkRevision(store:MaterialStore):number {
  return (store.db.prepare('SELECT COALESCE(MAX(rowid),0) revision FROM material_link_event WHERE owner_id=?').get(store.studentId) as {revision:number}).revision;
}
/** Page-confirmation CAS, independent from material_asset.revision used by extraction. */
export function assetLinkRevision(store:MaterialStore,assetId:string):number {
  const row=store.db.prepare('SELECT link_revision FROM material_asset WHERE owner_id=? AND id=?').get(store.studentId,assetId) as {link_revision:number}|undefined;
  if (!row) throw new MobileRequestError(404,'not_found','材料不存在。'); return row.link_revision;
}
function checkRevision(store:MaterialStore,expected:number):void { if (!Number.isSafeInteger(expected)||expected!==linkRevision(store)) throw conflict(); }
type QuestionMeta={id:string;document_id:string|null;unresolved_json:string};
type AssetMeta={id:string;document_id:string|null;hints_json:string;link_revision:number};
type Alias={source_key:string;question_id:string;details_json:string};
type Metadata={questions:QuestionMeta[];assets:AssetMeta[];aliases:Alias[]};
type QuestionState=QuestionMeta&{revision:number;canonicalId:string};
type Operation={id:string;eventIds:string[];before:Metadata;after:Metadata;questionStates?:QuestionState[]};
type Event={id:string;fragment_id:string;fragment_revision:number;revision:number;question_id:string|null;attempt_id:string|null;before_question_id:string|null;before_attempt_id:string|null;before_fragment_revision:number|null;basis_json:string};
function metadata(store:MaterialStore):Metadata {
  return {
    questions:store.db.prepare('SELECT id,document_id,unresolved_json FROM material_question WHERE owner_id=? ORDER BY id').all(store.studentId) as QuestionMeta[],
    assets:store.db.prepare('SELECT id,document_id,hints_json,link_revision FROM material_asset WHERE owner_id=? ORDER BY id').all(store.studentId) as AssetMeta[],
    aliases:store.db.prepare("SELECT source_key,question_id,details_json FROM material_legacy_map WHERE owner_id=? AND source_kind='question_alias' ORDER BY source_key").all(store.studentId) as Alias[],
  };
}
function delta(before:Metadata,after:Metadata):[Metadata,Metadata] {
  const a:Metadata={questions:[],assets:[],aliases:[]}; const b:Metadata={questions:[],assets:[],aliases:[]};
  for (const key of ['questions','assets','aliases'] as const) {
    const identity=(row:QuestionMeta|AssetMeta|Alias)=>'source_key' in row?row.source_key:row.id;
    const left=new Map(before[key].map(row=>[identity(row),row])); const right=new Map(after[key].map(row=>[identity(row),row]));
    for (const id of new Set([...left.keys(),...right.keys()])) {
      if (JSON.stringify(left.get(id))===JSON.stringify(right.get(id))) continue;
      if (left.has(id)) (a[key] as (QuestionMeta|AssetMeta|Alias)[]).push(left.get(id)!);
      if (right.has(id)) (b[key] as (QuestionMeta|AssetMeta|Alias)[]).push(right.get(id)!);
    }
  }
  return [a,b];
}
function affectedQuestions(events:Event[],before:Metadata,after:Metadata):Set<string> {
  return new Set([
    ...events.flatMap(event=>[event.question_id,event.before_question_id]),
    ...[before,after].flatMap(meta=>[...meta.questions.map(question=>question.id),...meta.aliases.flatMap(alias=>[alias.source_key,alias.question_id])]),
  ].filter((id):id is string=>id!==null));
}
function questionState(store:MaterialStore,id:string):QuestionState {
  const row=store.db.prepare('SELECT id,document_id,unresolved_json,revision FROM material_question WHERE owner_id=? AND id=?').get(store.studentId,id) as (QuestionMeta&{revision:number})|undefined;
  if (!row) throw conflict();
  return {...row,canonicalId:resolveQuestionId(store,id)};
}
function checkQuestionState(store:MaterialStore,op:Operation,events:Event[],history:Event[]):void {
  if (op.questionStates) {
    for (const state of op.questionStates) if (JSON.stringify(questionState(store,state.id))!==JSON.stringify(state)) throw conflict();
  } else {
    // Older journals predate question snapshots. Later events on any involved
    // question make their inverse unsafe even if the original fragments stayed put.
    const affected=affectedQuestions(events,op.before,op.after);
    const last=history.findIndex(event=>event.id===events.at(-1)!.id);
    if (history.slice(last+1).some(event=>affected.has(event.question_id??'')||affected.has(event.before_question_id??''))) throw conflict();
  }
}
function operation(store:MaterialStore,run:()=>void):LinkChange[] {
  const start=linkRevision(store); const before=metadata(store); run();
  const events=store.db.prepare('SELECT * FROM material_link_event WHERE owner_id=? AND rowid>? ORDER BY rowid').all(store.studentId,start) as Event[];
  if (!events.length) return [];
  const assets=new Set(events.map(event=>(store.db.prepare('SELECT asset_id FROM material_fragment WHERE owner_id=? AND id=? AND revision=?').get(store.studentId,event.fragment_id,event.fragment_revision) as {asset_id:string}).asset_id));
  for (const id of assets) {
    const previous=before.assets.find(asset=>asset.id===id);
    if (previous) store.db.prepare('UPDATE material_asset SET link_revision=link_revision+1 WHERE owner_id=? AND id=? AND link_revision=?').run(store.studentId,id,previous.link_revision);
  }
  syncMaterialLearning(store);
  const [oldMeta,newMeta]=delta(before,metadata(store));
  const op:Operation={id:newId('mop'),eventIds:events.map(e=>e.id),before:oldMeta,after:newMeta,
    questionStates:[...affectedQuestions(events,oldMeta,newMeta)].sort().map(id=>questionState(store,id))};
  for (const event of events) store.db.prepare('UPDATE material_link_event SET basis_json=?,decision=? WHERE owner_id=? AND id=?').run(JSON.stringify({...JSON.parse(event.basis_json),operationId:op.id,...(event===events[0]?{operation:op}:{})}),'manual',store.studentId,event.id);
  const revision=linkRevision(store);
  return events.map(e=>({id:e.id,questionId:e.question_id??e.before_question_id??'',revision}));
}
function requireTarget(store:MaterialStore,target:LinkTarget):LinkTarget {
  const q=readQuestion(store,target.questionId); if (!q) throw new MobileRequestError(404,'not_found','题目不存在。');
  if (target.attemptId&&!q.attempts.some(a=>a.id===target.attemptId)) throw new MobileRequestError(400,'invalid_attempt','作答归属不一致。');
  return {questionId:q.id,attemptId:target.attemptId};
}
function retireEmptyQuestion(store:MaterialStore,id:string,targetId:string):void {
  targetId=resolveQuestionId(store,targetId);
  if (id===targetId||resolveQuestionId(store,id)!==id) return;
  const source=readQuestion(store,id)!;
  const remaining=store.db.prepare(`SELECT 1 FROM material_link_event l WHERE l.owner_id=? AND l.question_id=? AND NOT EXISTS
    (SELECT 1 FROM material_link_event n WHERE n.owner_id=l.owner_id AND n.fragment_id=l.fragment_id AND n.revision>l.revision) LIMIT 1`).get(store.studentId,id);
  if (!remaining&&!source.itemId&&!source.answers.length&&!source.grades.length) {
    store.db.prepare("INSERT INTO material_legacy_map(owner_id,source_kind,source_key,question_id,details_json) VALUES (?,'question_alias',?,?,?)")
      .run(store.studentId,id,targetId,JSON.stringify({reason:'manual_all_fragments'}));
  }
}
function move(store:MaterialStore,fragmentIds:string[],target:LinkTarget):void {
  if (!fragmentIds.length||new Set(fragmentIds).size!==fragmentIds.length) throw new MobileRequestError(400,'invalid_fragments','请选择材料片段。');
  const sources=new Set<string>();
  for (const id of fragmentIds) {
    const fragment=store.db.prepare('SELECT content_json,revision FROM material_fragment WHERE owner_id=? AND id=? ORDER BY revision DESC LIMIT 1').get(store.studentId,id) as {content_json:string;revision:number}|undefined;
    if (!fragment) throw new MobileRequestError(404,'not_found','材料不存在。');
    const role=JSON.parse(fragment.content_json).role;
    if ((role==='student_work'||role==='correction')&&!target.attemptId) throw new MobileRequestError(400,'attempt_required','请选择这次作答或另一次作答。');
    if (role!=='student_work'&&role!=='correction'&&target.attemptId) throw new MobileRequestError(400,'invalid_attempt','该材料不属于作答过程。');
    const old=currentLink(store,id); if (old?.question_id&&old.question_id!==target.questionId) sources.add(old.question_id);
    store.linkFragment(id,fragment.revision,target,old?.revision??0,{reason:'manual'});
  }
  for (const id of sources) retireEmptyQuestion(store,id,target.questionId);
}
/** expectedRevision/return revision are linkRevision(store), covering ALL source and destination links. */
export function relink(store:MaterialStore,input:{fragmentIds:string[];target:LinkTarget;expectedRevision:number}):LinkChange {
  return store.transaction(()=>{checkRevision(store,input.expectedRevision); const target=requireTarget(store,input.target); return operation(store,()=>move(store,input.fragmentIds,target))[0]!;});
}
/** One atomic user action: no empty attempt survives an invalid or stale link request. */
export function relinkNewAttempt(store:MaterialStore,input:{fragmentIds:string[];questionId:string;expectedRevision:number}):LinkChange&{attemptId:string} {
  return store.transaction(()=>{
    checkRevision(store,input.expectedRevision); const questionId=requireTarget(store,{questionId:input.questionId,attemptId:null}).questionId;
    const attemptId=store.createAttempt(questionId).id;
    const result=operation(store,()=>move(store,input.fragmentIds,{questionId,attemptId}))[0]!;
    return {...result,attemptId};
  });
}
/** expectedRevision is assetLinkRevision(store, assetId), NOT the extraction/source revision. Page confirmation only merges still-unique, compatible candidates. */
export function assignDocument(store:MaterialStore,input:{assetId:string;documentId:string;expectedRevision:number}):LinkChange[] {
  return store.transaction(()=>{
    const asset=materialAsset(store,input.assetId);
    if (!store.db.prepare('SELECT id FROM material_document WHERE owner_id=? AND id=?').get(store.studentId,input.documentId)) throw new MobileRequestError(404,'not_found','文档不存在。');
    return operation(store,()=>{
      const changed=store.db.prepare('UPDATE material_asset SET document_id=?,hints_json=?,link_revision=link_revision+1 WHERE owner_id=? AND id=? AND link_revision=?')
        .run(input.documentId,JSON.stringify({...JSON.parse(asset.hints_json),documentId:input.documentId}),store.studentId,input.assetId,input.expectedRevision);
      if (changed.changes!==1) throw conflict();
      const fragments=latestFragments(store,input.assetId);
      const ids=[...new Set(fragments.map(f=>currentLink(store,f.fragmentId)?.question_id).filter((v):v is string=>!!v))];
      const afterLinks:(()=>void)[]=[];
      for (let id of ids) {
        id=resolveQuestionId(store,id); const q=readQuestion(store,id)!;
        // A page-level choice must not move evidence on other pages to a new document silently.
        const other=store.db.prepare(`SELECT 1 FROM material_link_event l JOIN material_fragment f ON f.owner_id=l.owner_id AND f.id=l.fragment_id AND f.revision=l.fragment_revision
          WHERE l.owner_id=? AND l.question_id=? AND f.asset_id!=? AND NOT EXISTS (SELECT 1 FROM material_link_event n WHERE n.owner_id=l.owner_id AND n.fragment_id=l.fragment_id AND n.revision>l.revision) LIMIT 1`).get(store.studentId,id,input.assetId);
        if (other&&q.documentId!==input.documentId) {
          const provisional=store.createQuestion({documentId:input.documentId,number:q.number,subject:q.subject}).id;
          const attempts=new Map<string,string>();
          for (const f of fragments) { const link=currentLink(store,f.fragmentId); if (link?.question_id!==id) continue; if (link.attempt_id&&!attempts.has(link.attempt_id)) attempts.set(link.attempt_id,store.createAttempt(provisional).id); store.linkFragment(f.fragmentId,f.revision,{questionId:provisional,attemptId:link.attempt_id?attempts.get(link.attempt_id)!:null},link.revision,{reason:'document_assignment'}); }
          id=provisional;
        }
        const candidates=store.listQuestions().filter(c=>c.id!==id&&c.documentId===input.documentId&&q.number!==null&&c.number===q.number);
        store.db.prepare('UPDATE material_question SET document_id=?,unresolved_json=?,revision=revision+1 WHERE owner_id=? AND id=?').run(input.documentId,JSON.stringify(q.unresolved.filter(r=>r!=='document')),store.studentId,id);
        if (candidates.length===1) {
          const merged=mergeQuestions(store,id,candidates[0]!.id,afterLinks);
          if (!merged) store.db.prepare('UPDATE material_question SET unresolved_json=? WHERE owner_id=? AND id=?').run(JSON.stringify([...new Set([...readQuestion(store,id)!.unresolved,'association'])]),store.studentId,id);
        } else if (candidates.length>1) store.db.prepare('UPDATE material_question SET unresolved_json=? WHERE owner_id=? AND id=?').run(JSON.stringify([...q.unresolved.filter(r=>r!=='document'),'association']),store.studentId,id);
      }
      reconcileAsset(store,input.assetId);
      // Document confirmation changes link provenance even when the destination remains the same.
      for (const f of fragments) { const old=currentLink(store,f.fragmentId); if (old) store.linkFragment(f.fragmentId,old.fragment_revision,old.question_id?{questionId:old.question_id,attemptId:old.attempt_id}:null,old.revision,{reason:'document_assignment',documentId:input.documentId}); }
      for(const complete of afterLinks)complete();
    });
  });
}
function restoreMetadata(store:MaterialStore,from:Metadata,to:Metadata):void {
  for (const row of from.questions) {
    const current=store.db.prepare('SELECT id,document_id,unresolved_json FROM material_question WHERE owner_id=? AND id=?').get(store.studentId,row.id);
    if (JSON.stringify(current)!==JSON.stringify(row)) throw conflict();
  }
  for (const key of new Set([...from.aliases,...to.aliases].map(alias=>alias.source_key))) {
    const current=store.db.prepare("SELECT source_key,question_id,details_json FROM material_legacy_map WHERE owner_id=? AND source_kind='question_alias' AND source_key=?").get(store.studentId,key);
    if (JSON.stringify(current)!==JSON.stringify(from.aliases.find(alias=>alias.source_key===key))) throw conflict();
  }
  for (const row of from.assets) {
    const current=store.db.prepare('SELECT id,document_id,hints_json,link_revision FROM material_asset WHERE owner_id=? AND id=?').get(store.studentId,row.id);
    if (JSON.stringify(current)!==JSON.stringify(row)) throw conflict();
  }
  for (const row of to.assets) store.db.prepare('UPDATE material_asset SET document_id=?,hints_json=?,link_revision=link_revision+1 WHERE owner_id=? AND id=?').run(row.document_id,row.hints_json,store.studentId,row.id);
  for (const row of to.questions) store.db.prepare('UPDATE material_question SET document_id=?,unresolved_json=?,revision=revision+1 WHERE owner_id=? AND id=?').run(row.document_id,row.unresolved_json,store.studentId,row.id);
  for (const row of from.aliases) store.db.prepare("DELETE FROM material_legacy_map WHERE owner_id=? AND source_kind='question_alias' AND source_key=?").run(store.studentId,row.source_key);
  for (const row of to.aliases) store.db.prepare("INSERT INTO material_legacy_map(owner_id,source_kind,source_key,question_id,details_json) VALUES (?,'question_alias',?,?,?)").run(store.studentId,row.source_key,row.question_id,row.details_json);
}
/** Append inverse events; never remove historical events or overwrite a subsequent edit. Undo itself is undoable. */
export function undoLink(store:MaterialStore,changeId:string,expectedRevision:number):LinkChange {
  return store.transaction(()=>{
    checkRevision(store,expectedRevision);
    const event=store.db.prepare('SELECT * FROM material_link_event WHERE owner_id=? AND id=?').get(store.studentId,changeId) as Event|undefined;
    if (!event) throw new MobileRequestError(404,'not_found','关联记录不存在。');
    const eventBasis=JSON.parse(event.basis_json) as {operationId?:string};
    const history=store.db.prepare('SELECT * FROM material_link_event WHERE owner_id=? ORDER BY rowid').all(store.studentId) as Event[];
    const events=eventBasis.operationId?history.filter(e=>JSON.parse(e.basis_json).operationId===eventBasis.operationId):[event];
    const op=JSON.parse(events[0]!.basis_json).operation as Operation|undefined;
    const groups=new Map<string,Event[]>(); for (const row of events) groups.set(row.fragment_id,[...(groups.get(row.fragment_id)??[]),row]);
    for (const [id,rows] of groups) if (currentLink(store,id)?.id!==rows.at(-1)!.id) throw conflict();
    if (op) checkQuestionState(store,op,events,history);
    const changes=operation(store,()=>{
      if (op) restoreMetadata(store,op.after,op.before);
      for (const [id,rows] of groups) {
        const before=rows[0]!; const last=rows.at(-1)!;
        store.linkFragment(id,before.before_fragment_revision??before.fragment_revision,before.before_question_id?{questionId:before.before_question_id,attemptId:before.before_attempt_id}:null,last.revision,{reason:'undo',undoOf:changeId});
      }
      // A page split can create a provisional record. Preserve its ID as an alias after undo empties it.
      for (const question of op?.after.questions??[]) if (!op!.before.questions.some(old=>old.id===question.id)) {
        const originals=[...new Set(events.filter(event=>event.question_id===question.id&&event.before_question_id&&event.before_question_id!==question.id).map(event=>event.before_question_id!))];
        if (originals.length===1) retireEmptyQuestion(store,question.id,originals[0]!);
      }
    });
    return changes[0]!;
  });
}
