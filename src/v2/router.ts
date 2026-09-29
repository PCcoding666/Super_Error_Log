import fs from 'node:fs';
import path from 'node:path';
import express, { Router } from 'express';
import { getDb } from '../db/connection.js';
import { registerV2Photo } from '../bridge/recognitionToItems.js';
import { getQuestionCrop } from '../services/evidenceService.js';
import { audit } from '../services/eventLog.js';
import { discardV2Item, getWeek, isV2Item, restoreV2Item } from './weekService.js';
import { getV2Settings, updateV2Settings } from './settingsService.js';

export const V2_PROTOCOL_VERSION = 2 as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface V2RouterOptions {
  /** 移动识别数据目录（jobs/<jobId>/job.json 所在）；register 与 week 的懒桥接需要。 */
  mobileDataDir?: string;
}

/**
 * /v2 手机接口路由（v2.0 T2 起装配；T4a 增加本周错题卡片、删/恢复、学生设置）。
 * 鉴权由挂载方统一施加（与 /v1 同一中间件：云端设备令牌 / 回环共享令牌），本路由器不再鉴权。
 */
export function createV2Router(options: V2RouterOptions = {}): Router {
  const r = Router();
  const notFound = (response: express.Response, message: string): void => {
    response.status(404).json({ error: { code: 'not_found', message } });
  };
  const mobileDataDir = (): string => {
    if (!options.mobileDataDir) throw new Error('createV2Router 需要 mobileDataDir 才能服务该接口');
    return options.mobileDataDir;
  };

  r.get('/health', (_request, response) => {
    response.json({ protocolVersion: V2_PROTOCOL_VERSION });
  });

  // 登记自己上传的照片：任务必须存在于移动数据目录；幂等，重复登记返回相同结果。
  r.post('/photos/:jobId/register', (request, response) => {
    const jobId = String(request.params.jobId);
    if (!UUID.test(jobId)) { notFound(response, '识别任务不存在。'); return; }
    if (!fs.existsSync(path.join(mobileDataDir(), 'jobs', jobId, 'job.json'))) {
      notFound(response, '识别任务不存在。');
      return;
    }
    registerV2Photo(jobId);
    audit('v2_photo_registered', 'v2_photo', jobId);
    const row = getDb().prepare('SELECT registered_at FROM v2_photo WHERE job_id = ?').get(jobId) as { registered_at: string };
    response.json({ jobId, registeredAt: row.registered_at });
  });

  r.get('/week', (_request, response) => {
    response.json(getWeek(mobileDataDir()));
  });

  // 整题裁图：仅限 v2 来源的题。
  r.get('/items/:id/crop', async (request, response, next) => {
    try {
      const itemId = String(request.params.id);
      if (!isV2Item(itemId)) { notFound(response, '题目不存在或不属于手机上传。'); return; }
      try {
        const crop = await getQuestionCrop(itemId);
        response.type('image/jpeg').set('Cache-Control', 'private, no-store').send(crop);
      } catch {
        notFound(response, '整题裁图无法读取。');
      }
    } catch (error) { next(error); }
  });

  r.post('/items/:id/discard', (request, response) => {
    const result = discardV2Item(String(request.params.id));
    if (!result.ok) { response.status(result.httpStatus).json({ error: { code: result.httpStatus === 404 ? 'not_found' : 'conflict', message: result.message } }); return; }
    response.json({ id: String(request.params.id), status: result.status });
  });

  r.post('/items/:id/restore', (request, response) => {
    const result = restoreV2Item(String(request.params.id));
    if (!result.ok) { response.status(result.httpStatus).json({ error: { code: result.httpStatus === 404 ? 'not_found' : 'conflict', message: result.message } }); return; }
    response.json({ id: String(request.params.id), status: result.status });
  });

  r.get('/settings', (_request, response) => {
    response.json(getV2Settings());
  });

  r.put('/settings', express.json({ limit: '16kb', strict: true }), (request, response) => {
    const result = updateV2Settings(request.body);
    if (!result.ok) { response.status(400).json({ error: { code: 'invalid_request', message: result.message } }); return; }
    response.json(result.settings);
  });

  return r;
}
