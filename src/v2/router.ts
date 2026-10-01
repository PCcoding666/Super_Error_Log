import fs from 'node:fs';
import path from 'node:path';
import express, { Router } from 'express';
import { getDb } from '../db/connection.js';
import { registerV2Photo } from '../bridge/recognitionToItems.js';
import { getQuestionCrop } from '../services/evidenceService.js';
import { audit } from '../services/eventLog.js';
import { discardV2Item, getWeek, isV2Item, restoreV2Item } from './weekService.js';
import { getV2Settings, updateV2Settings } from './settingsService.js';
import { createPractice, getPractice, listPractices, recommendPractice } from './practiceService.js';
import { getReturnSummary, submitReturns } from './returnService.js';
import { answerFollowup, askFollowup, getV2Reflection, submitV2Reflection } from './reflectionService.js';
import { acceptCorrection, directCorrection, getCorrectionsReport, getEvidenceView, proposeCorrection } from './correctionService.js';
import type { FollowupProvider, CorrectionProvider } from '../ai/provider.js';

export const V2_PROTOCOL_VERSION = 2 as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface V2RouterOptions {
  /** 移动识别数据目录（jobs/<jobId>/job.json 所在）；register 与 week 的懒桥接需要。 */
  mobileDataDir?: string;
  /** T4c 追问/归纳模型能力；缺省走全局 getFollowupProvider()（mock 模式为确定性实现）。 */
  followupProvider?: FollowupProvider;
  /** T4e 修订建议模型能力；缺省走全局 getCorrectionProvider()（mock 模式为确定性实现）。 */
  correctionProvider?: CorrectionProvider;
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

  // T4b：本周推荐与建练习。/practice/recommend 必须先于 /practice/:id 注册。
  r.get('/practice/recommend', (_request, response) => {
    response.json(recommendPractice(mobileDataDir()));
  });

  r.post('/practice', express.json({ limit: '16kb', strict: true }), (request, response) => {
    const result = createPractice(request.body);
    if (!result.ok) {
      response.status(result.httpStatus).json({ error: { code: result.httpStatus === 400 ? 'invalid_request' : 'conflict', message: result.message } });
      return;
    }
    response.json(result.detail);
  });

  r.get('/practice', (_request, response) => {
    response.json({ packets: listPractices() });
  });

  r.get('/practice/:id', (request, response) => {
    const detail = getPractice(String(request.params.id));
    if (!detail) { notFound(response, '练习不存在。'); return; }
    response.json(detail);
  });

  // T4d：回传（形状错 400、规则错逐条 ok:false）与回报。仅限 v2 练习包。
  r.post('/practice/:id/return', express.json({ limit: '16kb', strict: true }), (request, response) => {
    const result = submitReturns(String(request.params.id), request.body);
    if (!result.ok) {
      const code = result.httpStatus === 404 ? 'not_found' : 'invalid_request';
      response.status(result.httpStatus).json({ error: { code, message: result.message } });
      return;
    }
    response.json({ results: result.results });
  });

  r.get('/practice/:id/summary', (request, response) => {
    const summary = getReturnSummary(String(request.params.id));
    if (!summary) { notFound(response, '练习不存在。'); return; }
    response.json(summary);
  });

  // T4c：AI 追问与复盘。仅限 v2 来源的题；Web 的 submitReflection 路径不变。
  r.post('/items/:id/reflection/ask', async (request, response, next) => {
    try {
      const result = await askFollowup(String(request.params.id), options.followupProvider);
      if (!result.ok) { response.status(result.httpStatus).json({ error: { code: result.httpStatus === 404 ? 'not_found' : 'conflict', message: result.message } }); return; }
      response.json({ turn: result.turn, question: result.question, source: result.source });
    } catch (error) { next(error); }
  });

  r.post('/items/:id/reflection/answer', express.json({ limit: '16kb', strict: true }), async (request, response, next) => {
    try {
      const result = await answerFollowup(String(request.params.id), request.body, options.followupProvider);
      if (!result.ok) {
        const code = result.httpStatus === 400 ? 'invalid_request' : result.httpStatus === 404 ? 'not_found' : 'conflict';
        response.status(result.httpStatus).json({ error: { code, message: result.message } });
        return;
      }
      response.json({ turn: result.turn, summary: result.summary, suggestedCause: result.suggestedCause, suggestedAttemptState: result.suggestedAttemptState, secondQuestion: result.secondQuestion });
    } catch (error) { next(error); }
  });

  r.post('/items/:id/reflection', express.json({ limit: '16kb', strict: true }), (request, response) => {
    const result = submitV2Reflection(String(request.params.id), request.body);
    if (!result.ok) {
      response.status(result.httpStatus).json({ error: { code: result.httpStatus === 400 ? 'invalid_request' : 'not_found', message: result.message } });
      return;
    }
    response.json({ ...result.reflection, status: result.status });
  });

  r.get('/items/:id/reflection', (request, response) => {
    const detail = getV2Reflection(String(request.params.id));
    if (!detail) { notFound(response, '题目不存在或不属于手机上传。'); return; }
    response.json(detail);
  });

  // T4e：修改识别结果与修改记录。仅限 v2 来源的题；不走 Web 的 saveEvidence。
  r.get('/items/:id/evidence', (request, response) => {
    const view = getEvidenceView(String(request.params.id));
    if (!view) { notFound(response, '题目不存在或不属于手机上传。'); return; }
    response.json(view);
  });

  const CORRECT_ERROR_CODE: Record<number, string> = {
    400: 'invalid_request', 404: 'not_found', 409: 'conflict', 429: 'rate_limited', 502: 'bad_gateway',
  };
  const sendCorrectError = (response: express.Response, result: { httpStatus: number; message: string; revision?: number }): void => {
    response.status(result.httpStatus).json({
      error: { code: CORRECT_ERROR_CODE[result.httpStatus] ?? 'error', message: result.message },
      ...(result.revision !== undefined ? { revision: result.revision } : {}),
    });
  };

  r.post('/items/:id/correct', express.json({ limit: '16kb', strict: true }), async (request, response, next) => {
    try {
      const result = await proposeCorrection(String(request.params.id), request.body, options.correctionProvider);
      if (!result.ok) { sendCorrectError(response, result); return; }
      response.json({ proposalId: result.proposalId, revision: result.revision, changes: result.changes, clarify: result.clarify });
    } catch (error) { next(error); }
  });

  r.post('/items/:id/correct/accept', express.json({ limit: '16kb', strict: true }), (request, response) => {
    const result = acceptCorrection(String(request.params.id), request.body);
    if (!result.ok) { sendCorrectError(response, result); return; }
    response.json({ revision: result.revision, card: result.card });
  });

  r.post('/items/:id/correct/direct', express.json({ limit: '16kb', strict: true }), (request, response) => {
    const result = directCorrection(String(request.params.id), request.body);
    if (!result.ok) { sendCorrectError(response, result); return; }
    response.json({ revision: result.revision, card: result.card });
  });

  // 修正即测量报告：只输出计数，不含题目文字。
  r.get('/corrections/report', (_request, response) => {
    response.json(getCorrectionsReport());
  });

  return r;
}
