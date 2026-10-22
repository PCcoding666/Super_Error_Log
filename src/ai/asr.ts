import { config } from '../config.js';
import crypto from 'node:crypto';
import { recordAiUsage, tokenCount } from '../observability/aiUsage.js';
import { FALLBACK_BLOCKED_MESSAGE, withFallbackBudget } from './fallbackBudget.js';

/**
 * 「说说为什么错」的语音转文字（学生网页版用；iOS App 在手机上本地转写，不走这里）。
 * - mock 模式（默认、测试）：固定返回一句合成的转写，不发任何网络请求。
 * - bailian 模式：配置 Token Plan key 时优先其原生接口的 qwen-audio-3.0-asr-flash；
 *   未配置或主用服务失败时使用原 DashScope 原生接口（默认 qwen-audio-3.1-asr-flash），
 *   音频以 Base64 Data URL 放在请求体里，只在内存里经过一次，**服务器不落盘、不记日志**。
 * - 其他模式或缺配置：fail-hard（启动守卫 + 取用时再查一次），绝不悄悄退回 mock。
 */

export const ASR_DEFAULT_MODEL = 'qwen-audio-3.1-asr-flash';
/** SEL_AI_BASE_URL 必须等于它（北京地域；文本模型仍走这个兼容接口）。 */
export const ASR_BAILIAN_ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
/** 语音转写实际调用的原生接口：固定常量（北京地域），不做成环境变量。 */
export const ASR_NATIVE_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
export const ASR_TOKEN_PLAN_ENDPOINT = 'https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
export const ASR_TOKEN_PLAN_MODEL = 'qwen-audio-3.0-asr-flash';
/** mock 模式固定转写（合成句子，不含任何真实学生内容）。 */
export const MOCK_TRANSCRIPT = '我以为移项不用变号，就直接抄过去了。';

export interface SpeechTranscriber {
  readonly source: 'mock' | 'bailian';
  /** audio：完整录音字节；mimeType：去掉参数后的媒体类型（audio/mp4、audio/webm …）。 */
  transcribe(audio: Buffer, mimeType: string, signal?: AbortSignal): Promise<string>;
}

export class TranscribeError extends Error {
  constructor(public readonly kind: 'timeout' | 'provider_error' | 'invalid_output', message: string, readonly fallbackEligible = false) {
    super(message);
    this.name = 'TranscribeError';
  }
}

export class MockTranscriber implements SpeechTranscriber {
  readonly source = 'mock' as const;
  async transcribe(audio: Buffer): Promise<string> {
    if (audio.length === 0) return '';
    return MOCK_TRANSCRIPT;
  }
}

export interface BailianTranscriberOptions {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  /** 固定 Token Plan 原生接口；不接受任意地址。 */
  tokenPlan?: boolean;
  /** 测试注入；缺省用全局 fetch。 */
  fetchImpl?: typeof fetch;
}

/** 浏览器录音 MIME → 原生接口 `parameters.format`（已核实 m4a/aac/webm 都能识别）；iOS Safari 产出 audio/mp4（AAC）。 */
const FORMAT_BY_MIME: Readonly<Record<string, string>> = {
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/webm': 'webm',
};
/** m4a 的几种别名统一成 audio/mp4 放进 Data URL（与已核实的请求一致）。 */
const DATA_URL_MIME: Readonly<Record<string, string>> = { 'audio/x-m4a': 'audio/mp4', 'audio/m4a': 'audio/mp4' };

function normalizeMime(mimeType: string): string {
  return mimeType.split(';')[0]!.trim().toLowerCase();
}
function canUseBackup(status: number): boolean {
  return [401, 403, 404, 408, 429].includes(status) || status >= 500;
}

/** 从原生接口响应里取转写文字：优先 output.text，其次 output.sentence.text（对象或数组）；都没有返回 null。 */
function extractText(body: unknown): string | null {
  const output = (body as { output?: { text?: unknown; sentence?: unknown } } | null | undefined)?.output;
  if (!output || typeof output !== 'object') return null;
  if (typeof output.text === 'string') return output.text.trim();
  const sentences = Array.isArray(output.sentence) ? output.sentence : [output.sentence];
  const parts = sentences.map(item => (item && typeof item === 'object' ? (item as { text?: unknown }).text : undefined));
  if (parts.length > 0 && parts.every(part => typeof part === 'string')) return (parts as string[]).join('').trim();
  return null;
}

export class BailianTranscriber implements SpeechTranscriber {
  readonly source = 'bailian' as const;
  constructor(private readonly options: BailianTranscriberOptions) {}

  /**
   * 请求体（可单测；不含密钥）。不带 sample_rate：2026-10-11 用真实调用核实，省略后 16 k/44.1 k/48 k 的
   * AAC 与 48 k Opus-WebM 都能正确转写，浏览器录音的真实采样率因此不用我们去猜。
   */
  requestBody(audio: Buffer, mimeType: string): Record<string, unknown> {
    const mime = normalizeMime(mimeType);
    const format = FORMAT_BY_MIME[mime];
    if (!format) throw new TranscribeError('provider_error', `语音转写不支持这种录音格式：${mime || '空'}。`);
    return {
      model: this.options.model,
      input: { messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:${DATA_URL_MIME[mime] ?? mime};base64,${audio.toString('base64')}` } }] }] },
      parameters: { format },
    };
  }

  async transcribe(audio: Buffer, mimeType: string, signal?: AbortSignal): Promise<string> {
    return (await this.transcribeWithUsage(audio, mimeType, signal)).text;
  }

  /** 同 transcribe，另外带回这次调用计入每日备用上限的 token 数（供应商报告的，或按音频大小的保守估计）。 */
  async transcribeWithUsage(audio: Buffer, mimeType: string, signal?: AbortSignal): Promise<{ text: string; tokens: number }> {
    const requestBody = JSON.stringify(this.requestBody(audio, mimeType));
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 30_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    combined.throwIfAborted();
    const started = Date.now();
    let httpStatus: number | null = null;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let errorCode: string | null = null;
    try {
      const response = await (this.options.fetchImpl ?? fetch)(this.options.tokenPlan ? ASR_TOKEN_PLAN_ENDPOINT : ASR_NATIVE_ENDPOINT, {
        method: 'POST',
        redirect: 'error',
        headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json' },
        body: requestBody,
        signal: combined,
      });
      httpStatus = response.status;
      let body: unknown;
      try { body = await response.json(); } catch {
        if (timeout.aborted || signal?.aborted) throw new Error('aborted');
        if (!response.ok) throw new TranscribeError('provider_error', `语音转写服务返回 HTTP ${response.status}。`, canUseBackup(response.status));
        throw new TranscribeError('invalid_output', '语音转写结果无法解析。');
      }
      const usage = (body as { usage?: { input_tokens?: unknown; output_tokens?: unknown; duration?: unknown } } | null)?.usage;
      const seconds = typeof usage?.duration === 'number' && Number.isFinite(usage.duration) && usage.duration > 0 ? usage.duration : null;
      inputTokens = tokenCount(usage?.input_tokens); outputTokens = tokenCount(usage?.output_tokens);
      if (!response.ok) throw new TranscribeError('provider_error', `语音转写服务返回 HTTP ${response.status}。`, canUseBackup(response.status));
      const text = extractText(body);
      if (text === null) throw new TranscribeError('invalid_output', '语音转写结果里没有文字。');
      const reported = (inputTokens ?? 0) + (outputTokens ?? 0);
      return { text, tokens: reported > 0 ? reported : estimateAsrTokens(audio.length, seconds) };
    } catch (error) {
      errorCode = signal?.aborted ? 'cancelled' : timeout.aborted ? 'timeout'
        : httpStatus === 429 ? 'rate_limited' : error instanceof TranscribeError ? error.kind : 'provider_error';
      if (timeout.aborted) throw new TranscribeError('timeout', '语音转写超时。', true);
      if (error instanceof TranscribeError) throw error;
      throw new TranscribeError('provider_error', '暂时连不上语音转写服务。', true);
    } finally {
      recordAiUsage({ id: crypto.randomUUID(), startedAt: new Date(started).toISOString(), operation: 'asr',
        model: this.options.model, provider: this.options.tokenPlan ? 'bailian-token-plan' : 'bailian', source: 'live', status: errorCode ? 'failed' : 'succeeded',
        inputTokens, outputTokens, durationMs: Date.now() - started, httpStatus, errorCode });
    }
  }
}

/**
 * 语音接口通常只报音频秒数（usage.duration），不报 token。备用通道的每日 token 上限按保守估计计入：
 * 有秒数按每秒 32 个（高于语音模型约 25 个/秒的计费口径）；连秒数都没有，按每 256 字节 1 个
 * （64 kbps 的 AAC 约 31 个/秒）。两种都至少 100 个。只用于熔断计数，宁可多算。
 */
export function estimateAsrTokens(bytes: number, seconds: number | null = null): number {
  return Math.max(100, seconds !== null ? Math.ceil(seconds * 32) : Math.ceil(bytes / 256));
}

export interface AsrConfig { aiMode: string; aiBaseUrl: string; aiApiKey: string; aiAsrModel: string }

/** 启动守卫：真实模式下语音转写缺一项配置就拒绝启动；报错只说变量名，不含任何配置值。 */
export function assertAsrConfigured(cfg: AsrConfig): void {
  if (cfg.aiMode !== 'bailian') throw new Error(`语音转写只支持百炼：要求 SEL_AI_MODE=bailian（当前：${cfg.aiMode}）`);
  if (cfg.aiBaseUrl.replace(/\/$/, '') !== ASR_BAILIAN_ENDPOINT) throw new Error(`语音转写只允许百炼北京接口 ${ASR_BAILIAN_ENDPOINT}（SEL_AI_BASE_URL）`);
  if (!cfg.aiApiKey.trim()) throw new Error('缺少 SEL_AI_API_KEY：语音转写需要它');
  if (!cfg.aiAsrModel.trim()) throw new Error('缺少 SEL_AI_MODEL_ASR');
}

/** 按配置构造转写器：mock → 固定转写；bailian → 先过守卫；其他模式 fail-hard。 */
export function createTranscriber(cfg: AsrConfig & { aiTimeoutMs?: number }): SpeechTranscriber {
  if (cfg.aiMode === 'mock') return new MockTranscriber();
  assertAsrConfigured(cfg);
  const timeoutMs = Math.min(cfg.aiTimeoutMs ?? 30_000, 60_000);
  const backup = new BailianTranscriber({ apiKey: cfg.aiApiKey, model: cfg.aiAsrModel, timeoutMs });
  const key = process.env.SEL_TOKEN_PLAN_API_KEY?.trim();
  if (!key) return backup;
  const primary = new BailianTranscriber({ apiKey: key, model: ASR_TOKEN_PLAN_MODEL, tokenPlan: true, timeoutMs });
  return { source: 'bailian', async transcribe(audio, mimeType, signal) {
    try { return await primary.transcribe(audio, mimeType, signal); }
    catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof TranscribeError) || !error.fallbackEligible) throw error;
      // 按量付费备用与图文调用共用同一份每日上限（见 fallbackBudget.ts）。
      const result = await withFallbackBudget({ operation: 'asr', primaryError: error.kind }, () => backup.transcribeWithUsage(audio, mimeType, signal),
        () => new TranscribeError('provider_error', FALLBACK_BLOCKED_MESSAGE), r => r.tokens);
      return result.text;
    }
  } };
}

let shared: SpeechTranscriber | null = null;
/** 全局配置的转写器（首次取用时构造；缺配置在这里抛错）。 */
export function getTranscriber(): SpeechTranscriber {
  shared ??= createTranscriber(config);
  return shared;
}
