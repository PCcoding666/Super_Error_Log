import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudentRegistry } from '../../src/studentHost/registry.js';
import { AdminAuth, ADMIN_SESSION_TTL_MS } from '../../src/admin/auth.js';
import { createAdminRouter, ADMIN_COOKIE } from '../../src/admin/router.js';
import { recordAiUsage } from '../../src/observability/aiUsage.js';
import { runAdminCli } from '../../src/studentHost/admin-cli.js';

let root: string; let registry: StudentRegistry; let auth: AdminAuth; let server: Server; let base: string;
let clock = Date.now();
beforeEach(async () => {
  clock = Date.now();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-admin-http-'));
  registry = StudentRegistry.open(root);
  auth = AdminAuth.open(root, { now: () => clock });
  const app = express();
  app.use('/admin', createAdminRouter({ registry, auth, originScheme: 'http:', ipOf: req => req.socket.remoteAddress ?? 'unknown' }));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  auth.close(); registry.close(); fs.rmSync(root, { recursive: true, force: true });
});
async function login(password: string, origin = base): Promise<Response> {
  return fetch(`${base}/admin/login`, { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password }) });
}
async function adminCookie(): Promise<string> {
  const response = await login(auth.rotatePassword());
  expect(response.status).toBe(303);
  return response.headers.get('set-cookie')!.split(';')[0]!;
}
const get = (suffix = '/', cookie = '') => fetch(`${base}/admin${suffix}`, { redirect: 'manual', headers: { cookie } });

describe('independent administrator dashboard', () => {
  it('requires admin credentials and never accepts student or forged cookies', async () => {
    const student = registry.createStudent(); const invite = registry.issueInvitation(student.studentId); const session = registry.redeem(invite.code);
    for (const cookie of ['', `sel_student=${session.sessionToken}`, `${ADMIN_COOKIE}=${session.sessionToken}`, `${ADMIN_COOKIE}=forged`]) {
      const response = await get('/', cookie); expect(response.status).toBe(303); expect(response.headers.get('location')).toBe('/admin/login');
      expect(await response.text()).not.toContain(student.studentId);
    }
    expect((await login(invite.code)).status).toBe(401);
  });
  it('uses scoped secure session attributes and no-store/security headers', async () => {
    const response = await login(auth.rotatePassword());
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('SameSite=Strict'); expect(cookie).toContain('Path=/admin');
    const page = await get('/', cookie.split(';')[0]);
    expect(page.status).toBe(200); expect(page.headers.get('cache-control')).toContain('no-store');
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await page.text()).toContain('用量与性能');
    expect(fs.statSync(path.join(root, 'admin.db')).mode & 0o777).toBe(0o600);
  });
  it('rejects cross-origin and missing-Origin login/logout', async () => {
    const password = auth.rotatePassword(); const cookie = (await login(password)).headers.get('set-cookie')!.split(';')[0]!;
    expect((await login(password, 'https://attacker.invalid')).status).toBe(403);
    const missing = await fetch(`${base}/admin/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ password }) });
    expect(missing.status).toBe(403);
    const badLogout = await fetch(`${base}/admin/logout`, { method: 'POST', redirect: 'manual', headers: { cookie, origin: 'https://attacker.invalid' } });
    expect(badLogout.status).toBe(403); expect((await get('/', cookie)).status).toBe(200);
  });
  it('invalidates session on logout, password rotation and fixed expiry', async () => {
    const cookie = await adminCookie();
    const response = await fetch(`${base}/admin/logout`, { method: 'POST', redirect: 'manual', headers: { cookie, origin: base } });
    expect(response.status).toBe(303); expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await get('/', cookie)).status).toBe(303);
    const next = await adminCookie(); auth.rotatePassword(); expect((await get('/', next)).status).toBe(303);
    const expiring = await adminCookie(); clock += ADMIN_SESSION_TTL_MS;
    expect((await get('/', expiring)).status).toBe(303);
  });
  it('rate-limits password checks without returning sensitive error details', async () => {
    auth.rotatePassword();
    for (let i = 0; i < 5; i++) expect((await login('wrong')).status).toBe(401);
    const response = await login('wrong'); expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBeTruthy();
    expect(await response.text()).not.toContain(root);
  });
  it('provides bootstrap through the existing server CLI; password never persists as plaintext', async () => {
    vi.stubEnv('SEL_STUDENT_HOST_DIR', root);
    const lines: string[] = []; expect(runAdminCli(['admin-password'], line => lines.push(line))).toBe(0);
    const password = lines.find(line => line.startsWith('管理员密码：'))!.split('：')[1]!;
    expect(password.length).toBeGreaterThanOrEqual(32);
    expect((await login(password)).status).toBe(303);
    expect(fs.readFileSync(path.join(root, 'admin.db')).includes(Buffer.from(password))).toBe(false);
  });
  it('renders all accounts/invitation status, usage and failure reasons; filters preserve exact account ownership', async () => {
    const a = registry.createStudent(); const b = registry.createStudent();
    const invite = registry.issueInvitation(a.studentId); registry.issueInvitation(a.studentId); registry.redeem(invite.code);
    recordAiUsage({ id: crypto.randomUUID(), startedAt: '2026-10-20T02:00:00.000Z', operation: 'asr', model: 'voice-model', provider: 'bailian', source: 'live',
      status: 'failed', errorCode: 'timeout', inputTokens: 321, outputTokens: null, durationMs: 2000, httpStatus: null }, a.studentDir);
    const cookie = await adminCookie();
    const page = await get('/', cookie); const html = await page.text();
    expect(html).toContain(a.studentId); expect(html).toContain(b.studentId); expect(html).toContain('321'); expect(html).toContain('超时');
    expect(html).toContain('可重复登录'); expect(html).toContain('可使用'); expect(html).toContain('未采集');
    expect(html).not.toContain(invite.code); expect(html).not.toMatch(/code_hash|token_hash|responseRaw/);
    const filtered = await get(`/?studentId=${b.studentId}`, cookie); const filteredHtml = await filtered.text();
    expect(filteredHtml).not.toContain('voice-model</td>'); expect(filteredHtml).toContain('没有符合筛选条件的调用');
    expect((await get('/?from=2026-02-30', cookie)).status).toBe(400);
    const injection = await get('/?model=%3Cscript%3Ealert(1)%3C%2Fscript%3E', cookie);
    expect(await injection.text()).not.toContain('<script>alert(1)</script>');
  });
  it('retains sessions across reopening the authentication store', async () => {
    const token = (await auth.login(auth.rotatePassword()))!;
    auth.close(); auth = AdminAuth.open(root, { now: () => clock });
    expect(auth.authenticate(token)).toBe(true);
  });
  it('does not create a session for a password reset during asynchronous verification', async () => {
    const old = auth.rotatePassword();
    const pending = auth.login(old);
    auth.rotatePassword();
    expect(await pending).toBeNull();
  });
});
