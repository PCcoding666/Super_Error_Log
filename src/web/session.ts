/**
 * 学生网页版的 cookie。全部 Path=/s、HttpOnly、SameSite=Lax；非本机地址一律 Secure。
 * 内容（隐私文档 docs/privacy/PRIVACY_AND_MINOR_DATA.md 同步列出）：
 * - sel_device：配对兑换得到的设备令牌（与 App 的令牌同一种，30 天有效，可由管理员撤销）。
 * - sel_consent：看过并同意「上传前看一下」的版本号。
 * - sel_photos：本周照片的两个本机标记（这页没有做错的题 / 移除这张），只存识别任务 ID。
 * - sel_skip：本次打开里点过的「跳过」（会话 cookie，关掉网页即失效，对应 App 的「只记在内存里」）。
 * - sel_a2hs：看过「放到主屏幕」提示。
 * - sel_items_subject：本次浏览错题本选择的学科。
 * 不存任何题目、照片、回答或名字。
 */
import type { Request, Response } from 'express';
import type { StepKind } from './weekPlan.js';

export const COOKIE = {
  device: 'sel_device',
  consent: 'sel_consent',
  photos: 'sel_photos',
  skip: 'sel_skip',
  a2hs: 'sel_a2hs',
  itemsSubject: 'sel_items_subject',
} as const;

export const CONSENT_VERSION = 'v1';
const YEAR_SECONDS = 365 * 24 * 60 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ITEM_ID = /^itm_[0-9a-f]{16}$/;

export function readCookies(request: Request): Record<string, string> {
  const header = request.headers.cookie;
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const raw = part.slice(index + 1).trim();
    if (!name || name in result) continue;
    try { result[name] = decodeURIComponent(raw); } catch { /* 忽略编码坏掉的 cookie */ }
  }
  return result;
}

/** 本机开发 / 测试（http://127.0.0.1、localhost）不加 Secure；其他主机一律 Secure（生产只走 Caddy 的 HTTPS）。 */
export function isLocalHost(request: Request): boolean {
  const host = (request.headers.host ?? '').toLowerCase();
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
}

export function setCookie(request: Request, response: Response, name: string, value: string, maxAgeSeconds: number | null): void {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/s', 'HttpOnly', 'SameSite=Lax'];
  if (maxAgeSeconds !== null) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
  if (!isLocalHost(request)) parts.push('Secure');
  response.append('set-cookie', parts.join('; '));
}

export function clearCookie(request: Request, response: Response, name: string): void {
  setCookie(request, response, name, '', 0);
}

// ---------- 照片标记 ----------

export interface PhotoMarks { pickDone: Set<string>; dismissed: Set<string> }

export function readPhotoMarks(request: Request): PhotoMarks {
  const raw = readCookies(request)[COOKIE.photos] ?? '';
  const marks: PhotoMarks = { pickDone: new Set(), dismissed: new Set() };
  for (const entry of raw.split('.')) {
    const [kind, id] = [entry.slice(0, 1), entry.slice(2)];
    if (!UUID.test(id)) continue;
    if (kind === 'p') marks.pickDone.add(id);
    if (kind === 'd') marks.dismissed.add(id);
  }
  return marks;
}

/** 只保留本周照片的标记（cookie 不会越积越大）。 */
export function writePhotoMarks(request: Request, response: Response, marks: PhotoMarks, keep: Iterable<string>): void {
  const allowed = new Set(keep);
  const entries = [
    ...[...marks.pickDone].filter(id => allowed.has(id)).map(id => `p-${id}`),
    ...[...marks.dismissed].filter(id => allowed.has(id)).map(id => `d-${id}`),
  ].slice(0, 80);
  setCookie(request, response, COOKIE.photos, entries.join('.'), YEAR_SECONDS);
}

// ---------- 本次打开里的「跳过」 ----------

export interface SkipState { steps: Set<StepKind>; passedItems: Set<string> }

export function readSkips(request: Request): SkipState {
  const raw = readCookies(request)[COOKIE.skip] ?? '';
  const state: SkipState = { steps: new Set(), passedItems: new Set() };
  for (const entry of raw.split('.')) {
    if (entry === 'shoot' || entry === 'why' || entry === 'record') state.steps.add(entry);
    else if (ITEM_ID.test(entry)) state.passedItems.add(entry);
  }
  return state;
}

/** 会话 cookie（不设 Max-Age）：关掉网页 / 主屏幕 App 被系统结束后就没了，相当于 App 的「只记在内存里」。 */
export function writeSkips(request: Request, response: Response, state: SkipState): void {
  const entries = [...state.steps, ...[...state.passedItems].slice(0, 20)];
  setCookie(request, response, COOKIE.skip, entries.join('.'), null);
}

export function hasConsent(request: Request): boolean {
  return readCookies(request)[COOKIE.consent] === CONSENT_VERSION;
}

export function giveConsent(request: Request, response: Response): void {
  setCookie(request, response, COOKIE.consent, CONSENT_VERSION, YEAR_SECONDS);
}

export function sawInstallHint(request: Request): boolean {
  return readCookies(request)[COOKIE.a2hs] === '1';
}

export function markInstallHint(request: Request, response: Response): void {
  setCookie(request, response, COOKIE.a2hs, '1', YEAR_SECONDS);
}
