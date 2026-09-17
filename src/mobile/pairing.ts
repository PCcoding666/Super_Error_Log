import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PAIRING_PROTOCOL_VERSION = 1 as const;
const CLOUD_URL = 'https://study.pccoding666.com';
const SESSION_TTL_MS = 5 * 60 * 1000;
const DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface PairingCodePayload {
  v: 1;
  serviceId: string;
  httpsUrl: 'https://study.pccoding666.com';
  sessionId: string;
  secret: string;
}

export interface RedeemResult {
  token: string;
  deviceId: string;
  serviceId: string;
  expiresAt: string;
  protocolVersion: 1;
}

export interface DeviceTokenRecord {
  deviceId: string;
  tokenHash: string;
  deviceInfo: string;
  expiresAt: string;
  revoked: boolean;
  createdAt: string;
}

export interface PairingManagerOptions { now?: () => Date }

export class PairingError extends Error {
  constructor(public readonly code: 'invalid_pairing_payload' | 'pairing_expired' | 'pairing_used' | 'pairing_not_found' | 'pairing_unavailable' | 'unauthorized', message: string) {
    super(message); this.name = 'PairingError';
  }
}

interface SessionState {
  payload: PairingCodePayload;
  expiresAt: Date;
  redeemed: { clientId: string; result: RedeemResult } | null;
}

interface DeviceFile { version: 1; devices: DeviceTokenRecord[] }

async function durableWrite(filename: string, bytes: string): Promise<void> {
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await fs.promises.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await fs.promises.rename(temporary, filename);
    await fs.promises.chmod(filename, 0o600);
    const directory = await fs.promises.open(path.dirname(filename), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await fs.promises.rm(temporary, { force: true });
    throw error;
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function validPayload(value: unknown): value is PairingCodePayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Record<string, unknown>;
  return payload.v === 1 && payload.httpsUrl === CLOUD_URL
    && isUuid(payload.serviceId) && isUuid(payload.sessionId)
    && typeof payload.secret === 'string' && Buffer.from(payload.secret, 'base64url').length === 32;
}

function parseDeviceFile(raw: string): DeviceTokenRecord[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new PairingError('pairing_unavailable', '设备记录无法读取。'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new PairingError('pairing_unavailable', '设备记录结构不合法。');
  const file = parsed as Record<string, unknown>;
  if (file.version !== 1 || !Array.isArray(file.devices)) throw new PairingError('pairing_unavailable', '设备记录结构不合法。');
  const devices: DeviceTokenRecord[] = [];
  const seenIds = new Set<string>();
  const seenHashes = new Set<string>();
  for (const entry of file.devices) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new PairingError('pairing_unavailable', '设备记录不合法。');
    const record = entry as Record<string, unknown>;
    if (!isUuid(record.deviceId) || typeof record.tokenHash !== 'string' || !SHA256_HEX.test(record.tokenHash)
      || typeof record.deviceInfo !== 'string' || typeof record.expiresAt !== 'string' || Number.isNaN(Date.parse(record.expiresAt))
      || typeof record.revoked !== 'boolean' || typeof record.createdAt !== 'string' || Number.isNaN(Date.parse(record.createdAt))) {
      throw new PairingError('pairing_unavailable', '设备记录不合法。');
    }
    if (seenIds.has(record.deviceId) || seenHashes.has(record.tokenHash)) throw new PairingError('pairing_unavailable', '设备记录存在重复标识。');
    seenIds.add(record.deviceId); seenHashes.add(record.tokenHash);
    devices.push({ deviceId: record.deviceId, tokenHash: record.tokenHash, deviceInfo: record.deviceInfo, expiresAt: record.expiresAt, revoked: record.revoked, createdAt: record.createdAt });
  }
  return devices;
}

async function createOrLoadServiceId(dataDir: string): Promise<string> {
  const filename = path.join(dataDir, 'service-id');
  const candidate = crypto.randomUUID();
  try {
    // 独占创建：并发 open 只有一方写入，其余读取同一 ID。
    const handle = await fs.promises.open(filename, 'wx', 0o600);
    try { await handle.writeFile(candidate); await handle.sync(); } finally { await handle.close(); }
    await fs.promises.chmod(filename, 0o600);
    return candidate;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  // 胜者写入前存在空文件窗口：读空或非法时做有界退避重试，避免把创建中误判为损坏。
  // 若进程恰在写入前被杀留下永久空文件，同样经重试后 fail closed（需人工处置，不悄悄换 ID）。
  for (let attempt = 0; ; attempt += 1) {
    const raw = (await fs.promises.readFile(filename, 'utf8')).trim();
    await fs.promises.chmod(filename, 0o600);
    if (isUuid(raw)) return raw;
    if (attempt >= 20) throw new PairingError('pairing_unavailable', '服务 ID 记录无法读取。');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

export class PairingManager {
  private readonly sessions = new Map<string, SessionState>();
  private readonly devices = new Map<string, DeviceTokenRecord>();
  private mutation: Promise<void> = Promise.resolve();
  private redeemChain: Promise<void> = Promise.resolve();
  private readonly now: () => Date;

  private constructor(readonly dataDir: string, readonly serviceId: string, options?: PairingManagerOptions) {
    this.now = options?.now ?? ((): Date => new Date());
  }

  static async open(dataDir: string, options?: PairingManagerOptions): Promise<PairingManager> {
    const resolved = path.resolve(dataDir);
    await fs.promises.mkdir(resolved, { recursive: true, mode: 0o700 });
    await fs.promises.chmod(resolved, 0o700);
    const devicesPath = path.join(resolved, 'devices.json');
    const hasDevices = fs.existsSync(devicesPath);
    const serviceIdPath = path.join(resolved, 'service-id');
    if (hasDevices && !fs.existsSync(serviceIdPath)) throw new PairingError('pairing_unavailable', '服务 ID 记录缺失，拒绝初始化。');
    const serviceId = await createOrLoadServiceId(resolved);
    const devices = hasDevices ? parseDeviceFile(await fs.promises.readFile(devicesPath, 'utf8')) : [];
    await fs.promises.chmod(devicesPath, 0o600).catch(() => undefined);
    const manager = new PairingManager(resolved, serviceId, options);
    for (const device of devices) manager.devices.set(device.deviceId, device);
    return manager;
  }

  createSession(): { payload: PairingCodePayload; expiresAt: Date } {
    const expiresAt = new Date(this.now().getTime() + SESSION_TTL_MS);
    const payload: PairingCodePayload = {
      v: 1, serviceId: this.serviceId, httpsUrl: CLOUD_URL,
      sessionId: crypto.randomUUID(), secret: crypto.randomBytes(32).toString('base64url'),
    };
    this.sessions.set(payload.sessionId, { payload, expiresAt, redeemed: null });
    return { payload, expiresAt };
  }

  async redeem(input: unknown, clientId: string, deviceInfo: string): Promise<RedeemResult> {
    // 整个兑换流程串行执行，保证并发兑换只有一个 clientId 胜出、同 clientId 重取幂等。
    const previous = this.redeemChain;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    this.redeemChain = gate;
    await previous;
    try { return await this.redeemSerialized(input, clientId, deviceInfo); }
    finally { release(); }
  }

  private async redeemSerialized(input: unknown, clientId: string, deviceInfo: string): Promise<RedeemResult> {
    if (!validPayload(input) || !isUuid(clientId)) throw new PairingError('invalid_pairing_payload', '配对码或客户端标识不合法。');
    if (typeof deviceInfo !== 'string' || deviceInfo.length > 200) throw new PairingError('invalid_pairing_payload', '设备信息不合法。');
    const payload = input;
    const session = this.sessions.get(payload.sessionId);
    if (!session) throw new PairingError('pairing_not_found', '配对会话不存在或已失效，请重新扫码。');
    if (session.payload.secret !== payload.secret || session.payload.serviceId !== payload.serviceId) {
      throw new PairingError('invalid_pairing_payload', '配对码内容与服务会话不符。');
    }
    // 过期检查先于恢复：已兑换会话过期后同样拒绝，内存秘密随会话一并丢弃。
    if (this.now().getTime() >= session.expiresAt.getTime()) {
      this.sessions.delete(payload.sessionId);
      throw new PairingError('pairing_expired', '配对码已过期，请重新扫码。');
    }
    if (session.redeemed) {
      if (session.redeemed.clientId === clientId) return structuredClone(session.redeemed.result);
      throw new PairingError('pairing_used', '配对码已被其他设备使用。');
    }
    // 持久化候选状态成功后才发布到内存；失败时会话保持未兑换，可重试。
    const token = crypto.randomBytes(32).toString('base64url');
    const deviceId = crypto.randomUUID();
    const createdAt = this.now();
    const record: DeviceTokenRecord = {
      deviceId, tokenHash: crypto.createHash('sha256').update(token).digest('hex'), deviceInfo,
      expiresAt: new Date(createdAt.getTime() + DEVICE_TTL_MS).toISOString(), revoked: false, createdAt: createdAt.toISOString(),
    };
    const result: RedeemResult = { token, deviceId, serviceId: this.serviceId, expiresAt: record.expiresAt, protocolVersion: PAIRING_PROTOCOL_VERSION };
    await this.persist(next => { next.set(deviceId, record); });
    session.redeemed = { clientId, result };
    return structuredClone(result);
  }

  async authenticate(header: string | undefined): Promise<{ deviceId: string }> {
    if (!header?.startsWith('Bearer ')) throw new PairingError('unauthorized', '设备令牌无效。');
    const token = header.slice(7);
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const expected = Buffer.from(hash);
    for (const device of this.devices.values()) {
      const actual = Buffer.from(device.tokenHash);
      if (actual.length === expected.length && crypto.timingSafeEqual(actual, expected)) {
        if (device.revoked || this.now().getTime() >= Date.parse(device.expiresAt)) throw new PairingError('unauthorized', '设备令牌已失效，请重新配对。');
        return { deviceId: device.deviceId };
      }
    }
    throw new PairingError('unauthorized', '设备令牌无效。');
  }

  async revoke(deviceId: string): Promise<void> {
    if (!isUuid(deviceId)) throw new PairingError('invalid_pairing_payload', '设备标识不合法。');
    if (!this.devices.has(deviceId)) throw new PairingError('pairing_not_found', '设备不存在。');
    await this.persist(next => {
      const record = next.get(deviceId);
      if (record) next.set(deviceId, { ...record, revoked: true });
    });
  }

  async listDevices(): Promise<Array<Omit<DeviceTokenRecord, 'tokenHash'>>> {
    return [...this.devices.values()].map(({ tokenHash: _tokenHash, ...rest }) => structuredClone(rest));
  }

  private async persist(update: (candidate: Map<string, DeviceTokenRecord>) => void): Promise<void> {
    const previous = this.mutation;
    let release!: () => void;
    this.mutation = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      // 在副本上应用候选状态；只有落盘成功才发布到内存。
      const candidate = new Map(structuredClone([...this.devices]));
      update(candidate);
      const file: DeviceFile = { version: 1, devices: [...candidate.values()] };
      await durableWrite(path.join(this.dataDir, 'devices.json'), JSON.stringify(file, null, 2));
      this.devices.clear();
      for (const [id, record] of candidate) this.devices.set(id, record);
    } catch {
      throw new PairingError('pairing_unavailable', '配对数据暂时无法保存。');
    } finally { release(); }
  }
}
