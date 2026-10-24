/**
 * help.pccoding666.com 的公开说明页。
 * 只在该 Host 的 GET / 返回 HTML。study 主机名、其它路径（含 /s）保持原样。
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
import { HELP_PORTAL_HOSTNAME, helpPortalHtml, isHelpPortalHost } from '../../src/portal/helpPortal.js';

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

function request(port: number, method: string, urlPath: string, host?: string): Promise<{ status: number; type: string; cache: string; body: string }> {
  return new Promise((resolve, reject) => {
    const headers = host ? { host } : undefined;
    const req = http.request({ hostname: '127.0.0.1', port, method, path: urlPath, headers }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk as Buffer));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        type: String(response.headers['content-type'] ?? ''),
        cache: String(response.headers['cache-control'] ?? ''),
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

  it('用中文写清产品、一周用法、学习页、占位联系方式和 GitHub', () => {
    expect(html).toContain('产品是什么');
    expect(html).toContain('怎么用');
    expect(html).toContain('周末拍卷');
    expect(html).toContain('收进错题本');
    expect(html).toContain('打印练习');
    expect(html).toContain('工作日纸上做');
    expect(html).toContain('下周末记结果');
    expect(html).toContain('href="https://study.pccoding666.com/s/"');
    expect(html).toContain('开始使用');
    expect(html).toContain('>邮箱<');
    expect(html).toContain('>微信<');
    expect(html.match(/待补充/g)?.length).toBe(2);
    expect(html).toContain('https://github.com/PCcoding666/Super_Error_Log');
    expect(html).not.toContain('sel.pccoding666.com');
    expect(HELP_PORTAL_HOSTNAME).toBe('help.pccoding666.com');
  });

  it('只把 help.pccoding666.com（可带端口）认作说明站', () => {
    expect(isHelpPortalHost('help.pccoding666.com')).toBe(true);
    expect(isHelpPortalHost('Help.PCCoding666.com:443')).toBe(true);
    expect(isHelpPortalHost('help.pccoding666.com:3101')).toBe(true);
    expect(isHelpPortalHost('study.pccoding666.com')).toBe(false);
    expect(isHelpPortalHost('127.0.0.1:3101')).toBe(false);
    expect(isHelpPortalHost('localhost')).toBe(false);
    expect(isHelpPortalHost('help.pccoding666.com.evil.test')).toBe(false);
    expect(isHelpPortalHost('nothelp.pccoding666.com')).toBe(false);
    expect(isHelpPortalHost('help.pccoding666.com:abc')).toBe(false);
    expect(isHelpPortalHost(undefined)).toBe(false);
    expect(isHelpPortalHost('')).toBe(false);
  });
});

describe('说明页路由不占用学生学习站', () => {
  it('help 主机的 GET / 是说明页；study、/s、/v1 仍走原路由', async () => {
    const port = await listen();

    const portal = await request(port, 'GET', '/', 'help.pccoding666.com');
    expect(portal.status).toBe(200);
    expect(portal.type).toContain('text/html');
    expect(portal.cache).toContain('public');
    expect(portal.body).toContain('周末拍卷');
    expect(portal.body).toContain('href="https://study.pccoding666.com/s/"');

    const withPort = await request(port, 'GET', '/', 'help.pccoding666.com:443');
    expect(withPort.status).toBe(200);
    expect(withPort.body).toContain('超级错题本');

    const study = await request(port, 'GET', '/', 'study.pccoding666.com');
    expect(study.status).toBe(404);
    expect(study.type).toContain('application/json');
    expect(study.body).toContain('not_found');

    const local = await request(port, 'GET', '/');
    expect(local.status).toBe(404);
    expect(local.type).toContain('application/json');

    const student = await request(port, 'GET', '/s/', 'help.pccoding666.com');
    expect(student.status).toBe(404);
    expect(student.type).toContain('application/json');
    expect(student.body).not.toContain('周末拍卷');

    const studentOnStudy = await request(port, 'GET', '/s/', 'study.pccoding666.com');
    expect(studentOnStudy.status).toBe(404);
    expect(studentOnStudy.type).toContain('application/json');

    const health = await request(port, 'GET', '/v1/health', 'help.pccoding666.com');
    expect(health.status).toBe(401);
    expect(health.type).toContain('application/json');

    const posted = await request(port, 'POST', '/', 'help.pccoding666.com');
    expect(posted.status).toBe(404);
    expect(posted.type).toContain('application/json');
  });
});
