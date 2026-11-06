import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdmissionController, uploadSlotRetryAfterSeconds } from '../../src/mobile/admission.js';
import { MobileRecognitionService } from '../../src/mobile/service.js';
import { MobileRecognitionStore } from '../../src/mobile/store.js';
import { setLogSink } from '../../src/observability/log.js';

describe('upload slot retry-after', () => {
  it('waits out a typical large-photo hold instead of a fixed one second', () => {
    expect(uploadSlotRetryAfterSeconds(0)).toBe(20);
    expect(uploadSlotRetryAfterSeconds(12_000)).toBe(8);
    expect(uploadSlotRetryAfterSeconds(64_000)).toBe(8);
    expect(uploadSlotRetryAfterSeconds(0, 45_000)).toBe(30);
    expect(uploadSlotRetryAfterSeconds(0)).not.toBe(1);
  });

  it('shrinks the estimate as the current holder has already been in the slot', () => {
    let now = 1_000_000;
    const admission = new AdmissionController({ now: () => now });
    expect(admission.tryAcquireUploadSlot('holder')).toEqual({ accepted: true, retryAfterSeconds: 0 });
    expect(admission.tryAcquireUploadSlot('next').retryAfterSeconds).toBe(20);
    now += 12_000;
    expect(admission.tryAcquireUploadSlot('next').retryAfterSeconds).toBe(8);
    admission.releaseUploadSlot('holder');
    expect(admission.tryAcquireUploadSlot('after').accepted).toBe(true);
  });
});

describe('RSS admission log', () => {
  const roots: string[] = [];
  const previous = process.env.SEL_RSS_ADMISSION_MIB;
  afterEach(() => {
    setLogSink(null);
    vi.restoreAllMocks();
    if (previous === undefined) delete process.env.SEL_RSS_ADMISSION_MIB;
    else process.env.SEL_RSS_ADMISSION_MIB = previous;
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('emits sel_admission with service_paused, rssMiB, limitMiB, and a student prefix', async () => {
    const studentId = '6b4e0561-1111-4111-8111-111111111111';
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-rss-'));
    roots.push(root);
    process.env.SEL_RSS_ADMISSION_MIB = '64';
    const lines: string[] = [];
    setLogSink(line => lines.push(line));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = await MobileRecognitionStore.open(path.join(root, studentId));
    const rss = vi.spyOn(process.memoryUsage, 'rss').mockReturnValue(80 * 1024 * 1024);
    const service = new MobileRecognitionService(store, {
      inventory: async () => { throw new Error('unused'); },
      recognizeQuestion: async () => { throw new Error('unused'); },
    });
    expect(service.acceptingJobs()).toBe(false);
    const event = JSON.parse(lines.at(-1) ?? '{}') as { event: string; level: string; code: string; rssMiB: number; limitMiB: number; student?: string };
    expect(event).toMatchObject({ event: 'sel_admission', level: 'warn', code: 'service_paused', rssMiB: 80, limitMiB: 64, student: '6b4e0561' });
    expect(JSON.stringify(event)).not.toContain('1111-4111-8111-111111111111');
    expect(warn).toHaveBeenCalled();
    rss.mockReturnValue(10 * 1024 * 1024);
    lines.length = 0;
    expect(service.acceptingJobs()).toBe(true);
    expect(lines).toHaveLength(0);
  });
});
