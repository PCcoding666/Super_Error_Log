/**
 * 学生邀请码网关 + 独立学生 worker（2026-10-15 S1）集成测试。
 * 真实网关 + 真实 fork 出来的 worker 进程 + 合成识别（SEL_STUDENT_WORKER_FAKE=1）与 mock 转写：
 * 不假装真实模型、不调真实模型、不读 .env 与 data/。
 * 覆盖：注册表事务/单用/过期/撤销/容量、登录与限速、退出清理、双学生数据隔离、
 * 路径攻击与伪造 cookie/header、body 流转发、worker 崩溃与重启恢复、令牌刷新。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatInviteCode, MAX_STUDENTS, normalizeInviteCode, RegistryError, StudentRegistry } from '../../src/studentHost/registry.js';
import { runAdminCli } from '../../src/studentHost/admin-cli.js';
import { createStudentHostGateway, LoginThrottle, SESSION_COOKIE, type StudentHostGateway } from '../../src/studentHost/router.js';
import { StudentWorkerPool, WorkerStartError } from '../../src/studentHost/workers.js';
import { RateLimiter } from '../../src/mobile/rateLimit.js';
import { MOCK_TRANSCRIPT } from '../../src/ai/asr.js';

const roots: string[] = [];
const gateways: StudentHostGateway[] = [];
const servers: Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(gateways.splice(0).map(gateway => gateway.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});

function tempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** 带 cookie 的浏览器替身：不跟随重定向，自己记 cookie（与 webClient.test.ts 同一形状）。 */
class Browser {
  cookies = new Map<string, string>();
  lastSetCookie: string[] = [];
  constructor(readonly base: string) {}
  async request(pathname: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('user-agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) Safari/604.1');
    if (this.cookies.size > 0) headers.set('cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    if (init.method === 'POST' && !headers.has('origin')) headers.set('origin', this.base);
    const response = await fetch(`${this.base}${pathname}`, { ...init, headers, redirect: 'manual' });
    this.lastSetCookie = response.headers.getSetCookie();
    for (const line of this.lastSetCookie) {
      const [pair] = line.split(';');
      const index = pair!.indexOf('=');
      const name = pair!.slice(0, index); const value = pair!.slice(index + 1);
      if (/Max-Age=0/.test(line)) this.cookies.delete(name); else this.cookies.set(name, value);
    }
    return response;
  }
  get(pathname: string): Promise<Response> { return this.request(pathname); }
  post(pathname: string, fields: Record<string, string> = {}, headers: Record<string, string> = {}): Promise<Response> {
    const body = new URLSearchParams(fields);
    return this.request(pathname, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } });
  }
}

interface HostSetup { base: string; gateway: StudentHostGateway; registry: StudentRegistry; pool: StudentWorkerPool; hostDir: string }

function newPool(registry: StudentRegistry): StudentWorkerPool {
  return new StudentWorkerPool({
    dirFor: studentId => registry.studentDir(studentId),
    env: { SEL_STUDENT_WORKER_FAKE: '1', SEL_AI_MODE: 'mock' },
  });
}

/** 把网关挂到一个真实 HTTP 端口上（不依赖任何外层 middleware）。 */
async function serve(gateway: StudentHostGateway): Promise<string> {
  const app = express();
  app.disable('x-powered-by');
  app.use('/s', gateway.router({ limiter: new RateLimiter(), ipOf: request => request.socket.remoteAddress ?? 'unknown' }));
  app.use((_request, response) => response.status(404).json({ error: { code: 'not_found', message: '接口不存在。' } }));
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function setupHost(): Promise<HostSetup> {
  const hostDir = tempRoot('sel-host-');
  const registry = StudentRegistry.open(hostDir);
  const pool = newPool(registry);
  const gateway = await createStudentHostGateway({ hostDir, registry, pool });
  gateways.push(gateway);
  const base = await serve(gateway);
  return { base, gateway, registry, pool, hostDir };
}

/** 管理员开学生 + 登录好的浏览器。 */
async function loginBrowser(env: HostSetup): Promise<{ browser: Browser; studentId: string; code: string }> {
  const { studentId } = env.registry.createStudent();
  const { code } = env.registry.issueInvitation(studentId);
  const browser = new Browser(env.base);
  const response = await browser.post('/s/login', { code });
  expect(response.status).toBe(303);
  expect(browser.cookies.has(SESSION_COOKIE)).toBe(true);
  return { browser, studentId, code };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('等待超时');
}

/** 发原始（不规范化）路径的请求：fetch 会把 /s/../v1 折叠掉，路径攻击必须用原始 socket 发。 */
function rawRequest(base: string, rawPath: string, cookie?: string): Promise<{ status: number; body: string }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: url.hostname, port: url.port, method: 'GET', path: rawPath,
      headers: { cookie: cookie ?? '', 'user-agent': 'raw-test' },
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on('error', reject);
    request.setTimeout(10_000, () => request.destroy(new Error('raw request timeout')));
    request.end();
  });
}

async function photoBytes(color: string): Promise<Buffer> {
  return sharp({ create: { width: 600, height: 780, channels: 3, background: color } }).jpeg().toBuffer();
}

async function uploadPhoto(browser: Browser, bytes: Buffer): Promise<{ ok: boolean; jobId?: string }> {
  const form = new FormData();
  form.append('key', crypto.randomUUID());
  form.append('photo', new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }), 'photo.jpg');
  const response = await browser.request('/s/capture', { method: 'POST', body: form, headers: { accept: 'application/json' } });
  return (await response.json()) as { ok: boolean; jobId?: string };
}

// ---------- 注册表（纯本进程，不拉 worker） ----------

describe('学生注册表', () => {
  it('邀请码：12 位分组展示、大小写/空格/短横线不敏感、库里只存 SHA256', () => {
    const registry = StudentRegistry.open(tempRoot('sel-reg-'));
    const { studentId } = registry.createStudent();
    const { code, expiresAt } = registry.issueInvitation(studentId);
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    // 大小写、空格、短横线都不影响兑换
    const messy = code.toLowerCase().replace('-', ' ').replace('-', '  -  ');
    expect(normalizeInviteCode(messy)).toBe(code.replace(/-/g, ''));
    const session = registry.redeem(messy);
    expect(session.studentId).toBe(studentId);
    expect(registry.authenticate(session.sessionToken)).toEqual({ studentId });
    // 库里只有哈希：明文码与明文令牌都不在库文件中
    const db = new DatabaseSync(path.join(registry.hostDir, 'registry.db'), { readOnly: true });
    const invitation = db.prepare('SELECT code_hash FROM invitations').get() as { code_hash: string };
    const stored = db.prepare('SELECT token_hash FROM sessions').get() as { token_hash: string };
    db.close();
    expect(invitation.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.token_hash).not.toBe(session.sessionToken);
    expect(fs.readFileSync(path.join(registry.hostDir, 'registry.db')).includes(code.replace(/-/g, ''))).toBe(false);
    registry.close();
  });

  it('一次性：兑换后重放失败；并发兑换只有一个成功', async () => {
    const registry = StudentRegistry.open(tempRoot('sel-reg-'));
    const { studentId } = registry.createStudent();
    const { code } = registry.issueInvitation(studentId);
    const [first, second] = await Promise.allSettled([Promise.resolve().then(() => registry.redeem(code)), Promise.resolve().then(() => registry.redeem(code))]);
    const succeeded = [first, second].filter(r => r.status === 'fulfilled');
    expect(succeeded).toHaveLength(1);
    expect(() => registry.redeem(code)).toThrowError(RegistryError);
    // 失败提示统一，不区分不存在/已用/过期
    expect(() => registry.redeem(code)).toThrowError('邀请码不正确或已经失效。');
    expect(() => registry.redeem('AAAA-BBBB-CCCC')).toThrowError('邀请码不正确或已经失效。');
    expect(() => registry.redeem('not a code')).toThrowError('邀请码不正确或已经失效。');
    registry.close();
  });

  it('过期邀请码（7 天）与过期会话（30 天）都拒绝', () => {
    let now = new Date('2026-10-15T00:00:00Z');
    const registry = StudentRegistry.open(tempRoot('sel-reg-'), { now: () => now });
    const { studentId } = registry.createStudent();
    const { code } = registry.issueInvitation(studentId);
    now = new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000);
    expect(() => registry.redeem(code)).toThrowError('邀请码不正确或已经失效。');

    now = new Date('2026-10-15T00:00:00Z');
    const second = registry.issueInvitation(studentId);
    const session = registry.redeem(second.code);
    now = new Date(now.getTime() + 31 * 24 * 60 * 60 * 1000);
    expect(registry.authenticate(session.sessionToken)).toBeNull();
    registry.close();
  });

  it('空间上限：最多 3 个学生，第 4 个拒绝且不产生目录', () => {
    const hostDir = tempRoot('sel-reg-');
    const registry = StudentRegistry.open(hostDir);
    for (let i = 0; i < MAX_STUDENTS; i += 1) registry.createStudent();
    expect(() => registry.createStudent()).toThrowError(/最多 3 个/);
    expect(fs.readdirSync(path.join(hostDir, 'students'))).toHaveLength(MAX_STUDENTS);
    // 目录权限 0700
    const studentId = registry.listStudents()[0]!.studentId;
    expect(fs.statSync(registry.studentDir(studentId)).mode & 0o777).toBe(0o700);
    registry.close();
  });

  it('退出与撤销：revokeSession 使单个会话失效；revoke-sessions 全撤', () => {
    const registry = StudentRegistry.open(tempRoot('sel-reg-'));
    const { studentId } = registry.createStudent();
    const first = registry.redeem(registry.issueInvitation(studentId).code);
    const second = registry.redeem(registry.issueInvitation(studentId).code);
    registry.revokeSession(first.sessionToken);
    expect(registry.authenticate(first.sessionToken)).toBeNull();
    expect(registry.authenticate(second.sessionToken)).not.toBeNull();
    expect(registry.revokeSessions(studentId)).toBe(1);
    expect(registry.authenticate(second.sessionToken)).toBeNull();
    registry.close();
  });

  it('管理 CLI：create 打印一次码、list 不含秘密、revoke-sessions 生效', () => {
    const hostDir = tempRoot('sel-reg-');
    process.env.SEL_STUDENT_HOST_DIR = hostDir;
    try {
      const lines: string[] = [];
      expect(runAdminCli(['create'], line => lines.push(line))).toBe(0);
      const codeMatch = /邀请码.*：([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})/.exec(lines.join('\n'));
      expect(codeMatch).not.toBeNull();
      const listed: string[] = [];
      expect(runAdminCli(['list'], line => listed.push(line))).toBe(0);
      expect(listed.join('\n')).toContain('可用邀请码 1');
      expect(listed.join('\n')).not.toContain(codeMatch![1]!);
      const registry = StudentRegistry.open(hostDir);
      const studentId = registry.listStudents()[0]!.studentId;
      registry.close();
      expect(runAdminCli(['revoke-sessions', studentId], () => undefined)).toBe(0);
      expect(runAdminCli(['revoke-sessions', 'missing'], () => undefined)).toBe(1);
    } finally {
      delete process.env.SEL_STUDENT_HOST_DIR;
    }
  });
});

// ---------- 网关：登录、退出、静态壳 ----------

describe('学生网关登录与退出', () => {
  it('匿名只能看到登录页与公开静态壳；登录页不含任何学生数据', async () => {
    const env = await setupHost();
    const browser = new Browser(env.base);
    const page = await browser.get('/s/');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('输入邀请码');
    expect(page.headers.get('cache-control')).toContain('no-store');
    for (const asset of ['/s/manifest.webmanifest', '/s/sw.js', '/s/assets/app.css', '/s/assets/app.js', '/s/offline']) {
      const response = await browser.get(asset);
      expect(response.status).toBe(200);
    }
    // 匿名 POST 一律回登录页，不进 worker
    const post = await browser.post('/s/settings', { practiceSlot: 'x', paperLocation: 'home' });
    expect(post.status).toBe(303);
    expect(post.headers.get('location')).toBe('/s/');
  });

  it('登录成功：sel_student HttpOnly/SameSite=Lax/Path=/s；错误码统一提示', async () => {
    const env = await setupHost();
    const { studentId } = env.registry.createStudent();
    const { code } = env.registry.issueInvitation(studentId);
    const browser = new Browser(env.base);
    const bad = await browser.post('/s/login', { code: 'AAAA-BBBB-CCCC' });
    expect(bad.status).toBe(400);
    const badText = await bad.text();
    expect(badText).toContain('这个邀请码进不去');
    // 错误提示不区分「不存在」与「格式错」
    const malformed = await browser.post('/s/login', { code: '12345' });
    expect(await malformed.text()).toContain('这个邀请码进不去');
    // 跨站提交拒绝
    const crossSite = await browser.post('/s/login', { code }, { origin: 'https://evil.example' });
    expect(crossSite.status).toBe(403);
    // 正确码（小写 + 空格）登录
    const ok = await browser.post('/s/login', { code: code.toLowerCase().replace('-', ' ') });
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/s/?login=1');
    const cookie = browser.lastSetCookie.find(line => line.startsWith(`${SESSION_COOKIE}=`))!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/s');
  });

  it('失败登录按 IP 限速：10 次失败后 429，超限期间不再校验码', async () => {
    const env = await setupHost();
    const browser = new Browser(env.base);
    for (let i = 0; i < 9; i += 1) {
      const response = await browser.post('/s/login', { code: 'AAAA-BBBB-CCCC' });
      expect(response.status).toBe(400);
    }
    // 第 10 次失败正好到顶：记录后立即按超限回 429
    const limited = await browser.post('/s/login', { code: 'AAAA-BBBB-CCCC' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).not.toBeNull();
    // 超限期间连正确码也进不去（防探测）
    const { studentId } = env.registry.createStudent();
    const { code } = env.registry.issueInvitation(studentId);
    const blocked = await browser.post('/s/login', { code });
    expect(blocked.status).toBe(429);
  });

  it('退出登录：会话立即失效、本机标记清掉、旧 cookie 再看只能看到登录页', async () => {
    const env = await setupHost();
    const { browser } = await loginBrowser(env);
    const token = browser.cookies.get(SESSION_COOKIE)!;
    // 先拿一个本机标记（同意上传说明 → sel_consent 经网关白名单回种）
    const consent = await browser.post('/s/consent');
    expect(consent.status).toBe(303);
    expect(browser.cookies.has('sel_consent')).toBe(true);
    expect(browser.lastSetCookie.every(line => !line.startsWith('sel_device='))).toBe(true);
    const logout = await browser.post('/s/logout');
    expect(logout.status).toBe(303);
    expect(browser.cookies.has(SESSION_COOKIE)).toBe(false);
    expect(browser.cookies.has('sel_consent')).toBe(false);
    expect(env.registry.authenticate(token)).toBeNull();
    const page = await browser.request('/s/', { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    expect(page.status).toBe(401);
    expect(await page.text()).toContain('输入邀请码');
  }, 90_000);
});

// ---------- 登录限速（注入时钟） ----------

describe('登录限速', () => {
  it('同 IP 到顶即挡；跨 IP 互不影响；10 分钟窗口过后恢复', () => {
    let now = 1_000_000;
    const throttle = new LoginThrottle(() => now);
    expect(throttle.blockedSeconds('1.1.1.1')).toBe(0);
    for (let i = 0; i < 10; i += 1) throttle.record('1.1.1.1');
    expect(throttle.blockedSeconds('1.1.1.1')).toBeGreaterThan(0);
    // 别的 IP 不受影响
    expect(throttle.blockedSeconds('2.2.2.2')).toBe(0);
    // 窗口过期后恢复
    now += 600_001;
    expect(throttle.blockedSeconds('1.1.1.1')).toBe(0);
    // retry-after 有界：剩余秒数随时间收敛
    for (let i = 0; i < 10; i += 1) throttle.record('3.3.3.3');
    const first = throttle.blockedSeconds('3.3.3.3');
    now += 300_000;
    const later = throttle.blockedSeconds('3.3.3.3');
    expect(later).toBeGreaterThan(0);
    expect(later).toBeLessThan(first);
  });
});

// ---------- 网关 + 真实 worker：隔离、代理、生命周期 ----------

describe('学生 worker 隔离与代理', () => {
  it('a rejected fix form preserves the session voice context and can transcribe again', async () => {
    const env = await setupHost();
    const { browser } = await loginBrowser(env);
    await browser.post('/s/consent');
    const upload = await uploadPhoto(browser, await photoBytes('#c1d5ef'));
    expect(upload.ok).toBe(true);
    let questionId: string | undefined;
    await waitFor(async () => {
      const html = await (await browser.get(`/s/photos/${upload.jobId}`)).text();
      questionId = /name="questionIds" value="([^"]+)"/.exec(html)?.[1];
      return questionId !== undefined;
    });
    expect((await browser.post(`/s/photos/${upload.jobId}/select`, { questionIds: questionId! })).status).toBe(303);
    let itemId: string | undefined;
    await waitFor(async () => {
      const html = await (await browser.get('/s/items')).text();
      itemId = /\/s\/items\/(itm_[0-9a-f]{16})/.exec(html)?.[1];
      return itemId !== undefined;
    });
    const contextOf = (html: string): string | undefined => /<meta name="sel-voice-context" content="([0-9a-f]{64})"\s*\/?\s*>/.exec(html)?.[1];
    const page = await browser.get(`/s/items/${itemId}/fix`);
    expect(page.status).toBe(200);
    const context = contextOf(await page.text());
    expect(context).toBe(crypto.createHash('sha256').update(browser.cookies.get(SESSION_COOKIE)!).digest('hex'));
    const rejected = await browser.post(`/s/items/${itemId}/fix`, { instruction: '' }, {
      'x-sel-internal-voice-context': 'f'.repeat(64),
    });
    expect(rejected.status).toBe(400);
    expect(rejected.headers.get('cache-control')).toBe('private, no-store');
    const html = await rejected.text();
    expect(html).toContain('data-endpoint="/s/voice"');
    expect(contextOf(html)).toBe(context);
    const voice = await browser.request('/s/voice', {
      method: 'POST', body: 'SYNTHETIC-FIX-VOICE',
      headers: { 'content-type': 'audio/webm', 'x-sel-voice-context': contextOf(html)! },
    });
    expect(voice.status).toBe(200);
    expect(await voice.json()).toEqual({ text: MOCK_TRANSCRIPT });
  }, 120_000);

  it('old-tab voice is rejected after switching students; current context transcribes without persisting audio', async () => {
    const env = await setupHost();
    const { browser, studentId: studentA } = await loginBrowser(env);
    const readContext = async (): Promise<string> => {
      // A polling read renders the same context without an unrelated finish-time
      // page-view audit write racing the subsequent voice persistence snapshot.
      const response = await browser.request('/s/settings', { headers: { 'x-sel-internal-voice-context': 'f'.repeat(64), 'x-sel-poll': '1' } });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      const html = await response.text();
      const context = /<meta name="sel-voice-context" content="([0-9a-f]{64})"\s*\/?\s*>/.exec(html)?.[1];
      expect(context).toBe(crypto.createHash('sha256').update(browser.cookies.get(SESSION_COOKIE)!).digest('hex'));
      expect(html).not.toContain(browser.cookies.get(SESSION_COOKIE)!);
      return context!;
    };
    const contextA = await readContext();
    const { studentId: studentB } = env.registry.createStudent();
    const invitationB = env.registry.issueInvitation(studentB);
    expect((await browser.post('/s/login', { code: invitationB.code })).status).toBe(303);
    const contextB = await readContext();
    expect(contextB).not.toBe(contextA);
    const fileHashes = (): Record<string, string> => {
      const hashes: Record<string, string> = {};
      const visit = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) visit(full);
          else if (entry.isFile()) {
            // SQLite updates shared-memory read marks even for read-only requests.
            // Keep the filename check; compare persistent data and every other file byte-for-byte.
            hashes[path.relative(env.hostDir, full)] = entry.name === 'app.db-shm'
              ? 'sqlite-shared-memory'
              : crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
          }
        }
      };
      for (const id of [studentA, studentB]) visit(env.registry.studentDir(id));
      return hashes;
    };
    const before = fileHashes();
    const ensure = vi.spyOn(env.pool, 'ensure');
    const voice = (context?: string) => browser.request('/s/voice', {
      method: 'POST', body: 'SYNTHETIC-PRIVATE-VOICE', headers: {
        'content-type': 'audio/webm', 'x-sel-internal-voice-context': contextB,
        ...(context === undefined ? {} : { 'x-sel-voice-context': context }),
      },
    });
    for (const context of [contextA, undefined]) {
      const rejected = await voice(context);
      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toMatchObject({ error: { code: 'voice_context_mismatch' } });
    }
    expect(ensure).not.toHaveBeenCalled();
    const accepted = await voice(contextB);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ text: MOCK_TRANSCRIPT });
    expect(ensure).toHaveBeenCalledExactlyOnceWith(studentB);
    expect(fileHashes()).toEqual(before);
    for (const route of ['/s/offline', '/s/sw.js', '/s/assets/app.js']) {
      const publicResponse = await browser.get(route);
      expect(await publicResponse.text()).not.toContain(contextB);
    }
  }, 120_000);

  it('两个学生：各自 worker、各自目录与数据库；设置互不可见', async () => {
    const env = await setupHost();
    const a = await loginBrowser(env);
    const b = await loginBrowser(env);
    const saveA = await a.browser.post('/s/settings', { practiceSlot: '甲放学后', paperLocation: 'home' });
    expect(saveA.status).toBe(303);
    const saveB = await b.browser.post('/s/settings', { practiceSlot: '乙晚饭后', paperLocation: 'school' });
    expect(saveB.status).toBe(303);
    expect(await (await a.browser.get('/s/settings')).text()).toContain('甲放学后');
    expect(await (await a.browser.get('/s/settings')).text()).not.toContain('乙晚饭后');
    expect(await (await b.browser.get('/s/settings')).text()).toContain('乙晚饭后');
    // 独立进程 ×2、独立目录、各自 app.db
    expect(env.pool.size).toBe(2);
    for (const { studentId } of [a, b]) {
      const dir = env.registry.studentDir(studentId);
      expect(fs.existsSync(path.join(dir, 'app.db'))).toBe(true);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    }
    expect(env.registry.studentDir(a.studentId)).not.toBe(env.registry.studentDir(b.studentId));
    // 设置页（worker 模式）有退出按钮
    expect(await (await a.browser.get('/s/settings')).text()).toContain('退出登录');
  }, 120_000);

  it('照片与图片隔离：A 的照片 B 的 /s/photos 没有；猜到 A 的 jobId 读图也是 404', async () => {
    const env = await setupHost();
    const a = await loginBrowser(env);
    const b = await loginBrowser(env);
    await a.browser.post('/s/consent');
    const upload = await uploadPhoto(a.browser, await photoBytes('#b0b8ff'));
    expect(upload.ok).toBe(true);
    const jobId = upload.jobId!;
    await waitFor(async () => (await (await a.browser.get('/s/photos')).text()).includes(jobId));
    expect(await (await b.browser.get('/s/photos')).text()).not.toContain(jobId);
    // 同一 ID 在 B 的空间里不存在（B 的请求只进 B 的 worker）
    const imageAsB = await b.browser.get(`/s/img/photo/${jobId}`);
    expect(imageAsB.status).toBe(404);
    const pageAsB = await b.browser.get(`/s/photos/${jobId}`);
    expect(pageAsB.status).toBe(404);
  }, 120_000);

  it('伪造 sel_device / authorization / X-Real-IP 都被网关剥掉；worker 的 Set-Cookie 只放行业务 cookie', async () => {
    const env = await setupHost();
    const { browser } = await loginBrowser(env);
    const token = browser.cookies.get(SESSION_COOKIE)!;
    const forged = await browser.request('/s/', {
      headers: {
        cookie: `${SESSION_COOKIE}=${token}; sel_device=forged-device-token`,
        authorization: 'Bearer forged',
        'x-real-ip': '1.2.3.4',
        'x-forwarded-for': '1.2.3.4',
      },
    });
    // 网关用内部令牌替换：worker 鉴权通过（若 forged 被透传，worker 会 401）
    expect(forged.status).toBe(200);
    expect(forged.headers.get('set-cookie') ?? '').not.toContain('sel_device');
    expect(forged.headers.get('set-cookie') ?? '').not.toContain(SESSION_COOKIE);
    // HTML 一律 no-store
    expect(forged.headers.get('cache-control')).toContain('no-store');
  }, 90_000);

  it('旧 /s/pair 与路径穿越（含编码）一律 404，碰不到 worker 也碰不到 /v1 /v2', async () => {
    const env = await setupHost();
    const { browser } = await loginBrowser(env);
    const token = browser.cookies.get(SESSION_COOKIE)!;
    const cookie = `${SESSION_COOKIE}=${token}`;
    const pair = await browser.get('/s/pair?code=AAAA');
    expect(pair.status).toBe(404);
    const pairPost = await browser.post('/s/pair', { code: 'AAAA', clientId: crypto.randomUUID() });
    expect(pairPost.status).toBe(404);
    for (const attack of ['/s/../v1/health', '/s/%2e%2e/v2/health', '/s/..%2fhealth', '/s/assets/../../../app.db']) {
      const result = await rawRequest(env.base, attack, cookie);
      expect(result.status).toBe(404);
      expect(result.body).not.toContain('protocolVersion');
    }
    // 未挂载的路径（/v1 本身）在这个测试 app 里不存在，确认没有被转发语义污染
    expect((await rawRequest(env.base, '/v1/health', cookie)).status).toBe(404);
  }, 90_000);

  it('worker 崩溃：只影响本学生，下次请求重拉；数据不丢；另一个学生不受任何影响', async () => {
    const env = await setupHost();
    const a = await loginBrowser(env);
    const b = await loginBrowser(env);
    await a.browser.post('/s/settings', { practiceSlot: '甲放学后', paperLocation: 'home' });
    // 杀 A 的 worker（模拟崩溃）
    const entries = (env.pool as unknown as { entries: Map<string, { child: { kill(s: string): void } }> }).entries;
    entries.get(a.studentId)!.child.kill('SIGKILL');
    await waitFor(async () => !env.pool.isRunning(a.studentId));
    // B 照常
    expect((await b.browser.get('/s/settings')).status).toBe(200);
    // A 下一次请求自动重拉，设置还在（独立目录落盘）
    const page = await a.browser.get('/s/settings');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('甲放学后');
    expect(env.pool.isRunning(a.studentId)).toBe(true);
  }, 120_000);

  it('内部令牌刷新：refresh 后旧令牌换新，已登录会话不受影响', async () => {
    const env = await setupHost();
    const a = await loginBrowser(env);
    const before = await env.pool.ensure(a.studentId);
    await env.pool.refreshToken(a.studentId);
    const after = await env.pool.ensure(a.studentId);
    expect(after.token).not.toBe(before.token);
    expect(after.port).toBe(before.port);
    expect((await a.browser.get('/s/settings')).status).toBe(200);
  }, 90_000);

  it('父进程重启：已注册学生的 worker 自动预热，旧会话仍有效、数据还在', async () => {
    const env = await setupHost();
    const a = await loginBrowser(env);
    await a.browser.post('/s/settings', { practiceSlot: '甲放学后', paperLocation: 'home' });
    const oldToken = a.browser.cookies.get(SESSION_COOKIE)!;
    expect(env.pool.isRunning(a.studentId)).toBe(true);
    // 模拟父进程整体重启：关网关（停 worker、关 registry），同一 hostDir 上重新开。
    await env.gateway.close();
    expect(env.pool.isRunning(a.studentId)).toBe(false);
    const registry2 = StudentRegistry.open(env.hostDir);
    const pool2 = newPool(registry2);
    const gateway2 = await createStudentHostGateway({ hostDir: env.hostDir, registry: registry2, pool: pool2 });
    gateways.push(gateway2);
    // 不用等学生打开：创建时预热已拉起 worker
    await waitFor(async () => pool2.isRunning(a.studentId));
    const base2 = await serve(gateway2);
    const browser = new Browser(base2);
    const page = await browser.request('/s/settings', { headers: { cookie: `${SESSION_COOKIE}=${oldToken}` } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('甲放学后');
  }, 120_000);

  it('worker 启动失败：503 页面，不路由到别人', async () => {
    const hostDir = tempRoot('sel-host-');
    const registry = StudentRegistry.open(hostDir);
    const pool = new StudentWorkerPool({ dirFor: id => registry.studentDir(id), workerScript: path.join(hostDir, 'missing-worker.js'), execArgv: [] });
    const gateway = await createStudentHostGateway({ hostDir, registry, pool });
    gateways.push(gateway);
    const app = express();
    app.use('/s', gateway.router({ limiter: new RateLimiter(), ipOf: () => '127.0.0.1' }));
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise<void>(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { studentId } = registry.createStudent();
    const { code } = registry.issueInvitation(studentId);
    const browser = new Browser(base);
    await browser.post('/s/login', { code });
    const page = await browser.get('/s/');
    expect(page.status).toBe(503);
    expect(await page.text()).toContain('暂时进不去');
    await expect(pool.ensure(studentId)).rejects.toBeInstanceOf(WorkerStartError);
  }, 60_000);
});
