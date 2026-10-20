import { describe, expect, it } from 'vitest';
import {
  aiConcurrency, imageConcurrency, maxLiveWorkers, rssAdmissionThresholdBytes, workerIdleMs,
} from '../../src/studentHost/limits.js';

const MIB = 1024 * 1024;

describe('student host capacity limits', () => {
  it('uses the 4-core defaults when the environment is empty', () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(workerIdleMs(env)).toBe(12 * 60 * 1000);
    expect(maxLiveWorkers(env)).toBe(8);
    expect(aiConcurrency(env)).toBe(2);
    expect(imageConcurrency(env)).toBe(2);
    expect(rssAdmissionThresholdBytes(env)).toBe(512 * MIB);
  });

  it('sizes a worker’s admission from the service budget and the live-worker cap', () => {
    const worker = { SEL_STUDENT_WORKER: '1' } as NodeJS.ProcessEnv;
    expect(rssAdmissionThresholdBytes(worker)).toBe(256 * MIB);
    expect(rssAdmissionThresholdBytes({ ...worker, SEL_SERVICE_MEMORY_MIB: '1024', SEL_MAX_LIVE_WORKERS: '3' })).toBe(192 * MIB);
    expect(rssAdmissionThresholdBytes({ SEL_RSS_ADMISSION_MIB: '300' })).toBe(300 * MIB);
  });

  it('accepts zero for idle exit and the live-worker cap, and rejects junk', () => {
    expect(workerIdleMs({ SEL_WORKER_IDLE_MS: '0' } as NodeJS.ProcessEnv)).toBe(0);
    expect(maxLiveWorkers({ SEL_MAX_LIVE_WORKERS: '0' } as NodeJS.ProcessEnv)).toBe(0);
    expect(() => aiConcurrency({ SEL_GLOBAL_AI_CONCURRENCY: '99' } as NodeJS.ProcessEnv)).toThrow(/SEL_GLOBAL_AI_CONCURRENCY/);
  });
});
