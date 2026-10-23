/** P0-5: new invitation accounts choose 初中/高中 on first entry; changing the stage resets the notebook stage filter. Synthetic only. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, expect, it } from 'vitest';
import { StudentRegistry } from '../../src/studentHost/registry.js';
import { createStudentHostGateway, type StudentHostGateway } from '../../src/studentHost/router.js';
import { StudentWorkerPool } from '../../src/studentHost/workers.js';
import { RateLimiter } from '../../src/mobile/rateLimit.js';

const roots: string[] = []; const gateways: StudentHostGateway[] = []; const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map(g => g.close()));
  await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => s.close(() => resolve()))));
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});

class Browser {
  cookies = new Map<string, string>(); lastSetCookie: string[] = [];
  constructor(readonly base: string) {}
  async request(pathname: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set('cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    if (init.method === 'POST') headers.set('origin', this.base);
    const response = await fetch(this.base + pathname, { ...init, headers, redirect: 'manual' });
    this.lastSetCookie = response.headers.getSetCookie();
    for (const line of this.lastSetCookie) { const [pair] = line.split(';'); const i = pair!.indexOf('='); const name = pair!.slice(0, i); if (/Max-Age=0/.test(line)) this.cookies.delete(name); else this.cookies.set(name, pair!.slice(i + 1)); }
    return response;
  }
  get(p: string) { return this.request(p); }
  post(p: string, fields: Record<string, string>) { return this.request(p, { method: 'POST', body: new URLSearchParams(fields), headers: { 'content-type': 'application/x-www-form-urlencoded' } }); }
}

async function login(options: { materials?: boolean } = {}) {
  const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-stage-')); roots.push(hostDir);
  const registry = StudentRegistry.open(hostDir);
  const pool = new StudentWorkerPool({ dirFor: id => registry.studentDir(id), env: { SEL_STUDENT_WORKER_FAKE: '1', SEL_AI_MODE: 'mock', SEL_E2E_LEGACY_CAPTURE: options.materials ? '0' : '1' } });
  const gateway = await createStudentHostGateway({ hostDir, registry, pool }); gateways.push(gateway);
  const app = express(); app.use('/s', gateway.router({ limiter: new RateLimiter(), ipOf: r => r.socket.remoteAddress ?? 'unknown' }));
  const server = app.listen(0, '127.0.0.1'); servers.push(server); await new Promise<void>(r => server.once('listening', r));
  const browser = new Browser(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  const { studentId } = registry.createStudent();
  expect((await browser.post('/s/login', { code: registry.issueInvitation(studentId).code })).status).toBe(303);
  return browser;
}

it('a new account must pick 初中 or 高中 before the notebook, once', async () => {
  const browser = await login();
  const gate = await (await browser.get('/s/?login=1')).text();
  expect(gate).toContain('你现在读初中还是高中？');
  expect(gate).toContain('目前只支持数学、物理、化学。');
  expect(gate).not.toMatch(/<option[^>]*selected/);
  const bad = await browser.post('/s/stage', { grade: '高三' });
  expect(bad.status).toBe(400); expect(await bad.text()).toContain('请选择初中或高中。');
  const chosen = await browser.post('/s/stage', { grade: '高中' });
  expect(chosen.status).toBe(303); expect(chosen.headers.get('location')).toBe('/s/');
  const home = await (await browser.get('/s/')).text();
  expect(home).not.toContain('你现在读初中还是高中？');
  expect(home).toContain('0 道错题');
  expect(await (await browser.get('/s/settings')).text()).toMatch(/<option[^>]*selected[^>]*>高中</);
}, 60_000);

it('deep links and uploads cannot bypass the stage choice; settings and the choice itself stay reachable', async () => {
  const browser = await login();
  for (const page of ['/s/capture', '/s/items', '/s/materials', '/s/practices', '/s/choose']) {
    const response = await browser.get(page);
    expect(response.status, page).toBe(200);
    expect(await response.text(), page).toContain('你现在读初中还是高中？');
  }
  const upload = await browser.request('/s/materials/uploads?uploadId=' + crypto.randomUUID(), { method: 'POST', headers: { accept: 'application/json', 'x-upload-id': crypto.randomUUID() }, body: new FormData() });
  expect(upload.status).toBe(409);
  expect(await upload.json()).toEqual({ error: { code: 'stage_required', message: '请先选择初中或高中，再上传或整理。' } });
  const legacy = await browser.post('/s/capture', {});
  expect(legacy.status).toBe(303); expect(legacy.headers.get('location')).toBe('/s/');
  expect(await (await browser.get('/s/settings')).text()).toContain('我的学段');
  expect((await browser.post('/s/stage', { grade: '初中' })).status).toBe(303);
  expect(await (await browser.get('/s/capture')).text()).not.toContain('你现在读初中还是高中？');
}, 60_000);

it('a new account can still log out before choosing a stage (the logout draft check is not gated)', async () => {
  const browser = await login({ materials: true });
  expect(await (await browser.get('/s/?login=1')).text()).toContain('你现在读初中还是高中？');
  // 设置页的退出脚本先用这个只读接口确认本机草稿属于当前账号；以前被学段拦截成 409，点退出没反应。
  const session = await browser.request('/s/materials/session', { headers: { accept: 'application/json' } });
  expect(session.status).toBe(200);
  expect(await session.json()).toMatchObject({ draftNamespace: expect.any(String), assetCount: 0 });
  // 拍照和整理仍然要先选学段。
  const upload = await browser.request('/s/materials/uploads?uploadId=' + crypto.randomUUID(), { method: 'POST', headers: { accept: 'application/json', 'x-upload-id': crypto.randomUUID() }, body: new FormData() });
  expect(upload.status).toBe(409);
  const logout = await browser.post('/s/logout', {});
  expect(logout.status).toBe(303); expect(logout.headers.get('location')).toBe('/s/');
  expect(await (await browser.get('/s/')).text()).toContain('12 位邀请码');
}, 60_000);
