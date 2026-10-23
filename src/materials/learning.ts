import { SUBJECTS, type Subject } from '../domain/types.js';
import { newId, now } from '../db/connection.js';
import { MobileRequestError } from '../mobile/service.js';
import type { MaterialStore } from './store.js';
import { unsupportedSubject } from './subjects.js';
import { effectiveQuestionStem, readQuestion, resolveQuestionId } from './queries.js';

/** Intent is retained on original identities. Association combines choices with exclusion priority.
 * An explicit choice on the merged question updates its entire current alias family; undo then
 * retains that later student choice for each identity. Events preserve the family acted on. */
export { unsupportedSubject, UNSUPPORTED_SUBJECT_MESSAGE } from './subjects.js';
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
/** inclusionIntent for every current question in one pass (read-only; same exclusion priority). */
export function inclusionIntents(store:MaterialStore):Map<string,boolean> {
 const intents=new Map<string,boolean>();
 for(const row of store.db.prepare('SELECT question_id,included FROM material_inclusion WHERE owner_id=?').all(store.studentId) as {question_id:string;included:number}[]){
  const id=resolveQuestionId(store,row.question_id);
  if(intents.get(id)===false)continue;
  intents.set(id,row.included===1);
 }
 return intents;
}
export function materialPracticeEligible(store:MaterialStore, questionId:string):boolean {
 const q=readQuestion(store,questionId); if(!q||!questionIncluded(store,q.id)) return false;
 if(q.missing.includes('stem')||q.missing.includes('diagram')||q.unresolved.length||!SUBJECTS.includes(q.subject as Subject)) return false;
 // Preserve the v2 low-confidence path. Failed/unchecked or uncertain associations cannot enter.
 return effectiveQuestionStem(store,q.id).every(f=>(f.check==='passed'||f.check==='low')&&!f.uncertainties.includes('missing_diagram'));
}
/** Full marks printed with the stem, e.g. 「（6分）」「(本题 12 分)」「（满分10分）」. */
export function fullMarksOf(stem:string):number|null {
 const m=/[（(]\s*(?:本小?题)?\s*(?:满分)?\s*(?:共)?\s*(\d+(?:\.\d+)?)\s*分\s*[)）]/u.exec(stem);
 const n=m?Number(m[1]):NaN;return Number.isFinite(n)&&n>0?n:null;
}
/** Visible teacher marks that mean "not full marks". Whole-mark patterns only, so「没有错误」「不错」never count.
 * Includes ×, half ticks, circles, 「-6」 without 分, 「扣2」, a fraction below full marks,
 * and a bare score below the stem's printed full marks. */
export function teacherMarkMeansWrong(raw:string,fullMarks:number|null=null):boolean {
 const text=raw.trim().replace(/[。.!！,，;；]+$/u,'').replace(/\s+/gu,' ');
 if(!text||text.length>60)return false;
 // A cross followed by the teacher's comment, e.g.「× 漏了 x≤5」. The cross itself is the verdict.
 if(/^[×✗✘╳✕❌]\s*\S/u.test(text))return true;
 // A transcribed Latin X: alone, or followed by a comment (not an expression such as「x = 5」).
 if(/^[Xx](?:\s+(?![=<>≤≥+\-−])\S.*)?$/u.test(text)&&!/(?<!不)正确|很好|不错|真棒|满分/u.test(text))return true;
 if(text.length>24)return false;
 if(/^(?:错|错误|答错|做错|不对|不正确|答案错误|错了|半对|对一半|部分正确|不完整|未答|没做|空)$/u.test(text))return true;
 if(/^[^\p{L}\p{N}]*[×✗✘╳✕❌][^\p{L}\p{N}]*$/u.test(text))return true;
 // Half ticks: a tick with a slash through or beside it, or the word on its own.
 if(/^(?:[√✓✔]\s*[\/／\\丿]|[\/／\\]\s*[√✓✔]|半\s*[√✓✔])$/u.test(text))return true;
 // A circle around/next to the answer is a common error mark.
 if(/^[○◯〇⭕◎]$/u.test(text))return true;
 if(/^(?:[-−－–]\s*\d+(?:\.\d+)?\s*分?|扣\s*\d+(?:\.\d+)?\s*分?)(?:\s+.*)?$/u.test(text))return true;
 if(/^(?:[×✗✘╳✕]\s*)?[-−－–]\s*\d+(?:\.\d+)?\s*分?$/u.test(text))return true;
 const fraction=/^(?:得\s*)?(\d+(?:\.\d+)?)\s*分?\s*[\/／]\s*(\d+(?:\.\d+)?)\s*分?$/u.exec(text);
 if(fraction){const earned=Number(fraction[1]),total=Number(fraction[2]);return total>0&&earned<total;}
 const bare=/^(?:得\s*)?[+＋]?\s*(\d+(?:\.\d+)?)\s*分?$/u.exec(text);
 if(bare&&fullMarks!==null)return Number(bare[1])<fullMarks;
 return false;
}
/** A tick on its own (optionally with full marks), or the plain word for "right". Never a half tick. */
export function teacherMarkMeansRight(raw:string,fullMarks:number|null=null):boolean {
 const text=raw.trim().replace(/[。.!！,，;；]+$/u,'').replace(/\s+/gu,' ');
 if(!text||text.length>24||teacherMarkMeansWrong(text,fullMarks))return false;
 if(/^(?:对|正确|全对|满分|[√✓✔☑]+)$/u.test(text))return true;
 const scored=/^[√✓✔☑]\s*(?:得\s*)?[+＋]?\s*(\d+(?:\.\d+)?)\s*分?$/u.exec(text);
 return !!scored&&fullMarks!==null&&Number(scored[1])>=fullMarks;
}
/** Every certain teacher mark on the question is a tick, and no current AI grade says otherwise. */
export function markedRight(q:import('./contracts.js').QuestionBundle):boolean {
 if(!q.teacherMarks.length||q.grades.some(g=>!g.stale&&g.result!=='correct'))return false;
 const full=fullMarksOf(q.stem.filter(f=>f.role==='question').map(f=>f.text).join('\n'));
 return q.teacherMarks.every(f=>f.check==='passed'&&!f.uncertainties.length&&teacherMarkMeansRight(f.text,full));
}
/** Photo material without a printed number or stem (work, marks, corrections): the model saw it on the page
 * but could not place it. It stays where it is (no inferred association) and is summarized per photo instead
 * of listed as a question. Anything with learning or result history is still listed. */
export function unplacedMaterial(q:import('./contracts.js').QuestionBundle):boolean {
 return q.number===null&&!q.itemId&&!q.answers.length&&!q.grades.length&&!q.stem.some(f=>f.role==='question')
  &&(q.stem.length>0||q.teacherMarks.length>0||q.attempts.some(a=>a.fragments.length>0));
}
const numbered=new Intl.Collator('zh-CN',{numeric:true});
/** Paper, then printed number (2 before 10, 3(1) after 3), then photo. A question without a paper is
 * placed by the photo of its stem (or its first material). Unnumbered questions follow their paper. */
export function sortQuestions<T extends import('./contracts.js').QuestionBundle>(store:MaterialStore,questions:T[]):T[] {
 const photos=new Map((store.db.prepare('SELECT id FROM material_asset WHERE owner_id=? ORDER BY created_at,rowid').all(store.studentId) as {id:string}[]).map((a,i)=>[a.id,i]));
 const anchor=(q:T)=>{const stem=q.stem.filter(f=>f.role==='question');const fragments=stem.length?stem:[...q.stem,...q.attempts.flatMap(a=>a.fragments),...q.teacherMarks];
  return Math.min(Number.MAX_SAFE_INTEGER,...fragments.map(f=>photos.get(f.assetId)??Number.MAX_SAFE_INTEGER));};
 const keys=new Map(questions.map(q=>[q.id,{photo:anchor(q),paper:q.documentId??`photo:${anchor(q)}`}]));
 const paperRank=new Map<string,number>();
 for(const {photo,paper} of keys.values())paperRank.set(paper,Math.min(paperRank.get(paper)??Number.MAX_SAFE_INTEGER,photo));
 return [...questions].sort((a,b)=>{
  const x=keys.get(a.id)!,y=keys.get(b.id)!;
  return paperRank.get(x.paper)!-paperRank.get(y.paper)!||x.paper.localeCompare(y.paper)
   ||(a.number===null?1:0)-(b.number===null?1:0)||numbered.compare(a.number??'',b.number??'')
   ||x.photo-y.photo||a.id.localeCompare(b.id);
 });
}
function automaticMistake(store:MaterialStore,questionId:string):boolean {
 const q=readQuestion(store,questionId)!;
 if(unsupportedSubject(q.subject)) return false;
 if(q.grades.some(g=>!g.stale&&(g.result==='incorrect'||g.result==='partial'||(!!g.score&&typeof g.score.total==="number"&&g.score.total>0&&g.score.earned<g.score.total)))) return true;
 const full=fullMarksOf(q.stem.filter(f=>f.role==='question').map(f=>f.text).join('\n'));
 return q.teacherMarks.some(f=>f.check==='passed'&&!f.uncertainties.length&&teacherMarkMeansWrong(f.text,full));
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
/** Persists one validated intent without the learning projection; callers sync once. */
function recordInclusion(store:MaterialStore,questionId:string,included:boolean,expectedRevision:number):string {
 const q=readQuestion(store,questionId);if(!q)throw new MobileRequestError(404,'not_found','题目不存在。');
 if(typeof included!=='boolean'||!Number.isSafeInteger(expectedRevision))throw new MobileRequestError(400,'invalid_request','收录选项不合法。');
 if(q.revision!==expectedRevision)throw new MobileRequestError(409,'revision_conflict','材料已更新，请刷新后重试。');
 const family=questionFamily(store,q.id);
 for(const id of family){
  store.db.prepare('INSERT INTO material_inclusion(owner_id,question_id,included) VALUES (?,?,?) ON CONFLICT(owner_id,question_id) DO UPDATE SET included=excluded.included').run(store.studentId,id,included?1:0);
  store.db.prepare('UPDATE material_question SET revision=revision+1 WHERE owner_id=? AND id=?').run(store.studentId,id);
 }
 store.db.prepare('INSERT INTO material_inclusion_event(id,owner_id,question_id,included,family_json) VALUES (?,?,?,?,?)').run(newId('min'),store.studentId,q.id,included?1:0,JSON.stringify(family));
 return q.id;
}
export function setQuestionIncluded(store:MaterialStore,questionId:string,included:boolean,expectedRevision:number):{itemId:string|null;revision:number} {
 return store.transaction(()=>{
  const id=recordInclusion(store,questionId,included,expectedRevision);
  syncMaterialLearning(store);const next=readQuestion(store,id)!;return {itemId:next.itemId,revision:next.revision};
 });
}

/** Questions the student can still add in one step: a readable stem, a supported subject,
 * not yet in the notebook, never explicitly removed and not ticked by the teacher.
 * Grouped by the photo of their first stem, in paper and question-number order. */
export function notYetIncluded(store:MaterialStore,questions=store.listQuestions(),intents=inclusionIntents(store)):{assetId:string;questions:import('./contracts.js').QuestionBundle[]}[] {
 const groups=new Map<string,import('./contracts.js').QuestionBundle[]>();
 for(const q of sortQuestions(store,questions)){
  if(q.itemId||q.missing.includes('stem')||unsupportedSubject(q.subject)||intents.has(q.id)||markedRight(q))continue;
  const assetId=q.stem.find(f=>f.role==='question')!.assetId;
  groups.set(assetId,[...(groups.get(assetId)??[]),q]);
 }
 return [...groups].map(([assetId,questions])=>({assetId,questions}));
}
/** Notebook-level nudge: questions still waiting to be added, failed photos, photos in progress. Read-only. */
export function materialIntakeSummary(store:MaterialStore):{pending:number;failed:number;processing:number} {
 const rows=store.db.prepare(`SELECT j.state FROM material_job j WHERE j.owner_id=? AND j.kind='extract'
  AND NOT EXISTS (SELECT 1 FROM material_job n WHERE n.owner_id=j.owner_id AND n.kind='extract' AND n.asset_id=j.asset_id AND n.rowid>j.rowid)`).all(store.studentId) as {state:string}[];
 return {pending:notYetIncluded(store).reduce((n,g)=>n+g.questions.length,0),failed:rows.filter(r=>r.state==='failed'||r.state==='interrupted').length,processing:rows.filter(r=>r.state==='queued'||r.state==='running').length};
}
/** Batch inclusion. Each pick carries the revision the student saw; a changed question is skipped, never guessed. */
export function includeQuestions(store:MaterialStore,picks:{questionId:string;revision:number}[]):{included:number;skipped:number} {
 return store.transaction(()=>{
  let skipped=0;const recorded:string[]=[];const already:string[]=[];const seen=new Set<string>();
  // Validate and persist every intent first; the learning projection then runs once for the whole batch.
  for(const pick of picks){
   const q=readQuestion(store,pick.questionId);
   if(!q||seen.has(q.id)||unsupportedSubject(q.subject)){skipped++;continue;}
   seen.add(q.id);
   if(q.itemId&&inclusionIntent(store,q.id)!==false){already.push(q.id);continue;}
   try{recorded.push(recordInclusion(store,q.id,true,pick.revision));}
   catch(error){if(error instanceof MobileRequestError&&[400,404,409].includes(error.status)){skipped++;continue;}throw error;}
  }
  if(recorded.length)syncMaterialLearning(store);
  const landed=recorded.filter(id=>readQuestion(store,id)?.itemId).length;
  return {included:already.length+landed,skipped:skipped+recorded.length-landed};
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
