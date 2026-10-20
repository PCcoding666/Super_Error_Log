import { learningObservationFragments } from './learning.js';
import type { LearningContext } from '../learning/contracts.js';
import type { CorrectionChange } from '../ai/evidence.js';
import type { MaterialStore } from './store.js';
import { currentLink, readQuestion } from './queries.js';
import type { Fragment } from './contracts.js';

/** A concatenated stem is a view. A single edit must stay inside one source fragment;
 * cross-page/subpart replacements are rejected rather than copied over multiple originals. */
export function applyMaterialTextCorrection(store:MaterialStore,questionId:string,before:LearningContext,after:LearningContext,changes:CorrectionChange[]):number {
 const q=readQuestion(store,questionId)!;const edits=new Map<string,{fragment:Fragment;text:string}>();
 for(const change of changes){
  if(change.field==='questionText'){
   const old=before.questionText,next=after.questionText;let start=0,end=0;
   while(start<Math.min(old.length,next.length)&&old[start]===next[start])start++;
   while(end<old.length-start&&end<next.length-start&&old[old.length-1-end]===next[next.length-1-end])end++;
   let offset=0,found=false;
   for(const f of q.stem.filter(f=>f.role==='question')){
    if(start>=offset&&old.length-end<=offset+f.text.length){
     edits.set(f.fragmentId,{fragment:f,text:f.text.slice(0,start-offset)+next.slice(start,next.length-end)+f.text.slice(old.length-end-offset)});found=true;break;
    }offset+=f.text.length+2;
   }
   if(!found)throw new Error('请一次只修改一段题干，保留材料之间的分段。');
  }else if(change.field==='observation'){
   const f=learningObservationFragments(store,q.id).find(f=>f.fragmentId===change.observationId);
   if(!f)throw new Error('作答材料已变化，请刷新。');edits.set(f.fragmentId,{fragment:f,text:change.after});
  }
 }
 for(const {fragment,text} of edits.values()){
  const revision=(store.db.prepare('SELECT MAX(revision) n FROM material_fragment WHERE owner_id=? AND id=?').get(store.studentId,fragment.fragmentId) as {n:number}).n+1;
  const next={...fragment,text,revision};store.putFragment(next);const link=currentLink(store,fragment.fragmentId)!;
  store.linkFragment(fragment.fragmentId,revision,{questionId:q.id,attemptId:link.attempt_id},link.revision,{reason:'student_transcription'});
 }
 // Only an explicit subject correction establishes stored classification authority.
 // Editing a transcript must not freeze a subject derived from removable sources.
 store.db.prepare('UPDATE material_question SET subject=CASE WHEN ? THEN ? ELSE subject END,tags_json=?,revision=revision+1 WHERE owner_id=? AND id=?')
  .run(Number(changes.some(c=>c.field==='subject')),after.subject,JSON.stringify(after.knowledgeTags),store.studentId,q.id);
 return readQuestion(store,q.id)!.revision;
}

/** Legacy Evidence stays authoritative for its original regions. Mirror only the fragments
 * whose original bridge provenance names that legacy evidence; supplementary pages stay separate. */
export function syncLegacyTranscripts(store:MaterialStore,itemId:string,context:LearningContext):void {
 const mapped=store.db.prepare("SELECT question_id FROM material_legacy_map WHERE owner_id=? AND source_kind='error_item' AND source_key=?").get(store.studentId,itemId) as {question_id:string}|undefined;
 if(!mapped)return;
 const origins=store.db.prepare(`SELECT e.fragment_id,e.basis_json,f.content_json FROM material_link_event e
 JOIN material_fragment f ON f.owner_id=e.owner_id AND f.id=e.fragment_id AND f.revision=e.fragment_revision
 WHERE e.owner_id=? AND e.question_id=? AND json_extract(e.basis_json,'$.source')='legacy'
 AND NOT EXISTS(SELECT 1 FROM material_link_event earlier WHERE earlier.owner_id=e.owner_id AND earlier.fragment_id=e.fragment_id AND earlier.revision<e.revision)`)
 .all(store.studentId,mapped.question_id) as {fragment_id:string;basis_json:string;content_json:string}[];
 for(const origin of origins){
  const basis=JSON.parse(origin.basis_json) as {itemId?:string;regionId?:string;observationId?:string;observationIds?:string[]};
  const original=JSON.parse(origin.content_json) as Fragment;
  let text:string|undefined;
  if(original.role==='question'&&basis.itemId===itemId)text=context.questionText;
  else if(basis.observationId)text=context.observations.find(o=>o.id===basis.observationId)?.text;
  else if(basis.observationIds?.length)text=basis.observationIds.map(id=>context.observations.find(o=>o.id===id)?.text??'').join('\n');
  if(text===undefined)continue;
  const link=currentLink(store,origin.fragment_id);if(!link)continue;
  const current=store.db.prepare('SELECT content_json FROM material_fragment WHERE owner_id=? AND id=? AND revision=?').get(store.studentId,origin.fragment_id,link.fragment_revision) as {content_json:string};
  const fragment=JSON.parse(current.content_json) as Fragment;if(fragment.text===text)continue;
  const revision=(store.db.prepare('SELECT MAX(revision) n FROM material_fragment WHERE owner_id=? AND id=?').get(store.studentId,fragment.fragmentId) as {n:number}).n+1;
  store.putFragment({...fragment,text,revision});
  store.linkFragment(fragment.fragmentId,revision,link.question_id?{questionId:link.question_id,attemptId:link.attempt_id}:null,link.revision,{reason:'legacy_student_transcription',itemId});
 }
 store.db.prepare('UPDATE material_question SET subject=?,tags_json=?,revision=revision+1 WHERE owner_id=? AND id=?').run(context.subject,JSON.stringify(context.knowledgeTags),store.studentId,mapped.question_id);
}
