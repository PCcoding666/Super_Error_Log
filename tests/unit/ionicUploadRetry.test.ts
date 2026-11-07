/// <reference path="../../client/src/vite-env.d.ts" />
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UploadFailure, Uploader } from '../../client/src/lib/uploader.js';
import {
  UPLOAD_RETRY_MAX_ATTEMPTS, UploadFlightGuard, decideUploadRetry, isUploadAutoRetry, parseRetryAfterHeader, uploadBackoffDelay, uploadRetryMessage,
} from '../../client/src/lib/uploadBackoff.js';
import { UPLOAD_BACKOFF_SCRIPT, UPLOAD_RETRY_BASE_MS, UPLOAD_RETRY_MAX_ATTEMPTS as SSR_ATTEMPTS, UPLOAD_RETRY_MAX_MS } from '../../src/web/uploadQueue.js';

const serverBackoff = new Function(`${UPLOAD_BACKOFF_SCRIPT};return backoffDelay`)() as (attempt: number, retryAfter: number, rand: number) => number;

describe('ionic upload backoff', () => {
  it('matches the existing page-queue cadence', () => {
    expect(uploadBackoffDelay(1, 0, 0.5)).toBe(serverBackoff(1, 0, 0.5));
    expect([1, 2, 3, 4, 5, 6, 7].map(n => uploadBackoffDelay(n, 0, 0.5))).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    expect(uploadBackoffDelay(3, 0, 0)).toBe(6400);
    expect(uploadBackoffDelay(3, 0, 1)).toBe(9600);
    expect(uploadBackoffDelay(1, 30_000, 0.5)).toBe(30_000);
    expect(uploadBackoffDelay(1, 0, 0.5)).toBeGreaterThanOrEqual(UPLOAD_RETRY_BASE_MS);
    expect(uploadBackoffDelay(7, 0, 0.5)).toBe(UPLOAD_RETRY_MAX_MS);
    expect(UPLOAD_RETRY_MAX_ATTEMPTS).toBe(SSR_ATTEMPTS);
  });

  it('reads Retry-After as seconds or an HTTP date', () => {
    const now = Date.parse('Wed, 21 Oct 2015 07:28:00 GMT');
    expect(parseRetryAfterHeader('20')).toBe(20_000);
    expect(parseRetryAfterHeader('Wed, 21 Oct 2015 07:28:00 GMT', now - 5_000)).toBe(5_000);
    expect(parseRetryAfterHeader('not-a-date', now)).toBe(0);
    expect(parseRetryAfterHeader(null)).toBe(0);
  });

  it('auto-retries admission and gateway blips, not HEIC or invalid images', () => {
    expect(isUploadAutoRetry({ kind: 'upload_429', status: 429, code: 'busy' })).toBe(true);
    expect(isUploadAutoRetry({ kind: 'upload_429', status: 429, code: 'capacity_full' })).toBe(true);
    expect(isUploadAutoRetry({ kind: 'upload_503', status: 503, code: 'service_paused' })).toBe(true);
    expect(isUploadAutoRetry({ kind: 'upload_503', status: 503, code: 'paused' })).toBe(true);
    expect(isUploadAutoRetry({ kind: 'upload_502', status: 502, code: null })).toBe(true);
    expect(isUploadAutoRetry({ kind: 'upload_504', status: 504, code: null })).toBe(true);
    expect(isUploadAutoRetry({ kind: 'upload_network', status: 0, code: null })).toBe(true);
    expect(isUploadAutoRetry({ kind: 'prepare_heic', status: 0, code: null })).toBe(false);
    expect(isUploadAutoRetry({ kind: 'upload_400', status: 400, code: 'invalid_image' })).toBe(false);
    expect(isUploadAutoRetry({ kind: 'upload_503', status: 503, code: 'disk_low' })).toBe(false);
    expect(isUploadAutoRetry({ kind: 'upload_429', status: 429, code: 'rate_limited' })).toBe(false);
    expect(isUploadAutoRetry({ kind: 'upload_abort', status: 0, code: null })).toBe(false);
  });

  it('uses distinct copy for busy, service_paused, and capacity_full', () => {
    expect(uploadRetryMessage('busy', 20_000, false)).toBe('服务器正在收另一张照片，约 20 秒后自动再试。');
    expect(uploadRetryMessage('service_paused', 20_000, false)).toBe('处理服务忙，稍后自动再试。');
    expect(uploadRetryMessage('capacity_full', 30_000, false)).toBe('排队已满，稍后自动再试。');
    expect(uploadRetryMessage('busy', 20_000, true)).toContain('再试一次');
    expect(uploadRetryMessage(null, 2_000, false)).toContain('暂时连不上服务器');
    const heic = decideUploadRetry({ kind: 'prepare_heic', status: 0, code: null, retryable: false, retryAfterMs: 0, attemptsSoFar: 0, random: 0.5 });
    expect(heic).toEqual({ action: 'fail', message: null });
  });
});

describe('upload flight guard', () => {
  it('refuses a second POST for a key that is in flight or backing off', () => {
    const guard = new UploadFlightGuard();
    expect(guard.start('photo')).toBe(true);
    expect(guard.start('photo')).toBe(false);
    expect(guard.manualRetry('photo')).toBe('ignore');
    guard.schedule('photo');
    expect(guard.start('photo')).toBe(false);
    expect(guard.manualRetry('photo')).toBe('ignore');
    guard.releaseSchedule('photo');
    expect(guard.manualRetry('photo')).toBe('allow');
    expect(guard.start('photo')).toBe(true);
  });
});

describe('ionic uploader recovery', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  function harness(fail: () => UploadFailure | string) {
    const sends: string[] = [];
    const scheduled: Array<{ callback: () => void; ms: number }> = [];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'cap-1' }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const uploader = new Uploader({
      prepare: async file => file.type.includes('heic') ? Promise.reject(new Error('decode')) : new Blob(['jpeg'], { type: 'image/jpeg' }),
      random: () => 0.5,
      schedule: (callback, ms) => {
        const item = { callback, ms };
        scheduled.push(item);
        return { cancel: () => { item.callback = () => undefined; } };
      },
      xhrUpload: async (_url, _body, headers) => {
        const id = headers['x-upload-id'] ?? headers.key ?? 'legacy';
        sends.push(id);
        const outcome = fail();
        if (outcome instanceof UploadFailure) throw outcome;
        return outcome;
      },
    });
    uploader.setMode({ kind: 'materials', namespace: 'draft-ns' });
    return { uploader, sends, scheduled };
  }

  async function addPhoto(uploader: Uploader, name = 'page.jpg', type = 'image/jpeg'): Promise<void> {
    uploader.add([new File([Uint8Array.from([1, 2, 3])], name, { type })]);
    await vi.waitFor(() => {
      const state = uploader.entries[0]?.state;
      expect(state === 'backoff' || state === 'failed' || state === 'succeeded').toBe(true);
    });
  }

  it('waits out busy and retries the same upload id without a second in-flight POST', async () => {
    let outcome: UploadFailure | string = new UploadFailure('upload_429', '服务器正在处理另一个上传，请稍后再试。', true, null, 'busy', 20_000, 429);
    const { uploader, sends, scheduled } = harness(() => outcome);
    await addPhoto(uploader);
    const key = uploader.entries[0]!.key;
    expect(sends).toEqual([key]);
    expect(uploader.entries[0]).toMatchObject({ state: 'backoff', message: '服务器正在收另一张照片，约 20 秒后自动再试。' });
    expect(scheduled[0]!.ms).toBe(20_000);
    uploader.retry();
    expect(sends).toEqual([key]);
    outcome = 'asset-1';
    scheduled[0]!.callback();
    await vi.waitFor(() => expect(uploader.entries[0]!.state).toBe('succeeded'));
    expect(sends).toEqual([key, key]);
    expect(uploader.entries[0]!.photoId).toBe('asset-1');
  });

  it('does not open another POST while the first is still uploading', async () => {
    let release: (id: string) => void = () => undefined;
    const { uploader, sends } = harness(() => new Promise(resolve => { release = resolve; }) as unknown as string);
    uploader.add([new File([Uint8Array.from([1])], 'page.jpg', { type: 'image/jpeg' })]);
    await vi.waitFor(() => expect(uploader.entries[0]!.state).toBe('uploading'));
    expect(sends).toHaveLength(1);
    uploader.retry();
    uploader.retry();
    expect(sends).toHaveLength(1);
    expect(uploader.entries[0]!.state).toBe('uploading');
    release('asset-1');
    await vi.waitFor(() => expect(uploader.entries[0]!.state).toBe('succeeded'));
    expect(sends).toHaveLength(1);
  });

  it('names service_paused and capacity_full instead of a network failure', async () => {
    const paused = harness(() => new UploadFailure('upload_503', '处理服务已暂停，请稍后重试。', true, 'abcd1234', 'service_paused', 20_000, 503));
    await addPhoto(paused.uploader);
    expect(paused.uploader.entries[0]!.message).toBe('处理服务忙，稍后自动再试。');
    expect(paused.scheduled[0]!.ms).toBe(20_000);
    const full = harness(() => new UploadFailure('upload_429', '处理队列已满，请稍后重试。', true, null, 'capacity_full', 30_000, 429));
    await addPhoto(full.uploader);
    expect(full.uploader.entries[0]!.message).toBe('排队已满，稍后自动再试。');
    expect(full.scheduled[0]!.ms).toBe(30_000);
  });

  it('does not auto-retry HEIC or invalid_image', async () => {
    const heic = harness(() => 'unused');
    await addPhoto(heic.uploader, 'page.heic', 'image/heic');
    expect(heic.sends).toHaveLength(0);
    expect(heic.scheduled).toHaveLength(0);
    expect(heic.uploader.entries[0]).toMatchObject({ state: 'failed', retryable: false });
    expect(heic.uploader.entries[0]!.message).toContain('HEIC');
    const bad = harness(() => new UploadFailure('upload_400', '照片无法读取、已损坏或超过像素限制，请补拍。', false, null, 'invalid_image', 0, 400));
    await addPhoto(bad.uploader);
    expect(bad.sends).toHaveLength(1);
    expect(bad.scheduled).toHaveLength(0);
    expect(bad.uploader.entries[0]).toMatchObject({ state: 'failed', retryable: false, message: '照片无法读取、已损坏或超过像素限制，请补拍。' });
  });

  it('stops automatic retries after the shared attempt cap and still allows a manual retry', async () => {
    const { uploader, sends, scheduled } = harness(() => new UploadFailure('upload_502', 'bad gateway', true, null, null, 0, 502));
    await addPhoto(uploader);
    for (let n = 1; n <= UPLOAD_RETRY_MAX_ATTEMPTS; n += 1) {
      expect(uploader.entries[0]!.state).toBe('backoff');
      scheduled[n - 1]!.callback();
      await vi.waitFor(() => expect(sends).toHaveLength(n + 1));
    }
    expect(uploader.entries[0]!.state).toBe('failed');
    expect(uploader.entries[0]!.retryable).toBe(true);
    expect(uploader.entries[0]!.message).toContain('再试一次');
    expect(sends).toHaveLength(UPLOAD_RETRY_MAX_ATTEMPTS + 1);
    uploader.retry();
    await vi.waitFor(() => expect(sends.length).toBeGreaterThan(UPLOAD_RETRY_MAX_ATTEMPTS + 1));
    expect(sends.every(id => id === uploader.entries[0]!.key)).toBe(true);
  });

  it('keeps the recovery policy wired into the client uploader', () => {
    const source = readFileSync(new URL('../../client/src/lib/uploader.ts', import.meta.url), 'utf8');
    expect(source).toContain('decideUploadRetry');
    expect(source).toContain('manualRetry');
    expect(source).toContain("'x-upload-id': entry.key");
    expect(source).toContain('parseRetryAfterHeader');
  });
});
