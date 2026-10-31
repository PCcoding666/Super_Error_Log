/**
 * 学生邀请码网关的可观测性（2026-11-01）：真实网关 + 真实 fork 的合成 worker，拦下主进程写 stderr 的结构化日志行。
 * 覆盖：每个请求一个请求 ID 并回给浏览器、网关访问日志带学生前缀与状态码、登录失败 / 伪造会话 / 跨站提交都写明原因、
 * worker 拉起与崩溃都有日志、worker 接口出错时 JSON 里带错误编号（与响应头同一个值）。
 * 不读 .env 与 data/，不调真实模型。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StudentRegistry } from '../../src/studentHost/registry.js';
import { createStudentHostGateway, SESSION_COOKIE, type StudentHostGateway } from '../../src/studentHost/router.js';
import { StudentWorkerPool } from '../../src/studentHost/workers.js';
import { RateLimiter } from '../../src/mobile/rateLimit.js';
import { setLogSink } from '../../src/observability/log.js';

type LogLine = Record<string, unknown> & { event: string };

const roots: string[] = [];
const gateways: StudentHostGateway[] = [];
const servers: Server[] = [];
let lines: LogLine[] = [];

beforeEach(() => {
  lines = [];
  setLogSink(line => { try { lines.push(JSON.parse(line) as LogLine); } catch { /* 非 JSON 行不管 */ } });
});

afterEach(async () => {
  setLogSink(null);
  await Promise.all(gateways.splice(0).map(gateway => gateway.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

class Browser {
  cookies = new Map<string, string>();
  constructor(readonly base: string) {}
  async request(pathname: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('user-agent', IPHONE);
    if (this.cookies.size > 0) headers.set('cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    if (init.method === 'POST' && !headers.has('origin')) headers.set('origin', this.base);
    const response = await fetch(`${this.base}${pathname}`, { ...init, headers, redirect: 'manual' });
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const index = pair!.indexOf('=');
      const name = pair!.slice(0, index); const value = pair!.slice(index + 1);
      if (/Max-Age=0/.test(line)) this.cookies.delete(name); else this.cookies.set(name, value);
    }
    return response;
  }
  get(pathname: string, headers: Record<string, string> = {}): Promise<Response> { return this.request(pathname, { headers }); }
  form(pathname: string, fields: Record<string, string>): Promise<Response> {
    return this.request(pathname, { method: 'POST', body: new URLSearchParams(fields), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  }
  json(pathname: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return this.request(pathname, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', accept: 'application/json', ...headers } });
  }
}

interface Host { base: string; registry: StudentRegistry; pool: StudentWorkerPool }

async function setupHost(): Promise<Host> {
  const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-trace-'));
  roots.push(hostDir);
  const registry = StudentRegistry.open(hostDir);
  const pool = new StudentWorkerPool({ dirFor: id => registry.studentDir(id), env: { SEL_STUDENT_WORKER_FAKE: '1', SEL_AI_MODE: 'mock', SEL_E2E_LEGACY_CAPTURE: '1' } });
  const gateway = await createStudentHostGateway({ hostDir, registry, pool, failureDelayMs: 0 });
  gateways.push(gateway);
  const app = express();
  app.use('/s', gateway.router({ limiter: new RateLimiter(), ipOf: request => request.socket.remoteAddress ?? 'unknown' }));
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, registry, pool };
}

async function login(host: Host): Promise<{ browser: Browser; studentId: string }> {
  const { studentId } = host.registry.createStudent();
  const { code } = host.registry.issueInvitation(studentId);
  const browser = new Browser(host.base);
  expect((await browser.form('/s/login', { code })).status).toBe(303);
  expect(browser.cookies.has(SESSION_COOKIE)).toBe(true);
  expect((await browser.form('/s/stage', { grade: '初中' })).status).toBe(303);
  return { browser, studentId };
}

const of = (event: string): LogLine[] => lines.filter(line => line.event === event);
async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('等待超时');
}

describe('学生网关可观测性', () => {
  it('每个请求有请求 ID 回给浏览器；访问日志带学生前缀、路由模板、状态码与耗时；worker 拉起有日志', async () => {
    const host = await setupHost();
    const { browser, studentId } = await login(host);
    const response = await browser.get('/s/api/settings', { accept: 'application/json' });
    expect(response.status).toBe(200);
    const rid = response.headers.get('x-sel-request-id');
    expect(rid).toMatch(/^[a-z0-9]{12}$/);
    const access = of('sel_http').find(line => line.rid === rid);
    expect(access).toBeDefined();
    expect(access).toMatchObject({ level: 'info', method: 'GET', route: '/s/api/settings', status: 200, student: studentId.slice(0, 8), ua: 'ios-safari' });
    expect(typeof access!.ms).toBe('number');
    expect(JSON.stringify(access)).not.toContain(browser.cookies.get(SESSION_COOKIE)!);
    // 同一学生的 worker 拉起：一行 sel_worker_start，带耗时与存活数。
    const started = of('sel_worker_start').filter(line => line.student === studentId.slice(0, 8));
    expect(started).toHaveLength(1);
    expect(typeof started[0]!.ms).toBe('number');
    expect(started[0]!.live).toBe(1);
    // 成功的图片 / 静态资源不记访问日志；出错的才记。
    expect((await browser.get('/s/manifest.webmanifest')).status).toBe(200);
    expect(of('sel_http').some(line => line.route === '/s/manifest.webmanifest')).toBe(false);
    // 学生 ID 全文、邀请码、会话令牌都不该出现在任何一行里。
    const dump = JSON.stringify(lines);
    expect(dump).not.toContain(studentId);
    expect(dump).not.toContain(browser.cookies.get(SESSION_COOKIE)!);
  }, 60_000);

  it('登录失败、伪造会话、跨站提交、被拒路径：访问日志写明原因', async () => {
    const host = await setupHost();
    const { browser } = await login(host);
    const okLogin = of('sel_login').find(line => line.outcome === 'ok');
    expect(okLogin).toMatchObject({ level: 'info', ua: 'ios-safari' });
    expect(typeof okLogin!.ip).toBe('string');
    expect(JSON.stringify(okLogin)).not.toContain(browser.cookies.get(SESSION_COOKIE)!);

    const bad = await new Browser(host.base).form('/s/login', { code: 'AAAA-BBBB-CCCC' });
    expect(bad.status).toBe(400);
    const failedLogin = of('sel_login').find(line => line.outcome !== 'ok');
    expect(failedLogin).toMatchObject({ level: 'warn', outcome: 'invalid_code' });
    expect(of('sel_http').find(line => line.rid === bad.headers.get('x-sel-request-id'))).toMatchObject({ status: 400, reason: 'invalid_code' });

    const forged = await fetch(`${host.base}/s/api/notebook`, { headers: { cookie: `${SESSION_COOKIE}=forged-token`, accept: 'application/json', 'user-agent': IPHONE } });
    expect(forged.status).toBe(401);
    expect(of('sel_http').find(line => line.rid === forged.headers.get('x-sel-request-id'))).toMatchObject({ status: 401, reason: 'session_invalid', route: '/s/api/notebook' });

    const cross = await browser.json('/s/api/items/discard', { ids: [] }, { origin: 'https://evil.example' });
    expect(cross.status).toBe(403);
    expect(of('sel_http').find(line => line.rid === cross.headers.get('x-sel-request-id'))).toMatchObject({ status: 403, reason: 'cross_site' });

    const refused = await browser.get('/s/pair');
    expect(refused.status).toBe(404);
    expect(of('sel_http').find(line => line.rid === refused.headers.get('x-sel-request-id'))).toMatchObject({ status: 404, reason: 'path_refused' });

    // 任何一行都不含邀请码或会话令牌。
    const dump = JSON.stringify(lines);
    expect(dump).not.toContain('AAAA-BBBB-CCCC');
    expect(dump).not.toContain('forged-token');
  }, 60_000);

  it('worker 接口出错：JSON 里带 requestId，和响应头是同一个值；404 的错误码进访问日志', async () => {
    const host = await setupHost();
    const { browser } = await login(host);
    const missing = await browser.get('/s/api/items/itm_0000000000000000', { accept: 'application/json' });
    expect(missing.status).toBe(404);
    const rid = missing.headers.get('x-sel-request-id')!;
    const body = await missing.json() as { error: { code: string; requestId?: string } };
    expect(body.error.requestId).toBe(rid);
    expect(missing.headers.get('x-sel-error-code')).toBe(body.error.code);
    expect(of('sel_http').find(line => line.rid === rid)).toMatchObject({ status: 404, code: body.error.code, route: '/s/api/items/:itemId' });
  }, 60_000);

  it('worker 崩溃：sel_worker_error 一行，下一次请求重拉又有一行 sel_worker_start', async () => {
    const host = await setupHost();
    const { browser, studentId } = await login(host);
    const short = studentId.slice(0, 8);
    expect(of('sel_worker_start').filter(line => line.student === short)).toHaveLength(1);
    const entries = (host.pool as unknown as { entries: Map<string, { child: { kill(s: string): void } }> }).entries;
    entries.get(studentId)!.child.kill('SIGKILL');
    await waitFor(() => !host.pool.isRunning(studentId));
    await waitFor(() => of('sel_worker_error').some(line => line.student === short));
    expect(of('sel_worker_error').find(line => line.student === short)!.message).toContain('SIGKILL');
    expect((await browser.get('/s/api/settings', { accept: 'application/json' })).status).toBe(200);
    expect(of('sel_worker_start').filter(line => line.student === short)).toHaveLength(2);
  }, 90_000);

  it('网关关闭时 worker 按预期退出：sel_worker_stop 记 shutdown，不算错误', async () => {
    const host = await setupHost();
    const { studentId } = await login(host);
    const gateway = gateways.pop()!;
    await gateway.close();
    const stopped = of('sel_worker_stop').find(line => line.student === studentId.slice(0, 8));
    expect(stopped).toMatchObject({ level: 'info', reason: 'shutdown' });
    expect(typeof stopped!.uptimeMs).toBe('number');
    expect(of('sel_worker_error')).toHaveLength(0);
  }, 60_000);
});
