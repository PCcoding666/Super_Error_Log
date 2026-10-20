import { SUBJECTS, type Subject } from '../domain/types.js';
import { newId, now } from '../db/connection.js';
import { MobileRequestError } from '../mobile/service.js';
import type { MaterialStore } from './store.js';
import { effectiveQuestionStem, readQuestion, resolveQuestionId } from './queries.js';

/** Intent is retained on original identities. Association combines choices with exclusion priority.
 * An explicit choice on the merged question updates its entire current alias family; undo then
 * retains that later student choice for each identity. Events preserve the family acted on. */
export function questionFamily(store:MaterialStore, questionId:string):string[] {
 const id=resolveQuestionId(store,questionId);
 return (store.db.prepare('SELECT id FROM material_question WHERE owner_id=?').all(store.studentId) as {id:string}[]).filter(q=>resolveQuestionId(store,q.id)===id).map(q=>q.id);
}
export function inclusionIntent(store:MaterialStore, questionId:string):boolean|null {
 const values=questionFamily(store,questionId).flatMap(id=>{
  const row=store.db.prepare('SELECT included FROM material_inclusion WHERE owner_id=? AND question_id=?').get(store.studentId,id) as {included:number}|undefined;
  return row?[row.included]:[];
 });
 return values.includes(0)?false:values.includes(1)?true:null;
}
export function materialPracticeEligible(store:MaterialStore, questionId:string):boolean {
 const q=readQuestion(store,questionId); if(!q||!questionIncluded(store,q.id)) return false;
 if(q.missing.includes('stem')||q.missing.includes('diagram')||q.unresolved.length||!SUBJECTS.includes(q.subject as Subject)) return false;
 // Preserve the v2 low-confidence path. Failed/unchecked or uncertain associations cannot enter.
 return effectiveQuestionStem(store,q.id).every(f=>(f.check==='passed'||f.check==='low')&&!f.uncertainties.includes('missing_diagram'));
}
function automaticMistake(store:MaterialStore,questionId:string):boolean {
 const q=readQuestion(store,questionId)!;
 if(q.grades.some(g=>!g.stale&&(g.result==='incorrect'||g.result==='partial'))) return true;
 return q.teacherMarks.some(f=>f.check==='passed'&&!f.uncertainties.length&&
   /^(?:错误|答错|不正确|答案错误|扣\s*\d+(?:\.\d+)?\s*分|[-−]\s*\d+(?:\.\d+)?\s*分|[×✗✘])[。.!！]?$/u.test(f.text.trim()));
}
export function questionIncluded(store:MaterialStore,questionId:string):boolean { return inclusionIntent(store,questionId)??automaticMistake(store,questionId); }
/** Called at mutation boundaries, never by material GETs. No mastery or evidence writes. */
export function syncMaterialLearning(store:MaterialStore):void {
 store.transaction(()=>{
  for(const q of store.listQuestions()) {
   // Every migrated item retains its original learning authority, including pre-mobile records.
   if(q.itemId&&(store.db.prepare('SELECT 1 FROM mobile_item_link WHERE item_id=?').get(q.itemId)||store.db.prepare("SELECT 1 FROM material_legacy_map WHERE owner_id=? AND source_kind='error_item' AND source_key=?").get(store.studentId,q.itemId))) continue;
   const intent=inclusionIntent(store,q.id),included=intent??automaticMistake(store,q.id);
   if(q.missing.includes('stem')) {
    // Retain the learning identity/history, but remove classification whose only
    // supporting stem was moved or undone. Legacy authority was excluded above.
    if(q.itemId) store.db.prepare('UPDATE error_item SET subject=? WHERE id=?').run(q.subject,q.itemId);
    continue;
   }
   if(!included&&!q.itemId) continue;
   const stem=q.stem.filter(f=>f.role==='question');let itemId=q.itemId;
   if(!itemId){
    const anchor=store.db.prepare(`SELECT s.id,s.batch_id FROM material_asset a JOIN source_asset s ON s.id=a.source_asset_id WHERE a.owner_id=? AND a.id=?`).get(store.studentId,stem[0]!.assetId) as {id:string;batch_id:string};
    const index=(store.db.prepare('SELECT COALESCE(MAX(item_index),0)+1 n FROM error_item WHERE asset_id=?').get(anchor.id) as {n:number}).n;
    itemId=newId('itm');
    store.db.prepare(`INSERT INTO error_item(id,student_id,batch_id,asset_id,item_index,subject,knowledge_tags,status,text_excerpt,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(itemId,store.studentId,anchor.batch_id,anchor.id,index,q.subject,JSON.stringify(q.tags),'ready_for_reflection',stem.map(f=>f.text).join('\n\n').slice(0,80),now(),now());
    store.db.prepare('INSERT INTO material_item_link(owner_id,question_id,item_id) VALUES (?,?,?)').run(store.studentId,q.id,itemId);
   }else{
    store.db.prepare('UPDATE error_item SET text_excerpt=?,subject=?,knowledge_tags=?,updated_at=? WHERE id=?').run(stem.map(f=>f.text).join('\n\n').slice(0,80),q.subject,JSON.stringify(q.tags),now(),itemId);
   }
  }
 });
}
export function setQuestionIncluded(store:MaterialStore,questionId:string,included:boolean,expectedRevision:number):{itemId:string|null;revision:number} {
 return store.transaction(()=>{
  const q=readQuestion(store,questionId);if(!q)throw new MobileRequestError(404,'not_found','题目不存在。');
  if(typeof included!=='boolean'||!Number.isSafeInteger(expectedRevision))throw new MobileRequestError(400,'invalid_request','收录选项不合法。');
  if(q.revision!==expectedRevision)throw new MobileRequestError(409,'revision_conflict','材料已更新，请刷新后重试。');
  const family=questionFamily(store,q.id);
  for(const id of family){
   store.db.prepare('INSERT INTO material_inclusion(owner_id,question_id,included) VALUES (?,?,?) ON CONFLICT(owner_id,question_id) DO UPDATE SET included=excluded.included').run(store.studentId,id,included?1:0);
   store.db.prepare('UPDATE material_question SET revision=revision+1 WHERE owner_id=? AND id=?').run(store.studentId,id);
  }
  store.db.prepare('INSERT INTO material_inclusion_event(id,owner_id,question_id,included,family_json) VALUES (?,?,?,?,?)').run(newId('min'),store.studentId,q.id,included?1:0,JSON.stringify(family));
  syncMaterialLearning(store);const next=readQuestion(store,q.id)!;return {itemId:next.itemId,revision:next.revision};
 });
}

/** Current source-backed textual observations, including imported answer and unknown fragments.
 * Generated/manual ReferenceAnswer records remain separate; they never become photographed observations. */
export function learningObservationFragments(store:MaterialStore,questionId:string):import('./contracts.js').Fragment[] {
 const id=resolveQuestionId(store,questionId);
 const rows=store.db.prepare(`SELECT f.content_json FROM material_link_event l
 JOIN material_fragment f ON f.owner_id=l.owner_id AND f.id=l.fragment_id AND f.revision=l.fragment_revision
 WHERE l.owner_id=? AND l.question_id=? AND NOT EXISTS (
 SELECT 1 FROM material_link_event n WHERE n.owner_id=l.owner_id AND n.fragment_id=l.fragment_id AND n.revision>l.revision)`)
 .all(store.studentId,id) as {content_json:string}[];
 return rows.map(r=>JSON.parse(r.content_json) as import('./contracts.js').Fragment)
 .filter(f=>f.role!=='question'&&f.role!=='diagram')
 .sort((a,b)=>(a.page??Number.MAX_SAFE_INTEGER)-(b.page??Number.MAX_SAFE_INTEGER)||a.order-b.order||a.fragmentId.localeCompare(b.fragmentId));
}
