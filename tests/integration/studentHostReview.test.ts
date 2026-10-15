/** Independent review cases: real HTTP, no student data or model calls. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http, { type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { StudentRegistry, normalizeInviteCode } from '../../src/studentHost/registry.js';
import { createStudentHostGateway } from '../../src/studentHost/router.js';
import type { StudentWorkerPool } from '../../src/studentHost/workers.js';
import { RateLimiter } from '../../src/mobile/rateLimit.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanups.splice(0).reverse()) await fn(); });
async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
function registry(): StudentRegistry {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-host-review-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const reg = StudentRegistry.open(dir);
  cleanups.push(() => reg.close());
  return reg;
}
function invite(reg: StudentRegistry): string {
  const student = reg.createStudent();
  const spy = vi.spyOn(crypto, 'randomBytes').mockReturnValueOnce(Buffer.alloc(12) as never);
  const code = reg.issueInvitation(student.studentId).code;
  spy.mockRestore();
  return code;
}
async function setup() {
  const reg = registry();
  let calls = 0;
  const upstream = http.createServer((req, res) => {
    calls++;
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      setTimeout(() => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/s/trail') res.setHeader('set-cookie', ['sel_tap=; Path=/s; Max-Age=0', 'sel_device=internal-secret; Path=/s']);
        res.end(JSON.stringify({ body, path: req.url, cookie: req.headers.cookie }));
      }, 30);
    });
  });
  const upstreamBase = await listen(upstream);
  const pool = { ensure: async () => ({ port: Number(new URL(upstreamBase).port), token: 'internal-secret' }), stopAll: async () => {} } as unknown as StudentWorkerPool;
  const gateway = await createStudentHostGateway({ registry: reg, pool });
  const app = express();
  app.use('/s', gateway.router({ limiter: new RateLimiter(), ipOf: () => '192.0.2.1' }));
  const base = await listen(http.createServer(app));
  const code = invite(reg);
  const cookie = `sel_student=${reg.redeem(code).sessionToken}`;
  const post = (route: string, headers: Record<string, string> = {}, body = 'hello') => fetch(base + route, {
    method: 'POST', redirect: 'manual', headers: { cookie, origin: base, 'content-type': 'application/x-www-form-urlencoded', ...headers }, body,
    signal: AbortSignal.timeout(3000),
  });
  return { base, reg, cookie, post, calls: () => calls };
}

it('every random-byte boundary produces a redeemable 12-character invitation', () => {
  const reg = registry();
  const id = reg.createStudent().studentId;
  const spy = vi.spyOn(crypto, 'randomBytes').mockReturnValueOnce(Buffer.alloc(12, 255) as never);
  const code = reg.issueInvitation(id).code;
  spy.mockRestore();
  expect(normalizeInviteCode(code)).not.toBeNull();
  expect(reg.redeem(code).studentId).toBe(id);
});

it('blocks repeated failed login attempts from the same actual IP', async () => {
  const env = await setup();
  for (let i = 0; i < 11; i++) {
    const response = await env.post('/s/login', {}, 'code=wrong');
    await response.text();
    if (i === 10) expect(response.status).toBe(429);
  }
});

it.each(['/s/login', '/s/logout', '/s/settings', '/s/voice'])('rejects null Origin on %s', async route => {
  const env = await setup();
  const response = await env.post(route, { origin: 'null' });
  expect(response.status).toBe(403);
  expect(env.calls()).toBe(0);
});

it('rejects cross-site and wrong-scheme business submissions before proxying', async () => {
  const env = await setup();
  for (const headers of ([{ origin: 'https://attacker.invalid' }, { origin: env.base.replace('http:', 'https:') }, { 'sec-fetch-site': 'cross-site' }] as Array<Record<string, string>>)) {
    const response = await env.post('/s/settings', headers);
    expect(response.status).toBe(403);
    expect(env.calls()).toBe(0);
  }
});

it('normal delayed POST and GET responses survive completion of the request body', async () => {
  const env = await setup();
  const result = await env.post('/s/settings', {}, 'practiceSlot=weekend');
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ body: 'practiceSlot=weekend', path: '/s/settings' });
  const get = await fetch(env.base + '/s/', { headers: { cookie: env.cookie }, signal: AbortSignal.timeout(3000) });
  expect(get.status).toBe(200);
  expect((await get.json()).path).toBe('/s/');
});

it('clears previous student business cookies on a successful invitation login', async () => {
  const env = await setup();
  const next = env.reg.issueInvitation(env.reg.listStudents()[0]!.studentId);
  const response = await env.post('/s/login', { cookie: 'sel_photos=old; sel_skip=old; sel_consent=old' }, new URLSearchParams({ code: next.code }).toString());
  expect(response.status).toBe(303);
  const cookies = response.headers.getSetCookie().join('\n');
  for (const name of ['sel_photos', 'sel_skip', 'sel_consent', 'sel_tap', 'sel_device']) expect(cookies).toMatch(new RegExp(`${name}=;[^\\n]*Max-Age=0`, 'i'));
});

it('forwards the existing tap cookie and its clearing response without exposing an internal device token', async () => {
  const env = await setup();
  const response = await env.post('/s/trail', { cookie: `${env.cookie}; sel_tap=synthetic-event; sel_device=forged` });
  expect(response.status).toBe(200);
  expect((await response.json()).cookie).toContain('sel_tap=synthetic-event');
  const headers = response.headers.getSetCookie().join('\n');
  expect(headers).toContain('sel_tap=;');
  expect(headers).not.toContain('internal-secret');
  expect(headers).not.toContain('sel_device');
});

it.each(['application/json', '*/*'])('unauthenticated voice fetch gets a JSON 401 with Accept %s', async accept => {
  const env = await setup();
  const response = await env.post('/s/voice', { cookie: '', accept });
  expect(response.status).toBe(401);
  expect(response.headers.get('content-type')).toContain('application/json');
});
