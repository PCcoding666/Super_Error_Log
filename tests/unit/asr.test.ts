/**
 * 语音转写：配置守卫（fail-hard）、百炼请求形状（注入 fetch，不发真实网络请求）、MP4 时长读取与录音校验。
 * 不读 .env、不调用真实百炼；所有音频都是合成的字节。
 */
import { describe, expect, it } from 'vitest';
import { ASR_BAILIAN_ENDPOINT, BailianTranscriber, MOCK_TRANSCRIPT, MockTranscriber, TranscribeError, assertAsrConfigured, createTranscriber } from '../../src/ai/asr.js';
import { baseMimeType, mp4DurationSeconds, transcribeClip } from '../../src/v2/transcribe.js';
import { syntheticMp4 } from '../helpers/syntheticAudio.js';

const FAKE_KEY = 'sk-unit-test-not-a-real-key';
const complete = { aiMode: 'bailian', aiBaseUrl: ASR_BAILIAN_ENDPOINT, aiApiKey: FAKE_KEY, aiAsrModel: 'qwen3-asr-flash' };

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

describe('百炼千问 ASR 请求形状（OpenAI 兼容 chat/completions + input_audio Data URL）', () => {
  it('请求体：模型、Base64 Data URL、中文、不做 ITN；鉴权头带密钥；解析 choices[0].message.content', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: ' 移项忘了变号。 ' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const transcriber = new BailianTranscriber({ baseUrl: `${ASR_BAILIAN_ENDPOINT}/`, apiKey: FAKE_KEY, model: 'qwen3-asr-flash', fetchImpl });
    const audio = Buffer.from('synthetic-audio');
    expect(await transcriber.transcribe(audio, 'audio/mp4')).toBe('移项忘了变号。');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${ASR_BAILIAN_ENDPOINT}/chat/completions`);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${FAKE_KEY}`);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual({
      model: 'qwen3-asr-flash',
      messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:audio/mp4;base64,${audio.toString('base64')}` } }] }],
      stream: false,
      asr_options: { language: 'zh', enable_itn: false },
    });
  });

  it('content 为分段数组时拼接文字', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ choices: [{ message: { content: [{ text: '第一段' }, { text: '第二段' }] } }] }))) as unknown as typeof fetch;
    const transcriber = new BailianTranscriber({ baseUrl: ASR_BAILIAN_ENDPOINT, apiKey: FAKE_KEY, model: 'm', fetchImpl });
    expect(await transcriber.transcribe(Buffer.from('x'), 'audio/webm')).toBe('第一段第二段');
  });

  it('HTTP 错误、网络错误、超时、没有文字都映射成 TranscribeError', async () => {
    const make = (impl: () => Promise<Response>, timeoutMs?: number) => new BailianTranscriber({ baseUrl: ASR_BAILIAN_ENDPOINT, apiKey: FAKE_KEY, model: 'm', fetchImpl: impl as unknown as typeof fetch, timeoutMs });
    await expect(make(async () => new Response('{}', { status: 500 })).transcribe(Buffer.from('x'), 'audio/mp4')).rejects.toBeInstanceOf(TranscribeError);
    await expect(make(async () => { throw new TypeError('fetch failed'); }).transcribe(Buffer.from('x'), 'audio/mp4')).rejects.toMatchObject({ kind: 'provider_error' });
    await expect(make(async () => new Response('{"choices":[]}')).transcribe(Buffer.from('x'), 'audio/mp4')).rejects.toMatchObject({ kind: 'invalid_output' });
    const hanging = make(() => new Promise<Response>((_resolve, reject) => { setTimeout(() => reject(new DOMException('aborted', 'AbortError')), 200); }), 20);
    await expect(hanging.transcribe(Buffer.from('x'), 'audio/mp4')).rejects.toMatchObject({ kind: 'timeout' });
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
