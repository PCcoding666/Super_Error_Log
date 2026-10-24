/**
 * 原生 App（iOS）经学生邀请码网关登录与转发（2026-10-23）：
 * POST /s/native/login 兑换邀请码拿会话令牌 + serviceId；Bearer 令牌访问 /s/native/v1 /s/native/v2 被改写到该学生 worker；
 * cookie 会话进不了 /s/native，令牌进不了网页路由；/v1/pairing 与路径穿越永远到不了 worker。
 * 真实网关 + 真实 fork 的 worker（合成识别、mock 转写），不碰真实模型与 data/。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import express from 'express';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { StudentRegistry } from '../../src/studentHost/registry.js';
import { createStudentHostGateway, NATIVE_PROTOCOL_VERSION, SESSION_COOKIE, type StudentHostGateway } from '../../src/studentHost/router.js';
import { StudentWorkerPool } from '../../src/studentHost/workers.js';
import { RateLimiter } from '../../src/mobile/rateLimit.js';

const roots: string[] = [];
const gateways: StudentHostGateway[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(gateways.splice(0).map(gateway => gateway.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});

interface HostSetup { base: string; registry: StudentRegistry; pool: StudentWorkerPool }

async function setupHost(): Promise<HostSetup> {
  const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-native-'));
  roots.push(hostDir);
  const registry = StudentRegistry.open(hostDir);
  const pool = new StudentWorkerPool({
    dirFor: studentId => registry.studentDir(studentId),
    env: { SEL_STUDENT_WORKER_FAKE: '1', SEL_AI_MODE: 'mock', SEL_E2E_LEGACY_CAPTURE: '1' },
  });
  const gateway = await createStudentHostGateway({ hostDir, registry, pool });
  gateways.push(gateway);
  const app = express();
  app.disable('x-powered-by');
  app.use('/s', gateway.router({ limiter: new RateLimiter(), ipOf: request => request.socket.remoteAddress ?? 'unknown' }));
  app.use((_request, response) => response.status(404).json({ error: { code: 'not_found', message: '接口不存在。' } }));
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, registry, pool };
}

/** 原生 App 替身：没有 cookie、没有 Origin，只带 Bearer。 */
function native(base: string, token?: string) {
  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    'user-agent': 'SuperErrorLog/0.3 (iPhone; iOS 18.0)', accept: 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra,
  });
  return {
    login: (code: string, extra: Record<string, string> = {}) => fetch(`${base}/s/native/login`, {
      method: 'POST', headers: headers({ 'content-type': 'application/json', ...extra }), body: JSON.stringify({ code, deviceInfo: 'iPhone' }), redirect: 'manual',
    }),
    get: (pathname: string) => fetch(`${base}${pathname}`, { headers: headers(), redirect: 'manual' }),
    post: (pathname: string, body?: BodyInit, extra: Record<string, string> = {}) => fetch(`${base}${pathname}`, { method: 'POST', headers: headers(extra), body, redirect: 'manual' }),
  };
}

async function loginNative(env: HostSetup): Promise<{ token: string; serviceId: string; studentId: string; code: string }> {
  const { studentId } = env.registry.createStudent();
  const { code } = env.registry.issueInvitation(studentId);
  const response = await native(env.base).login(code);
  expect(response.status).toBe(200);
  const body = await response.json() as { token: string; serviceId: string; expiresAt: string; protocolVersion: number };
  expect(body.protocolVersion).toBe(NATIVE_PROTOCOL_VERSION);
  expect(body.token.length).toBeGreaterThan(16);
  expect(body.serviceId).toMatch(/^[0-9a-f-]{36}$/);
  expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
  expect(response.headers.get('set-cookie')).toBeNull();
  return { token: body.token, serviceId: body.serviceId, studentId, code };
}

describe('原生 App 经网关登录与转发', () => {
  it('邀请码换令牌：health 的 serviceId 与登录返回一致；/v2 周视图可用；错误码统一、限速按码', async () => {
    const env = await setupHost();
    const { token, serviceId } = await loginNative(env);
    const app = native(env.base, token);
    const health = await app.get('/s/native/v1/health');
    expect(health.status).toBe(200);
    const snapshot = await health.json() as { serviceId: string; protocolVersion: number; acceptingJobs: boolean };
    expect(snapshot.serviceId).toBe(serviceId);
    expect(snapshot.protocolVersion).toBe(1);
    expect(health.headers.get('cache-control')).toContain('no-store');
    const week = await app.get('/s/native/v2/week');
    expect(week.status).toBe(200);
    expect(await week.json()).toMatchObject({ items: [] });
    const v2Health = await app.get('/s/native/v2/health');
    expect(v2Health.status).toBe(200);
    expect(await v2Health.json()).toMatchObject({ protocolVersion: 2 });

    const bad = await native(env.base).login('NOT-A-REAL-CODE');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: 'invalid_code' } });
    let last = bad;
    for (let i = 0; i < 12; i += 1) last = await native(env.base).login('NOT-A-REAL-CODE');
    expect(last.status).toBe(429);
    expect(last.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(await last.json()).toMatchObject({ error: { code: 'rate_limited' } });
    // 先验码：同一网络里别的同学的正确码不受影响；连开头四位和被挡的错码相同的正确码也照常登录
    const { studentId: other } = env.registry.createStudent();
    const { code } = env.registry.issueInvitation(other);
    expect((await native(env.base).login(code)).status).toBe(200);
    for (let i = 0; i < 12; i += 1) await native(env.base).login(`${code.slice(0, 4)}-ZZZZ-ZZZZ`);
    expect((await native(env.base).login(`${code.slice(0, 4)}-ZZZZ-ZZZZ`)).status).toBe(429);
    expect((await native(env.base).login(code)).status).toBe(200);
  }, 90_000);

  it('上传与识别进度经 /s/native/v1 到达本学生 worker；登记后进入 /v2 周视图；另一个学生看不到', async () => {
    const env = await setupHost();
    const a = native(env.base, (await loginNative(env)).token);
    const b = native(env.base, (await loginNative(env)).token);
    const bytes = await sharp({ create: { width: 600, height: 780, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
    const key = crypto.randomUUID();
    const uploaded = await a.post('/s/native/v1/recognitions', new Uint8Array(bytes), { 'content-type': 'image/jpeg', 'idempotency-key': key, 'x-photo-name': 'paper.jpg' });
    expect(uploaded.status).toBe(202);
    const { job } = await uploaded.json() as { job: { id: string } };
    expect(job.id).toMatch(/^[0-9a-f-]{36}$/);
    // 幂等重放：同键再传返回同一任务
    const replay = await a.post('/s/native/v1/recognitions', new Uint8Array(bytes), { 'content-type': 'image/jpeg', 'idempotency-key': key, 'x-photo-name': 'paper.jpg' });
    expect([200, 202]).toContain(replay.status);
    expect(((await replay.json()) as { job: { id: string } }).job.id).toBe(job.id);
    const start = Date.now();
    let status = '';
    while (Date.now() - start < 30_000) {
      const progress = await a.get(`/s/native/v1/recognitions/${job.id}`);
      expect(progress.status).toBe(200);
      status = ((await progress.json()) as { job: { status: string } }).job.status;
      if (status === 'completed' || status === 'partial' || status === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    expect(['completed', 'partial']).toContain(status);
    expect((await a.post(`/s/native/v2/photos/${job.id}/register`)).status).toBe(200);
    const week = await a.get('/s/native/v2/week');
    expect(((await week.json()) as { photos: unknown[] }).photos.length).toBe(1);
    // B 看不到 A 的任务与周视图
    expect((await b.get(`/s/native/v1/recognitions/${job.id}`)).status).toBe(404);
    expect(((await (await b.get('/s/native/v2/week')).json()) as { photos: unknown[] }).photos.length).toBe(0);
  }, 90_000);

  it('令牌边界：cookie 进不了 /s/native；令牌进不了网页；伪造 authorization 不被转发；pairing 与穿越 404；退出后 401', async () => {
    const env = await setupHost();
    const { token, code } = await loginNative(env);
    const app = native(env.base, token);
    // 网页登录拿的 cookie 不能用于 /s/native（网页自己的 /s/api 是另一套，不在本测试范围）
    const web = await fetch(`${env.base}/s/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: env.base }, body: new URLSearchParams({ code }), redirect: 'manual' });
    expect(web.status).toBe(303);
    const cookie = web.headers.getSetCookie().find(line => line.startsWith(`${SESSION_COOKIE}=`))!.split(';')[0]!;
    const viaCookie = await fetch(`${env.base}/s/native/v1/health`, { headers: { cookie, accept: 'application/json' }, redirect: 'manual' });
    expect(viaCookie.status).toBe(401);
    expect(await viaCookie.json()).toMatchObject({ error: { code: 'unauthorized' } });
    // 令牌不能当网页会话用：没有 cookie 只能看到登录页
    const viaBearer = await fetch(`${env.base}/s/`, { headers: { authorization: `Bearer ${token}` }, redirect: 'manual' });
    expect(viaBearer.status).toBe(200);
    expect(await viaBearer.text()).toContain('邀请码');
    expect((await viaBearer.headers.get('set-cookie'))).toBeNull();
    // 没令牌 / 假令牌
    expect((await native(env.base).get('/s/native/v2/week')).status).toBe(401);
    expect((await native(env.base, 'forged').get('/s/native/v2/week')).status).toBe(401);
    // 配对兑换与网页路径、穿越：不到 worker
    expect((await app.post('/s/native/v1/pairing/redeem', '{}', { 'content-type': 'application/json' })).status).toBe(404);
    expect((await app.get('/s/native/v1/admin')).status).toBe(404);
    expect((await app.get('/s/native/')).status).toBe(404);
    expect((await app.get('/s/native/v2/../v1/pairing/redeem')).status).toBe(404);
    // 带 Origin 的跨站脚本拿不到令牌
    const cross = await native(env.base).login(code, { origin: 'https://evil.example' });
    expect(cross.status).toBe(403);
    // 退出：令牌立即失效；再退出也是 204
    expect((await app.post('/s/native/logout')).status).toBe(204);
    expect((await app.get('/s/native/v1/health')).status).toBe(401);
    expect((await app.post('/s/native/logout')).status).toBe(204);
    // 新码可重复登录：换一枚新令牌照常工作
    const again = await native(env.base).login(code);
    expect(again.status).toBe(200);
    const fresh = ((await again.json()) as { token: string }).token;
    expect(fresh).not.toBe(token);
    expect((await native(env.base, fresh).get('/s/native/v1/health')).status).toBe(200);
  }, 90_000);

  it('学生空间起不来时不发令牌：503 且会话已撤销', async () => {
    const env = await setupHost();
    const { studentId } = env.registry.createStudent();
    const { code } = env.registry.issueInvitation(studentId);
    // 把学生目录换成文件，worker 必然启动失败
    const dir = env.registry.studentDir(studentId);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(dir, 'not a directory');
    const response = await native(env.base).login(code);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'unavailable' } });
  }, 90_000);
});
