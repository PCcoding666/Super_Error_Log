import crypto from 'node:crypto';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import { MobileRecognitionService, MobileRequestError } from './service.js';
import { IdempotencyConflictError, MobileRecognitionStore } from './store.js';
import type { MobileVisionBoundary } from './vision.js';

export interface CreateMobileAppOptions { dataDir: string; pairingToken: string; vision: MobileVisionBoundary }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function equalToken(actual: string, expected: string): boolean {
  const left = Buffer.from(actual); const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function authentication(token: string): RequestHandler {
  return (request, response, next) => {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ') || !equalToken(header.slice(7), token)) {
      response.status(401).json({ error: { code: 'unauthorized', message: '本地配对令牌无效。' } }); return;
    }
    next();
  };
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

export async function createMobileApp(options: CreateMobileAppOptions): Promise<express.Express> {
  if (!options.pairingToken || options.pairingToken.length < 16) throw new Error('移动端配对令牌至少需要16个字符');
  const store = await MobileRecognitionStore.open(options.dataDir);
  const service = new MobileRecognitionService(store, options.vision);
  const app = express(); app.disable('x-powered-by'); app.locals.mobileRecognitionService = service;
  app.use((_request, response, next) => { response.setHeader('cache-control', 'private, no-store'); response.setHeader('pragma', 'no-cache'); next(); });
  app.use('/v1', authentication(options.pairingToken));
  app.get('/v1/health', (_request, response) => {
    if (!service.isStorageAvailable()) { response.status(503).json({ error: { code: 'storage_unavailable', message: '本地存储暂时不可用，服务已停止接受识别任务。' } }); return; }
    response.json({ version: 1, realVisionConfigured: options.vision.configured !== false });
  });
  app.post('/v1/recognitions', express.raw({ type: 'image/jpeg', limit: '15mb' }), async (request, response, next) => {
    try {
      if (!request.is('image/jpeg') || !Buffer.isBuffer(request.body)) throw new MobileRequestError(415, 'unsupported_media_type', '只接受原始 image/jpeg 照片字节。');
      const key = request.headers['idempotency-key'];
      if (typeof key !== 'string' || !UUID.test(key)) throw new MobileRequestError(400, 'invalid_idempotency_key', 'Idempotency-Key 必须是 UUID。');
      const job = await service.submit({ idempotencyKey: key, photoName: photoName(request.headers['x-photo-name']), sourceBytes: request.body });
      response.status(202).json({ job });
    } catch (error) { next(error); }
  });
  app.get('/v1/recognitions', async (_request, response, next) => { try { response.json({ jobs: await service.listJobs() }); } catch (error) { next(error); } });
  app.get('/v1/recognitions/:id', async (request, response, next) => { try { response.json({ job: await service.getJob(id(request.params.id)) }); } catch (error) { next(error); } });
  app.post('/v1/recognitions/:id/retry', express.json({ limit: '16kb', strict: true }), async (request, response, next) => {
    try {
      const body = bodyObject(request.body); if (!(body.questionId === null || (typeof body.questionId === 'string' && UUID.test(body.questionId)))) throw new MobileRequestError(400, 'invalid_request', 'questionId 必须是 UUID 或 null。');
      response.status(202).json({ job: await service.retry(id(request.params.id), body.questionId as string | null) });
    } catch (error) { next(error); }
  });
  app.post('/v1/recognitions/:id/questions/:questionId/confirm', express.json({ limit: '16kb', strict: true }), async (request, response, next) => {
    try {
      const body = bodyObject(request.body);
      if (!Number.isSafeInteger(body.revision) || (body.action !== 'confirm' && body.action !== 'skip') || 'evidence' in body) throw new MobileRequestError(400, 'invalid_request', '确认请求不合法。');
      response.json({ job: await service.confirm(id(request.params.id), id(request.params.questionId), { revision: body.revision as number, action: body.action, sourceCompared: body.sourceCompared as boolean | undefined }) });
    } catch (error) { next(error); }
  });
  app.get('/v1/recognitions/:id/media/:mediaId', async (request, response, next) => {
    try { const bytes = await service.getMedia(id(request.params.id), id(request.params.mediaId)); response.type('image/jpeg').send(bytes); }
    catch (error) { next(error); }
  });
  app.use((_request, response) => response.status(404).json({ error: { code: 'not_found', message: '接口不存在。' } }));
  const errors: ErrorRequestHandler = (error, _request, response, _next) => {
    if (response.headersSent) return;
    if (error instanceof IdempotencyConflictError) { response.status(409).json({ error: { code: 'idempotency_conflict', message: error.message } }); return; }
    if (error instanceof MobileRequestError) { response.status(error.status).json({ error: { code: error.code, message: error.message } }); return; }
    if ((error as { type?: string }).type === 'entity.too.large') { response.status(413).json({ error: { code: 'payload_too_large', message: '照片超过15 MB上传限制。' } }); return; }
    if (error instanceof SyntaxError) { response.status(400).json({ error: { code: 'invalid_json', message: '请求 JSON 无法解析。' } }); return; }
    response.status(500).json({ error: { code: 'internal', message: '本地服务暂时无法完成请求。' } });
  };
  app.use(errors);
  return app;
}
