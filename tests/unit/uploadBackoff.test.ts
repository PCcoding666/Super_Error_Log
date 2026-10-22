/** P0-13：上传队列在 5xx / 断网后的自动重试间隔（浏览器脚本里的同一段函数）。 */
import { describe, expect, it } from 'vitest';
import { UPLOAD_BACKOFF_SCRIPT, UPLOAD_QUEUE_SCRIPT, UPLOAD_RETRY_BASE_MS, UPLOAD_RETRY_MAX_ATTEMPTS, UPLOAD_RETRY_MAX_MS } from '../../src/web/uploadQueue.js';

const backoff = new Function(`${UPLOAD_BACKOFF_SCRIPT};return backoffDelay`)() as (attempt: number, retryAfter: number, rand: number) => number;

describe('upload auto-retry backoff', () => {
  it('doubles from the base, caps at the maximum and never retries faster than a second', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(n => backoff(n, 0, 0.5))).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    expect(UPLOAD_RETRY_BASE_MS).toBe(2000); expect(UPLOAD_RETRY_MAX_MS).toBe(60000);
    expect(backoff(0, 0, 0)).toBeGreaterThanOrEqual(1000);
  });
  it('spreads phones out with ±20% jitter so a whole class does not retry in the same second', () => {
    expect(backoff(3, 0, 0)).toBe(6400);
    expect(backoff(3, 0, 1)).toBe(9600);
  });
  it('waits at least as long as the server asked with Retry-After', () => {
    expect(backoff(1, 30000, 0.5)).toBe(30000);
    expect(backoff(7, 5000, 0.5)).toBe(60000);
  });
  it('is embedded in the queue with a bounded number of automatic attempts', () => {
    expect(UPLOAD_QUEUE_SCRIPT).toContain(UPLOAD_BACKOFF_SCRIPT);
    expect(UPLOAD_QUEUE_SCRIPT).toContain(`var RETRY_MAX=${UPLOAD_RETRY_MAX_ATTEMPTS};`);
    expect(UPLOAD_RETRY_MAX_ATTEMPTS).toBeGreaterThanOrEqual(5);
  });
});
