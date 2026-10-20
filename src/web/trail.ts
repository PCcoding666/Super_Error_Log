/**
 * 学生网页版的互动记录（docs/web-interaction-trail.md）：每一次看页、点按、提交、跳过、出错，
 * 都经现有的审计日志 `audit()`（audit_event 表 + events.log）记一行，只有四样东西：
 *
 *   created_at = 时间戳
 *   name       = web_view | web_tap | web_submit | web_skip | web_error
 *   entity_type= 「路由模板#动作」，例如 `/s/why/:pid/:itemId/confirm#primary.submit`
 *   entity_id  = 设备 ID（配对兑换得到的那台设备；还没配对时为空）
 *
 * 路由只记模板（题目、练习、照片的 ID 一律换成 `:pid` `:itemId` `:jobId`），动作只记按钮的固定标识；
 * 不记任何内容（题目、回答、照片、名字、配对码、查询参数都不进日志）。
 *
 * 点按由页面脚本放进短命 cookie `sel_tap`（「随机短 ID.角色.按钮标识@页面路径」，最多 6 条），
 * 随下一个请求交过来；不跳页的点按由脚本立刻发一个 HEAD 带过来。同一条点按只记一次（按短 ID 去重）。
 * 关掉脚本时没有点按记录，其余四类照记（都在服务器上判定）。
 */
import type { NextFunction, Request, Response } from 'express';
import { getDb } from '../db/connection.js';
import { audit } from '../services/eventLog.js';
import { clearCookie, readCookies } from './session.js';

export type TrailKind = 'view' | 'tap' | 'submit' | 'skip' | 'error';
export const TRAIL_KINDS: readonly TrailKind[] = ['view', 'tap', 'submit', 'skip', 'error'];
export const TRAIL_COOKIE = 'sel_tap';

const TAP_ROLES = new Set(['primary', 'secondary', 'content', 'top', 'error', 'auto']);
const TAP_ENTRY = /^([a-z0-9]{1,8})\.([a-z]+)\.([A-Za-z0-9_-]{1,40})@(\/s(?:\/[^\s|@]*)?)$/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
const SAFE_ROUTE = /^\/s(?:\/[A-Za-z0-9:_.-]+)*\/?$/;

/** 写一行（失败不影响页面）。 */
export function trail(kind: TrailKind, route: string, action: string, deviceId: string | null): void {
  try { audit(`web_${kind}`, `${route}#${action}`, deviceId ?? undefined); } catch { /* 记录失败不挡学生 */ }
}

/** 页面路径 → 路由模板：ID 换成占位符；带别的东西（不像路由的）一律记成 `/s/*`。 */
export function routeTemplate(pathname: string): string {
  const path = pathname.split('?')[0]!.split('#')[0]!
    .replace(/pkt_[0-9a-f]{16}/g, ':pid')
    .replace(/itm_[0-9a-f]{16}/g, ':itemId')
    .replace(UUID, ':jobId');
  return path.length <= 64 && SAFE_ROUTE.test(path) ? path : '/s/*';
}

export interface TapEntry { id: string; role: string; key: string; route: string }

/** 解析 sel_tap：只认格式对的条目，最多 6 条。 */
export function parseTapCookie(raw: string): TapEntry[] {
  const entries: TapEntry[] = [];
  for (const part of raw.split('|').slice(-6)) {
    const match = TAP_ENTRY.exec(part);
    if (!match || !TAP_ROLES.has(match[2]!)) continue;
    entries.push({ id: match[1]!, role: match[2]!, key: match[3]!, route: routeTemplate(match[4]!) });
  }
  return entries;
}

// 同一条点按可能随两个并发请求一起到（例如跳页时还有图片在加载）：按「设备 + 短 ID」去重。
const seen = new Map<string, true>();
function firstTime(deviceId: string | null, id: string): boolean {
  const key = `${deviceId ?? '-'}:${id}`;
  if (seen.has(key)) return false;
  seen.set(key, true);
  if (seen.size > 2000) seen.delete(seen.keys().next().value!);
  return true;
}

/** 把 cookie 里的点按记下来；返回这次请求是不是脚本的自动刷新。 */
function consumeTaps(raw: string, deviceId: string | null): { autoRefresh: boolean } {
  let autoRefresh = false;
  for (const entry of parseTapCookie(raw)) {
    if (!firstTime(deviceId, entry.id)) continue;
    // 页面脚本的自动动作：refresh = 整页重新载入（R1 的做法，旧页面还可能发）；update = 局部轮询发现状态变了、换了一块（一次状态变化记一次）。
    if (entry.role === 'auto') {
      if (entry.key === 'refresh') autoRefresh = true;
      else if (entry.key === 'update') trail('view', entry.route, 'update', deviceId);
      continue;
    }
    if (entry.role === 'error') trail('error', entry.route, `client:${entry.key}`, deviceId);
    else trail('tap', entry.route, `${entry.role}.${entry.key}`, deviceId);
  }
  return { autoRefresh };
}

/**
 * 是不是「打开了一页」：浏览器直接导航是 document；主屏幕 App 里由 Service Worker 转发的导航是 empty
 * （worker 用 fetch 重新取页面）。图片、脚本、样式不走这里（见 QUIET）。
 */
function isPageLoad(request: Request): boolean {
  const dest = request.headers['sec-fetch-dest'];
  return dest === undefined || dest === 'document' || dest === 'empty';
}

// 不记的请求：静态资源、图片；离线页（只有 Service Worker 预缓存时才会从服务器取，真离线时由 worker 直接给）；
// 语音转写也不在服务器上记（转写请求不往数据目录写任何东西，见 privacy 文档），录音按钮的点按和转写失败由页面脚本当作点按 / 出错记下。
const QUIET = /^\/(?:assets|img)\/|^\/(?:manifest\.webmanifest|sw\.js|voice|offline)$/;

/** 页面的路由模板：匹配到路由时用路由定义；没匹配到的 404 一律 `/s/*`。 */
function routeOf(request: Request, response: Response): string {
  const matched = (request as Request & { route?: { path?: unknown } }).route?.path;
  if (typeof matched === 'string') return matched === '/' ? '/s/' : `/s${matched}`;
  if (response.statusCode === 404) return '/s/*';
  return routeTemplate(`/s${request.path}`);
}

/** 等待页的局部轮询（页面脚本带 x-sel-poll: 1 取同一页）：不算「打开了一页」，状态变了由脚本报一次 update。 */
export function isPoll(request: Request): boolean {
  return request.headers['x-sel-poll'] === '1';
}

/** 每个请求结束时记：看页 / 提交 / 跳过 / 出错。放在路由最前面。 */
export function trailRecorder() {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (!QUIET.test(request.path) && request.method !== 'HEAD') {
      const polled = isPoll(request);
      response.on('finish', () => {
        const route = routeOf(request, response);
        const device = typeof response.locals.deviceId === 'string' ? response.locals.deviceId : null;
        const status = response.statusCode;
        const code = typeof response.locals.trailError === 'string' ? response.locals.trailError : null;
        if (status >= 400 || code) trail('error', route, code ? `${status}:${code}` : String(status), device);
        if (status >= 400) return;
        if (request.method === 'GET') {
          if (status === 200 && isPageLoad(request) && !polled) {
            const view = typeof response.locals.trailView === 'string' ? response.locals.trailView : response.locals.trailRefresh ? 'refresh' : 'open';
            trail('view', route, view, device);
          }
          return;
        }
        if (request.method === 'POST' && !code) {
          const skip = typeof response.locals.trailSkip === 'string' ? response.locals.trailSkip : null;
          if (skip) trail('skip', route, skip, device);
          else trail('submit', route, typeof response.locals.trailAction === 'string' ? response.locals.trailAction : 'submit', device);
        }
      });
    }
    next();
  };
}

/** 鉴权之后：收下 cookie 里的点按并清掉 cookie；脚本发来的 HEAD（不跳页的点按）到这里就结束。 */
export function trailTaps() {
  return (request: Request, response: Response, next: NextFunction): void => {
    const raw = readCookies(request)[TRAIL_COOKIE];
    if (raw !== undefined) {
      const device = typeof response.locals.deviceId === 'string' ? response.locals.deviceId : null;
      const { autoRefresh } = consumeTaps(raw, device);
      if (autoRefresh) response.locals.trailRefresh = true;
      clearCookie(request, response, TRAIL_COOKIE);
      if (request.method === 'HEAD') { response.status(204).end(); return; }
    }
    next();
  };
}

/** 读某台设备的互动记录（测试与排查用；只读审计表）。 */
export interface TrailRow { at: string; kind: TrailKind; route: string; action: string; deviceId: string | null }
export function readTrail(deviceId?: string | null): TrailRow[] {
  const rows = (deviceId === undefined
    ? getDb().prepare("SELECT name, entity_type, entity_id, created_at FROM audit_event WHERE name LIKE 'web\\_%' ESCAPE '\\' ORDER BY created_at, rowid").all()
    : deviceId === null
      ? getDb().prepare("SELECT name, entity_type, entity_id, created_at FROM audit_event WHERE name LIKE 'web\\_%' ESCAPE '\\' AND entity_id IS NULL ORDER BY created_at, rowid").all()
      : getDb().prepare("SELECT name, entity_type, entity_id, created_at FROM audit_event WHERE name LIKE 'web\\_%' ESCAPE '\\' AND entity_id = ? ORDER BY created_at, rowid").all(deviceId)) as Array<{ name: string; entity_type: string | null; entity_id: string | null; created_at: string }>;
  return rows
    .filter(row => TRAIL_KINDS.includes(row.name.slice(4) as TrailKind) && row.entity_type)
    .map(row => {
      const index = row.entity_type!.indexOf('#');
      return { at: row.created_at, kind: row.name.slice(4) as TrailKind, route: row.entity_type!.slice(0, index), action: row.entity_type!.slice(index + 1), deviceId: row.entity_id };
    });
}
