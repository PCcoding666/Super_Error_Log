/**
 * 学生网页版（/s/）路由集成测试：真实 HTTP（云端装配：设备令牌 + PairingManager），合成识别、mock 语音转写，
 * /v2 的追问 / 打印辅导走 mock 模式的确定性实现。不调真实模型、不读 .env 与 data/，所有照片与录音都是合成的。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Evidence } from '../../src/ai/evidence.js';
import { MOCK_TRANSCRIPT, MockTranscriber } from '../../src/ai/asr.js';
import { getDb } from '../../src/db/connection.js';
import { ensureStudentProfile } from '../../src/services/studentService.js';
import { createMobileApp } from '../../src/mobile/router.js';
import { PairingManager, decodeWebPairingCode, webPairingLink } from '../../src/mobile/pairing.js';
import { RateLimiter } from '../../src/mobile/rateLimit.js';
import { AdmissionController } from '../../src/mobile/admission.js';
import { cropPhoto } from '../../src/media/images.js';
import type { MobileRecognitionService } from '../../src/mobile/service.js';
import type { InventoryCandidate, MobileVisionBoundary, VisionInventoryResult, VisionQuestionResult } from '../../src/mobile/vision.js';
import { createV2Router } from '../../src/v2/router.js';
import { createWebClientRouter, dayOptions } from '../../src/web/router.js';
import { readTrail } from '../../src/web/trail.js';
import { syntheticMp4 } from '../helpers/syntheticAudio.js';

const roots: string[] = [];
const servers: Server[] = [];
const services: MobileRecognitionService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.stop()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});

beforeAll(() => { ensureStudentProfile(); });
beforeEach(() => {
  const db = getDb();
  for (const table of ['v2_print_snapshot', 'correction', 'correction_proposal', 'v2_reflection_turn', 'mastery_event', 'review_attempt', 'review_packet_item', 'review_packet', 'mobile_item_link', 'evidence_record', 'error_diagnosis', 'error_item', 'asset_origin', 'source_asset', 'source_batch', 'v2_photo', 'v2_setting']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
});

/** 合成识别：偏红 = 有批改痕迹（自动精读），偏蓝 = 没批改（等学生勾）。 */
class SyntheticVision implements MobileVisionBoundary {
  readonly configured = true;
  gate: Promise<void> | null = null;
  questionCount = 3;
  async inventory(source: Buffer): Promise<VisionInventoryResult> {
    if (this.gate) await this.gate;
    const stats = await sharp(source).stats();
    const marked = (stats.channels[0]?.mean ?? 0) >= (stats.channels[2]?.mean ?? 0);
    return {
      candidates: Array.from({ length: this.questionCount }, (_, index) => ({
        number: String(index + 1), box: { x: 0.1, y: 0.05 + index * 0.9 / this.questionCount, width: 0.8, height: 0.75 / this.questionCount },
        selectionEvidence: marked ? 'marked_wrong' as const : 'unmarked' as const, partial: false,
      })),
      warnings: [],
    };
  }
  async recognizeQuestion(source: Buffer, candidate: InventoryCandidate): Promise<VisionQuestionResult> {
    const n = Number(candidate.number);
    const evidence: Evidence = {
      version: 1, questionNumber: candidate.number, questionText: `解方程：${n}x + 1 = ${n + 1}，求 x。`, subject: '数学', chapter: '',
      knowledgeTags: [['一元一次方程', '二次函数', '相似三角形'][n - 1] ?? '方程'], questionType: '计算', questionRegion: candidate.box, requiresDiagram: false,
      regions: [{ id: 's1', kind: 'student_work', box: candidate.box, confidence: 0.9, cleanForPrint: false }],
      observations: [{ id: 'o1', kind: 'student_work', text: 'x = 2', regionId: 's1', confidence: 0.9 }], uncertainties: [],
    };
    return { evidence, verification: { textComplete: true, questionCropComplete: true, questionCropPure: true, transcriptionMatches: true, diagramSafe: true, issues: [] }, questionCrop: await cropPhoto(source, candidate.box), diagramCrops: [] };
  }
}

async function photo(color: string, size = 600): Promise<Buffer> {
  return sharp({ create: { width: size, height: Math.round(size * 1.3), channels: 3, background: color } }).jpeg().toBuffer();
}

interface Setup { base: string; manager: PairingManager; dataDir: string; vision: SyntheticVision; service: MobileRecognitionService }

async function setup(options: { limiter?: RateLimiter; admission?: AdmissionController } = {}): Promise<Setup> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-web-'));
  roots.push(dataDir);
  const manager = await PairingManager.open(dataDir, { pairingUrl: 'https://study.pccoding666.com' });
  const vision = new SyntheticVision();
  const transcriber = new MockTranscriber();
  const app = await createMobileApp({
    dataDir, vision, mode: 'cloud', pairing: manager, cloudProxy: true, rateLimiter: options.limiter, admission: options.admission ?? new AdmissionController({ diskProbe: async () => 100n * 1024n ** 3n, dataUsageProbe: async () => 0n }),
    v2Router: ({ limiter }) => createV2Router({ mobileDataDir: dataDir, transcriber, limiter }),
    webClient: deps => createWebClientRouter({ ...deps, mobileDataDir: dataDir, transcriber }),
  });
  const service = app.locals.mobileRecognitionService as MobileRecognitionService;
  services.push(service);
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, manager, dataDir, vision, service };
}

/** 带 cookie 的浏览器替身：不跟随重定向，自己记 cookie。 */
class Browser {
  cookies = new Map<string, string>();
  lastSetCookie: string[] = [];
  constructor(readonly base: string, readonly userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1') {}
  async request(pathname: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('user-agent', this.userAgent);
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
  post(pathname: string, fields: Record<string, string | string[]> = {}, headers: Record<string, string> = {}): Promise<Response> {
    const body = new URLSearchParams();
    for (const [name, value] of Object.entries(fields)) for (const v of Array.isArray(value) ? value : [value]) body.append(name, v);
    return this.request(pathname, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } });
  }
  async text(pathname: string): Promise<string> { return (await this.get(pathname)).text(); }
  /** 页面上看得见的字（去掉标签）：标题、按钮按词组分成了小段（<span class="ph">），文字断言看这个。 */
  async visibleText(pathname: string): Promise<string> { return (await this.text(pathname)).replace(/<[^>]+>/g, ''); }
}

async function pairBrowser(env: Setup): Promise<Browser> {
  const browser = new Browser(env.base);
  const link = webPairingLink(env.manager.createSession().payload, env.base);
  const page = await (await browser.get(link.slice(env.base.length))).text();
  const code = /name="code" value="([^"]+)"/.exec(page)![1]!;
  const clientId = /name="clientId" value="([^"]+)"/.exec(page)![1]!;
  const response = await browser.post('/s/pair', { code, clientId });
  expect(response.status).toBe(303);
  return browser;
}

async function uploadPhoto(browser: Browser, bytes: Buffer, type = 'image/jpeg'): Promise<Response> {
  const form = new FormData();
  form.append('key', crypto.randomUUID());
  form.append('photo', new Blob([new Uint8Array(bytes)], { type }), 'photo.jpg');
  return browser.request('/s/capture', { method: 'POST', body: form, headers: { accept: 'application/json' } });
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('等待超时');
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full); else out.push(`${path.relative(dir, full)}:${fs.statSync(full).size}`);
    }
  };
  walk(dir);
  return out.sort();
}

describe('三栏入口', () => {
  it('默认打开错题本，三个入口独立可达', async () => {
    const env = await setup();
    const browser = await pairBrowser(env);
    const home = await browser.text('/s/');
    expect(home).toContain('<h1>错题本</h1>');
    expect(home).toContain('错题录入');
    expect(home).toContain('href="/s/practices"');
    expect(home).not.toContain('纸上练习');
    await browser.post('/s/consent');
    const capture = await browser.text('/s/capture');
    expect(capture).toContain('<h1>错题录入</h1>');
    expect(capture).toContain('查看上传记录');
    expect(await browser.text('/s/practices')).toContain('新建练习');
  });
});

describe('PWA 外壳：manifest、图标、Service Worker、离线页（无学生数据）', () => {
  it('manifest 为 standalone、竖屏、start_url 与 scope 都是 /s/；苹果主屏幕图标 180×180', async () => {
    const env = await setup();
    const response = await fetch(`${env.base}/s/manifest.webmanifest`);
    expect(response.headers.get('content-type')).toContain('application/manifest+json');
    const manifest = await response.json() as Record<string, unknown>;
    expect(manifest).toMatchObject({ display: 'standalone', orientation: 'portrait', start_url: '/s/', scope: '/s/', theme_color: '#F2F2F7' });
    expect((manifest.icons as Array<{ sizes: string }>).map(icon => icon.sizes)).toEqual(['192x192', '512x512', '512x512']);
    const icon = Buffer.from(await (await fetch(`${env.base}/s/assets/apple-touch-icon.png`)).arrayBuffer());
    expect(await sharp(icon).metadata()).toMatchObject({ format: 'png', width: 180, height: 180 });
    const sw = await fetch(`${env.base}/s/sw.js`);
    expect(sw.headers.get('content-type')).toContain('javascript');
    const swText = await sw.text();
    expect(swText).toContain("caches.match('/s/offline')");
    expect(swText).not.toMatch(/\/s\/img|\/v2\//);
    const offline = await (await fetch(`${env.base}/s/offline`)).text();
    expect(offline).toContain('连不上服务器');
  });

  it('每页都带主屏幕所需的 head：manifest、apple-touch-icon、apple-mobile-web-app-capable、theme-color；安全响应头', async () => {
    const env = await setup();
    const response = await fetch(`${env.base}/s/`);
    const html = await response.text();
    for (const needle of ['<link rel="manifest" href="/s/manifest.webmanifest"/>', 'rel="apple-touch-icon"', 'name="apple-mobile-web-app-capable" content="yes"', 'name="theme-color"', 'viewport-fit=cover']) {
      expect(html).toContain(needle);
    }
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(html).not.toMatch(/<script>|<script [^>]*>[^<]/);
  });
});

describe('连接：链接配对 → httpOnly cookie；没有 cookie 只看到连接页', () => {
  it('没有 cookie：/s/ 是连接页（找大人要二维码或链接）；POST 被送回 /s/；图片 401', async () => {
    const env = await setup();
    const browser = new Browser(env.base);
    const page = await browser.text('/s/');
    expect(page).toContain('先连上服务器');
    expect(page).toContain('这一步要大人帮一下');
    expect((await browser.post('/s/consent')).headers.get('location')).toBe('/s/');
    expect((await browser.get('/s/img/item/itm_0123456789abcdef')).status).toBe(401);
    expect((await browser.request('/s/voice', { method: 'POST', body: new Uint8Array(syntheticMp4(2)), headers: { 'content-type': 'audio/mp4' } })).status).toBe(401);
  });

  it('打开链接只显示确认页（不兑换、不设 cookie）；点连接才兑换，cookie 是 httpOnly、Path=/s、SameSite=Lax', async () => {
    const env = await setup();
    const browser = new Browser(env.base);
    const link = webPairingLink(env.manager.createSession().payload, env.base);
    const confirm = await browser.get(link.slice(env.base.length));
    expect(confirm.status).toBe(200);
    expect(browser.lastSetCookie).toEqual([]);
    const html = await confirm.text();
    expect(html).toContain('连接这台手机');
    const code = /name="code" value="([^"]+)"/.exec(html)![1]!;
    const clientId = /name="clientId" value="([^"]+)"/.exec(html)![1]!;
    const redeemed = await browser.post('/s/pair', { code, clientId });
    expect(redeemed.status).toBe(303);
    expect(redeemed.headers.get('location')).toBe('/s/?paired=1');
    const cookie = browser.lastSetCookie.find(line => line.startsWith('sel_device='))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Path=\/s(;|$)/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).not.toMatch(/Secure/);
    const devices = await env.manager.listDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]!.deviceInfo).toBe('网页版 · iPhone Safari');
    // 同一次点击重放（同一 clientId）幂等；别的浏览器再用同一个码被拒。
    expect((await browser.post('/s/pair', { code, clientId })).status).toBe(303);
    const other = new Browser(env.base);
    const reused = await other.post('/s/pair', { code, clientId: crypto.randomUUID() });
    expect(reused.status).toBe(409);  // pairing_used，与 /v1/pairing/redeem 同一状态码
    expect(await reused.text()).toContain('这个二维码用不了');
    expect(other.cookies.has('sel_device')).toBe(false);
    const today = await browser.text('/s/?paired=1');
    expect(today).toContain('连上了 ✓');
    expect(today).toContain('<h1>错题本</h1>');
  });

  it('非本机主机名一律 Secure（生产只走 HTTPS）', async () => {
    const env = await setup();
    const { payload } = env.manager.createSession();
    const code = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const body = new URLSearchParams({ code, clientId: crypto.randomUUID() }).toString();
    const port = new URL(env.base).port;
    const setCookie = await new Promise<string[]>((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port, path: '/s/pair', method: 'POST', headers: { host: 'study.example.test', origin: 'https://study.example.test', 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } }, response => {
        response.resume(); resolve(response.headers['set-cookie'] ?? []);
      });
      request.on('error', reject); request.end(body);
    });
    expect(setCookie.find(line => line.startsWith('sel_device='))).toMatch(/; Secure/);
  });

  it('粘贴整条链接也能连；坏链接与跨站提交被拒', async () => {
    const env = await setup();
    const browser = new Browser(env.base);
    const bad = await browser.post('/s/pair', { link: 'https://study.pccoding666.com/s/pair?code=@@@' });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('这个二维码用不了');
    const forged = await browser.post('/s/pair', { link: webPairingLink(env.manager.createSession().payload) }, { origin: 'https://evil.example' });
    expect(forged.status).toBe(403);
    const pasted = await browser.post('/s/pair', { link: webPairingLink(env.manager.createSession().payload) });
    expect(pasted.status).toBe(303);
    expect(browser.cookies.has('sel_device')).toBe(true);
  });

  it('在微信里打开：提示换到 Safari，主按钮不可点（一次性码不被浪费）', async () => {
    const env = await setup();
    const browser = new Browser(env.base, 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0.50');
    const html = await browser.text(webPairingLink(env.manager.createSession().payload, env.base).slice(env.base.length));
    expect(html).toContain('在 Safari 中打开');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="next-step-primary"|<button[^>]*data-testid="next-step-primary"[^>]*disabled/);
  });

  it('设备被撤销：显示「需要重新扫码」并清掉 cookie', async () => {
    const env = await setup();
    const browser = await pairBrowser(env);
    const [device] = await env.manager.listDevices();
    await env.manager.revoke(device!.deviceId);
    const response = await browser.get('/s/');
    expect(response.status).toBe(401);
    expect(await response.text()).toContain('需要重新扫码');
    expect(browser.cookies.has('sel_device')).toBe(false);
  });

  it('网页配对链接与解码：载荷原样往返，接受整条链接', () => {
    const payload = { v: 1 as const, serviceId: crypto.randomUUID(), httpsUrl: 'https://8.163.96.197' as const, sessionId: crypto.randomUUID(), secret: crypto.randomBytes(32).toString('base64url') };
    const link = webPairingLink(payload);
    expect(link.startsWith('https://study.pccoding666.com/s/pair?code=')).toBe(true);
    expect(decodeWebPairingCode(link)).toEqual(payload);
    expect(decodeWebPairingCode(link.split('code=')[1]!)).toEqual(payload);
    expect(decodeWebPairingCode('not base64 !')).toBeNull();
  });
});

describe('拍照上传：先同意，再上传；去掉拍摄信息；与 /v1 共用准入', () => {
  it('今天页等待找题时自动刷新并提供查看进度；完成后停止刷新', async () => {
    const env = await setup();
    const browser = await pairBrowser(env);
    await browser.post('/s/consent');
    let release!: () => void;
    env.vision.gate = new Promise<void>(resolve => { release = resolve; });
    try {
      const response = await uploadPhoto(browser, await photo('#f0d0c8'));
      const { jobId } = await response.json() as { jobId: string };
      const waiting = await browser.text('/s/capture');
      expect(waiting).toContain('data-poll="4"');
      expect(waiting).toContain('照片已收到，正在找题。');
      expect(waiting).not.toContain('大约 1–2 分钟');
      release();
      await waitFor(async () => (await env.service.getJob(jobId)).status === 'completed');
      const done = await browser.text('/s/capture');
      expect(done).not.toContain('data-poll=');
      expect(done).not.toContain('照片已收到，正在找题。');
      expect(done).toContain('查看错题');
    } finally { release(); }
  });

  it('没同意不收照片；同意后上传、登记进本周、原图去掉 EXIF', async () => {
    const env = await setup();
    const browser = await pairBrowser(env);
    expect(await browser.text('/s/capture')).toContain('上传前看一下');
    const refused = await uploadPhoto(browser, await photo('#f0d0c8'));
    expect(refused.status).toBe(403);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM v2_photo').get()).toEqual({ n: 0 });
    expect((await browser.post('/s/consent')).headers.get('location')).toBe('/s/capture');
    expect(browser.cookies.get('sel_consent')).toBe('v1');
    const tagged = await sharp({ create: { width: 500, height: 650, channels: 3, background: '#f0d0c8' } }).withExif({ IFD0: { Artist: 'SYNTHETIC-EXIF-MARKER' } }).jpeg().toBuffer();
    expect((await sharp(tagged).metadata()).exif).toBeDefined();
    const response = await uploadPhoto(browser, tagged);
    expect(response.status).toBe(200);
    const { jobId } = await response.json() as { jobId: string };
    expect(getDb().prepare('SELECT job_id FROM v2_photo').all()).toEqual([{ job_id: jobId }]);
    const job = await env.service.getJob(jobId);
    const stored = await env.service.getMedia(jobId, job.sourceMediaId);
    expect((await sharp(stored).metadata()).exif).toBeUndefined();
    expect(stored.includes(Buffer.from('SYNTHETIC-EXIF-MARKER'))).toBe(false);
    const capture = await browser.visibleText('/s/capture');
    expect(capture).toContain('已拍 1 张');
    expect(capture).toContain('查看错题');
  });

  it('PNG 转成 JPEG；读不出来的文件给出换一张的提示', async () => {
    const env = await setup();
    const browser = await pairBrowser(env);
    await browser.post('/s/consent');
    const png = await sharp({ create: { width: 400, height: 520, channels: 3, background: '#c8d0f0' } }).png().toBuffer();
    expect((await uploadPhoto(browser, png, 'image/png')).status).toBe(200);
    const broken = await uploadPhoto(browser, Buffer.from('definitely not an image'));
    expect(broken.status).toBe(400);
    expect((await broken.json() as { error: { message: string } }).error.message).toContain('这张照片读不出来');
    const form = await browser.request('/s/capture', { method: 'POST', body: (() => { const f = new FormData(); f.append('photo', new Blob([new Uint8Array(Buffer.from('x'))]), 'a.jpg'); return f; })() });
    expect(form.status).toBe(303);
    expect(form.headers.get('location')).toBe('/s/capture?err=unreadable');
  });

  it('HEIC 说清楚是格式问题（不说 iCloud）；48MP 说清楚是像素太高', async () => {
    // 2026-10-15 线上修复：这两类在服务器读不了时不能一律「读不出来」，要给出能操作的提示
    const env = await setup();
    const browser = await pairBrowser(env);
    await browser.post('/s/consent');
    // 合成 HEIC：只有 ftyp 盒子（无隐私、无真实照片），sharp 必然解码失败，服务器按格式识别
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(12)]);
    const heicResponse = await uploadPhoto(browser, heic, 'image/heic');
    expect(heicResponse.status).toBe(400);
    const heicError = (await heicResponse.json() as { error: { code: string; message: string } }).error;
    expect(heicError.code).toBe('heic');
    expect(heicError.message).toContain('HEIC');
    expect(heicError.message).toContain('Safari');
    expect(heicError.message).not.toContain('iCloud');
    const heicForm = await browser.request('/s/capture', { method: 'POST', body: (() => { const f = new FormData(); f.append('photo', new Blob([new Uint8Array(heic)], { type: 'image/heic' }), 'a.heic'); return f; })() });
    expect(heicForm.headers.get('location')).toBe('/s/capture?err=heic');
    expect(await browser.text('/s/capture?err=heic')).toContain('HEIC');

    const big = await sharp({ create: { width: 8064, height: 6048, channels: 3, background: '#f0d0c8' } }).jpeg({ quality: 60 }).toBuffer();
    const bigResponse = await uploadPhoto(browser, big);
    expect(bigResponse.status).toBe(400);
    const bigError = (await bigResponse.json() as { error: { code: string; message: string } }).error;
    expect(bigError.code).toBe('pixels');
    expect(bigError.message).toContain('像素');
    expect(bigError.message).not.toContain('iCloud');
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM v2_photo').get()).toEqual({ n: 0 });
  });

  it('磁盘不足时与 /v1 一样拒收（准入规则只有一份）', async () => {
    const env = await setup({ admission: new AdmissionController({ diskProbe: async () => 1n, dataUsageProbe: async () => 0n }) });
    const browser = await pairBrowser(env);
    await browser.post('/s/consent');
    const response = await uploadPhoto(browser, await photo('#f0d0c8'));
    expect(response.status).toBe(503);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM v2_photo').get()).toEqual({ n: 0 });
  });
});

describe('勾出做错的题：没批改的页由学生勾，勾了才精读', () => {
  it('没批改痕迹的页：今天说「勾第 1 张」，勾 2 道后进错题本；「这页没有做错的题」只记在 cookie', async () => {
    const env = await setup();
    const browser = await pairBrowser(env);
    await browser.post('/s/consent');
    const { jobId } = await (await uploadPhoto(browser, await photo('#c8d0f0'))).json() as { jobId: string };
    await waitFor(async () => (await env.service.getJob(jobId)).status === 'completed');
    const today = await browser.visibleText('/s/photos');
    expect(today).toContain('勾第 1 张');
    expect(today).toContain('勾第 1 张');
    expect((await browser.text('/s/photos')).replace(/<[^>]+>/g, '')).toContain('这页没有批改痕迹，点这里勾出错题');
    const pick = await browser.text(`/s/photos/${jobId}`);
    const ids = [...pick.matchAll(/name="questionIds" value="([^"]+)"/g)].map(match => match[1]!);
    expect(ids).toHaveLength(3);
    const candidate = await browser.get(`/s/img/cand/${jobId}/${ids[0]}`);
    expect(candidate.headers.get('content-type')).toBe('image/jpeg');
    expect((await browser.post(`/s/photos/${jobId}/select`, { questionIds: [] })).status).toBe(400);
    // 加完回到勾出做错的题：带两个小数字（加了几道、第几张），页面上说一声「第 1 张：2 道加进错题本了」。
    expect((await browser.post(`/s/photos/${jobId}/select`, { questionIds: ids.slice(0, 2) })).headers.get('location')).toBe('/s/photos?added=2&n=1');
    await waitFor(async () => (await env.service.getJob(jobId)).status === 'completed' && (await env.service.getJob(jobId)).questions.filter(q => q.status === 'ready').length === 2);
    const added = (await browser.text('/s/photos?added=99&n=1')).replace(/<[^>]+>/g, '');
    expect(added).toContain('第 1 张：2 道加进错题本了 ✓');
    expect(await browser.text('/s/photos?added=x&n=1')).not.toContain('data-testid="photos-added"');
    await waitFor(async () => (await env.service.getJob(jobId)).status === 'completed' && (await env.service.getJob(jobId)).questions.filter(q => q.status === 'ready').length === 2);
    expect(await browser.visibleText('/s/photos')).toContain('还有 1 道没勾');
    expect(await browser.text('/s/items')).toContain('2 道');
    await browser.post(`/s/photos/${jobId}/none`);
    expect(browser.cookies.get('sel_photos')).toContain(`p-${jobId}`);
    expect(await browser.visibleText('/s/photos')).not.toContain('还有 1 道没勾');
  });
});

describe('错题页学科切换', () => {
  it('筛选当前题目、数量和历史题目，记住选择并保留旧学科与未分类入口', async () => {
    const env = await setup();
    const browser = await pairBrowser(env);
    await browser.post('/s/consent', { agree: 'yes' });
    const upload = await uploadPhoto(browser, await photo('#d34040'));
    expect(upload.status).toBe(200);
    const { jobId } = await upload.json() as { jobId: string };
    await waitFor(async () => (await env.service.getJob(jobId)).status === 'completed');
    await browser.get('/s/items'); // Bridge synthetic recognition into learning records.
    const db = getDb();
    const ids = (db.prepare('SELECT item_id FROM mobile_item_link ORDER BY item_id').all() as { item_id: string }[]).map(row => row.item_id);
    expect(ids).toHaveLength(3);
    db.prepare('UPDATE error_item SET subject=? WHERE id=?').run('物理', ids[1]!);
    db.prepare('UPDATE error_item SET subject=NULL WHERE id=?').run(ids[2]!);
    db.prepare("UPDATE evidence_record SET confidence_badge='low' WHERE item_id=?").run(ids[0]!);
    const physics = await browser.text('/s/items?subject=' + encodeURIComponent('物理'));
    expect(physics).toContain(`/s/items/${ids[1]}`);
    expect(physics).not.toContain(`/s/items/${ids[0]}`);
    expect(physics).not.toContain(`/s/items/${ids[2]}`);
    expect(physics).toContain('1 道');
    expect(physics).not.toContain('AI 可能认错了字');
    expect(physics).toContain('切换学科');
    expect(physics).not.toMatch(/<h[12][^>]*>物理<\/h[12]>/);
    expect(await browser.text('/s/items')).toContain(`/s/items/${ids[1]}`);
    const empty = await browser.text('/s/items?subject=' + encodeURIComponent('化学'));
    expect(empty).not.toContain('data-testid="item-card"');
    expect(empty).toContain('这个年级还没有化学错题');
    const unknown = await browser.text('/s/items?subject=' + encodeURIComponent('未分类'));
    expect(unknown).toContain(`/s/items/${ids[2]}`);
    expect(unknown).not.toContain(`/s/items/${ids[0]}`);
    db.prepare('UPDATE error_item SET subject=? WHERE id=?').run('英语', ids[2]!);
    expect(await browser.text('/s/items?subject=' + encodeURIComponent('英语'))).toContain(`/s/items/${ids[2]}`);
    const invalid = await browser.text('/s/items?subject=not-a-subject');
    expect(invalid).not.toContain('not-a-subject');
    await browser.get('/s/items?subject=' + encodeURIComponent('物理'));
    db.prepare('UPDATE v2_photo SET registered_at=?').run('2020-01-01T00:00:00Z');
    const backlog = await browser.text('/s/items');
    expect(backlog).toContain('（1 道）');
    expect(backlog).toContain(`/s/items/${ids[1]}`);
    expect(backlog).not.toContain(`/s/items/${ids[0]}`);
    expect(backlog).not.toContain(`/s/items/${ids[2]}`);
  });
});

describe('一周的闭环：选题 → 说说为什么错（学生自己提交）→ 打印 → 录结果', () => {
  for (const marked of [true, false]) it(`5 道练习生成后补充 2 道（${marked ? '自动识别' : '学生勾选'}），快照、题号、进度及已有做题记录不变`, async () => {
    const env = await setup();
    const browser = await pairBrowser(env);
    await browser.post('/s/consent');
    env.vision.questionCount = 5;
    const first = await (await uploadPhoto(browser, await photo('#f0d0c8'))).json() as { jobId: string };
    await waitFor(async () => (await env.service.getJob(first.jobId)).status === 'completed');
    const choose = await browser.text('/s/choose');
    const ids = [...choose.matchAll(/name="itemIds"(?: checked="")? value="(itm_[0-9a-f]+)"/g)].map(m => m[1]!);
    expect(ids).toHaveLength(5);
    const packetId = (await browser.post('/s/choose', { itemIds: ids })).headers.get('location')!.split('/').pop()!;
    await browser.post('/s/skip', { step: 'why', practice: packetId });
    await waitFor(async () => (await browser.text(`/s/print/${packetId}`)).includes('data-testid="sheet"'));
    const db = getDb();
    const frozen = () => ({
      packet: db.prepare('SELECT * FROM review_packet WHERE id = ?').get(packetId),
      items: db.prepare('SELECT * FROM review_packet_item WHERE packet_id = ? ORDER BY position').all(packetId),
      numbers: db.prepare('SELECT ei.id, ei.short_id, ei.status FROM error_item ei JOIN review_packet_item rpi ON rpi.item_id = ei.id WHERE rpi.packet_id = ? ORDER BY rpi.position').all(packetId),
      print: db.prepare('SELECT * FROM v2_print_snapshot WHERE packet_id = ?').get(packetId),
      attempts: db.prepare('SELECT * FROM review_attempt').all(),
    });
    const before = frozen();
    const sheet = await browser.text(`/s/print/${packetId}/sheet`);
    const home = await browser.text('/s/');
    expect(home).toContain('data-testid="tab-capture"');
    expect(home).toContain('<h1>错题本</h1>');
    let release!: () => void;
    env.vision.gate = new Promise<void>(resolve => { release = resolve; });
    env.vision.questionCount = 2;
    const added = await (await uploadPhoto(browser, await photo(marked ? '#f1c9bc' : '#c8d0f0'))).json() as { jobId: string };
    try {
      for (const pathname of ['/s/capture', '/s/photos']) {
        const html = await browser.text(pathname);
        expect(html).toContain('照片已收到，正在找题。');
        expect(html).not.toContain('已新增 2 道错题');
      }
      expect(frozen()).toEqual(before);
    } finally { release(); env.vision.gate = null; }
    await waitFor(async () => (await env.service.getJob(added.jobId)).status === 'completed');
    if (!marked) {
      expect(await browser.text('/s/photos')).not.toContain('已新增 2 道错题');
      const questions = (await env.service.getJob(added.jobId)).questions.map(q => q.id);
      expect((await browser.post(`/s/photos/${added.jobId}/select`, { questionIds: questions })).status).toBe(303);
      await waitFor(async () => { const job = await env.service.getJob(added.jobId); return job.status === 'completed' && job.questions.every(q => q.status === 'ready'); });
    }
    const photos = await browser.text('/s/photos');
    expect(photos).toContain('已新增 2 道错题');
    expect(photos).toContain('已保存到错题本，这次补充不会改变之前的练习纸。');
    expect(photos.replace(/<[^>]+>/g, '')).toContain('查看错题');
    expect(photos).toContain('继续录入');
    const newItems = db.prepare('SELECT item_id FROM mobile_item_link WHERE job_id = ?').all(added.jobId) as { item_id: string }[];
    expect(newItems).toHaveLength(2);
    const itemsPage = await browser.text('/s/items');
    for (const item of newItems) {
      expect(itemsPage).toContain(`/s/items/${item.item_id}`);
      expect((await browser.get(`/s/items/${item.item_id}`)).status).toBe(200);
    }
    expect(frozen()).toEqual(before);
    expect(await browser.text(`/s/print/${packetId}/sheet`)).toBe(sheet);
    // 真正走五道录结果表单，补充的两道不能混入原练习。
    const dateHtml = await browser.text(`/s/record/${packetId}`);
    const date = /name="date" value="(\d{4}-\d{2}-\d{2})"/.exec(dateHtml)![1]!;
    let html = await (await browser.post(`/s/record/${packetId}`, { date, at: '0', go: 'next' })).text();
    for (let i = 0; i < 5; i++) {
      expect(html).toContain(`第 ${i + 1} 道，共 5 道`);
      const fields = Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"\/>/g)].map(m => [m[1]!, m[2]!]));
      const result = await browser.post(`/s/record/${packetId}`, { ...fields, completion: 'independent', correct: 'yes', go: i === 4 ? 'submit' : 'next' });
      if (i === 4) expect(result.headers.get('location')).toBe(`/s/results/${packetId}`);
      else html = await result.text();
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM review_attempt WHERE packet_id = ?').get(packetId)).toEqual({ n: 5 });
    const recorded = frozen();
    // 再补一张，已有做题记录和打印快照也保持原样。
    const last = await (await uploadPhoto(browser, await photo('#c1caf2'))).json() as { jobId: string };
    await waitFor(async () => (await env.service.getJob(last.jobId)).status === 'completed');
    await browser.text('/s/photos');
    expect(frozen()).toEqual(recorded);
  });

  async function chosen(env: Setup): Promise<{ browser: Browser; packetId: string; itemIds: string[] }> {
    const browser = await pairBrowser(env);
    await browser.post('/s/consent');
    const { jobId } = await (await uploadPhoto(browser, await photo('#f0d0c8'))).json() as { jobId: string };
    await waitFor(async () => (await env.service.getJob(jobId)).status === 'completed');
    const choose = await browser.text('/s/choose');
    expect(choose).toContain('就练这 3 道');
    const itemIds = [...choose.matchAll(/name="itemIds"(?: checked="")? value="(itm_[0-9a-f]+)"/g)].map(match => match[1]!);
    expect((await browser.post('/s/choose', { itemIds: [] })).status).toBe(400);
    const created = await browser.post('/s/choose', { itemIds, practiceSlot: '__other', practiceSlotOther: '周四午休' });
    expect(created.status).toBe(303);
    const packetId = created.headers.get('location')!.split('/').pop()!;
    expect(getDb().prepare('SELECT practice_slot FROM review_packet WHERE id = ?').get(packetId)).toEqual({ practice_slot: '周四午休' });
    return { browser, packetId, itemIds };
  }

  it('AI 只问、只建议；没选把握不能提交；提交后才有复盘记录；跳过一道后去打印', async () => {
    const env = await setup();
    const { browser, packetId, itemIds } = await chosen(env);
    expect(await browser.text(`/s/why/${packetId}`)).toContain('说说为什么错');
    const start = await browser.post(`/s/why/${packetId}/start`);
    expect(start.headers.get('location')).toBe(`/s/why/${packetId}/${itemIds[0]}`);
    const ask = await browser.text(start.headers.get('location')!);
    expect(ask).toContain('AI 问你');
    expect(ask).toContain('data-endpoint="/s/voice"');
    const answered = await browser.post(`/s/why/${packetId}/${itemIds[0]}/answer`, { answer: '我以为移项不用变号' });
    expect(answered.status).toBe(303);
    const confirm = await browser.text(`/s/why/${packetId}/${itemIds[0]}/confirm`);
    expect(confirm).toContain('AI 猜的');
    expect(confirm).toContain('这个要你自己选，AI 不帮你猜');
    expect(confirm).not.toMatch(/name="masteryFeeling" value="\d" checked/);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM error_diagnosis').get()).toEqual({ n: 0 });
    const missing = await browser.post(`/s/why/${packetId}/${itemIds[0]}/submit`, { attemptState: '方法基本正确但步骤出错', cause: '计算', summary: '' });
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain('还差：有没有把握');
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM error_diagnosis').get()).toEqual({ n: 0 });
    const submitted = await browser.post(`/s/why/${packetId}/${itemIds[0]}/submit`, { attemptState: '方法基本正确但步骤出错', cause: '计算', masteryFeeling: '2', summary: '移项忘了变号' });
    expect(submitted.headers.get('location')).toBe(`/s/why/${packetId}/${itemIds[1]}`);
    expect(getDb().prepare('SELECT submitted_by, confirmed_summary, mastery_feeling FROM error_diagnosis').all()).toEqual([{ submitted_by: 'student', confirmed_summary: '移项忘了变号', mastery_feeling: 2 }]);
    await browser.post(`/s/why/${packetId}/${itemIds[1]}/pass`);
    const last = await browser.post(`/s/why/${packetId}/${itemIds[2]}/pass`);
    expect(last.headers.get('location')).toBe(`/s/why/${packetId}`);
    expect(await browser.text(`/s/why/${packetId}`)).toContain('3 道里说了 1 道');
  });

  it('跳过直接打印 → 准备好后出现 A4 练习纸；今天变成「这一份练习纸已准备好」；当天录的做对不算真会', async () => {
    const env = await setup();
    const { browser, packetId, itemIds } = await chosen(env);
    const skip = await browser.post('/s/skip', { step: 'why', practice: packetId });
    expect(skip.headers.get('location')).toBe(`/s/print/${packetId}`);
    await waitFor(async () => (await browser.text(`/s/print/${packetId}`)).includes('data-testid="sheet"'));
    const print = await browser.text(`/s/print/${packetId}`);
    expect(print).toContain('做完再看');
    expect(print).toContain('做题日期：________');
    expect(print).not.toContain('什么时候做：');
    expect(await browser.text(`/s/print/${packetId}?answers=1`)).toContain('对照原卷查看解析');
    expect(print).toContain('打印好了，回到今天');
    const sheet = await browser.get(`/s/print/${packetId}/sheet`);
    expect(sheet.status).toBe(200);
    const css = await (await browser.get('/s/assets/app.css')).text();
    expect(css).toContain('@page{size:A4');
    const today = await browser.visibleText('/s/');
    expect(today).toContain('错题本');
    // 录结果：日期不预选；一题一屏；最后一次提交。
    const dateScreen = await browser.text(`/s/record/${packetId}`);
    expect(dateScreen).toContain('练习纸是哪天做的？');
    expect(dateScreen).not.toMatch(/name="date" value="[^"]+" checked/);
    expect((await browser.post(`/s/record/${packetId}`, { at: '0', go: 'next' })).status).toBe(400);
    const date = /name="date" value="(\d{4}-\d{2}-\d{2})"/.exec(dateScreen)![1]!;
    let state: Record<string, string> = { date, at: '0', go: 'next' };
    let html = await (await browser.post(`/s/record/${packetId}`, state)).text();
    for (let index = 0; index < itemIds.length; index += 1) {
      expect(html).toContain(`第 ${index + 1} 道，共 ${itemIds.length} 道`);
      const hidden = Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"\/>/g)].map(match => [match[1]!, match[2]!]));
      state = { ...hidden, completion: 'independent', correct: 'yes', go: index === itemIds.length - 1 ? 'submit' : 'next' };
      if (index === 0) {
        const missingCorrect = await browser.post(`/s/record/${packetId}`, { ...hidden, completion: 'independent', go: 'next' });
        expect(await missingCorrect.text()).toContain('选一下做对了没有');
      }
      const response = await browser.post(`/s/record/${packetId}`, state);
      if (index === itemIds.length - 1) { expect(decodeURIComponent(response.headers.get("location") ?? "")).toBe(`/s/results/${packetId}`); break; }
      html = await response.text();
    }
    const results = await browser.visibleText(`/s/results/${packetId}`);
    expect(results).toContain('3 道里，独立做对 3 道');
    expect(results).toContain('做对了，过几天再确认');
    expect(results).not.toContain('真会了 ✓');
  });
});

describe('语音转写：同源 /s/voice 与 /v2/reflections/transcribe，录音不落盘', () => {
  it('/s/voice 返回 mock 转写；只收音频；按设备限流；数据目录里不多任何文件', async () => {
    const env = await setup({ limiter: new RateLimiter({ transcribePerDevice: 2 }) });
    const browser = await pairBrowser(env);
    const before = [...listFiles(env.dataDir), ...listFiles(process.env.SEL_DATA_DIR!)].filter(entry => !entry.startsWith('app.db'));
    const clip = syntheticMp4(5);
    const ok = await browser.request('/s/voice', { method: 'POST', body: new Uint8Array(clip), headers: { 'content-type': 'audio/mp4' } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ text: MOCK_TRANSCRIPT });
    const wrong = await browser.request('/s/voice', { method: 'POST', body: new Uint8Array(Buffer.from('png')), headers: { 'content-type': 'image/png' } });
    expect(wrong.status).toBe(415);
    const limited = await browser.request('/s/voice', { method: 'POST', body: new Uint8Array(clip), headers: { 'content-type': 'audio/webm;codecs=opus' } });
    expect(limited.status).toBe(429);
    const after = [...listFiles(env.dataDir), ...listFiles(process.env.SEL_DATA_DIR!)].filter(entry => !entry.startsWith('app.db'));
    expect(after).toEqual(before);
    const forged = await browser.request('/s/voice', { method: 'POST', body: new Uint8Array(clip), headers: { 'content-type': 'audio/mp4', origin: 'https://evil.example' } });
    expect(forged.status).toBe(403);
  });

  it('/v2/reflections/transcribe：设备令牌鉴权，超过 5 MB 413，超过 60 秒 400', async () => {
    const env = await setup();
    const { token } = await env.manager.redeem(env.manager.createSession().payload, crypto.randomUUID(), 'iPhone');
    const call = (body: Buffer, auth = true) => fetch(`${env.base}/v2/reflections/transcribe`, {
      method: 'POST', body: new Uint8Array(body), headers: { 'content-type': 'audio/mp4', ...(auth ? { authorization: `Bearer ${token}` } : {}) },
    });
    expect((await call(syntheticMp4(3), false)).status).toBe(401);
    const ok = await call(syntheticMp4(3));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ text: MOCK_TRANSCRIPT });
    const big = await call(Buffer.alloc(5 * 1024 * 1024 + 10, 1));
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: { code: 'payload_too_large', message: '录音超过 5 MB 限制。' } });
    expect((await call(syntheticMp4(90))).status).toBe(400);
  });
});

describe('录结果的日期选项', () => {
  it('从练习纸生成那天到今天、最多 7 天，今天写「今天」，不早于生成日', () => {
    const now = new Date('2026-10-10T02:00:00Z'); // 上海周六 10:00
    expect(dayOptions(new Date('2026-10-09T13:00:00Z'), now, 'Asia/Shanghai').map(day => day.label)).toEqual(['周五 10/9', '今天']);
    const week = dayOptions(new Date('2026-09-20T00:00:00Z'), now, 'Asia/Shanghai');
    expect(week).toHaveLength(7);
    expect(week[0]).toEqual({ value: '2026-10-04', label: '周日 10/4' });
    expect(week[6]).toEqual({ value: '2026-10-10', label: '今天' });
  });
});

describe('互动记录：每个动作只记时间、路由模板、动作标识、设备 ID（docs/web-interaction-trail.md）', () => {
  it('看页、点按（随请求带来 / 不跳页时的 HEAD）、提交、跳过、出错都写进审计日志，不带任何内容', async () => {
    const env = await setup();
    const stranger = new Browser(env.base);
    await stranger.get('/s/');
    const browser = await pairBrowser(env);
    const [device] = await env.manager.listDevices();
    const deviceId = device!.deviceId;
    await browser.get('/s/?paired=1');
    // 页面脚本把点了哪个按钮放进 sel_tap，随下一个请求带来；带来后清掉。同一条点按再来一次不重复记。
    browser.cookies.set('sel_tap', encodeURIComponent('a1b2c3.primary.capture@/s/'));
    await browser.get('/s/capture');
    expect(browser.cookies.has('sel_tap')).toBe(false);
    browser.cookies.set('sel_tap', encodeURIComponent('a1b2c3.primary.capture@/s/'));
    await browser.get('/s/capture');
    // 不跳页的点按（拍照、打印、录音）：脚本立刻发 HEAD 把它带来，服务器记完回 204。
    browser.cookies.set('sel_tap', encodeURIComponent('d4e5f6.primary.capture@/s/capture|e7.error.mic_denied@/s/why/pkt_0123456789abcdef/itm_0123456789abcdef'));
    const beacon = await browser.request('/s/capture', { method: 'HEAD' });
    expect(beacon.status).toBe(204);
    await browser.post('/s/consent');
    await browser.post('/s/skip', { step: 'shoot' });
    expect((await uploadPhoto(browser, Buffer.from('definitely not an image'))).status).toBe(400);
    expect((await browser.get('/s/items/itm_0123456789abcdef')).status).toBe(404);
    expect((await browser.get('/s/some-page-that-does-not-exist')).status).toBe(404);
    // 脚本的自动刷新（等 AI 的页面）记成 refresh，不和他自己打开的页面混在一起。
    browser.cookies.set('sel_tap', encodeURIComponent('r1.auto.refresh@/s/photos'));
    await browser.get('/s/photos');

    const rows = readTrail(deviceId);
    const lines = rows.map(row => `${row.kind} ${row.route}#${row.action}`);
    expect(lines).toEqual(expect.arrayContaining([
      'submit /s/pair#submit',
      'view /s/#open',
      'tap /s/#primary.capture',
      'view /s/capture#open',
      'tap /s/capture#primary.capture',
      'error /s/why/:pid/:itemId#client:mic_denied',
      'submit /s/consent#submit',
      'skip /s/skip#shoot',
      'error /s/capture#400:unreadable',
      'error /s/items/:id#404',
      'error /s/*#404',
      'view /s/photos#refresh',
    ]));
    expect(lines.filter(line => line === 'tap /s/#primary.capture')).toHaveLength(1);
    expect(readTrail(null).map(row => `${row.kind} ${row.route}#${row.action}`)).toContain('view /s/#connect');
    // 每一行都有时间戳和这台设备的 ID；路由与动作里没有任何 ID、配对码、查询参数或内容。
    for (const row of rows) {
      expect(row.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(row.deviceId).toBe(deviceId);
      expect(`${row.route}#${row.action}`).not.toMatch(/pkt_|itm_[0-9a-f]|[0-9a-f]{8}-[0-9a-f]{4}|code=|\?|not an image|[\u4e00-\u9fff]/);
    }
    expect(new Set(rows.map(row => row.kind))).toEqual(new Set(['view', 'tap', 'submit', 'skip', 'error']));
  });

  it('这周的练习纸生成以后又拍了卷子：「勾出做错的题」说明新题去哪，主按钮回到今天（门槛 G3）', async () => {
    const env = await setup();
    const browser = await pairBrowser(env);
    await browser.post('/s/consent');
    const first = await (await uploadPhoto(browser, await photo('#f0d0c8'))).json() as { jobId: string };
    await waitFor(async () => (await env.service.getJob(first.jobId)).status === 'completed');
    const choose = await browser.text('/s/choose');
    const itemIds = [...choose.matchAll(/name="itemIds"(?: checked="")? value="(itm_[0-9a-f]+)"/g)].map(match => match[1]!);
    const packetId = (await browser.post('/s/choose', { itemIds })).headers.get('location')!.split('/').pop()!;
    await browser.post('/s/skip', { step: 'why', practice: packetId });
    await waitFor(async () => (await browser.text(`/s/print/${packetId}`)).includes('data-testid="sheet"'));
    expect(await browser.visibleText('/s/?printed=1')).toContain('错题本');
    // 做完以后又拍了一张（周中入口「又发了卷子？现在拍」也走到这里）。
    const again = await (await uploadPhoto(browser, await photo('#f0d0c8'))).json() as { jobId: string };
    await waitFor(async () => (await env.service.getJob(again.jobId)).status === 'completed');
    const photos = await browser.text('/s/photos');
    expect(photos).toContain('data-testid="photos-after-week"');
    expect(photos.replace(/<[^>]+>/g, '')).toContain('补充错题');
    // 哪张是新拍的：练习纸生成以后才拍的第 2 张标「新拍的」，第 1 张（已经进了这周的练习）不标。
    expect(photos).toContain('data-testid="photo-new-2"');
    expect(photos).not.toContain('data-testid="photo-new-1"');
    const photosText = photos.replace(/<[^>]+>/g, '');
    expect(photosText).toContain('这次补充不会改变之前的练习纸');
    expect(photosText).toContain('查看错题');
    expect(photos).toContain('href="/s/items"');
    expect(photosText).not.toContain('下一步：选这周要练的题');
  });
});

describe('稀疏的屏用现有数据填满；服务器忙页不替没连上的人说「都在」（quality round 1 iteration 2）', () => {
  it('说说为什么错开头、说完了、打印首屏、以前的练习都列出这份练习里的题', async () => {
    const env = await setup();
    const browser = await pairBrowser(env);
    await browser.post('/s/consent');
    const job = await (await uploadPhoto(browser, await photo('#f0d0c8'))).json() as { jobId: string };
    await waitFor(async () => (await env.service.getJob(job.jobId)).status === 'completed');
    const choose = await browser.text('/s/choose');
    const itemIds = [...choose.matchAll(/name="itemIds"(?: checked="")? value="(itm_[0-9a-f]+)"/g)].map(match => match[1]!);
    const packetId = (await browser.post('/s/choose', { itemIds })).headers.get('location')!.split('/').pop()!;
    const text = async (path: string): Promise<string> => (await browser.text(path)).replace(/<[^>]+>/g, '');

    // 开头一屏：这次的几道，每道一行，第一道写「从这道开始」。
    const intro = await browser.text(`/s/why/${packetId}`);
    expect(intro).toContain('data-testid="why-items"');
    expect((intro.match(/class="row qrow"/g) ?? []).length).toBe(itemIds.length);
    expect(await text(`/s/why/${packetId}`)).toContain(`这次的 ${itemIds.length} 道`);
    expect(await text(`/s/why/${packetId}`)).toContain('从这道开始');

    // 每道都「这道跳过」以后：说完了一屏列出每道「这次没说」。
    for (const itemId of itemIds) await browser.post(`/s/why/${packetId}/${itemId}/pass`);
    const done = await browser.text(`/s/why/${packetId}`);
    expect(done).toContain('data-testid="why-done-items"');
    expect(done.replace(/<[^>]+>/g, '')).toContain(`${itemIds.length} 道里说了 0 道`);
    expect(done.match(/<span class="meta-line">这次没说<\/span>/g) ?? []).toHaveLength(itemIds.length);

    // 打印首屏：手机字号的题目清单在 A4 预览前面；预览本身照旧。
    await browser.post(`/s/print/${packetId}`);
    await waitFor(async () => (await browser.text(`/s/print/${packetId}`)).includes('data-testid="sheet"'));
    const print = await browser.text(`/s/print/${packetId}`);
    expect(print.indexOf('data-testid="print-summary"')).toBeGreaterThan(-1);
    expect(print.indexOf('data-testid="print-summary"')).toBeLessThan(print.indexOf('data-testid="print-preview"'));
    expect(await text(`/s/print/${packetId}`)).toContain(`这张练习纸上有 ${itemIds.length} 道题`);

    // 以前的练习：最近一份单独一张卡，下面列出它的每道题。
    const practicesHtml = await browser.text('/s/practices');
    expect(practicesHtml).toContain('data-testid="practice-latest-items"');
    expect((practicesHtml.match(/class="row qrow"/g) ?? []).length).toBe(itemIds.length);
    expect(await text('/s/practices')).toContain('选择一份练习继续');
  });

  it('服务器忙：连着的手机说「照片和错题都在」，还没连上的不说', async () => {
    const env = await setup({ limiter: new RateLimiter({ pairingFailPerIp: 1, authedQueryPerDevice: 4 }) });
    const stranger = new Browser(env.base);
    let unpaired = '';
    for (let attempt = 0; attempt < 4 && !unpaired; attempt += 1) {
      const response = await stranger.post('/s/pair', { link: 'https://example.invalid/s/pair?code=nope' });
      if (response.status === 429) unpaired = await response.text();
    }
    expect(unpaired).toContain('服务器有点忙');
    const unpairedText = unpaired.replace(/<[^>]+>/g, '');
    expect(unpairedText).toContain('还没连上服务器。等一会儿再试；还是不行，请大人给一个新的二维码或链接。');
    // 会走到这一页的，是连接失败太多次：手里的链接多半已经用过或过期，不再叫他「再用同一个」。
    expect(unpairedText).not.toContain('同一个');
    expect(unpaired).not.toContain('照片和错题都在');
    expect(unpaired).not.toContain('data-testid="settings-link"');

    // 连接失效（cookie 无效）的人：以前连上过，不说「还没连上」。
    const expiredBrowser = new Browser(env.base);
    expiredBrowser.cookies.set('sel_device', 'not-a-valid-token');
    let expired = '';
    for (let attempt = 0; attempt < 40 && !expired; attempt += 1) {
      const response = await expiredBrowser.get('/s/');
      if (response.status === 429) expired = await response.text(); else expiredBrowser.cookies.set('sel_device', 'not-a-valid-token');
    }
    const expiredText = expired.replace(/<[^>]+>/g, '');
    expect(expiredText).toContain('服务器有点忙');
    expect(expiredText).toContain('连接过期了，要请大人给一个新的二维码或链接。');
    expect(expiredText).toContain('照片和错题都还在服务器上');
    expect(expiredText).not.toContain('还没连上');

    const browser = await pairBrowser(env);
    let paired = '';
    for (let attempt = 0; attempt < 10 && !paired; attempt += 1) {
      const response = await browser.get('/s/');
      if (response.status === 429) paired = await response.text();
    }
    expect(paired).toContain('已经传上去的照片和错题都在服务器上');
  });

  it('已经连着的手机又点了一个坏链接、连接失败太多次：服务器忙页按「连着」说（照片和错题都在）', async () => {
    const env = await setup({ limiter: new RateLimiter({ pairingFailPerIp: 1 }) });
    const browser = await pairBrowser(env);
    let busy = '';
    for (let attempt = 0; attempt < 4 && !busy; attempt += 1) {
      const response = await browser.post('/s/pair', { link: 'https://example.invalid/s/pair?code=nope' });
      if (response.status === 429) busy = await response.text();
    }
    expect(busy).toContain('已经传上去的照片和错题都在服务器上');
    expect(busy).not.toContain('还没连上');
  });
});

describe('等 AI 的页面：局部轮询代替整页刷新（quality round 2）', () => {
  it('找题中：页面带 data-poll 与可换的区域、等了多久；关掉脚本时退回 meta refresh；轮询请求不记「打开了一页」，状态变了只记一次 update', async () => {
    const env = await setup();
    let release!: () => void;
    env.vision.gate = new Promise<void>(resolve => { release = resolve; });
    const browser = await pairBrowser(env);
    const [device] = await env.manager.listDevices();
    await browser.post('/s/consent');
    const { jobId } = await (await uploadPhoto(browser, await photo('#f0d0c8'))).json() as { jobId: string };

    const waiting = await browser.text('/s/photos');
    expect(waiting).toMatch(/<body[^>]* data-poll="3"/);
    expect(waiting).toContain('<noscript><meta http-equiv="refresh" content="3"/></noscript>');
    for (const region of ['photos', 'more', 'bar']) expect(waiting).toContain(`data-live="${region}"`);
    expect(waiting).toMatch(/data-testid="wait-line"[^>]*><span class="ph" data-elapsed="\d+">已经等了 \d+ 秒<\/span>/);
    expect(waiting.replace(/<[^>]+>/g, '')).toContain('找好了这一页会自己更新，可以先离开');
    expect(waiting).toContain('data-announcer=""');
    const capture = await browser.text('/s/capture');
    expect(capture).toMatch(/<body[^>]* data-poll="4"/);
    expect(capture).toContain('data-live="capture-status"');
    expect(await browser.text('/s/capture')).toMatch(/<body[^>]* data-poll="4"/);

    // 脚本的轮询：同一页带 x-sel-poll: 1，取三次也不记「打开了一页」。
    for (let i = 0; i < 3; i += 1) expect((await browser.request('/s/photos', { headers: { 'x-sel-poll': '1' } })).status).toBe(200);
    // 状态变了：脚本换掉区域后报一次 update（随 HEAD 带来）。
    release();
    await waitFor(async () => (await env.service.getJob(jobId)).status === 'completed');
    const done = await browser.text('/s/photos');
    expect(done).not.toContain('data-poll=');
    expect(done).not.toContain('http-equiv="refresh"');
    expect(done).not.toContain('data-testid="wait-line"');
    browser.cookies.set('sel_tap', encodeURIComponent('u1.auto.update@/s/photos'));
    expect((await browser.request('/s/photos', { method: 'HEAD' })).status).toBe(204);

    const lines = readTrail(device!.deviceId).map(row => `${row.kind} ${row.route}#${row.action}`);
    expect(lines.filter(line => line === 'view /s/photos#open')).toHaveLength(2);
    expect(lines.filter(line => line === 'view /s/photos#update')).toHaveLength(1);
    expect(lines.filter(line => line.includes('#refresh'))).toHaveLength(0);
  });

  it('练习纸准备中：进度、已经等了多久（从开始准备算，只读现有的一列）、按进度推算还要多久；准备好了就不再轮询', async () => {
    const env = await setup();
    const browser = await pairBrowser(env);
    await browser.post('/s/consent');
    const job = await (await uploadPhoto(browser, await photo('#f0d0c8'))).json() as { jobId: string };
    await waitFor(async () => (await env.service.getJob(job.jobId)).status === 'completed');
    const choose = await browser.text('/s/choose');
    const itemIds = [...choose.matchAll(/name="itemIds"(?: checked="")? value="(itm_[0-9a-f]+)"/g)].map(match => match[1]!);
    const packetId = (await browser.post('/s/choose', { itemIds })).headers.get('location')!.split('/').pop()!;
    await browser.post('/s/skip', { step: 'why', practice: packetId });
    await waitFor(async () => (await browser.text(`/s/print/${packetId}`)).includes('data-testid="sheet"'));
    const ready = await browser.text(`/s/print/${packetId}`);
    expect(ready).not.toContain('data-poll=');
    expect(ready).toContain('data-live="print" data-announce="练习纸准备好了"');

    // 把这一行改回「准备中」（等于正在准备：第 1 道做完，开始于 40 秒前）。
    const started = new Date(Date.now() - 40_000).toISOString();
    getDb().prepare("UPDATE v2_print_snapshot SET status = 'preparing', progress_done = 1, progress_total = 3, created_at = ? WHERE packet_id = ?").run(started, packetId);
    getDb().prepare('UPDATE review_packet SET generated_at = NULL WHERE id = ?').run(packetId);
    const preparing = await browser.text(`/s/print/${packetId}`);
    expect(preparing).toMatch(/<body[^>]* data-poll="2"/);
    expect(preparing).toContain('<noscript><meta http-equiv="refresh" content="2"/></noscript>');
    expect(preparing.replace(/<[^>]+>/g, '')).toContain('正在准备练习纸… 第 1/3 道');
    const elapsed = Number(/data-elapsed="(\d+)"/.exec(preparing)![1]);
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(60);
    // 40 秒做了 1 道，还剩 2 道 → 大约 80 秒 → 「还要大约 2 分钟」。
    expect(preparing.replace(/<[^>]+>/g, '')).toContain('照现在的速度，还要大约 2 分钟');
    expect(preparing).toContain('style="transform:scaleX(0.33)"');
    const online = await browser.text(`/s/print/${packetId}`);
    expect(online).toMatch(/<body[^>]* data-poll="2"/);
    expect(online.replace(/<[^>]+>/g, '')).toContain('照现在的速度，还要大约 2 分钟');
  });
});

describe('打印页与练习纸单独页的首屏（quality round 2；纸面本身不变）', () => {
  it('先是第 1 道题原样原大小，再是题目清单，整张 A4 是可展开的缩略图；单独页打印之前主按钮是「打印」；哪里都不替他说「已打印」', async () => {
    const env = await setup();
    const browser = await pairBrowser(env);
    await browser.post('/s/consent');
    const job = await (await uploadPhoto(browser, await photo('#f0d0c8'))).json() as { jobId: string };
    await waitFor(async () => (await env.service.getJob(job.jobId)).status === 'completed');
    const choose = await browser.text('/s/choose');
    const itemIds = [...choose.matchAll(/name="itemIds"(?: checked="")? value="(itm_[0-9a-f]+)"/g)].map(match => match[1]!);
    const packetId = (await browser.post('/s/choose', { itemIds })).headers.get('location')!.split('/').pop()!;
    await browser.post('/s/skip', { step: 'why', practice: packetId });
    await waitFor(async () => (await browser.text(`/s/print/${packetId}`)).includes('data-testid="sheet"'));

    for (const path of [`/s/print/${packetId}`, `/s/print/${packetId}/sheet`]) {
      const html = await browser.text(path);
      const at = (needle: string): number => html.indexOf(needle);
      expect(at('data-testid="print-peek"')).toBeGreaterThan(-1);
      expect(at('data-testid="print-peek"')).toBeLessThan(at('data-testid="print-summary"'));
      expect(at('data-testid="print-summary"')).toBeLessThan(at('data-testid="sheet-box"'));
      // 第 1 道：和纸上那一道是同一段 HTML（同一个组件），放在 .sheet 里，用纸上的字号。
      const peek = html.slice(at('class="peek-page"'), at('data-testid="print-summary"'));
      const firstItem = /<div class="item">[\s\S]*?<\/p><\/div>/.exec(peek)![0];
      const sheet = html.slice(at('data-testid="sheet"'));
      expect(sheet.indexOf(firstItem)).toBeGreaterThan(-1);
      // 整张 A4：缩略图（data-open="false"），按钮「展开看整张」只在有脚本时出现；打印时只印纸。
      expect(html).toContain('class="print-root sheet-box" data-open="false"');
      const toggle = /<button type="button" class="link-btn sheet-toggle js-only" aria-expanded="false" aria-controls="sheet-frame"[^>]*>([\s\S]*?)<\/button>/.exec(html);
      expect(toggle).not.toBeNull();
      // 按钮里两种说法都在，按 aria-expanded 只显示一种（展开前「展开看整张」，展开后「收起整张」）。
      expect(toggle![1]!).toMatch(/<span class="when-closed">[\s\S]*<\/span><span class="when-open">收起整张<\/span>/);
      expect(toggle![1]!.replace(/<span class="when-open">[^<]*<\/span>/, '').replace(/<[^>]+>/g, '')).toBe('展开看整张');
      expect(html).not.toContain('已打印');
    }
    const sheetPage = await browser.text(`/s/print/${packetId}/sheet`);
    // 开着脚本：主按钮是「打印」（脚本把它标成主按钮）；「打印好了，回到今天」在打印回来以后才出现。
    expect(sheetPage).toMatch(/<a class="btn primary" href="#" data-print="" data-js-primary="" data-testid="sheet-print" data-key="print">打印<\/a>/);
    expect(sheetPage).toMatch(/<div class="bar-after hidden" data-after-print="">[\s\S]*?打印好了，回到今天[\s\S]*?<\/div><\/div>/);
    // 关掉脚本：说明用 Safari 的「分享」→「打印」，主按钮在 <noscript> 里（开着脚本时它不存在）。
    expect(sheetPage).toMatch(/<noscript>[\s\S]*「分享」[\s\S]*data-testid="next-step-primary"[^>]*>打印好了，回到今天<\/a>[\s\S]*<\/noscript>/);
    expect((sheetPage.match(/data-testid="next-step-primary"/g) ?? []).length).toBe(1);
    const css = await (await browser.get('/s/assets/app.css')).text();
    expect(css).toContain('.print-root>:not(.sheet-frame){display:none!important}');
  });
});

describe('性能卫生（quality round 2，代码这一侧）：带指纹的静态资源长缓存、脚本 defer、裁图按显示尺寸下发', () => {
  it('页面引用带内容指纹的样式与脚本（脚本 defer）；指纹对得上缓存一年，对不上不缓存；Service Worker 的外壳清单用同样的名字', async () => {
    const env = await setup();
    const html = await (await fetch(`${env.base}/s/`)).text();
    const css = /<link rel="stylesheet" href="(\/s\/assets\/app\.([0-9a-f]{10})\.css)"\/>/.exec(html);
    const js = /<script src="(\/s\/assets\/app\.([0-9a-f]{10})\.js)" defer=""><\/script>/.exec(html);
    expect(css).not.toBeNull();
    expect(js).not.toBeNull();
    const cssResponse = await fetch(`${env.base}${css![1]}`);
    expect(cssResponse.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(cssResponse.headers.get('pragma')).toBeNull();
    expect(cssResponse.headers.get('content-type')).toContain('text/css');
    const cssText = await cssResponse.text();
    expect(crypto.createHash('sha256').update(cssText).digest('hex').slice(0, 10)).toBe(css![2]);
    const jsResponse = await fetch(`${env.base}${js![1]}`);
    expect(jsResponse.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const jsText = await jsResponse.text();
    expect(crypto.createHash('sha256').update(jsText).digest('hex').slice(0, 10)).toBe(js![2]);
    // 下发的版本去掉了注释，仍然是能解析的脚本、能用的样式。
    expect(jsText).toContain('正在准备照片');
    expect(() => new Function(jsText)).not.toThrow();
    expect(cssText).toContain('@media (prefers-reduced-motion:reduce){');
    // 旧页面拿着别的指纹：照样给现在的内容，但不缓存；不带指纹的旧地址也一样。
    expect((await fetch(`${env.base}/s/assets/app.0000000000.css`)).headers.get('cache-control')).toBe('no-cache');
    expect((await fetch(`${env.base}/s/assets/app.css`)).headers.get('cache-control')).toBe('no-cache');
    expect((await fetch(`${env.base}/s/sw.js`)).headers.get('cache-control')).toBe('no-cache');
    expect((await fetch(`${env.base}/s/assets/icon-192.png`)).headers.get('cache-control')).toBe('public, max-age=604800');
    const sw = await (await fetch(`${env.base}/s/sw.js`)).text();
    expect(sw).toContain(`'${css![1]}'`);
    expect(sw).toContain(`'${js![1]}'`);
    // 页面本身仍然不缓存（学生数据）。
    expect((await fetch(`${env.base}/s/`)).headers.get('cache-control')).toBe('private, no-store');
  });

  it('题目裁图：thumb / list / big 按显示尺寸的 2 倍以内缩小，从不放大；不带尺寸的是原图；图片仍然不缓存', async () => {
    const env = await setup();
    const browser = await pairBrowser(env);
    await browser.post('/s/consent');
    const job = await (await uploadPhoto(browser, await photo('#f0d0c8', 2400))).json() as { jobId: string };
    await waitFor(async () => (await env.service.getJob(job.jobId)).status === 'completed');
    const items = await browser.text('/s/items');
    const itemId = /\/s\/img\/item\/(itm_[0-9a-f]+)\?s=list/.exec(items)![1]!;
    const size = async (path: string): Promise<{ width: number; height: number; bytes: number; cache: string | null }> => {
      const response = await browser.get(path);
      const buffer = Buffer.from(await response.arrayBuffer());
      const meta = await sharp(buffer).metadata();
      return { width: meta.width!, height: meta.height!, bytes: buffer.length, cache: response.headers.get('cache-control') };
    };
    const original = await size(`/s/img/item/${itemId}`);
    const thumb = await size(`/s/img/item/${itemId}?s=thumb`);
    const list = await size(`/s/img/item/${itemId}?s=list`);
    const big = await size(`/s/img/item/${itemId}?s=big`);
    expect(original.width).toBeGreaterThan(1088);
    expect(Math.max(thumb.width, thumb.height)).toBeLessThanOrEqual(168);
    expect(list.height).toBeLessThanOrEqual(192);
    expect(list.width).toBeLessThanOrEqual(1088);
    expect(big.width).toBeLessThanOrEqual(1088);
    expect(thumb.bytes).toBeLessThan(original.bytes);
    expect(big.bytes).toBeLessThan(original.bytes);
    expect(thumb.cache).toBe('private, no-store');
    // 原图再取一次还是原样（磁盘上的原图不动）。
    expect(await size(`/s/img/item/${itemId}`)).toEqual(original);
    // 已经比目标小的图原样返回（不放大）。
    const tiny = await photo('#f0d0c8', 120);
    const { displayImage } = await import('../../src/web/images.js');
    expect(await displayImage(tiny, 'big')).toBe(tiny);
  });
});

describe('年级、学科、章节分类', () => {
  async function categoryFixture() {
    const env = await setup();
    const browser = await pairBrowser(env);
    await browser.post('/s/consent');
    expect((await uploadPhoto(browser, await photo('#fa8080'))).status).toBe(200);
    await waitFor(async () => { await browser.get('/s/items'); return (getDb().prepare('SELECT COUNT(*) AS n FROM error_item').get() as {n:number}).n === 3; });
    const rows = getDb().prepare('SELECT id FROM error_item ORDER BY item_index').all() as {id:string}[];
    return { browser, rows };
  }

  it('edits only one item and keeps knowledge points as detail rather than a fourth classification', async () => {
    const { browser, rows } = await categoryFixture();
    const id = rows[0]!.id;
    const before = getDb().prepare('SELECT * FROM error_item WHERE id=?').get(id);
    const response = await browser.post(`/s/items/${id}/category`, { grade: '初二', subject: '物理', chapter: '力与运动' });
    expect(response.status).toBe(303);
    expect(await browser.visibleText(`/s/items/${id}`)).toContain('初二 · 物理 · 力与运动');
    expect(getDb().prepare('SELECT * FROM error_item WHERE id=?').get(id)).toEqual(before);
    expect(await browser.visibleText(`/s/items/${rows[1]!.id}`)).toContain('初三 · 数学 · 二次函数');
    expect((await browser.post(`/s/items/${id}/category`, { grade: '大学', subject: '物理', chapter: '力' })).status).toBe(400);
    expect(await browser.visibleText(`/s/items/${id}`)).toContain('初二 · 物理 · 力与运动');
  });

  it('selects the union of whole chapters including older items and hands the exact set to practice selection', async () => {
    const { browser, rows } = await categoryFixture();
    for (const [index, row] of rows.entries()) {
      expect((await browser.post(`/s/items/${row.id}/category`, { grade: '初三', subject: '数学', chapter: index < 2 ? '一元二次方程' : '二次函数' })).status).toBe(303);
    }
    getDb().prepare("UPDATE v2_photo SET registered_at='2025-01-01T00:00:00Z'").run();
    const response = await browser.post('/s/items/select', { grade: '初三', subject: '数学', chapters: ['一元二次方程', '二次函数'] });
    expect(response.status).toBe(200);
    const html = await response.text();
    const selected = [...html.matchAll(/<input[^>]*name="itemIds"[^>]*>/g)].filter(match => /checked/.test(match[0])).map(match => /value="([^"]+)"/.exec(match[0])![1]);
    expect(selected.sort()).toEqual(rows.map(row => row.id).sort());
    const empty = await browser.post('/s/items/select', { grade: '初二', subject: '数学', chapters: ['一元二次方程'] });
    expect(empty.status).toBe(400);
  });

  it('settings saves the student grade for future questions without moving existing classifications', async () => {
    const { browser, rows } = await categoryFixture();
    expect((await browser.post('/s/settings/grade', { grade: '初一' })).status).toBe(303);
    try {
      expect(await browser.text('/s/settings')).toContain('value="初一" selected');
      expect(await browser.visibleText(`/s/items/${rows[0]!.id}`)).toContain('初三 · 数学');
    } finally { getDb().prepare("UPDATE student_profile SET grade='初三'").run(); }
  });
});
