import { config } from '../config.js';

/**
 * 「说说为什么错」的语音转文字（学生网页版用；iOS App 在手机上本地转写，不走这里）。
 * - mock 模式（默认、测试）：固定返回一句合成的转写，不发任何网络请求。
 * - bailian 模式：调用百炼（DashScope）OpenAI 兼容接口的千问 ASR（默认 qwen3-asr-flash），
 *   音频以 Base64 Data URL 放在请求体里，只在内存里经过一次，**服务器不落盘、不记日志**。
 * - 其他模式或缺配置：fail-hard（启动守卫 + 取用时再查一次），绝不悄悄退回 mock。
 */

export const ASR_DEFAULT_MODEL = 'qwen3-asr-flash';
export const ASR_BAILIAN_ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
/** mock 模式固定转写（合成句子，不含任何真实学生内容）。 */
export const MOCK_TRANSCRIPT = '我以为移项不用变号，就直接抄过去了。';

export interface SpeechTranscriber {
  readonly source: 'mock' | 'bailian';
  /** audio：完整录音字节；mimeType：去掉参数后的媒体类型（audio/mp4、audio/webm …）。 */
  transcribe(audio: Buffer, mimeType: string, signal?: AbortSignal): Promise<string>;
}

export class TranscribeError extends Error {
  constructor(public readonly kind: 'timeout' | 'provider_error' | 'invalid_output', message: string) {
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
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  /** 测试注入；缺省用全局 fetch。 */
  fetchImpl?: typeof fetch;
}

export class BailianTranscriber implements SpeechTranscriber {
  readonly source = 'bailian' as const;
  constructor(private readonly options: BailianTranscriberOptions) {}

  /** 请求体（可单测；不含密钥）。 */
  requestBody(audio: Buffer, mimeType: string): Record<string, unknown> {
    return {
      model: this.options.model,
      messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:${mimeType};base64,${audio.toString('base64')}` } }] }],
      stream: false,
      // 学生说的是普通话；数字保持原样（不做 ITN），以免把「移项」之类改写。
      asr_options: { language: 'zh', enable_itn: false },
    };
  }

  async transcribe(audio: Buffer, mimeType: string, signal?: AbortSignal): Promise<string> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 30_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(`${this.options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(this.requestBody(audio, mimeType)),
        signal: combined,
      });
    } catch {
      if (timeout.aborted) throw new TranscribeError('timeout', '语音转写超时。');
      throw new TranscribeError('provider_error', '暂时连不上语音转写服务。');
    }
    if (!response.ok) throw new TranscribeError('provider_error', `语音转写服务返回 HTTP ${response.status}。`);
    let body: unknown;
    try { body = await response.json(); } catch { throw new TranscribeError('invalid_output', '语音转写结果无法解析。'); }
    const content = (body as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
      return content.map(part => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '')).join('').trim();
    }
    throw new TranscribeError('invalid_output', '语音转写结果里没有文字。');
  }
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
  return new BailianTranscriber({ baseUrl: cfg.aiBaseUrl, apiKey: cfg.aiApiKey, model: cfg.aiAsrModel, timeoutMs: Math.min(cfg.aiTimeoutMs ?? 30_000, 60_000) });
}

let shared: SpeechTranscriber | null = null;
/** 全局配置的转写器（首次取用时构造；缺配置在这里抛错）。 */
export function getTranscriber(): SpeechTranscriber {
  shared ??= createTranscriber(config);
  return shared;
}
