import { afterEach, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import http from 'node:http';
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { migrateMaterials } from '../../src/materials/schema.js';
import { MaterialStore } from '../../src/materials/store.js';
import { MaterialJobs } from '../../src/materials/jobs.js';
import { MaterialUploads } from '../../src/materials/uploads.js';
import { MobileRecognitionService } from '../../src/mobile/service.js';
import { MobileRecognitionStore } from '../../src/mobile/store.js';
import { AdmissionController } from '../../src/mobile/admission.js';
import { createMaterialsRouter } from '../../src/web/materialsRouter.js';
import { saveManualAnswer, requestAnswers, selectAnswerBasis, registerMaterialAnswers } from '../../src/materials/answers.js';
import { requestGrades, gradeQuestion, registerMaterialGrading } from '../../src/materials/grading.js';
import { createMaterialActionProvider, validateMaterialGrade, hasScoringCriteria } from '../../src/materials/provider.js';
import { readQuestion } from '../../src/materials/queries.js';
import type { Fragment } from '../../src/materials/contracts.js';
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const c of cleanups.splice(0).reverse())
        await c();
});
function setup() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    db.exec(SCHEMA_SQL);
    migrateMaterials(db);
    db.exec("INSERT INTO student_profile(id,nickname,created_at) VALUES ('a','A','2026-10-20'),('b','B','2026-10-20')");
    cleanups.push(() => db.close());
    return new MaterialStore(db, 'a');
}
function question(store: MaterialStore, number = '12', subpart: string | null = null) {
    const q = store.createQuestion({ number });
    const id = randomUUID();
    const cap = store.createCapture(randomUUID());
    store.db.prepare('INSERT INTO source_batch(id,student_id,created_at) VALUES (?,?,?)').run(id, store.studentId, '2026-10-20');
    store.db.prepare('INSERT INTO source_asset(id,batch_id,filename,mime,size,content_hash,storage_path,created_at) VALUES (?,?,?,?,?,?,?,?)').run(id, id, 'synthetic.jpg', 'image/jpeg', 1, id, '/synthetic.jpg', '2026-10-20');
    store.db.prepare('INSERT INTO material_asset(id,owner_id,capture_id,source_asset_id) VALUES (?,?,?,?)').run(id, store.studentId, cap.id, id);
    const stem: Fragment = { assetId: id, fragmentId: randomUUID(), revision: 1, sourceHash: id, box: { x: 0, y: 0, width: 1, height: 1 }, role: 'question', text: '1+1=?', number, subpart, page: 1, order: 0, requiresDiagram: false, check: 'passed', uncertainties: [] };
    store.putFragment(stem);
    store.linkFragment(stem.fragmentId, 1, { questionId: q.id, attemptId: null });
    return { id: q.id, stem };
}
const manual = (s: MaterialStore, id: string, text = '2', subpart: string | null = null) => saveManualAnswer(s, { questionId: id, subpart, text, claimedSource: '老师提供', expectedRevision: readQuestion(s, id)!.revision });
async function runtime(store: MaterialStore, capacity = 10) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'answers-'));
    const admission = new AdmissionController({ jobCapacity: capacity, diskProbe: async () => 10n ** 12n });
    const scheduler = new MobileRecognitionService(await MobileRecognitionStore.open(dir), { inventory: async () => ({ candidates: [], warnings: [], capacityReached: false }), recognizeQuestion: async () => {
            throw Error('unused');
        } });
    scheduler.useAdmission(admission);
    const jobs = new MaterialJobs(store, scheduler, admission);
    const uploads = new MaterialUploads(store, jobs, admission);
    await uploads.initialize();
    cleanups.push(async () => {
        await scheduler.stop();
        rmSync(dir, { recursive: true, force: true });
    });
    return { jobs, uploads, admission, scheduler, dir };
}
async function settled(jobs: MaterialJobs, id: string) {
    for (let i = 0; i < 200; i++) {
        const j = jobs.get(id)!;
        if (!['queued', 'running'].includes(j.state))
            return j;
        await new Promise(r => setTimeout(r, 5));
    }
    throw Error('not settled');
}

function work(s:MaterialStore,q:ReturnType<typeof question>,check:Fragment['check']='passed') { const a=s.createAttempt(q.id);const f={...q.stem,fragmentId:randomUUID(),role:'student_work' as const,text:'2',check};s.putFragment(f);s.linkFragment(f.fragmentId,1,{questionId:q.id,attemptId:a.id});return {id:a.id,f}; }
it('grades only eligible requested attempts and never updates mastery',async()=>{
 const s=setup(),qs=Array.from({length:5},()=>question(s));for(const q of qs.slice(0,4))work(s,q);for(const q of qs)manual(s,q.id);
 const diagram={...qs[2]!.stem,revision:2,requiresDiagram:true};s.putFragment(diagram);s.linkFragment(diagram.fragmentId,2,{questionId:qs[2]!.id,attemptId:null});work(s,qs[3]!);
 s.db.prepare("INSERT INTO error_item(id,student_id,batch_id,asset_id,item_index,status,created_at,updated_at) VALUES ('learning-item','a',?,?,0,'reviewing','now','now')").run(qs[0]!.stem.assetId,qs[0]!.stem.assetId);
 s.db.exec("INSERT INTO mastery_event(id,item_id,from_status,to_status,reason,created_at) VALUES ('mastery','learning-item','captured','reviewing','student rework','now'); INSERT INTO v2_reflection_turn(id,item_id,turn,question,question_source,answer,created_at) VALUES ('reflection','learning-item',1,'为什么错','student','我的反思','now')");
 const learning=()=>['error_item','mastery_event','v2_reflection_turn','review_attempt'].map(t=>s.db.prepare(`SELECT * FROM ${t}`).all());const learningBefore=learning();
 const before=s.db.prepare('SELECT * FROM student_profile').all();const rt=await runtime(s);registerMaterialGrading(s,rt.jobs,rt.uploads,{mode:'mock'});const req={requestId:randomUUID(),questionIds:qs.map(q=>q.id)};const action=requestGrades(s,rt.jobs,req);
 expect(action.jobs).toHaveLength(2);expect(action.skipped).toHaveLength(3);for(const j of action.jobs)expect((await settled(rt.jobs,j.id)).state).toBe('succeeded');expect(requestGrades(s,rt.jobs,req).jobs.map(j=>j.id)).toEqual(action.jobs.map(j=>j.id));expect(s.db.prepare('SELECT * FROM student_profile').all()).toEqual(before);
 expect(readQuestion(s,qs[0]!.id)!.grades[0]!.score).toBeNull();expect(learning()).toEqual(learningBefore);
});
it('requires explicit ambiguous attempt and respects a selected conflicting reference',async()=>{
 const s=setup(),q=question(s);const a=work(s,q);work(s,q);const m=manual(s,q.id);const f={...q.stem,fragmentId:randomUUID(),role:'reference_answer' as const,text:'3'};s.putFragment(f);s.linkFragment(f.fragmentId,1,{questionId:q.id,attemptId:null});const rt=await runtime(s);
 expect(requestGrades(s,rt.jobs,{requestId:randomUUID(),questionIds:[q.id]}).skipped).toHaveLength(1);
 expect(requestGrades(s,rt.jobs,{requestId:randomUUID(),questionIds:[q.id],attemptByQuestion:{[q.id]:a.id}}).skipped).toHaveLength(1);
 selectAnswerBasis(s,q.id,[m.id],readQuestion(s,q.id)!.revision);expect(readQuestion(s,q.id)!.answerConflict).toBe(true);registerMaterialGrading(s,rt.jobs,rt.uploads,{mode:'mock'});const action=requestGrades(s,rt.jobs,{requestId:randomUUID(),questionIds:[q.id],attemptByQuestion:{[q.id]:a.id}});expect(action.jobs).toHaveLength(1);await settled(rt.jobs,action.jobs[0]!.id);expect(readQuestion(s,q.id)!.grades[0]!.attemptId).toBe(a.id);
});
const gradeRun={stage:'material_grade' as const,model:'synthetic',durationMs:0,promptTokens:null,completionTokens:null,maxTokens:100,thinking:false as const,promptVersion:'test'};
function output(f:Fragment){return {result:'correct' as const,findings:[{fragmentIds:[f.fragmentId],text:'作答与答案一致'}],score:null,run:gradeRun};}
it('rejects invented findings and other attempts and permits scores only with real criteria',()=>{
 const s=setup(),q=question(s),a=work(s,q),other=work(s,q);const valid=output(a.f);
 for(const id of ['invented',q.stem.fragmentId,other.f.fragmentId])expect(()=>validateMaterialGrade({...valid,findings:[{fragmentIds:[id],text:'claim'}]},{stem:[q.stem],work:[a.f]})).toThrow();
 const scored={...valid,score:{earned:5,total:10,rubricFragmentIds:[q.stem.fragmentId]}};
 expect(validateMaterialGrade(scored,{stem:[{...q.stem,text:'本题10分'}],work:[a.f]}).score).toBeNull();
 expect(validateMaterialGrade(scored,{stem:[{...q.stem,text:'评分标准：写出正确公式得5分；计算正确结果得5分。'}],work:[a.f]}).score).toEqual(scored.score);
 expect(()=>validateMaterialGrade({...scored,score:{...scored.score,earned:11}},{stem:[q.stem],work:[a.f]})).toThrow();
 expect(validateMaterialGrade(valid,{stem:[q.stem],work:[{...a.f,check:'low'}]})).toMatchObject({result:'uncertain',score:null});
});
it('preserves teacher marks and cannot publish an in-flight old rubric as current',async()=>{
 const s=setup(),q=question(s),a=work(s,q);manual(s,q.id);const teacher={...q.stem,fragmentId:randomUUID(),role:'teacher_mark' as const,text:'扣2分'};s.putFragment(teacher);s.linkFragment(teacher.fragmentId,1,{questionId:q.id,attemptId:null});
 const before=readQuestion(s,q.id)!;const rt=await runtime(s);let release!:()=>void;let started!:()=>void;const start=new Promise<void>(r=>started=r),gate=new Promise<void>(r=>release=r);let done!:()=>void;const completed=new Promise<void>(r=>done=r);
 rt.jobs.register('grade',async(id,signal)=>{await gradeQuestion(s,{answer:async()=>{throw Error('unused');},grade:async()=>{started();await gate;return output(a.f);}},id,signal);done();});
 const action=requestGrades(s,rt.jobs,{requestId:randomUUID(),questionIds:[q.id]});await start;
 const revised={...q.stem,revision:2,text:'评分标准：写出正确公式得5分；计算正确结果得5分。'};s.putFragment(revised);s.linkFragment(revised.fragmentId,2,{questionId:q.id,attemptId:null});release();await completed;
 expect(readQuestion(s,q.id)!.grades[0]!.stale).toBe(true);expect(rt.jobs.get(action.jobs[0]!.id)!.state).toBe('stale');expect(readQuestion(s,q.id)!.teacherMarks).toEqual(before.teacherMarks);expect(readQuestion(s,q.id)!.attempts).toEqual(before.attempts);
});
it('invalidates a completed grade when frozen rubric changes',async()=>{
 const s=setup(),q=question(s),a=work(s,q);manual(s,q.id);const rt=await runtime(s);registerMaterialGrading(s,rt.jobs,rt.uploads,{mode:'mock'});const j=requestGrades(s,rt.jobs,{requestId:randomUUID(),questionIds:[q.id]}).jobs[0]!;await settled(rt.jobs,j.id);expect(readQuestion(s,q.id)!.grades[0]!.stale).toBe(false);
 s.putFragment({...q.stem,revision:2,text:'new criteria'});s.linkFragment(q.stem.fragmentId,2,{questionId:q.id,attemptId:null});expect(readQuestion(s,q.id)!.grades[0]!.stale).toBe(true);
});
it('requires complete answer scope and never bypasses stale or conflicting provided references',async()=>{
 const s=setup(),q=question(s,'12','a');work(s,q);const b={...q.stem,fragmentId:randomUUID(),subpart:'b'};s.putFragment(b);s.linkFragment(b.fragmentId,1,{questionId:q.id,attemptId:null});manual(s,q.id,'a only','a');const rt=await runtime(s);
 expect(requestGrades(s,rt.jobs,{requestId:randomUUID(),questionIds:[q.id]}).skipped[0]!.reason).toContain('未覆盖');
 const q2=question(s);work(s,q2);manual(s,q2.id);s.putFragment({...q2.stem,revision:2});s.linkFragment(q2.stem.fragmentId,2,{questionId:q2.id,attemptId:null});expect(requestGrades(s,rt.jobs,{requestId:randomUUID(),questionIds:[q2.id]}).skipped).toHaveLength(1);
});
it('rolls admission input dependencies and batch entry back together, then replays once at capacity',async()=>{
 const s=setup(),q=question(s);work(s,q);manual(s,q.id);const rt=await runtime(s,1);const req={requestId:randomUUID(),questionIds:[q.id]};s.db.exec("CREATE TRIGGER fail_grade_batch BEFORE UPDATE ON material_action_batch BEGIN SELECT RAISE(ABORT,'batch failure'); END");
 expect(()=>requestGrades(s,rt.jobs,req)).toThrow('batch failure');expect(s.db.prepare("SELECT count(*) n FROM material_job WHERE kind='grade'").get()).toEqual({n:0});s.db.exec('DROP TRIGGER fail_grade_batch');const first=requestGrades(s,rt.jobs,req);expect(first.jobs).toHaveLength(1);expect(requestGrades(s,rt.jobs,req)).toEqual(first);
 const a=work(s,q);expect(()=>requestGrades(s,rt.jobs,{...req,attemptByQuestion:{[q.id]:a.id}})).toThrow();
});
it('persists an inline answer once across grade failure/retry using actual local requests',async()=>{
 const s=setup(),q=question(s),a=work(s,q);const rt=await runtime(s);rt.jobs.retryDelaysMs=[0,0];
 const bytes=await sharp({create:{width:80,height:60,channels:3,background:'#fff'}}).jpeg().toBuffer(),file=path.join(rt.dir,'owned.jpg');writeFileSync(file,bytes);const hash=createHash('sha256').update(bytes).digest('hex');
 s.db.prepare('UPDATE source_asset SET content_hash=? WHERE id=?').run(hash,q.stem.assetId);
 for(const f of [q.stem,a.f]){f.sourceHash=hash;s.putFragment({...f,revision:2});s.linkFragment(f.fragmentId,2,{questionId:q.id,attemptId:f.role==='question'?null:a.id});}
 let answerCalls=0,gradeCalls=0,fail=true,images=0;
 const server=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw),content=body.messages[1].content,data=JSON.parse(content[0].text);res.setHeader('content-type','application/json');
 if(data.operation==='answer')answerCalls++;else{gradeCalls++;images=content.filter((p:any)=>p.type==='image_url').length;if(fail){res.statusCode=503;res.end('{}');return;}}
 const value=data.operation==='answer'?{questionId:data.questionId,basisKey:data.basisKey,text:'2',fragmentIds:data.fragments.map((f:any)=>f.fragmentId)}:{questionId:data.questionId,attemptId:data.attemptId,basisKey:data.basisKey,...output(a.f)};
 res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));cleanups.push(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
 const options={mode:'openai' as const,chat:{baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,apiKey:'synthetic',models:{material_extract:'e',material_verify:'v',material_answer:'a',material_grade:'g'},timeoutMs:2000,bailianOnly:false}};
 rt.jobs.register('grade',(id,signal)=>gradeQuestion(s,createMaterialActionProvider(options,{request:(key,invoke)=>rt.jobs.request(id,key,invoke),source:id=>{expect(id).toBe(q.stem.assetId);return {sourceHash:hash,originalPath:file};}}),id,signal));
 const req={requestId:randomUUID(),questionIds:[q.id]},job=requestGrades(s,rt.jobs,req).jobs[0]!;expect((await settled(rt.jobs,job.id)).state).toBe('failed');expect(answerCalls).toBe(1);expect(gradeCalls).toBe(3);expect(readQuestion(s,q.id)!.answers).toHaveLength(1);expect(images).toBe(1);
 expect(requestGrades(s,rt.jobs,req).jobs[0]!.id).toBe(job.id);fail=false;rt.jobs.retry(job.id,randomUUID());expect((await settled(rt.jobs,job.id)).state).toBe('succeeded');expect(answerCalls).toBe(1);expect(gradeCalls).toBe(4);expect(s.db.prepare('SELECT count(*) n FROM material_answer').get()).toEqual({n:1});expect(readQuestion(s,q.id)!.grades).toHaveLength(1);
});
it('rejects corrections-only attempts and allows regenerating stale AI history',async()=>{
 const s=setup(),q=question(s),a=s.createAttempt(q.id),f={...q.stem,fragmentId:randomUUID(),role:'correction' as const,text:'2'};s.putFragment(f);s.linkFragment(f.fragmentId,1,{questionId:q.id,attemptId:a.id});const rt=await runtime(s);expect(requestGrades(s,rt.jobs,{requestId:randomUUID(),questionIds:[q.id],attemptByQuestion:{[q.id]:a.id}}).skipped[0]!.reason).toContain('原始作答');
 const q2=question(s);work(s,q2);registerMaterialAnswers(s,rt.jobs,rt.uploads,{mode:'mock'});const answer=requestAnswers(s,rt.jobs,{requestId:randomUUID(),questionIds:[q2.id]}).jobs[0]!;await settled(rt.jobs,answer.id);s.putFragment({...q2.stem,revision:2,text:'1+2=?'});s.linkFragment(q2.stem.fragmentId,2,{questionId:q2.id,attemptId:null});expect(readQuestion(s,q2.id)!.answers[0]!.stale).toBe(true);
 registerMaterialGrading(s,rt.jobs,rt.uploads,{mode:'mock'});const j=requestGrades(s,rt.jobs,{requestId:randomUUID(),questionIds:[q2.id]}).jobs[0]!;expect(j).toBeDefined();expect((await settled(rt.jobs,j.id)).state).toBe('succeeded');expect(readQuestion(s,q2.id)!.answers[0]!.revision).toBe(2);
});
it('does not authorize an invented total from a real rubric fragment',()=>{
 const s=setup(),q=question(s),a=work(s,q);const stem={...q.stem,text:'评分标准：写出正确公式得5分；计算正确结果得5分。'};expect(validateMaterialGrade({...output(a.f),score:{earned:70,total:100,rubricFragmentIds:[stem.fragmentId]}},{stem:[stem],work:[a.f]}).score).toBeNull();
});
it('does not publish or launch grade after an external answer arrives during inline generation',async()=>{
 const s=setup(),q=question(s),a=work(s,q),rt=await runtime(s);let ready!:()=>void,release!:()=>void;const started=new Promise<void>(r=>ready=r),gate=new Promise<void>(r=>release=r);let calls=0;
 rt.jobs.register('grade',(id,signal)=>gradeQuestion(s,{answer:async()=>{ready();await gate;return {text:'2',fragmentIds:[q.stem.fragmentId],run:{...gradeRun,stage:'material_answer'}};},grade:async()=>{calls++;return output(a.f);}},id,signal));
 const j=requestGrades(s,rt.jobs,{requestId:randomUUID(),questionIds:[q.id]}).jobs[0]!;await started;manual(s,q.id,'external provided answer');release();await new Promise(r=>setTimeout(r,20));expect(rt.jobs.get(j.id)!.state).toBe('stale');expect(calls).toBe(0);expect(readQuestion(s,q.id)!.answers.map(a=>a.source)).toEqual(['manual']);expect(readQuestion(s,q.id)!.grades).toEqual([]);
});
it('keeps grades on explicit POST and GET read-only with owned routes and attempt controls',async()=>{
 const s=setup(),q=question(s);work(s,q);manual(s,q.id);const rt=await runtime(s);registerMaterialGrading(s,rt.jobs,rt.uploads,{mode:'mock'});const namespace=s.getWorkspace().draftNamespace,app=express();app.use('/s',createMaterialsRouter({store:s,...rt,draftNamespace:namespace}));const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));cleanups.push(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const before=s.db.prepare('SELECT total_changes() n').get();const html=await(await fetch(`${base}/s/materials/questions/${q.id}`)).text();expect(html).toContain('帮我批改');expect(html).toContain('name="attemptId"');expect(s.db.prepare('SELECT total_changes() n').get()).toEqual(before);
 const headers={'content-type':'application/json',accept:'application/json'};const post=(body:unknown,extra={})=>fetch(base+'/s/materials/grades',{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});const input={namespace,requestId:randomUUID(),questionIds:[q.id]};expect((await post(input,{origin:'https://evil.example'})).status).toBe(403);expect((await post({...input,namespace:'other'})).status).toBe(409);const foreign=new MaterialStore(s.db,'b').createQuestion();expect((await post({...input,questionIds:[foreign.id]})).status).toBe(404);const response=await post(input);expect(response.status).toBe(200);const action=await response.json() as {jobs:{id:string}[]};await settled(rt.jobs,action.jobs[0]!.id);const changes=s.db.prepare('SELECT total_changes() n').get();const result=await(await fetch(`${base}/s/materials/questions/${q.id}`)).text();expect(result).toContain('<summary>AI 批改</summary>');expect(result).toContain('AI 建议：');expect(result).toContain('未提供精确分数');expect(s.db.prepare('SELECT total_changes() n').get()).toEqual(changes);
});
it('binds local grade requests to real owned multi-image crops and validates before checkpoint success',async()=>{
 const s=setup(),q=question(s),a=work(s,q),rt=await runtime(s);const bytes=await sharp({create:{width:120,height:80,channels:3,background:'#f00'}}).withMetadata({orientation:6}).jpeg().toBuffer();const second=await sharp({create:{width:60,height:60,channels:3,background:'#00f'}}).jpeg().toBuffer();const files=[path.join(rt.dir,'red.jpg'),path.join(rt.dir,'blue.jpg')];writeFileSync(files[0]!,bytes);writeFileSync(files[1]!,second);
 const diagram={...q.stem,fragmentId:'diagram',role:'diagram' as const,sourceHash:createHash('sha256').update(bytes).digest('hex'),box:{x:0,y:0,width:0.5,height:1}};const workImage={...a.f,assetId:'second-owned',sourceHash:createHash('sha256').update(second).digest('hex')};const stem={...q.stem,sourceHash:diagram.sourceHash};let bad=true,calls=0,imageCount=0,width=0;
 const server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw),content=body.messages[1].content,data=JSON.parse(content[0].text);const images=content.filter((p:any)=>p.type==='image_url');imageCount=images.length;width=(await sharp(Buffer.from(images[0].image_url.url.split(',')[1],'base64')).metadata()).width!;calls++;res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({questionId:data.questionId,attemptId:data.attemptId,basisKey:data.basisKey,result:'correct',findings:[{fragmentIds:bad?['invented']:[workImage.fragmentId],text:'work checked'}],score:null})}}]}));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));cleanups.push(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
 const cache=new Map<string,unknown>(),keys:string[]=[];const provider=createMaterialActionProvider({mode:'openai',chat:{baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,apiKey:'synthetic',models:{material_extract:'e',material_verify:'v',material_answer:'a',material_grade:'g'},timeoutMs:2000,bailianOnly:false}},{source:id=>{if(id===workImage.assetId)return {sourceHash:workImage.sourceHash,originalPath:files[1]!};expect(id).toBe(q.stem.assetId);return {sourceHash:diagram.sourceHash,originalPath:files[0]!};},request:async(key,invoke)=>{keys.push(key);if(cache.has(key))return cache.get(key) as any;const value=await invoke(new AbortController().signal);cache.set(key,value);return value;}});
 const input={questionId:q.id,attemptId:a.id,basisKey:'grade-real-basis',stem:[stem,diagram],work:[workImage],answers:[]},signal=new AbortController().signal;await expect(provider.grade(input,signal)).rejects.toMatchObject({code:'invalid_output'});expect(cache.size).toBe(0);bad=false;await provider.grade(input,signal);await provider.grade(input,signal);expect(calls).toBe(2);expect(imageCount).toBe(2);expect(width).toBe(40);expect(new Set(keys).size).toBe(1);writeFileSync(files[1]!,Buffer.from('replaced'));await expect(provider.grade({...input,basisKey:'different'},signal)).rejects.toMatchObject({code:'invalid_output'});expect(calls).toBe(2);
});
it('uses verified repaired diagram evidence without promoting unproven low fragments',async()=>{
 const s=setup(),q=question(s),a=work(s,q);const f={...q.stem,revision:2,requiresDiagram:true,check:'low' as const,uncertainties:['missing_diagram']};s.putFragment(f);s.linkFragment(f.fragmentId,2,{questionId:q.id,attemptId:null});const diagram={...q.stem,fragmentId:randomUUID(),role:'diagram' as const};s.putFragment(diagram);s.linkFragment(diagram.fragmentId,1,{questionId:q.id,attemptId:null});manual(s,q.id);const rt=await runtime(s);expect(requestGrades(s,rt.jobs,{requestId:randomUUID(),questionIds:[q.id]}).skipped).toHaveLength(1);
 const {assetId:_asset,sourceHash:_hash,revision:_rev,text:_text,check:_check,uncertainties:_uncertainties,...region}=f;
 const execution={stages:{'material-v1:1:locate':{state:'succeeded',result:{value:{candidates:[{...region,key:'candidate'}]}}},'material-v1:1:read:candidate':{state:'succeeded',result:{value:{text:f.text,uncertainties:[]}}},'material-v1:1:verify:candidate':{state:'succeeded',result:{value:{check:'passed',uncertainties:[]}}}}};
 s.db.prepare("INSERT INTO material_job(id,owner_id,request_id,kind,asset_id,state,input_json,result_json) VALUES ('provenance','a',?,'extract',?,'succeeded',?,?)").run(randomUUID(),q.stem.assetId,JSON.stringify({execution}),JSON.stringify({assetId:q.stem.assetId,revision:1,sourceHash:f.sourceHash}));
 rt.jobs.register('grade',(id,signal)=>gradeQuestion(s,{answer:async()=>{throw Error('unused');},grade:async()=>output(a.f)},id,signal));const job=requestGrades(s,rt.jobs,{requestId:randomUUID(),questionIds:[q.id]}).jobs[0]!;await settled(rt.jobs,job.id);expect(readQuestion(s,q.id)!.grades[0]!.result).toBe('correct');expect(readQuestion(s,q.id)!.stem.find(x=>x.fragmentId===f.fragmentId)).toMatchObject({check:'low',uncertainties:['missing_diagram']});
});
it.each(['low','failed','unchecked'] as const)('skips %s work and never starts an answer or grade stage',async check=>{
 const s=setup(),q=question(s);work(s,q,check);const rt=await runtime(s);registerMaterialGrading(s,rt.jobs,rt.uploads,{mode:'mock'});const action=requestGrades(s,rt.jobs,{requestId:randomUUID(),questionIds:[q.id]});expect(action.jobs).toEqual([]);expect(action.skipped).toHaveLength(1);expect(readQuestion(s,q.id)!.answers).toEqual([]);
});
it('accounts for every document question at capacity and resumes only uncommitted batch entries',async()=>{
 const s=setup();s.db.exec("INSERT INTO material_document(id,owner_id) VALUES ('grade-doc','a')");const qs=[question(s),question(s)];for(const q of qs){work(s,q);manual(s,q.id);s.db.prepare("UPDATE material_question SET document_id='grade-doc' WHERE id=?").run(q.id);}const rt=await runtime(s,2),request={requestId:randomUUID(),documentId:'grade-doc'};
 s.db.exec("CREATE TRIGGER fail_second_grade BEFORE UPDATE ON material_action_batch WHEN json_array_length(NEW.result_json,'$.jobs')=2 BEGIN SELECT RAISE(ABORT,'second grade failed'); END");expect(()=>requestGrades(s,rt.jobs,request)).toThrow('second grade failed');expect(s.db.prepare("SELECT count(*) n FROM material_job WHERE kind='grade'").get()).toEqual({n:1});s.db.exec('DROP TRIGGER fail_second_grade');const action=requestGrades(s,rt.jobs,request);expect(action.jobs).toHaveLength(2);expect(requestGrades(s,rt.jobs,request).jobs.map(j=>j.id)).toEqual(action.jobs.map(j=>j.id));
 const blocked=requestGrades(s,rt.jobs,{requestId:randomUUID(),questionIds:qs.map(q=>q.id)});expect(blocked.jobs).toEqual([]);expect(blocked.skipped.map(x=>x.questionId).sort()).toEqual(qs.map(q=>q.id).sort());
});

it.each([
 '评分标准：本题为计算题，总分10分。',
 '评分标准：计算题，总分10分。',
 '评分细则：本题是计算题，可得10分。',
 '评分标准：计算题得10分。',
 '评分标准：计算题答对得10分。',
 '评分标准：写出答案，本题满分10分。',
 '评分标准：写出正确公式得5分；计算题总分5分。',
 '评分标准：计算正确结果，最高可得10分。',
])('does not treat labels or question totals as earning criteria: %s',text=>{
 const s=setup(),q=question(s),a=work(s,q),stem={...q.stem,text};
 expect(hasScoringCriteria(stem)).toBe(false);
 expect(validateMaterialGrade({...output(a.f),score:{earned:7,total:10,rubricFragmentIds:[stem.fragmentId]}},{stem:[stem],work:[a.f]}).score).toBeNull();
});
it.each([
 '评分标准：写出正确公式得5分、计算正确结果得5分。',
 '评分标准：写出正确公式得5分 计算正确结果得5分。',
 '评分标准：写出正确公式得5分并计算正确结果得5分。',
 '评分标准：写出正确公式（5分）并计算正确结果得5分。',
 '评分标准：写出正确公式得五分并计算正确结果得5分。',
 '评分标准：写出正确公式得５分并计算正确结果得5分。',
 '评分标准：写出正确公式给5分/计算正确结果计5分。',
])('rejects multiple award amounts inside one unsupported clause: %s',text=>{
 const s=setup(),q=question(s),a=work(s,q),stem={...q.stem,text};
 expect(hasScoringCriteria(stem)).toBe(false);
 expect(validateMaterialGrade({...output(a.f),result:'partial',score:{earned:3,total:5,rubricFragmentIds:[stem.fragmentId]}},{stem:[stem],work:[a.f]}).score).toBeNull();
});
