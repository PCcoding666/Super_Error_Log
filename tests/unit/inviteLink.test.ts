/** 预填邀请码的登录链接（src/studentHost/inviteLink.ts）：拼接、入口校验、查询串解析。 */
import { describe, expect, it } from 'vitest';
import { CODE_QUERY_PARAM, DEFAULT_PUBLIC_ORIGIN, isSafeHostHeader, loginLink, loginPageUrl, prefillCodeFromQuery, resolvePublicOrigin } from '../../src/studentHost/inviteLink.js';

describe('登录链接', () => {
  it('loginLink 把码统一成 XXXX-XXXX-XXXX，入口末尾的斜杠去掉；不是 12 位的码报错', () => {
    expect(CODE_QUERY_PARAM).toBe('code');
    expect(loginLink('https://study.example.com', 'abcd efgh jkmn')).toBe('https://study.example.com/s/?code=ABCD-EFGH-JKMN');
    expect(loginLink('http://127.0.0.1:3100/', 'ABCD-EFGH-JKMN')).toBe('http://127.0.0.1:3100/s/?code=ABCD-EFGH-JKMN');
    expect(loginPageUrl('https://study.example.com/')).toBe('https://study.example.com/s/');
    expect(() => loginLink('https://study.example.com', 'ABCD-EFGH')).toThrow('12 位');
    expect(() => loginLink('https://study.example.com', 'ABCD-EFGH-JKLM')).toThrow('12 位'); // L 不在码表里
  });

  it('resolvePublicOrigin：显式参数 > SEL_PUBLIC_ORIGIN > 缺省域名；只收 http(s)://主机[:端口]', () => {
    expect(resolvePublicOrigin({})).toBe(DEFAULT_PUBLIC_ORIGIN);
    expect(resolvePublicOrigin({ SEL_PUBLIC_ORIGIN: '  ' })).toBe(DEFAULT_PUBLIC_ORIGIN);
    expect(resolvePublicOrigin({ SEL_PUBLIC_ORIGIN: 'https://study.example.com/' })).toBe('https://study.example.com');
    expect(resolvePublicOrigin({ SEL_PUBLIC_ORIGIN: 'https://study.example.com' }, 'http://127.0.0.1:3100')).toBe('http://127.0.0.1:3100');
    for (const bad of ['ftp://x', 'study.example.com', 'https://user@study.example.com', 'https://study.example.com/s/', 'https://study.example.com/?a=1', 'https://study.example.com/#x']) {
      expect(() => resolvePublicOrigin({}, bad)).toThrow();
    }
  });

  it('prefillCodeFromQuery 只认一个像 12 位码的字符串，别的一律当没有', () => {
    expect(prefillCodeFromQuery('abcd-efgh-jkmn')).toBe('ABCD-EFGH-JKMN');
    expect(prefillCodeFromQuery(' ABCD EFGH JKMN ')).toBe('ABCD-EFGH-JKMN');
    expect(prefillCodeFromQuery('ABCDEFGHJKMN')).toBe('ABCD-EFGH-JKMN');
    expect(prefillCodeFromQuery(undefined)).toBeNull();
    expect(prefillCodeFromQuery('')).toBeNull();
    expect(prefillCodeFromQuery(['ABCD-EFGH-JKMN', 'ABCD-EFGH-JKMN'])).toBeNull();
    expect(prefillCodeFromQuery('ABCD-EFGH')).toBeNull();
    expect(prefillCodeFromQuery('<script>alert(1)</script>')).toBeNull();
    expect(prefillCodeFromQuery('A'.repeat(41))).toBeNull();
    expect(prefillCodeFromQuery({ code: 'ABCD-EFGH-JKMN' })).toBeNull();
  });

  it('isSafeHostHeader 只认主机名 / IPv4 / 带方括号的 IPv6，可带端口', () => {
    for (const ok of ['study.example.com', '127.0.0.1:3100', 'localhost', '[::1]:3100', 'a-b.example']) expect(isSafeHostHeader(ok)).toBe(true);
    for (const bad of [undefined, '', 'evil host', 'a/b', 'x.example.com:abc', '-bad.example', 'a..b', 'x.example.com\r\nSet-Cookie: a=b', ['a', 'b']]) expect(isSafeHostHeader(bad)).toBe(false);
  });
});
