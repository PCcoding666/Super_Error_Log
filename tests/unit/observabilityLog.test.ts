/**
 * 结构化日志的几个纯函数：一行一条 JSON、字段截短、请求 ID 的形状、User-Agent 压成家族、错误摘要。
 * 不连服务器、不写文件。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { errorSummary, logEvent, newRequestId, requestIdOf, setLogSink, uaFamily } from '../../src/observability/log.js';

afterEach(() => setLogSink(null));

describe('logEvent', () => {
  it('写一行 JSON：event / level / at 在前，undefined 字段丢掉，长字符串截到 500 字', () => {
    const lines: string[] = [];
    setLogSink(line => lines.push(line));
    logEvent('sel_http', 'info', { rid: 'abc', status: 200, student: undefined, long: 'x'.repeat(900), flag: true, none: null });
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(Object.keys(record).slice(0, 3)).toEqual(['event', 'level', 'at']);
    expect(record.event).toBe('sel_http');
    expect(record.level).toBe('info');
    expect(typeof record.at).toBe('string');
    expect(record).not.toHaveProperty('student');
    expect(record.flag).toBe(true);
    expect(record.none).toBeNull();
    expect((record.long as string).length).toBe(501);
    expect(lines[0]).not.toContain('\n');
  });

  it('字段里不能覆盖 event / level / at', () => {
    const lines: string[] = [];
    setLogSink(line => lines.push(line));
    logEvent('sel_login', 'warn', { event: 'fake', level: 'info', at: 'yesterday', outcome: 'invalid_code' } as Record<string, string>);
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(record.event).toBe('sel_login');
    expect(record.level).toBe('warn');
    expect(record.at).not.toBe('yesterday');
  });
});

describe('请求 ID', () => {
  it('12 位小写字母数字，不含易混的 0/o/1/l/i；每次不同', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newRequestId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[abcdefghjkmnpqrstuvwxyz23456789]{12}$/);
  });

  it('只认自己生成的形状；别的一律当没有', () => {
    expect(requestIdOf(newRequestId())).toMatch(/^[a-z0-9]{12}$/);
    expect(requestIdOf('abcdefgh')).toBe('abcdefgh');
    expect(requestIdOf('ABCDEFGHJKLM')).toBeNull();
    expect(requestIdOf('short')).toBeNull();
    expect(requestIdOf('a'.repeat(33))).toBeNull();
    expect(requestIdOf(['abcdefghjkmn'])).toBeNull();
    expect(requestIdOf(undefined)).toBeNull();
    expect(requestIdOf('abc def ghij')).toBeNull();
  });
});

describe('uaFamily', () => {
  const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  it('只压成几个家族，原始 UA 不出现在结果里', () => {
    expect(uaFamily(IPHONE_SAFARI)).toBe('ios-safari');
    expect(uaFamily('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148')).toBe('ios-webview');
    expect(uaFamily(`${IPHONE_SAFARI} MicroMessenger/8.0.50`)).toBe('wechat');
    expect(uaFamily('Mozilla/5.0 (Linux; Android 14; 23013RK75C) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36')).toBe('android-chrome');
    expect(uaFamily('Mozilla/5.0 (Linux; Android 14; 23013RK75C Build/UKQ1; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.0.0 Mobile Safari/537.36')).toBe('android-webview');
    expect(uaFamily('Mozilla/5.0 (Linux; U; Android 14; zh-cn; 23013RK75C) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/118.0.0.0 MiuiBrowser/18.4 Mobile Safari/537.36 XiaoMi/MiuiBrowser/18.4')).toBe('android-other');
    expect(uaFamily('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36')).toBe('desktop');
    expect(uaFamily('curl/8.4.0')).toBe('other');
    expect(uaFamily(undefined)).toBe('none');
    expect(uaFamily([IPHONE_SAFARI])).toBe('ios-safari');
  });
});

describe('errorSummary', () => {
  it('Error：类名、截短的消息、最多三帧只有位置的栈', () => {
    const error = new TypeError('x'.repeat(400));
    const summary = errorSummary(error);
    expect(summary.errName).toBe('TypeError');
    expect(summary.errMessage).toHaveLength(300);
    expect(summary.errStack).toBeDefined();
    expect(summary.errStack!.split(' | ').length).toBeLessThanOrEqual(3);
    expect(summary.errStack!.split(' | ')[0]).toMatch(/^at /);
  });

  it('不是 Error 的值也能记', () => {
    expect(errorSummary('boom')).toEqual({ errName: 'string', errMessage: 'boom', errStack: undefined });
    expect(errorSummary(null).errName).toBe('object');
  });
});
