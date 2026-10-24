/**
 * T2 单进程装配 + 共享数据库（RED → GREEN）。
 * 一个 Node 进程同时提供：/v1 识别服务（设备令牌鉴权，语义不变）、/v2/health（设备令牌鉴权）。
 * 共享 SEL_DATA_DIR/app.db。云端公网入口不挂旧的 Web 看板：默认 Host 下 /、/parent、/items、/trends 一律 404。
 * /help/ 是公开说明页，见 helpPortal.test.ts。GET / 没有说明页例外。
 * 测试用临时目录与合成数据；不调真实模型、不读 .env、不读 data/。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { assembleCloudService, type CloudAssembly } from '../../src/mobile/cloudAssembly.js';
import { createMobileApp } from '../../src/mobile/router.js';
import type { MobileConfiguration } from '../../src/mobile/configuration.js';
import type { MobileRecognitionService } from '../../src/mobile/service.js';
import { getDb } from '../../src/db/connection.js';
import { createV2Router } from '../../src/v2/router.js';
import type { MobileVisionBoundary, VisionContext, VisionInventoryResult, VisionQuestionResult, InventoryCandidate } from '../../src/mobile/vision.js';

const roots: string[] = [];
const clouds: CloudAssembly[] = [];
const loopbackServices: MobileRecognitionService[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(clouds.splice(0).map(assembly => assembly.close()));
  await Promise.all(loopbackServices.splice(0).map(service => service.stop()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});

const box = { x: 0, y: 0, width: 1, height: 1 };
class FixtureVision implements MobileVisionBoundary {
  async inventory(_source: Buffer, _context: VisionContext): Promise<VisionInventoryResult> {
    return { candidates: [{ number: '1', box, selectionEvidence: 'unmarked', partial: false }], warnings: [] };
  }
  async recognizeQuestion(_source: Buffer, candidate: InventoryCandidate, _context: VisionContext): Promise<VisionQuestionResult> {
    return { evidence: { version: 1, questionNumber: candidate.number, questionText: '求 x 的值。', subject: '数学', chapter: '', knowledgeTags: [], questionType: '计算', questionRegion: box, requiresDiagram: false, regions: [], observations: [], uncertainties: [] }, verification: { textComplete: true, questionCropComplete: true, questionCropPure: true, transcriptionMatches: true, diagramSafe: true, issues: [] }, questionCrop: _source, diagramCrops: [] };
  }
}

async function tempRoot(): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-t2-assembly-'));
  roots.push(root);
  return root;
}

async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}

function cloudConfiguration(dataDir: string, port: number): MobileConfiguration {
  return {
    mode: 'cloud', host: '127.0.0.1', port, dataDir, pairingToken: '',
    vision: {
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'synthetic', timeoutMs: 1000, bailianOnly: true,
      models: { inventory: 'm', transcribe: 'm', verify: 'm', ground: 'm' },
    },
  };
}

/** 真实 Unix socket HTTP 客户端（取配对码；不 mock 传输层）。 */
function socketGet(socketPath: string, url: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, method: 'GET', path: url }, response => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { raw += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, text: raw }));
    });
    request.on('error', reject);
    request.setTimeout(10_000, () => request.destroy(new Error('admin socket request timeout')));
    request.end();
  });
}

/** 经管理 socket 取配对码 → 公网 redeem，拿到被装配内部 PairingManager 认可的设备令牌。 */
async function issueDeviceToken(base: string, dataDir: string): Promise<string> {
  const code = await socketGet(path.join(dataDir, 'admin.sock'), '/pairing-code');
  expect(code.status).toBe(200);
  const { payload } = JSON.parse(code.text) as { payload: unknown };
  const response = await fetch(`${base}/v1/pairing/redeem`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ payload, clientId: crypto.randomUUID(), deviceInfo: 'iPhone' }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

async function setupCloud(): Promise<{ base: string; token: string; dataDir: string }> {
  const dataDir = await tempRoot();
  const port = await freePort();
  const assembly = await assembleCloudService(cloudConfiguration(dataDir, port));
  clouds.push(assembly);
  await assembly.listen();
  const base = `http://127.0.0.1:${port}`;
  const token = await issueDeviceToken(base, dataDir);
  return { base, token, dataDir };
}

function countProfiles(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM student_profile').get() as { n: number }).n;
}

describe('T2 云端单进程装配', () => {
  it('同一端口：/v1/health 与 /v2/health 设备令牌鉴权', async () => {
    const { base, token } = await setupCloud();
    const auth = { authorization: `Bearer ${token}` };

    // /v1 语义不变：无令牌 401，有令牌 200 且仍是协议 v1 形状。
    expect((await fetch(`${base}/v1/health`)).status).toBe(401);
    const v1 = await fetch(`${base}/v1/health`, { headers: auth });
    expect(v1.status).toBe(200);
    expect((await v1.json()) as Record<string, unknown>).toMatchObject({ version: 1, protocolVersion: 1 });

    // /v2/health：无令牌 401，有令牌 200 且 protocolVersion 2。
    expect((await fetch(`${base}/v2/health`)).status).toBe(401);
    const v2 = await fetch(`${base}/v2/health`, { headers: auth });
    expect(v2.status).toBe(200);
    expect((await v2.json()) as Record<string, unknown>).toMatchObject({ protocolVersion: 2 });
  });

  it('云端公网入口不挂任何 Web 页面：/、/parent、/items、/trends 匿名与带令牌均 404 JSON，POST /batches 404', async () => {
    const { base, token } = await setupCloud();
    const auth = { authorization: `Bearer ${token}` };
    for (const path of ['/', '/parent', '/items', '/trends']) {
      // 匿名 404 JSON。
      const anonymous = await fetch(`${base}${path}`);
      expect(anonymous.status).toBe(404);
      expect(anonymous.headers.get('content-type')).toContain('application/json');
      expect(((await anonymous.json()) as { error: { code: string } }).error.code).toBe('not_found');
      // 带设备令牌同样 404 JSON（云端没有 Web 看板可鉴权进入）。
      const authed = await fetch(`${base}${path}`, { headers: auth });
      expect(authed.status).toBe(404);
      expect(authed.headers.get('content-type')).toContain('application/json');
      expect(((await authed.json()) as { error: { code: string } }).error.code).toBe('not_found');
    }
    // Web 写入路由同样不存在：404（走移动 app 既有 404 处理器）。
    const post = await fetch(`${base}/batches`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Bearer ${token}` }, body: '',
    });
    expect(post.status).toBe(404);
    expect(post.headers.get('content-type')).toContain('application/json');
  });

  it('closes HTTP and admin listeners before reporting a material shutdown write failure', async () => {
    const dataDir = await tempRoot();
    const assembly = await assembleCloudService(cloudConfiguration(dataDir, 0), {
      vision: new FixtureVision(),
      configureMaterials: jobs => {
        const question = jobs.store.createQuestion().id;
        jobs.enqueue('answer', question, crypto.randomUUID(), 'synthetic-basis');
      },
    });
    clouds.push(assembly); await assembly.listen();
    const port = assembly.boundPort()!; const socketPath = assembly.admin!.socketPath;
    const canConnect = (options: net.NetConnectOpts): Promise<boolean> => new Promise(resolve => {
      const socket = net.createConnection(options);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => { socket.destroy(); resolve(false); });
      socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
    });
    expect(await canConnect({ host: '127.0.0.1', port })).toBe(true);
    expect(await canConnect({ path: socketPath })).toBe(true);
    getDb().exec("CREATE TRIGGER reject_cloud_stop BEFORE UPDATE OF state ON material_job WHEN NEW.state='interrupted' BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END");
    try {
      const closeError = await assembly.close().then(() => null, error => error);
      expect(closeError).toBeInstanceOf(AggregateError);
      const messages = (error: unknown): string[] => error instanceof AggregateError ? error.errors.flatMap(messages) : [String(error)];
      expect(messages(closeError).join(' ')).toContain('synthetic storage failure');
      expect({
        httpListening: await canConnect({ host: '127.0.0.1', port }),
        adminListening: await canConnect({ path: socketPath }),
        socketExists: fs.existsSync(socketPath),
        boundPort: assembly.boundPort(),
      }).toEqual({ httpListening: false, adminListening: false, socketExists: false, boundPort: null });
      const replacement = net.createServer();
      try {
        await new Promise<void>((resolve, reject) => { replacement.once('error', reject); replacement.listen(port, '127.0.0.1', resolve); });
        expect((replacement.address() as net.AddressInfo).port).toBe(port);
      } finally { await new Promise<void>(resolve => replacement.close(() => resolve())); }
    } finally {
      getDb().exec('DROP TRIGGER reject_cloud_stop');
      await assembly.close();
    }
  });

  it('装配两次不创建第二个学生档案（共享 SEL_DATA_DIR/app.db）', async () => {
    const first = await assembleCloudService(cloudConfiguration(await tempRoot(), await freePort()));
    clouds.push(first);
    await first.listen();
    const afterFirst = countProfiles();
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    const second = await assembleCloudService(cloudConfiguration(await tempRoot(), await freePort()));
    clouds.push(second);
    await second.listen();
    expect(countProfiles()).toBe(afterFirst);
  });
});

describe('T2 回环模式装配', () => {
  it('loopback 同样挂载 /v2/health（共享令牌鉴权），/v1 语义不变', async () => {
    const dataDir = await tempRoot();
    const pairingToken = 'loopback-shared-token-0123456789';
    const app = await createMobileApp({ dataDir, pairingToken, vision: new FixtureVision(), v2Router: createV2Router });
    loopbackServices.push(app.locals.mobileRecognitionService);
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise<void>(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    expect((await fetch(`${base}/v2/health`)).status).toBe(401);
    const v2 = await fetch(`${base}/v2/health`, { headers: { authorization: `Bearer ${pairingToken}` } });
    expect(v2.status).toBe(200);
    expect((await v2.json()) as Record<string, unknown>).toMatchObject({ protocolVersion: 2 });

    expect((await fetch(`${base}/v1/health`)).status).toBe(401);
    const v1 = await fetch(`${base}/v1/health`, { headers: { authorization: `Bearer ${pairingToken}` } });
    expect(v1.status).toBe(200);
  });
});
