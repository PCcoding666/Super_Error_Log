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
  let starts = 0;
  const upstream = http.createServer((req, res) => {
    calls++;
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      setTimeout(() => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/s/trail') res.setHeader('set-cookie', ['sel_tap=; Path=/s; Max-Age=0', 'sel_device=internal-secret; Path=/s']);
        res.end(JSON.stringify({ body, path: req.url, cookie: req.headers.cookie, headers: req.headers }));
      }, 30);
    });
  });
  const upstreamBase = await listen(upstream);
  const pool = { ensure: async () => { starts++; return { port: Number(new URL(upstreamBase).port), token: 'internal-secret' }; }, stopAll: async () => {} } as unknown as StudentWorkerPool;
  const gateway = await createStudentHostGateway({ registry: reg, pool });
  const app = express();
  // Match the parent mobile app's default headers: public assets must override both.
  app.use((_req, res, next) => { res.setHeader('cache-control', 'private, no-store'); res.setHeader('pragma', 'no-cache'); next(); });
  app.use('/s', gateway.router({ limiter: new RateLimiter(), ipOf: () => '192.0.2.1' }));
  const base = await listen(http.createServer(app));
  const code = invite(reg);
  const cookie = `sel_student=${reg.redeem(code).sessionToken}`;
  const post = (route: string, headers: Record<string, string> = {}, body = 'hello') => fetch(base + route, {
    method: 'POST', redirect: 'manual', headers: { cookie, origin: base, 'content-type': 'application/x-www-form-urlencoded', ...headers }, body,
    signal: AbortSignal.timeout(3000),
  });
  return { base, reg, cookie, post, calls: () => calls, starts: () => starts };
}

it.each(['anonymous', 'invalid', 'valid'] as const)('serves the login page fingerprinted assets before session auth (%s)', async session => {
  const env = await setup();
  const login = await fetch(env.base + '/s/');
  expect(login.headers.get('cache-control')).toBe('private, no-store');
  const html = await login.text();
  const assets = [...html.matchAll(/(?:src|href)="(\/s\/assets\/app\.([0-9a-f]{10})\.(css|js))"/g)];
  expect(assets.map(match => match[3]).sort()).toEqual(['css', 'js']);
  const cookie = session === 'valid' ? env.cookie : session === 'invalid' ? 'sel_student=expired' : '';
  for (const match of assets) {
    const response = await fetch(env.base + match[1], { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain(match[3] === 'css' ? 'text/css' : 'text/javascript');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(response.headers.get('pragma')).toBeNull();
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.getSetCookie()).toEqual([]);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 10)).toBe(match[2]);
    const head = await fetch(env.base + match[1], { method: 'HEAD', headers: { cookie } });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe(response.headers.get('content-type'));
    expect(head.headers.get('cache-control')).toBe(response.headers.get('cache-control'));
    expect(await head.text()).toBe('');
  }
  expect(env.starts()).toBe(0);
  expect(env.calls()).toBe(0);
});

it('revalidates legacy and stale assets while keeping current static shell resources public', async () => {
  const env = await setup();
  for (const [route, mime] of [
    ['/s/assets/app.css?v=3', 'text/css'],
    ['/s/assets/app.js?v=3', 'text/javascript'],
    ['/s/assets/app.0000000000.css', 'text/css'],
    ['/s/assets/app.0000000000.js', 'text/javascript'],
    ['/s/manifest.webmanifest', 'application/manifest+json'],
    ['/s/sw.js', 'text/javascript'],
  ]) {
    const response = await fetch(env.base + route);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain(mime);
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('pragma')).toBeNull();
    expect(response.headers.getSetCookie()).toEqual([]);
    expect((await response.text()).length).toBeGreaterThan(0);
  }
  for (const name of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png']) {
    const response = await fetch(env.base + '/s/assets/' + name);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('image/png');
    expect(response.headers.get('cache-control')).toBe('public, max-age=604800');
    expect(response.headers.get('pragma')).toBeNull();
    expect(Buffer.from(await response.arrayBuffer()).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  }
  const offline = await fetch(env.base + '/s/offline');
  expect(offline.status).toBe(200);
  expect(offline.headers.get('cache-control')).toBe('private, no-store');
  await offline.text();
  expect(env.starts()).toBe(0);
});

it('does not make private routes public with the static shell', async () => {
  const env = await setup();
  for (const route of ['/s/settings', '/s/img/item/itm_0000000000000000', '/s/pair']) {
    const response = await fetch(env.base + route);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.text()).toContain('输入邀请码');
  }
  const response = await fetch(env.base + '/s/settings', { headers: { cookie: env.cookie } });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  await response.text();
  expect(env.starts()).toBe(1);
});

it.each(['1', '0', '1, 1'])('only forwards the canonical poll marker (%s) without relaxing auth headers', async value => {
  const env = await setup();
  const response = await fetch(env.base + '/s/photos', {
    headers: { cookie: env.cookie + '; sel_device=forged', 'x-sel-poll': value, authorization: 'Bearer forged', 'x-real-ip': '203.0.113.1' },
  });
  expect(response.status).toBe(200);
  const result = await response.json() as { headers: Record<string, string> };
  expect(result.headers['x-sel-poll']).toBe(value === '1' ? '1' : undefined);
  expect(result.headers.authorization).toBeUndefined();
  expect(result.headers['x-real-ip']).toBe('192.0.2.1');
  expect(result.headers.cookie).toBe('sel_device=internal-secret');
});

it.each(['/s/voice', '/s/voice/', '/s/VOICE'])('rejects missing or mismatched voice context before starting a worker (%s)', async route => {
  const env = await setup();
  for (const context of ['', '0'.repeat(64), 'invalid']) {
    const response = await env.post(route, {
      'content-type': 'audio/webm', 'x-sel-voice-context': context,
      'x-sel-internal-voice-context': context,
    }, 'SYNTHETIC-PRIVATE-VOICE');
    expect(response.status).toBe(409);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toMatchObject({ error: { code: 'voice_context_mismatch' } });
  }
  expect(env.starts()).toBe(0);
  expect(env.calls()).toBe(0);
});

it('injects context from the authenticated session, ignoring browser-supplied internal context', async () => {
  const env = await setup();
  const context = crypto.createHash('sha256').update(env.cookie.slice('sel_student='.length)).digest('hex');
  const page = await fetch(env.base + '/s/photos', { headers: {
    cookie: env.cookie, 'x-sel-internal-voice-context': 'f'.repeat(64),
  } });
  expect((await page.json()).headers['x-sel-internal-voice-context']).toBe(context);
  const form = await env.post('/s/items/itm_0123456789abcdef/fix', {
    'x-sel-internal-voice-context': 'f'.repeat(64),
  }, 'instruction=');
  expect(form.status).toBe(200);
  expect((await form.json()).headers['x-sel-internal-voice-context']).toBe(context);
  const voice = await env.post('/s/voice', {
    'content-type': 'audio/webm', 'x-sel-voice-context': context,
    'x-sel-internal-voice-context': 'f'.repeat(64),
  }, 'synthetic-voice');
  expect(voice.status).toBe(200);
  const forwarded = await voice.json();
  expect(forwarded.body).toBe('synthetic-voice');
  expect(forwarded.headers['x-sel-internal-voice-context']).toBeUndefined();
  expect(forwarded.headers['x-sel-voice-context']).toBeUndefined();
});

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
