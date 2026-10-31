/**
 * 公开说明页在 /help/，不看 Host。
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
import { HELP_PORTAL_PATH, helpPortalHtml, readHelpContact } from '../../src/portal/helpPortal.js';

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

function request(port: number, method: string, urlPath: string, host?: string): Promise<{ status: number; type: string; cache: string; location: string; body: string }> {
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
  const html = helpPortalHtml({});

  it('用中文写清产品、一周用法、学习页和 GitHub；没配联系方式时不出现占位符', () => {
    expect(HELP_PORTAL_PATH).toBe('/help/');
    expect(html).toContain('href="https://study.pccoding666.com/help/"');
    expect(html).toContain('href="/help/"');
    expect(html).toContain('产品是什么');
    expect(html).toContain('怎么用');
    expect(html).toContain('周末拍卷');
    expect(html).toContain('收进错题本');
    expect(html).toContain('打印练习');
    expect(html).toContain('工作日纸上做');
    expect(html).toContain('下周末记结果');
    expect(html).toContain('href="https://study.pccoding666.com/s/"');
    expect(html).toContain('开始使用');
    expect(html).not.toContain('待补充');
    expect(html).not.toContain('>邮箱<');
    expect(html).not.toContain('>微信<');
    expect(html).toContain('data-contact="none"');
    expect(html).toContain('https://github.com/PCcoding666/Super_Error_Log');
    expect(html).not.toContain('sel.pccoding666.com');
    expect(html).not.toContain('help.pccoding666.com');
  });

  it('「开始使用」是三步：扫码或点链接 → 进入错题本 → 拍一张批改过的卷子；附 iPhone Safari 与安卓 Chrome 的添加到主屏幕步骤', () => {
    const start = /<h2 id="start">[\s\S]*?<h2 id="contact">/.exec(html)![0];
    expect(start).toContain('data-testid="start-steps"');
    expect(start.match(/<li><strong><span>0\d<\/span>/g)?.length).toBe(3);
    expect(start).toContain('扫码或点链接');
    expect(start).toContain('邀请码已经填好');
    expect(start).toContain('进入错题本');
    expect(start).toContain('在浏览器打开');
    expect(start).toContain('拍一张批改过的卷子');
    expect(start).toContain('<h3 id="install">放到手机桌面</h3>');
    expect(start).toContain('iPhone · Safari');
    expect(start).toContain('添加到主屏幕');
    expect(start).toContain('安卓 · Chrome');
    expect(html).toContain('<a href="#install">放到手机桌面</a>');
    // 说明页不含任何邀请码或带码链接的样子
    expect(html).not.toMatch(/code=[A-Z0-9]{4}-/);
  });

  it('联系方式只从环境变量读：设了哪项显示哪项，HTML 转义，邮箱可点；代码里没有个人信息', () => {
    expect(readHelpContact({})).toEqual({ wechat: undefined, email: undefined });
    expect(readHelpContact({ SEL_HELP_CONTACT_WECHAT: '  ', SEL_HELP_CONTACT_EMAIL: '' })).toEqual({ wechat: undefined, email: undefined });
    const contact = readHelpContact({ SEL_HELP_CONTACT_WECHAT: 'teacher_wx_<test>', SEL_HELP_CONTACT_EMAIL: 'help@example.com' });
    expect(contact).toEqual({ wechat: 'teacher_wx_<test>', email: 'help@example.com' });
    const both = helpPortalHtml(contact);
    expect(both).toContain('<dt>邮箱</dt><dd data-contact="email"><a href="mailto:help@example.com">help@example.com</a></dd>');
    expect(both).toContain('<dt>微信</dt><dd data-contact="wechat">teacher_wx_&lt;test&gt;</dd>');
    expect(both).not.toContain('teacher_wx_<test>');
    expect(both).not.toContain('data-contact="none"');
    const onlyWechat = helpPortalHtml({ wechat: 'teacher_wx' });
    expect(onlyWechat).toContain('<dt>微信</dt>');
    expect(onlyWechat).not.toContain('<dt>邮箱</dt>');
    const oddEmail = helpPortalHtml({ email: '发邮件到 help at example dot com' });
    expect(oddEmail).toContain('<dd data-contact="email">发邮件到 help at example dot com</dd>');
    expect(oddEmail).not.toContain('mailto:');
  });
});

describe('说明页在 /help/，不占用学生学习站，也不看 Host', () => {
  it('GET /help/ 是说明页；/help 跳到 /help/；根路径、/s、/v1 仍走原路由', async () => {
    const port = await listen();

    const portal = await request(port, 'GET', '/help/', 'study.pccoding666.com');
    expect(portal.status).toBe(200);
    expect(portal.type).toContain('text/html');
    expect(portal.cache).toContain('public');
    expect(portal.body).toContain('周末拍卷');
    expect(portal.body).toContain('href="https://study.pccoding666.com/s/"');
    expect(portal.body).toContain('href="/help/"');

    const bareHost = await request(port, 'GET', '/help/');
    expect(bareHost.status).toBe(200);
    expect(bareHost.body).toContain('超级错题本');

    const oldHost = await request(port, 'GET', '/help/', 'help.pccoding666.com');
    expect(oldHost.status).toBe(200);
    expect(oldHost.body).toContain('周末拍卷');

    const head = await request(port, 'HEAD', '/help/', 'study.pccoding666.com');
    expect(head.status).toBe(200);
    expect(head.type).toContain('text/html');
    expect(head.body).toBe('');

    const slash = await request(port, 'GET', '/help', 'study.pccoding666.com');
    expect(slash.status).toBe(301);
    expect(slash.location).toBe('/help/');
    expect(slash.body).not.toContain('周末拍卷');

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
    expect(oldHostRoot.body).not.toContain('周末拍卷');

    const localRoot = await request(port, 'GET', '/');
    expect(localRoot.status).toBe(404);
    expect(localRoot.type).toContain('application/json');

    const student = await request(port, 'GET', '/s/', 'study.pccoding666.com');
    expect(student.status).toBe(404);
    expect(student.type).toContain('application/json');
    expect(student.body).not.toContain('周末拍卷');

    const studentHelp = await request(port, 'GET', '/s/help', 'study.pccoding666.com');
    expect(studentHelp.status).toBe(404);
    expect(studentHelp.body).not.toContain('周末拍卷');

    const extra = await request(port, 'GET', '/help/extra', 'study.pccoding666.com');
    expect(extra.status).toBe(404);
    expect(extra.type).toContain('application/json');
    expect(extra.body).not.toContain('周末拍卷');

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
