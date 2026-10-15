import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { PairingManager } from '../../src/mobile/pairing.js';
import { createAdminServer, type AdminServerHandle } from '../../src/mobile/adminServer.js';

interface SocketAddress { address: string }

const directories: string[] = [];
const handles: AdminServerHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map(handle => handle.close()));
  directories.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true }));
});

async function tempDir(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-admin-'));
  directories.push(dir);
  return dir;
}

// 真实 Unix domain socket HTTP 客户端：不 mock 传输层。
function requestOverSocket(socketPath: string, method: string, url: string, body?: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, method, path: url, headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : undefined }, response => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { raw += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, text: raw }));
    });
    request.on('error', reject);
    request.setTimeout(10_000, () => request.destroy(new Error('admin socket request timeout')));
    if (body) request.write(body);
    request.end();
  });
}

async function setup(): Promise<{ handle: AdminServerHandle; manager: PairingManager; socketPath: string; request: (url: string, init?: { method?: string; body?: string }) => Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> }> {
  const dataDir = await tempDir();
  const manager = await PairingManager.open(dataDir);
  const handle = await createAdminServer(manager);
  handles.push(handle);
  const socketPath = (handle.server.address() as SocketAddress).address ?? path.join(dataDir, 'admin.sock');
  const request = (url: string, init: { method?: string; body?: string } = {}) => requestOverSocket(socketPath, init.method ?? 'GET', url, init.body);
  return { handle, manager, socketPath, request };
}

describe('admin Unix-socket entry', () => {
  it('监听 dataDir/admin.sock，父目录 0700、socket 文件 0600', async () => {
    const dataDir = await tempDir();
    const manager = await PairingManager.open(dataDir);
    const handle = await createAdminServer(manager);
    handles.push(handle);
    const socketPath = path.join(dataDir, 'admin.sock');
    expect(handle.socketPath).toBe(socketPath);
    expect(String(handle.server.address())).toBe(socketPath);
    expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dataDir).mode & 0o777).toBe(0o700);
  });

  it('GET /pairing-code 返回二维码载荷 JSON，含协议版本与固定 HTTPS 地址，不含任何长期令牌', async () => {
    const { request } = await setup();
    const response = await request('/pairing-code');
    expect(response.status).toBe(200);
    const body = JSON.parse(response.text) as { payload: { v: number; serviceId: string; httpsUrl: string; sessionId: string; secret: string }, expiresAt: string };
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(body.payload.v).toBe(1);
    // 缺省发 IP 直连入口（SEL_MOBILE_PAIRING_URL 未设置）。
    expect(body.payload.httpsUrl).toBe('https://8.163.96.197');
    expect(body.payload.sessionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(Buffer.from(body.payload.secret, 'base64url').length).toBe(32);
    expect(JSON.stringify(body)).not.toContain('token');
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('GET /pairing-code 每次生成新会话；旧会话兑换不受影响', async () => {
    const { request, manager } = await setup();
    const first = JSON.parse((await request('/pairing-code')).text) as { payload: { sessionId: string } };
    const second = JSON.parse((await request('/pairing-code')).text) as { payload: { sessionId: string } };
    expect(first.payload.sessionId).not.toBe(second.payload.sessionId);
    const result = await manager.redeem(first.payload, crypto.randomUUID(), 'iPhone');
    expect(result.protocolVersion).toBe(1);
  });

  it('GET /devices 列出设备且不暴露 tokenHash', async () => {
    const { request, manager } = await setup();
    await manager.redeem(manager.createSession().payload, crypto.randomUUID(), 'iPhone 17 Pro');
    const response = await request('/devices');
    expect(response.status).toBe(200);
    const body = JSON.parse(response.text) as { devices: Array<{ deviceId: string; deviceInfo: string; revoked: boolean }> };
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0]).toMatchObject({ deviceInfo: 'iPhone 17 Pro', revoked: false });
    expect(response.text).not.toContain('tokenHash');
    expect(response.text).not.toMatch(/[0-9a-f]{64}/);
  });

  it('POST /devices/:id/revoke 撤销指定设备；未知设备 404；非法 ID 400', async () => {
    const { request, manager } = await setup();
    const result = await manager.redeem(manager.createSession().payload, crypto.randomUUID(), 'iPhone');
    const ok = await request(`/devices/${result.deviceId}/revoke`, { method: 'POST' });
    expect(ok.status).toBe(200);
    const listed = JSON.parse((await request('/devices')).text) as { devices: Array<{ deviceId: string; revoked: boolean }> };
    expect(listed.devices.find(device => device.deviceId === result.deviceId)?.revoked).toBe(true);
    await expect(manager.authenticate(`Bearer ${result.token}`)).rejects.toMatchObject({ code: 'unauthorized' });
    const missing = await request(`/devices/${crypto.randomUUID()}/revoke`, { method: 'POST' });
    expect(missing.status).toBe(404);
    const invalid = await request('/devices/not-a-uuid/revoke', { method: 'POST' });
    expect(invalid.status).toBe(400);
  });

  it('撤销不存在的设备幂等安全：已撤销设备重复撤销返回 200', async () => {
    const { request, manager } = await setup();
    const result = await manager.redeem(manager.createSession().payload, crypto.randomUUID(), 'iPhone');
    await request(`/devices/${result.deviceId}/revoke`, { method: 'POST' });
    const again = await request(`/devices/${result.deviceId}/revoke`, { method: 'POST' });
    expect(again.status).toBe(200);
  });

  it('公网常规方法之外的操作被拒绝：PUT/DELETE 与未知路径 404/405，不暴露堆栈', async () => {
    const { request } = await setup();
    const put = await request('/pairing-code', { method: 'PUT' });
    expect([404, 405]).toContain(put.status);
    const deleted = await request('/devices', { method: 'DELETE' });
    expect([404, 405]).toContain(deleted.status);
    const unknown = await request('/v1/admin/anything');
    expect(unknown.status).toBe(404);
    const body = JSON.parse(unknown.text) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  it('管理响应不含任何令牌或会话秘密字符串', async () => {
    const { request, manager } = await setup();
    const redeemed = await manager.redeem(manager.createSession().payload, crypto.randomUUID(), 'iPhone');
    const pairBody = (await request('/pairing-code')).text;
    const devicesBody = (await request('/devices')).text;
    const all = `${pairBody}${devicesBody}`;
    expect(all).not.toContain(redeemed.token);
    expect(all).not.toContain(crypto.createHash('sha256').update(redeemed.token).digest('hex'));
  });

  it('重复启动在同一 dataDir 上失败：socket 已占用不静默覆盖', async () => {
    const dataDir = await tempDir();
    const manager = await PairingManager.open(dataDir);
    const first = await createAdminServer(manager);
    handles.push(first);
    await expect(createAdminServer(manager)).rejects.toThrow();
  });

  it('关闭后 socket 文件被清理', async () => {
    const dataDir = await tempDir();
    const manager = await PairingManager.open(dataDir);
    const handle = await createAdminServer(manager);
    const socketPath = path.join(dataDir, 'admin.sock');
    await handle.close();
    expect(fs.existsSync(socketPath)).toBe(false);
  });
});
