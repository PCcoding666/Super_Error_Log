/**
 * Ionic upload auto-retry. Same cadence as src/web/uploadQueue.ts UPLOAD_BACKOFF_SCRIPT:
 * 2s floor, 60s cap, ±20% jitter, never earlier than Retry-After, finite attempts.
 * Permanent image/client errors are not retried. The upload id stays with the entry.
 */

export const UPLOAD_RETRY_BASE_MS = 2_000;
export const UPLOAD_RETRY_MAX_MS = 60_000;
export const UPLOAD_RETRY_MAX_ATTEMPTS = 10;

const NO_AUTO_RETRY = new Set([
  'invalid_image',
  'disk_low',
  'data_quota',
  'payload_too_large',
  'idempotency_conflict',
  'upload_identity_unavailable',
]);

/** Retry-After as milliseconds. Accepts delay-seconds or an HTTP-date. Unreadable values are 0. */
export function parseRetryAfterHeader(value: string | null | undefined, now = Date.now()): number {
  if (!value) return 0;
  const trimmed = value.trim();
  if (!trimmed) return 0;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return 0;
}

/** Milliseconds before automatic attempt `attempt` (1-based). Never earlier than Retry-After. */
export function uploadBackoffDelay(attempt: number, retryAfterMs: number, random: number): number {
  const exponent = Math.max(0, attempt - 1);
  const base = Math.min(UPLOAD_RETRY_MAX_MS, UPLOAD_RETRY_BASE_MS * 2 ** exponent);
  const rand = Number.isFinite(random) ? Math.min(1, Math.max(0, random)) : Math.random();
  let delay = Math.round(base * (0.8 + 0.4 * rand));
  if (retryAfterMs > 0) delay = Math.max(delay, retryAfterMs);
  return Math.max(1000, delay);
}

/** Admission rejects and gateway blips retry themselves. HEIC, invalid images, and other permanent errors do not. */
export function isUploadAutoRetry(input: { kind: string; status: number; code: string | null }): boolean {
  if (input.kind.startsWith('prepare_') || input.kind === 'upload_abort') return false;
  if (input.code && NO_AUTO_RETRY.has(input.code)) return false;
  if (input.status === 429) return input.code === 'busy' || input.code === 'capacity_full';
  if (input.status === 502 || input.status === 503 || input.status === 504) return true;
  if (input.kind === 'upload_network' || input.kind === 'upload_timeout' || input.kind === 'capture_network' || input.kind === 'mode_network') return true;
  return false;
}

export function uploadRetryMessage(code: string | null, waitMs: number, exhausted: boolean): string {
  const seconds = Math.max(1, Math.round(waitMs / 1000));
  if (code === 'busy') {
    return exhausted
      ? '服务器正在收另一张照片。点「再试一次」。'
      : `服务器正在收另一张照片，约 ${seconds} 秒后自动再试。`;
  }
  if (code === 'service_paused' || code === 'paused') {
    return exhausted ? '处理服务忙。点「再试一次」。' : '处理服务忙，稍后自动再试。';
  }
  if (code === 'capacity_full') {
    return exhausted ? '排队已满。点「再试一次」。' : '排队已满，稍后自动再试。';
  }
  return exhausted
    ? '连续几次都没连上服务器，点「再试一次」再试。'
    : `暂时连不上服务器，约 ${seconds} 秒后自动再试。`;
}

export interface UploadRetryInput {
  kind: string;
  status: number;
  code: string | null;
  retryable: boolean;
  retryAfterMs: number;
  attemptsSoFar: number;
  random: number;
}

export type UploadRetryDecision =
  | { action: 'backoff'; attempts: number; waitMs: number; message: string }
  | { action: 'fail'; message: string | null };

/**
 * `message: null` on fail keeps the transport's own text (HEIC, invalid image, and other permanent errors).
 * busy / service_paused / capacity_full never collapse into "the network failed".
 */
export function decideUploadRetry(input: UploadRetryInput): UploadRetryDecision {
  const auto = input.retryable && isUploadAutoRetry(input);
  const attempts = input.attemptsSoFar + 1;
  if (auto && attempts <= UPLOAD_RETRY_MAX_ATTEMPTS) {
    const waitMs = uploadBackoffDelay(attempts, input.retryAfterMs, input.random);
    return { action: 'backoff', attempts, waitMs, message: uploadRetryMessage(input.code, waitMs, false) };
  }
  if (auto || input.code === 'busy' || input.code === 'capacity_full' || input.code === 'service_paused' || input.code === 'paused') {
    return { action: 'fail', message: uploadRetryMessage(input.code, input.retryAfterMs, true) };
  }
  return { action: 'fail', message: null };
}

/** One POST per entry while that entry is preparing, uploading, or waiting out a backoff. */
export class UploadFlightGuard {
  private readonly inflight = new Set<string>();
  private readonly scheduled = new Set<string>();

  holds(key: string): boolean {
    return this.inflight.has(key) || this.scheduled.has(key);
  }

  /** Begin the single in-flight POST. False when one is already running or scheduled for this key. */
  start(key: string): boolean {
    if (this.holds(key)) return false;
    this.inflight.add(key);
    return true;
  }

  finish(key: string): void {
    this.inflight.delete(key);
  }

  /** The POST ended and the next one must wait. */
  schedule(key: string): void {
    this.inflight.delete(key);
    this.scheduled.add(key);
  }

  /** Backoff elapsed. The entry may be queued again. */
  releaseSchedule(key: string): void {
    this.scheduled.delete(key);
  }

  /** 「再试一次」during prepare, upload, or backoff must not open a second POST. */
  manualRetry(key: string): 'ignore' | 'allow' {
    return this.holds(key) ? 'ignore' : 'allow';
  }
}
