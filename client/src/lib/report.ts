/**
 * 浏览器端的出错上报（client/ 单页应用）。
 * 老的服务端页面把脚本里的错误放进 sel_tap cookie（src/web/trail.ts 的 `client:xxx`）；单页应用改成攒一小批 JSON
 * POST 到 /s/api/client-log，服务器写一行 `sel_client_event` 日志并记进互动记录（web_error …#client:类别:错误码）。
 *
 * 只报元数据：类别、固定的短错误码、截短的提示文案、页面路由模板（题目 ID 换成 :id）、服务器给的请求 ID、
 * 客户端构建号、是否在线 / 页面是否可见。不报题目、照片、姓名、邀请码、URL 查询串。
 * 节流：同一「类别 + 错误码 + 路由」60 秒内只报一次；一次打开最多 40 条；攒 1.5 秒一起发；关页用 sendBeacon 兜底。
 */
export type ClientEventKind =
  | 'script_error' | 'unhandled_rejection' | 'render_error'
  | 'api_network' | 'api_not_json' | 'api_server_error'
  | 'upload_failed' | 'chooser_blocked';

export interface ClientEventInput {
  /** 固定的短标识（错误类名、上传失败种类、HTTP 状态），不是给人看的文案。 */
  code?: string;
  message?: string;
  /** 服务器响应头 x-sel-request-id（有就带上，日志按它对）。 */
  rid?: string | null;
  status?: number;
  retryable?: boolean;
  component?: string;
}

interface ClientEvent extends ClientEventInput {
  kind: ClientEventKind;
  /** 本条上报自己的编号：页面上显示「错误编号」，服务器日志同一个值。 */
  cid: string;
  route: string;
  at: string;
  build: string;
  online: boolean;
  visible: boolean;
}

export const CLIENT_BUILD: string = typeof __SEL_CLIENT_BUILD__ === 'string' ? __SEL_CLIENT_BUILD__ : 'dev';
const ENDPOINT = '/s/api/client-log';
const DEDUPE_MS = 60_000;
const MAX_PER_PAGE = 40;
const FLUSH_MS = 1500;
const MAX_MESSAGE = 200;

/** 单页应用自己的四个路由：题目 ID 换成 :id；别的一律 /s/*。 */
export function routeTemplate(pathname: string = location.pathname): string {
  const path = pathname.replace(/\/q\/[^/?#]+/, '/q/:id').replace(/\/+$/, '') || '/s';
  return /^\/s(?:\/(?:new|me|q\/:id))?$/.test(path) ? (path === '/s' ? '/s/' : path) : '/s/*';
}

const shortId = (): string => {
  try { return crypto.randomUUID().replace(/-/g, '').slice(0, 10); } catch { return Math.random().toString(36).slice(2, 12); }
};
const clip = (value: string | undefined, max: number): string | undefined => {
  if (!value) return undefined;
  // 去掉可能带查询串的网址，再截短；不留任何内容性的东西。
  const text = value.replace(/https?:\/\/\S+/g, '[url]').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

const seen = new Map<string, number>();
let sent = 0;
let queue: ClientEvent[] = [];
let timer: number | null = null;

function send(events: ClientEvent[], unloading: boolean): void {
  if (events.length === 0) return;
  const body = JSON.stringify({ events });
  if (unloading && typeof navigator.sendBeacon === 'function') {
    try { if (navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }))) return; } catch { /* 退回 fetch */ }
  }
  try {
    void fetch(ENDPOINT, { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'content-type': 'application/json', accept: 'application/json' }, body })
      .catch(() => { /* 上报失败就算了，绝不再为上报失败上报 */ });
  } catch { /* 同上 */ }
}

function flush(unloading = false): void {
  if (timer !== null) { window.clearTimeout(timer); timer = null; }
  if (!navigator.onLine && !unloading) return; // 离线：留在队列里，回到在线再发
  const batch = queue;
  queue = [];
  send(batch, unloading);
}

function schedule(): void {
  if (timer !== null) return;
  timer = window.setTimeout(() => flush(false), FLUSH_MS);
}

/** 记一条；被节流或超出上限时返回 null（页面就不显示编号）。 */
export function report(kind: ClientEventKind, input: ClientEventInput = {}): string | null {
  const route = routeTemplate();
  const key = `${kind}|${input.code ?? ''}|${route}`;
  const now = Date.now();
  const last = seen.get(key);
  if (last !== undefined && now - last < DEDUPE_MS) return null;
  if (sent >= MAX_PER_PAGE) return null;
  seen.set(key, now);
  sent += 1;
  const event: ClientEvent = {
    kind, cid: shortId(), route, at: new Date(now).toISOString(), build: CLIENT_BUILD,
    online: navigator.onLine, visible: document.visibilityState === 'visible',
    code: clip(input.code, 60), message: clip(input.message, MAX_MESSAGE), rid: input.rid ?? undefined,
    status: typeof input.status === 'number' ? input.status : undefined,
    retryable: typeof input.retryable === 'boolean' ? input.retryable : undefined,
    component: clip(input.component, 80),
  };
  queue.push(event);
  schedule();
  return event.cid;
}

let installed = false;
/** 全局兜底：没被任何 catch 接住的脚本错误和 Promise 拒绝；关页前把攒着的发掉。只装一次。 */
export function installGlobalErrorReporting(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('error', event => {
    // 资源加载失败（img/script）走元素自己的 error，不冒泡到这里；这里只有脚本运行时错误。
    const error = event.error as unknown;
    report('script_error', { code: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : event.message });
  });
  window.addEventListener('unhandledrejection', event => {
    const reason = event.reason as unknown;
    report('unhandled_rejection', { code: reason instanceof Error ? reason.name : typeof reason, message: reason instanceof Error ? reason.message : String(reason) });
  });
  window.addEventListener('pagehide', () => flush(true));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(true); });
  window.addEventListener('online', () => flush(false));
}

/** 测试与排查用：现在攒着没发的条数。 */
export function pendingReports(): number { return queue.length; }
