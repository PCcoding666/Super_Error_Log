import multer from 'multer';
import { Router, urlencoded, type Request, type Response } from 'express';
import { getDb } from '../db/connection.js';
import { practiceReviewer, type PracticeReviewer } from '../ai/practiceReview.js';
import type { AdmissionController } from '../mobile/admission.js';
import type { RateLimiter } from '../mobile/rateLimit.js';
import { acquireUploadAdmission, releaseUploadAdmission, trackUploadAdmission } from '../mobile/router.js';
import { attachSubmission, submissionState, submissionImage, reviewSubmission, isReviewing, assignFinding, confirmSubmission } from '../v2/practiceSubmission.js';
import type { PracticeDetail } from '../v2/practiceService.js';
import { getPrintStatus } from '../v2/printService.js';
import { practiceProgress } from '../v2/practiceProgress.js';
import { taskLifecycle } from '../v2/practiceTasks.js';
import { getReturnSummary } from '../v2/returnService.js';
import { sendHtml } from '../views/render.js';
import { localDayText } from './weekPlan.js';
import { PracticeSubmitPage, PracticeFeedbackPage } from './views/practiceSubmission.js';

/** Parent mounts this only after student auth, CSRF and task existence/lifecycle checks. */
export function practiceSubmissionRouter(options:{reviewer?:PracticeReviewer;limiter:RateLimiter;admission:AdmissionController|null;timeZone:string;now:()=>Date}):Router {
  const r=Router(),form=urlencoded({extended:false,limit:'16kb'});
  const feedback=(req:Request,res:Response,error?:string)=>{
    const p=res.locals.practice as PracticeDetail;
    const legacy=getDb().prepare('SELECT COUNT(*) n FROM practice_work WHERE packet_id=?').get(p.id) as {n:number};
    sendHtml(res,PracticeFeedbackPage({practice:p,state:submissionState(p.id),progress:practiceProgress(p.id),summary:getReturnSummary(p.id),cancelled:taskLifecycle(p.id)==='cancelled',today:localDayText(options.now(),options.timeZone),earliestDay:localDayText(new Date(p.generatedAt??p.createdAt),options.timeZone),legacyPhotos:legacy.n,error,draft:req.method==='POST'?req.body:undefined}));
  };
  const uploadPage=(req:Request,res:Response,error?:string)=>{
    const p=res.locals.practice as PracticeDetail,cancelled=taskLifecycle(p.id)==='cancelled';
    sendHtml(res,PracticeSubmitPage({practice:p,state:submissionState(p.id),cancelled,error}));
  };
  r.get('/practice/:pid/submit',(req,res)=>uploadPage(req,res));
  r.get('/practice/:pid/feedback',(req,res)=>feedback(req,res));
  const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:15*1024*1024,files:2,fields:4,parts:8}}).array('photo',2);
  r.post('/practice/:pid/submission',async(req,res)=>{
    // Saving photos does not call AI. This per-device upload limit is separate from
    // the transcription quota used by /review, and it rejects before the body is read.
    // The parent query limit and upload admission still apply.
    const gate=options.limiter.upload(String(res.locals.deviceId));
    if(!gate.allowed){res.setHeader('retry-after',String(gate.retryAfterSeconds));res.status(429).json({error:{message:'上传次数较多，请稍后再试'}});return;}
    const admission=options.admission,reservation=admission?trackUploadAdmission(admission,res):null;
    const fail=(status:number,message:string)=>{res.status(status);if(req.accepts(['html','json'])==='json')res.json({error:{message}});else uploadPage(req,res,message);};
    try{
      if(admission&&reservation){const rejection=await acquireUploadAdmission(admission,reservation);if(res.destroyed)return;if(rejection){if(rejection.retryAfterSeconds!==undefined)res.setHeader('retry-after',String(rejection.retryAfterSeconds));fail(rejection.status,rejection.message);return;}}
      await new Promise<void>((resolve,reject)=>upload(req,res,error=>error?reject(new Error('照片过大或格式不正确，请重新选择')):resolve()));
      const files=((req.files??[]) as Express.Multer.File[]).filter(f=>f.size>0);
      if(files.length!==1)throw new Error('请一次上传一张照片；相册多选会按顺序自动保存');
      const save=async()=>{if(res.destroyed)throw new Error('上传已取消');return attachSubmission(String(req.params.pid),String(req.body?.key??''),files[0]!.buffer);};
      const photo=admission?await admission.withImage(save):await save();
      if(res.destroyed)return;
      if(req.accepts(['html','json'])==='json')res.json({ok:true,jobId:photo.id});else res.redirect(303,`/s/practice/${req.params.pid}/submit`);
    }catch(error){if(!res.destroyed)fail(400,error instanceof Error&&/^[\u4e00-\u9fff]/u.test(error.message)?error.message:'照片读不出来，请重新选择 JPEG 照片');}
    finally{if(admission&&reservation)releaseUploadAdmission(admission,reservation);}
  });
  r.get('/practice/:pid/submission/:id/image',(req,res)=>{
    const bytes=submissionImage(String(req.params.pid),String(req.params.id));
    if(!bytes){res.status(404).send('照片不存在');return;}
    res.setHeader('cache-control','private, no-store');res.type('jpeg').send(bytes);
  });
  r.post('/practice/:pid/review',async(req,res)=>{
    const pid=String(req.params.pid),dest=`/s/practice/${pid}/feedback`;
    const state=submissionState(pid);
    if(isReviewing(pid)||state.status==='ready'||state.attempts>=3){res.redirect(303,dest);return;}
    const prepared=getPrintStatus(pid, 'all');
    if(!state.photos.length||prepared.httpStatus!==200||prepared.body.status!=='ready'){res.status(400);feedback(req,res,!state.photos.length?'请先拍照提交作答':'题目还没有准备好，请先回到题目查看准备进度');return;}
    const gate=options.limiter.transcribe(String(res.locals.deviceId));
    if(!gate.allowed){res.setHeader('retry-after',String(gate.retryAfterSeconds));res.status(429);feedback(req,res,'核对次数较多，请稍后再试，也可以自己核对');return;}
    const admission=options.admission;
    if(admission&&!admission.tryAcquireJobCapacity().accepted){res.setHeader('retry-after','30');res.status(429);feedback(req,res,'服务器正在忙，照片已保存，请稍后再核对');return;}
    // The request returns immediately after the durable analysis state is written.
    // The task owns capacity until completion, independent of the browser connection.
    const job=reviewSubmission(pid,options.reviewer??practiceReviewer(),admission?work=>admission.withImage(work):undefined);
    void job.catch(()=>undefined).finally(()=>admission?.releaseJobCapacity());
    res.redirect(303,dest);
  });
  r.post('/practice/:pid/assign',form,(req,res)=>{
    const pid=String(req.params.pid);
    try{assignFinding(pid,Number(req.body?.revision),Number(req.body?.finding),String(req.body?.itemId??''));res.redirect(303,`/s/practice/${pid}/feedback`);}
    catch(error){res.status(400);feedback(req,res,error instanceof Error?error.message:'题号没有保存');}
  });
  r.post('/practice/:pid/confirm',form,(req,res)=>{
    const pid=String(req.params.pid),p=res.locals.practice as PracticeDetail;
    try{
      const results=p.items.filter(item=>req.body?.[`outcome_${item.id}`]).map(item=>({itemId:item.id,outcome:req.body[`outcome_${item.id}`],performedOn:req.body[`date_${item.id}`],help:req.body[`help_${item.id}`]}));
      const result=confirmSubmission(pid,{revision:Number(req.body?.revision),performedOn:req.body?.performedOn,help:req.body?.help,results});
      const error=!result.ok?result.message:result.results.filter(r=>!r.ok).map(r=>r.error).join('；');
      if(error){res.status(400);feedback(req,res,error);return;}
      res.redirect(303,`/s/practice/${pid}/feedback`);
    }catch(error){res.status(400);feedback(req,res,error instanceof Error?error.message:'结果没有保存');}
  });
  return r;
}
