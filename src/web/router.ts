import { NOTEBOOK_STATUSES, matchesNotebook, notebookUrl, safeNotebookReturn, validNotebookSelection, type NotebookFilters } from './notebook.js';
import type { NotebookPageProps } from './views/items.js';
import type { HandwritingRecognizer } from '../ai/handwriting.js';
import { practiceRouter } from './practiceRouter.js';
import { activePractice, setTaskLifecycle, startSuggestedPractice, suggestedPractice, taskLifecycle } from '../v2/practiceTasks.js';
import { practiceProgress } from '../v2/practiceProgress.js';
import { PracticeDashboardPage } from './views/practiceDashboard.js';
/**
 * 学生网页版（/s/）：云端移动服务同源挂载，SSR、表单驱动、不做 hydration。
 * - 鉴权：配对兑换得到的设备令牌放在 httpOnly cookie（Path=/s），每个请求按 /v1 /v2 同一规则鉴权与限流。
 * - 业务全部调用现有服务（识别 service、/v2 的 week/practice/print/return/reflection/correction/settings），
 *   不在视图里另写一份规则；页面只做「取数 → WeekPlan → 渲染」与表单提交。
 * - 只有拍照上传与录音用到脚本；关掉脚本时每屏照样能用（语音除外）。
 */
import { categoryForItem, editItemCategory, isGrade, updateStudentGrade } from '../classification/itemCategories.js';
import { readCatalog } from '../classification/catalog.js';
import { requireProfile } from '../services/studentService.js';
import crypto from 'node:crypto';
import express, { Router, type ErrorRequestHandler, type Request, type Response } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { sendHtml } from '../views/render.js';
import { getDb } from '../db/connection.js';
import { audit } from '../services/eventLog.js';
import { isHeif } from '../media/images.js';
import { getQuestionCrop } from '../services/evidenceService.js';
import { ATTEMPT_STATES, CAUSES } from '../domain/types.js';
import { registerV2Photo } from '../bridge/recognitionToItems.js';
import { MobileRequestError, type MobileRecognitionService } from '../mobile/service.js';
import { PairingError, decodeWebPairingCode, type PairingManager } from '../mobile/pairing.js';
import type { RateLimiter } from '../mobile/rateLimit.js';
import type { AdmissionController } from '../mobile/admission.js';
import { acquireUploadAdmission, releaseUploadAdmission, trackUploadAdmission } from '../mobile/router.js';
import { getTranscriber, type SpeechTranscriber } from '../ai/asr.js';
import type { CoachProvider, CorrectionProvider, FollowupProvider } from '../ai/provider.js';
import { isAccountRole, type AccountRole } from '../studentHost/accountRole.js';
import { getWeek, discardV2Item, isV2Item, restoreV2Item, type V2WeekItem } from '../v2/weekService.js';
import { getItemFullCrop } from '../v2/fullCrop.js';
import { getV2Settings, updateV2Settings } from '../v2/settingsService.js';
import { createPractice, getPractice, listPractices, recommendPractice, type PracticeCard, type PracticeDetail } from '../v2/practiceService.js';
import { getPrintStatus, readPrintMedia, requestPrint, type PrintSnapshot } from '../v2/printService.js';
import { getReturnSummary, submitReturns } from '../v2/returnService.js';
import { answerFollowup, askFollowup, getV2Reflection, submitV2Reflection } from '../v2/reflectionService.js';
import { acceptCorrection, directCorrection, getEvidenceView, proposeCorrection } from '../v2/correctionService.js';
import { TRANSCRIBE_MAX_BYTES, transcribeClip } from '../v2/transcribe.js';
import { registerStaticAssets } from './staticAssets.js';
import { displayImage, displaySize } from './images.js';
import { COOKIE, clearCookie, giveConsent, hasConsent, markInstallHint, readCookies, readPhotoMarks, readSkips, sawInstallHint, setCookie, writePhotoMarks, writeSkips } from './session.js';
import { actionHref, loadPhotos, loadToday, printStartedAt, type TodayState, type WebContext } from './state.js';
import { trailRecorder, trailTaps } from './trail.js';
import { DEFAULT_TIME_ZONE, localDayOrdinal, localDayText, stepCaption, type StepKind } from './weekPlan.js';
import { barButton, barFromPlan, BusyPage, ConnectPage, ErrorPage, InstallPage, PairPage, TodayPage, type BusyReason, type TodayWait } from './views/today.js';
import { CapturePage, ConsentPage, PhotosPage, PickPage, findingSince } from './views/photos.js';
import { CategoryEditPage, EditPage, FixPage, ItemDetailPage, ItemsPage } from './views/items.js';
import {
  ChoosePage, PracticesPage, PrintPage, RecordDatePage, RecordItemPage, ResultsPage, SettingsPage, SheetPage, printExpect,
  WhyAskPage, WhyConfirmPage, WhyDonePage, WhyIntroPage, COMPLETIONS, type DayOption, type PrintState, type RecordAnswer,
} from './views/practice.js';
import type { BarButton, BarModel } from './views/layout.js';
import { itemNotebookReturn, itemContextUrl, removedNotebookUrl, type ItemPracticeRecord } from './itemLearning.js';

export interface WebClientOptions {
  mobileDataDir: string;
  service: MobileRecognitionService;
  pairing: PairingManager;
  limiter: RateLimiter;
  admission: AdmissionController | null;
  ipOf: (request: Request) => string;
  transcriber?: SpeechTranscriber;
  followupProvider?: FollowupProvider;
  correctionProvider?: CorrectionProvider;
  coachProvider?: CoachProvider;
  handwriting?: HandwritingRecognizer;
  /** 学生邀请码网关的 worker 模式：设置页显示「退出登录」（POST /s/logout 由网关处理）。 */
  studentHostWorker?: boolean;
  /** 「距生成几天」、录结果的日期按哪个时区的日历算；缺省用进程时区（与回传校验、ISO 周一致）。 */
  timeZone?: string;
  now?: () => Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ITEM_ID = /^itm_[0-9a-f]{16}$/;
const PACKET_ID = /^pkt_[0-9a-f]{16}$/;
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
};

const UPLOAD_ERRORS: Record<string, string> = {
  unreadable: '这张照片读不出来，可能没拍好或者文件坏了。换一张试试。',
  heic: '这张照片是 HEIC 格式，服务器读不了。用 iPhone 自带的 Safari 打开这个网页再选一次（会自动转好），或者先把它存成 JPEG。',
  pixels: '这张照片像素太高，服务器处理不了。用 Safari 打开这个网页重选一次，会自动缩小再传。',
  too_big: '这张照片太大了（超过 15 MB），换一张。',
  submit_failed: '没传上去。过一会儿再试，照片还在这个页面里。',
  busy: '服务器有点忙，过一会儿再试。照片没传上去，再拍一次就好。',
  full: '服务器存不下新照片了，请告诉帮你装错题本的人。',
  paused: '服务器正在恢复，过一会儿再试。',
  empty: '先拍一页或者从相册选一张。',
};

class NotFound extends Error {}

function render(response: Response, node: ReactNode, status = 200): void {
  response.status(status);
  const context = response.locals.voiceContext;
  if (typeof context === 'string' && /^[0-9a-f]{64}$/.test(context)) {
    // The strict hex value comes only from worker middleware below, never from page input.
    const html = renderToStaticMarkup(node).replace('</head>', `<meta name="sel-voice-context" content="${context}"/></head>`);
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.send(`<!doctype html>${html}`);
    return;
  }
  sendHtml(response, node);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : Array.isArray(value) && typeof value[0] === 'string' ? value[0] : '';
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  return typeof value === 'string' && value !== '' ? [value] : [];
}

function wantsJson(request: Request): boolean {
  return (request.headers.accept ?? '').includes('application/json');
}

/** 跨站提交拦截（cookie 已是 SameSite=Lax；这里再看 Origin / Sec-Fetch-Site）。 */
function crossSite(request: Request): boolean {
  if (request.headers['sec-fetch-site'] === 'cross-site') return true;
  const origin = request.headers.origin;
  if (!origin || origin === 'null') return false;
  try { return new URL(origin).host !== request.headers.host; } catch { return true; }
}

/** 网页的设备说明（管理员 `devices` 列表里看到的）：只写浏览器类型，不写版本号以外的任何东西。 */
function deviceInfo(request: Request): string {
  const ua = request.headers['user-agent'] ?? '';
  const device = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : '其他设备';
  const browser = /MicroMessenger/.test(ua) ? '微信内置浏览器' : /CriOS|Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : '浏览器';
  return `网页版 · ${device} ${browser}`.slice(0, 200);
}

function inAppBrowser(request: Request): boolean {
  return /MicroMessenger|QQ\/|Weibo|DingTalk|AlipayClient|Lark|FBAN|FBAV|Instagram/i.test(request.headers['user-agent'] ?? '');
}

function requireMatch(value: string, pattern: RegExp): string {
  if (!pattern.test(value)) throw new NotFound();
  return value;
}

/** 当前步骤之外的流程页底部：「下一步：<今天清单里的当前一步>」。 */
function nextStepBar(state: TodayState, ownKind: StepKind | null): BarModel {
  const { plan } = state;
  const index = plan.currentIndex;
  const step = index === null ? null : plan.steps[index] ?? null;
  if (step && step.kind === ownKind) return barFromPlan(plan.next) ?? homeBar();
  if (!step || !plan.next?.primary) {
    return plan.next ? barFromPlan(plan.next)! : homeBar();
  }
  if (!plan.next.isEnabled || plan.next.isWaiting) return barFromPlan(plan.next) ?? homeBar();
  const button = barButton(plan.next.primary);
  return { caption: plan.next.caption, primary: { ...button, title: `下一步：${step.title}` }, secondary: [] };
}

function homeBar(): BarModel {
  return { caption: '', primary: { title: '返回错题本', key: 'goHome', href: '/s/' }, secondary: [] };
}

function captionFor(state: TodayState, kind: StepKind): string {
  const index = state.plan.steps.findIndex(step => step.kind === kind);
  return index >= 0 ? stepCaption(state.plan.steps, index) : '';
}

/** 录结果可选的日期：练习纸生成那天到今天（最多最近 7 天），旧的在前，今天写「今天」。 */
export function dayOptions(generatedAt: Date, now: Date, timeZone: string): DayOption[] {
  const today = localDayOrdinal(now, timeZone);
  const first = Math.max(localDayOrdinal(generatedAt, timeZone), today - 6);
  const days: DayOption[] = [];
  for (let ordinal = first; ordinal <= today; ordinal += 1) {
    const date = new Date(ordinal * 86_400_000 + 12 * 3_600_000);
    const value = localDayText(date, 'UTC');
    const [, month, day] = value.split('-').map(Number);
    days.push({ value, label: ordinal === today ? '今天' : `${WEEKDAYS[date.getUTCDay()]} ${month}/${day}` });
  }
  return days;
}

/**
 * 连接失败时「具体原因」里给学生看的话（设计稿 §6：不说「配对」「配对码」）。服务器的错误码与日志不变。
 */
const PAIRING_REASONS: Record<string, string> = {
  invalid_pairing_payload: '链接不完整，可能复制漏了一段。',
  pairing_used: '这个二维码已经被另一台手机用过了，每个只能用一次。',
  pairing_expired: '这个二维码过期了。',
  pairing_not_found: '这个二维码已经失效了。',
  pairing_unavailable: '服务器暂时连不上，过一会儿再试。',
};

export function createWebClientRouter(options: WebClientOptions): Router {
  // 日历与服务器的领域规则用同一个时区（进程时区）：回传日期校验、ISO 周都按进程本地时间算，
  // 网页按别的时区算「今天」会让他选到被服务器拒收的日期。生产服务器应为 Asia/Shanghai（见 deploy/README.md）。
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? DEFAULT_TIME_ZONE;
  new Intl.DateTimeFormat('en-US', { timeZone }); // 时区写错启动即失败
  const ctx: WebContext = { mobileDataDir: options.mobileDataDir, service: options.service, timeZone, now: options.now ?? (() => new Date()) };
  const transcriber = (): SpeechTranscriber => options.transcriber ?? getTranscriber();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PHOTO_BYTES, files: 2, fields: 10, parts: 14 } });
  const form = express.urlencoded({ extended: false, limit: '64kb', parameterLimit: 200 });
  const r = Router();

  r.use((_request, response, next) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
    next();
  });
  // 互动记录：每个请求结束时记看页 / 提交 / 跳过 / 出错（只记路由模板、动作标识、设备 ID，见 trail.ts）。
  r.use(trailRecorder());
  /** 给这次请求的互动记录标一个出错原因（固定的短标识，不是给人看的文案）。 */
  const failed = (response: Response, code: string): void => { response.locals.trailError = code; };

  // ---------- 公开资源（无学生数据） ----------
  registerStaticAssets(r);

  r.use((request, response, next) => {
    const internalPage = options.studentHostWorker === true && (request.method === 'GET' || request.method === 'POST')
      && !/^\/voice\/?$/i.test(request.path);
    if (internalPage) {
      const context = request.headers['x-sel-internal-voice-context'];
      // The strict hex value comes only from the parent gateway, never from page input.
      if (typeof context === 'string' && /^[0-9a-f]{64}$/.test(context)) response.locals.voiceContext = context;
      // 账号身份标签：只信父进程网关注入的内部头（网关在白名单重建时已丢弃浏览器同名头），
      // 且必须是四个合法值之一；只是展示用元数据，不参与鉴权。
      const role = request.headers['x-sel-internal-account-role'];
      if (isAccountRole(role)) response.locals.accountRole = role;
    }
    next();
  });

  /** 连接页上「服务器忙」时这台手机的连接情况：没有 cookie = 还没连上；cookie 有效 = 连着；cookie 失效 = 连接过期（只读，不计入失败次数）。 */
  const connectionOf = async (request: Request): Promise<BusyReason> => {
    const token = readCookies(request)[COOKIE.device];
    if (!token) return 'unpaired';
    try { await options.pairing.authenticate(`Bearer ${token}`); return 'connected'; }
    catch (error) { if (error instanceof PairingError) return 'expired'; throw error; }
  };

  // ---------- 配对：打开链接 → 确认页 → 点一下兑换 → httpOnly cookie ----------
  r.get('/pair', (request, response) => {
    const code = str(request.query.code);
    if (decodeWebPairingCode(code) === null) { render(response, ConnectPage({ reason: 'unpaired', error: PAIRING_REASONS.invalid_pairing_payload }), 400); return; }
    render(response, PairPage({ code, clientId: crypto.randomUUID(), inAppBrowser: inAppBrowser(request) }));
  });

  r.post('/pair', form, async (request, response, next) => {
    try {
      if (crossSite(request)) { response.status(403).send('forbidden'); return; }
      const raw = str(request.body?.code) || str(request.body?.link);
      const payload = decodeWebPairingCode(raw);
      const clientId = UUID.test(str(request.body?.clientId)) ? str(request.body?.clientId) : crypto.randomUUID();
      try {
        if (payload === null) throw new PairingError('invalid_pairing_payload', PAIRING_REASONS.invalid_pairing_payload!);
        const result = await options.pairing.redeem(payload, clientId, deviceInfo(request));
        const seconds = (Date.parse(result.expiresAt) - Date.now()) / 1000;
        setCookie(request, response, COOKIE.device, result.token, seconds);
        audit('web_client_paired', 'device', result.deviceId);
        response.locals.deviceId = result.deviceId;
        response.redirect(303, '/s/?paired=1');
      } catch (error) {
        if (!(error instanceof PairingError)) throw error;
        failed(response, error.code);
        const gate = options.limiter.pairingFailure(options.ipOf(request));
        if (!gate.allowed) {
          failed(response, 'busy');
          response.setHeader('retry-after', String(gate.retryAfterSeconds));
          render(response, BusyPage({ retryAfterSeconds: gate.retryAfterSeconds, reason: await connectionOf(request) }), 429);
          return;
        }
        const status = error.code === 'pairing_expired' ? 410 : error.code === 'pairing_used' ? 409 : error.code === 'pairing_not_found' ? 404 : error.code === 'pairing_unavailable' ? 503 : 400;
        render(response, ConnectPage({ reason: 'unpaired', error: PAIRING_REASONS[error.code] ?? '这个二维码用不了。' }), status);
      }
    } catch (error) { next(error); }
  });

  // ---------- 鉴权：设备令牌 cookie，与 /v1 /v2 同一套鉴权与限流 ----------
  r.use(async (request, response, next) => {
    try {
      const token = readCookies(request)[COOKIE.device];
      const isPage = request.method === 'GET' && !request.path.startsWith('/img/');
      const reject = (reason: 'unpaired' | 'unauthorized'): void => {
        if (reason === 'unauthorized') clearCookie(request, response, COOKIE.device);
        if (request.method !== 'GET') { if (wantsJson(request) || request.path === '/voice') { response.status(401).json({ error: { code: 'unauthorized', message: '需要重新连接。' } }); } else { response.redirect(303, '/s/'); } return; }
        if (!isPage) { response.status(401).type('text/plain').send('unauthorized'); return; }
        if (reason === 'unauthorized') failed(response, 'unauthorized'); else response.locals.trailView = 'connect';
        render(response, ConnectPage({ reason }), reason === 'unauthorized' ? 401 : 200);
      };
      if (!token) { reject('unpaired'); return; }
      let deviceId: string;
      try { deviceId = (await options.pairing.authenticate(`Bearer ${token}`)).deviceId; }
      catch (error) {
        if (!(error instanceof PairingError)) throw error;
        const fail = options.limiter.authFailure(options.ipOf(request));
        // 带着 cookie 却鉴权失败：以前连上过、连接失效了（不是「还没连上」）。
        if (!fail.allowed) { failed(response, 'busy'); response.setHeader('retry-after', String(fail.retryAfterSeconds)); render(response, BusyPage({ retryAfterSeconds: fail.retryAfterSeconds, reason: 'expired' }), 429); return; }
        reject('unauthorized');
        return;
      }
      response.locals.deviceId = deviceId;
      const query = options.limiter.authedQuery(deviceId);
      if (!query.allowed) {
        failed(response, 'busy');
        response.setHeader('retry-after', String(query.retryAfterSeconds));
        if (request.path === '/voice' || wantsJson(request)) { response.status(429).json({ error: { code: 'rate_limited', message: '请求过于频繁，请稍后再试。' } }); return; }
        render(response, BusyPage({ retryAfterSeconds: query.retryAfterSeconds, reason: 'connected' }), 429);
        return;
      }
      if (request.method === 'POST' && crossSite(request)) { failed(response, 'cross_site'); response.status(403).send('forbidden'); return; }
      next();
    } catch (error) { next(error); }
  });
  // 页面脚本记下的点按（cookie sel_tap）在这里收下；不跳页的点按发来的 HEAD 到这里就结束。
  r.use(trailTaps());

  const page = (handler: (request: Request, response: Response) => Promise<void> | void) =>
    async (request: Request, response: Response, next: express.NextFunction): Promise<void> => {
      try { await handler(request, response); } catch (error) { next(error); }
    };

  // 默认进入错题本，保留根地址作为主屏幕入口。
  r.get('/', page(async (request, response) => {
    render(response, await itemsPage(request, response));
  }));
  r.post('/install/seen', page((request, response) => { markInstallHint(request, response); response.redirect(303, '/s/'); }));
  r.get('/install', page((_request, response) => render(response, InstallPage())));

  /** 「今天」在等 AI 吗：找题中的照片（从最早那张算）或正在准备的练习纸（从开始准备算）。都不在等时 null。 */
  const todayWait = (state: TodayState): TodayWait | null => {
    if (state.photos.some(photo => photo.state === 'finding')) return { since: findingSince(state.photos), expect: 'AI 找好以后，这一步会自己打勾' };
    if (state.preparingPrintID) {
      const since = printStartedAt(state.preparingPrintID);
      const status = getPrintStatus(state.preparingPrintID);
      const progress = status.httpStatus === 200 ? (status.body as { progress?: { done: number; total: number } }).progress : undefined;
      const elapsed = since ? Math.max(0, Math.floor((ctx.now().getTime() - Date.parse(since)) / 1000)) : null;
      return { since, expect: printExpect(progress?.done ?? 0, progress?.total ?? 0, elapsed) };
    }
    return null;
  };

  // 「跳过」只记在本次打开里（会话 cookie）；「跳过，直接打印」顺手开始准备练习纸。
  r.post('/skip', form, page((request, response) => {
    const step = str(request.body?.step);
    if (step !== 'shoot' && step !== 'why' && step !== 'record') { response.redirect(303, '/s/'); return; }
    const skips = readSkips(request);
    skips.steps.add(step);
    writeSkips(request, response, skips);
    response.locals.trailSkip = step;
    const practiceId = str(request.body?.practice);
    if (step === 'why' && PACKET_ID.test(practiceId) && getPractice(practiceId)) {
      requestPrint(practiceId, options.coachProvider);
      response.redirect(303, `/s/print/${practiceId}`);
      return;
    }
    response.redirect(303, '/s/');
  }));

  // ---------- 拍这周的卷子 ----------
  r.get('/capture', page(async (request, response) => {
    if (!hasConsent(request)) { render(response, ConsentPage()); return; }
    const state = await loadToday(ctx, request);
    const next = { title: '查看错题', href: '/s/items' };
    const err = UPLOAD_ERRORS[str(request.query.err)] ?? null;
    render(response, CapturePage({ photos: state.photos, next, caption: '', flash: { err } }));
  }));

  r.post('/consent', form, page((request, response) => { giveConsent(request, response); const returnTo = str(request.body?.returnTo); response.redirect(303, /^\/s\/practice\/pkt_[0-9a-f]{16}\?item=itm_[0-9a-f]{16}&view=upload$/.test(returnTo) ? returnTo : '/s/capture'); }));

  r.post('/capture', async (request, response, next) => {
    const fail = (code: string, status: number): void => {
      failed(response, code);
      if (wantsJson(request)) { response.status(status).json({ error: { code, message: UPLOAD_ERRORS[code] ?? '没传上去。' } }); return; }
      response.redirect(303, `/s/capture?err=${code}`);
    };
    if (!hasConsent(request)) {
      // 第一次上传前必须先看「上传前看一下」并同意；没同意的照片不收（也不读进内存以外的任何地方）。
      failed(response, 'consent_required');
      if (wantsJson(request)) { response.status(403).json({ error: { code: 'consent_required', message: '第一次上传前，先看一下上传说明。' } }); return; }
      response.redirect(303, '/s/capture');
      return;
    }
    const admission = options.admission;
    const reserve = admission ? trackUploadAdmission(admission, response) : null;
    try {
      if (admission && reserve) {
        const rejection = await acquireUploadAdmission(admission, reserve);
        if (rejection) { if (rejection.retryAfterSeconds !== undefined) response.setHeader('retry-after', String(rejection.retryAfterSeconds)); fail(rejection.status === 503 ? 'full' : 'busy', rejection.status); return; }
      }
      try {
        await new Promise<void>((resolve, reject) => upload.any()(request, response, error => (error ? reject(error) : resolve())));
      } catch (error) {
        fail(error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE' ? 'too_big' : 'empty', 400);
        return;
      }
      const file = (request.files as Express.Multer.File[] | undefined ?? []).find(entry => entry.size > 0);
      if (!file) { fail('empty', 400); return; }
      // 统一转成 JPEG：按 EXIF 摆正，去掉位置等拍摄信息（sharp 默认不保留元数据）。
      // 失败要分清原因（2026-10-15 线上修复）：HEIC 服务器读不了、像素超限、文件损坏，不能一律说「读不出来」。
      // 脚本端已在浏览器里转过格式与尺寸，走到这里的多是没脚本/旧缓存的原图直传，告诉他换 Safari 或 JPEG。
      let jpeg: Buffer;
      try {
        const normalize = async (): Promise<Buffer> => {
          const high = await sharp(file.buffer, { failOn: 'error', limitInputPixels: 40_000_000 }).rotate().jpeg({ quality: 90 }).toBuffer();
          return high.length <= MAX_PHOTO_BYTES ? high : sharp(file.buffer, { failOn: 'error', limitInputPixels: 40_000_000 }).rotate().jpeg({ quality: 75 }).toBuffer();
        };
        // Release the image slot before submit(), which acquires the same slot itself.
        jpeg = admission ? await admission.withImage(normalize) : await normalize();
      } catch (error) {
        const code = isHeif(file.buffer) ? 'heic'
          : error instanceof Error && /pixel limit/i.test(error.message) ? 'pixels'
          : 'unreadable';
        fail(code, 400);
        return;
      }
      if (jpeg.length > MAX_PHOTO_BYTES) { fail('too_big', 400); return; }
      const key = UUID.test(str(request.body?.key)) ? str(request.body?.key) : crypto.randomUUID();
      let jobId: string;
      try {
        const submitted = await options.service.submit({ idempotencyKey: key, photoName: `${key}.jpg`, sourceBytes: jpeg });
        if (submitted.created && reserve?.capacity) reserve.handoff = true;
        jobId = submitted.job.id;
      } catch (error) {
        if (error instanceof MobileRequestError) { fail(error.status === 503 ? 'paused' : error.status === 429 ? 'busy' : 'submit_failed', error.status); return; }
        throw error;
      }
      registerV2Photo(jobId);
      audit('v2_photo_registered', 'v2_photo', jobId);
      if (wantsJson(request)) { response.json({ ok: true, jobId, next: '/s/capture' }); return; }
      response.redirect(303, '/s/capture');
    } catch (error) { next(error); }
    finally { if (admission && reserve) releaseUploadAdmission(admission, reserve); }
  });

  // ---------- 勾出做错的题 ----------
  r.get('/photos', page(async (request, response) => {
    const state = await loadToday(ctx, request);
    const refresh = state.photos.some(photo => photo.state === 'finding');
    const err = request.query.err === 'retry' ? '这次没重试成功，过一会儿再试。' : null;
    // 刚从勾选面板加了题回来：说一声加了几道，那一张的那一行浮上来（只是两个小数字，不带任何 ID）。
    const addedPhoto = state.photos.find(photo => photo.number === Number(str(request.query.n)));
    const added = /^[1-9]\d?$/.test(str(request.query.added)) && addedPhoto && addedPhoto.itemCount > 0 ? { count: addedPhoto.itemCount, number: addedPhoto.number } : null;
    const photos = state.photos.filter(photo => !(photo.dismissed && photo.failure));
    const needsPick = photos.find(photo => photo.state === 'needsPick');
    const bar: BarModel = {
      caption: '', primary: needsPick
        ? {title: `勾第 ${needsPick.number} 张`, key:'openPick', href:`/s/photos/${needsPick.jobId}`}
        : {title:'查看错题', key:'items', href:'/s/items'},
      secondary: [{title:'继续录入',key:'capture',href:'/s/capture'}],
    };
    render(response, PhotosPage({ photos, bar, refresh, itemCount: state.week.items.length, newSince: state.latestDetail?.generatedAt ?? null, added, now: ctx.now(), flash: { err } }));
  }));

  const weekPhoto = async (request: Request, jobId: string) => {
    const week = getWeek(ctx.mobileDataDir);
    if (!week.photos.some(photo => photo.jobId === jobId)) throw new NotFound();
    const photos = await loadPhotos(ctx, week, readPhotoMarks(request));
    return { week, photo: photos.find(photo => photo.jobId === jobId)! };
  };

  r.get('/photos/:jobId', page(async (request, response) => {
    const { photo } = await weekPhoto(request, requireMatch(String(request.params.jobId), UUID));
    render(response, PickPage({ photo }));
  }));

  r.post('/photos/:jobId/select', form, page(async (request, response) => {
    const jobId = requireMatch(String(request.params.jobId), UUID);
    const { photo } = await weekPhoto(request, jobId);
    const ids = list(request.body?.questionIds).filter(id => UUID.test(id));
    if (ids.length === 0) { failed(response, 'none_picked'); render(response, PickPage({ photo, error: '先勾出做错的题。' }), 400); return; }
    const chosen = [...new Set(ids)].slice(0, 30);
    try { await options.service.select(jobId, chosen); }
    catch (error) {
      if (error instanceof MobileRequestError) { failed(response, 'select_failed'); render(response, PickPage({ photo, error: error.message }), error.status); return; }
      throw error;
    }
    response.redirect(303, `/s/photos?added=${chosen.length}&n=${photo.number}`);
  }));

  const markPhoto = (kind: 'pickDone' | 'dismissed') => page(async (request, response) => {
    const jobId = requireMatch(String(request.params.jobId), UUID);
    const { week } = await weekPhoto(request, jobId);
    const marks = readPhotoMarks(request);
    marks[kind].add(jobId);
    writePhotoMarks(request, response, marks, week.photos.map(photo => photo.jobId));
    response.redirect(303, '/s/photos');
  });
  r.post('/photos/:jobId/none', markPhoto('pickDone'));
  r.post('/photos/:jobId/dismiss', markPhoto('dismissed'));

  r.post('/photos/:jobId/retry', form, page(async (request, response) => {
    const jobId = requireMatch(String(request.params.jobId), UUID);
    await weekPhoto(request, jobId);
    const ids = list(request.body?.questionIds).filter(id => UUID.test(id));
    try {
      if (ids.length === 0) await options.service.retry(jobId, null);
      else for (const id of ids) await options.service.retry(jobId, id);
    } catch (error) {
      if (error instanceof MobileRequestError) { failed(response, 'retry_failed'); response.redirect(303, '/s/photos?err=retry'); return; }
      throw error;
    }
    response.redirect(303, '/s/photos');
  }));

  // ---------- 这周的错题 / 题目详情 / 改一下 ----------
  const findItem = (itemId: string): V2WeekItem => {
    requireMatch(itemId, ITEM_ID);
    if (!isV2Item(itemId)) throw new NotFound();
    const week = getWeek(ctx.mobileDataDir, true);
    const item = [...week.items, ...week.backlog].find(entry => entry.id === itemId);
    if (item) return item;
    for (const summary of listPractices()) {
      const card = getPractice(summary.id)?.items.find(entry => entry.id === itemId);
      if (card) return card;
    }
    throw new NotFound();
  };

  const notebookData = async (request: Request, response: Response): Promise<NotebookPageProps> => {
    const state = await loadToday(ctx, request);
    const library = getWeek(ctx.mobileDataDir, true);
    const all = [...library.items, ...library.backlog];
    const input = request.method === 'POST' ? request.body : request.query;
    const cookies = readCookies(request);
    const gradeValue = str(input?.grade);
    const grade = isGrade(gradeValue) ? gradeValue : isGrade(cookies[COOKIE.itemsGrade]) ? cookies[COOKIE.itemsGrade]! : requireProfile().grade;
    const subjects = [...new Set([...readCatalog(getDb(), requireProfile().id).subjects.map(subject => subject.name), ...all.map(item => item.subject || '未分类')])];
    const requested = str(input?.subject).trim().slice(0,100);
    // An edit/removal can empty a former subject; keep the explicit scope rather than broadening it.
    if (requested && !subjects.includes(requested)) subjects.push(requested);
    const subject = [requested, cookies[COOKIE.itemsSubject], ...all.filter(item => item.grade === grade).map(item => item.subject), ...subjects].find(value => value && subjects.includes(value)) ?? '数学';
    setCookie(request, response, COOKIE.itemsSubject, subject, null);
    setCookie(request, response, COOKIE.itemsGrade, grade, null);
    const scope = all.filter(item=>item.grade === grade && (item.subject || '未分类') === subject);
    const chapters = [...new Set(scope.map(item=>item.chapter || '未分类'))];
    const chapter = str(input?.chapter).trim().slice(0,100);
    // Keep unavailable chapter filters visible so a changed category never silently broadens search.
    if (chapter && !chapters.includes(chapter)) chapters.push(chapter);
    const status = str(input?.status);
    const filters: NotebookFilters = {grade,subject,chapter,status:Object.hasOwn(NOTEBOOK_STATUSES,status) ? status : '',q:str(input?.q).trim().slice(0,200)};
    const matches = (item: V2WeekItem): boolean => matchesNotebook(item,filters,filters.q ? getEvidenceView(item.id)?.questionText : '');
    const items = library.items.filter(matches), backlog = library.backlog.filter(matches);
    const requestedSelection = request.method === 'POST' || request.query.mode === 'select' ? list(input?.itemIds) : [];
    const validReturnSelection = validNotebookSelection(requestedSelection) && !!safeNotebookReturn(notebookUrl(filters,undefined,requestedSelection),'');
    const selectedIds = request.method === 'POST' || validReturnSelection ? requestedSelection : [];
    const visibleIds = new Set([...items,...backlog].map(item=>item.id));
    const recommend = recommendPractice(ctx.mobileDataDir);
    const removed = ITEM_ID.test(str(request.query.removed)) ? str(request.query.removed) : null;
    const returnItem = ITEM_ID.test(str(request.query.returnItem)) ? str(request.query.returnItem) : removed;
    const selecting = request.method === 'POST' || request.query.mode === 'select';
    return {items,backlog,filters,chapters,total:scope.length,selectedIds,
      undoReturnTo: removed ? notebookUrl(filters,returnItem ?? undefined,selecting ? selectedIds : undefined) : undefined,
      eligibleIds:[...recommend.recommended,...recommend.others].map(item=>item.id),
      recoveryItems:all.filter(item=>selectedIds.includes(item.id) && !visibleIds.has(item.id)),
      selection:selecting,
      category:{grade,subject,subjects},anyPhoto:state.week.photos.length > 0,
      finding:state.photos.some(photo=>photo.state === 'finding'),
      bar:{caption:'',primary:null,secondary:[]},removed,
      flash:{ok:request.query.paired === '1' ? '连上了 ✓' : null,err:!validReturnSelection && request.method !== 'POST' ? '返回的选题信息不可用，请重新选择。' : null}};
  };
  const itemsPage = async (request: Request, response: Response): Promise<ReactNode> => ItemsPage(await notebookData(request,response));
  r.get('/items', page(async (request, response) => render(response, await itemsPage(request,response))));

  r.post('/items/select', form, page(async (request,response) => {
    const data = await notebookData(request,response);
    const ids = data.selectedIds ?? [];
    const openItem = str(request.body?.openItem);
    if (openItem) {
      const item = findItem(openItem);
      const returnTo = notebookUrl(data.filters ?? data.category,item.id,ids);
      if (!validNotebookSelection(ids) || !safeNotebookReturn(returnTo,'')) {
        render(response,ItemsPage({...data,flash:{err:'选题信息过多或含不可用编号。已保留选择，请减少待选题或取消不可用编号后再查看。'}}),400); return;
      }
      response.redirect(303,`/s/items/${item.id}?${new URLSearchParams({returnTo})}`); return;
    }
    const chapter = str(request.body?.addChapter);
    if (chapter) {
      const eligible = new Set(data.eligibleIds);
      data.selectedIds = [...new Set([...ids,...[...data.items,...data.backlog]
        .filter(item=>(item.chapter || '未分类') === chapter && eligible.has(item.id)).map(item=>item.id)])];
      render(response,ItemsPage(data)); return;
    }
    const reject = (message:string,status:number): void => {
      failed(response,'notebook_selection');
      render(response,ItemsPage({...data,flash:{err:message}}),status);
    };
    if (!ids.length) { reject('至少选 1 道题，再加入练习。',400); return; }
    if (ids.length > 8) { reject('最多 8 道。已保留全部选择，请取消几道后继续。',400); return; }
    if (ids.some(id=>!ITEM_ID.test(id)) || new Set(ids).size !== ids.length) {
      reject('选择中有不可用或重复的题目。已保留选择，请取消不可用的题目后重试。',400); return;
    }
    const result = createPractice({itemIds:ids});
    if (!result.ok) {
      reject(result.httpStatus === 409 ? '有题目已在练习中或尚未到复习时间。已保留全部选择，请取消当前不可加入的题目后重试。' : result.message,result.httpStatus); return;
    }
    requestPrint(result.detail.id,options.coachProvider);
    response.redirect(303,`/s/practice/${result.detail.id}`);
  }));

  const unfinishedPractice = (itemId: string): string | null => {
    const row = getDb().prepare(`SELECT rpi.packet_id AS id FROM review_packet_item rpi
      JOIN review_packet rp ON rp.id = rpi.packet_id
      WHERE rpi.item_id = ?
      AND NOT EXISTS (SELECT 1 FROM practice_task pt WHERE pt.packet_id = rpi.packet_id AND pt.lifecycle = 'cancelled')
      AND NOT EXISTS (
        SELECT 1 FROM review_attempt ra WHERE ra.packet_id = rpi.packet_id AND ra.item_id = rpi.item_id
      ) ORDER BY rp.created_at DESC, rp.rowid DESC LIMIT 1`).get(itemId) as {id:string} | undefined;
    return row?.id ?? null;
  };
  const detail = (itemId: string, error?: string | null, returnTo?: string): ReactNode => {
    const item = findItem(itemId);
    const recommend = recommendPractice(ctx.mobileDataDir);
    const history = getDb().prepare(`SELECT rp.id, rp.created_at, rp.generated_at, ra.correct, ra.completion, ra.hint_level, ra.performed_at
      FROM review_packet_item rpi JOIN review_packet rp ON rp.id = rpi.packet_id
      LEFT JOIN review_attempt ra ON ra.packet_id = rpi.packet_id AND ra.item_id = rpi.item_id
      WHERE rpi.item_id = ? ORDER BY COALESCE(ra.performed_at, rp.created_at) DESC, rp.created_at DESC, rp.rowid DESC`).all(itemId) as unknown as Array<ItemPracticeRecord & {generated_at:string|null}>;
    const reflection = getV2Reflection(itemId)?.reflection ?? null;
    return ItemDetailPage({
      item, evidence: getEvidenceView(itemId), canDiscard: item.status === 'ready_for_reflection' || item.status === 'eligible_for_review',
      reflected: reflection != null, reflection, error, returnTo, timeZone:ctx.timeZone,
      eligible: [...recommend.recommended,...recommend.others].some(candidate => candidate.id === itemId),
      resumePracticeId: unfinishedPractice(itemId), reflectionPracticeId: history[0]?.id,
      // recordAttempt uses the process calendar; UI time-zone overrides must not relabel its delay evidence.
      practiceHistory: history.map(record => ({...record,generated_day:record.generated_at ? localDayText(new Date(record.generated_at),Intl.DateTimeFormat().resolvedOptions().timeZone) : null})),
    });
  };

  r.get('/items/:id', page((request, response) => render(response, detail(String(request.params.id),null,str(request.query.returnTo)))));
  r.post('/items/:id/practice', form, page((request,response) => {
    const item = findItem(String(request.params.id)); // Same ownership / v2 checks as the reading route.
    const returnTo = itemNotebookReturn(request.body?.returnTo,item);
    const existing = unfinishedPractice(item.id);
    if (existing) {
      // A retried POST resumes the existing packet; GET detail never creates or prepares one.
      requestPrint(existing,options.coachProvider);
      response.redirect(303,`/s/practice/${existing}?item=${item.id}`);
      return;
    }
    const result = createPractice({itemIds:[item.id]});
    if (!result.ok) {
      failed(response,'item_practice_ineligible');
      const reason = item.status === 'temporarily_mastered'
        ? '尚未到复习时间，先看看这题的订正和练习记录，或返回错题本选择其他题。'
        : '这道题的练习资格已变化。请查看练习记录，或返回错题本选择其他题。';
      render(response,detail(item.id,reason,returnTo),result.httpStatus);
      return;
    }
    requestPrint(result.detail.id,options.coachProvider);
    response.redirect(303,`/s/practice/${result.detail.id}?item=${item.id}`);
  }));

  r.get('/items/:id/category', page((request, response) => {
    const item = findItem(String(request.params.id));
    render(response, CategoryEditPage({item,returnTo:itemNotebookReturn(request.query.returnTo,item)}));
  }));
  r.post('/items/:id/category', form, page((request, response) => {
    const item = findItem(String(request.params.id));
    const returnTo = itemNotebookReturn(request.body?.returnTo,item);
    const values = {grade:str(request.body?.grade),subject:str(request.body?.subject),chapter:str(request.body?.chapter)};
    const error = editItemCategory(getDb(), requireProfile().id, item.id, values);
    if (error) { render(response, CategoryEditPage({item,values,error,returnTo}), 400); return; }
    audit('item_category_updated', 'item', item.id);
    response.redirect(303, itemContextUrl(item,returnTo));
  }));

  r.post('/items/:id/discard', form, page((request, response) => {
    const itemId = String(request.params.id);
    const item = findItem(itemId);
    const returnTo = itemNotebookReturn(request.body?.returnTo,item);
    const result = discardV2Item(itemId);
    if (!result.ok) { failed(response, 'discard_refused'); render(response, detail(itemId, result.message,returnTo), result.httpStatus); return; }
    response.redirect(303, removedNotebookUrl(returnTo,itemId));
  }));

  r.post('/items/:id/restore', form, page((request, response) => {
    const itemId = requireMatch(String(request.params.id), ITEM_ID);
    if (!isV2Item(itemId)) throw new NotFound();
    const returnTo = itemNotebookReturn(request.body?.returnTo,{id:itemId,...categoryForItem(itemId)});
    restoreV2Item(itemId);
    response.redirect(303, returnTo);
  }));

  const fixPage = (itemId: string, extra: { error?: string | null; instruction?: string; proposal?: Parameters<typeof FixPage>[0]['proposal']; returnTo?: string } = {}): ReactNode => {
    const item = findItem(itemId);
    const evidence = getEvidenceView(itemId);
    if (!evidence) throw new NotFound();
    return FixPage({ item, revision: evidence.revision, clientRequestId: crypto.randomUUID(), ...extra });
  };

  r.get('/items/:id/fix', page((request, response) => render(response, fixPage(String(request.params.id),{returnTo:str(request.query.returnTo)}))));

  r.post('/items/:id/fix', form, page(async (request, response) => {
    const itemId = String(request.params.id);
    const item = findItem(itemId);
    const returnTo = itemNotebookReturn(request.body?.returnTo,item);
    const instruction = str(request.body?.instruction);
    const method = str(request.body?.method) === 'voice' ? 'voice' : 'keyboard';
    const result = await proposeCorrection(itemId, {
      instruction, method, revision: Number(str(request.body?.revision)), clientRequestId: str(request.body?.clientRequestId),
    }, options.correctionProvider);
    if (!result.ok) { failed(response, 'fix_failed'); render(response, fixPage(itemId, { error: result.message, instruction, returnTo }), result.httpStatus); return; }
    render(response, fixPage(itemId, { instruction, returnTo, proposal: { proposalId: result.proposalId, revision: result.revision, changes: result.changes, clarify: result.clarify } }));
  }));

  r.post('/items/:id/fix/accept', form, page((request, response) => {
    const itemId = String(request.params.id);
    const item = findItem(itemId);
    const returnTo = itemNotebookReturn(request.body?.returnTo,item);
    const result = acceptCorrection(itemId, { proposalId: str(request.body?.proposalId), revision: Number(str(request.body?.revision)) });
    if (!result.ok) { failed(response, 'fix_accept_failed'); render(response, fixPage(itemId, { error: result.message, returnTo }), result.httpStatus); return; }
    response.redirect(303, itemContextUrl(item,returnTo));
  }));

  r.get('/items/:id/edit', page((request, response) => {
    const itemId = String(request.params.id);
    const item = findItem(itemId);
    const evidence = getEvidenceView(itemId);
    if (!evidence) throw new NotFound();
    render(response, EditPage({ item, evidence, returnTo:itemNotebookReturn(request.query.returnTo,item) }));
  }));

  r.post('/items/:id/edit', form, page((request, response) => {
    const itemId = String(request.params.id);
    const item = findItem(itemId);
    const evidence = getEvidenceView(itemId);
    if (!evidence) throw new NotFound();
    const returnTo = itemNotebookReturn(request.body?.returnTo,item);
    const after = str(request.body?.questionText).replace(/\r\n/g, '\n');
    if (after.trim() === '' || after === evidence.questionText) { response.redirect(303, itemContextUrl(item,returnTo)); return; }
    const result = directCorrection(itemId, { revision: Number(str(request.body?.revision)), changes: [{ field: 'questionText', before: evidence.questionText, after }] });
    if (!result.ok) { failed(response, 'edit_failed'); render(response, EditPage({ item, evidence: getEvidenceView(itemId) ?? evidence, error: result.message, returnTo }), result.httpStatus); return; }
    response.redirect(303, itemContextUrl(item,returnTo));
  }));

  r.use(practiceRouter({ coachProvider: options.coachProvider, limiter: options.limiter, admission: options.admission, handwriting: options.handwriting, timeZone: ctx.timeZone, now: ctx.now }));

  // ---------- 选这周要练的题 ----------
  const choosePage = async (request: Request, error?: string | null, reason?: string | null): Promise<ReactNode> => {
    const state = await loadToday(ctx, request);
    return ChoosePage({ recommend: recommendPractice(ctx.mobileDataDir), practiceSlot: getV2Settings().practiceSlot, caption: '', error, reason, ...(request.method === 'POST' ? { selectedIds: list(request.body?.itemIds) } : {}) });
  };
  r.get('/choose', page(async (request, response) => render(response, await choosePage(request))));

  r.post('/choose', form, page(async (request, response) => {
    const itemIds = [...new Set(list(request.body?.itemIds).filter(id => ITEM_ID.test(id)))];
    if (itemIds.length === 0) { failed(response, 'none_chosen'); render(response, await choosePage(request, '至少选 1 道'), 400); return; }
    if (itemIds.length > 8) { failed(response, 'too_many'); render(response, await choosePage(request, '最多 8 道。想加这道，先去掉一道。'), 400); return; }
    const slotChoice = str(request.body?.practiceSlot);
    const practiceSlot = (slotChoice === '__other' ? str(request.body?.practiceSlotOther) : slotChoice).trim();
    const result = createPractice({ itemIds, ...(practiceSlot ? { practiceSlot } : {}) });
    if (!result.ok) {
      failed(response, result.httpStatus === 409 ? 'conflict' : 'create_failed');
      const message = result.httpStatus === 409 ? '有几道题刚刚变了，已经重新推荐。再看一眼。' : result.message;
      render(response, await choosePage(request, message, result.httpStatus === 409 ? result.message : null), result.httpStatus);
      return;
    }
    requestPrint(result.detail.id, options.coachProvider);
    response.redirect(303, `/s/practice/${result.detail.id}`);
  }));

  // ---------- 说说为什么错 ----------
  const practiceOf = (practiceId: string): PracticeDetail => {
    requireMatch(practiceId, PACKET_ID);
    const found = getPractice(practiceId);
    if (!found) throw new NotFound();
    return found;
  };
  const remaining = (request: Request, practice: PracticeDetail, except?: string): PracticeDetail['items'] => {
    const passed = readSkips(request).passedItems;
    return practice.items.filter(item => !item.reflected && !passed.has(item.id) && item.id !== except);
  };
  const cardOf = (practice: PracticeDetail, itemId: string): { card: PracticeCard; index: number } => {
    const index = practice.items.findIndex(item => item.id === itemId);
    if (index < 0) throw new NotFound();
    return { card: practice.items[index]!, index };
  };
  /** 去下一道：先让 AI 问一句（幂等），再跳到问答屏；没有了就去「说完了」。 */
  const goNextWhy = async (response: Response, practiceId: string, queue: PracticeCard[]): Promise<void> => {
    const next = queue[0];
    if (!next) { response.redirect(303, `/s/why/${practiceId}`); return; }
    await askFollowup(next.id, options.followupProvider);
    response.redirect(303, `/s/why/${practiceId}/${next.id}`);
  };

  r.get('/why/:pid', page((request, response) => {
    const practice = practiceOf(String(request.params.pid));
    const queue = remaining(request, practice);
    if (queue.length === 0) { render(response, WhyDonePage({ practice })); return; }
    render(response, WhyIntroPage({ practice, index: practice.items.indexOf(queue[0]!), total: practice.items.length, pending: queue.map(item => item.id) }));
  }));

  r.post('/why/:pid/start', page(async (request, response) => {
    const practice = practiceOf(String(request.params.pid));
    await goNextWhy(response, practice.id, remaining(request, practice));
  }));

  r.get('/why/:pid/:itemId', page((request, response) => {
    const practice = practiceOf(String(request.params.pid));
    const { card, index } = cardOf(practice, String(request.params.itemId));
    const turns = getV2Reflection(card.id)?.turns ?? [];
    if (turns.length > 0 && turns.every(turn => turn.answer !== null)) { response.redirect(303, `/s/why/${practice.id}/${card.id}/confirm`); return; }
    render(response, WhyAskPage({ practiceId: practice.id, card, index, total: practice.items.length, turns }));
  }));

  r.post('/why/:pid/:itemId/ask', page(async (request, response) => {
    const practice = practiceOf(String(request.params.pid));
    const { card } = cardOf(practice, String(request.params.itemId));
    const result = await askFollowup(card.id, options.followupProvider);
    response.redirect(303, result.ok ? `/s/why/${practice.id}/${card.id}` : `/s/why/${practice.id}/${card.id}/confirm`);
  }));

  r.post('/why/:pid/:itemId/answer', form, page(async (request, response) => {
    const practice = practiceOf(String(request.params.pid));
    const { card, index } = cardOf(practice, String(request.params.itemId));
    const answer = str(request.body?.answer).trim();
    const result = await answerFollowup(card.id, { answer }, options.followupProvider);
    if (!result.ok && result.httpStatus === 400) {
      failed(response, 'answer_invalid');
      render(response, WhyAskPage({ practiceId: practice.id, card, index, total: practice.items.length, turns: getV2Reflection(card.id)?.turns ?? [], error: result.message, answer }), 400);
      return;
    }
    if (result.ok && result.secondQuestion) { response.redirect(303, `/s/why/${practice.id}/${card.id}`); return; }
    response.redirect(303, `/s/why/${practice.id}/${card.id}/confirm`);
  }));

  const confirmPage = (request: Request, practice: PracticeDetail, itemId: string, error?: string | null): ReactNode => {
    const { card, index } = cardOf(practice, itemId);
    const view = getV2Reflection(card.id);
    return WhyConfirmPage({
      practiceId: practice.id, card, index, total: practice.items.length, last: remaining(request, practice, card.id).length === 0,
      suggestion: view?.suggestion ?? null, previous: view?.reflection ?? null, error,
    });
  };

  r.get('/why/:pid/:itemId/confirm', page((request, response) => {
    const practice = practiceOf(String(request.params.pid));
    render(response, confirmPage(request, practice, String(request.params.itemId)));
  }));

  r.post('/why/:pid/:itemId/submit', form, page(async (request, response) => {
    const practice = practiceOf(String(request.params.pid));
    const { card } = cardOf(practice, String(request.params.itemId));
    const attemptState = str(request.body?.attemptState);
    const cause = str(request.body?.cause);
    const mastery = str(request.body?.masteryFeeling);
    const missing = [
      (ATTEMPT_STATES as readonly string[]).includes(attemptState) ? null : '当时怎么了',
      (CAUSES as readonly string[]).includes(cause) ? null : '错在哪',
      /^[0-3]$/.test(mastery) ? null : '有没有把握',
    ].filter(Boolean);
    if (missing.length > 0) { failed(response, 'missing'); render(response, confirmPage(request, practice, card.id, `还差：${missing.join('、')}`), 400); return; }
    // 由学生自己点「提交」才写入；AI 只给过建议（领域规则）。
    const result = submitV2Reflection(card.id, { attemptState, cause, masteryFeeling: Number(mastery), summary: str(request.body?.summary).replace(/\s+/g, ' ').trim().slice(0, 60) });
    if (!result.ok) { failed(response, 'submit_failed'); render(response, confirmPage(request, practice, card.id, result.message), result.httpStatus); return; }
    await goNextWhy(response, practice.id, remaining(request, practiceOf(practice.id), card.id));
  }));

  r.post('/why/:pid/:itemId/pass', page(async (request, response) => {
    const practice = practiceOf(String(request.params.pid));
    const { card } = cardOf(practice, String(request.params.itemId));
    const skips = readSkips(request);
    skips.passedItems.add(card.id);
    writeSkips(request, response, skips);
    response.locals.trailSkip = 'item';
    await goNextWhy(response, practice.id, practice.items.filter(item => !item.reflected && !skips.passedItems.has(item.id)));
  }));

  // ---------- 打印练习纸 ----------
  const printState = (practiceId: string): PrintState => {
    const status = getPrintStatus(practiceId);
    if (status.httpStatus !== 200) throw new NotFound();
    const body = status.body as { status: string; progress?: { done: number; total: number }; snapshot?: PrintSnapshot; error?: string | null };
    if (body.status === 'ready' && body.snapshot) return { status: 'ready', snapshot: body.snapshot };
    if (body.status === 'preparing') return { status: 'preparing', done: body.progress?.done ?? 0, total: body.progress?.total ?? 0 };
    if (body.status === 'failed') return { status: 'failed', error: body.error ?? null };
    return { status: 'none' };
  };

  r.post('/print/:pid', page((request, response) => {
    const practice = practiceOf(String(request.params.pid));
    requestPrint(practice.id, options.coachProvider);
    response.redirect(303, `/s/print/${practice.id}`);
  }));

  r.get('/print/:pid', page(async (request, response) => {
    const practice = practiceOf(String(request.params.pid));
    const state = await loadToday(ctx, request);
    const print = printState(practice.id);
    render(response, PrintPage({ practiceId: practice.id, state: print, includeAnswers: request.query.answers === '1', caption: captionFor(state, 'print'), since: print.status === 'preparing' ? printStartedAt(practice.id) : null, now: ctx.now() }));
  }));

  r.get('/print/:pid/sheet', page((request, response) => {
    const practice = practiceOf(String(request.params.pid));
    const state = printState(practice.id);
    if (state.status !== 'ready') { response.redirect(303, `/s/print/${practice.id}`); return; }
    render(response, SheetPage({ snapshot: state.snapshot, includeAnswers: request.query.answers === '1' }));
  }));

  // ---------- 录练习纸的结果（一题一屏，答案放在隐藏字段里一路带着，最后一次提交） ----------
  const recordInfo = (practiceId: string) => {
    const practice = practiceOf(practiceId);
    if (!practice.generatedAt) return null;
    const pending = practice.items.filter(item => item.status === 'packet_generated');
    return { practice, pending, recorded: practice.items.length - pending.length, days: dayOptions(new Date(practice.generatedAt), ctx.now(), ctx.timeZone) };
  };
  const answerOf = (state: Record<string, string>, itemId: string): RecordAnswer => ({
    completion: state[`c_${itemId}`] ?? '', correct: state[`k_${itemId}`] ?? '', stuck: state[`s_${itemId}`] ?? '', date: state[`d_${itemId}`] ?? state.date ?? '',
  });
  const NEEDS_CORRECT = new Set(['independent', 'hint1', 'hint2']);
  const COMPLETION_VALUES = new Set(COMPLETIONS.map(([value]) => value));

  r.get('/record/:pid', page((request, response) => {
    const info = recordInfo(String(request.params.pid));
    if (!info) { response.redirect(303, `/s/print/${String(request.params.pid)}`); return; }
    if (info.pending.length === 0) { response.redirect(303, `/s/results/${info.practice.id}`); return; }
    const rejected = str(request.query.rejected) ? `这道没提交上：${str(request.query.rejected).slice(0, 200)}` : null;
    render(response, RecordDatePage({ practiceId: info.practice.id, days: info.days, state: {}, recorded: info.recorded, remaining: info.pending.length, rejected }));
  }));

  r.post('/record/:pid', form, page((request, response) => {
    const info = recordInfo(String(request.params.pid));
    if (!info) { response.redirect(303, `/s/print/${String(request.params.pid)}`); return; }
    if (info.pending.length === 0) { response.redirect(303, `/s/results/${info.practice.id}`); return; }
    const { practice, pending, days } = info;
    const dayValues = new Set(days.map(day => day.value));
    const ids = new Set(pending.map(item => item.id));
    // 带过来的状态：共用日期 + 每题的答案。
    const state: Record<string, string> = {};
    const body = (request.body ?? {}) as Record<string, unknown>;
    for (const [name, value] of Object.entries(body)) {
      const match = /^([ckds])_(itm_[0-9a-f]{16})$/.exec(name);
      if (match && ids.has(match[2]!) && typeof value === 'string' && value.length <= 100) state[name] = value;
    }
    const date = str(body.date);
    if (dayValues.has(date)) state.date = date;
    const at = Number(str(body.at));
    const go = str(body.go);
    const total = pending.length;
    response.locals.trailAction = at === 0 ? 'submit:date' : go === 'prev' ? 'submit:prev' : at >= total ? 'submit:final' : 'submit:next';
    const showItem = (index: number, error?: string | null): void => {
      const card = pending[index]!;
      render(response, RecordItemPage({ practiceId: practice.id, card, index, total, days, state, answer: answerOf(state, card.id), error }), error ? 400 : 200);
    };
    const showDate = (error?: string | null): void => {
      render(response, RecordDatePage({ practiceId: practice.id, days, state, recorded: info.recorded, remaining: total, error }), error ? 400 : 200);
    };
    if (!Number.isInteger(at) || at < 0 || at > total) { showDate(); return; }
    if (at === 0) {
      if (!state.date) { failed(response, 'date_missing'); showDate('先选一下是哪天做的'); return; }
      showItem(0);
      return;
    }
    // 当前这道的答案并进状态。
    const card = pending[at - 1]!;
    const completion = str(body.completion);
    if (COMPLETION_VALUES.has(completion)) state[`c_${card.id}`] = completion; else delete state[`c_${card.id}`];
    const correct = str(body.correct);
    if (NEEDS_CORRECT.has(completion) && (correct === 'yes' || correct === 'no')) state[`k_${card.id}`] = correct; else delete state[`k_${card.id}`];
    const stuck = str(body.stuck).trim().slice(0, 100);
    if (completion === 'not_solved' && stuck) state[`s_${card.id}`] = stuck; else delete state[`s_${card.id}`];
    const itemDate = str(body.itemDate);
    if (dayValues.has(itemDate) && itemDate !== state.date) state[`d_${card.id}`] = itemDate; else delete state[`d_${card.id}`];
    if (go === 'prev') { if (at === 1) showDate(); else showItem(at - 2); return; }
    if (!state[`c_${card.id}`]) { failed(response, 'completion_missing'); showItem(at - 1, '先选这道是怎么做的'); return; }
    if (NEEDS_CORRECT.has(completion) && !state[`k_${card.id}`]) { failed(response, 'correct_missing'); showItem(at - 1, '对照练习纸最后一页的答案，选一下做对了没有'); return; }
    if (at < total) { showItem(at); return; }
    // 最后一道：一次提交全部（服务器逐条判定）。
    if (!state.date) { failed(response, 'date_missing'); showDate('先选一下是哪天做的'); return; }
    for (let index = 0; index < total; index += 1) {
      if (!state[`c_${pending[index]!.id}`]) { failed(response, 'item_missing'); showItem(index, '这道还没录'); return; }
    }
    const results = pending.map(item => {
      const c = state[`c_${item.id}`]!;
      return {
        itemId: item.id, completion: c, performedOn: state[`d_${item.id}`] ?? state.date!,
        ...(NEEDS_CORRECT.has(c) ? { correct: state[`k_${item.id}`] === 'yes' } : {}),
        ...(state[`s_${item.id}`] ? { stuckStep: state[`s_${item.id}`] } : {}),
      };
    });
    const outcome = submitReturns(practice.id, { results });
    if (!outcome.ok) { failed(response, 'return_failed'); showDate(outcome.message); return; }
    const rejected = outcome.results.find(entry => !entry.ok);
    if (rejected) {
      failed(response, 'return_rejected');
      const label = pending.find(item => item.id === rejected.itemId)?.shortId ?? '';
      response.redirect(303, `/s/record/${practice.id}?rejected=${encodeURIComponent(`${label} ${rejected.error ?? ''}`.trim())}`);
      return;
    }
    response.redirect(303, `/s/results/${practice.id}`);
  }));

  // ---------- 这次的结果 / 以前的练习 ----------
  r.get('/results/:pid', page(async (request, response) => {
    const practice = practiceOf(String(request.params.pid));
    const summary = getReturnSummary(practice.id);
    if (!summary) throw new NotFound();
    const state = await loadToday(ctx, request);
    const bar = nextStepBar(state, null);
    const next: BarButton = bar.primary && !('disabled' in bar.primary && bar.primary.disabled) ? bar.primary : { title: '返回错题本', key: 'goHome', href: '/s/' };
    render(response, ResultsPage({ practice, summary, next }));
  }));

  const dashboard = (response:Response, error?:string): void => {
    const recommendation=suggestedPractice(ctx.mobileDataDir);
    const tasks=listPractices(-1).map(p=>({
      practice:getPractice(p.id)!,lifecycle:taskLifecycle(p.id),recorded:Object.keys(practiceProgress(p.id).answers).length,received:0,
    }));
    render(response,PracticeDashboardPage({tasks,activeId:activePractice()?.id??null,recommendation,requestKey:crypto.randomUUID(),error}));
  };
  r.get('/practices',page((_request,response)=>dashboard(response)));
  r.post('/practices/start',form,page((request,response)=>{
    const result=startSuggestedPractice(ctx.mobileDataDir,str(request.body?.key));
    if(!result.ok){response.status(result.httpStatus);dashboard(response,result.message);return;}
    if(taskLifecycle(result.detail.id)!=='cancelled')requestPrint(result.detail.id,options.coachProvider);
    response.redirect(303,`/s/practice/${result.detail.id}`);
  }));
  for(const [action,lifecycle] of [['pause','paused'],['resume','active'],['cancel','cancelled']] as const){
    r.post(`/practice/:pid/${action}`,form,page((request,response)=>{
      const p=practiceOf(String(request.params.pid));
      try{setTaskLifecycle(p.id,lifecycle);}catch(error){response.status(409);dashboard(response,error instanceof Error?error.message:'任务没有更新');return;}
      response.redirect(303,action==='cancel'&&request.body?.next==='choose'?'/s/choose':'/s/practices');
    }));
  }

  // ---------- 设置 ----------
  /** 设置页的账号身份标签：只有邀请码网关 worker 模式才有（locals 由上面的内部头中间件写入）；旧独立版一律不显示。 */
  const accountRoleOf = (response: Response): AccountRole | null =>
    options.studentHostWorker === true && isAccountRole(response.locals.accountRole) ? response.locals.accountRole : null;

  r.get('/settings', page((_request, response) => {
    render(response, SettingsPage({ studentHostWorker: options.studentHostWorker === true, accountRole: accountRoleOf(response), grade: requireProfile().grade }));
  }));

  r.post('/settings/grade', form, page((request, response) => {
    if (!updateStudentGrade(getDb(), requireProfile().id, request.body?.grade)) {
      render(response, SettingsPage({studentHostWorker:options.studentHostWorker === true,accountRole:accountRoleOf(response),grade:requireProfile().grade,error:'请选择初一、初二或初三。'}), 400); return;
    }
    audit('student_grade_updated', 'student', requireProfile().id);
    response.redirect(303, '/s/settings');
  }));

  // 兼容已打开的旧网页；新设置页不再提供做题时段与原卷位置表单。
  r.post('/settings', form, page((request, response) => {
    const slotChoice = str(request.body?.practiceSlot);
    const practiceSlot = (slotChoice === '__other' ? str(request.body?.practiceSlotOther) : slotChoice).trim();
    const result = updateV2Settings({ practiceSlot, paperLocation: str(request.body?.paperLocation) });
    if (!result.ok) { failed(response, 'settings_invalid'); render(response, ErrorPage({ title: '设置没有保存', detail: '请重新打开设置页。', reason: result.message }), 400); return; }
    response.redirect(303, '/s/settings');
  }));

  // ---------- 语音转写（同源镜像 /v2/reflections/transcribe：同一校验、同一转写器、同一限流档） ----------
  r.post('/voice', express.raw({ type: () => true, limit: TRANSCRIBE_MAX_BYTES }), async (request, response, next) => {
    try {
      const gate = options.limiter.transcribe(String(response.locals.deviceId));
      if (!gate.allowed) {
        failed(response, 'rate_limited');
        response.setHeader('retry-after', String(gate.retryAfterSeconds));
        response.status(429).json({ error: { code: 'rate_limited', message: '说得太频繁了，过一会儿再试，或者直接打字。' } });
        return;
      }
      const outcome = await transcribeClip(transcriber(), request.body, request.headers['content-type']);
      response.status(outcome.status).json(outcome.body);
    } catch (error) { next(error); }
  });

  // ---------- 图片（全部要设备令牌；只给本周 / 本学生的识别任务、v2 题目与练习快照） ----------
  const registered = (jobId: string): boolean => !!getDb().prepare('SELECT 1 FROM v2_photo WHERE job_id = ?').get(jobId);
  r.get('/img/photo/:jobId', page(async (request, response) => {
    const jobId = requireMatch(String(request.params.jobId), UUID);
    if (!registered(jobId)) throw new NotFound();
    const job = await options.service.getJob(jobId);
    const source = await options.service.getMedia(jobId, job.sourceMediaId);
    const full = request.query.full === '1';
    // 网格里的缩略图：一格约 114 CSS px 宽，按 2 倍下发（228 px）；「看原图」1600 px。
    const bytes = await sharp(source, { limitInputPixels: 40_000_000 }).rotate().resize({ width: full ? 1600 : 228, withoutEnlargement: true }).jpeg({ quality: full ? 85 : 70 }).toBuffer();
    response.type('image/jpeg').send(bytes);
  }));
  // 题目裁图：?s=thumb|list|big 按显示尺寸的 2 倍以内缩小后下发（从不放大）；不带 s 的是原图（「看原图」、打印用）。磁盘上的原图不动。
  r.get('/img/cand/:jobId/:questionId', page(async (request, response) => {
    const jobId = requireMatch(String(request.params.jobId), UUID);
    if (!registered(jobId)) throw new NotFound();
    response.type('image/jpeg').send(await displayImage(await options.service.getCandidateCrop(jobId, requireMatch(String(request.params.questionId), UUID)), displaySize(request.query.s)));
  }));
  r.get('/img/item/:id', page(async (request, response) => {
    const itemId = requireMatch(String(request.params.id), ITEM_ID);
    if (!isV2Item(itemId)) throw new NotFound();
    response.type('image/jpeg').send(await displayImage(request.query.scope === 'full' ? await getItemFullCrop(itemId) : await getQuestionCrop(itemId), displaySize(request.query.s)));
  }));
  r.get('/img/print/:pid/:name', page(async (request, response) => {
    const media = readPrintMedia(requireMatch(String(request.params.pid), PACKET_ID), String(request.params.name));
    if (!media) throw new NotFound();
    // 练习纸上（打印）用原图；手机上看的那一道、打印前看一眼的截图用缩小的。
    response.type('image/jpeg').send(await displayImage(media, displaySize(request.query.s)));
  }));

  r.use((_request, response) => render(response, ErrorPage({ title: '这一页不存在', detail: '可能链接不完整。回到今天接着做。' }), 404));

  const errors: ErrorRequestHandler = (error, request, response, _next) => {
    if (response.headersSent) return;
    const isImage = request.path.startsWith('/img/');
    if (error instanceof NotFound || (error instanceof MobileRequestError && error.status === 404)) {
      if (isImage) { response.status(404).type('text/plain').send('not found'); return; }
      render(response, ErrorPage({ title: '这一页不存在', detail: '可能链接不完整，或者这道题已经不在了。回到今天接着做。' }), 404);
      return;
    }
    if ((error as { type?: string }).type === 'entity.too.large') {
      response.status(413).json({ error: { code: 'payload_too_large', message: request.path === '/voice' ? '录音超过 5 MB 限制。' : '内容太大了。' } });
      return;
    }
    if (request.path === '/voice' || isImage || wantsJson(request)) { response.status(500).json({ error: { code: 'internal', message: '服务器暂时没处理好，再试一次。' } }); return; }
    render(response, ErrorPage({ title: '服务器暂时没处理好', detail: '再试一次；照片和错题都还在。' }), 500);
  };
  r.use(errors);
  return r;
}
