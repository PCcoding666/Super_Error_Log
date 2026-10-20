import { ensureStudentProfile } from '../services/studentService.js';
import { getDb } from '../db/connection.js';
import { getEvidence } from '../services/evidenceService.js';
import { MaterialStore } from '../materials/store.js';
import { effectiveQuestionStem, readQuestion } from '../materials/queries.js';
import { inclusionIntent, materialPracticeEligible, questionIncluded, learningObservationFragments } from '../materials/learning.js';
import { validateLearningContext } from '../ai/evidence.js';
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
