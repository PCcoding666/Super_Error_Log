import { createHash } from 'node:crypto';
import { newId } from '../db/connection.js';
import { MobileRequestError } from '../mobile/service.js';
import type { BatchAction, BatchRequest, Fragment, Grade, ReferenceAnswer } from './contracts.js';
import type { MaterialStore } from './store.js';
import type { MaterialJobs } from './jobs.js';
import type { MaterialUploads } from './uploads.js';
import { answerEligibility, answersConflict, generateAnswerForBasis, selectedAnswerIds } from './answers.js';
import { answerBasis, dependenciesCurrent, effectiveFragmentCheck, effectiveQuestionStem, gradeBasis, readQuestion, type MaterialBasis } from './queries.js';
import { createMaterialActionProvider, validateMaterialGrade, type MaterialGradingProvider, type MaterialProviderOptions } from './provider.js';
const invalid = (message:string):never=>{throw new MobileRequestError(400,'invalid_request',message);};
const conflict = ():never=>{throw new MobileRequestError(409,'idempotency_conflict','请求键已用于不同题目、作答或依据。');};
function question(store:MaterialStore,id:string){const q=readQuestion(store,id);if(!q)throw new MobileRequestError(404,'not_found','题目不存在。');return q;}
type FrozenGrade = { questionId:string; attemptId:string; stem:Fragment[]; work:Fragment[]; answers:ReferenceAnswer[]; original:MaterialBasis; answerBasis:MaterialBasis; prepared?:MaterialBasis };
function candidate(store:MaterialStore,id:string,chosen?:string):{reason:string}|{input:FrozenGrade;basis:MaterialBasis} {
 const q=question(store,id);const reason=answerEligibility(store,id);if(reason)return {reason};
 const attempts=q.attempts.filter(a=>a.fragments.some(f=>f.role==='student_work'));const a=chosen?q.attempts.find(a=>a.id===chosen):attempts.length===1?attempts[0]:undefined;
 if(!a)return {reason:chosen?'所选作答不存在':attempts.length?'请选择本次要批改的作答':'缺少作答'};
 if(!a.fragments.some(f=>f.role==='student_work'))return {reason:'缺少原始作答，订正不能代替原作'};
 const work=a.fragments.filter(f=>f.role==='student_work'||f.role==='correction');
 if(work.some(f=>effectiveFragmentCheck(store,id,f.fragmentId)!=='passed'||f.uncertainties.length))return {reason:'作答尚未通过检查，无法确定'};
 const ids=selectedAnswerIds(store,id),answers=ids.map(id=>q.answers.find(a=>a.id===id)!);
 if(!ids.length&&(q.answers.some(a=>a.source!=='ai'||!a.stale)||store.db.prepare('SELECT 1 FROM material_answer_selection WHERE owner_id=? AND question_id=?').get(store.studentId,id)))return {reason:'参考答案冲突或已过期，请选择有效依据'};
 if(answersConflict(answers))return {reason:'参考答案冲突'};
 const scopes=new Set([...q.stem.filter(f=>f.role==='question'),...work].map(f=>f.subpart));
 if(answers.length&&![...scopes].every(scope=>answers.some(a=>a.subpart===null||a.subpart===scope)))return {reason:'所选答案未覆盖整题及本次作答的小问'};
 if(q.stem.filter(f=>f.role==='diagram').length+work.length>16||q.stem.length+work.length>32||[...q.stem,...work].reduce((n,f)=>n+f.text.length,0)+answers.reduce((n,a)=>n+a.text.length,0)>40000)return {reason:'题目和作答超过单次处理上限，请拆分材料'};
 const basis=gradeBasis(store,id,a.id,ids);return {basis,input:{questionId:id,attemptId:a.id,stem:effectiveQuestionStem(store,id),work,answers,original:basis,answerBasis:answerBasis(store,id)}};
}
export function requestGrades(store:MaterialStore,jobs:MaterialJobs,input:BatchRequest & {attemptByQuestion?:Record<string,string>}):BatchAction {
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId))invalid('请求键必须是 UUID。');
 if(('documentId' in input)===('questionIds' in input))invalid('请选择题目或试卷。');
 let ids:string[];
 if('documentId' in input){if(!store.db.prepare('SELECT 1 FROM material_document WHERE owner_id=? AND id=?').get(store.studentId,input.documentId!))throw new MobileRequestError(404,'not_found','试卷不存在。');ids=store.listQuestions().filter(q=>q.documentId===input.documentId).map(q=>q.id);}
 else {if(!Array.isArray(input.questionIds)||!input.questionIds.length||input.questionIds.length>200)invalid('请选择1–200道题。');ids=input.questionIds.map(id=>question(store,id).id);}
 ids=[...new Set(ids)].sort();if(ids.length>200)invalid('每次最多200道题。');
 const choices=input.attemptByQuestion??{};if(typeof choices!=='object'||Array.isArray(choices)||Object.entries(choices).some(([k,v])=>!ids.includes(k)||typeof v!=='string'||!v))invalid('作答选择无效。');
 const targets=ids.map(id=>({id,choice:choices[id]??null}));
 const candidates=ids.map(id=>candidate(store,id,choices[id]));
 const prior=store.db.prepare("SELECT fingerprint,result_json FROM material_action_batch WHERE owner_id=? AND kind='grade' AND request_id=?").get(store.studentId,input.requestId) as {fingerprint:string;result_json:string}|undefined;
 const result:BatchAction=prior?JSON.parse(prior.result_json):{jobs:[],skipped:[]};
 const bases=candidates.map((c,i)=>{
   if('reason' in c)return {id:ids[i],reason:c.reason,basis:question(store,ids[i]!).basisKey};
   const old=result.jobs.map(j=>store.db.prepare('SELECT question_id,input_json FROM material_job WHERE owner_id=? AND id=?').get(store.studentId,j.id) as {question_id:string;input_json:string}).find(j=>j.question_id===ids[i]);
   if(old){const frozen=JSON.parse(old.input_json) as FrozenGrade;if(frozen.prepared?.basisKey===c.basis.basisKey)return {id:ids[i],basis:frozen.original.basisKey};}
   return {id:ids[i],basis:c.basis.basisKey};
 });
 const fingerprint=createHash('sha256').update(JSON.stringify({target:'documentId' in input?input.documentId:null,targets,bases})).digest('hex');
 if(prior&&prior.fingerprint!==fingerprint)conflict();
 if(!prior)store.db.prepare("INSERT INTO material_action_batch(owner_id,kind,request_id,fingerprint,result_json) VALUES (?,'grade',?,?,?)").run(store.studentId,input.requestId,fingerprint,JSON.stringify(result));
 const save=(next:BatchAction)=>store.db.prepare("UPDATE material_action_batch SET result_json=? WHERE owner_id=? AND kind='grade' AND request_id=?").run(JSON.stringify(next),store.studentId,input.requestId);
 const accounted=new Set([...result.skipped.map(x=>x.questionId),...result.jobs.map(j=>(store.db.prepare('SELECT question_id FROM material_job WHERE owner_id=? AND id=?').get(store.studentId,j.id) as {question_id:string}).question_id)]);
 for(const [i,id] of ids.entries()){
  if(accounted.has(id))continue;const c=candidates[i]!;
  const skip=(reason:string)=>{const next={...result,skipped:[...result.skipped,{questionId:id,reason}]};save(next);result.skipped=next.skipped;};
  if('reason' in c){skip(c.reason);continue;}
  try{const j=jobs.enqueue('grade',id,input.requestId,c.basis.basisKey,{input:c.input,dependencies:c.basis.dependencies,persistJob:job=>save({...result,jobs:[...result.jobs,job]})});result.jobs.push(j);}
  catch(e){if(e instanceof MobileRequestError&&[429,503].includes(e.status))skip(e.message);else throw e;}
 }
 result.jobs=result.jobs.map(j=>jobs.get(j.id)??j);return result;
}
export async function gradeQuestion(store:MaterialStore,provider:MaterialGradingProvider,jobId:string,signal:AbortSignal):Promise<void>{
 const row=()=>store.db.prepare("SELECT * FROM material_job WHERE owner_id=? AND id=? AND kind='grade'").get(store.studentId,jobId) as {state:string;input_json:string;result_json:string|null}|undefined;
 const job=row();if(!job)throw Error('grade job not found');
 let input=JSON.parse(job.input_json) as FrozenGrade;
 const current=()=>row()?.state==='running'&&dependenciesCurrent(store,(input.prepared??input.original).basisKey,(input.prepared??input.original).dependencies);
 if(!current()){store.db.prepare("UPDATE material_job SET state='stale' WHERE owner_id=? AND id=?").run(store.studentId,jobId);return;}
 if(!input.answers.length){
  await generateAnswerForBasis(store,provider,{operationId:`${jobId}:answer`,parentJobId:jobId,questionId:input.questionId,stem:input.stem,basis:input.answerBasis},signal,answer=>{
   // Own answer adoption can change selection only. It cannot revive external work/link/answer invalidation.
   if(!current()||answer.stale||!dependenciesCurrent(store,input.original.basisKey,input.original.dependencies)||JSON.stringify(selectedAnswerIds(store,input.questionId))!==JSON.stringify([answer.id]))throw new MobileRequestError(409,'stale_basis','批改依据已变化。');
   const prepared=gradeBasis(store,input.questionId,input.attemptId,[answer.id]);
   const latest=JSON.parse(row()!.input_json);input={...latest,answers:[answer],prepared};
   store.db.prepare('UPDATE material_job SET input_json=?,basis_key=?,dependencies_json=? WHERE owner_id=? AND id=?').run(JSON.stringify(input),prepared.basisKey,JSON.stringify(prepared.dependencies),store.studentId,jobId);
  });
 }
 if(!current())return;
 const basis=input.prepared??input.original;
 const output=validateMaterialGrade(await provider.grade({questionId:input.questionId,attemptId:input.attemptId,basisKey:basis.basisKey,stem:input.stem,work:input.work,answers:input.answers},signal),{stem:input.stem,work:input.work});signal.throwIfAborted();
 store.transaction(()=>{
  const stale=!current();const grade:Grade={id:newId('mgr'),attemptId:input.attemptId,answerIds:input.answers.map(a=>a.id),basisKey:basis.basisKey,...output,stale};
  if(row()!.result_json)return;
  store.db.prepare('INSERT INTO material_grade(id,owner_id,attempt_id,basis_key,dependencies_json,content_json,stale) VALUES (?,?,?,?,?,?,?)').run(grade.id,store.studentId,grade.attemptId,grade.basisKey,JSON.stringify(basis.dependencies),JSON.stringify(grade),Number(stale));
  store.db.prepare("UPDATE material_job SET result_json=?,state=CASE WHEN ? THEN 'stale' ELSE state END WHERE owner_id=? AND id=?").run(JSON.stringify({gradeId:grade.id}),Number(stale),store.studentId,jobId);
 });
}
export function registerMaterialGrading(store:MaterialStore,jobs:MaterialJobs,uploads:MaterialUploads,options:MaterialProviderOptions):void {
 jobs.register('grade',async(id,signal)=>gradeQuestion(store,createMaterialActionProvider(options,{request:(key,invoke)=>jobs.request(id,key,invoke),source:assetId=>uploads.source(assetId)}),id,signal));
}
