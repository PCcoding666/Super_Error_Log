/**
 * 2026-10-22 账号与隐私（P0-6、P0-10、P0-11、P1-5、P1-6）。只用合成身份（测试学生甲…、+65 / 138 开头的假号码）。
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RECOVERY_LOCK_MS, SESSION_TTL_MS, StudentRegistry } from '../../src/studentHost/registry.js';
import { StudentWorkerPool } from '../../src/studentHost/workers.js';
import { liveWorkerPid, WORKER_PID_FILE, writeWorkerPid } from '../../src/studentHost/workerLock.js';
import { spawn } from 'node:child_process';
import { createStudentHostGateway, SESSION_COOKIE, type StudentHostGateway } from '../../src/studentHost/router.js';
import { AttemptGuard, codeKey, LOGIN_LIMITS, REGISTRATION_LIMITS } from '../../src/studentHost/attemptGuard.js';
import { runAdminCli } from '../../src/studentHost/admin-cli.js';
import { RateLimiter } from '../../src/mobile/rateLimit.js';
import { accountLabel, parseAdminFilters, readAdminReport } from '../../src/admin/report.js';
import { SettingsPage } from '../../src/web/views/practice.js';

const DAY = 86_400_000;
const WECHAT_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50(0x1800322f) NetType/WIFI Language/zh_CN';
const SAFARI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-accounts-'));
  roots.push(dir);
  return dir;
}
function openRegistry(dir = root(), now?: () => Date): StudentRegistry {
  const registry = StudentRegistry.open(dir, now ? { now } : undefined);
  registries.push(registry);
  return registry;
}

/** 网关 + 合成 IP（x-test-ip 只在测试夹具里被 ipOf 采信）。 */
async function setup(options: { now?: () => Date; requireRegistrationCode?: boolean } = {}) {
  const dir = root();
  const registry = StudentRegistry.open(dir, options.now ? { now: options.now } : undefined);
  const gateway = await createStudentHostGateway({ registry, now: options.now, requireRegistrationCode: options.requireRegistrationCode ?? false });
  gateways.push(gateway);
  const app = express();
  app.use('/s', gateway.router({ limiter: new RateLimiter(), ipOf: request => String(request.headers['x-test-ip'] ?? '192.0.2.10') }));
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const post = (route: string, fields: Record<string, string>, headers: Record<string, string> = {}) => fetch(base + route, {
    method: 'POST', redirect: 'manual', headers: { origin: base, ...headers }, body: new URLSearchParams(fields),
  });
  const get = (route: string, headers: Record<string, string> = {}) => fetch(base + route, { redirect: 'manual', headers });
  return { dir, registry, base, post, get };
}
function codeFrom(html: string, testId = 'registered-invite-code'): string {
  const code = new RegExp(`data-testid="${testId}"[^>]*>([A-Z0-9-]+)<`).exec(html)?.[1];
  expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  return code!;
}
function sessionCookie(response: Response): string {
  const line = response.headers.getSetCookie().find(value => value.startsWith(`${SESSION_COOKIE}=`) && !value.startsWith(`${SESSION_COOKIE}=;`));
  expect(line).toBeTruthy();
  return line!.split(';')[0]!;
}
/** 注册时自己设的 4 位找回码（合成）。 */
const pinField = { pin: '2580' };

// ---------- P0-6 限流按码计数 + 全站预算 ----------

describe('同一个 Wi-Fi 下全班注册和登录（P0-6）', () => {
  it('40 个同学同一出口 IP 用班级注册码注册全部成功；10 次别人的错码后，正确的码照样能登录', async () => {
    const env = await setup({ requireRegistrationCode: true });
    const { code: classCode } = env.registry.createRegistrationCode({ label: '合成高三一班', maxUses: 45 });
    const statuses: number[] = [];
    const codes: string[] = [];
    for (let i = 1; i <= 40; i++) {
      const response = await env.post('/s/register', { regcode: classCode, name: `测试学生${i}`, phone: `+65800000${String(i).padStart(2, '0')}`, ...pinField }, { 'x-test-ip': '203.0.113.7' });
      statuses.push(response.status);
      if (response.status === 201) codes.push(codeFrom(await response.text())); else await response.text();
    }
    expect(statuses.every(status => status === 201)).toBe(true);
    expect(env.registry.listStudents()).toHaveLength(40);
    expect(env.registry.listRegistrationCodes()[0]).toMatchObject({ usedCount: 40, status: 'active' });
    for (let i = 0; i < 10; i++) {
      const wrong = await env.post('/s/login', { code: 'AAAA-BBBB-CCCC' }, { 'x-test-ip': '203.0.113.7' });
      await wrong.text();
    }
    const target = codes.find(code => !code.startsWith('AAAA'))!;
    const ok = await env.post('/s/login', { code: target }, { 'x-test-ip': '203.0.113.7' });
    expect(ok.status).toBe(303);
    // 全班每人都登录一次（成功不计数）
    for (const code of codes.filter(code => !code.startsWith('AAAA'))) {
      expect((await env.post('/s/login', { code }, { 'x-test-ip': '203.0.113.7' })).status).toBe(303);
    }
  });

  it('同一 IP 失败次数有很宽的上限；全站失败预算用完时所有人都先等一等', () => {
    let now = 1_000_000;
    const guard = new AttemptGuard({ ...LOGIN_LIMITS, perIp: 30, globalFailures: 50 }, () => now);
    for (let i = 0; i < 30; i++) guard.failure(codeKey(`Z${String(i).padStart(3, '0')}XXXXXXXX`, '198.51.100.1'), '198.51.100.1');
    expect(guard.blocked(codeKey('QQQQ-QQQQ-QQQQ', '198.51.100.1'), '198.51.100.1')).toMatchObject({ scope: 'ip' });
    expect(guard.blocked(codeKey('QQQQ-QQQQ-QQQQ', '198.51.100.2'), '198.51.100.2')).toBeNull();
    for (let i = 0; i < 20; i++) guard.failure(codeKey(`Y${String(i).padStart(3, '0')}XXXXXXXX`, `198.51.100.${10 + i}`), `198.51.100.${10 + i}`);
    expect(guard.blocked(codeKey('QQQQ-QQQQ-QQQQ', '198.51.100.99'), '198.51.100.99')).toMatchObject({ scope: 'global' });
    now += LOGIN_LIMITS.windowMs + 1;
    expect(guard.blocked(codeKey('QQQQ-QQQQ-QQQQ', '198.51.100.1'), '198.51.100.1')).toBeNull();
  });

  it('成功不计数且会清掉这个码的失败记录；注册成功计入全站注册预算', () => {
    const guard = new AttemptGuard({ windowMs: 600_000, perCode: 3, perIp: 100, globalFailures: 1000, globalSuccesses: 2 });
    const key = codeKey('ABCD-EFGH', '192.0.2.1');
    guard.failure(key, '192.0.2.1'); guard.failure(key, '192.0.2.1');
    guard.success(key, '192.0.2.1');
    guard.failure(key, '192.0.2.1'); guard.failure(key, '192.0.2.1');
    expect(guard.blocked(key, '192.0.2.1')).toBeNull();
    guard.success(key, '192.0.2.1');
    expect(guard.blocked(key, '192.0.2.1')).toMatchObject({ scope: 'global' });
  });

  it('注册成功另按 IP 每小时限量：同一网络够一个班，再多就要等；别的网络不受影响', () => {
    let now = 1_000_000;
    const guard = new AttemptGuard(REGISTRATION_LIMITS, () => now);
    const key = codeKey('', '203.0.113.7');
    for (let i = 0; i < 59; i++) { guard.success(key, '203.0.113.7'); now += 1_000; }
    expect(guard.blocked(key, '203.0.113.7')).toBeNull();
    guard.success(key, '203.0.113.7');
    // 全站 10 分钟预算（200）远没用完，挡的是这个 IP。
    expect(guard.blocked(key, '203.0.113.7')).toMatchObject({ scope: 'ip_success' });
    expect(guard.blocked(codeKey('', '203.0.113.8'), '203.0.113.8')).toBeNull();
    // 10 分钟的失败窗口过了还不够，要等满一小时。
    now += REGISTRATION_LIMITS.windowMs;
    expect(guard.blocked(key, '203.0.113.7')).toMatchObject({ scope: 'ip_success' });
    now += REGISTRATION_LIMITS.perIpSuccess!.windowMs;
    expect(guard.blocked(key, '203.0.113.7')).toBeNull();
  });

  it('不要注册码时，同一个 IP 一小时最多注册 60 个，第 61 个被挡且页面说清楚', async () => {
    const env = await setup();
    const statuses: number[] = [];
    for (let i = 1; i <= 60; i++) {
      const response = await env.post('/s/register', { name: `测试学生${i}`, phone: `+65800001${String(i).padStart(2, '0')}`, ...pinField }, { 'x-test-ip': '203.0.113.7' });
      statuses.push(response.status);
      await response.text();
    }
    expect(statuses.every(status => status === 201)).toBe(true);
    const blocked = await env.post('/s/register', { name: '测试学生61', phone: '+6580000261', ...pinField }, { 'x-test-ip': '203.0.113.7' });
    expect(blocked.status).toBe(429);
    expect(await blocked.text()).toContain('刚注册的人太多了');
    expect(env.registry.listStudents()).toHaveLength(60);
    const elsewhere = await env.post('/s/register', { name: '测试学生61', phone: '+6580000261', ...pinField }, { 'x-test-ip': '198.51.100.20' });
    expect(elsewhere.status).toBe(201);
  }, 60_000);

  it('限速时页面说清楚是谁太频繁', async () => {
    const env = await setup();
    let last: Response | undefined;
    for (let i = 0; i < 10; i++) { last = await env.post('/s/login', { code: 'AAAA-BBBB-CCCC' }); await last.clone().text(); }
    expect(last!.status).toBe(429);
    expect(await last!.text()).toContain('这个码输错的次数太多了');
  });
});

// ---------- P0-6 注册码门槛 ----------

describe('打开班级注册码时（SEL_REGISTRATION_CODE_REQUIRED=1），注册必须用老师发的注册码（P0-6）', () => {
  it('没有注册码、错码、作废、过期、名额用完都不能注册，也不占名额', async () => {
    let now = new Date('2026-10-22T08:00:00Z');
    const env = await setup({ now: () => now, requireRegistrationCode: true });
    const fields = { name: '测试学生甲', phone: '+6581234567', ...pinField };
    for (const regcode of ['', 'WRNG-0000', 'not a code']) {
      const response = await env.post('/s/register', { ...fields, regcode });
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain('注册码不正确或已经失效');
      expect(html).not.toContain('registered-invite-code');
    }
    const revoked = env.registry.createRegistrationCode({ label: '作废', maxUses: 5 });
    env.registry.revokeRegistrationCode(revoked.id);
    expect((await env.post('/s/register', { ...fields, regcode: revoked.code })).status).toBe(400);
    const small = env.registry.createRegistrationCode({ label: '两人', maxUses: 2, days: 3 });
    expect((await env.post('/s/register', { ...fields, regcode: small.code })).status).toBe(201);
    expect((await env.post('/s/register', { ...fields, name: '测试学生乙', regcode: small.code.toLowerCase().replace('-', ' ') })).status).toBe(201);
    expect((await env.post('/s/register', { ...fields, name: '测试学生丙', regcode: small.code })).status).toBe(400);
    const expiring = env.registry.createRegistrationCode({ label: '一天', maxUses: 5, days: 1 });
    now = new Date(now.getTime() + DAY);
    expect((await env.post('/s/register', { ...fields, name: '测试学生丁', regcode: expiring.code })).status).toBe(400);
    expect(env.registry.listStudents()).toHaveLength(2);
    expect(fs.readdirSync(env.registry.studentsRoot())).toHaveLength(2);
    expect(env.registry.listRegistrationCodes().map(code => code.status).sort()).toEqual(['expired', 'revoked', 'used_up']);
  });

  it('注册码只存哈希；已有账号、已有邀请码和管理员建号不受影响', async () => {
    const env = await setup({ requireRegistrationCode: true });
    const { studentId } = env.registry.createStudent();
    const oldCode = env.registry.issueInvitation(studentId).code;
    const created = env.registry.createRegistrationCode({ label: '合成班' });
    const db = new DatabaseSync(path.join(env.dir, 'registry.db'), { readOnly: true });
    const row = db.prepare('SELECT code_hash FROM registration_codes').get() as { code_hash: string };
    db.close();
    expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(path.join(env.dir, 'registry.db')).includes(Buffer.from(created.code.replace('-', '')))).toBe(false);
    expect((await env.post('/s/login', { code: oldCode })).status).toBe(303);
  });

  it('同一班级码重复登记（含姓名里多一个空格）算失败，且不会给出原码', async () => {
    const env = await setup({ requireRegistrationCode: true });
    const { code } = env.registry.createRegistrationCode({ label: '合成班' });
    const first = await env.post('/s/register', { regcode: code, name: '测试 甲', phone: '13800000001', ...pinField });
    expect(first.status).toBe(201);
    const invite = codeFrom(await first.text());
    const again = await env.post('/s/register', { regcode: code, name: '测试甲', phone: '+86 138-0000-0001', ...pinField });
    expect(again.status).toBe(400);
    expect(await again.text()).not.toContain(invite);
    expect(env.registry.listStudents()).toHaveLength(1);
  });
});

// ---------- 注册降门槛与自助找回（2026-10-23） ----------

describe('默认注册：姓名 + 手机号 + 自己设的 4 位找回码', () => {
  it('不要注册码，也没有同意勾选和隐私规则页；登录页能去找回', async () => {
    const env = await setup();
    const register = await (await env.get('/s/register')).text();
    expect(register).not.toContain('name="regcode"');
    expect(register).not.toContain('name="consent"');
    expect(register).not.toContain('/s/privacy');
    expect(register).toContain('name="pin"');
    expect(await (await env.get('/s/')).text()).toContain('href="/s/recover"');
    const privacy = await env.get('/s/privacy');
    expect(await privacy.text()).not.toContain('个人信息处理规则');
    const response = await env.post('/s/register', { name: '测试学生甲', phone: '+6581234567', ...pinField });
    expect(response.status).toBe(201);
    codeFrom(await response.text());
  });

  it('找回码必须是 4 位数字且不能太好猜；只存加盐摘要，不存明文', async () => {
    const env = await setup();
    for (const pin of ['', '12', '12345', 'abcd', '1234', '0000', '9876', '3456', '4567']) {
      const response = await env.post('/s/register', { name: '测试学生甲', phone: '+6581234567', pin });
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain('4 位数字');
      // 红字贴在找回码下面，姓名和手机号还在；这不是离线壳。
      expect(html).toContain('data-testid="register-pin-error"');
      expect(html).toContain('id="register-pin"');
      expect(html).toMatch(/id="register-pin"[^>]*aria-invalid="true"/);
      expect(html).toContain('value="测试学生甲"');
      expect(html).toContain('value="+6581234567"');
      expect(html).not.toContain('连不上服务器');
      expect(html).toContain('请先设好 4 位找回码');
    }
    expect(env.registry.listStudents()).toHaveLength(0);
    expect((await env.post('/s/register', { name: '测试学生甲', phone: '+6581234567', pin: '1212' })).status).toBe(201);
    const db = new DatabaseSync(path.join(env.dir, 'registry.db'), { readOnly: true });
    const row = db.prepare('SELECT recovery_hash FROM student_registration').get() as { recovery_hash: string };
    db.close();
    expect(row.recovery_hash).toMatch(/^scrypt\$[\w-]+\$[\w-]+$/);
    expect(row.recovery_hash).not.toContain('1212');
  });

  it('姓名或手机号填错时，红字落在对应输入框上，仍然是注册页', async () => {
    const env = await setup();
    const phone = await env.post('/s/register', { name: 'pctest002', phone: '002', pin: '2580' });
    expect(phone.status).toBe(400);
    const phoneHtml = await phone.text();
    expect(phoneHtml).toContain('请填写姓名和有效手机号');
    expect(phoneHtml).toContain('data-testid="register-phone-error"');
    expect(phoneHtml).toMatch(/id="register-phone"[^>]*aria-invalid="true"/);
    expect(phoneHtml).toContain('value="pctest002"');
    expect(phoneHtml).toContain('value="002"');
    expect(phoneHtml).not.toMatch(/id="register-pin"[^>]*aria-invalid="true"/);
    expect(phoneHtml).not.toContain('连不上服务器');
    const name = await env.post('/s/register', { name: '   ', phone: '18924082429', pin: '2580' });
    expect(name.status).toBe(400);
    const nameHtml = await name.text();
    expect(nameHtml).toMatch(/id="register-name"[^>]*aria-invalid="true"/);
    expect(nameHtml).toContain('data-testid="register-name-error"');
    const both = await env.post('/s/register', { name: '', phone: '002', pin: '2580' });
    const bothHtml = await both.text();
    expect(bothHtml).toMatch(/id="register-name"[^>]*aria-invalid="true"/);
    expect(bothHtml).toMatch(/id="register-phone"[^>]*aria-invalid="true"/);
    expect(bothHtml).toContain('请先填好姓名和手机号');
  });

  it('同一姓名手机号再注册：不建新账号，提示用找回码找回', async () => {
    const env = await setup();
    await (await env.post('/s/register', { name: '测试 甲', phone: '13800000001', ...pinField })).text();
    const again = await env.post('/s/register', { name: '测试甲', phone: '+86 138-0000-0001', ...pinField });
    expect(again.status).toBe(400);
    const html = await again.text();
    expect(html).toContain('已经注册过了');
    expect(html).toContain('href="/s/recover"');
    expect(html).not.toContain('registered-invite-code');
    expect(env.registry.listStudents()).toHaveLength(1);
  });
});

describe('自助找回：姓名 + 手机号 + 找回码', () => {
  it('对上就发新码；旧码和所有已登录的设备都失效，学习目录不变', async () => {
    const env = await setup();
    const registered = await env.post('/s/register', { name: '测试学生甲', phone: '13800000001', ...pinField });
    const oldCode = codeFrom(await registered.text());
    const oldSession = sessionCookie(await env.post('/s/login', { code: oldCode }));
    const [student] = env.registry.listStudents();
    for (const fields of [{ pin: '1357' }, { pin: '' }, { phone: '13800000002' }, { name: '测试学生乙' }]) {
      const response = await env.post('/s/recover', { name: '测试学生甲', phone: '138 0000 0001', ...pinField, ...fields });
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain('姓名、手机号或找回码不对');
      expect(html).not.toContain('registered-invite-code');
    }
    const recovered = await env.post('/s/recover', { name: '测试 学生甲', phone: '+86 138-0000-0001', ...pinField });
    expect(recovered.status).toBe(200);
    const html = await recovered.text();
    expect(html).toContain('找回成功');
    const newCode = codeFrom(html);
    expect(newCode).not.toBe(oldCode);
    expect((await env.post('/s/login', { code: oldCode })).status).toBe(400);
    expect((await env.get('/s/account', { cookie: oldSession })).status).toBe(401);
    expect((await env.post('/s/login', { code: newCode })).status).toBe(303);
    expect(env.registry.listStudents().map(s => s.studentId)).toEqual([student!.studentId]);
  });

  it('同一账号连续错 5 次锁 24 小时，计数存在注册表里（重开也还锁着）；到时间后找回码对就能找回', async () => {
    let now = new Date('2026-10-23T08:00:00Z');
    const dir = root();
    const first = openRegistry(dir, () => now);
    first.registerStudent('测试学生甲', '+6581234567', { recoveryPin: '2580' });
    for (let i = 0; i < 4; i++) expect(() => first.recoverInvitation('测试学生甲', '+6581234567', '1357')).toThrow('姓名、手机号或找回码不对');
    first.close();
    registries.splice(registries.indexOf(first), 1);
    const reopened = openRegistry(dir, () => now);
    expect(() => reopened.recoverInvitation('测试学生甲', '+6581234567', '1357')).toThrow('姓名、手机号或找回码不对');
    // 第 5 次错之后，连正确的找回码也要等。
    expect(() => reopened.recoverInvitation('测试学生甲', '+6581234567', '2580')).toThrow('以后再试');
    now = new Date(now.getTime() + RECOVERY_LOCK_MS + 1000);
    expect(reopened.recoverInvitation('测试学生甲', '+6581234567', '2580').code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it('停用的账号不能自助找回', () => {
    const registry = openRegistry();
    const { studentId } = registry.registerStudent('测试学生甲', '+6581234567', { recoveryPin: '2580' });
    registry.disableStudent(studentId);
    expect(() => registry.recoverInvitation('测试学生甲', '+6581234567', '2580')).toThrow('姓名、手机号或找回码不对');
  });

  it('老账号没有找回码：找回不行；登录后在「我的邀请码」里补设，之后就能找回；管理员建的号没有找回', async () => {
    const env = await setup();
    const legacy = env.registry.registerStudent('测试学生甲', '+6581234567');
    const cookie = sessionCookie(await env.post('/s/login', { code: legacy.code }));
    expect((await env.post('/s/recover', { name: '测试学生甲', phone: '+6581234567', pin: '2580' })).status).toBe(400);
    const before = await (await env.get('/s/account', { cookie })).text();
    expect(before).toContain('还没设找回码');
    const weak = await env.post('/s/account/recovery', { pin: '1111' }, { cookie });
    expect(weak.status).toBe(400);
    expect(await weak.text()).toContain('没能保存找回码');
    const saved = await env.post('/s/account/recovery', { pin: '2580' }, { cookie });
    expect(saved.status).toBe(303);
    const flash = saved.headers.getSetCookie().find(line => line.startsWith('sel_account_flash='))!.split(';')[0];
    const after = await (await env.get('/s/account', { cookie: `${cookie}; ${flash}` })).text();
    expect(after).toContain('找回码已保存');
    expect(after).toContain('已经设好了');
    expect((await env.post('/s/recover', { name: '测试学生甲', phone: '+6581234567', pin: '2580' })).status).toBe(200);

    const { studentId } = env.registry.createStudent();
    const adminCookie = sessionCookie(await env.post('/s/login', { code: env.registry.issueInvitation(studentId).code }));
    expect(await (await env.get('/s/account', { cookie: adminCookie })).text()).not.toContain('data-testid="recovery-pin"');
    const refused = await env.post('/s/account/recovery', { pin: '2580' }, { cookie: adminCookie });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('不是用姓名和手机号注册的');
  });

  it('找回页按 IP 限速，被挡时不检查姓名手机号', async () => {
    const env = await setup();
    for (let i = 0; i < 20; i++) {
      const response = await env.post('/s/recover', { name: `测试学生${i}`, phone: '+6581234567', pin: '2580' }, { 'x-test-ip': '198.51.100.9' });
      expect(response.status).toBe(400);
      await response.text();
    }
    const blocked = await env.post('/s/recover', { name: '测试学生甲', phone: '+6581234567', pin: '2580' }, { 'x-test-ip': '198.51.100.9' });
    expect(blocked.status).toBe(429);
    expect(await blocked.text()).toContain('试得太频繁了');
  });
});

// ---------- P0-11 滑动续期、我的邀请码、到期提醒、微信 ----------

describe('会话续期与我的邀请码（P0-11）', () => {
  it('天天用的学生不会在第 30 天掉线；超过 30 天没用才需要重新登录', () => {
    let t = Date.parse('2026-11-01T12:00:00Z');
    const registry = openRegistry(root(), () => new Date(t));
    const registered = registry.registerStudent('测试学生甲', '+6581234567');
    const session = registry.redeem(registered.code);
    for (let day = 1; day <= 45; day++) {
      t += DAY;
      expect(registry.authenticate(session.sessionToken)).not.toBeNull();
      registry.renewSession(session.sessionToken);
    }
    // 同一天内不重复写
    expect(registry.renewSession(session.sessionToken)).toBeNull();
    t += SESSION_TTL_MS + 1;
    expect(registry.authenticate(session.sessionToken)).toBeNull();
    expect(registry.renewSession(session.sessionToken)).toBeNull();
  });

  it('网关在续期时重写 cookie 有效期', async () => {
    let now = new Date();
    const env = await setup({ now: () => now });
    const { studentId } = env.registry.createStudent();
    const login = await env.post('/s/login', { code: env.registry.issueInvitation(studentId).code });
    const cookie = sessionCookie(login);
    expect((await env.get('/s/account', { cookie })).headers.getSetCookie().some(line => line.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
    now = new Date(now.getTime() + 2 * DAY);
    const later = await env.get('/s/account', { cookie });
    expect(later.status).toBe(200);
    const renewed = later.headers.getSetCookie().find(line => line.startsWith(`${SESSION_COOKIE}=`))!;
    expect(renewed.split(';')[0]).toBe(cookie);
    expect(renewed).toContain('HttpOnly');
    expect(Number(/Max-Age=(\d+)/.exec(renewed)![1])).toBeGreaterThan(29 * 86_400);
  });

  it('设置里的「我的邀请码」能看到并复制本机登录用的码；一键重新生成后旧码和别的设备失效、本机继续可用', async () => {
    const env = await setup();
    const registered = await env.post('/s/register', { name: '测试学生甲', phone: '+6581234567', ...pinField });
    const code = codeFrom(await registered.text());
    const phone = sessionCookie(await env.post('/s/login', { code }));
    const tablet = sessionCookie(await env.post('/s/login', { code }));
    const page = await env.get('/s/account', { cookie: phone });
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toContain('no-store');
    const html = await page.text();
    expect(codeFrom(html, 'my-invite-code')).toBe(code);
    expect(html).toContain('data-copy-target');
    expect(html).toContain('/s/account-copy.js');
    const script = await env.get('/s/account-copy.js');
    expect(script.status).toBe(200);
    expect(await script.text()).toContain('clipboard');
    // 库里没有邀请码明文
    expect(fs.readFileSync(path.join(env.dir, 'registry.db')).includes(Buffer.from(code.replace(/-/g, '')))).toBe(false);

    expect((await env.post('/s/account/regenerate', {}, { cookie: phone, origin: 'https://attacker.invalid' })).status).toBe(403);
    const regenerated = await env.post('/s/account/regenerate', {}, { cookie: phone });
    // POST/Redirect/GET：成功后 303 回到查看页，带一次性提示 cookie。
    expect(regenerated.status).toBe(303);
    expect(regenerated.headers.get('location')).toBe('/s/account');
    const flash = regenerated.headers.getSetCookie().find(line => line.startsWith('sel_account_flash='))!.split(';')[0]!;
    const shown = await env.get('/s/account', { cookie: `${phone}; ${flash}` });
    const shownHtml = await shown.text();
    expect(shownHtml).toContain('已经换成新邀请码');
    expect(shown.headers.getSetCookie().some(line => /^sel_account_flash=;.*Max-Age=0/.test(line))).toBe(true);
    const next = codeFrom(shownHtml, 'my-invite-code');
    // 刷新查看页：码不变，提示不再出现，也不会再换一次。
    const refreshed = await (await env.get('/s/account', { cookie: phone })).text();
    expect(codeFrom(refreshed, 'my-invite-code')).toBe(next);
    expect(refreshed).not.toContain('已经换成新邀请码');
    expect(next).not.toBe(code);
    expect((await env.post('/s/login', { code })).status).toBe(400);
    expect((await env.get('/s/account', { cookie: tablet })).status).toBe(401);
    expect(codeFrom(await (await env.get('/s/account', { cookie: phone })).text(), 'my-invite-code')).toBe(next);
    expect((await env.post('/s/login', { code: next })).status).toBe(303);
  });

  it('迁移前登录的旧会话看不到原码，但可以一键重新生成', async () => {
    const env = await setup();
    const { studentId } = env.registry.createStudent();
    const session = env.registry.redeem(env.registry.issueInvitation(studentId).code);
    const db = new DatabaseSync(path.join(env.dir, 'registry.db'));
    db.exec('UPDATE sessions SET invitation_hash = NULL, code_box = NULL');
    db.close();
    const cookie = `${SESSION_COOKIE}=${session.sessionToken}`;
    const html = await (await env.get('/s/account', { cookie })).text();
    expect(html).toContain('data-testid="invite-code-unavailable"');
    expect((await env.post('/s/account/regenerate', {}, { cookie })).status).toBe(303);
    expect(codeFrom(await (await env.get('/s/account', { cookie })).text(), 'my-invite-code')).toMatch(/-/);
  });

  it('邀请码 7 天内到期时提醒；设置页给出一键换码按钮', async () => {
    let now = new Date('2026-11-01T00:00:00Z');
    const env = await setup({ now: () => now });
    const { studentId } = env.registry.createStudent();
    const issued = env.registry.issueInvitation(studentId);
    now = new Date(issued.expiresAt.getTime() - 10 * DAY);
    const cookie = sessionCookie(await env.post('/s/login', { code: issued.code }));
    expect(await (await env.get('/s/account', { cookie })).text()).not.toContain('data-testid="invite-expiring"');
    now = new Date(issued.expiresAt.getTime() - 3 * DAY);
    expect(env.registry.invitationExpiry(studentId)?.toISOString()).toBe(issued.expiresAt.toISOString());
    const warned = await (await env.get('/s/account', { cookie })).text();
    expect(warned).toContain('data-testid="invite-expiring"');
    expect(warned).toContain('3 天后');
    now = new Date(issued.expiresAt.getTime() + DAY);
    expect(env.registry.invitationExpiry(studentId)).toBeNull();
    expect(await (await env.get('/s/account', { cookie })).text()).toContain('已经过期了');

    const soon = new Date(Date.now() + 3 * DAY + 3_600_000).toISOString();
    const settings = renderToStaticMarkup(SettingsPage({ studentHostWorker: true, inviteExpires: soon }));
    expect(settings).toContain('data-testid="invite-expiring"');
    expect(settings).toContain('action="/s/account/regenerate"');
    expect(settings).toContain('href="/s/account"');
    expect(renderToStaticMarkup(SettingsPage({ studentHostWorker: true, inviteExpires: null }))).not.toContain('invite-expiring');
    expect(renderToStaticMarkup(SettingsPage({ studentHostWorker: true, inviteExpires: 'none' }))).toContain('已经过期了');
    expect(renderToStaticMarkup(SettingsPage({ studentHostWorker: false, inviteExpires: soon }))).not.toContain('/s/account');
  });

  it('登录页、注册页在微信里提示「在浏览器打开」，普通浏览器不提示', async () => {
    const env = await setup();
    for (const route of ['/s/', '/s/register']) {
      expect(await (await env.get(route, { 'user-agent': WECHAT_UA })).text()).toContain('data-testid="in-app-browser-notice"');
      expect(await (await env.get(route, { 'user-agent': SAFARI_UA })).text()).not.toContain('in-app-browser-notice');
    }
    expect(await (await env.get('/s/', { 'user-agent': WECHAT_UA })).text()).toContain('在浏览器打开');
  });
});

// ---------- P1-5 后台显示谁是谁 ----------

describe('后台账号列表（P1-5）', () => {
  it('显示登记姓名与手机尾号，管理员建号显示账号编号；停用的账号标出来', async () => {
    const registry = openRegistry();
    const registered = registry.registerStudent('测试学生甲', '13800001234');
    const created = registry.createStudent();
    registry.disableStudent(created.studentId);
    const report = await readAdminReport(registry, parseAdminFilters({}));
    const labels = Object.fromEntries(report.accounts.map(account => [account.studentId, account.label]));
    expect(labels[registered.studentId]).toBe('测试学生甲 · 尾号 1234');
    expect(labels[created.studentId]).toContain(created.studentId.slice(0, 8));
    expect(labels[created.studentId]).toContain('已停用');
    expect(accountLabel({ studentId: created.studentId, registeredName: null, phoneLast4: null, disabledAt: null }, '小测')).toBe('小测');
  });
});

// ---------- P1-5 / P1-6 管理 CLI ----------

describe('管理 CLI（P1-5、P1-6）', () => {
  it('没有设置 SEL_STUDENT_HOST_DIR 或目录不存在时拒绝运行，也不新建注册库', () => {
    const cwd = root();
    const previous = process.cwd();
    process.chdir(cwd);
    try {
      vi.stubEnv('SEL_STUDENT_HOST_DIR', '');
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(runAdminCli(['list'], () => undefined)).toBe(2);
      vi.stubEnv('SEL_STUDENT_HOST_DIR', path.join(cwd, 'typo-dir'));
      expect(runAdminCli(['create'], () => undefined)).toBe(2);
      expect(errors.mock.calls.flat().join('\n')).toContain('拒绝运行');
      errors.mockRestore();
      expect(fs.readdirSync(cwd)).toEqual([]);
    } finally { process.chdir(previous); }
  });

  it('lookup 支持姓名片段和手机尾号；list 显示姓名和尾号', () => {
    const dir = root();
    const registry = openRegistry(dir);
    vi.stubEnv('SEL_STUDENT_HOST_DIR', dir);
    const a = registry.registerStudent('测试学生甲', '13800001234');
    const b = registry.registerStudent('测试学生乙', '13800005678');
    const byName: string[] = [];
    expect(runAdminCli(['lookup', '学生甲'], line => byName.push(line))).toBe(0);
    expect(byName.join('\n')).toContain(a.studentId);
    expect(byName.join('\n')).not.toContain(b.studentId);
    expect(byName.join('\n')).not.toContain('测试学生甲');
    expect(byName.join('\n')).toContain('尾号 1234');
    const byPhone: string[] = [];
    expect(runAdminCli(['lookup', '5678'], line => byPhone.push(line))).toBe(0);
    expect(byPhone.join('\n')).toContain(b.studentId);
    expect(byPhone.join('\n')).not.toContain(a.studentId);
    expect(runAdminCli(['lookup', '9999'], () => undefined)).toBe(1);
    const listed: string[] = [];
    expect(runAdminCli(['list'], line => listed.push(line))).toBe(0);
    expect(listed.join('\n')).toContain('测试学生甲  尾号 1234');
    expect(listed.join('\n')).not.toContain(a.code);
  });

  it('registration-code create / list / revoke', () => {
    const dir = root();
    const registry = openRegistry(dir);
    vi.stubEnv('SEL_STUDENT_HOST_DIR', dir);
    const lines: string[] = [];
    expect(runAdminCli(['registration-code', 'create', '--uses', '35', '--days', '7', '合成', '高三一班'], line => lines.push(line))).toBe(0);
    const code = /注册码（只显示这一次）：([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(lines.join('\n'))![1]!;
    expect(registry.registerStudent('测试学生甲', '+6581234567', { registrationCode: code, recoveryPin: '2580' }).code).toBeTruthy();
    const listed: string[] = [];
    expect(runAdminCli(['registration-code', 'list'], line => listed.push(line))).toBe(0);
    expect(listed.join('\n')).toContain('「合成 高三一班」  已用 1/35  可用');
    expect(listed.join('\n')).not.toContain(code);
    const id = registry.listRegistrationCodes()[0]!.id;
    expect(runAdminCli(['registration-code', 'revoke', id], () => undefined)).toBe(0);
    expect(registry.listRegistrationCodes()[0]!.status).toBe('revoked');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(runAdminCli(['registration-code', 'create', '--uses', 'many'], () => undefined)).toBe(2);
  });

  it('revoke-sessions 说明不作废邀请码；disable 让码和会话都失效，reset-invitation 恢复', () => {
    const dir = root();
    const registry = openRegistry(dir);
    vi.stubEnv('SEL_STUDENT_HOST_DIR', dir);
    const registered = registry.registerStudent('测试学生甲', '+6581234567');
    const session = registry.redeem(registered.code);
    const revoked: string[] = [];
    expect(runAdminCli(['revoke-sessions', registered.studentId], line => revoked.push(line))).toBe(0);
    expect(revoked.join('\n')).toContain('邀请码没有作废');
    expect(registry.redeem(registered.code).studentId).toBe(registered.studentId);
    expect(runAdminCli(['disable', registered.studentId], () => undefined)).toBe(0);
    expect(() => registry.redeem(registered.code)).toThrow('邀请码不正确或已经失效');
    expect(registry.authenticate(session.sessionToken)).toBeNull();
    expect(registry.listStudents()[0]!.disabledAt).toBeTruthy();
    const reset: string[] = [];
    expect(runAdminCli(['reset-invitation', registered.studentId], line => reset.push(line))).toBe(0);
    const next = /：([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})/.exec(reset.join('\n'))![1]!;
    expect(registry.redeem(next).studentId).toBe(registered.studentId);
    expect(registry.listStudents()[0]!.disabledAt).toBeNull();
  });

  it('delete 需要 --confirm、先停用；删除注册资料和目录，同名同号可以重新注册', () => {
    const dir = root();
    const registry = openRegistry(dir);
    const registered = registry.registerStudent('测试学生甲', '+6581234567');
    const other = registry.registerStudent('测试学生乙', '+6581234568');
    fs.writeFileSync(path.join(registry.studentDir(registered.studentId), 'synthetic.txt'), 'x');
    expect(() => registry.deleteStudent(registered.studentId)).toThrow('disable');
    registry.disableStudent(registered.studentId);
    vi.stubEnv('SEL_STUDENT_HOST_DIR', dir);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(runAdminCli(['delete', registered.studentId], () => undefined)).toBe(2);
    expect(registry.deleteStudent(registered.studentId)).toEqual({ removedDirectory: true });
    expect(fs.existsSync(registry.studentDir(registered.studentId))).toBe(false);
    expect(registry.listStudents().map(student => student.studentId)).toEqual([other.studentId]);
    expect(registry.findRegisteredStudent('测试学生甲', '+6581234567')).toBeNull();
    expect(fs.readFileSync(path.join(dir, 'deletions.log'), 'utf8')).toContain(registered.studentId);
    expect(fs.readFileSync(path.join(dir, 'deletions.log'), 'utf8')).not.toContain('测试学生甲');
    expect(registry.redeem(other.code).studentId).toBe(other.studentId);
    expect(registry.registerStudent('测试学生甲', '+6581234567').studentId).not.toBe(registered.studentId);
  });

  it('delete 在该学生 worker 仍存活时拒绝（不靠空闲时间推断）；进程退出后的过期标记不挡删除', async () => {
    const dir = root();
    const registry = openRegistry(dir);
    const registered = registry.registerStudent('测试学生甲', '+6581234567');
    const studentDir = registry.studentDir(registered.studentId);
    registry.disableStudent(registered.studentId);
    // 一个命令行像 worker 的合成长寿进程（不加载任何业务代码）。
    const script = path.join(root(), 'worker.js');
    fs.writeFileSync(script, 'setInterval(() => {}, 1000);');
    const child = spawn(process.execPath, [script], { stdio: 'ignore' });
    await new Promise<void>(resolve => child.once('spawn', () => resolve()));
    try {
      writeWorkerPid(studentDir, child.pid!);
      expect(liveWorkerPid(studentDir)).toBe(child.pid);
      expect(() => registry.deleteStudent(registered.studentId)).toThrow('还在运行');
      expect(registry.listStudents()).toHaveLength(1);
      expect(fs.existsSync(studentDir)).toBe(true);
    } finally {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }
    // 被强杀后留下的标记：pid 已不存在，按已退出处理。
    expect(fs.existsSync(path.join(studentDir, WORKER_PID_FILE))).toBe(true);
    expect(liveWorkerPid(studentDir)).toBeNull();
    // 损坏的标记：无法确认，宁可拒绝。
    fs.writeFileSync(path.join(studentDir, WORKER_PID_FILE), 'garbage');
    expect(() => registry.deleteStudent(registered.studentId)).toThrow('无法识别');
    fs.rmSync(path.join(studentDir, WORKER_PID_FILE));
    expect(registry.deleteStudent(registered.studentId)).toEqual({ removedDirectory: true });
  });

  it('真实学生 worker 运行时写存活标记，正常退出时清掉；运行期间 delete 被拒绝', async () => {
    const dir = root();
    const registry = openRegistry(dir);
    const registered = registry.registerStudent('测试学生甲', '+6581234567');
    const pool = new StudentWorkerPool({ dirFor: id => registry.studentDir(id), env: { NODE_ENV: 'test', SEL_STUDENT_WORKER_FAKE: '1', SEL_AI_MODE: 'mock' } });
    try {
      await pool.ensure(registered.studentId);
      const studentDir = registry.studentDir(registered.studentId);
      expect(liveWorkerPid(studentDir)).toBeGreaterThan(0);
      registry.disableStudent(registered.studentId);
      expect(() => registry.deleteStudent(registered.studentId)).toThrow('还在运行');
      await pool.stopAll();
      expect(fs.existsSync(path.join(studentDir, WORKER_PID_FILE))).toBe(false);
      expect(registry.deleteStudent(registered.studentId)).toEqual({ removedDirectory: true });
    } finally { await pool.stopAll(); }
  }, 60_000);

  it('delete --confirm 通过 CLI 删除已停用、没有运行进程的账号', () => {
    const dir = root();
    const registry = openRegistry(dir);
    const registered = registry.registerStudent('测试学生甲', '+6581234567');
    registry.disableStudent(registered.studentId);
    vi.stubEnv('SEL_STUDENT_HOST_DIR', dir);
    const lines: string[] = [];
    expect(runAdminCli(['delete', registered.studentId, '--confirm'], line => lines.push(line))).toBe(0);
    expect(lines.join('\n')).toContain('已删除');
    expect(registry.listStudents()).toHaveLength(0);
  });

  it('export 导出登记资料和学习数据副本，不含码和令牌', () => {
    const dir = root();
    const out = root();
    const registry = openRegistry(dir);
    vi.stubEnv('SEL_STUDENT_HOST_DIR', dir);
    const registered = registry.registerStudent('测试学生甲', '+6581234567');
    registry.redeem(registered.code);
    const studentDir = registry.studentDir(registered.studentId);
    const app = new DatabaseSync(path.join(studentDir, 'app.db'));
    app.exec("PRAGMA journal_mode = WAL; CREATE TABLE error_item(id TEXT); INSERT INTO error_item VALUES ('synthetic-1'), ('synthetic-2');");
    fs.mkdirSync(path.join(studentDir, 'uploads'));
    fs.writeFileSync(path.join(studentDir, 'uploads', 'photo.jpg'), 'synthetic-bytes');
    const lines: string[] = [];
    expect(runAdminCli(['export', registered.studentId, out], line => lines.push(line))).toBe(0);
    app.close();
    const target = /已导出到：(.+)$/m.exec(lines.join('\n'))![1]!;
    expect(fs.statSync(target).mode & 0o777).toBe(0o700);
    const account = JSON.parse(fs.readFileSync(path.join(target, 'account.json'), 'utf8'));
    expect(account.registration).toMatchObject({ name: '测试学生甲', phone: '+6581234567' });
    const exported = JSON.stringify(account);
    expect(exported).not.toContain(registered.code);
    expect(exported).not.toContain('code_hash');
    expect(exported).not.toContain('token_hash');
    const copy = new DatabaseSync(path.join(target, 'data', 'app.db'), { readOnly: true });
    expect(copy.prepare('SELECT COUNT(*) AS n FROM error_item').get()).toEqual({ n: 2 });
    copy.close();
    expect(fs.readFileSync(path.join(target, 'data', 'uploads', 'photo.jpg'), 'utf8')).toBe('synthetic-bytes');
    expect(runAdminCli(['export', registered.studentId, out], () => undefined)).toBe(1);
  });

  it('export 解开符号链接后再检查：指向注册库或学生目录的输出位置一律拒绝', () => {
    const dir = root();
    const outside = root();
    const registry = openRegistry(dir);
    const registered = registry.registerStudent('测试学生甲', '+6581234567');
    const studentDir = registry.studentDir(registered.studentId);
    const intoHost = path.join(outside, 'looks-safe');
    fs.symlinkSync(dir, intoHost);
    const intoStudent = path.join(outside, 'also-safe');
    fs.symlinkSync(studentDir, intoStudent);
    for (const target of [intoHost, path.join(intoHost, 'new-subdir'), intoStudent, dir, path.join(studentDir, 'nested')]) {
      expect(() => registry.exportStudent(registered.studentId, target)).toThrow('不要导出到学生空间目录里面');
    }
    expect(fs.readdirSync(studentDir)).toEqual([]);
    expect(fs.readdirSync(dir).filter(name => name.includes(registered.studentId))).toEqual([]);
    // 指向外面的符号链接照常可用，结果写在真实路径下。
    const realOut = root();
    const link = path.join(outside, 'out-link');
    fs.symlinkSync(realOut, link);
    const target = registry.exportStudent(registered.studentId, link);
    expect(target.startsWith(fs.realpathSync(realOut) + path.sep)).toBe(true);
  });
});

// ---------- 增量迁移 ----------

describe('增量迁移（老库照常可用）', () => {
  it('10-21 版本的注册库（无新列）打开后旧账号、旧码、旧会话都能用', () => {
    const dir = root();
    const db = new DatabaseSync(path.join(dir, 'registry.db'));
    const id = crypto.randomUUID();
    const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
    db.exec(`CREATE TABLE students(id TEXT PRIMARY KEY, created_at TEXT NOT NULL, account_role TEXT NOT NULL DEFAULT 'student', last_seen_at TEXT);
      CREATE TABLE invitations(code_hash TEXT PRIMARY KEY, student_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, redeemed_at TEXT, public_id TEXT, reusable INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, student_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE student_registration(student_id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, UNIQUE(name, phone));`);
    db.prepare('INSERT INTO students (id, created_at) VALUES (?, ?)').run(id, '2026-10-21T00:00:00.000Z');
    db.prepare('INSERT INTO student_registration VALUES (?, ?, ?)').run(id, '测试学生甲', '+8613800001234');
    db.prepare('INSERT INTO invitations VALUES (?, ?, ?, ?, NULL, ?, 1)').run(hash('0123456789AB'), id, '2026-10-21T00:00:00.000Z', '2026-12-20T00:00:00.000Z', crypto.randomUUID());
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, 0)').run(hash('synthetic-session'), id, '2026-10-21T00:00:00.000Z', '2026-11-20T00:00:00.000Z');
    db.close();
    const registry = openRegistry(dir, () => new Date('2026-11-01T00:00:00.000Z'));
    expect(registry.authenticate('synthetic-session')).toEqual({ studentId: id });
    expect(registry.redeem('0123-4567-89AB').studentId).toBe(id);
    expect(registry.listStudents()[0]).toMatchObject({ registeredName: '测试学生甲', phoneLast4: '1234', disabledAt: null });
    expect(registry.sessionInvitation('synthetic-session')).toMatchObject({ code: null });
    expect(registry.renewSession('synthetic-session')).not.toBeNull();
    expect(registry.authenticate('synthetic-session')).toEqual({ studentId: id });
  });
});
