import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatClient, type ChatOptions, type ChatTrace } from '../../src/ai/chatClient.js';
import sharp from 'sharp';
import { BailianMobileVision, type VisionAttempt } from '../../src/mobile/vision.js';

const original = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const primary = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
const options = (): ChatOptions => ({ baseUrl: original, apiKey: 'old-secret', models: { followup: 'qwen3.8-max' }, timeoutMs: 1000, bailianOnly: true });
const ok = () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] }));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('Token Plan primary with original provider backup', () => {
  it('fails over timeout, but caller cancellation never starts backup', async () => {
    vi.stubEnv('SEL_TOKEN_PLAN_API_KEY', 'plan-secret');
    const hanging = (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    });
    const fetcher = vi.fn().mockImplementationOnce(hanging).mockResolvedValueOnce(ok()); vi.stubGlobal('fetch', fetcher);
    await new ChatClient({ ...options(), timeoutMs: 10 }).call('followup', [{ role: 'user', content: 'test' }]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const controller = new AbortController(); const error = new Error('cancelled');
    fetcher.mockReset().mockImplementation(hanging);
    const pending = new ChatClient({ ...options(), signal: controller.signal }).call('followup', [{ role: 'user', content: 'test' }]);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1)); controller.abort(error);
    await expect(pending).rejects.toBe(error);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('redacts both keys in failed traces before fallback', async () => {
    vi.stubEnv('SEL_TOKEN_PLAN_API_KEY', 'plan-secret');
    const traces: ChatTrace[] = [];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('plan-secret old-secret', { status: 503 })).mockResolvedValueOnce(ok()));
    await new ChatClient({ ...options(), trace: t => { traces.push(t); } }).call('followup', [{ role: 'user', content: 'test' }]);
    expect(traces[0]!.responseRaw).toBe('[REDACTED] [REDACTED]');
  });
  it.each([false, true])('persists each failed mobile attempt even if backup budget is exhausted (%s)', async exhausted => {
    vi.stubEnv('SEL_TOKEN_PLAN_API_KEY', 'plan-secret');
    const response = { candidates: [], warnings: [], capacityReached: false };
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 503 })).mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(response) } }] })));
    vi.stubGlobal('fetch', fetcher);
    const vision = new BailianMobileVision({ ...options(), models: { inventory: 'qwen3.8-max', transcribe: 'qwen3.8-max', verify: 'qwen3.8-max', ground: 'qwen3.8-max' } });
    const attempts: Array<VisionAttempt & { reservationId?: string }> = []; let n = 0;
    const source = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
    const error = new Error('budget exhausted');
    const result = vision.inventory(source, { jobId: 'test', sourceHash: 'synthetic', questionId: null,
      reserveAttempt: async () => { n++; if (exhausted && n === 2) throw error; return { roundId: 'round', reservationId: `r${n}`, attempt: n }; },
      recordAttempt: attempt => { attempts.push(attempt); } });
    if (exhausted) await expect(result).rejects.toBe(error); else await result;
    expect(attempts.map(a => a.httpStatus)).toEqual(exhausted ? [503] : [503, 200]);
    expect(attempts.map(a => a.reservationId)).toEqual(exhausted ? ['r1'] : ['r1', 'r2']);
    expect(fetcher).toHaveBeenCalledTimes(exhausted ? 1 : 2);
  });
  it('uses Token Plan first and preserves the model and JSON contract', async () => {
    vi.stubEnv('SEL_TOKEN_PLAN_API_KEY', 'plan-secret');
    const fetcher = vi.fn().mockResolvedValueOnce(ok()); vi.stubGlobal('fetch', fetcher);
    expect((await new ChatClient(options()).call('followup', [{ role: 'user', content: 'test' }])).value).toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe(primary + '/chat/completions');
    expect(fetcher.mock.calls[0]![1].headers.authorization).toBe('Bearer plan-secret');
    expect(JSON.parse(fetcher.mock.calls[0]![1].body).model).toBe('qwen3.8-max');
  });
  it.each([401, 403, 404, 408, 429, 500, 503])('falls back once after HTTP %s and reserves each attempt', async status => {
    vi.stubEnv('SEL_TOKEN_PLAN_API_KEY', 'plan-secret');
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('{}', { status })).mockResolvedValueOnce(ok()); vi.stubGlobal('fetch', fetcher);
    const beforeRequest = vi.fn().mockResolvedValue(undefined);
    const traces: ChatTrace[] = [];
    await new ChatClient({ ...options(), beforeRequest, trace: t => { traces.push(t); } }).call('followup', [{ role: 'user', content: 'test' }]);
    expect(fetcher).toHaveBeenCalledTimes(2); expect(beforeRequest).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]![0]).toBe(original + '/chat/completions');
    expect(fetcher.mock.calls[1]![1].headers.authorization).toBe('Bearer old-secret');
    expect(traces.map(t => t.httpStatus)).toEqual([status, 200]);
  });
  it('falls back after a network failure but never loops when backup fails', async () => {
    vi.stubEnv('SEL_TOKEN_PLAN_API_KEY', 'plan-secret');
    const fetcher = vi.fn().mockRejectedValue(new Error('network')); vi.stubGlobal('fetch', fetcher);
    await expect(new ChatClient(options()).call('followup', [{ role: 'user', content: 'test' }])).rejects.toMatchObject({ kind: 'provider_error' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([200, 400])('does not fail over malformed output or bad input (HTTP %s)', async status => {
    vi.stubEnv('SEL_TOKEN_PLAN_API_KEY', 'plan-secret');
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status })); vi.stubGlobal('fetch', fetcher);
    await expect(new ChatClient(options()).call('followup', [{ role: 'user', content: 'test' }])).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not fail over reservation failure or cancellation', async () => {
    vi.stubEnv('SEL_TOKEN_PLAN_API_KEY', 'plan-secret');
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const reason = new Error('budget exhausted');
    await expect(new ChatClient({ ...options(), beforeRequest: async () => { throw reason; } }).call('followup', [{ role: 'user', content: 'test' }])).rejects.toBe(reason);
    const controller = new AbortController(); controller.abort(reason);
    await expect(new ChatClient({ ...options(), signal: controller.signal }).call('followup', [{ role: 'user', content: 'test' }])).rejects.toBe(reason);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('keeps non-Bailian clients and unconfigured deployments on their existing endpoint', async () => {
    const fetcher = vi.fn().mockImplementation(ok); vi.stubGlobal('fetch', fetcher);
    vi.stubEnv('SEL_TOKEN_PLAN_API_KEY', '');
    await new ChatClient(options()).call('followup', [{ role: 'user', content: 'test' }]);
    vi.stubEnv('SEL_TOKEN_PLAN_API_KEY', 'plan-secret');
    await new ChatClient({ ...options(), bailianOnly: false }).call('followup', [{ role: 'user', content: 'test' }]);
    expect(fetcher.mock.calls.map(c => c[0])).toEqual([original + '/chat/completions', original + '/chat/completions']);
  });
});
