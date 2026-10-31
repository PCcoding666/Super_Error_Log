import { ATTEMPT_STATES, CAUSES } from '../../src/domain/types.js';
import { describe, expect, it, vi } from 'vitest';
import { getDb, newId, now } from '../../src/db/connection.js';
import { localDayText } from '../../src/domain/calendarDay.js';
import { ensureStudentProfile } from '../../src/services/studentService.js';
import { MaterialStore } from '../../src/materials/store.js';
import { setQuestionIncluded, syncMaterialLearning } from '../../src/materials/learning.js';
import { getLearningContext, getLearningSource } from '../../src/learning/sources.js';
import { getLearningWeek, recommendLearningPractice, createLearningPractice, getLearningPractice } from '../../src/learning/queries.js';
import { directCorrection } from '../../src/v2/correctionService.js';
import { askFollowup, submitV2Reflection } from '../../src/v2/reflectionService.js';
import type { Fragment } from '../../src/materials/contracts.js';

export function fixture(owner=ensureStudentProfile().id) {
 const db=getDb(), store=new MaterialStore(db,owner), batch=newId('bat'), asset=newId('ast');
 db.prepare('INSERT INTO source_batch(id,student_id,created_at) VALUES (?,?,?)').run(batch,owner,now());
 db.prepare('INSERT INTO source_asset(id,batch_id,filename,mime,size,content_hash,storage_path,created_at) VALUES (?,?,?,?,?,?,?,?)').run(asset,batch,'synthetic.jpg','image/jpeg',1,'hash','/synthetic.jpg',now());
 const capture=store.createCapture(crypto.randomUUID());
 db.prepare('INSERT INTO material_asset(id,owner_id,capture_id,source_asset_id) VALUES (?,?,?,?)').run(asset,owner,capture.id,asset);
 const question=store.createQuestion({number:'1',subject:'数学'}).id;
 const add=(role:Fragment['role'],text:string,questionId=question,attemptId:string|null=null,extra:Partial<Fragment>={})=>{
  const f:Fragment={assetId:asset,fragmentId:newId('mfr'),revision:1,box:{x:0,y:0,width:1,height:1},sourceHash:'hash',role,text,number:'1',subpart:null,page:null,order:0,requiresDiagram:false,check:'passed',uncertainties:[],...extra};
  store.putFragment(f);store.linkFragment(f.fragmentId,1,{questionId,attemptId});return f;
 };
 return {db,store,question,asset,add};
}
describe('material learning',()=>{
 it('projects one learning item and keeps incomplete questions out of practice',()=>{
  const {store,question,add,db}=fixture();
  expect(setQuestionIncluded(store,question,true,store.getQuestion(question)!.revision).itemId).toBeNull();
  add('question','求 1+1');syncMaterialLearning(store);
  const item=store.getQuestion(question)!.itemId!; expect(item).toBeTruthy();
  const attempt=store.createAttempt(question);add('student_work','1+1=3',question,attempt.id);
  const second=store.createAttempt(question);add('student_work','1+1=2',question,second.id);syncMaterialLearning(store);
  expect(db.prepare('SELECT item_id FROM material_item_link WHERE question_id=?').all(question)).toHaveLength(1);
  expect(getLearningSource(item)).toEqual({kind:'material',questionId:question});
  expect(getLearningWeek('/nonexistent').items.map(c=>c.source.kind)).toContain('material');
  expect(recommendLearningPractice('/nonexistent').recommended.map(c=>c.id)).toContain(item);
  expect(db.prepare('SELECT * FROM evidence_record WHERE item_id=?').get(item)).toBeUndefined();
  const packet=createLearningPractice({itemIds:[item]});expect(packet.ok).toBe(true);if(!packet.ok)return;
  setQuestionIncluded(store,question,false,store.getQuestion(question)!.revision);
  expect(getLearningPractice(packet.detail.id)!.items.map(c=>c.id)).toContain(item);
  expect(recommendLearningPractice('/nonexistent').recommended.map(c=>c.id)).not.toContain(item);
 });
 it('preserves original sources and requires student-owned reflection',async()=>{
  const {store,question,add,db}=fixture();add('question','求 2+2');const attempt=store.createAttempt(question);const work=add('student_work','2+2=5',question,attempt.id);
  const item=setQuestionIncluded(store,question,true,store.getQuestion(question)!.revision).itemId!;
  const before=getLearningContext(item)!;expect(before.context.observations[0]).toMatchObject({id:work.fragmentId,regionId:null});
  expect((await askFollowup(item)).ok).toBe(true);expect(db.prepare('SELECT * FROM error_diagnosis WHERE item_id=?').all(item)).toHaveLength(0);
  const changed=directCorrection(item,{revision:before.revision,changes:[{field:'questionText',before:'求 2+2',after:'计算 2+2'}]});expect(changed.ok).toBe(true);expect(db.prepare('SELECT text_excerpt FROM error_item WHERE id=?').get(item)).toEqual({text_excerpt:'计算 2+2'});
  expect(store.getQuestion(question)!.stem[0]!.sourceHash).toBe('hash');expect(db.prepare('SELECT * FROM material_fragment WHERE id=?').all(store.getQuestion(question)!.stem[0]!.fragmentId)).toHaveLength(2);
  expect(submitV2Reflection(item,{attemptState:'',cause:'',masteryFeeling:1}).ok).toBe(false);
  expect(submitV2Reflection(item,{attemptState:ATTEMPT_STATES[0],cause:CAUSES[0],masteryFeeling:1,summary:'我需要检查计算'}).ok).toBe(true);
  expect(db.prepare('SELECT submitted_by FROM error_diagnosis WHERE item_id=?').all(item)).toEqual([{submitted_by:'student'}]);
 });
});

import { materialPracticeEligible, inclusionIntent } from '../../src/materials/learning.js';
import { relink, undoLink, linkRevision } from '../../src/materials/links.js';
import { answerBasis, gradeBasis, readQuestion } from '../../src/materials/queries.js';
import { backfillLegacyMaterials } from '../../src/materials/legacy.js';
import { getWeek } from '../../src/v2/weekService.js';
import { validateLearningContext, validateEvidence } from '../../src/ai/evidence.js';
import { submitLearningReturns } from '../../src/v2/returnService.js';
import { make, makeInput } from '../../src/web/weekPlan.js';

it('keeps inclusion across alias merge, explicit recovery, and safe undo',()=>{
 const {store,question,add}=fixture();const target=store.createQuestion({number:'1',subject:'数学'}).id;
 const work=add('student_work','我的答案：2',question,store.createAttempt(question).id);const targetAttempt=store.createAttempt(target).id;setQuestionIncluded(store,question,false,store.getQuestion(question)!.revision);
 add('question','求 1+1',target);setQuestionIncluded(store,target,true,store.getQuestion(target)!.revision);
 const item=store.getQuestion(target)!.itemId;
 const change=relink(store,{fragmentIds:[work.fragmentId],target:{questionId:target,attemptId:targetAttempt},expectedRevision:linkRevision(store)});
 expect(store.getQuestion(question)!.id).toBe(target);expect(inclusionIntent(store,target)).toBe(false);expect(materialPracticeEligible(store,target)).toBe(false);
 setQuestionIncluded(store,target,true,store.getQuestion(target)!.revision);
 expect(inclusionIntent(store,question)).toBe(true);expect(materialPracticeEligible(store,target)).toBe(true);expect(store.getQuestion(target)!.itemId).toBe(item);
 expect(()=>undoLink(store,change.id,linkRevision(store))).toThrow(/更新/);
 expect(JSON.parse((store.db.prepare('SELECT family_json FROM material_inclusion_event WHERE question_id=? ORDER BY rowid DESC LIMIT 1').get(target) as {family_json:string}).family_json).sort()).toEqual([question,target].sort());
 const separate=fixture();const target2=separate.store.createQuestion({subject:'数学'}).id;
 const only=separate.add('student_work','我的答案：4',separate.question,separate.store.createAttempt(separate.question).id);const targetAttempt2=separate.store.createAttempt(target2).id;setQuestionIncluded(separate.store,separate.question,true,separate.store.getQuestion(separate.question)!.revision);
 separate.add('question','求 2+2',target2);
 const moved=relink(separate.store,{fragmentIds:[only.fragmentId],target:{questionId:target2,attemptId:targetAttempt2},expectedRevision:linkRevision(separate.store)});
 expect(inclusionIntent(separate.store,target2)).toBe(true);const linkedItem=separate.store.getQuestion(target2)!.itemId;expect(linkedItem).toBeTruthy();
 undoLink(separate.store,moved.id,linkRevision(separate.store));
 expect(inclusionIntent(separate.store,separate.question)).toBe(true);expect(inclusionIntent(separate.store,target2)).toBeNull();
 expect(separate.store.getQuestion(target2)!.itemId).toBe(linkedItem);expect(materialPracticeEligible(separate.store,target2)).toBe(false);
});

it('requires the right checked diagram and genuine verification provenance',async()=>{
 const {store,question,add,db}=fixture();const stem=add('question','如图求角度',question,null,{requiresDiagram:true,subpart:'a',check:'low',uncertainties:['missing_diagram']});
 const item=setQuestionIncluded(store,question,true,store.getQuestion(question)!.revision).itemId!;
 expect(materialPracticeEligible(store,question)).toBe(false);
 add('diagram','图',question,null,{subpart:'b'});expect(materialPracticeEligible(store,question)).toBe(false);
 add('diagram','图',question,null,{subpart:'a',check:'unchecked'});expect(materialPracticeEligible(store,question)).toBe(false);
 add('diagram','图',question,null,{subpart:'a'});expect(materialPracticeEligible(store,question)).toBe(false);
 expect((await askFollowup(item)).ok).toBe(false);
 const {fragmentId,role,box,number,subpart,page,order,requiresDiagram}=stem;
 const region={fragmentId,role,box,number,subpart,page,order,requiresDiagram};
 const execution={stages:{'material-v1:1:locate':{state:'succeeded',result:{value:{candidates:[{...region,key:'candidate'}]}}},'material-v1:1:read:candidate':{state:'succeeded',result:{value:{text:stem.text,uncertainties:[]}}},'material-v1:1:verify:candidate':{state:'succeeded',result:{value:{check:'passed',uncertainties:[]}}}}};
 db.prepare('INSERT INTO material_job(id,owner_id,request_id,kind,asset_id,state,input_json,result_json) VALUES (?,?,?,?,?,?,?,?)').run(newId('mjb'),store.studentId,crypto.randomUUID(),'extract',stem.assetId,'succeeded',JSON.stringify({execution}),JSON.stringify({assetId:stem.assetId,revision:1,sourceHash:stem.sourceHash}));
 // The extra unchecked diagram remains unsafe; remove it through an actual link event.
 for(const f of store.getQuestion(question)!.stem.filter(f=>f.role==='diagram'&&f.check==='unchecked'))store.linkFragment(f.fragmentId,f.revision,null);
 expect(materialPracticeEligible(store,question)).toBe(true);
 expect(getLearningContext(item)!.context.uncertainties).not.toContain('missing_diagram');
 expect(readQuestion(store,question)!.stem.find(f=>f.fragmentId===stem.fragmentId)).toMatchObject({check:'low',uncertainties:['missing_diagram']});
 const changed=directCorrection(item,{revision:getLearningContext(item)!.revision,changes:[{field:'questionText',before:stem.text,after:'如图求角 A'}]});expect(changed.ok).toBe(true);
 expect(materialPracticeEligible(store,question)).toBe(false);expect(getLearningContext(item)!.context.uncertainties).toContain('missing_diagram');
});

it('keeps unmarked, uncertain, stale and excluded work out of automatic inclusion',()=>{
 const {store,question,add,db}=fixture();add('question','求 3+3');add('teacher_mark','已批改');expect(store.getQuestion(question)!.itemId).toBeNull();
 add('teacher_mark','没有错误');expect(store.getQuestion(question)!.itemId).toBeNull();
 add('teacher_mark','×',question,null,{check:'unchecked'});expect(store.getQuestion(question)!.itemId).toBeNull();
 const attempt=store.createAttempt(question);
 const seed=(result:'uncertain'|'incorrect',stale:boolean)=>{const id=newId('mgr');const g={id,attemptId:attempt.id,answerIds:[],basisKey:'x',result,findings:[],score:null,stale,run:{}};
 db.prepare('INSERT INTO material_grade(id,owner_id,attempt_id,basis_key,content_json,stale) VALUES (?,?,?,?,?,?)').run(id,store.studentId,attempt.id,'x',JSON.stringify(g),Number(stale));syncMaterialLearning(store);};
 seed('uncertain',false);seed('incorrect',true);expect(store.getQuestion(question)!.itemId).toBeNull();
 setQuestionIncluded(store,question,false,store.getQuestion(question)!.revision);seed('incorrect',false);add('teacher_mark','×');expect(store.getQuestion(question)!.itemId).toBeNull();
 setQuestionIncluded(store,question,true,store.getQuestion(question)!.revision);const item=store.getQuestion(question)!.itemId!;
 expect(db.prepare('SELECT status FROM error_item WHERE id=?').get(item)).toEqual({status:'ready_for_reflection'});
 expect(db.prepare('SELECT * FROM error_diagnosis WHERE item_id=?').all(item)).toHaveLength(0);expect(db.prepare('SELECT * FROM review_attempt WHERE item_id=?').all(item)).toHaveLength(0);
});

it('projects only edited source transcripts and invalidates actual answer/grade dependencies',()=>{
 const {store,question,add,db}=fixture();const first=add('question','第一页题干',question,null,{page:1});const second=add('question','第二页条件',question,null,{page:2,subpart:'b'});
 const attempt=store.createAttempt(question);const work=add('student_work','x=12345',question,attempt.id);
 const item=setQuestionIncluded(store,question,true,store.getQuestion(question)!.revision).itemId!;
 const answer=answerBasis(store,question),grade=gradeBasis(store,question,attempt.id,[]);
 const answerId=newId('man');db.prepare('INSERT INTO material_answer(id,revision,owner_id,question_id,source,basis_key,dependencies_json,content_json) VALUES (?,?,?,?,?,?,?,?)').run(answerId,1,store.studentId,question,'ai',answer.basisKey,JSON.stringify(answer.dependencies),JSON.stringify({id:answerId,questionId:question,revision:1,source:'ai',text:'2',fragmentIds:[],basisKey:answer.basisKey,stale:false,run:null,subpart:null,claimedSource:null}));
 const gradeId=newId('mgr');db.prepare('INSERT INTO material_grade(id,owner_id,attempt_id,basis_key,dependencies_json,content_json) VALUES (?,?,?,?,?,?)').run(gradeId,store.studentId,attempt.id,grade.basisKey,JSON.stringify(grade.dependencies),JSON.stringify({id:gradeId,attemptId:attempt.id,answerIds:[],basisKey:grade.basisKey,result:'incorrect',findings:[],score:null,stale:false,run:{}}));
 const changed=directCorrection(item,{revision:getLearningContext(item)!.revision,changes:[{field:'observation',observationId:work.fragmentId,before:work.text,after:'x=12346'}]});expect(changed.ok).toBe(true);
 expect(db.prepare('SELECT stale FROM material_answer WHERE id=?').get(answerId)).toEqual({stale:0});expect(db.prepare('SELECT stale FROM material_grade WHERE id=?').get(gradeId)).toEqual({stale:1});
 const context=getLearningContext(item)!;expect(directCorrection(item,{revision:context.revision,changes:[{field:'questionText',before:context.context.questionText,after:'第一页题干\n\n第二页新条件'}]}).ok).toBe(true);
 expect(store.getQuestion(question)!.stem.find(f=>f.fragmentId===first.fragmentId)!.revision).toBe(1);expect(store.getQuestion(question)!.stem.find(f=>f.fragmentId===second.fragmentId)).toMatchObject({text:'第二页新条件',revision:2,sourceHash:second.sourceHash,box:second.box,check:second.check});
 expect(db.prepare('SELECT stale FROM material_answer WHERE id=?').get(answerId)).toEqual({stale:1});
 const revision=getLearningContext(item)!.revision;expect(directCorrection(item,{revision,changes:[{field:'questionText',before:getLearningContext(item)!.context.questionText,after:'把所有页都换掉'}]}).ok).toBe(false);
 expect(directCorrection(item,{revision,changes:[{field:'observation',observationId:work.fragmentId,before:'x=12346',after:'这是全新正确解答且完全覆盖学生原作的错误过程'}]}).ok).toBe(false);
});

it('keeps legacy source identity, original schema and mapped transcripts after later supplementation',()=>{
 const {store,question,add,db,asset}=fixture();add('question','旧题干');const item=setQuestionIncluded(store,question,true,store.getQuestion(question)!.revision).itemId!;
 // Create a genuinely legacy item separately, then run the same backfill used by the bridge.
 const old=newId('itm'),jobId=crypto.randomUUID();const anchor=db.prepare('SELECT batch_id FROM source_asset WHERE id=?').get(asset) as {batch_id:string};
 db.prepare('INSERT INTO error_item(id,student_id,batch_id,asset_id,item_index,status,text_excerpt,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(old,store.studentId,anchor.batch_id,asset,9,'ready_for_reflection','原识别',now(),now());
 db.prepare('INSERT INTO mobile_item_link(item_id,job_id,question_id,question_revision) VALUES (?,?,?,?)').run(old,jobId,crypto.randomUUID(),1);
 db.prepare('INSERT INTO v2_photo(job_id,student_id,registered_at) VALUES (?,?,?)').run(jobId,store.studentId,now());
 const evidence={version:1,questionNumber:'1',questionText:'原识别',subject:'数学',chapter:'',knowledgeTags:[],questionType:'',questionRegion:{x:0,y:0,width:1,height:1},requiresDiagram:false,regions:[],observations:[],uncertainties:[]};
 db.prepare('INSERT INTO evidence_record(item_id,content_json,verified,updated_at) VALUES (?,?,?,?)').run(old,JSON.stringify(evidence),1,now());
 expect(backfillLegacyMaterials(db).mapped).toBeGreaterThan(0);expect(backfillLegacyMaterials(db).mapped).toBe(0);
 const mapped=db.prepare('SELECT question_id FROM material_item_link WHERE item_id=?').get(old) as {question_id:string};add('reference_answer','补充答案',mapped.question_id);
 expect(getLearningSource(old)).toEqual({kind:'legacy',jobId});expect(getLearningSource(item)?.kind).toBe('material');
 const all=getLearningWeek('/missing').items;expect(all.filter(c=>c.id===old)).toHaveLength(1);expect(all.map(c=>c.source.kind)).toEqual(expect.arrayContaining(['legacy','material']));
 const legacy=getWeek('/missing').items.find(c=>c.id===old)!;expect(legacy.jobId).toBe(jobId);expect(legacy).not.toHaveProperty('source');
 const record=getLearningContext(old)!;expect(directCorrection(old,{revision:record.revision,changes:[{field:'questionText',before:'原识别',after:'修正原识别'}]}).ok).toBe(true);
 expect(store.getQuestion(mapped.question_id)!.stem[0]).toMatchObject({text:'修正原识别',revision:2,check:'passed'});
 expect(store.getQuestion(mapped.question_id)!.answers[0]!.text).toBe('补充答案');
 setQuestionIncluded(store,mapped.question_id,false,store.getQuestion(mapped.question_id)!.revision);
 expect(getLearningWeek('/missing').items.map(c=>c.id)).not.toContain(old);expect(getWeek('/missing').items.map(c=>c.id)).not.toContain(old);
 const rejected=recommendLearningPractice('/missing');expect([...rejected.recommended,...rejected.others].map(c=>c.id)).not.toContain(old);
 setQuestionIncluded(store,mapped.question_id,true,store.getQuestion(mapped.question_id)!.revision);
 expect(getLearningWeek('/missing').items.find(c=>c.id===old)!.source).toEqual({kind:'legacy',jobId});
 const restored=recommendLearningPractice('/missing');expect([...restored.recommended,...restored.others].map(c=>c.id)).toContain(old);
});

it('validates text context without pretending it establishes full image evidence',()=>{
 const {store,question,add}=fixture();add('question','题干');const item=setQuestionIncluded(store,question,true,store.getQuestion(question)!.revision).itemId!;const context=getLearningContext(item)!.context;
 expect(validateLearningContext(context)).toEqual(context);expect(()=>validateEvidence(context)).toThrow();
 const plan=make(makeInput({weekKey:'2026-W43',today:new Date(),materialSaved:2,weekItemCount:1}));
 expect(plan.steps.find(s=>s.kind==='pick')).toMatchObject({title:'查看材料',isOptional:true,isDone:true});expect(plan.next?.caption).toContain('可以结束');
});

it('keeps delayed independent return rules for material practice',()=>{
 const {store,question,add,db}=fixture();add('question','延迟重做题');const item=setQuestionIncluded(store,question,true,store.getQuestion(question)!.revision).itemId!;
 const packet=createLearningPractice({itemIds:[item]});expect(packet.ok).toBe(true);if(!packet.ok)return;
 db.prepare("UPDATE review_packet SET status='generated',generated_at=? WHERE id=?").run(now(),packet.detail.id);
 db.prepare("UPDATE error_item SET status='packet_generated' WHERE id=?").run(item);
 const response=submitLearningReturns(packet.detail.id,{results:[{itemId:item,completion:'independent',correct:true,performedOn:localDayText(new Date())}]});expect(response.ok).toBe(true);
 expect(db.prepare('SELECT status FROM error_item WHERE id=?').get(item)).toEqual({status:'attempted'});
});

// 作答日、首次打印日都按进程时区的日历日算（生产 Asia/Shanghai）。北京时间 0–8 点 UTC 还是前一天：
// 拿 now().slice(0,10) 当作答日会被拒收，题留在未回传的包里，下次建包就 409「当前不可安排」。
it('accepts a paper return on the local calendar day between 00:00 and 08:00 Beijing time',()=>{
 const timeZone=process.env.TZ;process.env.TZ='Asia/Shanghai';
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-31T18:30:00.000Z'));
 try{
  expect(localDayText(new Date())).toBe('2026-11-01');expect(now().slice(0,10)).toBe('2026-10-31');
  const {store,question,add,db}=fixture();add('question','凌晨回传题');const item=setQuestionIncluded(store,question,true,store.getQuestion(question)!.revision).itemId!;
  const packet=createLearningPractice({itemIds:[item]});expect(packet.ok).toBe(true);if(!packet.ok)return;
  db.prepare("UPDATE review_packet SET status='generated',generated_at=? WHERE id=?").run(now(),packet.detail.id);
  db.prepare("UPDATE error_item SET status='packet_generated' WHERE id=?").run(item);
  const returned=(performedOn:string)=>submitLearningReturns(packet.detail.id,{results:[{itemId:item,completion:'independent',correct:true,performedOn}]});
  expect(returned('2026-10-31')).toMatchObject({ok:true,results:[{ok:false,error:'实际作答日期不能早于复习包首次打印日期'}]});
  // 当天做对仍只算 attempted，不算掌握；题回到候选，可以排进下一份练习。
  expect(returned('2026-11-01')).toMatchObject({ok:true,results:[{ok:true,toStatus:'attempted'}]});
  expect(createLearningPractice({itemIds:[item]})).toMatchObject({ok:true});
 }finally{vi.useRealTimers();if(timeZone===undefined)delete process.env.TZ;else process.env.TZ=timeZone;}
});

it('does not switch the current worker identity for a foreign item or packet',()=>{
 const db=getDb(),other=newId('stu');db.prepare('INSERT INTO student_profile(id,nickname,created_at) VALUES (?,?,?)').run(other,'Synthetic other',now());
 const {store,question,add}=fixture(other);add('question','另一个学生的题');const item=setQuestionIncluded(store,question,true,store.getQuestion(question)!.revision).itemId!;
 expect(getLearningSource(item)).toBeNull();expect(getLearningContext(item)).toBeNull();expect(createLearningPractice({itemIds:[item]})).toMatchObject({ok:false,httpStatus:409});
 expect(directCorrection(item,{revision:1,changes:[]})).toMatchObject({ok:false,httpStatus:404});
 expect(getLearningWeek('/missing').items.map(c=>c.id)).not.toContain(item);
});
it('retains unknown subject materials without inventing a learning classification',()=>{
 const {store,question,add,db}=fixture();db.prepare('UPDATE material_question SET subject=NULL WHERE id=?').run(question);add('question','学科未识别');
 const item=setQuestionIncluded(store,question,true,store.getQuestion(question)!.revision).itemId!;
 expect(item).toBeTruthy();expect(getLearningContext(item)).toBeNull();expect(materialPracticeEligible(store,question)).toBe(false);
});
it('exposes imported answer observations by fragment ID and appends source-aware corrections',()=>{
 const {store,question,add,db}=fixture();add('question','1+1');const answer=add('reference_answer','参考答案：3');const item=setQuestionIncluded(store,question,true,store.getQuestion(question)!.revision).itemId!;
 const before=getLearningContext(item)!;expect(before.context.observations).toContainEqual({id:answer.fragmentId,kind:'reference_answer',text:answer.text,regionId:null,confidence:1});
 expect(directCorrection(item,{revision:before.revision,changes:[{field:'observation',observationId:answer.fragmentId,before:answer.text,after:'参考答案：2'}]}).ok).toBe(true);
 expect(getLearningContext(item)!.context.observations.find(o=>o.id===answer.fragmentId)!.text).toBe('参考答案：2');
 expect(db.prepare('SELECT content_json FROM material_fragment WHERE id=? ORDER BY revision').all(answer.fragmentId)).toHaveLength(2);
 expect(store.getQuestion(question)!.answers[0]!.text).toBe('参考答案：2');
});

import { assignDocument, assetLinkRevision } from '../../src/materials/links.js';
it.each([true,false])('retains provisional photo-answer inclusion %s through document merge and undo',included=>{
 const provisional=fixture(),target=fixture(),store=provisional.store;provisional.add('reference_answer','答案：2');target.add('question','求 1+1');
 if(!included)target.add('teacher_mark','×');
 setQuestionIncluded(store,provisional.question,included,store.getQuestion(provisional.question)!.revision);
 const document=newId('mdoc');store.db.prepare('INSERT INTO material_document(id,owner_id) VALUES (?,?)').run(document,store.studentId);
 store.db.prepare('UPDATE material_question SET document_id=? WHERE owner_id=? AND id=?').run(document,store.studentId,target.question);
 const changes=assignDocument(store,{assetId:provisional.asset,documentId:document,expectedRevision:assetLinkRevision(store,provisional.asset)});
 expect(store.getQuestion(provisional.question)!.id).toBe(target.question);expect(inclusionIntent(store,target.question)).toBe(included);
 expect(store.getQuestion(target.question)!.itemId).toBeTruthy();expect(materialPracticeEligible(store,target.question)).toBe(included);
 const item=store.getQuestion(target.question)!.itemId;
 undoLink(store,changes[0]!.id,linkRevision(store));
 expect(store.getQuestion(provisional.question)!.id).toBe(provisional.question);expect(inclusionIntent(store,provisional.question)).toBe(included);expect(store.getQuestion(target.question)!.itemId).toBe(item);
});

import { mkdtempSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
it('does not change real synthetic source bytes during a transcript correction',async()=>{
 const {store,question,asset,add,db}=fixture();const dir=mkdtempSync(path.join(tmpdir(),'learning-source-'));
 try{
  const bytes=await sharp({create:{width:24,height:16,channels:3,background:'#fff'}}).jpeg().toBuffer();const file=path.join(dir,'original.jpg');writeFileSync(file,bytes);
  const hash=createHash('sha256').update(bytes).digest('hex');db.prepare('UPDATE source_asset SET content_hash=?,storage_path=? WHERE id=?').run(hash,file,asset);
  add('question','原图上的题干',question,null,{sourceHash:hash});const item=setQuestionIncluded(store,question,true,store.getQuestion(question)!.revision).itemId!;
  expect(directCorrection(item,{revision:getLearningContext(item)!.revision,changes:[{field:'questionText',before:'原图上的题干',after:'原图上的完整题干'}]}).ok).toBe(true);
  expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(hash);expect(store.getQuestion(question)!.stem[0]!.sourceHash).toBe(hash);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
