import type { CaptureUploadHints } from './captureSession.js';

/**
 * 拍照上传（搬自旧页面脚本 src/web/photoUpload.ts / uploadQueue.ts 的核心约定）：
 * - 先在浏览器里用 canvas 转成 JPEG（最长边 4096、去拍摄信息、超过 15 MB 逐级降质量），转换成功才上传；
 * - 每张照片一个幂等 key（UUID），重试用同一个 key 和同一份转换结果，服务器不会重复登记；
 * - 2xx 但响应不是约定形状不算成功；图片本身的问题不提供重试，其余失败可重试；
 * - busy / capacity_full / service_paused 和 502/503/504 按 Retry-After 自动退避，同一张照片不会叠出第二个 POST；
 * - 准备和上传单并发，避免手机同时持有多张大画布。
 * 旧流程（/s/capture）和材料流程（/s/materials/*）两套端点都支持；两者由 /s/api/intake 的 mode 决定。
 * 暂未搬过来的：材料流程把待传照片存进 IndexedDB、关页后继续传。
 */
export const MAX_UPLOAD_EDGE = 4096;
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const QUALITIES = [0.92, 0.85, 0.78, 0.7];
const PREPARE_MS = 30_000;
const UPLOAD_MS = 120_000;

export type UploadState = 'queued' | 'preparing' | 'uploading' | 'backoff' | 'succeeded' | 'failed';
export interface UploadEntry {
  key: string;
  name: string;
  state: UploadState;
  progress: number;
  message: string;
  retryable: boolean;
  previewUrl: string | null;
  /** 服务器返回的照片 id（旧流程 jobId / 材料流程 assetId）。 */
  photoId: string | null;
  file: File | null;
  blob: Blob | null;
  /** Sent with the upload so the extract pipeline knows single page vs one multi-page set. */
  hints: CaptureUploadHints;
  /** Pages that share a setId are one capture. Null is the ordinary single-page stream. */
  setId: string | null;
}
export type { CaptureUploadHints };
export type UploadMode = { kind: 'legacy' } | { kind: 'materials'; namespace: string };

import { report } from './report.js';
import { decideUploadRetry, parseRetryAfterHeader, UploadFlightGuard, type UploadRetryDecision } from './uploadBackoff.js';

/** requestId：服务器给这次上传请求的编号（响应头 x-sel-request-id）；服务器那边出错时拼进提示，学生报编号就能查到。 */
export class UploadFailure extends Error {
  constructor(
    public kind: string,
    message: string,
    public retryable: boolean,
    public requestId: string | null = null,
    public code: string | null = null,
    public retryAfterMs = 0,
    public status = 0,
  ) { super(message); this.name = 'UploadFailure'; }
}

const uuid = (): string => crypto.randomUUID();
function isHeic(file: File | null): boolean {
  if (!file) return false;
  const type = (file.type || '').toLowerCase();
  return type.includes('heic') || type.includes('heif') || /\.hei[cf]$/i.test(file.name || '');
}

function failureFrom(error: unknown, entry: UploadEntry): UploadFailure {
  if (error instanceof UploadFailure) return error;
  if (error instanceof Error && error.message === 'too_big') return new UploadFailure('prepare_big', '这张照片转出来还是太大，换一张试试。', false);
  if (error instanceof Error && error.message === 'prepare_timeout') return new UploadFailure('prepare_timeout', '准备照片超时了。点「再试一次」，或者换一张。', true);
  if (error instanceof Error && error.message === 'encode') return new UploadFailure('prepare_encode', '照片转换没完成。点「再试一次」，或者换一张。', true);
  if (isHeic(entry.file)) return new UploadFailure('prepare_heic', '这张照片是 HEIC 格式，这个浏览器读不了。用 iPhone 自带的 Safari 打开这个网页再选一次，或者换一张 JPEG 照片。', false);
  return new UploadFailure('prepare_decode', '这个浏览器读不了这张照片。换 Safari 打开试试，或者选一张 JPEG 照片。', false);
}

export function prepare(file: Blob): Promise<Blob> {
  return new Promise((resolve, reject) => {
    let url: string | null = null, canvas: HTMLCanvasElement | null = null, done = false;
    const img = new Image();
    const timer = setTimeout(() => finish(new Error('prepare_timeout')), PREPARE_MS);
    function finish(error: Error | null, blob?: Blob): void {
      if (done) return; done = true; clearTimeout(timer); img.onload = img.onerror = null;
      if (url) URL.revokeObjectURL(url); if (canvas) { canvas.width = 0; canvas.height = 0; }
      if (error) reject(error); else resolve(blob!);
    }
    img.onload = () => {
      if (done) return;
      try {
        const w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) { finish(new Error('decode')); return; }
        const scale = Math.min(1, MAX_UPLOAD_EDGE / Math.max(w, h));
        canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(w * scale)); canvas.height = Math.max(1, Math.round(h * scale));
        const context = canvas.getContext('2d');
        if (!context) { finish(new Error('encode')); return; }
        context.drawImage(img, 0, 0, canvas.width, canvas.height);
        let i = 0;
        const encode = (): void => {
          if (done) return;
          try {
            canvas!.toBlob(blob => {
              if (done) return;
              if (!blob || !blob.size || blob.type !== 'image/jpeg') { finish(new Error('encode')); return; }
              if (blob.size <= MAX_UPLOAD_BYTES) { finish(null, blob); return; }
              if (i >= QUALITIES.length - 1) { finish(new Error('too_big')); return; }
              i += 1; encode();
            }, 'image/jpeg', QUALITIES[i]);
          } catch { finish(new Error('encode')); }
        };
        encode();
      } catch { finish(new Error('encode')); }
    };
    img.onerror = () => finish(new Error('decode'));
    try { url = URL.createObjectURL(file); img.src = url; } catch { finish(new Error('decode')); }
  });
}

function readHeader(xhr: XMLHttpRequest, name: string): string | null {
  try { return xhr.getResponseHeader(name); } catch { return null; }
}

export type XhrUpload = (url: string, body: FormData, headers: Record<string, string>, onProgress: (p: number) => void, accept: (status: number, body: unknown) => string | null) => Promise<string>;

export interface UploaderDeps {
  prepare?: (file: Blob) => Promise<Blob>;
  xhrUpload?: XhrUpload;
  random?: () => number;
  schedule?: (callback: () => void, ms: number) => { cancel(): void };
}

function defaultSchedule(callback: () => void, ms: number): { cancel(): void } {
  const timer = setTimeout(callback, ms);
  return { cancel: () => clearTimeout(timer) };
}

function xhrUpload(url: string, body: FormData, headers: Record<string, string>, onProgress: (p: number) => void, accept: (status: number, body: unknown) => string | null): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: UploadFailure | null, id?: string): void => { if (settled) return; settled = true; if (error) reject(error); else resolve(id!); };
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url); xhr.timeout = UPLOAD_MS;
      xhr.setRequestHeader('accept', 'application/json');
      for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
      xhr.upload.onprogress = event => { if (!settled && event.lengthComputable && event.total > 0) onProgress(Math.min(100, Math.round((event.loaded * 100) / event.total))); };
      xhr.onload = () => {
        let parsed: unknown = null;
        try { parsed = JSON.parse(xhr.responseText); } catch { /* 不是 JSON */ }
        const id = xhr.status >= 200 && xhr.status < 300 ? accept(xhr.status, parsed) : null;
        if (id) { finish(null, id); return; }
        const rid = readHeader(xhr, 'x-sel-request-id');
        const retryAfterMs = parseRetryAfterHeader(readHeader(xhr, 'retry-after'));
        const error = (parsed as { error?: { message?: string; code?: string; requestId?: string } } | null)?.error;
        const code = typeof error?.code === 'string' ? error.code : null;
        if (error && typeof error.message === 'string') finish(new UploadFailure(`upload_${xhr.status}`, error.message, xhr.status !== 400 && code !== 'invalid_image', error.requestId ?? rid, code, retryAfterMs, xhr.status));
        else finish(new UploadFailure(xhr.status >= 500 ? 'upload_server' : 'upload_bad', '没传上去。过一会儿再试，照片还在这个页面里。', true, rid, null, retryAfterMs, xhr.status));
      };
      xhr.ontimeout = () => finish(new UploadFailure('upload_timeout', '上传超时了。照片还在这个页面里，点「再试一次」。', true));
      xhr.onerror = () => finish(new UploadFailure('upload_network', '网络没连上，没传上去。照片还在这个页面里。', true));
      xhr.onabort = () => finish(new UploadFailure('upload_abort', '上传中断了。照片还在这个页面里，点「再试一次」。', true));
      xhr.send(body);
    } catch { finish(new UploadFailure('upload_network', '没传上去。点「再试一次」，或者重新选择照片。', true)); }
  });
}

type Listener = () => void;

const BATCH_KEY = 'sel-intake-batch';

export class Uploader {
  entries: UploadEntry[] = [];
  /** 本批次传好的照片 id：录入态据此决定展开哪几张；存在本标签页的 sessionStorage，刷新不丢。 */
  batchIds: string[] = [];
  private batchClosed = false;
  private listeners = new Set<Listener>();
  private active = 0;
  /** 还没问过服务器时为 null：第一张发出去之前先取（材料流程不接受旧端点）。 */
  private mode: UploadMode | null = null;
  private modeRequest: Promise<UploadMode> | null = null;
  private materialsCaptureRequestId = uuid();
  /** One slot per multi-page set, plus `ambient` for single-page uploads. */
  private captureSlots = new Map<string, { requestId: string; id: string | null }>();
  private readonly flights = new UploadFlightGuard();
  private readonly timers = new Map<string, { cancel(): void }>();
  private readonly attempts = new Map<string, number>();

  constructor(private readonly deps: UploaderDeps = {}) { try { this.batchIds = JSON.parse(sessionStorage.getItem(BATCH_KEY) ?? '[]') as string[]; } catch { this.batchIds = []; } }
  subscribe(listener: Listener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private saveBatch(): void { try { sessionStorage.setItem(BATCH_KEY, JSON.stringify(this.batchIds)); } catch { /* 隐私模式 */ } }
  /** 点了「完成」：这一批结束，下次选照片开新的一批。 */
  finishBatch(): void {
    this.batchClosed = true;
    for (const entry of this.entries) if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
    this.entries = this.entries.filter(entry => entry.state !== 'succeeded');
    this.emit();
  }
  private emit(): void { this.entries = [...this.entries]; for (const listener of this.listeners) listener(); }
  setMode(mode: UploadMode): void {
    const same = this.mode !== null && mode.kind === this.mode.kind && (mode.kind !== 'materials' || this.mode.kind !== 'materials' || mode.namespace === this.mode.namespace);
    if (same) return;
    this.mode = mode; this.materialsCaptureRequestId = uuid(); this.captureSlots.delete('ambient');
  }
  /** 拍摄条据此决定要不要显示「多页」。生产邀请码空间是 materials；旧单学生演示才是 legacy。 */
  route(): Promise<UploadMode> { return this.resolveMode(); }
  /** Null until the first successful answer. A later mount can skip the pending frame. */
  knownRoute(): UploadMode | null { return this.mode; }
  /** 首次上传前向服务器确认该走哪套端点；网络失败按可重试处理，照片留在队列里。 */
  private resolveMode(): Promise<UploadMode> {
    if (this.mode) return Promise.resolve(this.mode);
    this.modeRequest ??= (async () => {
      let response: Response;
      try { response = await fetch('/s/api/upload', { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } }); }
      catch { throw new UploadFailure('mode_network', '网络没连上，没传上去。照片还在这个页面里。', true); }
      const body = (await response.json().catch(() => null)) as { mode?: string; draftNamespace?: string | null; error?: { message?: string } } | null;
      if (!response.ok || !body || (body.mode !== 'legacy' && body.mode !== 'materials')) throw new UploadFailure('mode_unavailable', body?.error?.message ?? '暂时连不上服务器，稍后再试。', response.status !== 400, null, null, parseRetryAfterHeader(response.headers.get('retry-after')), response.status);
      const mode: UploadMode = body.mode === 'materials' && body.draftNamespace ? { kind: 'materials', namespace: body.draftNamespace } : { kind: 'legacy' };
      this.setMode(mode);
      return mode;
    })().finally(() => { this.modeRequest = null; });
    return this.modeRequest;
  }
  get busy(): boolean { return this.entries.some(entry => entry.state === 'queued' || entry.state === 'preparing' || entry.state === 'uploading' || entry.state === 'backoff'); }
  /** 本批里已经传好的张数；录入态据此等服务器把题找出来。 */
  get succeeded(): number { return this.entries.filter(entry => entry.state === 'succeeded').length; }

  add(files: File[], detail?: { hints?: CaptureUploadHints | CaptureUploadHints[]; setId?: string | null }): void {
    if (this.batchClosed) {
      this.batchClosed = false; this.batchIds = []; this.saveBatch();
      const kept = new Set<string>();
      this.entries = this.entries.filter(entry => {
        const keep = (entry.state === 'failed' && entry.retryable) || entry.state === 'backoff';
        if (keep) kept.add(entry.key);
        return keep;
      });
      for (const [key, timer] of this.timers) if (!kept.has(key)) { timer.cancel(); this.timers.delete(key); this.flights.releaseSchedule(key); this.flights.finish(key); this.attempts.delete(key); }
    }
    files.forEach((file, index) => {
      let previewUrl: string | null = null;
      try { previewUrl = URL.createObjectURL(file); } catch { previewUrl = null; }
      const hints = Array.isArray(detail?.hints) ? (detail.hints[index] ?? { captureMode: 'single' as const }) : (detail?.hints ?? { captureMode: 'single' as const });
      this.entries.push({ key: uuid(), name: file.name || '照片', state: 'queued', progress: 0, message: '等待上传', retryable: false, previewUrl, photoId: null, file, blob: null, hints, setId: detail?.setId ?? null });
    });
    this.emit();
    this.pump();
  }
  retry(): void {
    for (const entry of this.entries) {
      // A tap while this photo is preparing, uploading, or already waiting must not open a second POST.
      if (entry.state !== 'failed' || !entry.retryable || this.flights.manualRetry(entry.key) === 'ignore') continue;
      this.attempts.delete(entry.key);
      entry.state = 'queued'; entry.progress = 0; entry.message = '等待上传';
    }
    this.emit(); this.pump();
  }
  private pump(): void {
    while (this.active < 1) {
      const entry = this.entries.find(candidate => candidate.state === 'queued' && !this.flights.holds(candidate.key));
      if (!entry) break;
      this.active += 1;
      void this.process(entry).finally(() => { this.active -= 1; this.pump(); });
    }
    this.emit();
  }
  private async process(entry: UploadEntry): Promise<void> {
    if (entry.state !== 'queued' || !this.flights.start(entry.key)) return;
    let scheduled = false;
    try {
      entry.state = 'preparing'; entry.message = '正在准备照片…'; this.emit();
      entry.blob = entry.blob ?? await (this.deps.prepare ?? prepare)(entry.file!);
      entry.state = 'uploading'; entry.progress = 0; entry.message = '正在上传…'; this.emit();
      const photoId = await this.send(entry);
      entry.photoId = photoId; entry.state = 'succeeded'; entry.progress = 100; entry.message = '已上传 · AI 正在找题'; entry.blob = null; entry.file = null;
      this.attempts.delete(entry.key);
      if (!this.batchIds.includes(photoId)) { this.batchIds = [...this.batchIds, photoId]; this.saveBatch(); }
    } catch (error) {
      const failure = failureFrom(error, entry);
      try { report('upload_failed', { code: failure.kind, message: failure.message, retryable: failure.retryable, rid: failure.requestId, status: failure.status || undefined }); } catch { /* 上报失败不影响这张照片还在不在 */ }
      const decision = decideUploadRetry({
        kind: failure.kind, status: failure.status, code: failure.code, retryable: failure.retryable,
        retryAfterMs: failure.retryAfterMs, attemptsSoFar: this.attempts.get(entry.key) ?? 0, random: this.deps.random?.() ?? Math.random(),
      });
      if (decision.action === 'backoff') {
        this.armBackoff(entry, decision);
        scheduled = true;
        return;
      }
      const serverSide = Boolean(failure.requestId && (failure.kind === 'upload_server' || failure.kind === 'upload_bad' || /^upload_5\d\d$/.test(failure.kind)));
      const text = decision.message ?? failure.message;
      entry.state = 'failed'; entry.progress = 0; entry.retryable = failure.retryable;
      entry.message = serverSide ? `${text}（错误编号 ${failure.requestId}）` : text;
      if (!failure.retryable) { entry.file = null; entry.blob = null; }
    } finally {
      if (!scheduled) this.flights.finish(entry.key);
      this.emit();
    }
    if (entry.setId) void this.settleSet(entry.setId);
  }
  /** Same upload id, one timer. A second tap while this is armed does not send. */
  private armBackoff(entry: UploadEntry, decision: Extract<UploadRetryDecision, { action: 'backoff' }>): void {
    this.attempts.set(entry.key, decision.attempts);
    this.flights.schedule(entry.key);
    entry.state = 'backoff'; entry.progress = 0; entry.retryable = true; entry.message = decision.message;
    this.timers.get(entry.key)?.cancel();
    const handle = (this.deps.schedule ?? defaultSchedule)(() => {
      this.timers.delete(entry.key);
      this.flights.releaseSchedule(entry.key);
      if (!this.entries.includes(entry) || entry.state !== 'backoff') return;
      entry.state = 'queued'; entry.progress = 0; entry.message = '等待上传';
      this.emit();
      this.pump();
    }, decision.waitMs);
    this.timers.set(entry.key, handle);
  }
  /** A page that can never be uploaded must not leave the saved pages waiting. Retryable failures stay open. */
  private async settleSet(setId: string): Promise<void> {
    const mates = this.entries.filter(item => item.setId === setId);
    if (mates.some(item => item.state === 'queued' || item.state === 'preparing' || item.state === 'uploading' || item.state === 'backoff')) return;
    if (mates.some(item => item.state === 'failed' && item.retryable)) return;
    if (mates.every(item => item.state === 'succeeded')) return;
    const slot = this.captureSlots.get(setId);
    const mode = this.mode;
    if (!slot?.id || mode?.kind !== 'materials') return;
    const action = mates.some(item => item.state === 'succeeded') ? 'complete' : 'abandon';
    try {
      await fetch(`/s/materials/captures/${slot.id}/${action}`, { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/json', 'x-draft-namespace': mode.namespace } });
    } catch { /* 服务器会在等待结束后用已经收到的页继续。 */ }
  }
  /** Same request id retries the same capture. A multi-page set does not share the single-page capture. */
  private async ensureCapture(namespace: string, key: string, requestId: string): Promise<string> {
    let slot = this.captureSlots.get(key);
    if (!slot) { slot = { requestId, id: null }; this.captureSlots.set(key, slot); }
    if (slot.id) return slot.id;
    let response: Response;
    try { response = await fetch('/s/materials/captures', { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/json', 'x-draft-namespace': namespace }, body: JSON.stringify({ requestId: slot.requestId }) }); }
    catch { throw new UploadFailure('capture_network', '网络没连上，没传上去。照片还在这个页面里。', true); }
    const body = (await response.json().catch(() => ({}))) as { id?: string; error?: { message?: string; code?: string } };
    if (!response.ok || !body.id) throw new UploadFailure('capture', body.error?.message ?? '暂时无法上传，稍后再试。', response.status >= 500 || response.status === 429, null, body.error?.code ?? null, parseRetryAfterHeader(response.headers.get('retry-after')), response.status);
    slot.id = body.id;
    return slot.id;
  }
  private async send(entry: UploadEntry): Promise<string> {
    const onProgress = (p: number): void => { entry.progress = p; entry.message = p >= 100 ? '上传完成，正在处理照片…' : `正在上传 ${p}%`; this.emit(); };
    const mode = await this.resolveMode();
    const hintsJson = JSON.stringify(entry.hints);
    if (mode.kind === 'legacy') {
      const data = new FormData();
      data.append('key', entry.key);
      data.append('hints', hintsJson);
      data.append('photo', entry.blob!, 'photo.jpg');
      return (this.deps.xhrUpload ?? xhrUpload)('/s/capture', data, {}, onProgress, (_status, body) => {
        const value = body as { ok?: boolean; jobId?: string } | null;
        return value && value.ok === true && typeof value.jobId === 'string' && value.jobId ? value.jobId : null;
      });
    }
    const namespace = mode.namespace;
    const captureId = await this.ensureCapture(namespace, entry.setId ?? 'ambient', entry.setId ?? this.materialsCaptureRequestId);
    const data = new FormData();
    data.append('captureId', captureId);
    data.append('hints', hintsJson);
    data.append('photo', entry.blob!, 'photo.jpg');
    return (this.deps.xhrUpload ?? xhrUpload)('/s/materials/uploads', data, { 'x-draft-namespace': namespace, 'x-upload-id': entry.key }, onProgress, (_status, body) => {
      const value = body as { ok?: boolean; assetId?: string; job?: { id?: string; kind?: string } } | null;
      return value && value.ok === true && typeof value.assetId === 'string' && value.assetId && value.job?.kind === 'extract' ? value.assetId : null;
    });
  }
}

export const uploader = new Uploader();
