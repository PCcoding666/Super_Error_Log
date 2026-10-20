import type { PracticeReviewer } from '../ai/practiceReview.js';
import { practiceSubmissionRouter } from './practiceSubmissionRouter.js';
import multer from 'multer';
import { handwritingRecognizer, type HandwritingRecognizer } from '../ai/handwriting.js';
import { attachWork, latestWork, recognizeWork, workImage } from '../v2/practiceWork.js';
import type { AdmissionController } from '../mobile/admission.js';
import { acquireUploadAdmission, releaseUploadAdmission, trackUploadAdmission } from '../mobile/router.js';
import type { RateLimiter } from '../mobile/rateLimit.js';
import { Router, urlencoded, type Request, type Response, type NextFunction } from 'express';
import type { CoachProvider } from '../ai/provider.js';
import { getPractice } from '../v2/practiceService.js';
import { getPrintStatus, requestPrint, type PrintSnapshot } from '../v2/printService.js';
import { practiceProgress, revealPracticeHint, savePracticeCursor } from '../v2/practiceProgress.js';
import { submitReturns } from '../v2/returnService.js';
import { sendHtml } from '../views/render.js';
import { OnlinePracticePage } from './views/onlinePractice.js';
import { localDayText } from './weekPlan.js';
import { taskLifecycle } from '../v2/practiceTasks.js';

/** Mounted only after the existing student authentication and same-origin guards. */
export function practiceRouter(options: { coachProvider?: CoachProvider; practiceReviewer?:PracticeReviewer; handwriting?: HandwritingRecognizer; limiter: RateLimiter; admission: AdmissionController | null; timeZone: string; now: () => Date }): Router {
  const router = Router();
  const form = urlencoded({ extended: false, limit: '16kb' });
  router.use('/practice/:pid', (req, res, next) => {
    const practice = getPractice(String(req.params.pid));
    if (!practice) { res.status(404).send('练习不存在'); return; }
    if (req.method === 'POST' && taskLifecycle(practice.id) === 'cancelled') {
      res.status(409).send('这份练习已取消，已记录的结果仍然保留。'); return;
    }
    res.locals.practice = practice;
    next();
  });
  router.use(practiceSubmissionRouter({...options,reviewer:options.practiceReviewer}));
  const show = (req: Request, res: Response, error?: string, selectedItem?: string, selectedView?: string) => {
    if (req.query.uploadError) error = '照片未保存，请重拍或直接核对。';
    const p = res.locals.practice as NonNullable<ReturnType<typeof getPractice>>;
    const state = getPrintStatus(p.id);
    const body = state.httpStatus === 200 ? state.body : {};
    const itemId = selectedItem ?? (typeof req.query.item === 'string' ? req.query.item : undefined);
    const view = selectedView ?? String(req.query.view ?? '');
    if (itemId && !p.items.some(item => item.id === itemId)) { res.status(404).send('题目不在此练习中'); return; }
    if (itemId && taskLifecycle(p.id)!=='cancelled') savePracticeCursor(p.id,itemId);
    sendHtml(res, OnlinePracticePage({ practice: p, lifecycle:taskLifecycle(p.id), progress: practiceProgress(p.id), state: String(body.status), snapshot: body.status === 'ready' ? body.snapshot as PrintSnapshot : undefined, itemId, view, paper: req.query.mode === 'paper', today: localDayText(options.now(), options.timeZone), earliestDay: localDayText(new Date(p.generatedAt ?? p.createdAt), options.timeZone), works: Object.fromEntries(p.items.map(item => [item.id, latestWork(p.id, item.id)])), error }));
  };
  router.get('/practice/:pid', (req, res) => show(req, res));
  router.post('/practice/:pid/prepare', (_req, res) => {
    const p = res.locals.practice;
    requestPrint(p.id, options.coachProvider);
    res.redirect(303, `/s/practice/${p.id}`);
  });
  const member = (req: Request, res: Response, next: NextFunction) => {
    if (!res.locals.practice.items.some((item: {id: string}) => item.id === req.params.itemId)) { res.status(404).send('题目不在此练习中'); return; }
    next();
  };
  const upload = multer({ storage: multer.memoryStorage(), limits: {fileSize:15*1024*1024, files:2, fields:4, parts:8} }).array('photo', 2);
  router.post('/practice/:pid/:itemId/work', member, async (req, res) => {
    const gate = options.limiter.transcribe(String(res.locals.deviceId));
    if (!gate.allowed) { res.setHeader('retry-after', String(gate.retryAfterSeconds)); res.status(429).json({error:{message:'上传次数较多，请稍后再试，也可以直接核对。'}}); return; }
    const dest = `/s/practice/${req.params.pid}?item=${req.params.itemId}&view=check`;
    const admission = options.admission;
    const reserve = admission ? trackUploadAdmission(admission, res) : null;
    const fail = (status: number, message: string) => {
      if (req.accepts(['html','json']) === 'json') res.status(status).json({error:{message}});
      else res.redirect(303, `${dest}&uploadError=1`);
    };
    try {
      // Reserve before multer buffers the body; share capture's storage and capacity limits.
      if (admission && reserve) {
        const rejection = await acquireUploadAdmission(admission, reserve);
        if (res.destroyed) return;
        if (rejection) {
          if (rejection.retryAfterSeconds !== undefined) res.setHeader('retry-after', String(rejection.retryAfterSeconds));
          fail(rejection.status, rejection.message); return;
        }
      }
      await new Promise<void>((resolve,reject) => upload(req,res,error => error ? reject(new Error('照片过大或格式不正确，请重新选择')) : resolve()));
      const files = ((req.files ?? []) as Express.Multer.File[]).filter(file => file.size > 0);
      if (files.length !== 1) throw new Error('请选择一张作答照片');
      const save = async () => {
        if (res.destroyed) throw new Error('上传已取消');
        return attachWork(String(req.params.pid),String(req.params.itemId),String(req.body?.key ?? ''),files[0]!.buffer);
      };
      const work = admission ? await admission.withImage(save) : await save();
      await recognizeWork(work.id, options.handwriting ?? handwritingRecognizer());
      if (res.destroyed) return;
      if (req.accepts(['html','json']) === 'json') res.json({ok:true,jobId:work.id});
      else res.redirect(303,dest);
    } catch (err) {
      if (!res.destroyed) fail(400, err instanceof Error ? err.message : '照片未保存，请重试或直接核对');
    } finally {
      // No mobile job handoff: both reservations belong to this request.
      if (admission && reserve) releaseUploadAdmission(admission, reserve);
    }
  });
  router.get('/practice/:pid/:itemId/work/:wid/image', member, (req,res) => {
    const bytes = workImage(String(req.params.pid),String(req.params.itemId),String(req.params.wid));
    if (!bytes) {res.status(404).send('照片不存在'); return;}
    res.type('jpeg').send(bytes);
  });
  router.post('/practice/:pid/:itemId/work/retry', member, async (req,res) => {
    const work = latestWork(String(req.params.pid),String(req.params.itemId));
    const gate = options.limiter.transcribe(String(res.locals.deviceId));
    if (!gate.allowed) {res.setHeader('retry-after',String(gate.retryAfterSeconds));res.status(429).send('请稍后重试，仍可直接核对');return;}
    if (work) await recognizeWork(work.id, options.handwriting ?? handwritingRecognizer());
    res.redirect(303, `/s/practice/${req.params.pid}?item=${req.params.itemId}&view=check`);
  });
  router.post('/practice/:pid/:itemId/hint', form, member, (req, res) => {
    const level = Number(req.body?.level);
    if (level !== 1 && level !== 2) { res.status(400).send('提示等级无效'); return; }
    revealPracticeHint(String(req.params.pid), String(req.params.itemId), level);
    res.redirect(303, `/s/practice/${req.params.pid}?item=${req.params.itemId}`);
  });
  router.post('/practice/:pid/:itemId/skip', member, (req, res) => {
    const p = res.locals.practice as NonNullable<ReturnType<typeof getPractice>>;
    const progress = practiceProgress(p.id);
    const index = p.items.findIndex(item => item.id === req.params.itemId);
    const rotated = [...p.items.slice(index + 1), ...p.items.slice(0, index + 1)];
    const next = rotated.find(item => !progress.answers[item.id]);
    if (next) savePracticeCursor(p.id, next.id);
    res.redirect(303, `/s/practice/${p.id}`);
  });
  router.post('/practice/:pid/:itemId/result', form, member, (req, res) => {
    const pid = String(req.params.pid), itemId = String(req.params.itemId);
    const progress = practiceProgress(pid);
    if (progress.answers[itemId]) { res.redirect(303, `/s/practice/${pid}${req.body?.mode === 'paper' ? '?mode=paper&view=check' : ''}`); return; }
    if (req.body?.correct !== 'yes' && req.body?.correct !== 'no') { res.status(400).send('请选择做对了或做错了'); return; }
    const hint = Math.max(progress.hints[itemId] ?? 0, req.body?.usedHint === 'yes' ? 1 : 0);
    const result = submitReturns(pid, { results: [{ itemId, completion: hint === 2 ? 'hint2' : hint === 1 ? 'hint1' : 'independent', correct: req.body.correct === 'yes', performedOn: req.body.performedOn }] });
    const error = !result.ok ? result.message : result.results.find(entry => !entry.ok)?.error;
    if (error) { res.status(400); show(req, res, error, itemId, 'check'); return; }
    const next = res.locals.practice.items.find((item: {id: string}) => item.id !== itemId && !progress.answers[item.id]);
    if (next) savePracticeCursor(pid, next.id);
    res.redirect(303, `/s/practice/${pid}${req.body?.mode === 'paper' ? '?mode=paper&view=check' : ''}`);
  });
  return router;
}
