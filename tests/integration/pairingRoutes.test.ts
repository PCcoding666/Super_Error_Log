import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createMobileApp } from '../../src/mobile/router.js';
import type { MobileRecognitionService } from '../../src/mobile/service.js';
import { PairingManager, type PairingCodePayload } from '../../src/mobile/pairing.js';
import { assembleCloudService } from '../../src/mobile/cloudAssembly.js';
import type { MobileVisionBoundary, VisionContext, VisionInventoryResult, VisionQuestionResult, InventoryCandidate } from '../../src/mobile/vision.js';

const roots: string[] = [];
const servers: Server[] = [];
const services: MobileRecognitionService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.stop()));
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

type RequestFn = (url: string, init?: RequestInit) => Promise<Response>;

async function tempRoot(): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-cloud-routes-'));
  roots.push(root);
  return root;
}

/**
 * 云端模式装配：真实 PairingManager + cloudProxy 语义（仅信任本机 peer 的 X-Real-IP 覆写头）。
 * 应用监听 127.0.0.1，直连（loopback）peer 会被信任读取 X-Real-IP——模拟 Caddy `header_up X-Real-IP {remote_host}` 的效果。
 */
async function setupCloud(vision: MobileVisionBoundary = new FixtureVision(), options: { devicePrerecorded?: boolean } = {}): Promise<{
  request: RequestFn; anonymous: RequestFn; forged: RequestFn; manager: PairingManager; base: string;
}> {
  const dataDir = await tempRoot();
  const manager = await PairingManager.open(dataDir);
  const app = await createMobileApp({ dataDir, vision, mode: 'cloud', pairing: manager, cloudProxy: true });
  services.push(app.locals.mobileRecognitionService);
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let deviceToken = '';
  if (options.devicePrerecorded !== false) {
    const result = await manager.redeem(manager.createSession().payload, crypto.randomUUID(), 'iPhone');
    deviceToken = result.token;
  }
  const request: RequestFn = (url, init = {}) => fetch(`${base}${url}`, { ...init, headers: { authorization: `Bearer ${deviceToken}`, ...init.headers } });
  // 匿名请求：模拟外部客户端经 Caddy 到达——真实 remote 为 127.0.0.1，头被 Caddy 覆写为外部地址。
  const anonymous: RequestFn = (url, init = {}) => fetch(`${base}${url}`, { ...init, headers: { 'x-real-ip': '9.9.9.9', ...init.headers } });
  // 伪造头：客户端自带 X-Real-IP 试图绕过（模拟 Caddy 覆写前的客户端原值；应用侧因覆写语义只应信任最终值）。
  const forged: RequestFn = (url, init = {}) => fetch(`${base}${url}`, { ...init, headers: { 'x-real-ip': '1.2.3.4', ...init.headers } });
  return { request, anonymous, forged, manager, base };
}

async function redeem(request: RequestFn, payload: PairingCodePayload, clientId: string, deviceInfo = 'iPhone'): Promise<Response> {
  return request('/v1/pairing/redeem', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payload, clientId, deviceInfo }) });
}

describe('POST /v1/pairing/redeem', () => {
  it('兑换成功返回 RedeemResult；同 clientId 幂等重取返回同一结果', async () => {
    const { anonymous, manager } = await setupCloud();
    const { payload } = manager.createSession();
    const clientId = crypto.randomUUID();
    const first = await redeem(anonymous, payload, clientId);
    expect(first.status).toBe(200);
    const body = await first.json() as { token: string; deviceId: string; serviceId: string; expiresAt: string; protocolVersion: number };
    expect(body.protocolVersion).toBe(1);
    expect(body.serviceId).toBe(payload.serviceId);
    expect(crypto.createHash('sha256').update(body.token).digest('hex')).toHaveLength(64);
    const again = await redeem(anonymous, payload, clientId);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(body);
  });

  it('两个不同 clientId 并发兑换同一 sessionId 只有一个成功 409 pairing_used', async () => {
    const { anonymous, manager } = await setupCloud();
    const { payload } = manager.createSession();
    const [first, second] = await Promise.all([
      redeem(anonymous, payload, crypto.randomUUID()),
      redeem(anonymous, payload, crypto.randomUUID()),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const rejected = first.status === 409 ? first : second;
    expect((await rejected.json() as { error: { code: string } }).error.code).toBe('pairing_used');
  });

  it('过期会话 410；换 clientId 重放 409；非法载荷 400', async () => {
    const { anonymous, manager } = await setupCloud();
    const session = manager.createSession();
    const clientId = crypto.randomUUID();
    const valid = await redeem(anonymous, session.payload, clientId);
    expect(valid.status).toBe(200);
    // 重放：换 clientId 使用同一已兑换会话。
    expect((await redeem(anonymous, session.payload, crypto.randomUUID())).status).toBe(409);
    // 非法载荷（版本错误）。
    const stale: unknown = { ...session.payload, v: 2 };
    expect((await redeem(anonymous, stale as PairingCodePayload, crypto.randomUUID())).status).toBe(400);
  });

  it('会话 5 分钟后过期：过期兑换 410 pairing_expired', async () => {
    const clock = { now: new Date() };
    const dataDir = await tempRoot();
    const manager = await PairingManager.open(dataDir, { now: () => clock.now });
    const app = await createMobileApp({ dataDir, vision: new FixtureVision(), mode: 'cloud', pairing: manager, cloudProxy: true });
    services.push(app.locals.mobileRecognitionService);
    const server = app.listen(0, '127.0.0.1'); servers.push(server);
    await new Promise<void>(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const anonymous: RequestFn = (url, init = {}) => fetch(`${base}${url}`, { ...init, headers: { 'x-real-ip': '9.9.9.9', ...init.headers } });
    const { payload } = manager.createSession();
    clock.now = new Date(clock.now.getTime() + 5 * 60 * 1000 + 1000);
    const response = await redeem(anonymous, payload, crypto.randomUUID());
    expect(response.status).toBe(410);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('pairing_expired');
  });

  it('请求体上限 16kb：超限 413，文案指向配对而非照片', async () => {
    const { anonymous, manager } = await setupCloud();
    const { payload } = manager.createSession();
    const large = { payload, clientId: crypto.randomUUID(), deviceInfo: 'x'.repeat(20_000) };
    const response = await anonymous('/v1/pairing/redeem', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(large) });
    expect(response.status).toBe(413);
    const body = await response.json() as { error: { message: string } };
    expect(body.error.message).toContain('16 KB');
    expect(body.error.message).not.toContain('照片');
  });

  it('redeem 失败计入配对限流：每 IP 10/分钟后 429 + Retry-After', async () => {
    const { anonymous } = await setupCloud();
    const invalidPayload: unknown = { v: 1, serviceId: '0'.repeat(36), httpsUrl: 'https://study.pccoding666.com', sessionId: crypto.randomUUID(), secret: 'x'.repeat(43) };
    for (let index = 0; index < 10; index += 1) await redeem(anonymous, invalidPayload as PairingCodePayload, crypto.randomUUID());
    const blocked = await redeem(anonymous, invalidPayload as PairingCodePayload, crypto.randomUUID());
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});

describe('cloud device-token authentication on /v1', () => {
  it('无令牌访问 health 与集合 401；redeem 不需要令牌', async () => {
    const { anonymous, base } = await setupCloud();
    const health = await anonymous('/v1/health');
    expect(health.status).toBe(401);
    expect((await fetch(`${base}/v1/recognitions`)).status).toBe(401);
    const manager = await PairingManager.open(await tempRoot());
    const redemption = await redeem(anonymous, manager.createSession().payload, crypto.randomUUID());
    // redeem 是独立兑换入口：不需要 Authorization（结果非 401）。
    expect(redemption.status).not.toBe(401);
  });

  it('云端模式下旧共享令牌 401', async () => {
    const { base } = await setupCloud();
    const response = await fetch(`${base}/v1/health`, { headers: { authorization: 'Bearer legacy-shared-token-1234' } });
    expect(response.status).toBe(401);
  });

  it('撤销后的设备令牌立即 401', async () => {
    const { request, manager } = await setupCloud();
    expect((await request('/v1/health')).status).toBe(200);
    const deviceId = (await manager.listDevices())[0]?.deviceId;
    expect(deviceId).toBeTruthy();
    await manager.revoke(deviceId!);
    // request 闭包持有的仍是撤销前的同一令牌——必须立即失效。
    const response = await request('/v1/health');
    expect(response.status).toBe(401);
  });

  it('鉴权失败每 IP 30/分钟后 429；伪造 X-Real-IP 不能绕过限流', async () => {
    const { base } = await setupCloud();
    // 模拟 Caddy 覆写路径：header_up X-Real-IP {remote_host} 显式覆盖客户端传入值，
    // 无论请求携带什么伪造头，到达应用时都是真实来源（本测试直连即 127.0.0.1）。
    const throughCaddy: RequestFn = (url, init = {}) => fetch(`${base}${url}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), 'x-real-ip': '127.0.0.1' } });
    for (let index = 0; index < 31; index += 1) {
      await throughCaddy('/v1/recognitions', { method: 'GET', headers: { 'x-real-ip': `1.2.3.${index % 250}` } });
    }
    const response = await throughCaddy('/v1/recognitions', { method: 'GET' });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBeTruthy();
  });

  it('已鉴权查询每设备 300/分钟；超限 429', async () => {
    const { request } = await setupCloud();
    let blocked: Response | null = null;
    for (let index = 0; index < 302; index += 1) {
      const response = await request('/v1/recognitions');
      if (response.status === 429) { blocked = response; break; }
    }
    expect(blocked).not.toBeNull();
    expect(blocked?.headers.get('retry-after')).toBeTruthy();
  });
});

describe('cloud assembly close semantics', () => {
  it('close() 释放 HTTP 端口与 admin socket，不泄漏监听（review V1 回归）', async () => {
    const probe = net;
    const freePort = await new Promise<number>((resolve, reject) => {
      const server = probe.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { const port = (server.address() as { port: number }).port; server.close(() => resolve(port)); });
    });
    const dataDir = await tempRoot();
    const configuration = { mode: 'cloud' as const, host: '127.0.0.1' as const, port: freePort, dataDir, pairingToken: '', vision: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'synthetic', timeoutMs: 1000, bailianOnly: true as const, models: { inventory: 'm', transcribe: 'm', verify: 'm', ground: 'm' } } };
    const service = await assembleCloudService(configuration);
    await service.listen();
    const listening = await new Promise<boolean>(resolve => {
      const socket = probe.connect({ port: freePort, host: '127.0.0.1' });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    expect(listening).toBe(true);
    await service.close();
    const stillOpen = await new Promise<boolean>(resolve => {
      const socket = probe.connect({ port: freePort, host: '127.0.0.1' });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    expect(stillOpen).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'admin.sock'))).toBe(false);
  });

  it('重复 listen 拒绝，不产生双监听', async () => {
    const probe = net;
    const freePort = await new Promise<number>((resolve, reject) => {
      const server = probe.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { const port = (server.address() as { port: number }).port; server.close(() => resolve(port)); });
    });
    const configuration = { mode: 'cloud' as const, host: '127.0.0.1' as const, port: freePort, dataDir: await tempRoot(), pairingToken: '', vision: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'synthetic', timeoutMs: 1000, bailianOnly: true as const, models: { inventory: 'm', transcribe: 'm', verify: 'm', ground: 'm' } } };
    const service = await assembleCloudService(configuration);
    await service.listen();
    await expect(service.listen()).rejects.toThrow('重复');
    await service.close();
  });
});

describe('cloud health response and admin absence', () => {
  it('健康返回云端形状：version/serviceId/storage/vision/accepting/protocolVersion', async () => {
    const { request, manager } = await setupCloud();
    const response = await request('/v1/health');
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ version: 1, serviceId: manager.serviceId, storageAvailable: true, visionConfigured: true, protocolVersion: 1 });
    expect(typeof body.acceptingJobs).toBe('boolean');
  });

  it('公网 app 不存在 /v1/admin 路由', async () => {
    const { request } = await setupCloud();
    const response = await request('/v1/admin/pairing-code');
    expect(response.status).toBe(404);
  });

  it('错误体不含令牌或秘密', async () => {
    const { anonymous, manager } = await setupCloud();
    const { payload } = manager.createSession();
    const invalid: unknown = { ...payload, v: 2 };
    const response = await redeem(anonymous, invalid as PairingCodePayload, crypto.randomUUID());
    const text = await response.text();
    expect(text).not.toContain(payload.secret);
    const unauthorized = await anonymous('/v1/recognitions');
    expect(await unauthorized.text()).not.toContain('Bearer');
  });
});
