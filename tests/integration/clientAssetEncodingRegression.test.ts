/**
 * #127 回归补充（独立补测，不是实现方写的）。clientAssetEncoding.test.ts 把 sendClientAsset 挂在一个空 express 上测，
 * 这里补它没有覆盖的：
 * - 真实路由：生产装配（createMobileApp 的默认响应头 + 邀请码网关）和学生 worker 路由，都不带任何会话；
 * - HEAD 和条件请求（ETag / If-None-Match）；
 * - 构建产物自洽：每个压缩件都能解回原文件，没有多出来的，也没有漏掉的；
 * - precompress 插件自己的门槛（1024 字节、文件类型、watch 模式）；
 * - Accept-Encoding 的解析边界，以及路径安全没有因为多了 .br / .gz 而松动；
 * - 构建产物里没有的情况（png / woff2、压缩件不齐）用临时目录里的合成文件补。
 * 前四组用真实构建产物 dist/client（先 npm run build）。请求用 node:http 原始发：fetch 会自动解压，看不到线上的字节。
 * 只用合成数据。
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMobileApp, type WebClientDeps } from '../../src/mobile/router.js';
import { PairingManager } from '../../src/mobile/pairing.js';
import type { MobileRecognitionService } from '../../src/mobile/service.js';
import type { MobileVisionBoundary } from '../../src/mobile/vision.js';
import { StudentRegistry } from '../../src/studentHost/registry.js';
import { createStudentHostGateway, type StudentHostGateway } from '../../src/studentHost/router.js';
import { StudentWorkerPool } from '../../src/studentHost/workers.js';
import { acceptedEncodings, clientAppDir } from '../../src/web/clientApp.js';
import { createWebClientRouter } from '../../src/web/router.js';

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: Buffer }

const IMMUTABLE = 'public, max-age=31536000, immutable';
const isVariant = (name: string): boolean => /\.(?:br|gz)$/.test(name);
const isText = (name: string): boolean => /\.(?:js|css|svg|json)$/.test(name);
/** 收集用例时就要知道构建产物里有没有非文本资源（决定那条用例跑还是跳过）；没构建时是空的，beforeAll 会报清楚。 */
const BUILT_ASSETS = ((): string[] => { const dir = clientAppDir(); return dir ? fs.readdirSync(path.join(dir, 'assets')) : []; })();
const BUILT_BINARIES = BUILT_ASSETS.filter(name => !isVariant(name) && !isText(name));

const roots: string[] = [];
const servers: http.Server[] = [];
const services: MobileRecognitionService[] = [];
let gateway: StudentHostGateway;
let clientDir = '';
let assets = '';
let script = '';
let style = '';
/** 生产装配：createMobileApp（默认 no-store + pragma）里把 /s 交给邀请码网关。 */
let gatewayPort = 0;
/** 学生 worker 自己的 /s 路由（createWebClientRouter）。 */
let workerPort = 0;

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

async function listen(app: express.Express): Promise<number> {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise(resolve => server.once('listening', resolve));
  return (server.address() as AddressInfo).port;
}

/** 这组测试不识别照片；真被调到就是装配出了问题。 */
const NO_VISION: MobileVisionBoundary = {
  configured: true,
  inventory: async () => { throw new Error('这组测试不该识别照片'); },
  recognizeQuestion: async () => { throw new Error('这组测试不该识别照片'); },
};

/** 和 cloudAssembly.ts 一样用 createMobileApp 装配云端应用，/s 由调用方给。 */
async function mobileApp(webClient: (dataDir: string) => (deps: WebClientDeps) => express.Router): Promise<number> {
  const dataDir = tmp('sel-asset-app-');
  const pairing = await PairingManager.open(dataDir);
  const app = await createMobileApp({ dataDir, vision: NO_VISION, mode: 'cloud', pairing, cloudProxy: true, webClient: webClient(dataDir) });
  services.push(app.locals.mobileRecognitionService as MobileRecognitionService);
  return listen(app);
}

function send(port: number, pathname: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: pathname, method, headers, agent: false }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk as Buffer));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
}

const asset = (name: string): string => `/s/app/assets/${name}`;
const vary = (reply: Reply): string => String(reply.headers.vary ?? '').toLowerCase();
const read = (name: string): Buffer => fs.readFileSync(path.join(assets, name));

/** 按回复自己声明的 content-encoding 解开正文；声明和正文对不上会在这里抛错。 */
function decoded(reply: Reply): Buffer {
  const encoding = reply.headers['content-encoding'];
  if (encoding === undefined) return reply.body;
  if (encoding === 'br') return brotliDecompressSync(reply.body);
  if (encoding === 'gzip') return gunzipSync(reply.body);
  throw new Error(`没见过的 content-encoding：${String(encoding)}`);
}

beforeAll(async () => {
  const dir = clientAppDir();
  expect(dir, '没有 dist/client：先运行 npm run build').not.toBeNull();
  clientDir = dir!;
  assets = path.join(clientDir, 'assets');
  const shell = fs.readFileSync(path.join(clientDir, 'index.html'), 'utf8');
  script = /\/s\/app\/assets\/(index-[\w-]+\.js)/.exec(shell)![1]!;
  style = /\/s\/app\/assets\/(index-[\w-]+\.css)/.exec(shell)![1]!;

  // 网关：没有学生、没有会话，worker 进程一个也不会起。
  const hostDir = tmp('sel-asset-host-');
  const registry = StudentRegistry.open(hostDir);
  const pool = new StudentWorkerPool({ dirFor: id => registry.studentDir(id), env: { SEL_STUDENT_WORKER_FAKE: '1', SEL_AI_MODE: 'mock' } });
  gateway = await createStudentHostGateway({ hostDir, registry, pool });
  gatewayPort = await mobileApp(() => deps => gateway.router({ limiter: deps.limiter, ipOf: deps.ipOf, originScheme: 'https:' }));
  workerPort = await mobileApp(dataDir => deps => createWebClientRouter({ ...deps, mobileDataDir: dataDir, studentHostWorker: true }));
});

afterAll(async () => {
  await Promise.all(services.splice(0).map(service => service.stop()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await gateway?.close();
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});

describe('真实路由：生产装配里的邀请码网关', () => {
  it('没登录、带 accept-encoding: br：主脚本和样式发的就是构建好的 .br；安全头、请求编号都在，不发 cookie', async () => {
    const ids = new Set<string>();
    for (const [name, type] of [[script, 'text/javascript; charset=utf-8'], [style, 'text/css; charset=utf-8']] as const) {
      const reply = await send(gatewayPort, asset(name), { 'accept-encoding': 'gzip, deflate, br' });
      expect(reply.status, name).toBe(200);
      expect(reply.headers['content-encoding'], name).toBe('br');
      // 发的是磁盘上那份预压缩件（不是每次请求现压），解开和原文件一字不差。
      expect(reply.body.equals(read(`${name}.br`)), name).toBe(true);
      expect(brotliDecompressSync(reply.body).equals(read(name)), name).toBe(true);
      expect(Number(reply.headers['content-length']), name).toBe(reply.body.length);
      expect(vary(reply), name).toContain('accept-encoding');
      expect(reply.headers['cache-control'], name).toBe(IMMUTABLE);
      // 网关给所有响应加 nosniff：类型错一点浏览器就不执行脚本、不应用样式。
      expect(reply.headers['content-type'], name).toBe(type);
      expect(reply.headers['x-content-type-options'], name).toBe('nosniff');
      expect(reply.headers['content-security-policy'], name).toContain("script-src 'self'");
      expect(reply.headers['x-frame-options'], name).toBe('DENY');
      expect(reply.headers['referrer-policy'], name).toBe('same-origin');
      expect(reply.headers['x-sel-request-id'], name).toMatch(/^[a-z0-9]{8,32}$/);
      expect(reply.headers['set-cookie'], name).toBeUndefined();
      ids.add(String(reply.headers['x-sel-request-id']));
    }
    expect(ids.size).toBe(2);
    // 一个学生都没有，更不会有 worker 被拉起来。
    expect(gateway.registry.listStudents()).toEqual([]);
  });

  it('会话 cookie 已经失效也照发：不回登录页，也不顺手清 cookie', async () => {
    const reply = await send(gatewayPort, asset(script), { 'accept-encoding': 'br', cookie: 'sel_student=expired-synthetic-token' });
    expect(reply.status).toBe(200);
    expect(reply.headers['content-encoding']).toBe('br');
    expect(reply.headers['set-cookie']).toBeUndefined();
    expect(brotliDecompressSync(reply.body).equals(read(script))).toBe(true);
  });

  it('只接受 gzip 时发 .gz，不带请求头时发原文件；三种回复都带 Vary，都是不可变缓存', async () => {
    const gzip = await send(gatewayPort, asset(script), { 'accept-encoding': 'gzip' });
    expect(gzip.headers['content-encoding']).toBe('gzip');
    expect(gzip.body.equals(read(`${script}.gz`))).toBe(true);
    expect(gunzipSync(gzip.body).equals(read(script))).toBe(true);
    const plain = await send(gatewayPort, asset(script));
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body.equals(read(script))).toBe(true);
    for (const reply of [gzip, plain]) {
      expect(reply.status).toBe(200);
      expect(vary(reply)).toContain('accept-encoding');
      expect(reply.headers['cache-control']).toBe(IMMUTABLE);
      expect(reply.headers['content-type']).toBe('text/javascript; charset=utf-8');
      expect(Number(reply.headers['content-length'])).toBe(reply.body.length);
    }
  });

  it('HEAD：头和 GET 一样，正文为空，content-length 是要发的那一份的大小', async () => {
    for (const [header, suffix] of [['br', '.br'], ['gzip', '.gz'], [undefined, '']] as const) {
      const headers: Record<string, string> = header ? { 'accept-encoding': header } : {};
      const get = await send(gatewayPort, asset(script), headers);
      const head = await send(gatewayPort, asset(script), headers, 'HEAD');
      expect(head.status, String(header)).toBe(200);
      expect(head.body.length, String(header)).toBe(0);
      for (const name of ['content-encoding', 'content-type', 'content-length', 'cache-control', 'vary', 'etag']) {
        expect(head.headers[name], `${String(header)} ${name}`).toBe(get.headers[name]);
      }
      expect(Number(head.headers['content-length']), String(header)).toBe(fs.statSync(path.join(assets, script + suffix)).size);
    }
  });

  it('条件请求：三种编码的 ETag 各不相同；同一种编码再来是 304，换一种编码拿到的是那一种的完整正文', async () => {
    const original = read(script);
    const plain = await send(gatewayPort, asset(script));
    const br = await send(gatewayPort, asset(script), { 'accept-encoding': 'br' });
    const gzip = await send(gatewayPort, asset(script), { 'accept-encoding': 'gzip' });
    const tags = [plain, br, gzip].map(reply => String(reply.headers.etag ?? ''));
    for (const tag of tags) expect(tag).toMatch(/^(?:W\/)?"[^"]+"$/);
    // 共用一个 ETag 的话，缓存会拿 br 的字节去答复只认 gzip 的浏览器。
    expect(new Set(tags).size).toBe(3);

    const again = await send(gatewayPort, asset(script), { 'accept-encoding': 'br', 'if-none-match': tags[1]! });
    expect(again.status).toBe(304);
    expect(again.body.length).toBe(0);
    expect(again.headers.etag).toBe(tags[1]);
    expect(vary(again)).toContain('accept-encoding');
    expect(again.headers['cache-control']).toBe(IMMUTABLE);
    expect((await send(gatewayPort, asset(script), { 'if-none-match': tags[0]! })).status).toBe(304);

    // 手里是 br 的 ETag，但这次只接受 gzip / 什么都不接受：不能回 304，要给能解的完整正文。
    const asGzip = await send(gatewayPort, asset(script), { 'accept-encoding': 'gzip', 'if-none-match': tags[1]! });
    expect(asGzip.status).toBe(200);
    expect(asGzip.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(asGzip.body).equals(original)).toBe(true);
    const asPlain = await send(gatewayPort, asset(script), { 'if-none-match': tags[1]! });
    expect(asPlain.status).toBe(200);
    expect(asPlain.headers['content-encoding']).toBeUndefined();
    expect(asPlain.body.equals(original)).toBe(true);
  });

  it('路径安全没松：压缩件本身、编码过的穿越、带斜杠和过长的名字都拿不到资源，404 也不会被长期缓存', async () => {
    const original = read(script);
    const packed = read(`${script}.br`);
    const refused = [
      `${script}.br`, `${script}.gz`,
      // 点号写成 %2E、后缀换大小写（macOS 的文件系统不分大小写，文件“存在”）也一样。
      `${script}%2Ebr`, `${script}.BR`, `${script}.Gz`,
      // 解码后会落回真实主脚本或别的可下发类型的穿越：只有名字校验拦得住。
      `%2e%2e%2fassets%2f${script}`, `.%2F${script}`, `..%2F..%2F..%2Fpackage.json`, '..%2Findex.html', `..%5Cassets%5C${script}`,
      `${script}%00.png`, `.${script}`, `${'a'.repeat(122)}.js`, '%E5%90%88%E6%88%90.js',
      // Express 的路由不计较末尾的斜杠：带上斜杠也还是同一个名字，压缩件照样 404。
      `${script}.br/`,
    ];
    for (const name of refused) {
      const reply = await send(gatewayPort, asset(name), { 'accept-encoding': 'br, gzip' });
      expect(reply.status, name).toBe(404);
      expect(reply.headers['content-type'], name).toContain('text/plain');
      expect(reply.body.toString('utf8'), name).toBe('not found');
      expect(reply.headers['content-encoding'], name).toBeUndefined();
      expect(reply.headers['cache-control'], name).toBe('private, no-store');
    }
    // 多一段路径时资源路由不匹配，落到网关的会话环节（没登录看到的是登录页）；要紧的是拿到的不是资源。
    for (const name of [`sub/${script}`, `sub/${script}.br`, `${script}/${script}`]) {
      const reply = await send(gatewayPort, asset(name), { 'accept-encoding': 'br, gzip' });
      expect(reply.status, name).toBe(200);
      expect(String(reply.headers['content-type']), name).toContain('text/html');
      expect(reply.headers['content-encoding'], name).toBeUndefined();
      expect(String(reply.headers['cache-control']), name).not.toContain('immutable');
      expect(String(reply.headers['content-type']), name).not.toContain('javascript');
      expect(reply.body.equals(original) || reply.body.equals(packed), name).toBe(false);
    }
  });

  // 独立补测时发现、随 #127 一起修掉的旧缺口：createMobileApp 给所有响应加了 pragma: no-cache，
  // 旧的 /s/assets/app.*.css|js 用 staticAssets.ts 的 cacheFor() 把它去掉了（studentHostReview.test.ts 有断言），
  // sendClientAsset 以前只改 cache-control、没去 pragma。线上主脚本因此同时带着 immutable 和 pragma: no-cache；
  // 把 pragma 当 no-cache 处理的浏览器每次打开都要回源确认一遍（304），一年的不可变缓存就打了折扣。
  it('指纹资源的响应不带 pragma: no-cache（三种编码都一样），404 仍然不缓存', async () => {
    for (const header of ['br', 'gzip', undefined]) {
      const reply = await send(gatewayPort, asset(script), header ? { 'accept-encoding': header } : {});
      expect(reply.status, String(header)).toBe(200);
      expect(reply.headers.pragma, String(header)).toBeUndefined();
      expect(reply.headers['cache-control'], String(header)).toBe(IMMUTABLE);
    }
    expect((await send(gatewayPort, asset('nope-12345678.js'), { 'accept-encoding': 'br' })).headers['cache-control']).toBe('private, no-store');
  });

  // 已知缺口，#127 之前就有、和压缩无关：文件名里有解不开的百分号编码时，Express 在匹配路由时抛 URIError，
  // 落到 createMobileApp 的兜底错误处理，回 500，并记一条 error 级的 sel_request_failed（带调用栈）。
  // 这个地址不用登录，谁都能刷出 500 和 error 日志；该按「名字不合法」回 400 或 404。修好后把 .fails 去掉。
  it.fails('已知缺口：文件名的百分号编码解不开时应该是 400 或 404，不是 500', async () => {
    const reply = await send(gatewayPort, asset('%E0%A4%A.js'), { 'accept-encoding': 'br, gzip' });
    expect([400, 404]).toContain(reply.status);
  });
});

describe('真实路由：学生 worker 自己的 /s', () => {
  it('没有设备 cookie 也按 Accept-Encoding 发；压缩件本身仍是 404', async () => {
    const original = read(script);
    const br = await send(workerPort, asset(script), { 'accept-encoding': 'gzip, deflate, br' });
    expect(br.status).toBe(200);
    expect(br.headers['content-encoding']).toBe('br');
    expect(brotliDecompressSync(br.body).equals(original)).toBe(true);
    expect(vary(br)).toContain('accept-encoding');
    expect(br.headers['cache-control']).toBe(IMMUTABLE);
    expect(br.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(br.headers['x-content-type-options']).toBe('nosniff');
    expect(br.headers['set-cookie']).toBeUndefined();
    const gzip = await send(workerPort, asset(style), { 'accept-encoding': 'gzip' });
    expect(gzip.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(gzip.body).equals(read(style))).toBe(true);
    const plain = await send(workerPort, asset(script));
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body.equals(original)).toBe(true);
    for (const suffix of ['.br', '.gz']) {
      const direct = await send(workerPort, asset(script + suffix), { 'accept-encoding': 'br, gzip' });
      expect(direct.status, suffix).toBe(404);
      expect(direct.headers['content-encoding'], suffix).toBeUndefined();
    }
  });
});

describe('构建产物 dist/client', () => {
  it('每个 .br / .gz 都能解回旁边的原文件，而且比原文件小；没有找不到原文件的压缩件', () => {
    const names = fs.readdirSync(assets);
    const variants = names.filter(isVariant);
    // 至少主脚本和样式各两份。
    expect(variants.length).toBeGreaterThanOrEqual(4);
    for (const variant of variants) {
      const source = variant.replace(/\.(?:br|gz)$/, '');
      expect(names, `${variant} 旁边没有原文件`).toContain(source);
      const original = read(source);
      const packed = read(variant);
      const unpacked = variant.endsWith('.br') ? brotliDecompressSync(packed) : gunzipSync(packed);
      expect(unpacked.equals(original), `${variant} 解开后和原文件不一样`).toBe(true);
      expect(packed.length, `${variant} 不比原文件小`).toBeLessThan(original.length);
    }
    // 服务器优先发 br，是因为它更小。
    for (const name of [script, style]) expect(read(`${name}.br`).length, name).toBeLessThan(read(`${name}.gz`).length);
  });

  it('1024 字节以上的 js / css / svg / json 两种压缩件都有；不到 1024 字节的和别的类型都没有', () => {
    const names = fs.readdirSync(assets);
    for (const name of names.filter(candidate => !isVariant(candidate))) {
      const size = fs.statSync(path.join(assets, name)).size;
      const expected = isText(name) && size >= 1024;
      for (const suffix of ['.br', '.gz']) expect(names.includes(name + suffix), `${name}${suffix}（原文件 ${size} 字节）`).toBe(expected);
    }
  });

  it('压缩件只在 assets/ 这一层：index.html 和别的目录里都没有', () => {
    const stray: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (isVariant(entry.name) && dir !== assets) stray.push(path.relative(clientDir, file));
      }
    };
    walk(clientDir);
    expect(stray).toEqual([]);
    expect(fs.existsSync(path.join(clientDir, 'index.html'))).toBe(true);
  });

  // 这次构建只有 js 和 css 时这条跳过（报告里显示 skipped），不凭空造一个图片出来；合成文件的版本在本文件最后一组。
  it.skipIf(BUILT_BINARIES.length === 0)('构建产物里的非文本资源（png、woff2 之类）照发原文件，不带 Vary 和 content-encoding', async () => {
    for (const name of BUILT_BINARIES) {
      const reply = await send(gatewayPort, asset(name), { 'accept-encoding': 'br, gzip' });
      expect(reply.headers['content-encoding'], name).toBeUndefined();
      if (reply.status !== 200) continue; // 不在 MIME 表里的类型本来就是 404
      expect(reply.headers.vary, name).toBeUndefined();
      expect(reply.body.equals(read(name)), name).toBe(true);
    }
  });
});

describe('precompress 插件（client/vite.config.ts）', () => {
  it('只压 assets/ 这一层 1024 字节以上的 js / css / svg / json；watch 模式和没有输出目录时什么都不写', async () => {
    // 用变量当路径：client/ 有自己的 tsconfig，不把它拉进根目录的类型检查。
    const configPath = '../../client/vite.config.ts';
    const loaded = await import(/* @vite-ignore */ configPath) as { default: { plugins?: unknown[] } };
    const plugins = (loaded.default.plugins ?? []).flat(Infinity) as Array<{ name?: string; writeBundle?: unknown } | null | undefined | false>;
    const plugin = plugins.find(candidate => candidate && candidate.name === 'sel-precompress');
    expect(plugin, 'client/vite.config.ts 里没有 sel-precompress 插件').toBeTruthy();
    const writeBundle = (plugin as { writeBundle: unknown }).writeBundle as (this: { meta: { watchMode: boolean } }, options: { dir?: string }, bundle: Record<string, unknown>) => void;

    const out = tmp('sel-precompress-');
    const text = (bytes: number): Buffer => Buffer.from('const synthetic = "合成内容";\n'.repeat(200)).subarray(0, bytes);
    const files: Record<string, number> = {
      'assets/at-threshold.js': 1024, 'assets/below-threshold.js': 1023, 'assets/style.css': 3000, 'assets/icon.svg': 3000, 'assets/data.json': 3000,
      'assets/picture.png': 3000, 'assets/font.woff2': 3000, 'assets/chunk.js.map': 3000, 'assets/nested/deep.js': 3000, 'index.html': 3000, 'sw.js': 3000,
    };
    for (const [name, bytes] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(out, name)), { recursive: true });
      fs.writeFileSync(path.join(out, name), text(bytes));
    }
    const bundle = Object.fromEntries(Object.keys(files).map(name => [name, {}]));
    const variants = (): string[] => {
      const found: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) walk(path.join(dir, entry.name));
          else if (isVariant(entry.name)) found.push(path.relative(out, path.join(dir, entry.name)).split(path.sep).join('/'));
        }
      };
      walk(out);
      return found.sort();
    };

    writeBundle.call({ meta: { watchMode: true } }, { dir: out }, bundle);
    expect(variants()).toEqual([]);
    writeBundle.call({ meta: { watchMode: false } }, {}, bundle);
    expect(variants()).toEqual([]);

    writeBundle.call({ meta: { watchMode: false } }, { dir: out }, bundle);
    const compressed = ['assets/at-threshold.js', 'assets/data.json', 'assets/icon.svg', 'assets/style.css'];
    expect(variants()).toEqual(compressed.flatMap(name => [`${name}.br`, `${name}.gz`]).sort());
    for (const name of compressed) {
      const original = fs.readFileSync(path.join(out, name));
      expect(brotliDecompressSync(fs.readFileSync(path.join(out, `${name}.br`))).equals(original), name).toBe(true);
      expect(gunzipSync(fs.readFileSync(path.join(out, `${name}.gz`))).equals(original), name).toBe(true);
    }
  });
});

describe('Accept-Encoding 的边界', () => {
  it('acceptedEncodings：极小的 q、多余的参数、空串、多余的逗号、别名和长得像的名字', () => {
    expect([...acceptedEncodings('')]).toEqual([]);
    expect([...acceptedEncodings(' , ,')]).toEqual([]);
    expect([...acceptedEncodings([])]).toEqual([]);
    expect([...acceptedEncodings('gzip,,br,')]).toEqual(['gzip', 'br']);
    expect([...acceptedEncodings('gzip;q=0.0001')]).toEqual(['gzip']);
    expect([...acceptedEncodings('br;q=1;foo=bar')]).toEqual(['br']);
    // q 不在第一个参数的位置也要认。
    expect([...acceptedEncodings('br;foo=bar;q=0, gzip;foo=bar;q=0.3')]).toEqual(['gzip']);
    expect([...acceptedEncodings('BR;Q=0, GZIP;Q=0.5')]).toEqual(['gzip']);
    expect([...acceptedEncodings('br;q=0., gzip;q=1.')]).toEqual(['gzip']);
    expect([...acceptedEncodings('br, BR;q=0.5, br')]).toEqual(['br']);
    expect([...acceptedEncodings('*;q=1, br;q=0')]).toEqual([]);
    expect([...acceptedEncodings(['br;q=0', 'gzip'])]).toEqual(['gzip']);
    expect([...acceptedEncodings('identity')]).toEqual(['identity']);
    // 只认整个名字：别名和长得像的都不能被当成 br / gzip。
    const lookalikes = acceptedEncodings('x-gzip, gzipped, brotli, xbr, br2, zstd, deflate');
    expect(lookalikes.has('br')).toBe(false);
    expect(lookalikes.has('gzip')).toBe(false);
  });

  it('线上结果：只报 zstd / deflate 之类的拿到原文件；回复声明的编码一定是浏览器点名接受的，解开一定是原文件', async () => {
    const original = read(script);
    // allowed：这个请求头下哪些 content-encoding 说得过去（undefined = 原文件）。
    const cases: Array<{ header: string; allowed: Array<string | undefined> }> = [
      { header: 'zstd', allowed: [undefined] },
      { header: 'deflate', allowed: [undefined] },
      { header: 'zstd;q=1, deflate, compress, identity', allowed: [undefined] },
      { header: '', allowed: [undefined] },
      { header: 'brotli, gzipped, xbr, br2', allowed: [undefined] },
      // RFC 9110 把 x-gzip 当 gzip 的别名；现在的实现不认，发原文件。两种都说得过去，发 br 才是错。
      { header: 'x-gzip', allowed: [undefined, 'gzip'] },
      { header: 'gzip;q=0.0001', allowed: ['gzip'] },
      { header: 'br;q=1;foo=bar', allowed: ['br'] },
      { header: 'zstd, BR;q=0.001', allowed: ['br'] },
      { header: 'identity;q=0, gzip', allowed: ['gzip'] },
      { header: 'br;q=0.1, gzip;q=1', allowed: ['br', 'gzip'] },
      // 点名拒绝的那一种，不能借着 * 发回去。
      { header: '*;q=1, br;q=0', allowed: [undefined, 'gzip'] },
      { header: 'gzip;q=0, *', allowed: [undefined, 'br'] },
    ];
    for (const { header, allowed } of cases) {
      const reply = await send(gatewayPort, asset(script), { 'accept-encoding': header });
      expect(reply.status, header).toBe(200);
      expect(allowed, header).toContain(reply.headers['content-encoding']);
      expect(decoded(reply).equals(original), header).toBe(true);
      expect(vary(reply), header).toContain('accept-encoding');
    }
  });
});

describe('合成目录：构建产物里没有的情况', () => {
  // 真实构建现在只有 js 和 css，而且压缩件要么两种都有、要么都没有。下面这些分支只能拿合成文件来走：
  // 把 process.cwd() 临时指到一个临时目录、重新加载 clientApp.ts，让它把那里的 dist/client 当成产物目录。
  // clientAppDir() 找目录的方式变了的话，beforeAll 里的断言会先失败并说明原因。
  let port = 0;
  let dir = '';
  const body = (label: string): Buffer => Buffer.from(`/* 合成资源 ${label} */\n`.repeat(80));
  /** 放在不该被发出去的位置上的压缩件：内容和原文件无关，真发出来一眼就能认出。 */
  const TRAP = Buffer.from('合成的陷阱：这份压缩件不该被发出去。'.repeat(40));
  const write = (name: string, content: Buffer): void => fs.writeFileSync(path.join(dir, name), content);

  beforeAll(async () => {
    const root = tmp('sel-asset-synthetic-');
    dir = path.join(root, 'dist', 'client', 'assets');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(root, 'dist', 'client', 'index.html'), '<!doctype html><title>合成的壳</title>');
    // 不可压缩的类型，旁边故意放上压缩件。
    for (const name of ['picture-00000001.png', 'font-00000001.woff2', 'font-00000001.woff', 'chunk-00000001.js.map']) {
      write(name, body(name));
      write(`${name}.br`, brotliCompressSync(TRAP));
      write(`${name}.gz`, gzipSync(TRAP));
    }
    // 压缩件不齐。
    write('only-gz-00000001.js', body('only-gz'));
    write('only-gz-00000001.js.gz', gzipSync(body('only-gz')));
    write('only-br-00000001.css', body('only-br'));
    write('only-br-00000001.css.br', brotliCompressSync(body('only-br')));
    write('dir-br-00000001.js', body('dir-br'));
    fs.mkdirSync(path.join(dir, 'dir-br-00000001.js.br'));
    write('dir-br-00000001.js.gz', gzipSync(body('dir-br')));
    // svg 和 json：真实构建里暂时没有。
    for (const name of ['icon-00000001.svg', 'data-00000001.json']) {
      write(name, body(name));
      write(`${name}.br`, brotliCompressSync(body(name)));
      write(`${name}.gz`, gzipSync(body(name)));
    }

    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
    vi.resetModules();
    let fresh: typeof import('../../src/web/clientApp.js');
    try { fresh = await import('../../src/web/clientApp.js'); } finally { cwd.mockRestore(); }
    expect(fs.realpathSync(fresh.clientAppDir() ?? ''), '重新加载的 clientApp.ts 没有把合成目录当成产物目录').toBe(fs.realpathSync(path.join(root, 'dist', 'client')));
    const app = express();
    app.get('/s/app/assets/:file', fresh.sendClientAsset);
    port = await listen(app);
  });

  it('png / woff2 / woff / map：旁边就算有压缩件也发原文件，不带 Vary 和 content-encoding', async () => {
    for (const [name, type] of [['picture-00000001.png', 'image/png'], ['font-00000001.woff2', 'font/woff2'], ['font-00000001.woff', 'font/woff'], ['chunk-00000001.js.map', 'application/json']] as const) {
      for (const header of ['br, gzip', 'gzip', undefined]) {
        const reply = await send(port, asset(name), header ? { 'accept-encoding': header } : {});
        expect(reply.status, name).toBe(200);
        expect(reply.headers['content-encoding'], name).toBeUndefined();
        expect(reply.headers.vary, name).toBeUndefined();
        expect(reply.headers['content-type'], name).toContain(type);
        expect(reply.headers['cache-control'], name).toBe(IMMUTABLE);
        expect(reply.body.equals(body(name)), name).toBe(true);
      }
      for (const suffix of ['.br', '.gz']) expect((await send(port, asset(name + suffix), { 'accept-encoding': 'br, gzip' })).status, name + suffix).toBe(404);
    }
  });

  it('压缩件不齐时退到下一种：只有 .gz 的发 gzip，只有 .br 而浏览器只认 gzip 的发原文件，.br 是个目录的跳过它', async () => {
    const onlyGz = await send(port, asset('only-gz-00000001.js'), { 'accept-encoding': 'br, gzip' });
    expect(onlyGz.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(onlyGz.body).equals(body('only-gz'))).toBe(true);
    const onlyGzBr = await send(port, asset('only-gz-00000001.js'), { 'accept-encoding': 'br' });
    expect(onlyGzBr.headers['content-encoding']).toBeUndefined();
    expect(onlyGzBr.body.equals(body('only-gz'))).toBe(true);

    const onlyBr = await send(port, asset('only-br-00000001.css'), { 'accept-encoding': 'gzip' });
    expect(onlyBr.status).toBe(200);
    expect(onlyBr.headers['content-encoding']).toBeUndefined();
    expect(vary(onlyBr)).toContain('accept-encoding');
    expect(onlyBr.body.equals(body('only-br'))).toBe(true);
    expect((await send(port, asset('only-br-00000001.css'), { 'accept-encoding': 'gzip, br' })).headers['content-encoding']).toBe('br');

    const dirBr = await send(port, asset('dir-br-00000001.js'), { 'accept-encoding': 'br, gzip' });
    expect(dirBr.status).toBe(200);
    expect(dirBr.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(dirBr.body).equals(body('dir-br'))).toBe(true);
    const dirBrOnly = await send(port, asset('dir-br-00000001.js'), { 'accept-encoding': 'br' });
    expect(dirBrOnly.status).toBe(200);
    expect(dirBrOnly.headers['content-encoding']).toBeUndefined();
    expect(dirBrOnly.body.equals(body('dir-br'))).toBe(true);
  });

  it('svg 和 json 也按协商发，类型不变', async () => {
    for (const [name, type] of [['icon-00000001.svg', 'image/svg+xml'], ['data-00000001.json', 'application/json']] as const) {
      for (const [header, encoding] of [['br, gzip', 'br'], ['gzip', 'gzip'], ['zstd', undefined]] as const) {
        const reply = await send(port, asset(name), { 'accept-encoding': header });
        expect(reply.status, name).toBe(200);
        expect(reply.headers['content-encoding'], `${name} ${header}`).toBe(encoding);
        expect(reply.headers['content-type'], name).toContain(type);
        expect(vary(reply), name).toContain('accept-encoding');
        expect(decoded(reply).equals(body(name)), `${name} ${header}`).toBe(true);
      }
    }
  });
});
