import { decisiveTeacherMark, inclusionIntent, syncMaterialLearning } from './learning.js';
import { createHash } from 'node:crypto';
import { newId } from '../db/connection.js';
import { MobileRequestError } from '../mobile/service.js';
import type { BatchAction, BatchRequest, Fragment, Grade, QuestionBundle, ReferenceAnswer } from './contracts.js';
import type { MaterialStore } from './store.js';
import type { MaterialJobs } from './jobs.js';
import type { MaterialUploads } from './uploads.js';
import { answerEligibility, answersConflict, generateAnswerForBasis, selectedAnswerIds } from './answers.js';
import { answerBasis, dependenciesCurrent, effectiveFragmentCheck, effectiveQuestionStem, gradeBasis, readQuestion, type MaterialBasis } from './queries.js';
import { blocksProvisionalGrade, createMaterialActionProvider, validateMaterialGrade, type MaterialGradingProvider, type MaterialProviderOptions } from './provider.js';
import { unsupportedSubject } from './subjects.js';
const invalid = (message:string):never=>{throw new MobileRequestError(400,'invalid_request',message);};
const conflict = ():never=>{throw new MobileRequestError(409,'idempotency_conflict','请求键已用于不同题目、作答或依据。');};
function question(store:MaterialStore,id:string){const q=readQuestion(store,id);if(!q)throw new MobileRequestError(404,'not_found','题目不存在。');return q;}
type FrozenGrade = { questionId:string; attemptId:string; stem:Fragment[]; work:Fragment[]; answers:ReferenceAnswer[]; original:MaterialBasis; answerBasis:MaterialBasis; prepared?:MaterialBasis; source?:'intake' };
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
 const provisional=input.source==='intake';
 const output=validateMaterialGrade(await provider.grade({questionId:input.questionId,attemptId:input.attemptId,basisKey:basis.basisKey,stem:input.stem,work:input.work,answers:input.answers,...(provisional?{provisional:true}:{})},signal),{stem:input.stem,work:input.work},provisional?{provisional:true}:undefined);signal.throwIfAborted();
 store.transaction(()=>{
  const stale=!current();const grade:Grade={id:newId('mgr'),attemptId:input.attemptId,answerIds:input.answers.map(a=>a.id),basisKey:basis.basisKey,...output,stale,...(input.source==='intake'?{source:'intake' as const}:{})};
  if(row()!.result_json)return;
  store.db.prepare('INSERT INTO material_grade(id,owner_id,attempt_id,basis_key,dependencies_json,content_json,stale) VALUES (?,?,?,?,?,?,?)').run(grade.id,store.studentId,grade.attemptId,grade.basisKey,JSON.stringify(basis.dependencies),JSON.stringify(grade),Number(stale));
  syncMaterialLearning(store);
  store.db.prepare("UPDATE material_job SET result_json=?,state=CASE WHEN ? THEN 'stale' ELSE state END WHERE owner_id=? AND id=?").run(JSON.stringify({gradeId:grade.id}),Number(stale),store.studentId,jobId);
 });
}
export function registerMaterialGrading(store:MaterialStore,jobs:MaterialJobs,uploads:MaterialUploads,options:MaterialProviderOptions):void {
 jobs.register('grade',async(id,signal)=>gradeQuestion(store,createMaterialActionProvider(options,{request:(key,invoke)=>jobs.request(id,key,invoke),source:assetId=>uploads.source(assetId)}),id,signal));
}

export type IntakeVerdict = 'wrong' | 'partial' | 'right' | 'confirm';

function readableForIntake(fragment: Fragment, requireText: boolean): boolean {
  if (blocksProvisionalGrade(fragment)) return false;
  return !requireText || !!fragment.text.trim();
}

/** Provisional wrong/right/partial needs readable stem and work. Anything else stays confirm. */
export function intakeProvisionalReady(question: QuestionBundle): boolean {
  if (question.missing.includes('stem') || question.missing.includes('diagram') || question.unresolved.length) return false;
  const stems = question.stem.filter(fragment => fragment.role === 'question');
  if (!stems.length || stems.some(fragment => !readableForIntake(fragment, true))) return false;
  if (question.stem.some(fragment => fragment.role === 'diagram' && !readableForIntake(fragment, false))) return false;
  const work = question.attempts.flatMap(attempt => attempt.fragments).filter(fragment => fragment.role === 'student_work');
  return work.length > 0 && work.every(fragment => readableForIntake(fragment, true));
}

function applicableGrade(question: QuestionBundle): Grade | undefined {
  const decided = question.grades.filter(grade => !grade.stale && (grade.result === 'incorrect' || grade.result === 'partial' || grade.result === 'correct'));
  if (!decided.length) return undefined;
  return decided.every(grade => grade.result === decided[0]!.result) ? decided[0] : undefined;
}

/** Server-owned page verdict. Teacher marks win. A missing or unfinished grade stays confirm. */
export function intakeVerdict(question?: QuestionBundle): { verdict: IntakeVerdict; preselected: boolean } {
  const confirm = { verdict: 'confirm' as const, preselected: false };
  if (!question) return confirm;
  const mark = decisiveTeacherMark(question);
  if (mark === 'wrong') return { verdict: 'wrong', preselected: true };
  if (mark === 'right') return { verdict: 'right', preselected: false };
  if (!intakeProvisionalReady(question)) return confirm;
  const grade = applicableGrade(question);
  if (grade?.result === 'incorrect') return { verdict: 'wrong', preselected: true };
  if (grade?.result === 'partial') return { verdict: 'partial', preselected: true };
  if (grade?.result === 'correct') return { verdict: 'right', preselected: false };
  return confirm;
}

function questionOnAsset(question: QuestionBundle, assetId: string): boolean {
  return question.stem.some(fragment => fragment.assetId === assetId)
    || question.teacherMarks.some(fragment => fragment.assetId === assetId)
    || question.attempts.some(attempt => attempt.fragments.some(fragment => fragment.assetId === assetId));
}

function intakeGradeRequestId(questionId: string, basisKey: string): string {
  const digest = createHash('sha256').update(`sel-intake-grade:${questionId}:${basisKey}`).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function intakeGradeInput(store: MaterialStore, question: QuestionBundle): { input: FrozenGrade; basis: MaterialBasis } | null {
  if (!intakeProvisionalReady(question)) return null;
  const attempts = question.attempts.filter(attempt => attempt.fragments.some(fragment => fragment.role === 'student_work' && readableForIntake(fragment, true)));
  if (attempts.length !== 1) return null;
  const attempt = attempts[0]!;
  const studentWork = attempt.fragments.filter(fragment => fragment.role === 'student_work');
  if (studentWork.some(fragment => !readableForIntake(fragment, true))) return null;
  const work = [...studentWork, ...attempt.fragments.filter(fragment => fragment.role === 'correction' && readableForIntake(fragment, true))];
  if (question.stem.filter(fragment => fragment.role === 'diagram').length + work.length > 16 || question.stem.length + work.length > 32) return null;
  if ([...question.stem, ...work].reduce((total, fragment) => total + fragment.text.length, 0) > 40000) return null;
  const ids = selectedAnswerIds(store, question.id);
  const answers = ids.map(id => question.answers.find(answer => answer.id === id)!);
  const selection = store.db.prepare('SELECT 1 FROM material_answer_selection WHERE owner_id=? AND question_id=?').get(store.studentId, question.id);
  if (!ids.length && (question.answers.some(answer => answer.source !== 'ai' || !answer.stale) || selection)) return null;
  if (answersConflict(answers)) return null;
  const scopes = new Set([...question.stem.filter(fragment => fragment.role === 'question'), ...work].map(fragment => fragment.subpart));
  if (answers.length && ![...scopes].every(scope => answers.some(answer => answer.subpart === null || answer.subpart === scope))) return null;
  const basis = gradeBasis(store, question.id, attempt.id, ids);
  return {
    basis,
    input: {
      questionId: question.id, attemptId: attempt.id, stem: effectiveQuestionStem(store, question.id), work, answers,
      original: basis, answerBasis: answerBasis(store, question.id), source: 'intake',
    },
  };
}

function intakeGradeAlreadyCovered(store: MaterialStore, questionId: string, basisKey: string): boolean {
  const grades = store.db.prepare(`SELECT g.basis_key, g.dependencies_json FROM material_grade g
    JOIN material_attempt a ON a.owner_id=g.owner_id AND a.id=g.attempt_id
    WHERE g.owner_id=? AND a.question_id=? AND g.stale=0`).all(store.studentId, questionId) as { basis_key: string; dependencies_json: string }[];
  if (grades.some(row => { try { return dependenciesCurrent(store, row.basis_key, JSON.parse(row.dependencies_json)); } catch { return false; } })) return true;
  const rows = store.db.prepare(`SELECT input_json FROM material_job WHERE owner_id=? AND kind='grade' AND question_id=? AND state IN ('queued','running','interrupted','succeeded','failed')`).all(store.studentId, questionId) as { input_json: string }[];
  return rows.some(row => {
    try {
      const input = JSON.parse(row.input_json) as { source?: string; original?: { basisKey?: string } };
      return input.source === 'intake' && input.original?.basisKey === basisKey;
    } catch { return false; }
  });
}

function enqueueIntakeGrade(store: MaterialStore, jobs: MaterialJobs, question: QuestionBundle): void {
  if (question.itemId || unsupportedSubject(question.subject) || inclusionIntent(store, question.id) === false || decisiveTeacherMark(question)) return;
  const ready = intakeGradeInput(store, question);
  if (!ready || intakeGradeAlreadyCovered(store, question.id, ready.basis.basisKey)) return;
  jobs.enqueue('grade', question.id, intakeGradeRequestId(question.id, ready.basis.basisKey), ready.basis.basisKey, {
    input: ready.input, dependencies: ready.basis.dependencies,
  });
}

/** After extract, grade readable work that has no decisive teacher mark. 429/503 skips that item. */
export function requestIntakeGrades(store: MaterialStore, jobs: MaterialJobs, assetId: string): void {
  for (const question of store.listQuestions()) {
    if (!questionOnAsset(question, assetId)) continue;
    try { enqueueIntakeGrade(store, jobs, question); }
    catch (error) {
      if (error instanceof MobileRequestError && [429, 503, 409].includes(error.status)) continue;
      throw error;
    }
  }
}

/** True while an intake grade for one of these questions is still queued or running. */
export function intakeGradesPending(store: MaterialStore, questionIds: ReadonlySet<string>): boolean {
  if (!questionIds.size) return false;
  const rows = store.db.prepare("SELECT question_id, input_json FROM material_job WHERE owner_id=? AND kind='grade' AND state IN ('queued','running')").all(store.studentId) as { question_id: string | null; input_json: string }[];
  return rows.some(row => {
    if (!row.question_id || !questionIds.has(row.question_id)) return false;
    try { return JSON.parse(row.input_json).source === 'intake'; } catch { return false; }
  });
}
