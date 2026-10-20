/** Registration and personal login credentials use synthetic identities only. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { StudentRegistry, MAX_STUDENTS } from '../../src/studentHost/registry.js';
import { createStudentHostGateway, type StudentHostGateway } from '../../src/studentHost/router.js';
import { RateLimiter } from '../../src/mobile/rateLimit.js';

const roots: string[] = [];
const gateways: StudentHostGateway[] = [];
const servers: Server[] = [];
const registries: StudentRegistry[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  await Promise.all(gateways.splice(0).map(gateway => gateway.close()));
  registries.splice(0).forEach(registry => registry.close());
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
  vi.unstubAllEnvs();
});
function root(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-registration-'));
  roots.push(dir);
  return dir;
}
async function setup() {
  const registry = StudentRegistry.open(root());
  const gateway = await createStudentHostGateway({ registry });
  gateways.push(gateway);
  const app = express();
  app.use('/s', gateway.router({ limiter: new RateLimiter(), ipOf: () => '192.0.2.19' }));
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  return {
    registry, base,
    post: (route: string, fields: Record<string, string>, headers: Record<string, string> = {}) => fetch(base + route, {
      method: 'POST', redirect: 'manual', headers: { origin: base, ...headers }, body: new URLSearchParams(fields),
    }),
  };
}
function codeFrom(html: string): string {
  const code = /data-testid="registered-invite-code"[^>]*>([A-Z0-9-]+)</.exec(html)?.[1];
  expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  return code!;
}
it('defaults to 100 student accounts', () => { expect(MAX_STUDENTS).toBe(100); });
it('new administrator invitations last exactly 60 days', () => {
  const now = new Date('2026-10-21T00:00:00Z');
  const registry = StudentRegistry.open(root(), { now: () => now });
  registries.push(registry);
  const invitation = registry.issueInvitation(registry.createStudent().studentId);
  expect(invitation.expiresAt.getTime() - now.getTime()).toBe(60 * 24 * 60 * 60 * 1000);
});
it('offers a public name and phone registration form without a password', async () => {
  const env = await setup();
  const login = await fetch(env.base + '/s/');
  expect(await login.text()).toContain('href="/s/register"');
  const response = await fetch(env.base + '/s/register');
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toContain('no-store');
  const html = await response.text();
  expect(html).toContain('name="name"');
  expect(html).toContain('name="phone"');
  expect(html).not.toContain('type="password"');
  expect(env.registry.listStudents()).toHaveLength(0);
});
it('registers only from name and phone and can log in repeatedly to the same student', async () => {
  const env = await setup();
  const response = await env.post('/s/register', { name: '合成学生甲', phone: '+65 8123 4567', role: 'admin' });
  expect(response.status).toBe(201);
  expect(response.headers.get('cache-control')).toContain('no-store');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(response.headers.get('set-cookie')).toBeNull();
  const code = codeFrom(await response.text());
  const students = env.registry.listStudents();
  expect(students).toHaveLength(1);
  expect(students[0]!.accountRole).toBe('student');
  const first = await env.post('/s/login', { code });
  expect(first.status).toBe(303);
  const firstCookie = first.headers.getSetCookie().find(value => value.startsWith('sel_student='))!;
  expect(firstCookie).toContain('HttpOnly');
  await first.text();
  const second = await env.post('/s/login', { code });
  expect(second.status).toBe(303);
  const secondCookie = second.headers.getSetCookie().find(value => value.startsWith('sel_student='))!;
  expect(secondCookie).not.toBe(firstCookie);
  expect(env.registry.listStudents()).toHaveLength(1);
  const firstToken = firstCookie.split(';')[0]!.slice('sel_student='.length);
  const secondToken = secondCookie.split(';')[0]!.slice('sel_student='.length);
  expect(env.registry.authenticate(firstToken)).toEqual({ studentId: students[0]!.studentId });
  expect(env.registry.authenticate(secondToken)).toEqual({ studentId: students[0]!.studentId });
});
it('duplicate and concurrent submissions never reveal credentials or create another space', async () => {
  const env = await setup();
  const fields = { name: '合成学生甲', phone: '+6581234567' };
  const responses = await Promise.all([env.post('/s/register', fields), env.post('/s/register', fields)]);
  expect(responses.map(response => response.status).sort()).toEqual([201, 400]);
  const created = responses.find(response => response.status === 201)!;
  const rejected = responses.find(response => response.status === 400)!;
  const code = codeFrom(await created.text());
  const rejectedHtml = await rejected.text();
  expect(rejectedHtml).not.toContain(code);
  expect(rejectedHtml).not.toContain('registered-invite-code');
  const formatted = await env.post('/s/register', { name: ' 合成学生甲 ', phone: '+65 8123-4567' });
  expect(formatted.status).toBe(400);
  expect(await formatted.text()).not.toContain(code);
  expect(env.registry.listStudents()).toHaveLength(1);
  expect(fs.readdirSync(env.registry.studentsRoot())).toHaveLength(1);
});
it('different students sharing a family phone retain separate accounts and credentials', async () => {
  const env = await setup();
  const first = await env.post('/s/register', { name: '合成学生甲', phone: '+6581234567' });
  const second = await env.post('/s/register', { name: '合成学生乙', phone: '+6581234567' });
  expect(first.status).toBe(201); expect(second.status).toBe(201);
  const a = env.registry.redeem(codeFrom(await first.text()));
  const b = env.registry.redeem(codeFrom(await second.text()));
  expect(a.studentId).not.toBe(b.studentId);
  expect(env.registry.studentDir(a.studentId)).not.toBe(env.registry.studentDir(b.studentId));
});
it.each([
  { name: '', phone: '+6581234567' },
  { name: '   ', phone: '+6581234567' },
  { name: '合成学生', phone: '' },
  { name: '合成学生', phone: 'call me' },
  { name: '合成学生', phone: '123' },
  { name: '合成学生', phone: '+1234567890123456' },
])('invalid registration never allocates a student ($name / $phone)', async fields => {
  const env = await setup();
  const response = await env.post('/s/register', fields);
  expect(response.status).toBe(400);
  expect(await response.text()).not.toContain('registered-invite-code');
  expect(env.registry.listStudents()).toHaveLength(0);
});
it('honors a configured capacity and leaves existing accounts and data intact', async () => {
  vi.stubEnv('SEL_MAX_STUDENTS', '1');
  const env = await setup();
  const first = await env.post('/s/register', { name: '合成学生甲', phone: '+6581234567' });
  expect(first.status).toBe(201);
  const code = codeFrom(await first.text());
  const second = await env.post('/s/register', { name: '合成学生乙', phone: '+6581234568' });
  expect(second.status).toBe(503);
  expect(env.registry.listStudents()).toHaveLength(1);
  expect(fs.readdirSync(env.registry.studentsRoot())).toHaveLength(1);
  expect((await env.post('/s/login', { code })).status).toBe(303);
});
it('refuses cross-site registration without creating an account', async () => {
  const env = await setup();
  for (const origin of ['https://attacker.invalid', 'null']) {
    const response = await env.post('/s/register', { name: '合成学生', phone: '+6581234567' }, { origin });
    expect(response.status).toBe(403);
  }
  expect(env.registry.listStudents()).toHaveLength(0);
});
it('rate limits registration independently of valid invitation login', async () => {
  const env = await setup();
  const registered = await env.post('/s/register', { name: '合成学生', phone: '+6581234567' });
  expect(registered.status).toBe(201);
  const code = codeFrom(await registered.text());
  let response: Response | undefined;
  for (let i = 0; i < 11; i++) {
    response = await env.post('/s/register', { name: '', phone: '' });
    await response.text();
  }
  expect(response!.status).toBe(429);
  expect(response!.headers.get('retry-after')).not.toBeNull();
  expect((await env.post('/s/login', { code })).status).toBe(303);
});
