import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PairingManager } from '../../src/mobile/pairing.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_TTL_MS = 5 * 60 * 1000;
const DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const directories: string[] = [];
afterEach(() => { directories.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })); });

async function tempDir(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-pair-'));
  directories.push(dir);
  return dir;
}

class FakeClock {
  private current = new Date('2026-09-17T08:00:00Z').getTime();
  now = (): Date => new Date(this.current);
  advance(ms: number): void { this.current += ms; }
}

const uuid = () => crypto.randomUUID();

describe('PairingManager sessions and device tokens', () => {
  it('同 clientId 有效期内重取得到完全相同的结果；换 clientId 的重放被拒绝', async () => {
    const manager = await PairingManager.open(await tempDir());
    const { payload } = manager.createSession();
    const clientId = uuid();
    const first = await manager.redeem(payload, clientId, 'iPhone');
    expect(first.deviceId).not.toBe(clientId);
    const again = await manager.redeem(payload, clientId, 'iPhone');
    expect(again).toEqual(first);
    await expect(manager.redeem(payload, uuid(), 'Android')).rejects.toMatchObject({ code: 'pairing_used' });
  });

  it('并行同 clientId 重取返回完全相同结果且只创建一个设备', async () => {
    const manager = await PairingManager.open(await tempDir());
    const { payload } = manager.createSession();
    const clientId = uuid();
    const results = await Promise.all([
      manager.redeem(payload, clientId, 'iPhone'),
      manager.redeem(payload, clientId, 'iPhone'),
      manager.redeem(payload, clientId, 'iPhone'),
    ]);
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(await manager.listDevices()).toHaveLength(1);
  });

  it('并发兑换同一会话时只有一个不同 clientId 胜出', async () => {
    const manager = await PairingManager.open(await tempDir());
    const { payload } = manager.createSession();
    const results = await Promise.allSettled([
      manager.redeem(payload, uuid(), 'iPhone'),
      manager.redeem(payload, uuid(), 'iPhone'),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter(result => result.status === 'rejected') as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: 'pairing_used' });
  });

  it('同一 clientId 在两个不同会话兑换生成两个独立设备，不能覆盖或复活对方凭据', async () => {
    const manager = await PairingManager.open(await tempDir());
    const clientId = uuid();
    const first = await manager.redeem(manager.createSession().payload, clientId, 'iPhone');
    const second = await manager.redeem(manager.createSession().payload, clientId, 'iPhone');
    expect(first.deviceId).not.toBe(second.deviceId);
    expect(first.token).not.toBe(second.token);
    await manager.revoke(first.deviceId);
    await expect(manager.authenticate(`Bearer ${first.token}`)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(manager.authenticate(`Bearer ${second.token}`)).resolves.toMatchObject({ deviceId: second.deviceId });
    const again = await manager.redeem(manager.createSession().payload, clientId, 'iPad');
    expect(again.deviceId).not.toBe(first.deviceId);
  });

  it('serviceId 首次初始化后原子持久化，重开实例保持不变', async () => {
    const dir = await tempDir();
    const first = await PairingManager.open(dir);
    const { payload } = first.createSession();
    const result = await first.redeem(payload, uuid(), 'iPhone');
    const second = await PairingManager.open(dir);
    expect(second.createSession().payload.serviceId).toBe(payload.serviceId);
    expect((await second.listDevices()).map(device => device.deviceId)).toContain(result.deviceId);
    await expect(second.authenticate(`Bearer ${result.token}`)).resolves.toMatchObject({ deviceId: result.deviceId });
  });

  it('过期会话兑换失败；服务重启后恢复失败须重新扫码', async () => {
    const clock = new FakeClock();
    const dir = await tempDir();
    const manager = await PairingManager.open(dir, { now: clock.now });
    const { payload } = manager.createSession();
    clock.advance(SESSION_TTL_MS + 1);
    await expect(manager.redeem(payload, uuid(), 'iPhone')).rejects.toMatchObject({ code: 'pairing_expired' });

    const fresh = await PairingManager.open(dir, { now: clock.now });
    const { payload: second } = fresh.createSession();
    const clientId = uuid();
    const result = await fresh.redeem(second, clientId, 'iPhone');
    const restarted = await PairingManager.open(dir, { now: clock.now });
    await expect(restarted.redeem(second, clientId, 'iPhone')).rejects.toMatchObject({ code: 'pairing_not_found' });
    await expect(restarted.authenticate(`Bearer ${result.token}`)).resolves.toMatchObject({ deviceId: result.deviceId });
  });

  it('已兑换会话过期后，同 clientId/secret 的恢复也被拒绝', async () => {
    const clock = new FakeClock();
    const manager = await PairingManager.open(await tempDir(), { now: clock.now });
    const { payload } = manager.createSession();
    const clientId = uuid();
    await manager.redeem(payload, clientId, 'iPhone');
    clock.advance(SESSION_TTL_MS + 1);
    await expect(manager.redeem(payload, clientId, 'iPhone')).rejects.toMatchObject({ code: 'pairing_expired' });
  });

  it('正确格式但错误 secret 或另一 serviceId 的配对码被拒绝', async () => {
    const manager = await PairingManager.open(await tempDir());
    const { payload } = manager.createSession();
    const wrongSecret = { ...payload, secret: crypto.randomBytes(32).toString('base64url') };
    await expect(manager.redeem(wrongSecret, uuid(), 'iPhone')).rejects.toMatchObject({ code: 'invalid_pairing_payload' });
    const otherService = await PairingManager.open(await tempDir());
    const { payload: other } = otherService.createSession();
    const mixed = { ...other, serviceId: payload.serviceId };
    // 其他服务的会话在本服务不存在；其服务 ID 也不能兑换本服务会话。
    await expect(manager.redeem(mixed, uuid(), 'iPhone')).rejects.toMatchObject({ code: 'pairing_not_found' });
    const swapped = { ...payload, serviceId: other.serviceId };
    await expect(manager.redeem(swapped, uuid(), 'iPhone')).rejects.toMatchObject({ code: 'invalid_pairing_payload' });
  });

  it('撤销后的设备不能通过同会话恢复重新获得授权', async () => {
    const manager = await PairingManager.open(await tempDir());
    const { payload } = manager.createSession();
    const clientId = uuid();
    const result = await manager.redeem(payload, clientId, 'iPhone');
    await manager.revoke(result.deviceId);
    const recovered = await manager.redeem(payload, clientId, 'iPhone');
    expect(recovered.token).toBe(result.token);
    await expect(manager.authenticate(`Bearer ${recovered.token}`)).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('devices.json 中重复 deviceId 或 tokenHash 被拒绝', async () => {
    const dir = await tempDir();
    const manager = await PairingManager.open(dir);
    const result = await manager.redeem(manager.createSession().payload, uuid(), 'iPhone');
    const hash = crypto.createHash('sha256').update(result.token).digest('hex');
    const record = { deviceId: result.deviceId, tokenHash: hash, deviceInfo: 'iPhone', expiresAt: new Date(Date.now() + 60_000).toISOString(), revoked: false, createdAt: new Date().toISOString() };
    for (const devices of [[record, { ...record }], [record, { ...record, deviceId: uuid() }]]) {
      fs.writeFileSync(path.join(dir, 'devices.json'), JSON.stringify({ version: 1, devices }), { mode: 0o600 });
      await expect(PairingManager.open(dir)).rejects.toMatchObject({ code: 'pairing_unavailable' });
    }
  });

  it('service-id 缺失但已有设备记录时不能悄悄更换服务 ID', async () => {
    const dir = await tempDir();
    const manager = await PairingManager.open(dir);
    await manager.redeem(manager.createSession().payload, uuid(), 'iPhone');
    fs.rmSync(path.join(dir, 'service-id'));
    await expect(PairingManager.open(dir)).rejects.toMatchObject({ code: 'pairing_unavailable' });
  });

  it('并发 open 同一空目录得到同一 serviceId', async () => {
    const dir = await tempDir();
    const [first, second] = await Promise.all([PairingManager.open(dir), PairingManager.open(dir)]);
    expect(first.createSession().payload.serviceId).toBe(second.createSession().payload.serviceId);
  });

  it('devices.json 只保存令牌哈希与脱敏记录，不出现明文令牌或会话秘密', async () => {
    const dir = await tempDir();
    const manager = await PairingManager.open(dir);
    const { payload } = manager.createSession();
    const result = await manager.redeem(payload, uuid(), 'iPhone');
    const raw = fs.readFileSync(path.join(dir, 'devices.json'), 'utf8');
    expect(raw).not.toContain(result.token);
    expect(raw).not.toContain(payload.secret);
    expect(raw).toContain(crypto.createHash('sha256').update(result.token).digest('hex'));
    const listed = await manager.listDevices();
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain('tokenHash');
    expect(listed[0]).toMatchObject({ deviceId: result.deviceId, deviceInfo: 'iPhone', revoked: false });
  });

  it('撤销后的设备令牌立即失效且撤销状态落盘', async () => {
    const dir = await tempDir();
    const manager = await PairingManager.open(dir);
    const { payload } = manager.createSession();
    const result = await manager.redeem(payload, uuid(), 'iPhone');
    await manager.revoke(result.deviceId);
    await expect(manager.authenticate(`Bearer ${result.token}`)).rejects.toMatchObject({ code: 'unauthorized' });
    const reopened = await PairingManager.open(dir);
    await expect(reopened.authenticate(`Bearer ${result.token}`)).rejects.toMatchObject({ code: 'unauthorized' });
    expect((await reopened.listDevices()).find(device => device.deviceId === result.deviceId)?.revoked).toBe(true);
  });

  it('令牌 30 天后过期（按服务器时钟判定）', async () => {
    const clock = new FakeClock();
    const manager = await PairingManager.open(await tempDir(), { now: clock.now });
    const { payload } = manager.createSession();
    const result = await manager.redeem(payload, uuid(), 'iPhone');
    clock.advance(DEVICE_TTL_MS - 60_000);
    await expect(manager.authenticate(`Bearer ${result.token}`)).resolves.toMatchObject({ deviceId: result.deviceId });
    clock.advance(120_000);
    await expect(manager.authenticate(`Bearer ${result.token}`)).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('拒绝非法二维码载荷：错误域名、错误版本、非 UUID、短秘密、非法 clientId', async () => {
    const manager = await PairingManager.open(await tempDir());
    const { payload } = manager.createSession();
    const invalid: Array<Record<string, unknown>> = [
      { ...payload, httpsUrl: 'https://evil.example' },
      { ...payload, v: 2 },
      { ...payload, sessionId: 'not-a-uuid' },
      { ...payload, secret: 'short' },
      { ...payload, serviceId: 'not-a-uuid' },
    ];
    for (const candidate of invalid) {
      await expect(manager.redeem(candidate, uuid(), 'iPhone')).rejects.toMatchObject({ code: 'invalid_pairing_payload' });
    }
    await expect(manager.redeem(payload, 'not-a-uuid', 'iPhone')).rejects.toMatchObject({ code: 'invalid_pairing_payload' });
  });

  it('二维码秘密与设备令牌解码后恰好 32 字节', async () => {
    const manager = await PairingManager.open(await tempDir());
    const { payload } = manager.createSession();
    expect(Buffer.from(payload.secret, 'base64url').length).toBe(32);
    const result = await manager.redeem(payload, uuid(), 'iPhone');
    const tokenBytes = Buffer.from(result.token, 'base64url');
    expect(tokenBytes.length).toBe(32);
  });

  it('redeem 返回协议要求的完整字段', async () => {
    const clock = new FakeClock();
    const manager = await PairingManager.open(await tempDir(), { now: clock.now });
    const { payload } = manager.createSession();
    const result = await manager.redeem(payload, uuid(), 'iPhone');
    expect(result).toMatchObject({ serviceId: payload.serviceId, protocolVersion: 1 });
    expect(UUID.test(result.deviceId)).toBe(true);
    expect(new Date(result.expiresAt).getTime()).toBe(clock.now().getTime() + DEVICE_TTL_MS);
  });

  it('目录与文件权限为 0700/0600', async () => {
    const dir = await tempDir();
    const manager = await PairingManager.open(dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, 'service-id')).mode & 0o777).toBe(0o600);
    manager.createSession();
    const result = await manager.redeem(manager.createSession().payload, uuid(), 'iPhone');
    expect(fs.statSync(path.join(dir, 'devices.json')).mode & 0o777).toBe(0o600);
    expect(result.token.length).toBeGreaterThan(0);
  });

  it('令牌落盘失败时不发令牌、不产生新设备；恢复后同会话同 clientId 可正常兑换', async () => {
    const dir = await tempDir();
    const manager = await PairingManager.open(dir);
    const { payload } = manager.createSession();
    const clientId = uuid();
    fs.rmSync(path.join(dir, 'devices.json'), { force: true });
    fs.chmodSync(dir, 0o500);
    try {
      await expect(manager.redeem(payload, clientId, 'iPhone')).rejects.toMatchObject({ code: 'pairing_unavailable' });
      expect(await manager.listDevices()).toHaveLength(0);
    } finally { fs.chmodSync(dir, 0o700); }
    const result = await manager.redeem(payload, clientId, 'iPhone');
    expect(UUID.test(result.deviceId)).toBe(true);
    await expect(manager.authenticate(`Bearer ${result.token}`)).resolves.toMatchObject({ deviceId: result.deviceId });
  });

  it('devices.json 损坏或结构非法时 fail closed，不重置既有设备记录', async () => {
    const dir = await tempDir();
    const manager = await PairingManager.open(dir);
    const result = await manager.redeem(manager.createSession().payload, uuid(), 'iPhone');
    for (const corrupt of ['{ broken json', '{"version":1,"devices":"not-an-array"}', '{"version":2,"devices":[]}']) {
      fs.writeFileSync(path.join(dir, 'devices.json'), corrupt, { mode: 0o600 });
      await expect(PairingManager.open(dir)).rejects.toMatchObject({ code: 'pairing_unavailable' });
    }
    fs.writeFileSync(path.join(dir, 'devices.json'), JSON.stringify({ version: 1, devices: [{ deviceId: result.deviceId, tokenHash: crypto.createHash('sha256').update(result.token).digest('hex'), deviceInfo: 'iPhone', expiresAt: new Date(Date.now() + 60_000).toISOString(), revoked: false, createdAt: new Date().toISOString() }] }), { mode: 0o600 });
    const reopened = await PairingManager.open(dir);
    await expect(reopened.authenticate(`Bearer ${result.token}`)).resolves.toMatchObject({ deviceId: result.deviceId });
  });
});
