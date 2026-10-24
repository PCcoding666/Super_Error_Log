/**
 * 登录 / 注册 / 找回的失败限速（2026-10-22，P0-6；2026-10-24 按集成评审改为登录、注册「先验码」）。
 *
 * 以前按出口 IP 计数，且注册成功也计数：一个班在同一个 Wi-Fi 下第 11 个人就被挡 10 分钟，
 * 有人输错 10 次码，全班正确的码也进不去。现在：
 * - 登录和注册**先验码，再看预算**：正确的邀请码（以及正确的注册码）任何时候都能用，不受码键、IP、
 *   全站失败预算影响。预算只决定「错的那一次」怎么回应：超了回 429（说清楚是谁输错太多），预算已用完时
 *   网关再把错误回应放慢一点。这样几个 IP 刷满全站预算，也只能拖慢错误尝试，挡不住任何人。
 * - 找回不一样：找回码只有 4 位数字，必须**先看预算再比对**，否则超出预算的尝试照样被比对，按 IP 限速就没用了。
 *   每个账号另有落库的 5 次锁定（见 registry.recoverInvitation）。
 * - 登录的码键：输入的码的第一组（前 4 位）。注册的码键：整条注册码的哈希 + IP（全班共用一个注册码，
 *   有人打错后几位不会落到正确码的键上）。
 * - 成功不计数；成功后清掉该码键的失败记录。
 * - 同一 IP 只有一个很宽的失败上限，全站再加一个失败总预算。注册另有成功上限（全站总数、同一 IP 每小时），
 *   在注册**之前**检查，防止刷满名额；同一 IP 每小时的上限仍够一个班在同一个 Wi-Fi 下一起注册。
 * 码本身有 40–60 bit 随机性，限速主要用来挡噪声和滥用，不是唯一的安全措施。
 */
import crypto from 'node:crypto';

/** 滑动窗口计数器：key → 最近 windowMs 内的时间戳。 */
export class SlidingWindowCounter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly now: () => number, private readonly limit: number, private readonly windowMs: number) {}

  private recent(key: string): number[] {
    const list = (this.hits.get(key) ?? []).filter(at => this.now() - at < this.windowMs);
    if (list.length === 0) this.hits.delete(key); else this.hits.set(key, list);
    return list;
  }

  /** 已超限返回剩余秒数；否则 0。 */
  blockedSeconds(key: string): number {
    const list = this.recent(key);
    if (list.length < this.limit) return 0;
    return Math.max(1, Math.ceil((list[list.length - this.limit]! + this.windowMs - this.now()) / 1000));
  }

  record(key: string): void {
    const list = this.recent(key);
    list.push(this.now());
    // 只需要保留最近 limit 条就能判断是否超限，防止内存随攻击增长。
    this.hits.set(key, list.slice(-this.limit));
  }

  clear(key: string): void {
    this.hits.delete(key);
  }

  /** 防止长时间运行后 key 无限增长：清掉窗口外的空 key。 */
  sweep(): void {
    for (const key of [...this.hits.keys()]) this.recent(key);
  }
}

export interface AttemptGuardLimits {
  windowMs: number;
  /** 同一个码（前 4 位）的失败上限。 */
  perCode: number;
  /** 同一个 IP 的失败上限（很宽，只防单机乱刷）。 */
  perIp: number;
  /** 全站失败总预算。 */
  globalFailures: number;
  /** 全站成功总预算（只对注册有意义；0 = 不限）。 */
  globalSuccesses: number;
  /** 同一个 IP 的成功上限（只对注册有意义；不设 = 不限）。窗口单独设，通常比失败窗口长。 */
  perIpSuccess?: { limit: number; windowMs: number };
}

export const LOGIN_LIMITS: AttemptGuardLimits = { windowMs: 600_000, perCode: 10, perIp: 100, globalFailures: 1000, globalSuccesses: 0 };
export const REGISTRATION_LIMITS: AttemptGuardLimits = { windowMs: 600_000, perCode: 20, perIp: 100, globalFailures: 1000, globalSuccesses: 200, perIpSuccess: { limit: 60, windowMs: 3_600_000 } };
/** 自助找回：按 IP 计失败（每个账号另有落库的 5 次锁定，见 registry.recoverInvitation）。 */
export const RECOVERY_LIMITS: AttemptGuardLimits = { windowMs: 600_000, perCode: 20, perIp: 30, globalFailures: 300, globalSuccesses: 0 };

export type AttemptBlock = { seconds: number; scope: 'code' | 'ip' | 'ip_success' | 'global' } | null;

function cleanCode(input: string): string {
  return (typeof input === 'string' ? input : '').toUpperCase().replace(/[\s-]+/g, '').slice(0, 40);
}

/** 登录码 → 限速用的主键：规范化后取前 4 位；格式不对的输入按 IP 单独记（不会影响任何真实码）。 */
export function codeKey(input: string, ip: string): string {
  const cleaned = cleanCode(input);
  if (cleaned.length < 4 || !/^[0-9A-Z]+$/.test(cleaned)) return `malformed:${ip}`;
  return `code:${cleaned.slice(0, 4)}`;
}

/**
 * 注册码 → 限速用的主键：整条注册码（规范化后）的哈希 + IP。
 * 全班共用一个注册码：有人打错后几位，只会计到「这条错码 + 这个网络」上，不会落到正确注册码的键上。
 * 不要注册码（缺省）或格式不对的输入按 IP 单独记。
 */
export function registrationKey(input: string, ip: string): string {
  const cleaned = cleanCode(input);
  if (cleaned.length < 4 || !/^[0-9A-Z]+$/.test(cleaned)) return `malformed:${ip}`;
  return `reg:${crypto.createHash('sha256').update(cleaned).digest('hex').slice(0, 32)}:${ip}`;
}

export class AttemptGuard {
  private readonly perCode: SlidingWindowCounter;
  private readonly perIp: SlidingWindowCounter;
  private readonly failures: SlidingWindowCounter;
  private readonly successes: SlidingWindowCounter | null;
  private readonly ipSuccesses: SlidingWindowCounter | null;
  private calls = 0;

  constructor(readonly limits: AttemptGuardLimits, now: () => number = () => Date.now()) {
    this.perCode = new SlidingWindowCounter(now, limits.perCode, limits.windowMs);
    this.perIp = new SlidingWindowCounter(now, limits.perIp, limits.windowMs);
    this.failures = new SlidingWindowCounter(now, limits.globalFailures, limits.windowMs);
    this.successes = limits.globalSuccesses > 0 ? new SlidingWindowCounter(now, limits.globalSuccesses, limits.windowMs) : null;
    this.ipSuccesses = limits.perIpSuccess ? new SlidingWindowCounter(now, limits.perIpSuccess.limit, limits.perIpSuccess.windowMs) : null;
  }

  /**
   * 预算是否已用完（全站、码键、IP）。登录和注册**先验码**，只用它决定一次失败怎么回应；
   * 找回在比对之前用它挡（见文件头）。注册的成功上限另由 successCapped() 在注册前检查。
   */
  blocked(key: string, ip: string): AttemptBlock {
    if ((this.calls += 1) % 500 === 0) { this.perCode.sweep(); this.perIp.sweep(); this.ipSuccesses?.sweep(); }
    const global = Math.max(this.failures.blockedSeconds('all'), this.successes?.blockedSeconds('all') ?? 0);
    if (global > 0) return { seconds: global, scope: 'global' };
    const byCode = this.perCode.blockedSeconds(key);
    if (byCode > 0) return { seconds: byCode, scope: 'code' };
    const byIp = this.perIp.blockedSeconds(ip);
    if (byIp > 0) return { seconds: byIp, scope: 'ip' };
    const byIpSuccess = this.ipSuccesses?.blockedSeconds(ip) ?? 0;
    if (byIpSuccess > 0) return { seconds: byIpSuccess, scope: 'ip_success' };
    return null;
  }

  failure(key: string, ip: string): void {
    this.perCode.record(key);
    this.perIp.record(ip);
    this.failures.record('all');
  }

  /** 注册的成功上限（全站总数、同一 IP 每小时）：超了就在注册**之前**挡下，防止刷满名额。登录、找回没有这个上限。 */
  successCapped(ip: string): AttemptBlock {
    const global = this.successes?.blockedSeconds('all') ?? 0;
    if (global > 0) return { seconds: global, scope: 'global' };
    const byIp = this.ipSuccesses?.blockedSeconds(ip) ?? 0;
    return byIp > 0 ? { seconds: byIp, scope: 'ip_success' } : null;
  }

  success(key: string, ip: string): void {
    this.perCode.clear(key);
    this.successes?.record('all');
    this.ipSuccesses?.record(ip);
  }
}
