import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { MobileRecognitionStore, IdempotencyConflictError } from '../../src/mobile/store.js';
import { loadMobileConfiguration } from '../../src/mobile/configuration.js';

const directories: string[] = [];
async function fixture(): Promise<{ directory: string; jpeg: Buffer }> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-mobile-store-'));
  directories.push(directory);
  const jpeg = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
  return { directory, jpeg };
}

afterEach(() => directories.splice(0).forEach(directory => fs.rmSync(directory, { recursive: true, force: true })));

describe('MobileRecognitionStore', () => {
  it('atomically persists source bytes, transformed hash and an idempotent queued job with private permissions', async () => {
    const { directory, jpeg } = await fixture();
    const normalized = await sharp(jpeg).rotate().jpeg({ quality: 88 }).toBuffer();
    const store = await MobileRecognitionStore.open(directory);
    const key = crypto.randomUUID();

    const first = await store.createJob({ idempotencyKey: key, photoName: '练习一.jpg', sourceBytes: jpeg, normalizedBytes: normalized });
    const repeated = await store.createJob({ idempotencyKey: key, photoName: 'ignored.jpg', sourceBytes: jpeg, normalizedBytes: normalized });

    expect(first.created).toBe(true);
    expect(repeated.created).toBe(false);
    expect(repeated.job.id).toBe(first.job.id);
    expect((await store.getJob(first.job.id))?.sourceHash).toBe(crypto.createHash('sha256').update(jpeg).digest('hex'));
    expect(await store.readMedia(first.job.id, first.job.sourceMediaId)).toEqual(normalized);
    expect(await store.readSource(first.job.id)).toEqual(normalized);
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(directory, 'jobs', first.job.id, 'job.json')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(directory, 'jobs', first.job.id, 'source-original.jpg')).mode & 0o777).toBe(0o600);
    expect(first.job).not.toHaveProperty('idempotencyKey');
    expect(first.job).not.toHaveProperty('transformedHash');
  });

  it('serializes concurrent idempotency claims and rejects the same key with different source bytes', async () => {
    const { directory, jpeg } = await fixture();
    const store = await MobileRecognitionStore.open(directory);
    const key = crypto.randomUUID();
    const other = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#ff0000' } }).jpeg().toBuffer();
    const attempts = await Promise.all(Array.from({ length: 8 }, () => store.createJob({ idempotencyKey: key, photoName: 'a.jpg', sourceBytes: jpeg, normalizedBytes: jpeg })));

    expect(new Set(attempts.map(result => result.job.id)).size).toBe(1);
    expect(attempts.filter(result => result.created)).toHaveLength(1);
    await expect(store.createJob({ idempotencyKey: key, photoName: 'b.jpg', sourceBytes: other, normalizedBytes: other })).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('marks unfinished paid work interrupted on reopen without changing completed evidence', async () => {
    const { directory, jpeg } = await fixture();
    const store = await MobileRecognitionStore.open(directory);
    const { job } = await store.createJob({ idempotencyKey: crypto.randomUUID(), photoName: 'restart.jpg', sourceBytes: jpeg, normalizedBytes: jpeg });
    job.status = 'processing';
    job.phase = 'questions';
    job.questions = [
      { id: crypto.randomUUID(), number: '1', revision: 2, status: 'ready', selectionEvidence: 'marked_wrong', evidence: null, verification: null, questionMediaId: null, diagramMediaIds: [], error: null, confirmedAt: null },
      { id: crypto.randomUUID(), number: '2', revision: 1, status: 'processing', selectionEvidence: 'unclear', evidence: null, verification: null, questionMediaId: null, diagramMediaIds: [], error: null, confirmedAt: null },
    ];
    await store.saveJob(job);

    const reopened = await MobileRecognitionStore.open(directory);
    const recovered = (await reopened.getJob(job.id))!;
    expect(recovered.status).toBe('interrupted');
    expect(recovered.questions[0]).toMatchObject({ id: job.questions[0]!.id, status: 'ready', revision: 2 });
    expect(recovered.questions[1]).toMatchObject({ id: job.questions[1]!.id, status: 'failed', error: { code: 'interrupted', retryable: true } });
  });

  it('finishes local bookkeeping after a restart when every paid question stage was already durable', async () => {
    const { directory, jpeg } = await fixture(); const store = await MobileRecognitionStore.open(directory);
    const { job } = await store.createJob({ idempotencyKey: crypto.randomUUID(), photoName: 'finalize.jpg', sourceBytes: jpeg, normalizedBytes: jpeg });
    job.status = 'processing'; job.phase = 'questions';
    job.questions = [{ id: crypto.randomUUID(), number: '1', revision: 3, status: 'ready', selectionEvidence: 'unmarked', evidence: null, verification: null, questionMediaId: null, diagramMediaIds: [], error: null, confirmedAt: null }];
    await store.saveJob(job);
    const reopened = await MobileRecognitionStore.open(directory); const recovered = (await reopened.getJob(job.id))!;
    expect(recovered).toMatchObject({ status: 'completed', phase: 'complete', error: null });
    expect(recovered.questions[0]).toMatchObject({ status: 'ready', revision: 3 });
  });

  it('serves only allocated media IDs and retains bounded private attempt records', async () => {
    const { directory, jpeg } = await fixture();
    const store = await MobileRecognitionStore.open(directory);
    const { job } = await store.createJob({ idempotencyKey: crypto.randomUUID(), photoName: 'media.jpg', sourceBytes: jpeg, normalizedBytes: jpeg });
    const mediaId = await store.writeMedia(job.id, jpeg, 'question');
    await store.writeAttempt(job.id, null, { stage: 'inventory', request: { prompt: '完整提示', images: [{ sha256: 'a', bytes: 3 }] }, responseRaw: '{"ok":true}', usage: { prompt_tokens: 2 } });

    expect(await store.readMedia(job.id, mediaId)).toEqual(jpeg);
    await expect(store.readMedia(job.id, '../job.json')).rejects.toThrow();
    const attemptsDir = path.join(directory, 'jobs', job.id, 'attempts');
    const attemptPath = path.join(attemptsDir, fs.readdirSync(attemptsDir)[0]!);
    expect(fs.statSync(attemptPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(attemptPath, 'utf8')).responseRaw).toBe('{"ok":true}');
  });

  it('bounds the final serialized attempt file even when JSON escaping expands a provider response', async () => {
    const { directory, jpeg } = await fixture(); const store = await MobileRecognitionStore.open(directory);
    const { job } = await store.createJob({ idempotencyKey: crypto.randomUUID(), photoName: 'attempt.jpg', sourceBytes: jpeg, normalizedBytes: jpeg });
    await store.writeAttempt(job.id, null, { stage: 'inventory', request: { prompt: 'p' }, responseRaw: '\\"'.repeat(1_100_000), usage: { prompt_tokens: null, completion_tokens: null } });
    const attemptsDir = path.join(directory, 'jobs', job.id, 'attempts'); const attemptPath = path.join(attemptsDir, fs.readdirSync(attemptsDir)[0]!);
    expect(fs.statSync(attemptPath).size).toBeLessThanOrEqual(3_000_000);
    const saved = JSON.parse(fs.readFileSync(attemptPath, 'utf8'));
    expect(saved).toMatchObject({ responseTruncatedForStorage: true, responseOriginalBytes: 2_200_000 });
    expect(saved.responseRaw.length).toBeGreaterThan(0);
  });

  it('skips a corrupt job record but propagates a failed recovery write', async () => {
    const { directory, jpeg } = await fixture(); const corruptId = crypto.randomUUID(); const corruptDir = path.join(directory, 'jobs', corruptId);
    fs.mkdirSync(corruptDir, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(corruptDir, 'job.json'), '{bad', { mode: 0o600 });
    const store = await MobileRecognitionStore.open(directory); expect(await store.listJobs()).toEqual([]);
    const { job } = await store.createJob({ idempotencyKey: crypto.randomUUID(), photoName: 'recovery.jpg', sourceBytes: jpeg, normalizedBytes: jpeg }); job.status = 'processing'; await store.saveJob(job);
    const jobDirectory = path.join(directory, 'jobs', job.id); fs.chmodSync(jobDirectory, 0o500);
    try { await expect(MobileRecognitionStore.open(directory)).rejects.toThrow(); }
    finally { fs.chmodSync(jobDirectory, 0o700); }
  });
});

describe('mobile production configuration', () => {
  const names = ['SEL_MOBILE_MODE', 'SEL_MOBILE_AI_MODE', 'SEL_AI_MODE', 'SEL_MOBILE_AI_BASE_URL', 'SEL_AI_BASE_URL', 'SEL_MOBILE_AI_API_KEY', 'SEL_AI_API_KEY', 'DASHSCOPE_API_KEY', 'SEL_MOBILE_AI_MODEL', 'SEL_AI_MODEL', 'SEL_MOBILE_PAIRING_TOKEN', 'SEL_MOBILE_AI_TIMEOUT_MS', 'SEL_MOBILE_PORT', 'SEL_MOBILE_HOST', 'SEL_MOBILE_DATA_DIR', 'SEL_MOBILE_PAIRING_URL'] as const;
  const withEnvironment = <T>(values: Partial<Record<typeof names[number], string>>, callback: () => T): T => {
    const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
    try {
      for (const name of names) delete process.env[name];
      Object.assign(process.env, values);
      return callback();
    } finally {
      for (const name of names) {
        const value = before[name]; if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  };
  const root = () => { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-mobile-config-')); directories.push(directory); return directory; };
  const valid = { SEL_MOBILE_AI_MODE: 'bailian', SEL_MOBILE_AI_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', SEL_MOBILE_AI_API_KEY: 'synthetic-key', SEL_MOBILE_AI_MODEL: 'qwen3.8-27b', SEL_MOBILE_PAIRING_TOKEN: 'synthetic-pairing-token' };

  it('fails closed for mock mode, a non-Beijing endpoint, or a missing key', () => {
    expect(() => withEnvironment({ ...valid, SEL_MOBILE_AI_MODE: 'mock' }, () => loadMobileConfiguration(root()))).toThrow(/禁止 Mock/);
    expect(() => withEnvironment({ ...valid, SEL_MOBILE_AI_BASE_URL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' }, () => loadMobileConfiguration(root()))).toThrow(/北京/);
    const { SEL_MOBILE_AI_API_KEY: _removed, ...withoutKey } = valid;
    expect(() => withEnvironment(withoutKey, () => loadMobileConfiguration(root()))).toThrow(/密钥/);
  });

  it('keeps the dedicated mobile timeout at 30 minutes without changing web configuration', () => {
    const configuration = withEnvironment(valid, () => loadMobileConfiguration(root()));
    expect(configuration).toMatchObject({ host: '127.0.0.1', port: 3101, mode: 'loopback', vision: { timeoutMs: 1_800_000, bailianOnly: true } });
  });

  it('loopback is the default mode and requires a shared pairing token', () => {
    const { SEL_MOBILE_PAIRING_TOKEN: _token, ...withoutToken } = valid;
    expect(() => withEnvironment(withoutToken, () => loadMobileConfiguration(root()))).toThrow(/回环模式/);
  });

  it('cloud mode rejects the shared pairing token requirement and unknown modes fail closed', () => {
    const { SEL_MOBILE_PAIRING_TOKEN: _token, ...withoutToken } = valid;
    const cloud = withEnvironment({ ...withoutToken, SEL_MOBILE_MODE: 'cloud' }, () => loadMobileConfiguration(root()));
    expect(cloud.mode).toBe('cloud');
    expect(cloud.pairingToken).toBe('');
    expect(() => withEnvironment({ ...valid, SEL_MOBILE_MODE: 'lan' }, () => loadMobileConfiguration(root()))).toThrow(/loopback 或 cloud/);
  });

  it('pairing QR address defaults to the IP entry, may be set to the domain, and anything else fails closed', () => {
    const { SEL_MOBILE_PAIRING_TOKEN: _token, ...withoutToken } = valid;
    const cloud = { ...withoutToken, SEL_MOBILE_MODE: 'cloud' };
    expect(withEnvironment(cloud, () => loadMobileConfiguration(root())).pairingUrl).toBe('https://8.163.96.197');
    expect(withEnvironment({ ...cloud, SEL_MOBILE_PAIRING_URL: 'https://study.pccoding666.com' }, () => loadMobileConfiguration(root())).pairingUrl)
      .toBe('https://study.pccoding666.com');
    expect(() => withEnvironment({ ...cloud, SEL_MOBILE_PAIRING_URL: 'https://evil.example' }, () => loadMobileConfiguration(root()))).toThrow(/SEL_MOBILE_PAIRING_URL/);
  });
});
