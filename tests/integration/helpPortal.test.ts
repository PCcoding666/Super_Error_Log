/**
 * 公开说明页在 /help/，不看 Host。文案从「开始使用」写起。
 * study 的 GET / 仍是 404。/s、/v1 保持原样。不依赖 help.pccoding666.com。
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createMobileApp } from '../../src/mobile/router.js';
import type { MobileRecognitionService } from '../../src/mobile/service.js';
import type { MobileVisionBoundary } from '../../src/mobile/vision.js';
import { HELP_PORTAL_PATH, helpPortalHtml } from '../../src/portal/helpPortal.js';

const roots: string[] = [];
const servers: Server[] = [];
const services: MobileRecognitionService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.stop()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});

const vision: MobileVisionBoundary = {
  async inventory() { return { candidates: [], warnings: [] }; },
  async recognizeQuestion() { throw new Error('说明页测试不调用识别'); },
};

function request(port: number, method: string, urlPath: string, host?: string): Promise<{ status: number; type: string; cache: string; location: string; csp: string; nosniff: string; referrer: string; body: string }> {
  return new Promise((resolve, reject) => {
    const headers = host ? { host } : undefined;
    const req = http.request({ hostname: '127.0.0.1', port, method, path: urlPath, headers }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk as Buffer));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        type: String(response.headers['content-type'] ?? ''),
        cache: String(response.headers['cache-control'] ?? ''),
        location: String(response.headers.location ?? ''),
        csp: String(response.headers['content-security-policy'] ?? ''),
        nosniff: String(response.headers['x-content-type-options'] ?? ''),
        referrer: String(response.headers['referrer-policy'] ?? ''),
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function listen(): Promise<number> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-help-portal-'));
  roots.push(root);
  const app = await createMobileApp({ dataDir: root, pairingToken: 'pairing-token-for-tests', vision });
  services.push(app.locals.mobileRecognitionService);
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  return (server.address() as { port: number }).port;
}

describe('产品说明页文案', () => {
  const html = helpPortalHtml();

  it('先写开始使用，再写操作位置、占位联系方式和 GitHub', () => {
    expect(HELP_PORTAL_PATH).toBe('/help/');
    expect(html).toContain('href="https://study.pccoding666.com/help/"');
    expect(html).toContain('href="/help/"');
    expect(html).toContain('把做错的题收进错题本，方便以后再看。AI 从照片里抽出题目，也可以给提示；错因由你自己写。');
    const headings = [...html.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map(match => match[1]);
    expect(headings).toEqual(['开始使用', '使用指南', '联系方式']);
    const nav = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'));
    expect(nav.indexOf('href="#start"')).toBeLessThan(nav.indexOf('href="#guide"'));
    expect(nav.indexOf('href="#guide"')).toBeLessThan(nav.indexOf('href="#contact"'));
    expect(html).toContain('老师或管理员发的邀请码');
    expect(html).toContain('href="https://study.pccoding666.com/s/"');
    expect(html).toContain('href="https://study.pccoding666.com/s/register"');
    expect(html).toContain('href="https://study.pccoding666.com/s/recover"');
    expect(html).toContain('href="https://study.pccoding666.com/s/me"');
    expect(html).toContain('class="cta" href="https://study.pccoding666.com/s/"');
    expect(html).toContain('>打开学习页</a>');
    expect(html).toContain('>邮箱<');
    expect(html).toContain('>微信<');
    expect(html).toContain('<dd class="mono">待补充</dd>');
    expect(html).toContain('二维码待补充');
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/data:image/i);
    expect(html).not.toMatch(/<script\b/i);
    expect(html).toContain('https://github.com/PCcoding666/Super_Error_Log');
    for (const banned of ['寄宿', '周末拍卷', '真的会了', '当天做对', '怎么用', '工作日纸上做', '隔几天', '掌握', 'sel.pccoding666.com', 'help.pccoding666.com']) {
      expect(html, banned).not.toContain(banned);
    }
  });
});

describe('说明页在 /help/，不占用学生学习站，也不看 Host', () => {
  it('GET /help/ 是说明页；/help 跳到 /help/；根路径、/s、/v1 仍走原路由', async () => {
    const port = await listen();

    const portal = await request(port, 'GET', '/help/', 'study.pccoding666.com');
    expect(portal.status).toBe(200);
    expect(portal.type).toContain('text/html');
    expect(portal.cache).toContain('public');
    expect(portal.cache).toContain('max-age=300');
    expect(portal.csp).toBe("default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    expect(portal.nosniff).toBe('nosniff');
    expect(portal.referrer).toBe('strict-origin-when-cross-origin');
    expect(portal.body).toContain('打开学习页');
    expect(portal.body).toContain('href="https://study.pccoding666.com/s/"');
    expect(portal.body).toContain('href="/help/"');

    const bareHost = await request(port, 'GET', '/help/');
    expect(bareHost.status).toBe(200);
    expect(bareHost.body).toContain('超级错题本');

    const oldHost = await request(port, 'GET', '/help/', 'help.pccoding666.com');
    expect(oldHost.status).toBe(200);
    expect(oldHost.body).toContain('打开学习页');

    const head = await request(port, 'HEAD', '/help/', 'study.pccoding666.com');
    expect(head.status).toBe(200);
    expect(head.type).toContain('text/html');
    expect(head.body).toBe('');

    const slash = await request(port, 'GET', '/help', 'study.pccoding666.com');
    expect(slash.status).toBe(301);
    expect(slash.location).toBe('/help/');
    expect(slash.body).not.toContain('打开学习页');

    const slashQuery = await request(port, 'GET', '/help?from=start', 'study.pccoding666.com');
    expect(slashQuery.status).toBe(301);
    expect(slashQuery.location).toBe('/help/?from=start');

    const withQuery = await request(port, 'GET', '/help/?from=start', 'study.pccoding666.com');
    expect(withQuery.status).toBe(200);
    expect(withQuery.body).toContain('超级错题本');

    const studyRoot = await request(port, 'GET', '/', 'study.pccoding666.com');
    expect(studyRoot.status).toBe(404);
    expect(studyRoot.type).toContain('application/json');
    expect(studyRoot.body).toContain('not_found');

    const oldHostRoot = await request(port, 'GET', '/', 'help.pccoding666.com');
    expect(oldHostRoot.status).toBe(404);
    expect(oldHostRoot.type).toContain('application/json');
    expect(oldHostRoot.body).not.toContain('打开学习页');

    const localRoot = await request(port, 'GET', '/');
    expect(localRoot.status).toBe(404);
    expect(localRoot.type).toContain('application/json');

    const student = await request(port, 'GET', '/s/', 'study.pccoding666.com');
    expect(student.status).toBe(404);
    expect(student.type).toContain('application/json');
    expect(student.body).not.toContain('打开学习页');

    const studentHelp = await request(port, 'GET', '/s/help', 'study.pccoding666.com');
    expect(studentHelp.status).toBe(404);
    expect(studentHelp.body).not.toContain('打开学习页');

    const extra = await request(port, 'GET', '/help/extra', 'study.pccoding666.com');
    expect(extra.status).toBe(404);
    expect(extra.type).toContain('application/json');
    expect(extra.body).not.toContain('打开学习页');

    const health = await request(port, 'GET', '/v1/health', 'study.pccoding666.com');
    expect(health.status).toBe(401);
    expect(health.type).toContain('application/json');

    const posted = await request(port, 'POST', '/help/', 'study.pccoding666.com');
    expect(posted.status).toBe(404);
    expect(posted.type).toContain('application/json');

    const postedBare = await request(port, 'POST', '/help', 'study.pccoding666.com');
    expect(postedBare.status).toBe(404);
    expect(postedBare.type).toContain('application/json');
  });
});
