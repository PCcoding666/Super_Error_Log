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

/** Mounted only after the existing student authentication and same-origin guards. */
export function practiceRouter(options: { coachProvider?: CoachProvider; limiter: RateLimiter; timeZone: string; now: () => Date }): Router {
  const router = Router();
  const form = urlencoded({ extended: false, limit: '16kb' });
  router.use('/practice/:pid', (req, res, next) => {
    const practice = getPractice(String(req.params.pid));
    if (!practice) { res.status(404).send('练习不存在'); return; }
    res.locals.practice = practice;
    next();
  });
  const show = (req: Request, res: Response, error?: string, selectedItem?: string, selectedView?: string) => {
    if (req.query.uploadError) error = '照片未保存，请重拍或直接核对。';
    const p = res.locals.practice as NonNullable<ReturnType<typeof getPractice>>;
    const state = getPrintStatus(p.id);
    const body = state.httpStatus === 200 ? state.body : {};
    const itemId = selectedItem ?? (typeof req.query.item === 'string' ? req.query.item : undefined);
    const view = selectedView ?? String(req.query.view ?? '');
    if (itemId && !p.items.some(item => item.id === itemId)) { res.status(404).send('题目不在此练习中'); return; }
    if (itemId) savePracticeCursor(p.id,itemId);
    sendHtml(res, OnlinePracticePage({ practice: p, progress: practiceProgress(p.id), state: String(body.status), snapshot: body.status === 'ready' ? body.snapshot as PrintSnapshot : undefined, itemId, view, paper: req.query.mode === 'paper', today: localDayText(options.now(), options.timeZone), error }));
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
