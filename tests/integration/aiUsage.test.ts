import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatClient, type ChatTrace } from '../../src/ai/chatClient.js';
import { BailianTranscriber } from '../../src/ai/asr.js';

let root: string;
let server: http.Server | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-usage-'));
  vi.stubEnv('SEL_STUDENT_DATA_DIR', root);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; }
  fs.rmSync(root, { recursive: true, force: true });
});
function rows(): Array<Record<string, unknown>> {
  const filename = path.join(root, 'ai-usage.db');
  expect(fs.existsSync(filename), 'actual HTTP attempts must be persisted').toBe(true);
  const db = new DatabaseSync(filename, { readOnly: true });
  try { return db.prepare('SELECT * FROM ai_usage ORDER BY started_at, id').all(); }
  finally { db.close(); }
}
async function client(model = 'ok', extras: Partial<ConstructorParameters<typeof ChatClient>[0]> = {}): Promise<ChatClient> {
  server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const { model } = JSON.parse(raw);
    if (model === 'slow') return;
    const usage = model === 'missing' ? { prompt_tokens: -1, completion_tokens: 'wrong' } : { prompt_tokens: 120, completion_tokens: 30 };
    res.writeHead(model === 'limited' ? 429 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ usage, secret: 'response-private-material', choices: [{ finish_reason: 'stop', message: { content: model === 'invalid' ? 'oops' : '{"ok":true}' } }] }));
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  return new ChatClient({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKey: 'private-api-key',
    models: { diagnose: model }, timeoutMs: 1000, bailianOnly: false, ...extras });
}

describe('AI usage metadata at the actual provider boundary', () => {
  it('persists input/output usage and latency without request/response contents, once per HTTP attempt', async () => {
    const traces: ChatTrace[] = [];
    const c = await client('ok', { trace: trace => { traces.push(trace); } });
    await c.call('diagnose', [{ role: 'user', content: 'student-private-material' }]);
    await c.call('diagnose', []);
    const events = rows();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ operation: 'diagnose', model: 'ok', status: 'succeeded', input_tokens: 120, output_tokens: 30, http_status: 200, error_code: null });
    expect(events[0]!.duration_ms).toEqual(expect.any(Number));
    expect(events[0]!.started_at).toMatch(/^\d{4}-/);
    expect((traces[0] as ChatTrace & { usageId: string }).usageId).toEqual(expect.any(String));
    expect(JSON.stringify(events)).not.toMatch(/private-material|private-api-key/);
    expect(fs.statSync(path.join(root, 'ai-usage.db')).mode & 0o777).toBe(0o600);
  });
  it('keeps absent/invalid usage null rather than zero', async () => {
    await (await client('missing')).call('diagnose', []);
    expect(rows()[0]).toMatchObject({ input_tokens: null, output_tokens: null, status: 'succeeded' });
  });
  it('retains reported usage even for rate limiting', async () => {
    await expect((await client('limited')).call('diagnose', [])).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(rows()[0]).toMatchObject({ status: 'failed', error_code: 'rate_limited', http_status: 429, input_tokens: 120, output_tokens: 30 });
  });
  it('records invalid model JSON with its usage', async () => {
    await expect((await client('invalid')).call('diagnose', [])).rejects.toMatchObject({ kind: 'invalid_json' });
    expect(rows()[0]).toMatchObject({ status: 'failed', error_code: 'invalid_json', input_tokens: 120 });
  });
  it('records timeout without inventing usage', async () => {
    await expect((await client('slow', { timeoutMs: 40 })).call('diagnose', [])).rejects.toMatchObject({ kind: 'timeout' });
    expect(rows()[0]).toMatchObject({ status: 'failed', error_code: 'timeout', input_tokens: null, output_tokens: null });
  });
  it('records cancellation as failure and preserves cancellation reason', async () => {
    const controller = new AbortController();
    const reason = new Error('private-cancellation-reason');
    const c = await client('slow', { signal: controller.signal });
    const timer = setTimeout(() => controller.abort(reason), 40);
    try { await expect(c.call('diagnose', [])).rejects.toBe(reason); } finally { clearTimeout(timer); }
    expect(rows()[0]).toMatchObject({ status: 'failed', error_code: 'cancelled' });
    expect(JSON.stringify(rows())).not.toContain('private-cancellation-reason');
  });
  it('does not count configuration rejection as an HTTP call', async () => {
    const c = await client('ok', { apiKey: '' });
    await expect(c.call('diagnose', [])).rejects.toThrow();
    expect(fs.existsSync(path.join(root, 'ai-usage.db'))).toBe(false);
  });
  it('records native ASR usage and errors without audio or transcript', async () => {
    const transcriber = new BailianTranscriber({ apiKey: 'private-api-key', model: 'asr-test', fetchImpl: async () =>
      new Response(JSON.stringify({ output: { text: 'private-transcript' }, usage: { input_tokens: 144, output_tokens: 19 } })) });
    expect(await transcriber.transcribe(Buffer.from('private-audio'), 'audio/mp4')).toBe('private-transcript');
    expect(rows()[0]).toMatchObject({ operation: 'asr', model: 'asr-test', input_tokens: 144, output_tokens: 19, status: 'succeeded' });
    const failed = new BailianTranscriber({ apiKey: 'private-api-key', model: 'asr-test', fetchImpl: async () =>
      new Response(JSON.stringify({ usage: { input_tokens: 20 } }), { status: 503 }) });
    await expect(failed.transcribe(Buffer.from('private-audio'), 'audio/mp4')).rejects.toMatchObject({ kind: 'provider_error' });
    expect(rows().find(row => row.http_status === 503)).toMatchObject({ status: 'failed', input_tokens: 20, output_tokens: null, error_code: 'provider_error' });
    expect(JSON.stringify(rows())).not.toMatch(/private-transcript|private-audio|private-api-key/);
  });
  it('does not turn successful provider work into an error when metrics storage is unavailable', async () => {
    fs.mkdirSync(path.join(root, 'ai-usage.db'));
    await expect((await client()).call('diagnose', [])).resolves.toMatchObject({ value: { ok: true } });
  });
});
