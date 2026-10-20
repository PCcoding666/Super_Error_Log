/**
 * 学生网页版（/s/）：云端移动服务同源挂载，SSR、表单驱动、不做 hydration。
 * - 鉴权：配对兑换得到的设备令牌放在 httpOnly cookie（Path=/s），每个请求按 /v1 /v2 同一规则鉴权与限流。
 * - 业务全部调用现有服务（识别 service、/v2 的 week/practice/print/return/reflection/correction/settings），
 *   不在视图里另写一份规则；页面只做「取数 → WeekPlan → 渲染」与表单提交。
 * - 只有拍照上传与录音用到脚本；关掉脚本时每屏照样能用（语音除外）。
 */
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
import { discardV2Item, restoreV2Item } from '../v2/weekService.js';
import { getLearningSource, learningCard, materialStoreForItem } from '../learning/sources.js';
import { setQuestionIncluded } from '../materials/learning.js';
import { getLearningWeek as getWeek } from '../learning/queries.js';
import type { LearningCard as V2WeekItem } from '../learning/contracts.js';
import { getItemFullCrop } from '../v2/fullCrop.js';
import { getV2Settings, updateV2Settings } from '../v2/settingsService.js';
import { createLearningPractice as createPractice, getLearningPractice as getPractice, listLearningPractices as listPractices, recommendLearningPractice as recommendPractice } from '../learning/queries.js';
import type { LearningPracticeCard as PracticeCard, LearningPracticeDetail as PracticeDetail } from '../learning/contracts.js';
import { getPrintStatus, readPrintMedia, requestPrint, type PrintSnapshot } from '../v2/printService.js';
import { getLearningReturnSummary as getReturnSummary, submitLearningReturns as submitReturns } from '../v2/returnService.js';
import { answerFollowup, askFollowup, getV2Reflection, submitV2Reflection } from '../v2/reflectionService.js';
import { acceptCorrection, directCorrection, getEvidenceView, proposeCorrection } from '../v2/correctionService.js';
import { TRANSCRIBE_MAX_BYTES, transcribeClip } from '../v2/transcribe.js';
import { CLIENT_SCRIPT, SERVICE_WORKER, STYLES, iconPng, manifest } from './assets.js';
import { COOKIE, clearCookie, giveConsent, hasConsent, markInstallHint, readCookies, readPhotoMarks, readSkips, sawInstallHint, setCookie, writePhotoMarks, writeSkips } from './session.js';
import { actionHref, loadPhotos, loadToday, type TodayState, type WebContext } from './state.js';
import { trailRecorder, trailTaps } from './trail.js';
import { DEFAULT_TIME_ZONE, localDayOrdinal, localDayText, stepCaption, type StepKind } from './weekPlan.js';
import { barButton, barFromPlan, BusyPage, ConnectPage, ErrorPage, InstallPage, OfflinePage, PairPage, TodayPage } from './views/today.js';
import { CapturePage, ConsentPage, PhotosPage, PickPage } from './views/photos.js';
import { EditPage, FixPage, ItemDetailPage, ItemsPage } from './views/items.js';
import {
  ChoosePage, PracticesPage, PrintPage, RecordDatePage, RecordItemPage, ResultsPage, SettingsPage, SheetPage,
  WhyAskPage, WhyConfirmPage, WhyDonePage, WhyIntroPage, COMPLETIONS, type DayOption, type PrintState, type RecordAnswer,
} from './views/practice.js';
import { createMaterialsRouter } from './materialsRouter.js';
import type { WebClientDeps } from '../mobile/router.js';
import type { BarButton, BarModel } from './views/layout.js';

export interface WebClientOptions {
  materials?: WebClientDeps['materials'];
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
  const namespace = response.locals.draftNamespace as string | undefined;
  if (!namespace) { sendHtml(response, node); return; }
  const html = renderToStaticMarkup(node).replace(/<body\b/, `<body data-draft-namespace="${namespace}"`).replace(/(<form\b[^>]*>)([\s\S]*?)(<\/form>)/g, (_match, open: string, body: string, close: string) => `${open}${body.includes('name="namespace"') ? '' : `<input type="hidden" name="namespace" value="${namespace}"/>`}${body}${close}`);
  response.type('html').send(`<!doctype html>${html}`);
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
  return { caption: '', primary: { title: '回到今天', key: 'goHome', href: '/s/' }, secondary: [] };
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
  r.get('/manifest.webmanifest', (_request, response) => { response.type('application/manifest+json').send(JSON.stringify(manifest())); });
  r.get('/sw.js', (_request, response) => { response.type('text/javascript').send(SERVICE_WORKER); });
  r.get('/assets/app.css', (_request, response) => { response.type('text/css').send(STYLES); });
  r.get('/assets/app.js', (_request, response) => { response.type('text/javascript').send(CLIENT_SCRIPT); });
  const icon = (size: number, maskable = false) => async (_request: Request, response: Response): Promise<void> => {
    response.type('image/png').send(await iconPng(size, maskable));
  };
  r.get('/assets/icon-192.png', icon(192));
  r.get('/assets/icon-512.png', icon(512));
  r.get('/assets/icon-maskable-512.png', icon(512, true));
  r.get('/assets/apple-touch-icon.png', icon(180));
  r.get('/offline', (_request, response) => render(response, OfflinePage()));

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
        if (!gate.allowed) { failed(response, 'busy'); response.setHeader('retry-after', String(gate.retryAfterSeconds)); render(response, BusyPage({ retryAfterSeconds: gate.retryAfterSeconds, connected: false }), 429); return; }
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
        if (!fail.allowed) { failed(response, 'busy'); response.setHeader('retry-after', String(fail.retryAfterSeconds)); render(response, BusyPage({ retryAfterSeconds: fail.retryAfterSeconds, connected: false }), 429); return; }
        reject('unauthorized');
        return;
      }
      response.locals.deviceId = deviceId;
      const query = options.limiter.authedQuery(deviceId);
      if (!query.allowed) {
        failed(response, 'busy');
        response.setHeader('retry-after', String(query.retryAfterSeconds));
        if (request.path === '/voice' || wantsJson(request)) { response.status(429).json({ error: { code: 'rate_limited', message: '请求过于频繁，请稍后再试。' } }); return; }
        render(response, BusyPage({ retryAfterSeconds: query.retryAfterSeconds, connected: true }), 429);
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

  const useMaterials = options.materials && !(process.env.NODE_ENV === 'test' && process.env.SEL_STUDENT_WORKER_FAKE === '1' && process.env.SEL_E2E_LEGACY_CAPTURE === '1');
  if (useMaterials && options.materials) {
    ctx.materials=options.materials.store;
    const namespace = options.materials.store.getWorkspace().draftNamespace;
    r.use((request,response,next) => request.path.startsWith('/materials/answers/') ? next() : form(request,response,next), (request, response, next) => {
      response.locals.draftNamespace = namespace;
      if (request.method === 'POST' && !request.path.startsWith('/materials/answers/') && request.is('application/x-www-form-urlencoded') && request.body?.namespace !== namespace) { response.status(409).send('登录的账号已变化，请重新打开页面。'); return; }
      next();
    });
    r.use(createMaterialsRouter({ ...options.materials, draftNamespace: namespace, admission: options.admission }));
  }

  // ---------- 今天 ----------
  r.get('/', page(async (request, response) => {
    const state = await loadToday(ctx, request);
    const flash = request.query.paired === '1' ? { ok: '连上了 ✓' } : undefined;
    render(response, TodayPage({ materials: !!useMaterials, state, practiceSlot: getV2Settings().practiceSlot, flash, showInstallHint: !sawInstallHint(request) }));
  }));
  r.post('/install/seen', page((request, response) => { markInstallHint(request, response); response.redirect(303, '/s/'); }));
  r.get('/install', page((_request, response) => render(response, InstallPage())));

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
    const current = state.plan.currentIndex === null ? null : state.plan.steps[state.plan.currentIndex] ?? null;
    const next = current && current.kind !== 'shoot'
      ? { title: current.title, href: current.kind === 'pick' ? '/s/photos' : current.action ? actionHref(current.action) : '/s/' }
      : { title: '勾出做错的题', href: '/s/photos' };
    const err = UPLOAD_ERRORS[str(request.query.err)] ?? null;
    render(response, CapturePage({ photos: state.photos, next, caption: captionFor(state, 'shoot'), flash: { err } }));
  }));

  r.post('/consent', form, page((request, response) => { if (options.materials && request.body?.namespace && request.body.namespace !== options.materials.store.getWorkspace().draftNamespace) { response.status(409).send('登录的账号已变化，请重新打开页面。'); return; } giveConsent(request, response); const questionId = str(request.body?.questionId); const attemptId = str(request.body?.attemptId); response.redirect(303, '/s/capture' + (questionId ? `?questionId=${encodeURIComponent(questionId)}${attemptId ? `&attemptId=${encodeURIComponent(attemptId)}` : ''}` : '')); }));

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
    const photos = state.photos.filter(photo => !(photo.dismissed && photo.failure));
    // 这周的练习纸已经生成（做完了 / 周中）以后又拍了卷子：这周的练习已经定了，不再带他去选题；
    // 说清楚新找到的题去了哪（进错题本，下个周末再选），下一步是「回到今天」（门槛 G3）。
    if (state.plan.stage === 'done' || state.plan.stage === 'midweek') {
      const needsPick = photos.find(photo => photo.state === 'needsPick');
      const bar: BarModel = needsPick
        ? { caption: '', primary: { title: `勾第 ${needsPick.number} 张`, key: 'openPick', href: `/s/photos/${needsPick.jobId}` }, secondary: [{ title: '回到今天', key: 'goHome', href: '/s/' }] }
        : { caption: refresh ? 'AI 在后台找题，可以先回去' : '', primary: { title: '回到今天', key: 'goHome', href: '/s/' }, secondary: [] };
      render(response, PhotosPage({ photos, bar, refresh, itemCount: state.week.items.length, afterWeek: true, newSince: state.latestDetail?.createdAt ?? null, flash: { err } }));
      return;
    }
    const bar = nextStepBar(state, 'pick');
    render(response, PhotosPage({ photos, bar: { ...bar, caption: bar.caption || captionFor(state, 'pick') }, refresh, itemCount: state.week.items.length, flash: { err } }));
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
    try { await options.service.select(jobId, [...new Set(ids)].slice(0, 30)); }
    catch (error) {
      if (error instanceof MobileRequestError) { failed(response, 'select_failed'); render(response, PickPage({ photo, error: error.message }), error.status); return; }
      throw error;
    }
    response.redirect(303, '/s/photos');
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
    if (!getLearningSource(itemId)) throw new NotFound();
    const week = getWeek(ctx.mobileDataDir);
    const item = [...week.items, ...week.backlog].find(entry => entry.id === itemId);
    if (item) return item;
    for (const summary of listPractices()) {
      const card = getPractice(summary.id)?.items.find(entry => entry.id === itemId);
      if (card) return card;
    }
    const stored=learningCard(itemId);if(stored)return stored;
    throw new NotFound();
  };

  r.get('/items', page(async (request, response) => {
    const state = await loadToday(ctx, request);
    const removed = ITEM_ID.test(str(request.query.removed)) ? str(request.query.removed) : null;
    const current = state.plan.currentIndex === null ? null : state.plan.steps[state.plan.currentIndex];
    const bar = current?.kind === 'choose' ? nextStepBar(state, null) : { caption: '', primary: null, secondary: [{ title: '回到今天', key: 'goHome', href: '/s/' }] };
    render(response, ItemsPage({ items: state.week.items, backlog: state.week.backlog, anyPhoto: state.week.photos.length > 0, materials: !!ctx.materials, finding: state.photos.some(photo => photo.state === 'finding'), bar, removed }));
  }));

  const detail = (itemId: string, error?: string | null): ReactNode => {
    const item = findItem(itemId);
    return ItemDetailPage({
      item, evidence: getEvidenceView(itemId), canDiscard: item.source.kind==='material' || item.status === 'ready_for_reflection' || item.status === 'eligible_for_review',
      reflected: getV2Reflection(itemId)?.reflection != null, error,
    });
  };

  r.get('/items/:id', page((request, response) => render(response, detail(String(request.params.id)))));

  r.post('/items/:id/discard', page((request, response) => {
    const itemId = String(request.params.id);
    findItem(itemId);
    const source=getLearningSource(itemId)!;
    if(source.kind==='material'){const store=materialStoreForItem(itemId)!;setQuestionIncluded(store,source.questionId,false,store.getQuestion(source.questionId)!.revision);response.redirect(303,`/s/items?removed=${itemId}`);return;}
    const result = discardV2Item(itemId);
    if (!result.ok) { failed(response, 'discard_refused'); render(response, detail(itemId, result.message), result.httpStatus); return; }
    response.redirect(303, `/s/items?removed=${itemId}`);
  }));

  r.post('/items/:id/restore', page((request, response) => {
    const itemId = requireMatch(String(request.params.id), ITEM_ID);
    const source=getLearningSource(itemId);
    if(source?.kind==='material'){const store=materialStoreForItem(itemId)!;setQuestionIncluded(store,source.questionId,true,store.getQuestion(source.questionId)!.revision);}else restoreV2Item(itemId);
    response.redirect(303, '/s/items');
  }));

  const fixPage = (itemId: string, extra: { error?: string | null; instruction?: string; proposal?: Parameters<typeof FixPage>[0]['proposal'] } = {}): ReactNode => {
    const item = findItem(itemId);
    const evidence = getEvidenceView(itemId);
    if (!evidence) throw new NotFound();
    return FixPage({ item, revision: evidence.revision, clientRequestId: crypto.randomUUID(), ...extra });
  };

  r.get('/items/:id/fix', page((request, response) => render(response, fixPage(String(request.params.id)))));

  r.post('/items/:id/fix', form, page(async (request, response) => {
    const itemId = String(request.params.id);
    findItem(itemId);
    const instruction = str(request.body?.instruction);
    const method = str(request.body?.method) === 'voice' ? 'voice' : 'keyboard';
    const result = await proposeCorrection(itemId, {
      instruction, method, revision: Number(str(request.body?.revision)), clientRequestId: str(request.body?.clientRequestId),
    }, options.correctionProvider);
    if (!result.ok) { failed(response, 'fix_failed'); render(response, fixPage(itemId, { error: result.message, instruction }), result.httpStatus); return; }
    render(response, fixPage(itemId, { instruction, proposal: { proposalId: result.proposalId, revision: result.revision, changes: result.changes, clarify: result.clarify } }));
  }));

  r.post('/items/:id/fix/accept', form, page((request, response) => {
    const itemId = String(request.params.id);
    findItem(itemId);
    const result = acceptCorrection(itemId, { proposalId: str(request.body?.proposalId), revision: Number(str(request.body?.revision)) });
    if (!result.ok) { failed(response, 'fix_accept_failed'); render(response, fixPage(itemId, { error: result.message }), result.httpStatus); return; }
    response.redirect(303, `/s/items/${itemId}`);
  }));

  r.get('/items/:id/edit', page((request, response) => {
    const itemId = String(request.params.id);
    const item = findItem(itemId);
    const evidence = getEvidenceView(itemId);
    if (!evidence) throw new NotFound();
    render(response, EditPage({ item, evidence }));
  }));

  r.post('/items/:id/edit', form, page((request, response) => {
    const itemId = String(request.params.id);
    const item = findItem(itemId);
    const evidence = getEvidenceView(itemId);
    if (!evidence) throw new NotFound();
    const after = str(request.body?.questionText).replace(/\r\n/g, '\n');
    if (after.trim() === '' || after === evidence.questionText) { response.redirect(303, `/s/items/${itemId}`); return; }
    const result = directCorrection(itemId, { revision: Number(str(request.body?.revision)), changes: [{ field: 'questionText', before: evidence.questionText, after }] });
    if (!result.ok) { failed(response, 'edit_failed'); render(response, EditPage({ item, evidence: getEvidenceView(itemId) ?? evidence, error: result.message }), result.httpStatus); return; }
    response.redirect(303, `/s/items/${itemId}`);
  }));

  // ---------- 选这周要练的题 ----------
  const choosePage = async (request: Request, error?: string | null, reason?: string | null): Promise<ReactNode> => {
    const state = await loadToday(ctx, request);
    return ChoosePage({ recommend: recommendPractice(ctx.mobileDataDir), practiceSlot: getV2Settings().practiceSlot, caption: captionFor(state, 'choose'), error, reason });
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
    response.redirect(303, `/s/why/${result.detail.id}`);
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
    render(response, PrintPage({ practiceId: practice.id, state: printState(practice.id), caption: captionFor(state, 'print') }));
  }));

  r.get('/print/:pid/sheet', page((request, response) => {
    const practice = practiceOf(String(request.params.pid));
    const state = printState(practice.id);
    if (state.status !== 'ready') { response.redirect(303, `/s/print/${practice.id}`); return; }
    render(response, SheetPage({ snapshot: state.snapshot }));
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
    const next: BarButton = bar.primary && !('disabled' in bar.primary && bar.primary.disabled) ? bar.primary : { title: '回到今天', key: 'goHome', href: '/s/' };
    render(response, ResultsPage({ practice, summary, next }));
  }));

  r.get('/practices', page((_request, response) => {
    const practices = listPractices().map((p, index) => {
      const summary = p.generatedAt ? getReturnSummary(p.id) : null;
      const items = getPractice(p.id)?.items ?? [];
      const shortIds = items.map(item => item.shortId).filter((id): id is string => Boolean(id));
      // 最近一份把它的题列出来（小裁图、编号、科目）；更早的只写题号。
      return { ...p, answered: summary?.answered ?? null, independentCorrect: summary && summary.answered > 0 ? summary.independentCorrect : null, shortIds, ...(index === 0 ? { items } : {}) };
    });
    render(response, PracticesPage({ practices }));
  }));

  // ---------- 设置 ----------
  r.get('/settings', page((request, response) => {
    const settings = getV2Settings();
    render(response, SettingsPage({ ...settings, saved: request.query.saved === '1', studentHostWorker: options.studentHostWorker === true }));
  }));

  r.post('/settings', form, page((request, response) => {
    const slotChoice = str(request.body?.practiceSlot);
    const practiceSlot = (slotChoice === '__other' ? str(request.body?.practiceSlotOther) : slotChoice).trim();
    const result = updateV2Settings({ practiceSlot, paperLocation: str(request.body?.paperLocation) });
    if (!result.ok) { failed(response, 'settings_invalid'); render(response, SettingsPage({ ...getV2Settings(), saved: false, error: result.message.includes('practiceSlot') ? '做练习的时间要写 1–20 个字。' : '选一下原卷平时放在哪。', studentHostWorker: options.studentHostWorker === true }), 400); return; }
    response.redirect(303, '/s/settings?saved=1');
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
    const bytes = await sharp(source, { limitInputPixels: 40_000_000 }).rotate().resize({ width: full ? 1600 : 360, withoutEnlargement: true }).jpeg({ quality: full ? 85 : 70 }).toBuffer();
    response.type('image/jpeg').send(bytes);
  }));
  r.get('/img/cand/:jobId/:questionId', page(async (request, response) => {
    const jobId = requireMatch(String(request.params.jobId), UUID);
    if (!registered(jobId)) throw new NotFound();
    response.type('image/jpeg').send(await options.service.getCandidateCrop(jobId, requireMatch(String(request.params.questionId), UUID)));
  }));
  r.get('/img/item/:id', page(async (request, response) => {
    const itemId = requireMatch(String(request.params.id), ITEM_ID);
    if (!getLearningSource(itemId)) throw new NotFound();
    const source=getLearningSource(itemId)!;
    if(source.kind==='material'){
      const q=materialStoreForItem(itemId)!.getQuestion(source.questionId)!;
      const f=q.stem.find(f=>f.role==='question');if(!f)throw new NotFound();
      response.redirect(303,`/s/materials/fragments/${f.fragmentId}/crop`);return;
    }
    response.type('image/jpeg').send(request.query.scope === 'full' ? await getItemFullCrop(itemId) : await getQuestionCrop(itemId));
  }));
  r.get('/img/print/:pid/:name', page((request, response) => {
    const media = readPrintMedia(requireMatch(String(request.params.pid), PACKET_ID), String(request.params.name));
    if (!media) throw new NotFound();
    response.type('image/jpeg').send(media);
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
