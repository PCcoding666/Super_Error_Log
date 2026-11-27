/**
 * 预填邀请码的登录链接（2026-11-01）：`<公网入口>/s/?code=XXXX-XXXX-XXXX`。
 * 老师把它做成二维码或直接发给学生，打开就是填好码的登录页；学生点「进入我的错题本」才兑换，
 * 打开链接本身不建会话（链接预览、误点都不会把码用掉或把人登进去）。
 *
 * 码只出现在查询串里。服务端不把查询串写进任何日志（访问日志只记路由模板，见 src/web/trail.ts routeTemplate；
 * Caddy 未开访问日志），页面 Referrer-Policy 是 same-origin，所以码最远只会以 Referer 的形式回到本站自己。
 * 这里只做字符串拼接和校验，不碰注册表。
 */
import { formatInviteCode, normalizeInviteCode } from './registry.js';

/** 公网入口缺省值（与 src/mobile/pairing.ts 的网页配对入口、/help/ 说明页一致）。 */
export const DEFAULT_PUBLIC_ORIGIN = 'https://study.pccoding666.com';
/** 登录页路径（挂在网关 /s 下的根）。 */
export const LOGIN_PAGE_PATH = '/s/';
/** 查询串里放邀请码的参数名；只认这一个。 */
export const CODE_QUERY_PARAM = 'code';

/**
 * 解析公网入口：显式参数（CLI `--origin`）> 环境变量 SEL_PUBLIC_ORIGIN > 缺省域名。
 * 只接受 `http(s)://主机[:端口]`，不带路径、查询串、用户名；别的值直接报错，不猜。
 */
export function resolvePublicOrigin(env: NodeJS.ProcessEnv = process.env, explicit?: string): string {
  const raw = (explicit ?? env.SEL_PUBLIC_ORIGIN ?? '').trim();
  if (raw === '') return DEFAULT_PUBLIC_ORIGIN;
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`公网入口不是合法地址：${raw}（要像 https://study.example.com）`); }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error(`公网入口只能是 http(s)://主机[:端口]，不带路径或查询串：${raw}`);
  }
  return url.origin;
}

/** 浏览器带来的 Host 头能不能直接拼进链接：只认主机名 / IPv4 / 带方括号的 IPv6，可带端口。 */
export function isSafeHostHeader(host: unknown): host is string {
  return typeof host === 'string' && host.length <= 253 && /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?$/.test(host);
}

/** 登录链接。code 可以是任何能规范化的写法（带空格、小写都行），链接里统一成 XXXX-XXXX-XXXX。 */
export function loginLink(origin: string, code: string): string {
  const normalized = normalizeInviteCode(code);
  if (normalized === null) throw new Error('邀请码不是 12 位，不能生成登录链接');
  return `${origin.replace(/\/$/, '')}${LOGIN_PAGE_PATH}?${CODE_QUERY_PARAM}=${formatInviteCode(normalized)}`;
}

/** 不带码的登录页地址（给微信里的「复制网址」用）。 */
export function loginPageUrl(origin: string): string {
  return `${origin.replace(/\/$/, '')}${LOGIN_PAGE_PATH}`;
}

/**
 * 查询串里的 code → 预填值。只认一个字符串、长度在 40 以内、规范化后正好 12 位有效字符；
 * 其他一律当没有（不把来历不明的文本回显到页面）。返回 XXXX-XXXX-XXXX。
 */
export function prefillCodeFromQuery(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 40) return null;
  const normalized = normalizeInviteCode(value);
  return normalized === null ? null : formatInviteCode(normalized);
}
