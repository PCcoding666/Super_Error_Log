import express, { type Request, type Response } from 'express';
import type { StudentRegistry } from '../studentHost/registry.js';
import { readCookies } from '../web/session.js';
import { sendHtml } from '../views/render.js';
import { AdminAuth, ADMIN_SESSION_TTL_MS } from './auth.js';
import { FilterError, parseAdminFilters, readAdminReport } from './report.js';
import { AdminDashboard, AdminLogin, AdminProblem } from './views.js';
import { ADMIN_STYLES } from './styles.js';

export const ADMIN_COOKIE = 'sel_admin_session';
export interface AdminRouterOptions {
  registry: StudentRegistry; auth: AdminAuth; ipOf: (request: Request) => string; originScheme: 'http:' | 'https:';
}

export function createAdminRouter({ registry, auth, ipOf, originScheme }: AdminRouterOptions): express.Router {
  const router = express.Router();
  const attempts = new Map<string, { count: number; until: number }>();
  let global = { count: 0, until: 0 };
  const cookie = (response: Response, token: string, seconds: number) => response.setHeader('set-cookie',
    `${ADMIN_COOKIE}=${token}; Path=/admin; Max-Age=${seconds}; HttpOnly; SameSite=Strict${originScheme === 'https:' ? '; Secure' : ''}`);
  router.use((request, response, next) => {
    response.set({
      'cache-control': 'private, no-store', pragma: 'no-cache', 'x-content-type-options': 'nosniff',
      // no-referrer makes browser form POST Origin "null", defeating legitimate strict-origin login.
      'x-frame-options': 'DENY', 'referrer-policy': 'same-origin',
      'content-security-policy': "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
    });
    if (request.method === 'POST') {
      const origin = request.headers.origin;
      if (!origin || origin !== `${originScheme}//${request.headers.host}` || request.headers['sec-fetch-site'] === 'cross-site') {
        response.status(403).type('text/plain').send('不允许跨站提交。'); return;
      }
    }
    next();
  });
  router.get('/styles.css', (_request, response) => response.type('text/css').send(ADMIN_STYLES));
  router.get('/login', (_request, response) => sendHtml(response, AdminLogin({})));
  router.post('/login', express.urlencoded({ extended: false, limit: '2kb', parameterLimit: 2 }), async (request, response) => {
    const now = Date.now();
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
    const ip = ipOf(request);
    if (global.until <= now) global = { count: 0, until: now + 60_000 };
    const attempt = attempts.get(ip) ?? { count: 0, until: now + 600_000 };
    if (attempt.count >= 5 || global.count >= 30) {
      response.setHeader('retry-after', Math.max(1, Math.ceil(((attempt.count >= 5 ? attempt : global).until - now) / 1000)));
      response.status(429); sendHtml(response, AdminLogin({ error: '尝试过于频繁，请稍后重试。' })); return;
    }
    attempt.count += 1; global.count += 1; attempts.set(ip, attempt);
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    const token = await auth.login(password);
    if (!token) { response.status(401); sendHtml(response, AdminLogin({ error: '管理员密码不正确或尚未设置。' })); return; }
    attempts.delete(ip);
    auth.logout(readCookies(request)[ADMIN_COOKIE] ?? '');
    cookie(response, token, ADMIN_SESSION_TTL_MS / 1000);
    response.redirect(303, '/admin/');
  });
  router.use((request, response, next) => {
    if (!auth.authenticate(readCookies(request)[ADMIN_COOKIE] ?? '')) { response.redirect(303, '/admin/login'); return; }
    next();
  });
  router.post('/logout', (request, response) => {
    auth.logout(readCookies(request)[ADMIN_COOKIE] ?? '');
    cookie(response, '', 0); response.redirect(303, '/admin/login');
  });
  router.get('/', async (request, response) => {
    try { sendHtml(response, AdminDashboard(await readAdminReport(registry, parseAdminFilters(request.query)))); }
    catch (error) {
      if (error instanceof FilterError) { response.status(400); sendHtml(response, AdminProblem({ message: error.message })); return; }
      throw error;
    }
  });
  router.use((_request, response) => { response.status(404); sendHtml(response, AdminProblem({ message: '管理页面不存在。' })); });
  router.use(((error, _request, response, _next) => {
    if (response.headersSent) return;
    response.status((error as { type?: string }).type === 'entity.too.large' ? 413 : 500);
    sendHtml(response, AdminProblem({ message: '暂时无法读取管理数据，请稍后重试。' }));
  }) as express.ErrorRequestHandler);
  return router;
}
