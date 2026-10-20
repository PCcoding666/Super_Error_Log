import crypto from 'node:crypto';
import sharp from 'sharp';
import { getDb, newId, now } from '../db/connection.js';
import { validatePracticeReview, type PracticeReviewer, type ReviewFinding, type ReviewQuestion } from '../ai/practiceReview.js';
import { assertTaskWritable, taskLifecycle } from './practiceTasks.js';
import { getPractice } from './practiceService.js';
import { getPrintStatus, readPrintMedia, type PrintSnapshot } from './printService.js';
import { practiceProgress } from './practiceProgress.js';
import { submitReturns, type SubmitReturnResult } from './returnService.js';

export interface SubmissionPhoto {id:string;createdAt:string}
export interface SubmissionFinding extends ReviewFinding {itemId:string|null}
export interface SubmissionState {revision:number;status:'pending'|'analyzing'|'ready'|'failed'|'interrupted';attempts:number;findings:SubmissionFinding[];photos:SubmissionPhoto[]}
interface StateRow {revision:number;status:'pending'|'analyzing'|'ready'|'failed';attempts:number;findings_json:string}
const active=new Map<string,Promise<void>>();
export function submissionState(packetId:string):SubmissionState {
  const db=getDb();const row=db.prepare('SELECT revision,status,attempts,findings_json FROM practice_submission WHERE packet_id=?').get(packetId) as StateRow|undefined;
  const photos=db.prepare('SELECT id,created_at AS createdAt FROM practice_submission_photo WHERE packet_id=? ORDER BY rowid').all(packetId) as unknown as SubmissionPhoto[];
  return {revision:row?.revision??0,status:row?.status==='analyzing'&&!active.has(packetId)?'interrupted':row?.status??'pending',attempts:row?.attempts??0,findings:row?JSON.parse(row.findings_json):[],photos};
}
export function submissionImage(packetId:string,id:string):Buffer|null {
  const row=getDb().prepare('SELECT image FROM practice_submission_photo WHERE packet_id=? AND id=?').get(packetId,id) as {image:Uint8Array}|undefined;
  return row?Buffer.from(row.image):null;
}
const FULL_MESSAGE='本次已保存 12 张照片，可查看反馈或自己核对';
export async function attachSubmission(packetId:string,key:string,bytes:Buffer):Promise<SubmissionPhoto> {
  assertTaskWritable(packetId);
  if(!/^[0-9a-f-]{36}$/i.test(key))throw new Error('上传标识无效，请重新选择照片');
  if(!bytes.length||bytes.length>15*1024*1024)throw new Error('照片大小须在 15 MB 以内');
  const db=getDb();
  type Stored=SubmissionPhoto&{packet_id:string;source_hash:string};
  const lookup=()=>db.prepare('SELECT id,packet_id,source_hash,created_at AS createdAt FROM practice_submission_photo WHERE request_key=?').get(key) as Stored|undefined;
  const photoCount=()=>(db.prepare('SELECT COUNT(*) n FROM practice_submission_photo WHERE packet_id=?').get(packetId) as {n:number}).n;
  const existing=lookup();
  // A new photo on a full task stops here, before hashing or decoding. The insert
  // rechecks the same cap inside a write transaction so concurrent saves cannot pass 12.
  if(!existing&&photoCount()>=12)throw new Error(FULL_MESSAGE);
  const hash=crypto.createHash('sha256').update(bytes).digest('hex');
  const match=(row:Stored|undefined)=>{
    if(!row)return undefined;
    if(row.packet_id!==packetId||row.source_hash!==hash)throw new Error('上传标识已用于另一份照片');
    return {id:row.id,createdAt:row.createdAt};
  };
  const saved=match(existing);if(saved)return saved;
  const image=await sharp(bytes,{limitInputPixels:40_000_000}).rotate().resize({width:2048,height:2048,fit:'inside',withoutEnlargement:true}).jpeg({quality:88}).toBuffer();
  assertTaskWritable(packetId);
  const id=newId('psp'),createdAt=now();
  db.exec('BEGIN IMMEDIATE');
  try{
    const raced=match(lookup());
    if(raced){db.exec('ROLLBACK');return raced;}
    if(photoCount()>=12)throw new Error(FULL_MESSAGE);
    db.prepare('INSERT INTO practice_submission_photo(id,packet_id,request_key,source_hash,image,created_at) VALUES(?,?,?,?,?,?)').run(id,packetId,key,hash,image,createdAt);
    db.prepare("INSERT INTO practice_submission(packet_id,revision,status,updated_at) VALUES(?,1,'pending',?) ON CONFLICT(packet_id) DO UPDATE SET revision=revision+1,status='pending',attempts=0,findings_json='[]',updated_at=excluded.updated_at").run(packetId,createdAt);
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  return {id,createdAt};
}
export function isReviewing(packetId:string):boolean{return active.has(packetId);}
type ImageGate=<T>(work:()=>Promise<T>)=>Promise<T>;
/** Coalesces concurrent requests. A late result cannot replace a newer photo revision. */
export async function reviewSubmission(packetId:string,reviewer:PracticeReviewer,withImage:ImageGate=work=>work()):Promise<void> {
  assertTaskWritable(packetId);
  const existing=active.get(packetId);if(existing)return existing;
  const state=submissionState(packetId);if(!state.photos.length)throw new Error('请先提交作答照片');
  if(state.status==='ready'||state.attempts>=3)return;
  const print=getPrintStatus(packetId);
  if(print.httpStatus!==200||print.body.status!=='ready')throw new Error('题目还没有准备好，请先查看题目');
  const snapshot=print.body.snapshot as PrintSnapshot;
  const job=(async()=>{
    const db=getDb();db.prepare("UPDATE practice_submission SET status='analyzing',attempts=attempts+1,updated_at=? WHERE packet_id=? AND revision=?").run(now(),packetId,state.revision);
    try{
      const input=await withImage(async()=>{
        const photos:Buffer[]=[];const questions:ReviewQuestion[]=[];
        let imageBudget=0;
        const resize=async(bytes:Buffer,size:number)=>{
          const {data,info}=await sharp(bytes,{limitInputPixels:40_000_000}).resize({width:size,height:size,fit:'inside',withoutEnlargement:true}).jpeg({quality:90}).toBuffer({resolveWithObject:true});
          imageBudget+=Math.ceil(info.width/16)*Math.ceil(info.height/16)+1024;
          return data;
        };
        for(const photo of state.photos)photos.push(await resize(submissionImage(packetId,photo.id)!,1024));
        for(const [i,item] of snapshot.items.entries()){
          const media=[...(item.cropMedia?[item.cropMedia]:[]),...item.diagramMedia];
          const images:Buffer[]=[];let uncertain=item.needsGlance||media.length>2;
          for(const name of media.slice(0,2)){const bytes=readPrintMedia(packetId,name);if(bytes)images.push(await resize(bytes,384));else uncertain=true;}
          const stem=item.stemText??'',ref=snapshot.answerSheet[i]?.answer.text??null;
          questions.push({number:i+1,itemId:item.itemId,stem,reference:ref,uncertain,images});
        }
        // Allocate the remaining budget across full frozen text, reserving 10k for
        // prompt/JSON framing. Short submissions retain substantially more context.
        const textBudget=Math.min(8000,Math.max(0,Math.floor((90000-imageBudget)/(questions.length*2))));
        const bounded=(text:string)=>{let bytes=0,out='';for(const ch of text){bytes+=Buffer.byteLength(ch);if(bytes>textBudget)break;out+=ch;}return out;};
        for(const q of questions){
          const stem=bounded(q.stem),ref=q.reference===null?null:bounded(q.reference);
          if(stem!==q.stem||ref!==q.reference)q.uncertain=true;
          q.stem=stem;q.reference=ref;
        }
        return {photos,questions};
      });
      const result=validatePracticeReview(await reviewer.review(input),input.questions,input.photos.length);
      if(taskLifecycle(packetId)==='cancelled')return;
      const findings:SubmissionFinding[]=result.findings.map(f=>({...f,itemId:input.questions.find(q=>q.number===f.questionNumber)?.itemId??null}));
      db.prepare("UPDATE practice_submission SET status='ready',findings_json=?,updated_at=? WHERE packet_id=? AND revision=?").run(JSON.stringify(findings),now(),packetId,state.revision);
    }catch{
      db.prepare("UPDATE practice_submission SET status='failed',updated_at=? WHERE packet_id=? AND revision=?").run(now(),packetId,state.revision);
    }
  })();
  active.set(packetId,job);try{await job;}finally{if(active.get(packetId)===job)active.delete(packetId);}
}
function currentReview(packetId:string,revision:unknown):SubmissionState {
  assertTaskWritable(packetId);const state=submissionState(packetId);
  if(!Number.isInteger(revision)||revision!==state.revision||state.status!=='ready')throw new Error('照片或反馈已更新，请刷新后再确认');
  return state;
}
export function assignFinding(packetId:string,revision:number,index:number,itemId:string):void {
  const state=currentReview(packetId,revision),p=getPractice(packetId)!;
  const finding=state.findings[index];const number=p.items.findIndex(item=>item.id===itemId)+1;
  if(!Number.isInteger(index)||!finding||finding.itemId||!number)throw new Error('题号无法关联，请核对或补拍带题号的作答');
  const existing=state.findings.find(f=>f.itemId===itemId);
  if(existing){
    // One question may span several initially unidentifiable fragments. Association
    // adds evidence; it never promotes the combined work to a confident grade.
    existing.text=`${existing.text}\n\n补充作答（照片 ${finding.photoNumbers.join('、')}）：\n${finding.text}`;
    existing.photoNumbers=[...new Set([...existing.photoNumbers,...finding.photoNumbers])].sort((a,b)=>a-b);
    existing.complete=false;existing.uncertain=true;existing.suggestedCorrect=null;
    existing.feedback='已合并这道题的作答片段，请对照照片和参考答案确认结果。';
    state.findings.splice(index,1);
  }else{
    finding.itemId=itemId;finding.questionNumber=number;finding.uncertain=true;finding.suggestedCorrect=null;
  }
  getDb().prepare('UPDATE practice_submission SET revision=revision+1,findings_json=?,updated_at=? WHERE packet_id=? AND revision=?').run(JSON.stringify(state.findings),now(),packetId,revision);
}
export function confirmSubmission(packetId:string,input:unknown):SubmitReturnResult {
  const body=input as {revision?:unknown;performedOn?:unknown;help?:unknown;results?:unknown}|null;
  if(!body)throw new Error('请确认作答信息');
  currentReview(packetId,body.revision);
  if(!['independent','helped'].includes(String(body.help)))throw new Error('请说明这次是否用过提示或参考帮助');
  if(!Array.isArray(body.results)||!body.results.length||body.results.length>8)throw new Error('请选择至少一道有把握的结果');
  const p=getPractice(packetId)!,seen=new Set<string>();
  const results=body.results.map((raw:unknown)=>{
    const r=raw as {itemId?:unknown;outcome?:unknown;help?:unknown;performedOn?:unknown}|null;
    if(!r||typeof r.itemId!=='string'||!p.items.some(item=>item.id===r.itemId)||seen.has(r.itemId))throw new Error('题目不在本次练习中或重复');
    seen.add(r.itemId);
    if(!['correct','incorrect','not_solved'].includes(String(r.outcome)))throw new Error('作答结果无效');
    const help=r.help||body.help,performedOn=r.performedOn||body.performedOn;
    if(!['independent','helped'].includes(String(help))||typeof performedOn!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(performedOn))throw new Error('请填写实际做题日期和是否用过帮助');
    return {itemId:r.itemId,correct:r.outcome==='correct',completion:r.outcome==='not_solved'?'not_solved':help==='helped'?'hint1':'independent',performedOn};
  });
  const answers=practiceProgress(packetId).answers;
  const pending=results.filter(r=>!answers[r.itemId]);
  return pending.length?submitReturns(packetId,{results:pending}):{ok:true,results:[]};
}
