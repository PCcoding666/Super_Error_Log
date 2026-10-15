/**
 * 语音转写：配置守卫（fail-hard）、百炼原生接口请求形状与响应解析（注入 fetch，不发真实网络请求）、
 * MP4 时长读取与录音校验。不读 .env、不调用真实百炼；所有音频都是合成的字节。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ASR_BAILIAN_ENDPOINT, ASR_DEFAULT_MODEL, ASR_NATIVE_ENDPOINT, BailianTranscriber, MOCK_TRANSCRIPT, MockTranscriber, TranscribeError, assertAsrConfigured, createTranscriber, type SpeechTranscriber } from '../../src/ai/asr.js';
import { baseMimeType, mp4DurationSeconds, transcribeClip } from '../../src/v2/transcribe.js';
import { QWEN_AUDIO_ASR_TRANSCRIPT, qwenAudioAsrResponse } from '../helpers/qwenAudioAsrResponse.js';
import { syntheticMp4 } from '../helpers/syntheticAudio.js';

const FAKE_KEY = 'sk-unit-test-not-a-real-key';
const MODEL = 'qwen-audio-3.1-asr-flash';
const complete = { aiMode: 'bailian', aiBaseUrl: ASR_BAILIAN_ENDPOINT, aiApiKey: FAKE_KEY, aiAsrModel: MODEL };

describe('语音转写配置守卫：真实模式缺一项就拒绝，报错不含配置值', () => {
  it('配置齐全时通过', () => {
    expect(() => assertAsrConfigured(complete)).not.toThrow();
  });
  it('非 bailian 模式拒绝', () => {
    expect(() => assertAsrConfigured({ ...complete, aiMode: 'openai' })).toThrow(/SEL_AI_MODE=bailian/);
  });
  it('不是百炼北京接口拒绝', () => {
    expect(() => assertAsrConfigured({ ...complete, aiBaseUrl: 'https://example.invalid/v1' })).toThrow(/SEL_AI_BASE_URL/);
  });
  it('SEL_AI_BASE_URL 的校验不变：只认兼容接口，原生转写地址不能顶替它', () => {
    expect(() => assertAsrConfigured({ ...complete, aiBaseUrl: `${ASR_BAILIAN_ENDPOINT}/` })).not.toThrow();
    expect(() => assertAsrConfigured({ ...complete, aiBaseUrl: ASR_NATIVE_ENDPOINT })).toThrow(/SEL_AI_BASE_URL/);
  });
  it('缺密钥拒绝，报错里没有密钥', () => {
    let message = '';
    try { assertAsrConfigured({ ...complete, aiApiKey: ' ' }); } catch (error) { message = (error as Error).message; }
    expect(message).toMatch(/SEL_AI_API_KEY/);
    expect(message).not.toContain(FAKE_KEY);
  });
  it('缺模型拒绝', () => {
    expect(() => assertAsrConfigured({ ...complete, aiAsrModel: '' })).toThrow(/SEL_AI_MODEL_ASR/);
  });
  it('mock 模式给固定转写；openai 模式不降级、直接抛错', async () => {
    const mock = createTranscriber({ ...complete, aiMode: 'mock', aiApiKey: '' });
    expect(mock.source).toBe('mock');
    expect(await mock.transcribe(Buffer.from([1, 2, 3]), 'audio/mp4')).toBe(MOCK_TRANSCRIPT);
    expect(await new MockTranscriber().transcribe(Buffer.alloc(0))).toBe('');
    expect(() => createTranscriber({ ...complete, aiMode: 'openai' })).toThrow(/百炼/);
    expect(createTranscriber(complete).source).toBe('bailian');
  });
});

describe('语音转写模型默认值', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
  it('缺省 qwen-audio-3.1-asr-flash；SEL_AI_MODEL_ASR 仍可覆盖；留空等于缺省', async () => {
    expect(ASR_DEFAULT_MODEL).toBe(MODEL);
    vi.stubEnv('SEL_AI_MODEL_ASR', '');
    vi.resetModules();
    expect((await import('../../src/config.js')).config.aiAsrModel).toBe(MODEL);
    vi.stubEnv('SEL_AI_MODEL_ASR', 'some-other-asr');
    vi.resetModules();
    expect((await import('../../src/config.js')).config.aiAsrModel).toBe('some-other-asr');
  });
});

describe('百炼千问音频识别请求形状（DashScope 原生 multimodal-generation + input_audio Data URL）', () => {
  function recorder(respond: () => Response | Promise<Response> = () => new Response(JSON.stringify(qwenAudioAsrResponse()), { status: 200 })) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return respond(); }) as unknown as typeof fetch;
    return { calls, transcriber: new BailianTranscriber({ apiKey: FAKE_KEY, model: MODEL, fetchImpl }) };
  }

  it('固定打原生地址（不是 compatible-mode/chat/completions）；鉴权头带密钥；请求体含模型、Data URL、format，且没有 sample_rate', async () => {
    const { calls, transcriber } = recorder();
    const audio = Buffer.from('synthetic-audio');
    expect(await transcriber.transcribe(audio, 'audio/mp4')).toBe(QWEN_AUDIO_ASR_TRANSCRIPT);
    expect(calls).toHaveLength(1);
    expect(ASR_NATIVE_ENDPOINT).toBe('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation');
    expect(calls[0]!.url).toBe(ASR_NATIVE_ENDPOINT);
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.headers).toEqual({ authorization: `Bearer ${FAKE_KEY}`, 'content-type': 'application/json' });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      model: MODEL,
      input: { messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:audio/mp4;base64,${audio.toString('base64')}` } }] }] },
      parameters: { format: 'm4a' },
    });
    expect(String(calls[0]!.init.body)).not.toContain('sample_rate');
    expect(String(calls[0]!.init.body)).not.toContain(FAKE_KEY);
  });

  it.each([
    ['audio/mp4', 'audio/mp4', 'm4a'],
    ['audio/x-m4a', 'audio/mp4', 'm4a'],
    ['audio/m4a', 'audio/mp4', 'm4a'],
    ['audio/aac', 'audio/aac', 'aac'],
    ['audio/webm', 'audio/webm', 'webm'],
    ['audio/webm;codecs=opus', 'audio/webm', 'webm'],
    ['Audio/MP4', 'audio/mp4', 'm4a'],
  ])('收到 %s：Data URL 用 %s，parameters.format = %s', async (received, dataUrlMime, format) => {
    const { calls, transcriber } = recorder();
    const audio = Buffer.from('synthetic-audio');
    await transcriber.transcribe(audio, received);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.parameters).toEqual({ format });
    expect(body.input.messages[0].content[0].input_audio.data).toBe(`data:${dataUrlMime};base64,${audio.toString('base64')}`);
  });

  it('不认识的录音格式：不发请求，按 provider_error 处理', async () => {
    const { calls, transcriber } = recorder();
    await expect(transcriber.transcribe(Buffer.from('x'), 'audio/ogg')).rejects.toMatchObject({ kind: 'provider_error' });
    await expect(transcriber.transcribe(Buffer.from('x'), '')).rejects.toBeInstanceOf(TranscribeError);
    expect(calls).toHaveLength(0);
  });
});

describe('百炼千问音频识别响应解析', () => {
  const make = (payload: unknown | (() => Response)) => new BailianTranscriber({
    apiKey: FAKE_KEY,
    model: MODEL,
    fetchImpl: (async () => (typeof payload === 'function' ? (payload as () => Response)() : new Response(JSON.stringify(payload), { status: 200 }))) as unknown as typeof fetch,
  });

  it('真实响应样例：取 output.text', async () => {
    expect(await make(qwenAudioAsrResponse()).transcribe(Buffer.from('x'), 'audio/mp4')).toBe(QWEN_AUDIO_ASR_TRANSCRIPT);
  });

  it('output.text 缺失时退到 output.sentence.text（对象，或分句数组拼接）', async () => {
    expect(await make({ output: { sentence: { text: ' 移项忘了变号。 ' } } }).transcribe(Buffer.from('x'), 'audio/webm')).toBe('移项忘了变号。');
    expect(await make({ output: { sentence: [{ text: '第一句。' }, { text: '第二句。' }] } }).transcribe(Buffer.from('x'), 'audio/webm')).toBe('第一句。第二句。');
  });

  it('output.text 优先于 sentence；首尾空白去掉；没听出字（空串）返回空串而不是报错', async () => {
    expect(await make({ output: { text: '  优先这个  ', sentence: { text: '不用这个' } } }).transcribe(Buffer.from('x'), 'audio/mp4')).toBe('优先这个');
    expect(await make({ output: { text: '' } }).transcribe(Buffer.from('x'), 'audio/mp4')).toBe('');
  });

  it.each([
    ['空对象', {}],
    ['没有 output', { usage: { duration: 7 } }],
    ['output 里没有文字', { output: { sentence: {} } }],
    ['output.text 不是字符串', { output: { text: 123 } }],
    ['sentence 不是对象', { output: { sentence: 'x' } }],
    ['sentence 为空数组', { output: { sentence: [] } }],
    ['只有 OpenAI 兼容形状', { choices: [{ message: { content: '兼容接口的文字' } }] }],
  ])('结果里没有文字（%s）→ invalid_output', async (_name, payload) => {
    await expect(make(payload).transcribe(Buffer.from('x'), 'audio/mp4')).rejects.toMatchObject({ kind: 'invalid_output' });
  });

  it('响应体不是 JSON → invalid_output', async () => {
    await expect(make(() => new Response('<html>oops</html>', { status: 200 })).transcribe(Buffer.from('x'), 'audio/mp4')).rejects.toMatchObject({ kind: 'invalid_output' });
  });
});

describe('百炼千问音频识别错误映射', () => {
  const make = (impl: () => Promise<Response>, timeoutMs?: number) => new BailianTranscriber({ apiKey: FAKE_KEY, model: MODEL, fetchImpl: impl as unknown as typeof fetch, timeoutMs });

  it('HTTP 错误（含原生接口的 400 UNSUPPORTED_FORMAT）→ provider_error，消息只有状态码，不回显响应体、密钥或音频', async () => {
    const audio = Buffer.from('synthetic-audio');
    for (const status of [400, 401, 429, 500]) {
      let failure: unknown;
      try { await make(async () => new Response(JSON.stringify({ code: 'UNSUPPORTED_FORMAT', message: 'format is empty' }), { status })).transcribe(audio, 'audio/mp4'); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(TranscribeError);
      const { kind, message } = failure as TranscribeError;
      expect(kind).toBe('provider_error');
      expect(message).toBe(`语音转写服务返回 HTTP ${status}。`);
      expect(message).not.toContain('UNSUPPORTED_FORMAT');
      expect(message).not.toContain(FAKE_KEY);
      expect(message).not.toContain(audio.toString('base64'));
    }
  });

  it('网络错误 → provider_error；超时 → timeout', async () => {
    await expect(make(async () => { throw new TypeError('fetch failed'); }).transcribe(Buffer.from('x'), 'audio/mp4')).rejects.toMatchObject({ kind: 'provider_error' });
    const hanging = make(() => new Promise<Response>((_resolve, reject) => { setTimeout(() => reject(new DOMException('aborted', 'AbortError')), 200); }), 20);
    await expect(hanging.transcribe(Buffer.from('x'), 'audio/mp4')).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('调用方的取消信号会传给 fetch；取消按 provider_error 处理（不是超时）', async () => {
    const controller = new AbortController();
    const fetchImpl = (async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })) as unknown as typeof fetch;
    const pending = new BailianTranscriber({ apiKey: FAKE_KEY, model: MODEL, fetchImpl }).transcribe(Buffer.from('x'), 'audio/mp4', controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'provider_error' });
  });
});

describe('transcribeClip 把 MIME 交给转写器（允许列表不变）', () => {
  function seen() {
    const mimes: string[] = [];
    const transcriber: SpeechTranscriber = { source: 'bailian', transcribe: async (_audio, mime) => { mimes.push(mime); return QWEN_AUDIO_ASR_TRANSCRIPT; } };
    return { mimes, transcriber };
  }
  it('mp4/x-m4a/m4a 统一成 audio/mp4，aac 与 webm（去参数后）原样', async () => {
    const { mimes, transcriber } = seen();
    const clip = syntheticMp4(3);
    for (const type of ['audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac', 'audio/webm;codecs=opus']) {
      expect(await transcribeClip(transcriber, clip, type)).toEqual({ status: 200, body: { text: QWEN_AUDIO_ASR_TRANSCRIPT } });
    }
    expect(mimes).toEqual(['audio/mp4', 'audio/mp4', 'audio/mp4', 'audio/aac', 'audio/webm']);
  });
  it('其他类型（如 audio/ogg、audio/wav）仍然 415，不会走到转写器', async () => {
    const { mimes, transcriber } = seen();
    for (const type of ['audio/ogg', 'audio/wav', 'audio/mpeg', 'video/mp4']) expect((await transcribeClip(transcriber, Buffer.from('x'), type)).status).toBe(415);
    expect(mimes).toHaveLength(0);
  });
});

describe('MP4 时长与录音校验', () => {
  it('读 mvhd（v0、v1）与分片录音的 mehd；读不到返回 null', () => {
    expect(mp4DurationSeconds(syntheticMp4(12.5))).toBeCloseTo(12.5, 2);
    expect(mp4DurationSeconds(syntheticMp4(61, { version: 1 }))).toBeCloseTo(61, 2);
    expect(mp4DurationSeconds(syntheticMp4(30, { fragmented: true }))).toBeCloseTo(30, 2);
    expect(mp4DurationSeconds(Buffer.from('not an mp4 at all'))).toBeNull();
    expect(mp4DurationSeconds(Buffer.alloc(0))).toBeNull();
  });

  it('content-type 去参数', () => {
    expect(baseMimeType('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(baseMimeType(undefined)).toBe('');
  });

  it('只接受 audio/mp4 与 audio/webm；空录音、超过 60 秒拒绝；模型失败 502', async () => {
    const mock = new MockTranscriber();
    expect((await transcribeClip(mock, Buffer.from('x'), 'image/jpeg')).status).toBe(415);
    expect((await transcribeClip(mock, Buffer.alloc(0), 'audio/mp4')).status).toBe(400);
    const long = await transcribeClip(mock, syntheticMp4(75), 'audio/mp4');
    expect(long).toEqual({ status: 400, body: { error: { code: 'audio_too_long', message: '录音超过 60 秒，说短一点再试。' } } });
    expect(await transcribeClip(mock, syntheticMp4(8), 'audio/mp4')).toEqual({ status: 200, body: { text: MOCK_TRANSCRIPT } });
    expect((await transcribeClip(mock, Buffer.from('webm-bytes'), 'audio/webm;codecs=opus')).status).toBe(200);
    const failing = { source: 'bailian' as const, transcribe: async () => { throw new TranscribeError('provider_error', 'x'); } };
    expect((await transcribeClip(failing, syntheticMp4(3), 'audio/mp4')).status).toBe(502);
  });
});
