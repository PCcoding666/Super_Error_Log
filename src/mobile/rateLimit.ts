/**
 * 云端公网入口限流。四档（每分钟窗口）：
 * - 配对失败：每来源 IP 10 次 + 全局 60 次
 * - 鉴权失败：每来源 IP 30 次
 * - 已鉴权查询：每设备 300 次
 * 桶有过期清理与有界容量；429 响应带 Retry-After（秒）。不记录任何秘密。
 */

export interface RateLimiterOptions {
  /** 每分钟窗口次数；默认按计划值。 */
  pairingFailPerIp?: number;
  pairingFailGlobal?: number;
  authFailPerIp?: number;
  authedQueryPerDevice?: number;
  now?: () => number;
}

const MINUTE_MS = 60_000;
/** 桶实例上限：防内存放大（每键一个桶，超限走清扫后仍强制淘汰）。 */
const MAX_BUCKETS = 10_000;

interface Bucket { count: number; resetAt: number }

export class RateLimiter {
  private readonly pairingFailPerIp: number;
  private readonly pairingFailGlobal: number;
  private readonly authFailPerIp: number;
  private readonly authedQueryPerDevice: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket>();
  private globalPairingBucket: Bucket = { count: 0, resetAt: 0 };

  constructor(options: RateLimiterOptions = {}) {
    this.pairingFailPerIp = options.pairingFailPerIp ?? 10;
    this.pairingFailGlobal = options.pairingFailGlobal ?? 60;
    this.authFailPerIp = options.authFailPerIp ?? 30;
    this.authedQueryPerDevice = options.authedQueryPerDevice ?? 300;
    this.now = options.now ?? ((): number => Date.now());
  }

  /** 记录一次配对失败；返回是否仍允许（false = 已超限，应 429）。 */
  pairingFailure(ip: string): { allowed: boolean; retryAfterSeconds: number } {
    this.sweep();
    const globalBlocked = this.bumpGlobalPairing();
    const per = this.bump(`pair:${ip}`, this.pairingFailPerIp);
    const blocked = globalBlocked.blocked || per.blocked;
    return { allowed: !blocked, retryAfterSeconds: Math.max(globalBlocked.retryAfterSeconds, per.retryAfterSeconds) };
  }

  /** 记录一次鉴权失败；返回是否仍允许。 */
  authFailure(ip: string): { allowed: boolean; retryAfterSeconds: number } {
    this.sweep();
    const per = this.bump(`auth:${ip}`, this.authFailPerIp);
    return { allowed: !per.blocked, retryAfterSeconds: per.retryAfterSeconds };
  }

  /** 记录一次已鉴权查询；返回是否仍允许。 */
  authedQuery(deviceId: string): { allowed: boolean; retryAfterSeconds: number } {
    this.sweep();
    const per = this.bump(`query:${deviceId}`, this.authedQueryPerDevice);
    return { allowed: !per.blocked, retryAfterSeconds: per.retryAfterSeconds };
  }

  private bumpGlobalPairing(): { blocked: boolean; retryAfterSeconds: number } {
    if (this.globalPairingBucket.resetAt <= this.now()) this.globalPairingBucket = { count: 0, resetAt: this.now() + MINUTE_MS };
    this.globalPairingBucket.count += 1;
    return this.report(this.globalPairingBucket, this.pairingFailGlobal);
  }

  private bump(key: string, limit: number): { blocked: boolean; retryAfterSeconds: number } {
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= this.now()) {
      bucket = { count: 0, resetAt: this.now() + MINUTE_MS };
      this.buckets.set(key, bucket);
      this.evictIfOverflow();
    }
    bucket.count += 1;
    return this.report(bucket, limit);
  }

  private report(bucket: Bucket, limit: number): { blocked: boolean; retryAfterSeconds: number } {
    if (bucket.count <= limit) return { blocked: false, retryAfterSeconds: 0 };
    return { blocked: true, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - this.now()) / 1000)) };
  }

  private evictIfOverflow(): void {
    if (this.buckets.size <= MAX_BUCKETS) return;
    this.sweep();
    if (this.buckets.size <= MAX_BUCKETS) return;
    // 扫描后仍超限：按过期时间最远优先淘汰到容量内（正常流量不会到达该分支）。
    const entries = [...this.buckets.entries()].sort((a, b) => b[1].resetAt - a[1].resetAt);
    for (const [key] of entries.slice(MAX_BUCKETS - 1)) this.buckets.delete(key);
  }

  private sweep(): void {
    const now = this.now();
    if (this.globalPairingBucket.resetAt <= now) this.globalPairingBucket = { count: 0, resetAt: 0 };
    if (this.buckets.size === 0) return;
    for (const [key, bucket] of this.buckets) if (bucket.resetAt <= now) this.buckets.delete(key);
  }
}

/** 判断 IPv4/IPv6 字面量（信任边界内使用）。 */
export function isValidIp(value: string): boolean {
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) return value.split('.').every(part => Number(part) <= 255);
  return /^[0-9a-fA-F:]+:[0-9a-fA-F:]*$/.test(value) && value.includes(':');
}

/** 云端模式下应用侧的客户端 IP 解析：仅当 cloudProxy 且 peer 为本机时信任 X-Real-IP；否则用直连 peer。 */
export function clientIp(request: { headers: Record<string, string | string[] | undefined>; socket: { remoteAddress?: string } }, cloudProxy: boolean): string {
  const peer = request.socket.remoteAddress ?? '';
  const local = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  if (cloudProxy && local) {
    const header = request.headers['x-real-ip'];
    const value = Array.isArray(header) ? header[0] : header;
    if (typeof value === 'string' && isValidIp(value)) return value;
  }
  return peer || 'unknown';
}
