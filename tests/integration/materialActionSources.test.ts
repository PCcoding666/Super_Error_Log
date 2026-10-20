import { afterEach, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import sharp from 'sharp';
import { normalizePhoto } from '../../src/media/images.js';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { migrateMaterials } from '../../src/materials/schema.js';
import { MaterialStore } from '../../src/materials/store.js';
import { MaterialJobs } from '../../src/materials/jobs.js';
import { MaterialUploads } from '../../src/materials/uploads.js';
import { MobileRecognitionStore } from '../../src/mobile/store.js';
import { MobileRecognitionService } from '../../src/mobile/service.js';
import { backfillLegacyMaterials } from '../../src/materials/legacy.js';
import { createMaterialActionProvider } from '../../src/materials/provider.js';
import { answerEligibility } from '../../src/materials/answers.js';
import { readSourceBytes, readFragmentImage } from '../../src/materials/media.js';
import type { Fragment } from '../../src/materials/contracts.js';
const cleanup: (()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function fixture(layout:'direct'|'mobile'|'upload', identicalNormalization=false) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'material-action-source-')),db=new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');db.exec(SCHEMA_SQL);migrateMaterials(db);
  db.exec("INSERT INTO student_profile(id,nickname,created_at) VALUES ('alice','Synthetic A','2026-10-20'),('bob','Synthetic B','2026-10-20')");
  const store=new MaterialStore(db,'alice'),mobile=await MobileRecognitionStore.open(dir);
  const scheduler=new MobileRecognitionService(mobile,{inventory:async()=>({candidates:[],warnings:[],capacityReached:false}),recognizeQuestion:async()=>{throw Error('unused');}});
  const jobs=new MaterialJobs(store,scheduler,null),uploads=new MaterialUploads(store,jobs,null);
  cleanup.push(async()=>{await scheduler.stop();db.close();fs.rmSync(dir,{recursive:true,force:true});});
  const image=sharp({create:{width:80,height:40,channels:3,background:'#f00'}});
  const bytes=await (identicalNormalization?image.jpeg({quality:88}):image.jpeg().withMetadata({orientation:6})).toBuffer(),hash=createHash('sha256').update(bytes).digest('hex');
  let assetId:string,original:string,jobFile:string|null=null,derivative:string|null=null;
  if(layout==='upload') {
    const saved=await uploads.save({captureId:store.createCapture(randomUUID()).id,uploadId:randomUUID(),filename:'synthetic.jpg',bytes,hints:{}});assetId=saved.assetId;
    original=uploads.source(assetId).originalPath;derivative=uploads.source(assetId).normalizedPath;
  } else {
    assetId='legacy-source';let file=path.join(dir,'legacy-original.jpg'),jobId='direct-job';original=file;fs.writeFileSync(file,bytes);
    if(layout==='mobile') {
      const normalized=identicalNormalization?await normalizePhoto(bytes):await sharp(bytes).rotate().jpeg({quality:65}).toBuffer();
      if(identicalNormalization)expect(normalized).toEqual(bytes);else expect(normalized).not.toEqual(bytes);
      const {job}=await mobile.createJob({idempotencyKey:randomUUID(),photoName:'synthetic.jpg',sourceBytes:bytes,normalizedBytes:normalized});
      jobId=job.id;file=path.join(dir,'jobs',job.id,'media',`${job.sourceMediaId}.jpg`);derivative=file;
      original=path.join(dir,'jobs',job.id,'source-original.jpg');jobFile=path.join(dir,'jobs',job.id,'job.json');
    }
    db.prepare('INSERT INTO source_batch(id,student_id,created_at) VALUES (?,?,?)').run('batch','alice','2026-10-20');
    db.prepare('INSERT INTO source_asset(id,batch_id,filename,mime,size,content_hash,storage_path,created_at) VALUES (?,?,?,?,?,?,?,?)').run(assetId,'batch','synthetic.jpg','image/jpeg',bytes.length,hash,file,'2026-10-20');
    db.prepare('INSERT INTO error_item(id,student_id,batch_id,asset_id,item_index,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run('legacy-item','alice','batch',assetId,1,'ready_for_reflection','2026-10-20','2026-10-20');
    db.prepare('INSERT INTO mobile_item_link(item_id,job_id,question_id,question_revision) VALUES (?,?,?,?)').run('legacy-item',jobId,'legacy-q',1);
    const evidence={version:1,questionNumber:'1',questionText:'Read the diagram',subject:'数学',chapter:'',knowledgeTags:[],questionType:'',questionRegion:{x:0,y:0,width:1,height:.3},requiresDiagram:true,
      regions:[{id:'diagram',kind:'diagram',box:{x:0,y:.3,width:.5,height:.3},confidence:1,cleanForPrint:true},{id:'work',kind:'student_work',box:{x:0,y:.6,width:1,height:.3},confidence:1,cleanForPrint:false}],observations:[{id:'work-text',kind:'student_work',text:'x=3',regionId:'work',confidence:1}],uncertainties:[]};
    db.prepare('INSERT INTO evidence_record(item_id,content_json,verified,confidence_badge,updated_at) VALUES (?,?,?,?,?)').run('legacy-item',JSON.stringify(evidence),1,'ok','2026-10-20');
    expect(backfillLegacyMaterials(db).mapped).toBe(1);
  }
  if(layout==='upload') {
    const q=store.createQuestion({number:'1',subject:'数学'}).id,attempt=store.createAttempt(q).id;
    for(const [order,role] of (['question','diagram','student_work'] as const).entries()) {
      const f:Fragment={assetId,sourceHash:hash,fragmentId:randomUUID(),revision:1,box:{x:0,y:order/3,width:.5,height:1/3},role,text:role==='student_work'?'x=3':'synthetic stem',number:'1',subpart:null,page:1,order,requiresDiagram:role==='question',check:'passed',uncertainties:[]};
      store.putFragment(f);store.linkFragment(f.fragmentId,1,{questionId:q,attemptId:role==='student_work'?attempt:null});
    }
  }
  const q=store.listQuestions()[0]!;expect(answerEligibility(store,q.id)).toBeNull();
  expect(readSourceBytes(store,q.stem[0]!)).toEqual(bytes);
  let calls=0;const images:number[]=[];
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw),content=body.messages[1].content,c=JSON.parse(content[0].text);calls++;
    images.push(content.filter((p:{type:string})=>p.type==='image_url').length);
    const result=c.operation==='answer'?{questionId:c.questionId,basisKey:c.basisKey,text:'x=2',fragmentIds:c.fragments.map((f:Fragment)=>f.fragmentId)}:{questionId:c.questionId,attemptId:c.attemptId,basisKey:c.basisKey,result:'incorrect',findings:[{fragmentIds:c.work.map((f:Fragment)=>f.fragmentId),text:'Check the diagram'}],score:null};
    res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));cleanup.push(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
  const options={mode:'openai' as const,chat:{baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,apiKey:'synthetic',models:{material_extract:'e',material_verify:'v',material_answer:'a',material_grade:'g'},timeoutMs:2000,bailianOnly:false}};
  const provider=createMaterialActionProvider(options,{source:id=>uploads.source(id),request:async(_key,invoke)=>invoke(new AbortController().signal)});
  const signal=new AbortController().signal;
  const answer=()=>provider.answer({questionId:q.id,basisKey:'answer-basis',fragments:q.stem},signal);
  const grade=()=>provider.grade({questionId:q.id,attemptId:q.attempts[0]!.id,basisKey:'grade-basis',stem:q.stem,work:q.attempts[0]!.fragments,answers:[]},signal);
  return {store,db,q,bytes,original,derivative,jobFile,assetId,answer,grade,calls:()=>calls,images};
}
it.each(['direct','mobile','upload'] as const)('answers diagrams and grades work from the verified %s original using the registered action binding',async layout=>{
  const f=await fixture(layout);
  // The original is authoritative even when the derivative is unusable.
  if(f.derivative)fs.writeFileSync(f.derivative,'damaged derivative');
  expect((await f.answer()).text).toBe('x=2');expect((await f.grade()).result).toBe('incorrect');
  expect(f.calls()).toBe(2);expect(f.images).toEqual([1,2]);
});
it.each(['direct','mobile','upload'] as const)('rejects missing, altered and foreign %s originals before action HTTP calls',async layout=>{
  const f=await fixture(layout);
  for(const action of [f.answer,f.grade]) {
    fs.writeFileSync(f.original,'altered');await expect(action()).rejects.toThrow();
    fs.unlinkSync(f.original);await expect(action()).rejects.toThrow();fs.writeFileSync(f.original,f.bytes);
    f.db.prepare('UPDATE source_batch SET student_id=? WHERE id=(SELECT s.batch_id FROM source_asset s JOIN material_asset a ON a.source_asset_id=s.id WHERE a.id=?)').run('bob',f.assetId);
    await expect(action()).rejects.toThrow();
    f.db.prepare('UPDATE source_batch SET student_id=? WHERE id=(SELECT s.batch_id FROM source_asset s JOIN material_asset a ON a.source_asset_id=s.id WHERE a.id=?)').run('alice',f.assetId);
  }
  expect(f.calls()).toBe(0);
});
it.each(['job-id','hash','media-kind','media-path','owner-link'] as const)('rejects mobile %s identity mismatch before answer/grading requests',async mismatch=>{
  const f=await fixture('mobile'),job=JSON.parse(fs.readFileSync(f.jobFile!,'utf8'));
  if(mismatch==='job-id')job.id='foreign-job';
  if(mismatch==='hash')job.sourceHash='changed';
  if(mismatch==='media-kind')job.media[job.sourceMediaId].kind='crop';
  if(mismatch==='media-path')job.media[job.sourceMediaId].filename='../source-original.jpg';
  if(mismatch==='owner-link')f.db.prepare('UPDATE mobile_item_link SET job_id=? WHERE item_id=?').run('foreign-job','legacy-item');
  fs.writeFileSync(f.jobFile!,JSON.stringify(job));
  await expect(f.answer()).rejects.toThrow();await expect(f.grade()).rejects.toThrow();expect(f.calls()).toBe(0);
});

it.each(['mismatched-link','missing-link','missing-link-and-job-file','foreign-item-owner','job-metadata-only','bridge-provenance-only'] as const)('rejects identified mobile %s even with a naturally identical derivative and missing original',async problem=>{
  const f=await fixture('mobile',true);
  expect(fs.readFileSync(f.derivative!)).toEqual(f.bytes);
  fs.unlinkSync(f.original);
  if(problem==='mismatched-link')f.db.prepare('UPDATE mobile_item_link SET job_id=? WHERE item_id=?').run('foreign-job','legacy-item');
  else if(problem==='foreign-item-owner')f.db.prepare('UPDATE error_item SET student_id=? WHERE id=?').run('bob','legacy-item');
  else f.db.prepare('DELETE FROM mobile_item_link WHERE item_id=?').run('legacy-item');
  if(problem==='job-metadata-only'||problem==='bridge-provenance-only')f.db.prepare("DELETE FROM material_legacy_map WHERE source_kind='error_item'").run();
  if(problem==='bridge-provenance-only') {
    const job=JSON.parse(fs.readFileSync(f.jobFile!,'utf8'));
    f.db.prepare('INSERT INTO v2_photo(job_id,student_id,asset_id,registered_at) VALUES (?,?,?,?)').run(job.id,'alice',f.assetId,'2026-10-20');
  }
  if(problem==='missing-link-and-job-file'||problem==='bridge-provenance-only')fs.unlinkSync(f.jobFile!);
  await expect(f.answer()).rejects.toThrow();await expect(f.grade()).rejects.toThrow();expect(f.calls()).toBe(0);
  expect(()=>readSourceBytes(f.store,f.q.stem[0]!)).toThrow();
  await expect(readFragmentImage(f.store,f.q.stem[0]!.fragmentId,1)).rejects.toThrow();
});
it('keeps a genuine direct legacy original inside a generic media directory',async()=>{
  const f=await fixture('direct',true),directory=path.join(path.dirname(f.original),'archive','media');
  fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(path.dirname(directory),'job.json'),JSON.stringify({id:'unrelated-job',media:{}}));const filename=path.join(directory,'original.jpg');fs.renameSync(f.original,filename);
  f.db.prepare('UPDATE source_asset SET storage_path=? WHERE id=?').run(filename,f.assetId);
  expect(readSourceBytes(f.store,f.q.stem[0]!)).toEqual(f.bytes);
  expect((await f.answer()).text).toBe('x=2');expect((await f.grade()).result).toBe('incorrect');expect(f.calls()).toBe(2);
});
