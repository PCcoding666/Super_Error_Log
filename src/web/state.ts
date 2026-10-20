import type { MaterialStore } from '../materials/store.js';
/**
 * 把服务器上已有的状态交给 WeekPlan（只读，不新增任何持久化字段）：
 * 周视图、本周照片的识别任务、练习列表 / 当前详情 / 回报、打印快照状态、cookie 里的两种本机标记与本次打开的「跳过」。
 * 与 iOS `TodayPlan.input` 同一套取数口径；网页版的照片拍完立刻上传登记，所以没有「还在手机上」的照片。
 */
import type { Request } from 'express';
import type { RecognitionJob } from '../mobile/contracts.js';
import type { MobileRecognitionService } from '../mobile/service.js';
import { getLearningWeek as getWeek } from '../learning/queries.js';
import type { LearningWeek as V2WeekResponse } from '../learning/contracts.js';
import { getLearningPractice as getPractice, listLearningPractices as listPractices } from '../learning/queries.js';
import type { LearningPracticeDetail as PracticeDetail } from '../learning/contracts.js';
import { getLearningReturnSummary as getReturnSummary } from '../v2/returnService.js';
import { getPrintStatus } from '../v2/printService.js';
import { photoFailurePlan, photoState, type PhotoFailurePlan } from './photoPlan.js';
import { readPhotoMarks, readSkips, type PhotoMarks, type SkipState } from './session.js';
import { make, makeInput, practicesFrom, type LocalPhoto, type LocalPhotoState, type NextStepAction, type Practice, type Result, type ReturnSummaryEntry } from './weekPlan.js';

export interface WebContext {
  mobileDataDir: string;
  materials?: MaterialStore;
  service: MobileRecognitionService;
  timeZone: string;
  now: () => Date;
}

export interface PhotoView {
  number: number;
  jobId: string;
  /** 服务器登记这张照片的时间（v2_photo.registered_at）。 */
  registeredAt: string;
  job: RecognitionJob | null;
  state: LocalPhotoState | null;
  failure: PhotoFailurePlan | null;
  pickDone: boolean;
  dismissed: boolean;
  itemCount: number;
  unselectedCount: number;
}

export interface TodayState {
  plan: Result;
  week: V2WeekResponse;
  photos: PhotoView[];
  practices: Practice[];
  latestDetail: PracticeDetail | null;
  marks: PhotoMarks;
  skips: SkipState;
}

export async function loadPhotos(ctx: WebContext, week: V2WeekResponse, marks: PhotoMarks): Promise<PhotoView[]> {
  return Promise.all(week.photos.map(async (photo, index) => {
    let job: RecognitionJob | null = null;
    try { job = await ctx.service.getJob(photo.jobId); } catch { job = null; }
    const flags = { pickDone: marks.pickDone.has(photo.jobId), dismissed: marks.dismissed.has(photo.jobId) };
    return {
      number: index + 1, jobId: photo.jobId, registeredAt: photo.registeredAt, job, state: photoState(job, flags), failure: photoFailurePlan(job),
      pickDone: flags.pickDone, dismissed: flags.dismissed, itemCount: photo.itemCount, unselectedCount: photo.unselectedCount,
    };
  }));
}

export async function loadToday(ctx: WebContext, request: Request): Promise<TodayState> {
  const marks = readPhotoMarks(request);
  const skips = readSkips(request);
  const week = getWeek(ctx.mobileDataDir);
  const photos = await loadPhotos(ctx, week, marks);
  const list = listPractices();
  const latest = list[0] ?? null;
  const latestDetail = latest ? getPractice(latest.id) : null;
  // 回报只取最近几份已生成练习纸的（WeekPlan 只看最新一份与「上一份」）。
  const summaries: Record<string, ReturnSummaryEntry> = {};
  for (const entry of list.filter(p => p.generatedAt !== null).slice(0, 3)) {
    const summary = getReturnSummary(entry.id);
    if (summary) summaries[entry.id] = { answered: summary.answered, total: summary.total, independentCorrect: summary.independentCorrect };
  }
  const practices = practicesFrom(list, latestDetail, summaries);
  let preparingPrintID: string | null = null;
  if (latest) {
    const status = getPrintStatus(latest.id, 'all');
    if (status.httpStatus === 200 && status.body.status === 'preparing') preparingPrintID = latest.id;
  }
  const localPhotos: LocalPhoto[] = photos
    .filter(photo => photo.state !== null)
    .map(photo => ({ number: photo.number, taskID: photo.jobId, jobID: photo.jobId, state: photo.state! }));
  const plan = make(makeInput({
    connection: 'ok', weekKey: week.week, weekPhotoJobIDs: week.photos.map(photo => photo.jobId),
    weekItemCount: week.items.length, materialSaved: ctx.materials?(ctx.materials.db.prepare('SELECT count(*) n FROM material_asset WHERE owner_id=? AND status!=?').get(ctx.materials.studentId,'legacy') as {n:number}).n:null, localPhotos, practices, preparingPrintID,
    skipped: skips.steps, today: ctx.now(), timeZone: ctx.timeZone,
  }));
  return { plan, week, photos, practices, latestDetail, marks, skips };
}

/** 动作在网页上去哪：GET 能到的页面（清单行、链接用）。 */
export function actionHref(action: NextStepAction): string {
  switch (action.kind) {
    case 'scan': case 'rescan': return '/s/#connect';
    case 'capture': case 'uploadPending': return '/s/capture';
    case 'openPick': return `/s/photos/${action.taskID}`;
    case 'materials': return '/s/materials';
    case 'choose': return '/s/choose';
    case 'why': case 'skipWhy': return `/s/why/${action.practiceID}`;
    case 'print': return `/s/print/${action.practiceID}`;
    case 'record': return `/s/record/${action.practiceID}`;
    case 'summary': return `/s/results/${action.practiceID}`;
    case 'skipShoot': case 'skipRecord': case 'goHome': return '/s/';
  }
}
