/** Registration and personal login credentials use synthetic identities only. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { StudentRegistry, MAX_STUDENTS } from '../../src/studentHost/registry.js';
import { createStudentHostGateway, type StudentHostGateway } from '../../src/studentHost/router.js';
import { runAdminCli } from '../../src/studentHost/admin-cli.js';
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
  // 2026-10-22 起公开注册需要注册码与同意；既有用例默认带上一个有效注册码和「已满 14 周岁 + 同意」，
  // 注册码 / 同意本身的规则在 studentRegistrationGate.test.ts 里单独测。
  const registrationCode = registry.createRegistrationCode({ label: '合成班级', maxUses: 500 }).code;
  const gateway = await createStudentHostGateway({ registry });
  gateways.push(gateway);
  const app = express();
  app.use('/s', gateway.router({ limiter: new RateLimiter(), ipOf: () => '192.0.2.19' }));
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  return {
    registry, base, registrationCode,
    post: (route: string, fields: Record<string, string>, headers: Record<string, string> = {}) => fetch(base + route, {
      method: 'POST', redirect: 'manual', headers: { origin: base, ...headers },
      body: new URLSearchParams(route === '/s/register' ? { regcode: registrationCode, age: '14plus', consent: '1', ...fields } : fields),
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
  // 只有失败（这里是错误的注册码）才计数；同一个错码 20 次后被挡。
  for (let i = 0; i < 21; i++) {
    response = await env.post('/s/register', { name: '', phone: '', regcode: 'WRNG-0000' });
    await response.text();
  }
  expect(response!.status).toBe(429);
  expect(response!.headers.get('retry-after')).not.toBeNull();
  expect((await env.post('/s/login', { code })).status).toBe(303);
});


it('personal credentials persist across restart, expire exactly at day 60, and are stored only as hashes', () => {
  const dir = root();
  let now = new Date('2026-10-21T00:00:00Z');
  let registry = StudentRegistry.open(dir, { now: () => now });
  const registered = registry.registerStudent('合成学生甲', '13800138000');
  const studentId = registered.studentId;
  const db = new DatabaseSync(path.join(dir, 'registry.db'), { readOnly: true });
  const row = db.prepare('SELECT code_hash, reusable FROM invitations').get()!;
  expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(row.code_hash).not.toBe(registered.code.replace(/-/g, ''));
  expect(row.reusable).toBe(1);
  db.close(); registry.close();
  registry = StudentRegistry.open(dir, { now: () => now });
  registries.push(registry);
  expect(registry.findRegisteredStudent(' 合成学生甲 ', '+86 13800138000')).toBe(studentId);
  expect(registry.findRegisteredStudent('合成学生甲', '+86 13900139000')).toBeNull();
  now = new Date(registered.expiresAt.getTime() - 1);
  expect(registry.redeem(registered.code).studentId).toBe(studentId);
  now = registered.expiresAt;
  expect(() => registry.redeem(registered.code)).toThrow('邀请码不正确或已经失效');
  expect(registry.listInvitations()[0]!.status).toBe('expired');
  expect(registry.listStudents()).toHaveLength(1);
});
it('registration rolls back its directory and identity when credential creation fails', () => {
  const registry = StudentRegistry.open(root());
  registries.push(registry);
  const spy = vi.spyOn(registry, 'issueInvitation').mockImplementationOnce(() => { throw new Error('synthetic storage failure'); });
  expect(() => registry.registerStudent('合成学生甲', '+6581234567')).toThrow('synthetic storage failure');
  spy.mockRestore();
  expect(registry.listStudents()).toHaveLength(0);
  expect(registry.findRegisteredStudent('合成学生甲', '+6581234567')).toBeNull();
  expect(fs.readdirSync(registry.studentsRoot())).toHaveLength(0);
  expect(registry.registerStudent('合成学生甲', '+6581234567').code).toBeTruthy();
});
it.each(['0', '-1', '1.5', 'many', 'Infinity'])('rejects an invalid capacity setting: %s', value => {
  vi.stubEnv('SEL_MAX_STUDENTS', value);
  expect(() => StudentRegistry.open(root())).toThrow('SEL_MAX_STUDENTS');
});
it('legacy migration extends only still-usable codes and preserves one-time semantics and sessions', async () => {
  const dir = root();
  const db = new DatabaseSync(path.join(dir, 'registry.db'));
  const id = crypto.randomUUID();
  const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
  db.exec('CREATE TABLE students(id TEXT PRIMARY KEY, created_at TEXT NOT NULL); CREATE TABLE invitations(code_hash TEXT PRIMARY KEY, student_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, redeemed_at TEXT); CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, student_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);');
  db.prepare('INSERT INTO students VALUES (?, ?)').run(id, '2026-10-01T00:00:00.000Z');
  const insert = db.prepare('INSERT INTO invitations VALUES (?, ?, ?, ?, ?)');
  insert.run(hash('0123456789AB'), id, '2026-10-01T00:00:00.000Z', '2026-10-08T00:00:00.000Z', null);
  insert.run(hash('0123456789AC'), id, '2026-10-01T00:00:00.000Z', '2026-10-08T00:00:00.000Z', '2026-10-02T00:00:00.000Z');
  insert.run(hash('0123456789AD'), id, '2026-09-01T00:00:00.000Z', '2026-09-08T00:00:00.000Z', null);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, 0)').run(hash('synthetic-session'), id, '2026-10-02T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
  db.close();
  const registry = StudentRegistry.open(dir, { now: () => new Date('2026-10-05T00:00:00.000Z') });
  registries.push(registry);
  const pending = registry.listInvitations().find(row => row.status === 'pending')!;
  expect(pending.expiresAt).toBe(new Date(Date.parse('2026-10-01T00:00:00.000Z') + 60 * 24 * 60 * 60 * 1000).toISOString());
  for (const code of ['0123456789AC', '0123456789AD']) expect(() => registry.redeem(code)).toThrow();
  const concurrent = await Promise.allSettled([0, 1].map(() => Promise.resolve().then(() => registry.redeem('0123456789AB'))));
  expect(concurrent.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(() => registry.redeem('0123456789AB')).toThrow();
  expect(registry.authenticate('synthetic-session')).toEqual({ studentId: id });
  expect(registry.listStudents()).toHaveLength(1);
});


it('verified administrator recovery invalidates old codes and sessions without changing the student or data', () => {
  const registry = StudentRegistry.open(root());
  registries.push(registry);
  const registered = registry.registerStudent('合成学生', '+6581234567');
  const other = registry.registerStudent('合成学生乙', '+6581234568');
  const session = registry.redeem(registered.code);
  fs.writeFileSync(path.join(registry.studentDir(registered.studentId), 'synthetic-record.txt'), 'preserve this');
  const next = registry.resetInvitation(registered.studentId);
  expect(() => registry.redeem(registered.code)).toThrow();
  expect(registry.authenticate(session.sessionToken)).toBeNull();
  expect(registry.redeem(next.code).studentId).toBe(registered.studentId);
  expect(registry.redeem(other.code).studentId).toBe(other.studentId);
  expect(fs.readFileSync(path.join(registry.studentDir(registered.studentId), 'synthetic-record.txt'), 'utf8')).toBe('preserve this');
});
it('failed administrator recovery leaves the previous code and session usable', () => {
  const registry = StudentRegistry.open(root());
  registries.push(registry);
  const registered = registry.registerStudent('合成学生', '+6581234567');
  const session = registry.redeem(registered.code);
  const spy = vi.spyOn(registry, 'issueInvitation').mockImplementationOnce(() => { throw new Error('synthetic storage failure'); });
  expect(() => registry.resetInvitation(registered.studentId)).toThrow('synthetic storage failure');
  spy.mockRestore();
  expect(registry.authenticate(session.sessionToken)).toEqual({ studentId: registered.studentId });
  expect(registry.redeem(registered.code).studentId).toBe(registered.studentId);
});
it('administrator lookup does not print the name, phone or code, and reset only returns a new credential', () => {
  const dir = root();
  const registry = StudentRegistry.open(dir);
  registries.push(registry);
  vi.stubEnv('SEL_STUDENT_HOST_DIR', dir);
  const registered = registry.registerStudent('合成学生', '+6581234567');
  const lines: string[] = [];
  expect(runAdminCli(['lookup', '合成学生', '+6581234567'], line => lines.push(line))).toBe(0);
  expect(lines.join('\n')).toContain(registered.studentId);
  expect(lines.join('\n')).not.toContain(registered.code);
  expect(lines.join('\n')).not.toContain('合成学生');
  expect(lines.join('\n')).not.toContain('+6581234567');
  const reset: string[] = [];
  expect(runAdminCli(['reset-invitation', registered.studentId], line => reset.push(line))).toBe(0);
  const newCode = /：([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})/.exec(reset.join('\n'))![1]!;
  expect(newCode).not.toBe(registered.code);
  expect(() => registry.redeem(registered.code)).toThrow();
  expect(registry.redeem(newCode).studentId).toBe(registered.studentId);
});
