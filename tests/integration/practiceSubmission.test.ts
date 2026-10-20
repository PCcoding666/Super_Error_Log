import crypto from 'node:crypto';
import sharp from 'sharp';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb, now } from '../../src/db/connection.js';
import { createPractice } from '../../src/v2/practiceService.js';
import { attachWork } from '../../src/v2/practiceWork.js';
import { setTaskLifecycle } from '../../src/v2/practiceTasks.js';
import { attachSubmission, submissionState, submissionImage, reviewSubmission, assignFinding, confirmSubmission } from '../../src/v2/practiceSubmission.js';
import { validatePracticeReview, type PracticeReviewer } from '../../src/ai/practiceReview.js';
import { clearPracticeFixtures, seedPracticeItems } from '../helpers/practiceTask.js';

beforeEach(clearPracticeFixtures);
function prepared(count=3) {
  const ids=seedPracticeItems(count), result=createPractice({itemIds:ids});
  if(!result.ok) throw new Error(result.message);
  const p=result.detail;
  getDb().prepare("UPDATE review_packet SET status='generated',generated_at=? WHERE id=?").run(now(),p.id);
  getDb().prepare("UPDATE error_item SET status='packet_generated' WHERE id IN (SELECT item_id FROM review_packet_item WHERE packet_id=?)").run(p.id);
  const snapshot={packetId:p.id,week:p.week,preparedAt:now(),cover:{title:'synthetic',practiceSlot:'',rules:[],itemList:[]},items:ids.map((id,index)=>({itemId:id,position:index,stemText:'求解 x+1=2',cropMedia:null,diagramMedia:[],needsGlance:false})),answerSheet:ids.map(()=>({answer:{text:'x=1',source:'paper'}}))};
  getDb().prepare("INSERT INTO v2_print_snapshot(packet_id,status,progress_done,progress_total,snapshot_json,created_at) VALUES (?,'ready',?,?,?,?)").run(p.id,count,count,JSON.stringify(snapshot),now());
  return {p,ids};
}
const photo=()=>sharp({create:{width:20,height:20,channels:3,background:'#ffffff'}}).jpeg().toBuffer();
const finding=(questionNumber:number|null,photoNumbers=[1])=>({questionNumber,photoNumbers,text:'x=1',complete:true,uncertain:false,suggestedCorrect:true,feedback:'计算过程与参考答案一致。'});
const reviewer:PracticeReviewer={review:async()=>({findings:[finding(1),finding(null)]})};
const attempts=()=>getDb().prepare('SELECT COUNT(*) n FROM review_attempt').get();

describe('durable whole-task paper submission',()=>{
 it('stores JPEGs only in the task, deduplicates concurrent retries, and isolates ownership',async()=>{
   const {p}=prepared(), other=prepared(1).p, bytes=await photo(), key=crypto.randomUUID();
   const [a,b]=await Promise.all([attachSubmission(p.id,key,bytes),attachSubmission(p.id,key,bytes)]);
   expect(a.id).toBe(b.id); expect(submissionState(p.id)).toMatchObject({revision:1,status:'pending',photos:[{id:a.id}]});
   expect(submissionImage(other.id,a.id)).toBeNull();
   expect(await sharp(submissionImage(p.id,a.id)!).metadata()).toMatchObject({format:'jpeg'});
   await expect(attachSubmission(other.id,key,bytes)).rejects.toThrow('标识');
   expect(attempts()).toEqual({n:0});
   expect(getDb().prepare('SELECT COUNT(*) n FROM error_item').get()).toEqual({n:4});
 });
 it('reviews all pages together, preserves ambiguity and cannot write mastery until explicit confirmation',async()=>{
   const {p,ids}=prepared(); const bytes=await photo();
   await attachSubmission(p.id,crypto.randomUUID(),bytes); await attachSubmission(p.id,crypto.randomUUID(),bytes);
   let calls=0;
   const provider:PracticeReviewer={review:async input=>{calls++;expect(input.photos).toHaveLength(2);expect(input.questions).toHaveLength(3);return {findings:[finding(1,[1,2]),finding(null,[2])]};}};
   await Promise.all([reviewSubmission(p.id,provider),reviewSubmission(p.id,provider)]);
   expect(calls).toBe(1); expect(attempts()).toEqual({n:0});
   let state=submissionState(p.id); expect(state.status).toBe('ready');expect(state.findings[1]?.itemId).toBeNull();
   assignFinding(p.id,state.revision,1,ids[1]!);
   state=submissionState(p.id); expect(state.findings[1]).toMatchObject({itemId:ids[1],suggestedCorrect:null,uncertain:true});
   const confirm={revision:state.revision,performedOn:now().slice(0,10),help:'independent',results:[{itemId:ids[0],outcome:'correct'}]};
   expect(confirmSubmission(p.id,confirm)).toMatchObject({ok:true});
   expect(confirmSubmission(p.id,confirm)).toMatchObject({ok:true}); expect(attempts()).toEqual({n:1});
   expect(getDb().prepare('SELECT status FROM error_item WHERE id=?').get(ids[0]!)).toEqual({status:'attempted'});
   expect(getDb().prepare('SELECT status FROM error_item WHERE id=?').get(ids[2]!)).toEqual({status:'packet_generated'});
 });
 it('rejects missing help, stale revisions and foreign item IDs without recording',async()=>{
   const {p,ids}=prepared(), foreign=prepared(1).ids[0]; await attachSubmission(p.id,crypto.randomUUID(),await photo()); await reviewSubmission(p.id,reviewer);
   const input={revision:1,performedOn:now().slice(0,10),help:'independent',results:[{itemId:ids[0],outcome:'correct'}]};
   expect(()=>confirmSubmission(p.id,{...input,help:''})).toThrow();
   expect(()=>confirmSubmission(p.id,{...input,results:[{itemId:foreign,outcome:'correct'}]})).toThrow();
   await attachSubmission(p.id,crypto.randomUUID(),await photo());
   expect(()=>confirmSubmission(p.id,input)).toThrow('更新');expect(attempts()).toEqual({n:0});
 });
 it('never overwrites newer photos with an older analysis, and cancelled uploads/reviews cannot write',async()=>{
   const {p}=prepared(); await attachSubmission(p.id,crypto.randomUUID(),await photo());
   let finish!:(value:unknown)=>void;
   let entered!:(value:void)=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
   const job=reviewSubmission(p.id,{review:async()=>{entered();return await new Promise(resolve=>{finish=resolve;});}});
   await started; await attachSubmission(p.id,crypto.randomUUID(),await photo());finish({findings:[finding(1)]});await job;
   expect(submissionState(p.id)).toMatchObject({revision:2,status:'pending',findings:[]});
   setTaskLifecycle(p.id,'cancelled');await expect(attachSubmission(p.id,crypto.randomUUID(),await photo())).rejects.toThrow('取消');
   await expect(reviewSubmission(p.id,reviewer)).rejects.toThrow('取消');expect(attempts()).toEqual({n:0});
 });
 it('bounds retries and preserves photos through failure and interrupted analysis',async()=>{
   const {p}=prepared(); await attachSubmission(p.id,crypto.randomUUID(),await photo());
   getDb().prepare("UPDATE practice_submission SET status='analyzing'").run();
   expect(submissionState(p.id).status).toBe('interrupted');
   const fail:PracticeReviewer={review:async()=>{throw new Error('private provider error');}};
   await reviewSubmission(p.id,fail); await reviewSubmission(p.id,fail); await reviewSubmission(p.id,fail); await reviewSubmission(p.id,fail);
   expect(submissionState(p.id)).toMatchObject({status:'failed',attempts:3,photos:[expect.any(Object)]});
   expect(JSON.stringify(submissionState(p.id))).not.toContain('private provider error');expect(attempts()).toEqual({n:0});
 });
 it('cancellation during image decoding rejects both new and legacy photo writes',async()=>{
   const a=prepared(1),b=prepared(1),bytes=await photo();
   const oldUpload=attachWork(a.p.id,a.ids[0]!,crypto.randomUUID(),bytes);
   const newUpload=attachSubmission(b.p.id,crypto.randomUUID(),bytes);
   setTaskLifecycle(a.p.id,'cancelled');setTaskLifecycle(b.p.id,'cancelled');
   const settled=await Promise.allSettled([oldUpload,newUpload]);
   expect(settled.map(r=>r.status)).toEqual(['rejected','rejected']);
   for(const result of settled)if(result.status==='rejected')expect(String(result.reason)).toContain('取消');
   expect(submissionState(b.p.id).photos).toHaveLength(0);
   expect(getDb().prepare('SELECT COUNT(*) n FROM practice_work').get()).toEqual({n:0});
 });
 it('caps each task at twelve photos and rejects changed retry payloads',async()=>{
   const {p}=prepared(1),bytes=await photo(),key=crypto.randomUUID();
   await attachSubmission(p.id,key,bytes);
   await expect(attachSubmission(p.id,key,Buffer.from('changed'))).rejects.toThrow('标识');
   for(let i=1;i<12;i++)await attachSubmission(p.id,crypto.randomUUID(),bytes);
   await expect(attachSubmission(p.id,crypto.randomUUID(),bytes)).rejects.toThrow('12 张');
   expect(submissionState(p.id).photos).toHaveLength(12);
 });
 it('normalizes incomplete, uncertain, unsupported and unreferenced grades to unresolved',()=>{
   const questions=[{number:1,itemId:'one',stem:'x=1',reference:null,uncertain:false,images:[]}];
   const result=validatePracticeReview({findings:[finding(1)]},questions,1);
   expect(result.findings[0]?.suggestedCorrect).toBeNull();
   expect(()=>validatePracticeReview({findings:[finding(2)]},questions,1)).toThrow();
   expect(()=>validatePracticeReview({findings:[finding(1,[2])]},questions,1)).toThrow();
   expect(validatePracticeReview({findings:[{...finding(1),complete:false}]},[{...questions[0]!,reference:'x=1'}],1).findings[0]?.suggestedCorrect).toBeNull();
 });
});
