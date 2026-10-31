import crypto from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import { MobileRecognitionService, MobileRequestError } from './service.js';
import { IdempotencyConflictError, MobileRecognitionStore } from './store.js';
import type { MobileVisionBoundary } from './vision.js';
import { PairingError, type PairingManager } from './pairing.js';
import { RateLimiter, clientIp } from './rateLimit.js';
import { AdmissionController } from './admission.js';
import type { MaterialStore } from '../materials/store.js';
import { MaterialJobs } from '../materials/jobs.js';
import { MaterialUploads } from '../materials/uploads.js';
import { registerHelpPortal } from '../portal/helpPortal.js';
import { errorSummary, logEvent, requestIdOf } from '../observability/log.js';

export interface CreateMobileAppOptions {
  dataDir: string;
  /** Supplied only where the server-owned student database/profile already exists. */
  materialStore?: MaterialStore;
  configureMaterials?: (jobs: MaterialJobs, uploads: MaterialUploads) => void;
  vision: MobileVisionBoundary;
  /** 回环模式（默认）：共享令牌鉴权。 */
  pairingToken?: string;
  /** 云端模式：设备令牌鉴权 + redeem 路由。 */
  mode?: 'loopback' | 'cloud';
  pairing?: PairingManager;
  /** 仅云端：是否信任本机反代覆写的 X-Real-IP（Caddy header_up）。 */
  cloudProxy?: boolean;
  rateLimiter?: RateLimiter;
  /** 入口容量控制（Task 3）：云端缺省构造默认容量；回环模式不启用。 */
  admission?: AdmissionController;
  /** 本学生同时处理的照片和材料任务数。缺省读 SEL_STUDENT_AI_CONCURRENCY。 */
  studentAiConcurrency?: number;
  /** 单进程装配（v2.0 T2）：挂载 /v2 路由，与 /v1 共用鉴权与限流。云端模式把限流器交给 /v2（语音转写另有一档）。 */
  v2Router?: (deps: { limiter: RateLimiter | null }) => express.Router;
  /** 学生网页版（/s/，仅云端模式）：同源挂载，复用同一个识别 service、配对、限流与准入。 */
  webClient?: (deps: WebClientDeps) => express.Router;
  /** Host-only administrator surface. It owns separate authentication. */
  adminWeb?: (deps: Pick<WebClientDeps, 'ipOf'>) => express.Router;
}

export interface WebClientDeps {
  service: MobileRecognitionService;
  materials?: { store: MaterialStore; jobs: MaterialJobs; uploads: MaterialUploads };
  pairing: PairingManager;
  limiter: RateLimiter;
  admission: AdmissionController | null;
  ipOf: (request: express.Request) => string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 照片上传的预约状态（挂 response.locals；handler finally 与 close 兜底按标志幂等释放）。 */
export interface AdmissionReserve { slot: boolean; capacity: boolean; handoff: boolean }

/** 新建预约状态并挂 close 兜底：413（解析中抛错不进 handler）与客户端中断两条路径也会归还。 */
export function trackUploadAdmission(admission: AdmissionController, response: express.Response): AdmissionReserve {
  const reserve: AdmissionReserve = { slot: false, capacity: false, handoff: false };
  response.locals.selAdmission = reserve;
  response.on('close', () => releaseUploadAdmission(admission, reserve));
  return reserve;
}

/** 幂等释放：解析槽位总是归还；任务容量只在没有移交给 service（新任务受理成功）时归还。 */
export function releaseUploadAdmission(admission: AdmissionController, reserve: AdmissionReserve): void {
  if (reserve.slot) { reserve.slot = false; admission.releaseUploadSlot('upload'); }
  if (reserve.capacity && !reserve.handoff) { reserve.capacity = false; admission.releaseJobCapacity(); }
}

export interface AdmissionRejection { status: 429 | 503; code: string; message: string; retryAfterSeconds?: number }

/**
 * 新照片的准入（Task 3 原子预约）：磁盘门槛 → 解析槽位 → 任务容量。先于正文解析执行，被拒正文不进入内存。
 * /v1/recognitions 与学生网页版的拍照上传（/s/capture）共用，容量规则只有这一份。
 */
export async function acquireUploadAdmission(admission: AdmissionController, reserve: AdmissionReserve): Promise<AdmissionRejection | null> {
  const gate = await admission.storageGate();
  if (!gate.ok) {
    const message = gate.reason === 'disk_low' ? '服务器磁盘空间不足，已停止接收新照片，请联系管理员。' : '错题本数据存储已达到上限，请联系管理员处理。';
    return { status: 503, code: gate.reason ?? 'storage_full', message };
  }
  const slot = admission.tryAcquireUploadSlot('upload');
  if (!slot.accepted) return { status: 429, code: 'busy', message: '服务器正在处理另一个上传，请稍后重试。', retryAfterSeconds: slot.retryAfterSeconds };
  reserve.slot = true;
  const capacity = admission.tryAcquireJobCapacity();
  if (!capacity.accepted) {
    admission.releaseUploadSlot('upload'); reserve.slot = false;
    return { status: 429, code: 'capacity_full', message: '识别队列已满，请稍后再试。', retryAfterSeconds: capacity.retryAfterSeconds };
  }
  reserve.capacity = true;
  return null;
}

function equalToken(actual: string, expected: string): boolean {
  const left = Buffer.from(actual); const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function id(value: string): string {
  if (!UUID.test(value)) throw new MobileRequestError(404, 'not_found', '识别任务不存在。'); return value;
}
function bodyObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MobileRequestError(400, 'invalid_request', '请求正文不合法。');
  return value as Record<string, unknown>;
}
function photoName(header: string | string[] | undefined): string {
  if (typeof header !== 'string') return '未命名照片.jpg';
  let decoded: string; try { decoded = decodeURIComponent(header); } catch { throw new MobileRequestError(400, 'invalid_photo_name', '照片名称编码不合法。'); }
  if (!decoded.trim() || decoded.length > 255 || /[\0-\x1f\x7f]/.test(decoded)) throw new MobileRequestError(400, 'invalid_photo_name', '照片名称不合法。');
  return decoded;
}
function pairingErrorStatus(code: PairingError['code']): number {
  switch (code) {
    case 'pairing_expired': return 410;
    case 'pairing_used': return 409;
    case 'pairing_not_found': return 404;
    case 'invalid_pairing_payload': return 400;
    default: return 401;
  }
}

export async function createMobileApp(options: CreateMobileAppOptions): Promise<express.Express> {
  const mode = options.mode ?? 'loopback';
  if (mode === 'cloud' && !options.pairing) throw new Error('云端模式必须提供 PairingManager');
  if (mode === 'loopback' && (!options.pairingToken || options.pairingToken.length < 16)) throw new Error('移动端配对令牌至少需要16个字符');
  const store = await MobileRecognitionStore.open(options.dataDir);
  const service = new MobileRecognitionService(store, options.vision, { studentAiConcurrency: options.studentAiConcurrency });
  const limiter = options.rateLimiter ?? new RateLimiter();
  const admission = options.admission ?? (mode === 'cloud' ? new AdmissionController({ dataDir: options.dataDir }) : null);
  // Task 3：service 终态释放容量与图像信号量依赖注入（云端必须接通，否则容量永不归还）。
  if (admission) service.useAdmission(admission);
  const materials = options.materialStore ? {
    store: options.materialStore, jobs: new MaterialJobs(options.materialStore, service, admission),
  } : undefined;
  const materialSubsystem = materials ? { ...materials, uploads: new MaterialUploads(materials.store, materials.jobs, admission) } : undefined;
  if (materialSubsystem) {
    await materialSubsystem.uploads.initialize();
    options.configureMaterials?.(materialSubsystem.jobs, materialSubsystem.uploads);
    await materialSubsystem.jobs.resume();
  }
  // 自愈看门狗：启动即做一次恢复扫描（重启/队列卡死留下的非终态任务自动回到队列）。
  await service.initialize();
  const app = express(); app.disable('x-powered-by'); app.locals.mobileRecognitionService = service; app.locals.materials = materialSubsystem;
  app.use((_request, response, next) => { response.setHeader('cache-control', 'private, no-store'); response.setHeader('pragma', 'no-cache'); next(); });

  const proxyTrusted = mode === 'cloud' && options.cloudProxy === true;
  const ipOf = (request: express.Request): string => clientIp(request, proxyTrusted);

  // 云端模式：POST /v1/pairing/redeem 是唯一免鉴权入口（自身限流）。
  if (mode === 'cloud') {
    const pairing = options.pairing!;
    app.post('/v1/pairing/redeem', express.json({ limit: '16kb', strict: true }), async (request, response, next) => {
      try {
        const ip = ipOf(request);
        const body = bodyObject(request.body);
        const payload = body.payload; const clientId = body.clientId; const deviceInfo = body.deviceInfo;
        if (typeof clientId !== 'string' || !UUID.test(clientId)) throw new MobileRequestError(400, 'invalid_request', 'clientId 必须是 UUID。');
        if (deviceInfo !== undefined && (typeof deviceInfo !== 'string' || deviceInfo.length > 200)) throw new MobileRequestError(400, 'invalid_request', 'deviceInfo 不合法。');
        try {
          const result = await pairing.redeem(payload, clientId, typeof deviceInfo === 'string' ? deviceInfo : 'unknown');
          response.json(result);
        } catch (error) {
          if (error instanceof PairingError) {
            // 兑换失败（含过期/已用/非法）计入配对限流；限流先于业务错误返回。
            const gate = limiter.pairingFailure(ip);
            if (!gate.allowed) { response.setHeader('retry-after', String(gate.retryAfterSeconds)); response.status(429).json({ error: { code: 'rate_limited', message: '配对尝试过于频繁，请稍后再试。' } }); return; }
            response.status(pairingErrorStatus(error.code)).json({ error: { code: error.code, message: error.message } });
            return;
          }
          throw error;
        }
      } catch (error) { next(error); }
    });
  }

  // /v1 鉴权：回环共享令牌 或 云端设备令牌（鉴权成功后按设备计数）。T2 起同中间件覆盖 /v2。
  app.use(options.v2Router ? ['/v1', '/v2'] : '/v1', async (request, response, next) => {    try {
      if (mode === 'cloud') {
        const ip = ipOf(request);
        let deviceId: string;
        try { deviceId = (await options.pairing!.authenticate(request.headers.authorization)).deviceId; }
        catch (error) {
          if (error instanceof PairingError) {
            const fail = limiter.authFailure(ip);
            if (!fail.allowed) { response.setHeader('retry-after', String(fail.retryAfterSeconds)); response.status(429).json({ error: { code: 'rate_limited', message: '请求过于频繁，请稍后再试。' } }); return; }
            response.status(401).json({ error: { code: 'unauthorized', message: error.message } }); return;
          }
          throw error;
        }
        const query = limiter.authedQuery(deviceId);
        if (!query.allowed) { response.setHeader('retry-after', String(query.retryAfterSeconds)); response.status(429).json({ error: { code: 'rate_limited', message: '请求过于频繁，请稍后再试。' } }); return; }
        response.locals.deviceId = deviceId;
        next();
        return;
      }
      const header = request.headers.authorization;
      if (!header?.startsWith('Bearer ') || !equalToken(header.slice(7), options.pairingToken!)) {
        response.status(401).json({ error: { code: 'unauthorized', message: '本地配对令牌无效。' } }); return;
      }
      next();
    } catch (error) { next(error); }
  });

  app.get('/v1/health', async (_request, response, next) => {
    try {
      if (!service.isStorageAvailable()) { response.status(503).json({ error: { code: 'storage_unavailable', message: '本地存储暂时不可用，服务已停止接受识别任务。' } }); return; }
      if (mode === 'cloud') {
        const acceptingJobs = service.acceptingJobs() && (!admission || (await admission.accepting()));
        response.json({ version: 1, serviceId: options.pairing!.serviceId, storageAvailable: true, visionConfigured: options.vision.configured !== false, acceptingJobs, protocolVersion: 1 });
        return;
      }
      response.json({ version: 1, realVisionConfigured: options.vision.configured !== false });
    } catch (error) { next(error); }
  });

  // ── POST /v1/recognitions：容量/槽位/磁盘门槛预约先于正文解析（Task 3 原子预约）────
  // 第一段（app.use 过滤器，鉴权之后）：检查幂等重放、磁盘门槛、解析槽位与任务容量；
  // 429/503 短路时 express.raw 尚未开始缓冲，被拒正文不进入内存。预留态挂 response.locals，
  // close 兜底覆盖 413（raw 中间件抛错不进 handler）与客户端中断两条不进 finally 的路径。
  app.use((request, response, next) => {
    if (!admission || request.method !== 'POST' || request.originalUrl.split('?')[0] !== '/v1/recognitions') { next(); return; }
    const reserve = trackUploadAdmission(admission, response);
    void (async (): Promise<void> => {
      const keyHeader = request.headers['idempotency-key'];
      // 满队列时相同幂等键的旧任务仍可查验并按字节恢复：同键跳过容量与磁盘门槛（store 幂等处理），
      // 但正文仍要解析，仍占用解析槽位。
      if (typeof keyHeader === 'string' && UUID.test(keyHeader) && (await service.hasJob(keyHeader))) {
        const replaySlot = admission.tryAcquireUploadSlot('upload');
        if (!replaySlot.accepted) {
          response.setHeader('retry-after', String(replaySlot.retryAfterSeconds));
          response.status(429).json({ error: { code: 'busy', message: '服务器正在处理另一个上传，请稍后重试。' } });
          return;
        }
        reserve.slot = true;
        next();
        return;
      }
      const rejection = await acquireUploadAdmission(admission, reserve);
      if (rejection) {
        if (rejection.retryAfterSeconds !== undefined) response.setHeader('retry-after', String(rejection.retryAfterSeconds));
        response.status(rejection.status).json({ error: { code: rejection.code, message: rejection.message } });
        return;
      }
      // 异步检查期间客户端已消失：立即归还，不进入正文解析。
      if (response.writableEnded || response.destroyed) { releaseUploadAdmission(admission, reserve); return; }
      next();
    })().catch(next);
  });
  app.post('/v1/recognitions', express.raw({ type: 'image/jpeg', limit: '15mb' }), async (request, response, next) => {
    const keyHeader = request.headers['idempotency-key'];
    const reserve = (response.locals.selAdmission as AdmissionReserve | undefined) ?? null;
    try {
      if (!request.is('image/jpeg') || !Buffer.isBuffer(request.body)) throw new MobileRequestError(415, 'unsupported_media_type', '只接受原始 image/jpeg 照片字节。');
      if (typeof keyHeader !== 'string' || !UUID.test(keyHeader)) throw new MobileRequestError(400, 'invalid_idempotency_key', 'Idempotency-Key 必须是 UUID。');
      const submitted = await service.submit({ idempotencyKey: keyHeader, photoName: photoName(request.headers['x-photo-name']), sourceBytes: request.body });
      // 容量移交：新任务受理成功后由 service 在任务终态释放；幂等重放（created=false）无容量可移交。
      if (submitted.created && reserve?.capacity) reserve.handoff = true;
      response.status(202).json({ job: submitted.job });
    } catch (error) { next(error); }
    finally {
      if (reserve && admission) releaseUploadAdmission(admission, reserve);
    }
  });
  app.get('/v1/recognitions', async (_request, response, next) => { try { response.json({ jobs: await service.listJobs() }); } catch (error) { next(error); } });
  app.get('/v1/recognitions/:id', async (request, response, next) => { try { response.json({ job: await service.getJob(id(request.params.id)) }); } catch (error) { next(error); } });
  app.post('/v1/recognitions/:id/retry', express.json({ limit: '16kb', strict: true }), async (request, response, next) => {
    try {
      const body = bodyObject(request.body); if (!(body.questionId === null || (typeof body.questionId === 'string' && UUID.test(body.questionId)))) throw new MobileRequestError(400, 'invalid_request', 'questionId 必须是 UUID 或 null。');
      response.status(202).json({ job: await service.retry(id(request.params.id), body.questionId as string | null) });
    } catch (error) { next(error); }
  });
  app.post('/v1/recognitions/:id/select', express.json({ limit: '16kb', strict: true }), async (request, response, next) => {
    try {
      const body = bodyObject(request.body);
      const ids = body.questionIds;
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 30
        || ids.some(item => typeof item !== 'string' || !UUID.test(item))
        || new Set(ids).size !== ids.length) throw new MobileRequestError(400, 'invalid_request', 'questionIds 须为 1–30 个不重复的题目 ID。');
      response.json({ job: await service.select(id(request.params.id), ids as string[]) });
    } catch (error) { next(error); }
  });
  app.get('/v1/recognitions/:id/questions/:questionId/candidate', async (request, response, next) => {
    try { const bytes = await service.getCandidateCrop(id(request.params.id), id(request.params.questionId)); response.type('image/jpeg').send(bytes); }
    catch (error) { next(error); }
  });
  app.post('/v1/recognitions/:id/questions/:questionId/confirm', express.json({ limit: '16kb', strict: true }), async (request, response, next) => {
    try {
      const body = bodyObject(request.body);
      if (!Number.isSafeInteger(body.revision) || (body.action !== 'confirm' && body.action !== 'skip') || 'evidence' in body) throw new MobileRequestError(400, 'invalid_request', '确认请求不合法。');
      response.json({ job: await service.confirm(id(request.params.id), id(request.params.questionId), { revision: body.revision as number, action: body.action, sourceCompared: body.sourceCompared as boolean | undefined, manualRelease: body.manualRelease as boolean | undefined }) });
    } catch (error) { next(error); }
  });
  app.get('/v1/recognitions/:id/media/:mediaId', async (request, response, next) => {
    try { const bytes = await service.getMedia(id(request.params.id), id(request.params.mediaId)); response.type('image/jpeg').send(bytes); }
    catch (error) { next(error); }
  });
  // T2 单进程装配：/v2 路由挂在 /v1 之后、404 之前。云端公网入口不挂旧的 Web 看板（F1）；
  // 只挂学生网页版 /s/（设备令牌 cookie 鉴权，没有家长 / 管理页面）。
  if (options.v2Router) app.use('/v2', options.v2Router({ limiter: mode === 'cloud' ? limiter : null }));
  if (options.webClient && mode === 'cloud') {
    app.use('/s', options.webClient({ service, materials: materialSubsystem, pairing: options.pairing!, limiter, admission, ipOf }));
  }
  if (options.adminWeb && mode === 'cloud') app.use('/admin', options.adminWeb({ ipOf }));
  // 公开说明页是 GET /help/（GET /help 301 到 /help/）。不看 Host，不占用 /s、/v1、/v2、/admin。
  registerHelpPortal(app);
  app.use((_request, response) => response.status(404).json({ error: { code: 'not_found', message: '接口不存在。' } }));
  const errors: ErrorRequestHandler = (error, request, response, _next) => {
    if (response.headersSent) return;
    if (error instanceof IdempotencyConflictError) { response.status(409).json({ error: { code: 'idempotency_conflict', message: error.message } }); return; }
    if (error instanceof MobileRequestError) { response.status(error.status).json({ error: { code: error.code, message: error.message } }); return; }
    if ((error as { type?: string }).type === 'entity.too.large') {
      // 按入口区分超限文案：照片上传 vs 配对兑换（16kb JSON）。
      const message = request.path === '/v1/pairing/redeem' ? '配对请求超过16 KB限制。'
        : request.path === '/v2/reflections/transcribe' ? '录音超过 5 MB 限制。' : '照片超过15 MB上传限制。';
      response.status(413).json({ error: { code: 'payload_too_large', message } });
      return;
    }
    if (error instanceof SyntaxError) { response.status(400).json({ error: { code: 'invalid_json', message: '请求 JSON 无法解析。' } }); return; }
    // 学生空间 worker 收到的是父进程网关交来的请求 ID（内部头；外来值只按形状校验、只用于日志）。
    const requestId = requestIdOf(request.headers['x-sel-internal-request-id']) ?? '-';
    logEvent('sel_request_failed', 'error', { rid: requestId, method: request.method, route: request.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ':id').slice(0, 80), status: 500, ...errorSummary(error) });
    response.setHeader('x-sel-error-code', 'internal');
    response.status(500).json({ error: { code: 'internal', message: '本地服务暂时无法完成请求。', ...(requestId !== '-' ? { requestId } : {}) } });
  };
  app.use(errors);
  return app;
}
