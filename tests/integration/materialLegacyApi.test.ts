import { getLearningReturnSummary } from '../../src/v2/returnService.js';
import { expect, it } from 'vitest';
import express from 'express';
import { getDb,newId,now } from '../../src/db/connection.js';
import { ensureStudentProfile } from '../../src/services/studentService.js';
import { MaterialStore } from '../../src/materials/store.js';
import { setQuestionIncluded } from '../../src/materials/learning.js';
import { createLearningPractice, getLearningPractice } from '../../src/learning/queries.js';
import { getPractice,listPractices } from '../../src/v2/practiceService.js';
import { createV2Router } from '../../src/v2/router.js';
it.each(['material','mixed'])('hides every %s packet and material item entrypoint from legacy APIs',async(kind)=>{
 const db=getDb(),owner=ensureStudentProfile().id,store=new MaterialStore(db,owner),batch=newId('bat'),asset=newId('ast');
 db.prepare('INSERT INTO source_batch(id,student_id,created_at) VALUES (?,?,?)').run(batch,owner,now());
 db.prepare('INSERT INTO source_asset(id,batch_id,filename,mime,size,content_hash,storage_path,created_at) VALUES (?,?,?,?,?,?,?,?)').run(asset,batch,'s.jpg','image/jpeg',1,'hash','/s.jpg',now());
 const capture=store.createCapture(crypto.randomUUID());db.prepare('INSERT INTO material_asset(id,owner_id,capture_id,source_asset_id) VALUES (?,?,?,?)').run(asset,owner,capture.id,asset);
 const q=store.createQuestion({subject:'数学'}).id;const f={assetId:asset,fragmentId:newId('mfr'),revision:1,box:{x:0,y:0,width:1,height:1},sourceHash:'hash',role:'question' as const,text:'1+1',number:'1',subpart:null,page:null,order:0,requiresDiagram:false,check:'passed' as const,uncertainties:[]};
 store.putFragment(f);store.linkFragment(f.fragmentId,1,{questionId:q,attemptId:null});const item=setQuestionIncluded(store,q,true,store.getQuestion(q)!.revision).itemId!;
 const legacyItem=newId('itm');const jobId=crypto.randomUUID();
 db.prepare('INSERT INTO error_item(id,student_id,batch_id,asset_id,item_index,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(legacyItem,owner,batch,asset,2,'ready_for_reflection',now(),now());
 db.prepare('INSERT INTO mobile_item_link(item_id,job_id,question_id,question_revision) VALUES (?,?,?,?)').run(legacyItem,jobId,crypto.randomUUID(),1);
 const selected=kind==='mixed'?[legacyItem,item]:[item];
 const created=createLearningPractice({itemIds:selected});expect(created.ok).toBe(true);if(!created.ok)return;const id=created.detail.id;
 expect(getLearningPractice(id)!.items.map(c=>c.id)).toEqual(selected);
 setQuestionIncluded(store,q,false,store.getQuestion(q)!.revision);expect(getLearningPractice(id)!.items.map(c=>c.id)).toEqual(selected);expect(getLearningReturnSummary(id)!.total).toBe(selected.length);
 expect(getPractice(id)).toBeNull();expect(listPractices().map(p=>p.id)).not.toContain(id);
 const app=express();app.use('/v2',createV2Router({mobileDataDir:'/nonexistent'}));const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const addr=server.address() as {port:number};
 try{for(const [method,url] of [['GET',`practice/${id}`],['GET',`practice/${id}/print`],['POST',`practice/${id}/print`],['GET',`practice/${id}/print/media/a.jpg`],['POST',`practice/${id}/return`],['GET',`practice/${id}/summary`],['GET',`items/${item}/evidence`],['POST',`items/${item}/reflection/ask`],['POST',`items/${item}/correct/direct`],['POST',`items/${item}/correct`],['POST',`items/${item}/correct/accept`],['POST',`items/${item}/reflection/answer`],['POST',`items/${item}/reflection`],['GET',`items/${item}/reflection`],['GET',`items/${item}/crop`],['POST',`items/${item}/discard`],['POST',`items/${item}/restore`]]){
 expect((await fetch(`http://127.0.0.1:${addr.port}/v2/${url}`,{method})).status,url).toBe(404);
 }
 const listed=await (await fetch(`http://127.0.0.1:${addr.port}/v2/practice`)).json();expect(listed.packets.map((p:{id:string})=>p.id)).not.toContain(id);
 }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
