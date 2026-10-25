import { AiError } from './errors.js';
import type { Stage } from './evidence.js';
import sharp from 'sharp';
import crypto from 'node:crypto';
import { recordAiUsage, tokenCount } from '../observability/aiUsage.js';
import { withProcessImage } from '../mobile/admission.js';
import { PreemptedError, withParentPermit } from '../studentHost/parentPermit.js';
import { FALLBACK_BLOCKED_MESSAGE, withFallbackBudget } from './fallbackBudget.js';

export type ModelStage = Stage | 'crop_inventory' | 'crop_verify' | 'mobile_inventory' | 'mobile_transcribe' | 'mobile_verify' | 'mobile_ground' | 'material_extract' | 'material_verify' | 'material_answer' | 'material_grade' | 'explain' | 'answer_read';
export interface StageRun { stage: ModelStage; model: string; durationMs: number; promptTokens: number | null; completionTokens: number | null; maxTokens: number; thinking: false; promptVersion: string }
export interface StageResult<T> { value: T; run: StageRun }
export interface ChatTrace {
  usageId?: string;
  startedAt?: string;
  durationMs?: number;
  stage: ModelStage;
  model: string;
  request: Record<string, unknown>;
  responseRaw: string | null;
  httpStatus: number | null;
  usage: { prompt_tokens: number | null; completion_tokens: number | null };
  error: { kind: string; message: string } | null;
}
/** background：后台任务（详情页解答的预生成），向父进程借名额时排在前台请求之后。 */
export interface ChatOptions { baseUrl: string; apiKey: string; models: Record<string, string>; timeoutMs: number; bailianOnly: boolean; maxTokens?: number; trace?: (trace: ChatTrace) => void | Promise<void>; signal?: AbortSignal; beforeRequest?: () => Promise<void>; background?: boolean }
export interface Message { role: 'system' | 'user'; content: unknown }
export const PROMPT_VERSION = 'evidence-v1-20260907';
export const MAX_INPUT_TOKEN_RESERVATION = 100_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const TOKEN_PLAN_ENDPOINT = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
/** Only transport/provider failures may use the backup, never local validation or budgets. */
class FailoverError extends AiError { httpStatus: number | null = null }

async function readResponse(response: Response): Promise<{ raw: string; overflow: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { raw: '', overflow: false };
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const chunk = await reader.read(); if (chunk.done) break;
    const remaining = MAX_RESPONSE_BYTES - size;
    if (chunk.value.byteLength > remaining) {
      if (remaining > 0) chunks.push(chunk.value.slice(0, remaining));
      await reader.cancel();
      return { raw: Buffer.concat(chunks).toString('utf8'), overflow: true };
    }
    chunks.push(chunk.value); size += chunk.value.byteLength;
  }
  return { raw: Buffer.concat(chunks).toString('utf8'), overflow: false };
}

function traceMessages(messages: Message[]): unknown[] {
  return messages.map(message => ({ role: message.role, content: Array.isArray(message.content)
    ? message.content.map(part => {
      if (part?.type !== 'image_url') return part;
      const url = part.image_url?.url;
      if (typeof url !== 'string') return { type: 'image_url', image: { invalid: true } };
      const comma = url.indexOf(',');
      const bytes = comma >= 0 ? Buffer.from(url.slice(comma + 1), 'base64') : Buffer.alloc(0);
      return { type: 'image_url', image: { mime: url.slice(5, url.indexOf(';')), bytes: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'), detail: part.image_url?.detail ?? null } };
    }) : message.content }));
}

/** Deliberately over-reserve UTF-8 bytes and 16x16 image patches; not a billing tokenizer. */
async function checkInput(messages: Message[]): Promise<void> {
  let reserved = 1024;
  for (const message of messages) {
    reserved += 32;
    if (typeof message.content === 'string') reserved += Buffer.byteLength(message.content);
    else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type === 'text' && typeof part.text === 'string') reserved += Buffer.byteLength(part.text);
        else if (part?.type === 'image_url') {
          const url = part.image_url?.url;
          if (typeof url !== 'string' || url.length > 21_000_000 || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(url)) throw new AiError('unsupported', '模型图片必须为有大小限制的本地图片');
          const bytes = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
          try {
            const meta = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
            if (!meta.width || !meta.height || !['jpeg', 'png', 'webp'].includes(meta.format ?? '')) throw new Error();
            reserved += Math.ceil(meta.width / 16) * Math.ceil(meta.height / 16) + 1024;
          } catch { throw new AiError('unsupported', '模型图片无法读取或像素过大'); }
        } else throw new AiError('unsupported', '不支持的模型输入类型');
      }
    } else throw new AiError('unsupported', '不支持的模型输入类型');
    if (reserved > MAX_INPUT_TOKEN_RESERVATION) throw new AiError('unsupported', '模型输入超出保守预算，请缩小图片或拆分证据');
  }
}

export function assertEndpoint(baseUrl: string, bailianOnly: boolean): void {
  let u: URL; try { u = new URL(baseUrl); } catch { throw new AiError('unsupported', '请配置有效 SEL_AI_BASE_URL'); }
  if (u.username || u.password || u.search || u.hash) throw new AiError('unsupported', '模型地址不得含凭据或查询参数');
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local && !bailianOnly)) throw new AiError('unsupported', '模型接口必须使用 HTTPS');
  const official = ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com', 'cn-hongkong.dashscope.aliyuncs.com'].includes(u.hostname)
    || /^[a-z0-9-]+\.(cn-beijing|ap-southeast-1|cn-hongkong|us-east-1|eu-central-1|ap-northeast-1)\.maas\.aliyuncs\.com$/.test(u.hostname);
  if (bailianOnly && (!official || !u.pathname.endsWith('/compatible-mode/v1'))) throw new AiError('unsupported', '百炼模式只允许其官方按量付费接口');
}

function containsImage(messages: Message[]): boolean {
  return messages.some(message => Array.isArray(message.content) && message.content.some(part => part?.type === 'image_url'));
}

export class ChatClient {
  constructor(readonly options: ChatOptions) {}
  async call(stage: ModelStage, messages: Message[], beforeRequest?: () => Promise<void>): Promise<StageResult<unknown>> {
    const base = beforeRequest ? { ...this.options, beforeRequest: async () => { await beforeRequest(); await this.options.beforeRequest?.(); } } : this.options;
    // 后台任务的模型名额可以被前台请求要走：父进程一说就中止这次调用（抛 PreemptedError），由调用方稍后重排。
    const preempt = base.background ? new AbortController() : null;
    const o: ChatOptions = preempt ? { ...base, signal: base.signal ? AbortSignal.any([base.signal, preempt.signal]) : preempt.signal } : base;
    const model = o.models[stage];
    if (!o.apiKey.trim() || !model?.trim()) throw new AiError('unsupported', '真实 AI 配置缺失，请在本机配置密钥和阶段模型；不会降级为 Mock');
    assertEndpoint(o.baseUrl, o.bailianOnly);
    const vision = containsImage(messages);
    // 带图的调用才占全局名额：先串行解码校验，再占视觉名额发请求。纯文本追问不排队。
    if (vision) await withProcessImage(() => checkInput(messages), { background: o.background });
    else await checkInput(messages);
    const run = async (): Promise<StageResult<unknown>> => {
      const key = process.env.SEL_TOKEN_PLAN_API_KEY?.trim();
      // Explicit opt-in for the Beijing Bailian deployment. ASR has its own client
      // and continues to use the original native DashScope key.
      if (!key || !o.bailianOnly || o.baseUrl.replace(/\/$/, '') !== 'https://dashscope.aliyuncs.com/compatible-mode/v1') {
        return this.complete(stage, messages, o);
      }
      try { return await this.complete(stage, messages, { ...o, baseUrl: TOKEN_PLAN_ENDPOINT, apiKey: key }); }
      catch (error) {
        o.signal?.throwIfAborted();
        if (!(error instanceof FailoverError)) throw error;
        // 备用是按量付费：每日上限（跨进程计数）到了就停，并给出说清楚的提示；绝不降级为 Mock。
        return withFallbackBudget({ operation: stage, primaryError: error.kind, primaryHttpStatus: error.httpStatus },
          () => this.complete(stage, messages, o),
          blocked => blocked.reason === 'config'
            ? new AiError('unsupported', '备用 AI 通道的每日上限配置无效（SEL_AI_FALLBACK_DAILY_CALLS / SEL_AI_FALLBACK_DAILY_TOKENS 必须是非负整数）')
            : new AiError('rate_limited', FALLBACK_BLOCKED_MESSAGE),
          result => (result.run.promptTokens ?? 0) + (result.run.completionTokens ?? 0) || null);
      }
    };
    return vision ? withParentPermit('ai', run, { background: o.background, onPreempt: preempt ? () => preempt.abort(new PreemptedError()) : undefined }) : run();
  }

  private async complete(stage: ModelStage, messages: Message[], o: ChatOptions): Promise<StageResult<unknown>> {
    const model = o.models[stage]!;
    const maxTokens = o.maxTokens ?? 8192;
    if (!Number.isInteger(maxTokens) || maxTokens < 128 || maxTokens > 16384 || !Number.isFinite(o.timeoutMs) || o.timeoutMs < 1) throw new AiError('unsupported', '模型 token/超时限制无效');
    const request = { model, messages: traceMessages(messages), temperature: 0, max_tokens: maxTokens,
      response_format: { type: 'json_object' }, ...(o.bailianOnly || model.startsWith('qwen') ? { enable_thinking: false } : {}) };
    // Reservation errors must never be classified as provider failures.
    o.signal?.throwIfAborted();
    await o.beforeRequest?.();
    o.signal?.throwIfAborted();
    const started = Date.now(); const usageId = crypto.randomUUID(); const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), o.timeoutMs);
    let raw: string | null = null; let httpStatus: number | null = null;
    let usage = { prompt_tokens: null as number | null, completion_tokens: null as number | null };
    let reportedError: { kind: string; message: string } | null = null;
    try {
      const res = await fetch(`${o.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', redirect: 'error', signal: o.signal ? AbortSignal.any([controller.signal, o.signal]) : controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${o.apiKey}` },
        body: JSON.stringify({ model, messages, temperature: 0, max_tokens: maxTokens,
          response_format: { type: 'json_object' }, ...(o.bailianOnly || model.startsWith('qwen') ? { enable_thinking: false } : {}) }),
      });
      httpStatus = res.status;
      const received = await readResponse(res); raw = received.raw;
      if (received.overflow) throw new AiError('invalid_json', '模型响应过大');
      // A failed HTTP call may still carry billable usage; retain it before classifying status.
      let body: { choices?: Array<{ finish_reason?: string; message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } } | null = null;
      try { body = JSON.parse(raw); } catch { /* classified after HTTP status */ }
      usage = { prompt_tokens: tokenCount(body?.usage?.prompt_tokens), completion_tokens: tokenCount(body?.usage?.completion_tokens) };
      if (res.status === 429) throw new FailoverError('rate_limited', '模型服务限流');
      if (!res.ok) {
        if (res.status === 401) throw new FailoverError('unsupported', '模型认证失败');
        if (res.status === 403) throw new FailoverError('unsupported', '模型权限不足');
        if (res.status === 404) throw new FailoverError('unsupported', '模型不存在或无权限');
        if (res.status >= 500 || res.status === 408) throw new FailoverError('provider_error', `模型服务暂时不可用 HTTP ${res.status}`);
        throw new AiError('unsupported', `模型请求不受支持 HTTP ${res.status}`);
      }
      if (!raw) throw new AiError('invalid_json', '模型响应为空');
      if (!body || typeof body !== 'object') throw new AiError('invalid_json', '模型响应不是 JSON 对象');
      const choice = body.choices?.[0];
      if (choice?.finish_reason !== 'stop' || typeof choice.message?.content !== 'string') throw new AiError('invalid_json', '模型输出被截断、拒绝或缺少正文');
      let value: unknown; try { value = JSON.parse(choice.message.content); } catch { throw new AiError('invalid_json', '模型正文不符合 JSON 契约'); }
      return { value, run: { stage, model, durationMs: Date.now() - started, promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, maxTokens, thinking: false, promptVersion: PROMPT_VERSION } };
    } catch (e) {
      if (o.signal?.aborted) { reportedError = { kind: 'cancelled', message: '调用已取消' }; throw o.signal.reason; }
      if (e instanceof FailoverError) e.httpStatus = httpStatus;
      if (e instanceof AiError) { reportedError = { kind: e.kind, message: e.message }; throw e; }
      // Provider exceptions may contain echoed user material/credentials. Never propagate them.
      const safe = new FailoverError(controller.signal.aborted ? 'timeout' : 'provider_error', controller.signal.aborted ? '模型调用超时' : '模型连接失败');
      reportedError = { kind: safe.kind, message: safe.message }; throw safe;
    } finally {
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      const startedAt = new Date(started).toISOString();
      recordAiUsage({ id: usageId, startedAt, durationMs, operation: stage, model,
        provider: o.baseUrl === TOKEN_PLAN_ENDPOINT ? 'bailian-token-plan' : o.bailianOnly ? 'bailian' : 'openai-compatible', source: 'live',
        status: reportedError ? 'failed' : 'succeeded', inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens,
        httpStatus, errorCode: reportedError?.kind ?? null });
      let safeRaw = raw;
      for (const key of [o.apiKey, this.options.apiKey, process.env.SEL_TOKEN_PLAN_API_KEY]) {
        if (key && safeRaw !== null) safeRaw = safeRaw.split(key).join('[REDACTED]');
      }
      await o.trace?.({ usageId, startedAt, durationMs, stage, model, request, responseRaw: safeRaw, httpStatus, usage, error: reportedError });
    }
  }
}
