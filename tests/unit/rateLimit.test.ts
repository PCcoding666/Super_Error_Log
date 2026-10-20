import { describe, expect, it } from 'vitest';
import { RateLimiter, isValidIp, clientIp } from '../../src/mobile/rateLimit.js';

describe('RateLimiter', () => {
  it('配对失败：每 IP 10/分钟内允许，第 11 次拒绝并给出 Retry-After', () => {
    let clock = 0;
    const limiter = new RateLimiter({ now: () => clock });
    for (let index = 0; index < 10; index += 1) expect(limiter.pairingFailure('1.2.3.4').allowed).toBe(true);
    const blocked = limiter.pairingFailure('1.2.3.4');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
    // 其他 IP 不受该桶影响。
    expect(limiter.pairingFailure('5.6.7.8').allowed).toBe(true);
  });

  it('配对失败全局 60/分钟：即使分散来源也会拒绝', () => {
    let clock = 0;
    const limiter = new RateLimiter({ now: () => clock });
    let last = { allowed: true, retryAfterSeconds: 0 };
    for (let index = 0; index < 61; index += 1) last = limiter.pairingFailure(`10.0.${index / 250 | 0}.${index % 250}`);
    expect(last.allowed).toBe(false);
  });

  it('鉴权失败每 IP 30/分钟；已鉴权查询每设备 300/分钟', () => {
    let clock = 0;
    const limiter = new RateLimiter({ now: () => clock });
    for (let index = 0; index < 30; index += 1) expect(limiter.authFailure('1.1.1.1').allowed).toBe(true);
    expect(limiter.authFailure('1.1.1.1').allowed).toBe(false);
    for (let index = 0; index < 300; index += 1) expect(limiter.authedQuery('device-1').allowed).toBe(true);
    expect(limiter.authedQuery('device-1').allowed).toBe(false);
    expect(limiter.authedQuery('device-2').allowed).toBe(true);
  });

  it('照片上传每设备 30/分钟，与语音转写额度分开', () => {
    let clock = 0;
    const limiter = new RateLimiter({ now: () => clock });
    for (let index = 0; index < 30; index += 1) expect(limiter.upload('device-1').allowed).toBe(true);
    const blocked = limiter.upload('device-1');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(limiter.upload('device-2').allowed).toBe(true);
    expect(limiter.transcribe('device-1').allowed).toBe(true);
    const tight = new RateLimiter({ uploadPerDevice: 1, now: () => clock });
    expect(tight.upload('device-1').allowed).toBe(true);
    expect(tight.upload('device-1').allowed).toBe(false);
  });

  it('分钟窗口滚动后桶重置', () => {
    let clock = 0;
    const limiter = new RateLimiter({ now: () => clock });
    for (let index = 0; index < 31; index += 1) limiter.authFailure('2.2.2.2');
    expect(limiter.authFailure('2.2.2.2').allowed).toBe(false);
    clock = 61_000;
    expect(limiter.authFailure('2.2.2.2').allowed).toBe(true);
  });

  it('过期桶被清扫，不无限累积', () => {
    let clock = 0;
    const limiter = new RateLimiter({ now: () => clock });
    for (let index = 0; index < 5_000; index += 1) limiter.authFailure(`${index}.0.0.1`);
    expect((limiter as unknown as { buckets: Map<string, unknown> }).buckets.size).toBeLessThanOrEqual(10_000);
    clock = 120_000;
    limiter.authFailure('3.3.3.3');
    expect((limiter as unknown as { buckets: Map<string, unknown> }).buckets.size).toBe(1);
  });
});

describe('clientIp trust boundary', () => {
  const localSocket = { remoteAddress: '127.0.0.1' };
  const remoteSocket = { remoteAddress: '203.0.113.9' };
  it('cloudProxy 关闭：忽略一切转发头，按直连 peer 计数', () => {
    expect(clientIp({ headers: { 'x-real-ip': '6.6.6.6' }, socket: localSocket }, false)).toBe('127.0.0.1');
    expect(clientIp({ headers: { 'x-real-ip': '6.6.6.6' }, socket: remoteSocket }, false)).toBe('203.0.113.9');
  });
  it('cloudProxy 开启且 peer 为本机：信任 X-Real-IP', () => {
    expect(clientIp({ headers: { 'x-real-ip': '6.6.6.6' }, socket: localSocket }, true)).toBe('6.6.6.6');
    // ::1 / ::ffff:127.0.0.1 同样视为本机。
    expect(clientIp({ headers: { 'x-real-ip': '6.6.6.6' }, socket: { remoteAddress: '::1' } }, true)).toBe('6.6.6.6');
  });
  it('cloudProxy 开启但 peer 非本机：忽略头（防外部直连伪造）', () => {
    expect(clientIp({ headers: { 'x-real-ip': '6.6.6.6' }, socket: remoteSocket }, true)).toBe('203.0.113.9');
  });
  it('头值非法或缺失：回退直连 peer', () => {
    expect(clientIp({ headers: {}, socket: localSocket }, true)).toBe('127.0.0.1');
    expect(clientIp({ headers: { 'x-real-ip': 'not-an-ip' }, socket: localSocket }, true)).toBe('127.0.0.1');
    expect(clientIp({ headers: { 'x-real-ip': ['7.7.7.7', '8.8.8.8'] }, socket: localSocket }, true)).toBe('7.7.7.7');
  });
});

describe('isValidIp', () => {
  it('接受合法 IPv4 与 IPv6，拒绝非法值', () => {
    expect(isValidIp('1.2.3.4')).toBe(true);
    expect(isValidIp('256.1.1.1')).toBe(false);
    expect(isValidIp('::1')).toBe(true);
    expect(isValidIp('2001:db8::1')).toBe(true);
    expect(isValidIp('not-an-ip')).toBe(false);
    expect(isValidIp('')).toBe(false);
  });
});
