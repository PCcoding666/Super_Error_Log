/**
 * 学生邀请码网关（2026-10-15）：挂在主进程 /s，替代旧的单学生网页直挂。
 * - 公开：登录页与静态壳（脚本/样式/icon/manifest/sw/offline，无任何学生数据）。
 * - 登录：POST /s/login（同源校验）兑换邀请码 → sel_student 会话 cookie
 *   （HttpOnly、SameSite=Lax、Path=/s、非本机 Secure、30 天，活跃使用时滑动续期）。错误提示统一，不暴露学生存在性。
 *   限速按「码」计失败次数（成功不计），另有很宽的单 IP 上限和全站预算，见 attemptGuard.ts（P0-6）。
 * - 注册：POST /s/register 填姓名、手机号和自己设的 4 位找回码。设了 SEL_REGISTRATION_CODE_REQUIRED=1 时
 *   还要老师/管理员预发的班级注册码（默认不要）。
 * - 找回：POST /s/recover 姓名 + 手机号 + 找回码对上，作废旧码和会话，当场发新码；同一账号连续错 5 次锁 24 小时。
 * - 我的邀请码：GET /s/account 查看/复制本设备登录用的码；POST /s/account/regenerate 一键换新码（P0-11）；
 *   POST /s/account/recovery 设置或修改找回码（老账号在这里补设）。
 * - 退出：POST /s/logout 立即撤销会话并清掉本机页面标记（业务 cookie），不删除学习数据。
 * - 转发：其余 /s/* 按会话找到学生，流式代理到该学生的独立 worker 进程。
 *   - 禁止旧 /s/pair（绕过新登录的口子）与任何含编码/穿越字符的路径，绝不转发到 /v1 /v2。
 *   - 请求头白名单重建：过滤用户带来的 sel_device、authorization 与转发头；注入只有父进程知道的内部
 *     sel_device 令牌、真实 IP 与账号身份标签 x-sel-internal-account-role（只是元数据，来自注册表，
 *     浏览器带来的同名头一律丢弃）。原始 Host 保留。
 *   - 响应 Set-Cookie 只放行业务 cookie（见 BUSINESS_COOKIES），
 *     绝不把内部 sel_device 或 sel_student 发给浏览器；含学生数据的响应一律 no-store。
 *   - 请求体流式转发（不解析 multipart）；有限超时；客户端断连取消上游请求（POST 不自动重放）。
 * - 原生 App（iOS，2026-10-23）：/s/native 下的 JSON 接口，不用 cookie、不进网页路由（/s/api 是网页单页应用的
 *     cookie 接口，由 worker 处理，与这里无关）。
 *   - POST /s/native/login {code} 兑换邀请码 → 返回会话令牌（与网页会话同一张表、同样 30 天滑动续期）
 *     和该学生 worker 的 serviceId；限速与网页登录共用同一套按码计数。
 *   - /s/native/v1/* 与 /s/native/v2/* 要求 Authorization: Bearer <会话令牌>，鉴权后改写成 worker 的
 *     /v1 /v2（带只有父进程知道的内部设备令牌），只放行 health / recognitions / v2，绝不放行 pairing。
 *   - POST /s/native/logout 立即撤销该令牌。cookie 会话永远进不了 /s/native；令牌也永远进不了网页路由。
 */
import http from 'node:http';
import crypto from 'node:crypto';
import express, { Router, type Request, type Response } from 'express';
import { isAccountRole } from './accountRole.js';
import { INVITATION_WARN_MS, RegistryError, StudentRegistry, resolveStudentHostDir } from './registry.js';
import { AttemptGuard, codeKey, LOGIN_LIMITS, RECOVERY_LIMITS, REGISTRATION_LIMITS, registrationKey } from './attemptGuard.js';
import { isInAppBrowserAgent } from '../web/inAppBrowser.js';
import { StudentWorkerPool, WorkerStartError } from './workers.js';
import { registerStaticAssets } from '../web/staticAssets.js';
import { COOKIE, clearCookie, readCookies, setCookie } from '../web/session.js';
import { TRAIL_COOKIE } from '../web/trail.js';
import type { RateLimiter } from '../mobile/rateLimit.js';
import { sendHtml } from '../views/render.js';
import { AccountPage, HostErrorPage, LoginPage, RecoveryPage, RegistrationPage, RegistrationCompletePage, registrationFieldErrors } from './loginView.js';
import { CAPACITY_RETRY_SECONDS, CapacityWaitlist, capacityLines, capacityPageHtml } from './busyView.js';

/** 「我的邀请码」换码成功的一次性提示（网关自用，不转发给 worker，也不在业务 cookie 白名单里）。 */
const ACCOUNT_FLASH_COOKIE = 'sel_account_flash';

/** 前台会话 cookie（Path=/s）；与学生 worker 内部的 sel_device 设备令牌完全分开。 */
export const SESSION_COOKIE = 'sel_student';

/** 原生 App 接口前缀（挂在 /s 下）与它的协议代次；iOS 的 health 校验也按这个代次。 */
export const NATIVE_API_PREFIX = '/native';
export const NATIVE_PROTOCOL_VERSION = 1;
/** 原生 App 能经网关到达的 worker 路径：只有上传/识别进度与 /v2 闭环；/v1/pairing 永远不在其中。 */
const NATIVE_UPSTREAM = /^\/(?:v1\/(?:health|recognitions)(?:\/|$)|v2(?:\/|$))/;
/** 网关为原生 App 转发时保留的请求头（白名单之外一律丢弃；cookie 与 authorization 由网关重建）。 */
const NATIVE_FORWARD_HEADERS = ['idempotency-key', 'x-photo-name'] as const;

/** 允许在浏览器与 worker 之间来回的业务 cookie（不含 sel_device / sel_student）。 */
const BUSINESS_COOKIES: ReadonlySet<string> = new Set([COOKIE.photos, COOKIE.skip, COOKIE.a2hs, COOKIE.itemsSubject, TRAIL_COOKIE]);

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
};

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'set-cookie', 'content-length']);
/** 语音转写（60s）之外留有裕量；识别/打印都是 202 异步，不会被这个上限卡住。 */
const PROXY_TIMEOUT_MS = 120_000;

/**
 * 通用的单 key 失败计数（旧接口，保留给测试与其他调用方）。网关的登录/注册限速已改用 attemptGuard.ts：
 * 按码计数、成功不计数、单 IP 宽上限 + 全站预算。
 */
export class LoginThrottle {
  private readonly failures = new Map<string, number[]>();
  constructor(private readonly now: () => number = () => Date.now(), private readonly limit = 10, private readonly windowMs = 600_000) {}

  private recent(ip: string): number[] {
    const list = (this.failures.get(ip) ?? []).filter(at => this.now() - at < this.windowMs);
    if (list.length === 0) this.failures.delete(ip); else this.failures.set(ip, list);
    return list;
  }

  /** 已超限返回剩余秒数；否则 0。超限期间不再检查邀请码（防探测）。 */
  blockedSeconds(ip: string): number {
    const list = this.recent(ip);
    if (list.length < this.limit) return 0;
    return Math.max(1, Math.ceil((list[0]! + this.windowMs - this.now()) / 1000));
  }

  record(ip: string): void {
    const list = this.recent(ip);
    list.push(this.now());
    this.failures.set(ip, list);
  }
}

/**
 * 跨站提交拦截（比 web/router 更严：Origin 为 null 一律拒绝——隐藏来源的 POST 不接受）。
 * 同源判定同时比对 host 与协议：expectedScheme 由部署形态给出（Caddy 后面是 https:，本机测试是 http:）。
 * 老浏览器同源表单可能不带 Origin：不带放行（SameSite=Lax 已挡住跨站携带 cookie）。
 */
function crossSite(request: Request, expectedScheme: string): boolean {
  if (request.headers['sec-fetch-site'] === 'cross-site') return true;
  const origin = request.headers.origin;
  if (!origin) return false;
  if (origin === 'null') return true;
  try {
    const url = new URL(origin);
    return url.host !== request.headers.host || url.protocol !== expectedScheme;
  } catch { return true; }
}

function wantsJson(request: Request): boolean {
  return (request.headers.accept ?? '').includes('application/json');
}

/**
 * 相对路径白名单校验：拒绝编码字符（%）、反斜杠、.. 段、旧 /s/pair 与网关自有端点。
 * 返回可安全拼到 worker '/s' 前缀后的原始 URL（含查询串）；不合法返回 null。
 */
function safeRelativeUrl(rawUrl: string): string | null {
  const queryAt = rawUrl.indexOf('?');
  const pathname = queryAt >= 0 ? rawUrl.slice(0, queryAt) : rawUrl;
  if (!pathname.startsWith('/')) return null;
  if (pathname.includes('%') || pathname.includes('\\') || pathname.includes('..') || pathname.includes('\0')) return null;
  if (pathname === '/pair' || pathname.startsWith('/pair/')) return null;
  if (/^\/(?:login|logout|register|recover|account-copy\.js)\/?$/i.test(pathname)) return null;
  if (/^\/account(?:\/|$)/i.test(pathname)) return null;
  return rawUrl;
}

/**
 * 原生 App 路径 → worker 路径：/native/v1/health → /v1/health。不在白名单内（含 /v1/pairing、/s 网页）返回 null。
 * 先过 safeRelativeUrl 的编码/穿越检查，再按 worker 侧的真实前缀放行。
 */
function nativeUpstreamUrl(rawUrl: string): string | null {
  const safe = safeRelativeUrl(rawUrl);
  if (safe === null || !safe.startsWith(`${NATIVE_API_PREFIX}/`)) return null;
  const upstream = safe.slice(NATIVE_API_PREFIX.length);
  const pathname = upstream.split('?')[0]!;
  return NATIVE_UPSTREAM.test(pathname) ? upstream : null;
}

function isNativePath(pathname: string): boolean {
  return pathname === NATIVE_API_PREFIX || pathname.startsWith(`${NATIVE_API_PREFIX}/`);
}

/** Authorization: Bearer <token>；形状不对返回 null（不区分缺失与非法）。 */
function bearerToken(request: Request): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 && token.length <= 512 ? token : null;
}

export interface StudentHostGatewayDeps {
  limiter: RateLimiter;
  ipOf: (request: Request) => string;
  /** 公网入口的协议（带冒号，如 'https:'）；同源校验比对它。缺省按请求自身协议（本机测试 http:）。 */
  originScheme?: string;
}

export interface StudentHostGatewayOptions {
  hostDir?: string;
  registry?: StudentRegistry;
  pool?: StudentWorkerPool;
  now?: () => Date;
  /** 测试注入：限速器用的时钟（毫秒）。 */
  throttleNow?: () => number;
  /** 注册要不要班级注册码；缺省读 SEL_REGISTRATION_CODE_REQUIRED=1（默认不要）。 */
  requireRegistrationCode?: boolean;
  /**
   * 登录、注册的失败预算已用完时，「错的那一次」回应前等多久（毫秒，缺省 500）。正确的码不等。
   * 只放慢错误尝试，不挡任何人（全站预算不能变成全站锁）。
   */
  failureDelayMs?: number;
}

/** 「复制邀请码」的小脚本：网关自己提供（script-src 'self'），没有脚本时码本身可以长按选择。 */
const COPY_SCRIPT = `(() => {
  for (const button of document.querySelectorAll('[data-copy-target]')) {
    const target = document.getElementById(button.getAttribute('data-copy-target'));
    const status = button.parentElement && button.parentElement.querySelector('[data-copy-status]');
    if (!target) continue;
    button.hidden = false;
    button.addEventListener('click', async () => {
      const text = (target.textContent || '').trim();
      let ok = false;
      try { await navigator.clipboard.writeText(text); ok = true; } catch (error) {
        try {
          const range = document.createRange(); range.selectNodeContents(target);
          const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
          ok = document.execCommand('copy');
        } catch (inner) { ok = false; }
      }
      if (status) status.textContent = ok ? '已复制。' : '没能自动复制，请长按邀请码手动复制或截图。';
    });
  }
})();`;

export interface StudentHostGateway {
  readonly registry: StudentRegistry;
  readonly pool: StudentWorkerPool;
  router(deps: StudentHostGatewayDeps): Router;
  close(): Promise<void>;
}

export async function createStudentHostGateway(options: StudentHostGatewayOptions = {}): Promise<StudentHostGateway> {
  const registry = options.registry ?? StudentRegistry.open(options.hostDir ?? resolveStudentHostDir());
  const pool = options.pool ?? new StudentWorkerPool({ dirFor: studentId => registry.studentDir(studentId), sharedDir: registry.hostDir });
  const loginGuard = new AttemptGuard(LOGIN_LIMITS, options.throttleNow);
  const registrationGuard = new AttemptGuard(REGISTRATION_LIMITS, options.throttleNow);
  const recoveryGuard = new AttemptGuard(RECOVERY_LIMITS, options.throttleNow);
  const requireCode = options.requireRegistrationCode ?? process.env.SEL_REGISTRATION_CODE_REQUIRED === '1';
  const now = options.now ?? ((): Date => new Date());
  const failureDelayMs = Math.max(0, options.failureDelayMs ?? 500);
  const slowDown = (): Promise<void> => failureDelayMs > 0 ? new Promise(resolve => setTimeout(resolve, failureDelayMs)) : Promise.resolve();
  let built: Router | null = null;

  // 不在启动时为每个已注册学生拉起进程。第一次打开再 fork；空闲后由进程池退出。
  // 未完成的识别和打印留在该学生自己的目录里，下次启动时的恢复扫描会续做。

  const buildRouter = (deps: StudentHostGatewayDeps): Router => {
    const r = Router();
    const form = express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 20 });
    const expectedScheme = deps.originScheme ?? 'http:';
    const isCrossSite = (request: Request): boolean => crossSite(request, expectedScheme);

    r.use((_request, response, next) => {
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
      // 默认禁止缓存；公开静态壳由共享注册函数单独设置缓存策略。
      response.setHeader('cache-control', 'private, no-store');
      next();
    });

    // ---------- 公开资源（无学生数据；与 worker 同一份静态壳） ----------
    registerStaticAssets(r);
    r.get('/login', (_request, response) => response.redirect(303, '/s/'));

    const inApp = (request: Request): boolean => isInAppBrowserAgent(request.headers['user-agent']);

    // ---------- 公开资源：复制脚本（无学生数据） ----------
    r.get('/account-copy.js', (_request, response) => {
      response.setHeader('cache-control', 'public, max-age=3600');
      response.type('application/javascript').send(COPY_SCRIPT);
    });

    // ---------- 公开注册（姓名手机号 + 找回码；打开时另要注册码；不能指定账号身份或学生 ID） ----------
    r.get('/register', (request, response) => sendHtml(response, RegistrationPage({ inAppBrowser: inApp(request), requireCode })));
    r.post('/register', form, async (request, response) => {
      if (isCrossSite(request)) { response.status(403).send('forbidden'); return; }
      const ip = deps.ipOf(request);
      const field = (name: string): string => typeof request.body?.[name] === 'string' ? request.body[name] : '';
      const values = { name: field('name').slice(0, 60), phone: field('phone').slice(0, 40), regcode: field('regcode').slice(0, 20) };
      const page = (extra: Parameters<typeof RegistrationPage>[0]): void => sendHtml(response, RegistrationPage({ inAppBrowser: inApp(request), requireCode, values, ...extra }));
      const key = registrationKey(requireCode ? values.regcode : '', ip);
      // 只有成功上限（全站总数、同一 IP 每小时）在注册前挡，防刷满名额；失败预算只影响错的那一次怎么回应。
      const capped = registrationGuard.successCapped(ip);
      if (capped) {
        response.setHeader('retry-after', String(capped.seconds));
        response.status(429);
        page({ blocked: capped });
        return;
      }
      try {
        const registration = registry.registerStudent(values.name, values.phone, {
          recoveryPin: field('pin').slice(0, 16),
          ...(requireCode ? { registrationCode: values.regcode } : {}),
        });
        // 成功不计入失败次数，只计入全站注册总预算和这个 IP 的每小时注册上限。
        registrationGuard.success(key, ip);
        response.status(201);
        response.setHeader('referrer-policy', 'no-referrer');
        sendHtml(response, RegistrationCompletePage({ ...registration, inAppBrowser: inApp(request) }));
      } catch (error) {
        if (!(error instanceof RegistryError)) throw error;
        // 只有「码不对」和「重复登记」算失败（后者可被用来探测谁注册过）；填错格式不算。
        // 先验过码才走到这里：失败预算超了只把这次错误回应改成 429（并放慢），不会挡住新同学正常注册。
        if (error.code === 'invalid_registration_code' || error.code === 'duplicate_registration') {
          const wasOver = registrationGuard.blocked(key, ip) !== null;
          registrationGuard.failure(key, ip);
          const over = registrationGuard.blocked(key, ip);
          if (over) {
            if (wasOver) await slowDown();
            response.setHeader('retry-after', String(over.seconds));
            response.status(429);
            page({ blocked: over, values: error.code === 'invalid_registration_code' ? { ...values, regcode: '' } : values });
            return;
          }
        }
        response.status(error.code === 'capacity_full' ? 503 : 400);
        const kept = error.code === 'invalid_registration_code' ? { ...values, regcode: '' } : values;
        page({ error: error.message, duplicate: error.code === 'duplicate_registration', fieldErrors: registrationFieldErrors(error.code, kept), values: kept });
      }
    });

    // ---------- 自助找回（姓名 + 手机号 + 找回码 → 作废旧码，发新码） ----------
    r.get('/recover', (request, response) => sendHtml(response, RecoveryPage({ inAppBrowser: inApp(request) })));
    r.post('/recover', form, (request, response) => {
      if (isCrossSite(request)) { response.status(403).send('forbidden'); return; }
      const ip = deps.ipOf(request);
      const field = (name: string): string => typeof request.body?.[name] === 'string' ? request.body[name] : '';
      const values = { name: field('name').slice(0, 60), phone: field('phone').slice(0, 40) };
      const key = `ip:${ip}`;
      // 找回码只有 4 位：先看预算再比对（和登录、注册相反），超出预算的尝试一律不比对。
      const blocked = recoveryGuard.blocked(key, ip);
      if (blocked) {
        response.setHeader('retry-after', String(blocked.seconds));
        response.status(429);
        sendHtml(response, RecoveryPage({ blocked, inAppBrowser: inApp(request), values }));
        return;
      }
      try {
        const invitation = registry.recoverInvitation(values.name, values.phone, field('pin'));
        recoveryGuard.success(key, ip);
        response.setHeader('referrer-policy', 'no-referrer');
        sendHtml(response, RegistrationCompletePage({ ...invitation, recovered: true, inAppBrowser: inApp(request) }));
      } catch (error) {
        if (!(error instanceof RegistryError)) throw error;
        if (error.code === 'recovery_failed') recoveryGuard.failure(key, ip);
        response.status(error.code === 'recovery_locked' ? 429 : 400);
        sendHtml(response, RecoveryPage({ error: error.message, inAppBrowser: inApp(request), values }));
      }
    });

    // ---------- 登录（兑换邀请码） ----------
    r.post('/login', form, async (request, response) => {
      if (isCrossSite(request)) { response.status(403).send('forbidden'); return; }
      const ip = deps.ipOf(request);
      const raw = typeof request.body?.code === 'string' ? request.body.code : '';
      const key = codeKey(raw, ip);
      // 先验码：正确的码任何时候都能登录，不受码键、IP、全站失败预算影响（预算只放慢错误尝试）。
      try {
        const session = registry.redeem(raw);
        loginGuard.success(key, ip);
        const seconds = Math.max(1, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000));
        const previous = readCookies(request)[SESSION_COOKIE];
        if (previous) registry.revokeSession(previous);
        // 换号登录：先清掉上一学生留在本机的页面标记，再种新会话。
        for (const name of BUSINESS_COOKIES) clearCookie(request, response, name);
        // Clear only this browser's legacy cookie, never revoke native-device credentials.
        clearCookie(request, response, COOKIE.device);
        setCookie(request, response, SESSION_COOKIE, session.sessionToken, seconds);
        response.redirect(303, '/s/?login=1');
      } catch (error) {
        if (!(error instanceof RegistryError)) throw error;
        const wasOver = loginGuard.blocked(key, ip) !== null;
        loginGuard.failure(key, ip);
        const retryAfter = loginGuard.blocked(key, ip);
        if (retryAfter) {
          if (wasOver) await slowDown();
          response.setHeader('retry-after', String(retryAfter.seconds));
          response.status(429);
          sendHtml(response, LoginPage({ blocked: retryAfter, inAppBrowser: inApp(request) }));
          return;
        }
        response.status(400);
        sendHtml(response, LoginPage({ error: error.message, inAppBrowser: inApp(request) }));
      }
    });

    // ---------- 原生 App：兑换邀请码（JSON；无 cookie）。限速与网页登录共用同一张按码计数表 ----------
    const nativeJson = express.json({ limit: '4kb', strict: true });
    r.post(`${NATIVE_API_PREFIX}/login`, nativeJson, async (request, response) => {
      // 原生请求不带 Origin；带了就按网页同源规则查，防止网页脚本借这个口子拿令牌。
      if (isCrossSite(request)) { response.status(403).json({ error: { code: 'forbidden', message: '不接受跨站请求。' } }); return; }
      const ip = deps.ipOf(request);
      const body = request.body as Record<string, unknown> | undefined;
      const raw = typeof body?.code === 'string' ? body.code : '';
      const key = codeKey(raw, ip);
      const rateLimited = (blocked: { seconds: number }): void => {
        response.setHeader('retry-after', String(blocked.seconds));
        response.status(429).json({ error: { code: 'rate_limited', message: `试的次数太多了，请 ${blocked.seconds} 秒后再试。` } });
      };
      // 与网页登录同一顺序——先验码：正确的码任何时候都能登录，码键 / IP / 全站失败预算只放慢错误尝试，
      // 否则同一校园网络或全站累计输错就会把正确的码一起挡住（可被错误尝试触发的拒绝服务）。
      let session;
      try {
        session = registry.redeem(raw);
      } catch (error) {
        if (!(error instanceof RegistryError)) throw error;
        const wasOver = loginGuard.blocked(key, ip) !== null;
        loginGuard.failure(key, ip);
        const retryAfter = loginGuard.blocked(key, ip);
        if (retryAfter) {
          if (wasOver) await slowDown();
          rateLimited(retryAfter);
          return;
        }
        response.status(400).json({ error: { code: 'invalid_code', message: error.message } });
        return;
      }
      loginGuard.success(key, ip);
      // 学生空间的 serviceId 来自它自己的 worker（每个学生目录一份、重启不变）：App 之后每次 health 都核对它。
      // 与 proxyToWorker 一样先 retain：容量腾挪与空闲退出都按 inflight 计数排除正在服务的 worker，
      // 否则别的学生并发启动可能把正在做登录检查的这个 worker 当空闲进程停掉。
      let serviceId: string;
      pool.retain(session.studentId);
      try {
        const endpoint = await pool.ensure(session.studentId);
        const health = await fetch(`http://127.0.0.1:${endpoint.port}/v1/health`, {
          headers: { authorization: `Bearer ${endpoint.token}`, accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
        });
        const snapshot = await health.json() as { serviceId?: unknown };
        if (!health.ok || typeof snapshot.serviceId !== 'string') throw new Error('worker health 没有 serviceId');
        serviceId = snapshot.serviceId;
      } catch (error) {
        pool.release(session.studentId);
        // 空间没起来就不发令牌：已建的会话立即撤销，App 下次重试会重新兑换（新码可重复登录）。
        registry.revokeSession(session.sessionToken);
        const capacity = error instanceof WorkerStartError && error.reason === 'capacity';
        response.setHeader('retry-after', String(capacity ? CAPACITY_RETRY_SECONDS : 30));
        response.status(503).json({ error: { code: capacity ? 'capacity' : 'unavailable', message: capacity ? '现在人有点多，请过一会儿再登录。' : '你的学习空间正在准备中，等半分钟再试。' } });
        return;
      }
      pool.release(session.studentId);
      response.setHeader('referrer-policy', 'no-referrer');
      response.json({ token: session.sessionToken, serviceId, expiresAt: session.expiresAt.toISOString(), protocolVersion: NATIVE_PROTOCOL_VERSION });
    });

    // ---------- 原生 App：退出（撤销这枚令牌；没有令牌或已失效也当成功） ----------
    r.post(`${NATIVE_API_PREFIX}/logout`, (request, response) => {
      const token = bearerToken(request);
      if (token) registry.revokeSession(token);
      response.status(204).end();
    });

    // ---------- 退出（立即撤销会话；清本机页面标记，不动学习数据） ----------
    r.post('/logout', form, async (request, response) => {
      if (isCrossSite(request)) { response.status(403).send('forbidden'); return; }
      const token = readCookies(request)[SESSION_COOKIE];
      const session = token ? registry.authenticate(token) : null;
      if (session && request.body?.namespace) {
        try {
          const endpoint = await pool.ensure(session.studentId);
          const checked = await fetch(`http://127.0.0.1:${endpoint.port}/s/materials/session`, { headers: { cookie: `${COOKIE.device}=${encodeURIComponent(endpoint.token)}`, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
          const state = await checked.json() as { draftNamespace?: string };
          if (!checked.ok || state.draftNamespace !== request.body.namespace) { response.status(409).send('登录的账号已变化，请重新打开页面。'); return; }
        } catch { response.status(503).send('暂时无法退出，请稍后再试。'); return; }
      }
      if (token) registry.revokeSession(token);
      clearCookie(request, response, SESSION_COOKIE);
      for (const name of BUSINESS_COOKIES) clearCookie(request, response, name);
      clearCookie(request, response, COOKIE.device);
      response.redirect(303, '/s/');
    });

    // ---------- 会话鉴权：过期/撤销/缺失只能看到登录页 ----------
    r.use((request, response, next) => {
      // 原生 App：只认 Bearer 令牌，cookie 一律不看（网页会话拿不到 JSON 接口，令牌也进不了网页路由）。
      if (isNativePath(request.path)) {
        const bearer = bearerToken(request);
        const native = bearer ? registry.authenticate(bearer) : null;
        if (!native) {
          response.status(401).json({ error: { code: 'unauthorized', message: '登录已失效，请重新输入邀请码。' } });
          return;
        }
        registry.renewSession(bearer!);
        response.locals.studentId = native.studentId;
        response.locals.sessionToken = bearer;
        response.locals.native = true;
        response.locals.accountRole = registry.getAccountRole(native.studentId);
        registry.recordActivity(native.studentId);
        next();
        return;
      }
      const token = readCookies(request)[SESSION_COOKIE];
      const session = token ? registry.authenticate(token) : null;
      if (!session) {
        if (token) clearCookie(request, response, SESSION_COOKIE);
        if (request.method !== 'GET') {
          // 语音转写与脚本请求拿 JSON 401；普通表单提交回登录页。
          if (wantsJson(request) || request.path === '/voice') {
            response.status(401).json({ error: { code: 'unauthorized', message: '需要重新登录。' } });
            return;
          }
          response.redirect(303, '/s/');
          return;
        }
        response.status(token ? 401 : 200);
        sendHtml(response, LoginPage({ inAppBrowser: isInAppBrowserAgent(request.headers['user-agent']) }));
        return;
      }
      // 滑动续期（P0-11）：每天最多一次把会话往后顺延 30 天，并重写 cookie 的有效期。
      const renewed = registry.renewSession(token!);
      if (renewed) setCookie(request, response, SESSION_COOKIE, token!, Math.max(1, Math.floor((renewed.getTime() - Date.now()) / 1000)));
      response.locals.studentId = session.studentId;
      response.locals.sessionToken = token;
      // Bind a page's recording to this browser session without exposing the bearer token.
      response.locals.voiceContext = crypto.createHash('sha256').update(token!).digest('hex');
      // 账号身份标签：每请求从注册表现读，set-role 后下一个请求即生效，不用重新登录/重启。
      // 只是元数据，不参与鉴权；浏览器/查询串/表单里的任何「role」都不会被采信。
      response.locals.accountRole = registry.getAccountRole(session.studentId);
      registry.recordActivity(session.studentId);
      next();
    });

    // ---------- 我的邀请码（网关直接处理，不进 worker） ----------
    r.get(/^\/account\/?$/, (request, response) => {
      const info = registry.sessionInvitation(String(response.locals.sessionToken));
      if (!info) { response.redirect(303, '/s/'); return; }
      // 换码成功的提示只显示一次：读到就清掉（刷新不会再显示，更不会再换一次码）。
      const flash = readCookies(request)[ACCOUNT_FLASH_COOKIE];
      if (flash) clearCookie(request, response, ACCOUNT_FLASH_COOKIE);
      response.setHeader('referrer-policy', 'no-referrer');
      sendHtml(response, AccountPage({ ...info, now: now(), regenerated: flash === '1', pinSaved: flash === 'pin',
        recovery: registry.hasRecoveryPin(String(response.locals.studentId)) }));
    });
    // POST/Redirect/GET：换码成功后 303 回到 /s/account，刷新页面只是重新查看，不会再换一次。
    // 新码保存在本会话可解的副本里，跳转后的页面照样能看到、能复制。
    r.post(/^\/account\/regenerate\/?$/, form, (request, response) => {
      if (isCrossSite(request)) { response.status(403).send('forbidden'); return; }
      try {
        registry.regenerateOwnInvitation(String(response.locals.sessionToken));
      } catch (error) {
        if (!(error instanceof RegistryError)) throw error;
        response.redirect(303, '/s/');
        return;
      }
      setCookie(request, response, ACCOUNT_FLASH_COOKIE, '1', 120);
      response.redirect(303, '/s/account');
    });
    r.post(/^\/account\/recovery\/?$/, form, (request, response) => {
      if (isCrossSite(request)) { response.status(403).send('forbidden'); return; }
      const studentId = String(response.locals.studentId);
      try {
        registry.setRecoveryPin(studentId, typeof request.body?.pin === 'string' ? request.body.pin.slice(0, 16) : '');
      } catch (error) {
        if (!(error instanceof RegistryError)) throw error;
        const info = registry.sessionInvitation(String(response.locals.sessionToken));
        if (!info) { response.redirect(303, '/s/'); return; }
        response.status(400);
        response.setHeader('referrer-policy', 'no-referrer');
        sendHtml(response, AccountPage({ ...info, now: now(), recovery: registry.hasRecoveryPin(studentId), pinError: error.message }));
        return;
      }
      setCookie(request, response, ACCOUNT_FLASH_COOKIE, 'pin', 120);
      response.redirect(303, '/s/account');
    });

    // ---------- 转发到该学生的独立 worker ----------
    r.use((request, response) => {
      const studentId = String(response.locals.studentId);
      if (response.locals.native === true) {
        const upstream = nativeUpstreamUrl(request.url);
        if (upstream === null) { response.status(404).json({ error: { code: 'not_found', message: '接口不存在。' } }); return; }
        void proxyToWorker(request, response, studentId, upstream, deps, { native: true }).catch(() => {
          if (!response.headersSent) response.status(503).json({ error: { code: 'unavailable', message: '暂时进不去，请稍后再试。' } });
        });
        return;
      }
      // 业务 POST 的同源校验在进 worker 之前完成（被拒不触达 worker）。
      if (request.method === 'POST' && isCrossSite(request)) { response.status(403).send('forbidden'); return; }
      // Express routes accept case differences and a trailing slash. Check the same variants.
      if (request.method === 'POST' && /^\/voice\/?$/i.test(request.path)) {
        const context = request.headers['x-sel-voice-context'];
        const expected = String(response.locals.voiceContext);
        if (typeof context !== 'string' || !/^[0-9a-f]{64}$/.test(context)
          || !crypto.timingSafeEqual(Buffer.from(context), Buffer.from(expected))) {
          response.status(409).json({ error: { code: 'voice_context_mismatch', message: '登录状态已改变，请刷新页面后重新录音。' } });
          return;
        }
      }
      const relUrl = safeRelativeUrl(request.url);
      if (relUrl === null) { response.status(404).type('text/plain').send('not found'); return; }
      void proxyToWorker(request, response, studentId, relUrl, deps).catch(() => {
        if (!response.headersSent) response.status(503).type('text/plain').send('暂时进不去');
      });
    });

    return r;
  };

  /** Students turned away by the worker cap and still retrying (counts only, memory only). */
  const capacityWaitlist = new CapacityWaitlist();
  /**
   * 转发到该学生的 worker。网页：/s 前缀 + 业务 cookie + 内部 sel_device cookie；
   * 原生（native）：relUrl 已是 worker 的 /v1 /v2 路径，用内部设备令牌作 Bearer，不带任何 cookie，错误一律 JSON。
   */
  const proxyToWorker = async (request: Request, response: Response, studentId: string, relUrl: string, deps: StudentHostGatewayDeps, mode: { native: boolean } = { native: false }): Promise<void> => {
    const native = mode.native;
    let retained = false;
    const releaseWorker = (): void => {
      if (!retained) return;
      retained = false;
      pool.release(studentId);
    };
    const failClosed = (error: unknown): void => {
      releaseWorker();
      const capacity = error instanceof WorkerStartError && error.reason === 'capacity';
      if (native && !response.headersSent) {
        response.setHeader('retry-after', String(capacity ? CAPACITY_RETRY_SECONDS : 30));
        response.status(503).json({ error: { code: capacity ? 'capacity' : 'unavailable', message: capacity ? '现在人有点多，请过一会儿再试。' : '你的学习空间正在准备中，等半分钟再试。' } });
        return;
      }
      if (capacity && !response.headersSent) {
        // P0-7: say what the host actually knows (slots, AI queue, others waiting) and retry by itself.
        const facts = { snapshot: pool.capacitySnapshot(), othersWaiting: capacityWaitlist.rejected(studentId) };
        response.setHeader('retry-after', String(CAPACITY_RETRY_SECONDS));
        response.status(503);
        if (wantsJson(request)) { response.json({ error: { code: 'capacity', message: capacityLines(facts).join('') } }); return; }
        response.type('html').send(capacityPageHtml(facts, request.method === 'GET' ? `/s${relUrl}` : '/s/'));
        return;
      }
      const detail = error instanceof WorkerStartError ? '你的学习空间正在准备中，等半分钟再试。' : '服务器暂时没准备好，过一会儿再试。';
      if (!response.headersSent) {
        response.status(503);
        sendHtml(response, HostErrorPage({ title: '暂时进不去', detail }));
      } else response.destroy();
    };
    let endpoint;
    try {
      pool.retain(studentId);
      retained = true;
      endpoint = await pool.ensure(studentId);
      capacityWaitlist.admitted(studentId);
    } catch (error) {
      failClosed(error);
      return;
    }
    if (response.writableEnded || request.destroyed) { releaseWorker(); return; }

    // 请求头白名单重建：用户带来的 sel_device / authorization / 转发头一律丢弃。
    const headers: Record<string, string> = {
      host: typeof request.headers.host === 'string' ? request.headers.host : 'localhost',
      'x-real-ip': deps.ipOf(request),
      accept: typeof request.headers.accept === 'string' ? request.headers.accept : '*/*',
    };
    // Opaque draft/replay expectations; the receiving worker validates these against its own database.
    for (const name of ['x-draft-namespace', 'x-upload-id']) {
      const value = request.headers[name];
      if (typeof value === 'string' && value.length <= 200) headers[name] = value;
    }
    if (typeof request.headers['accept-language'] === 'string') headers['accept-language'] = request.headers['accept-language'];
    if (typeof request.headers['user-agent'] === 'string') headers['user-agent'] = request.headers['user-agent'];
    if (typeof request.headers['content-type'] === 'string') headers['content-type'] = request.headers['content-type'];
    if (typeof request.headers['content-length'] === 'string') headers['content-length'] = request.headers['content-length'];
    if (request.headers['x-sel-poll'] === '1') headers['x-sel-poll'] = '1';
    if (native) {
      for (const name of NATIVE_FORWARD_HEADERS) {
        const value = request.headers[name];
        if (typeof value === 'string' && value.length <= 1024) headers[name] = value;
      }
      headers.authorization = `Bearer ${endpoint.token}`;
    }
    // Never forward a client-supplied internal context; only the authenticated gateway creates it.
    // Form POSTs can render a page again after validation errors, including its VoiceBox.
    if (!native && (request.method === 'GET' || request.method === 'POST') && !/^\/voice\/?$/i.test(request.path)) {
      headers['x-sel-internal-voice-context'] = String(response.locals.voiceContext);
    }
    // 账号身份标签：只由父进程按注册表下发（上面头白名单重建时浏览器带来的同名头已被丢弃）。
    const accountRole = response.locals.accountRole;
    if (isAccountRole(accountRole)) headers['x-sel-internal-account-role'] = accountRole;
    // 邀请码快到期提醒（只给设置页展示用）：7 天内到期给出到期时间，已没有可用码给 none；其余不带。
    if (!native && request.method === 'GET') {
      const expiry = registry.invitationExpiry(studentId);
      if (!expiry) headers['x-sel-internal-invite-expires'] = 'none';
      else if (expiry.getTime() - Date.now() <= INVITATION_WARN_MS) headers['x-sel-internal-invite-expires'] = expiry.toISOString();
    }
    const clientCookies = readCookies(request);
    const cookieParts = [...BUSINESS_COOKIES]
      .filter(name => clientCookies[name] !== undefined)
      .map(name => `${name}=${encodeURIComponent(clientCookies[name]!)}`);
    cookieParts.push(`${COOKIE.device}=${endpoint.token}`);
    if (!native) headers.cookie = cookieParts.join('; ');

    const upstream = http.request(
      { host: '127.0.0.1', port: endpoint.port, method: request.method, path: native ? relUrl : `/s${relUrl}`, headers, timeout: PROXY_TIMEOUT_MS },
      upstreamResponse => {
        response.status(upstreamResponse.statusCode ?? 502);
        for (const [name, value] of Object.entries(upstreamResponse.headers)) {
          if (HOP_BY_HOP.has(name)) continue;
          response.setHeader(name, value as string | string[]);
        }
        // Set-Cookie 白名单：只放行业务 cookie；worker 的 sel_device 与本应未知的 sel_student 绝不外发。
        for (const line of upstreamResponse.headers['set-cookie'] ?? []) {
          const name = line.slice(0, line.indexOf('=')).trim().toLowerCase();
          if (name === COOKIE.device || name === SESSION_COOKIE) continue;
          if (!BUSINESS_COOKIES.has(name)) continue;
          response.append('set-cookie', line);
        }
        const type = String(upstreamResponse.headers['content-type'] ?? '');
        if (type.includes('text/html') || type.includes('application/json') || type.startsWith('image/')) {
          response.setHeader('cache-control', 'private, no-store');
        }
        // 上游响应中途出错（worker 崩溃/连接被重置）：已写出的部分不能算数，直接断开。
        upstreamResponse.on('error', () => response.destroy());
        upstreamResponse.pipe(response);
      },
    );
    upstream.on('close', releaseWorker);
    upstream.on('timeout', () => upstream.destroy(new Error('学生空间响应超时')));
    upstream.on('error', () => {
      releaseWorker();
      if (!response.headersSent && native) { response.status(502).json({ error: { code: 'bad_gateway', message: '你的学习空间刚断了一下，稍等再试。' } }); return; }
      if (!response.headersSent) { response.status(502); sendHtml(response, HostErrorPage({ title: '暂时连不上', detail: '你的学习空间刚断了一下，稍等再试。' })); return; }
      response.destroy();
    });
    // 客户端断连 → 取消上游请求（POST 不自动重放：重试只能由学生本人重新提交）。
    // 挂在 response 上：request 的 close 在正文收完就触发，不代表客户端走了。
    response.on('close', () => { if (!response.writableFinished) upstream.destroy(); });
    request.pipe(upstream);
  };

  let closed = false;
  return {
    registry,
    pool,
    router: deps => {
      built ??= buildRouter(deps);
      return built;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await pool.stopAll();
      registry.close();
    },
  };
}
