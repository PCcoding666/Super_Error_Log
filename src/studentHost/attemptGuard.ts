/**
 * 登录 / 注册的失败限速（2026-10-22，P0-6）。
 *
 * 以前按出口 IP 计数，且注册成功也计数：一个班在同一个 Wi-Fi 下第 11 个人就被挡 10 分钟，
 * 有人输错 10 次码，全班正确的码也进不去。现在：
 * - 主键是「码」：按输入的码的第一组（前 4 位）计失败次数。同学之间的码几乎不会撞同一组，
 *   一个人反复输错只会挡住同一组开头的码。
 * - 成功不计数；成功后清掉该码的失败记录。
 * - 同一 IP 只有一个很宽的上限（防一台机器乱刷），远高于一个班的正常输错量。
 * - 全站再加一个总预算：失败总数（防大规模猜码），以及注册成功总数（防刷满名额）。
 * 码本身有 40–60 bit 随机性，限速主要用来挡噪声和滥用，不是唯一的安全措施。
 */

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
}

export const LOGIN_LIMITS: AttemptGuardLimits = { windowMs: 600_000, perCode: 10, perIp: 100, globalFailures: 1000, globalSuccesses: 0 };
export const REGISTRATION_LIMITS: AttemptGuardLimits = { windowMs: 600_000, perCode: 20, perIp: 100, globalFailures: 1000, globalSuccesses: 200 };

export type AttemptBlock = { seconds: number; scope: 'code' | 'ip' | 'global' } | null;

/** 输入码 → 限速用的主键：规范化后取前 4 位；格式不对的输入按 IP 单独记（不会影响任何真实码）。 */
export function codeKey(input: string, ip: string): string {
  const cleaned = (typeof input === 'string' ? input : '').toUpperCase().replace(/[\s-]+/g, '').slice(0, 40);
  if (cleaned.length < 4 || !/^[0-9A-Z]+$/.test(cleaned)) return `malformed:${ip}`;
  return `code:${cleaned.slice(0, 4)}`;
}

export class AttemptGuard {
  private readonly perCode: SlidingWindowCounter;
  private readonly perIp: SlidingWindowCounter;
  private readonly failures: SlidingWindowCounter;
  private readonly successes: SlidingWindowCounter | null;
  private calls = 0;

  constructor(readonly limits: AttemptGuardLimits, now: () => number = () => Date.now()) {
    this.perCode = new SlidingWindowCounter(now, limits.perCode, limits.windowMs);
    this.perIp = new SlidingWindowCounter(now, limits.perIp, limits.windowMs);
    this.failures = new SlidingWindowCounter(now, limits.globalFailures, limits.windowMs);
    this.successes = limits.globalSuccesses > 0 ? new SlidingWindowCounter(now, limits.globalSuccesses, limits.windowMs) : null;
  }

  /** 这次尝试是否要先挡下（挡下时不检查码，防探测）。 */
  blocked(key: string, ip: string): AttemptBlock {
    if ((this.calls += 1) % 500 === 0) { this.perCode.sweep(); this.perIp.sweep(); }
    const global = Math.max(this.failures.blockedSeconds('all'), this.successes?.blockedSeconds('all') ?? 0);
    if (global > 0) return { seconds: global, scope: 'global' };
    const byCode = this.perCode.blockedSeconds(key);
    if (byCode > 0) return { seconds: byCode, scope: 'code' };
    const byIp = this.perIp.blockedSeconds(ip);
    if (byIp > 0) return { seconds: byIp, scope: 'ip' };
    return null;
  }

  failure(key: string, ip: string): void {
    this.perCode.record(key);
    this.perIp.record(ip);
    this.failures.record('all');
  }

  success(key: string): void {
    this.perCode.clear(key);
    this.successes?.record('all');
  }
}
