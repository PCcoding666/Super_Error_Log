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
  async inventory(source: Buffer): Promise<VisionInventoryResult> {
    if (this.gate) await this.gate;
    const stats = await sharp(source).stats();
    const marked = (stats.channels[0]?.mean ?? 0) >= (stats.channels[2]?.mean ?? 0);
    return {
      candidates: [0, 1, 2].map(index => ({
        number: String(index + 1), box: { x: 0.1, y: 0.05 + index * 0.3, width: 0.8, height: 0.25 },
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

describe('PWA 外壳：manifest、图标、Service Worker、离线页（无学生数据）', () => {
  it('manifest 为 standalone、竖屏、start_url 与 scope 都是 /s/；苹果主屏幕图标 180×180', async () => {
    const env = await setup();
    const response = await fetch(`${env.base}/s/manifest.webmanifest`);
    expect(response.headers.get('content-type')).toContain('application/manifest+json');
    const manifest = await response.json() as Record<string, unknown>;
    expect(manifest).toMatchObject({ display: 'standalone', orientation: 'portrait', start_url: '/s/', scope: '/s/', theme_color: '#1F615C' });
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
    expect(today).toContain('今天大约 13 分钟，一共 5 步');
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
  it('没同意不收照片；同意后上传、登记进本周、原图去掉 EXIF', async () => {
    const env = await setup();
    const browser = await pairBrowser(env);
    expect(await browser.text('/s/capture')).toContain('上传前看一下');
    const refused = await uploadPhoto(browser, await photo('#f0d0c8'));
    expect(refused.status).toBe(403);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM v2_photo').get()).toEqual({ n: 0 });
    expect((await browser.post('/s/consent')).headers.get('location')).toBe('/s/capture');
    expect(browser.cookies.get('sel_consent')).toBe('v2');
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
    const capture = await browser.text('/s/capture');
    expect(capture).toContain('已拍 1 张');
    expect(capture).toContain('拍完了，下一步');
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
    const today = await browser.text('/s/');
    expect(today).toContain('第 1 张要你勾');
    expect(today).toContain('勾第 1 张');
    expect((await browser.text('/s/photos')).replace(/<[^>]+>/g, '')).toContain('这页没有批改痕迹，点这里勾出错题');
    const pick = await browser.text(`/s/photos/${jobId}`);
    const ids = [...pick.matchAll(/name="questionIds" value="([^"]+)"/g)].map(match => match[1]!);
    expect(ids).toHaveLength(3);
    const candidate = await browser.get(`/s/img/cand/${jobId}/${ids[0]}`);
    expect(candidate.headers.get('content-type')).toBe('image/jpeg');
    expect((await browser.post(`/s/photos/${jobId}/select`, { questionIds: [] })).status).toBe(400);
    expect((await browser.post(`/s/photos/${jobId}/select`, { questionIds: ids.slice(0, 2) })).headers.get('location')).toBe('/s/photos');
    await waitFor(async () => (await env.service.getJob(jobId)).status === 'completed' && (await env.service.getJob(jobId)).questions.filter(q => q.status === 'ready').length === 2);
    expect(await browser.text('/s/photos')).toContain('还有 1 道没勾');
    expect(await browser.text('/s/items')).toContain('2 道');
    await browser.post(`/s/photos/${jobId}/none`);
    expect(browser.cookies.get('sel_photos')).toContain(`p-${jobId}`);
    expect(await browser.text('/s/photos')).not.toContain('还有 1 道没勾');
  });
});

describe('一周的闭环：选题 → 说说为什么错（学生自己提交）→ 打印 → 录结果', () => {
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
    expect(await browser.text('/s/')).toContain('说说为什么错');
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

  it('跳过直接打印 → 准备好后出现 A4 练习纸；今天变成「这周的事做完了」；当天录的做对不算真会', async () => {
    const env = await setup();
    const { browser, packetId, itemIds } = await chosen(env);
    const skip = await browser.post('/s/skip', { step: 'why', practice: packetId });
    expect(skip.headers.get('location')).toBe(`/s/print/${packetId}`);
    await waitFor(async () => (await browser.text(`/s/print/${packetId}`)).includes('data-testid="sheet"'));
    const print = await browser.text(`/s/print/${packetId}`);
    expect(print).toContain('做完再看');
    expect(print).toContain('做题日期：________');
    expect(print).toContain('打印好了，回到今天');
    const sheet = await browser.get(`/s/print/${packetId}/sheet`);
    expect(sheet.status).toBe(200);
    const css = await (await browser.get('/s/assets/app.css')).text();
    expect(css).toContain('@page{size:A4');
    const today = await browser.text('/s/?printed=1');
    expect(today).toContain('这周的事做完了');
    expect(today).toContain('下次打开：下个周末，录结果');
    expect(today).toContain('没打出来？现在打印');
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
    const results = await browser.text(`/s/results/${packetId}`);
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
    expect(await browser.text('/s/?printed=1')).toContain('这周的事做完了');
    // 做完以后又拍了一张（周中入口「又发了卷子？现在拍」也走到这里）。
    const again = await (await uploadPhoto(browser, await photo('#f0d0c8'))).json() as { jobId: string };
    await waitFor(async () => (await env.service.getJob(again.jobId)).status === 'completed');
    const photos = await browser.text('/s/photos');
    expect(photos).toContain('data-testid="photos-after-week"');
    expect(photos).toContain('新拍的题下个周末再选');
    // 哪张是新拍的：练习纸生成以后才拍的第 2 张标「新拍的」，第 1 张（已经进了这周的练习）不标。
    expect(photos).toContain('data-testid="photo-new-2"');
    expect(photos).not.toContain('data-testid="photo-new-1"');
    const photosText = photos.replace(/<[^>]+>/g, '');
    expect(photosText).toContain('下面标着「新拍的」那 1 张不会加进去');
    expect(photosText).toContain('下个周末选题时，它们会出现在里面');
    expect(photos).toMatch(/<a class="btn primary" href="\/s\/" data-testid="next-step-primary"[^>]*>回到今天<\/a>/);
    expect(photos).not.toContain('下一步：选这周要练的题');
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
    expect(await text('/s/practices')).toContain('每个周末一份练习纸');
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
    expect(unpaired).toContain('还没连上服务器');
    expect(unpaired).not.toContain('照片和错题都在');
    expect(unpaired).not.toContain('data-testid="settings-link"');

    const browser = await pairBrowser(env);
    let paired = '';
    for (let attempt = 0; attempt < 10 && !paired; attempt += 1) {
      const response = await browser.get('/s/');
      if (response.status === 429) paired = await response.text();
    }
    expect(paired).toContain('已经传上去的照片和错题都在服务器上');
  });
});
