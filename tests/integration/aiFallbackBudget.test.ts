import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatClient, type ChatOptions } from '../../src/ai/chatClient.js';
import { AiError } from '../../src/ai/errors.js';
import { ASR_BAILIAN_ENDPOINT, createTranscriber, estimateAsrTokens } from '../../src/ai/asr.js';
import { FALLBACK_BLOCKED_MESSAGE, FALLBACK_LEDGER_FILE, readFallbackToday, setFallbackClockForTests, shanghaiDay } from '../../src/ai/fallbackBudget.js';
import { StudentRegistry } from '../../src/studentHost/registry.js';
import { createStudentHostGateway } from '../../src/studentHost/router.js';

const original = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const primary = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
const options = (): ChatOptions => ({ baseUrl: original, apiKey: 'payg-fake', models: { followup: 'qwen-fake' }, timeoutMs: 1000, bailianOnly: true });
const ok = (tokens = { prompt_tokens: 1000, completion_tokens: 50 }) => new Response(JSON.stringify({ usage: tokens, choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] }));
const quota = () => new Response(JSON.stringify({ error: { code: 'Throttling.AllocationQuota' } }), { status: 429 });
const msg = [{ role: 'user' as const, content: 'synthetic' }];

let ledger: string; let usage: string; let stderr: string[];
beforeEach(() => {
  ledger = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-fallback-ledger-'));
  usage = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-fallback-usage-'));
  vi.stubEnv('SEL_TOKEN_PLAN_API_KEY', 'plan-fake');
  vi.stubEnv('SEL_AI_FALLBACK_LEDGER_DIR', ledger);
  vi.stubEnv('SEL_STUDENT_DATA_DIR', usage);
  stderr = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write);
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); setFallbackClockForTests(null);
  fs.rmSync(ledger, { recursive: true, force: true }); fs.rmSync(usage, { recursive: true, force: true });
});
const events = (name: string) => stderr.filter(line => line.startsWith('{')).map(line => JSON.parse(line)).filter(line => line.event === name);
const hosts = (fetcher: ReturnType<typeof vi.fn>) => fetcher.mock.calls.map(call => String(call[0]).startsWith(primary) ? 'tp' : 'payg');

describe('pay-as-you-go fallback daily circuit breaker', () => {
  it('records an alertable structured event and counts every fallback in the shared ledger', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(quota()).mockResolvedValueOnce(ok()); vi.stubGlobal('fetch', fetcher);
    await new ChatClient(options()).call('followup', msg);
    expect(hosts(fetcher)).toEqual(['tp', 'payg']);
    const [event] = events('sel_ai_fallback');
    expect(event).toMatchObject({ level: 'warn', operation: 'followup', primaryError: 'rate_limited', primaryHttpStatus: 429, callsToday: 1, callLimit: 200 });
    expect(JSON.stringify(stderr)).not.toMatch(/plan-fake|payg-fake|synthetic/);
    expect(readFallbackToday(ledger)).toMatchObject({ calls: 1, tokens: 1050, blocked: 0 });
    expect(fs.statSync(path.join(ledger, FALLBACK_LEDGER_FILE)).mode & 0o777).toBe(0o600);
  });

  it('repro: Token Plan keeps failing → after the daily call cap the backup is no longer called and the student gets a clear message', async () => {
    vi.stubEnv('SEL_AI_FALLBACK_DAILY_CALLS', '2');
    const fetcher = vi.fn().mockImplementation(async (url: string) => String(url).startsWith(primary) ? quota() : ok()); vi.stubGlobal('fetch', fetcher);
    const client = new ChatClient(options());
    await client.call('followup', msg);
    await client.call('followup', msg);
    const blocked = client.call('followup', msg);
    await expect(blocked).rejects.toBeInstanceOf(AiError);
    await expect(client.call('followup', msg)).rejects.toMatchObject({ kind: 'rate_limited', message: FALLBACK_BLOCKED_MESSAGE });
    expect(hosts(fetcher)).toEqual(['tp', 'payg', 'tp', 'payg', 'tp', 'tp']);
    expect(events('sel_ai_fallback_blocked')[0]).toMatchObject({ level: 'error', reason: 'calls', callsToday: 2, callLimit: 2 });
    expect(readFallbackToday(ledger)).toMatchObject({ calls: 2, blocked: 2 });
  });

  it('stops on the daily token cap using reported usage', async () => {
    vi.stubEnv('SEL_AI_FALLBACK_DAILY_TOKENS', '1500');
    const fetcher = vi.fn().mockImplementation(async (url: string) => String(url).startsWith(primary) ? new Response('{}', { status: 503 }) : ok()); vi.stubGlobal('fetch', fetcher);
    const client = new ChatClient(options());
    await client.call('followup', msg); // 1050
    await client.call('followup', msg); // 2100 ≥ 1500 after this one
    await expect(client.call('followup', msg)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(events('sel_ai_fallback_blocked')[0]).toMatchObject({ reason: 'tokens' });
  });

  it('shares one count across student processes (different student dirs, same ledger)', async () => {
    vi.stubEnv('SEL_AI_FALLBACK_DAILY_CALLS', '1');
    const fetcher = vi.fn().mockImplementation(async (url: string) => String(url).startsWith(primary) ? quota() : ok()); vi.stubGlobal('fetch', fetcher);
    await new ChatClient(options()).call('followup', msg);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-fallback-other-'));
    try {
      vi.stubEnv('SEL_STUDENT_DATA_DIR', other);
      await expect(new ChatClient(options()).call('followup', msg)).rejects.toMatchObject({ kind: 'rate_limited' });
    } finally { fs.rmSync(other, { recursive: true, force: true }); }
  });

  it('resets at midnight Asia/Shanghai', async () => {
    vi.stubEnv('SEL_AI_FALLBACK_DAILY_CALLS', '1');
    let now = new Date('2026-10-22T15:59:00.000Z'); // 23:59 in Shanghai
    setFallbackClockForTests(() => now);
    const fetcher = vi.fn().mockImplementation(async (url: string) => String(url).startsWith(primary) ? quota() : ok()); vi.stubGlobal('fetch', fetcher);
    const client = new ChatClient(options());
    await client.call('followup', msg);
    await expect(client.call('followup', msg)).rejects.toMatchObject({ kind: 'rate_limited' });
    now = new Date('2026-10-22T16:00:30.000Z'); // 00:00 next day in Shanghai
    expect(shanghaiDay(now)).toBe('2026-10-23');
    await expect(client.call('followup', msg)).resolves.toMatchObject({ value: { ok: true } });
  });

  it('0 disables the backup entirely; invalid config fails hard instead of silently allowing spending', async () => {
    vi.stubEnv('SEL_AI_FALLBACK_DAILY_CALLS', '0');
    const fetcher = vi.fn().mockImplementation(async () => quota()); vi.stubGlobal('fetch', fetcher);
    await expect(new ChatClient(options()).call('followup', msg)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(hosts(fetcher)).toEqual(['tp']);
    vi.stubEnv('SEL_AI_FALLBACK_DAILY_CALLS', 'lots');
    await expect(new ChatClient(options()).call('followup', msg)).rejects.toMatchObject({ kind: 'unsupported' });
    expect(hosts(fetcher)).toEqual(['tp', 'tp']);
  });

  it('an unreadable ledger fails closed (no spending without a count)', async () => {
    const blocker = path.join(ledger, 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    vi.stubEnv('SEL_AI_FALLBACK_LEDGER_DIR', blocker);
    const fetcher = vi.fn().mockImplementation(async (url: string) => String(url).startsWith(primary) ? quota() : ok()); vi.stubGlobal('fetch', fetcher);
    await expect(new ChatClient(options()).call('followup', msg)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(hosts(fetcher)).toEqual(['tp']);
    expect(events('sel_ai_fallback_blocked')[0]).toMatchObject({ reason: 'ledger' });
  });

  it('a student worker without the shared ledger dir refuses the backup loudly instead of counting per student', async () => {
    // Before: the ledger fell back to SEL_STUDENT_DATA_DIR, silently making the cap per student.
    vi.stubEnv('SEL_AI_FALLBACK_LEDGER_DIR', '');
    vi.stubEnv('SEL_STUDENT_HOST_DIR', '');
    vi.stubEnv('SEL_STUDENT_WORKER', '1');
    const fetcher = vi.fn().mockImplementation(async (url: string) => String(url).startsWith(primary) ? quota() : ok()); vi.stubGlobal('fetch', fetcher);
    await expect(new ChatClient(options()).call('followup', msg)).rejects.toMatchObject({ kind: 'rate_limited', message: FALLBACK_BLOCKED_MESSAGE });
    expect(hosts(fetcher)).toEqual(['tp']);
    expect(events('sel_ai_fallback_blocked')[0]).toMatchObject({ level: 'error', reason: 'ledger_dir_missing' });
    expect(fs.existsSync(path.join(usage, FALLBACK_LEDGER_FILE))).toBe(false);
  });

  it('under the student gateway every worker gets the registry host dir as the one shared ledger', async () => {
    const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-fallback-host-'));
    const registry = StudentRegistry.open(hostDir);
    const gateway = await createStudentHostGateway({ registry });
    try {
      expect(gateway.pool.sharedDir).toBe(registry.hostDir);
      expect(path.resolve(gateway.pool.sharedDir!)).toBe(path.resolve(hostDir));
    } finally {
      await gateway.close(); fs.rmSync(hostDir, { recursive: true, force: true });
    }
  });

  it('does not limit pay-as-you-go when it is the configured primary (no Token Plan key)', async () => {
    vi.stubEnv('SEL_TOKEN_PLAN_API_KEY', '');
    vi.stubEnv('SEL_AI_FALLBACK_DAILY_CALLS', '0');
    const fetcher = vi.fn().mockImplementation(async () => ok()); vi.stubGlobal('fetch', fetcher);
    await new ChatClient(options()).call('followup', msg);
    await new ChatClient(options()).call('followup', msg);
    expect(hosts(fetcher)).toEqual(['payg', 'payg']);
    expect(events('sel_ai_fallback')).toHaveLength(0);
  });

  it('ASR fallbacks count toward the daily token cap (reported tokens, else reported seconds, else audio size)', async () => {
    const cfg = { aiMode: 'bailian', aiBaseUrl: ASR_BAILIAN_ENDPOINT, aiApiKey: 'payg-fake', aiAsrModel: 'qwen-audio-fake', aiTimeoutMs: 1000 };
    const asr = (usage: unknown) => vi.fn().mockImplementation(async (url: string) => String(url).includes('token-plan')
      ? new Response('{}', { status: 503 })
      : new Response(JSON.stringify({ output: { text: '合成转写' }, ...(usage === undefined ? {} : { usage }) })));
    const audio = Buffer.alloc(64_000, 1);
    vi.stubGlobal('fetch', asr({ input_tokens: 700, output_tokens: 20 }));
    expect(await createTranscriber(cfg).transcribe(audio, 'audio/mp4')).toBe('合成转写');
    expect(readFallbackToday(ledger)).toMatchObject({ calls: 1, tokens: 720 });
    vi.stubGlobal('fetch', asr({ duration: 5 }));
    await createTranscriber(cfg).transcribe(audio, 'audio/mp4');
    expect(readFallbackToday(ledger)).toMatchObject({ calls: 2, tokens: 720 + 160 });
    vi.stubGlobal('fetch', asr(undefined));
    await createTranscriber(cfg).transcribe(audio, 'audio/mp4');
    expect(estimateAsrTokens(64_000)).toBe(250);
    expect(readFallbackToday(ledger)).toMatchObject({ calls: 3, tokens: 720 + 160 + 250 });
    vi.stubEnv('SEL_AI_FALLBACK_DAILY_TOKENS', '1130');
    await expect(createTranscriber(cfg).transcribe(audio, 'audio/mp4')).rejects.toMatchObject({ message: FALLBACK_BLOCKED_MESSAGE });
  });

  it('records provider per attempt so /admin/ can split Token Plan from pay-as-you-go', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(quota()).mockResolvedValueOnce(ok()));
    await new ChatClient(options()).call('followup', msg);
    const db = new DatabaseSync(path.join(usage, 'ai-usage.db'), { readOnly: true });
    try {
      expect(db.prepare('SELECT provider, status, http_status AS http FROM ai_usage ORDER BY rowid').all())
        .toEqual([{ provider: 'bailian-token-plan', status: 'failed', http: 429 }, { provider: 'bailian', status: 'succeeded', http: 200 }]);
    } finally { db.close(); }
  });
});
