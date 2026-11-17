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
import { HELP_PORTAL_PATH, helpPortalHtml, readHelpContact, readHelpImage } from '../../src/portal/helpPortal.js';

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

  it('用中文写清自己注册、拍照、收题、单页多页和学习页；没配联系方式时不出现占位符', () => {
    expect(HELP_PORTAL_PATH).toBe('/help/');
    expect(html).toContain('href="https://study.pccoding666.com/help/"');
    expect(html).toContain('href="/help/"');
    expect(html).toContain('产品是什么');
    expect(html).toContain('第一次用');
    expect(html).toContain('经常用');
    expect(html).toContain('遇到问题');
    expect(html).toContain('拍卷子');
    expect(html).toContain('收进错题本');
    expect(html).toContain('单页');
    expect(html).toContain('多页');
    expect(html).toContain('点「新增」');
    expect(html).toContain('点「开始」');
    expect(html).not.toContain('iPhone 的系统菜单');
    expect(html).not.toContain('上方还有「单页 / 多页」');
    expect(html).not.toContain('放弃这组');
    expect(html).not.toContain('一次最多 8 页');
    expect(html).not.toContain('/s/practices');
    expect(html).not.toContain('练习');
    expect(html).not.toContain('即将推出');
    expect(html).not.toContain('示意图');
    expect(html).not.toContain('合成');
    expect(html).not.toContain('应用里的说明');
    expect(html).not.toContain('最快的三步');
    expect(html).not.toContain('老师给你');
    expect(html).not.toContain('开始使用');
    expect(html).toContain('去注册');
    expect(html).toContain('添加到桌面');
    expect(html).toContain('添加到主屏幕');
    expect(html).toContain('桌面图标会打开浏览器页面');
    expect(html).not.toContain('manifest');
    expect(html).not.toContain('Service Worker');
    expect(html).not.toContain('standalone');
    expect(html).toContain('https://study.pccoding666.com/s/register');
    expect(html).toContain('https://study.pccoding666.com/s/recover');
    expect(html).toContain('找回码跟手机号仅用于找回账户');
    expect(html).not.toContain('查看或换邀请码');
    expect(html).not.toContain('在「设置 → 我的邀请码」可以查看、复制，或重新生成');
    expect(html).toContain('超级错题本天使用户');
    expect(html).toContain('2026 年 11 月 23 日前有效');
    expect(html).toContain('/help/img/wechat-group.webp');
    expect(html).not.toContain('/help/img/account.webp');
    expect(html).not.toContain('/help/img/intake-auto.webp');
    expect(html).not.toContain('/help/img/install.webp');
    expect(html).not.toContain('/help/img/settings.webp');
    expect(html).not.toContain('/help/img/stage.webp');
    expect(html).toContain('href="https://study.pccoding666.com/s/"');
    expect(html).not.toContain('待补充');
    expect(html).not.toContain('>邮箱<');
    expect(html).not.toContain('>微信<');
    expect(html).toContain('data-contact="none"');
    expect(html).toContain('https://github.com/PCcoding666/Super_Error_Log');
    expect(html).not.toContain('sel.pccoding666.com');
    expect(html).not.toContain('help.pccoding666.com');
    for (const word of ['周末', '工作日', '下周末', '寄宿制']) expect(html, word).not.toContain(word);
    const images = [...html.matchAll(/src="\/help\/img\/([a-z0-9-]+\.webp)"/g)].map(match => match[1]);
    expect(images.length).toBeGreaterThan(10);
    expect(new Set(images).size).toBe(images.length);
    for (const name of images) expect(readHelpImage(name!)?.length ?? 0).toBeGreaterThan(1000);
    expect(images.some(name => name?.startsWith('practice-'))).toBe(false);
    const contact = /<section id="contact">[\s\S]*?<\/section>/.exec(html)![0];
    expect(contact).not.toContain('github.com');
    expect(contact).toContain('先问老师');
  });

  it('第一次用从自己注册开始，不从老师的二维码开始；换手机才讲自己的登录链接；桌面步骤在经常用', () => {
    const start = /<section id="start">[\s\S]*?<\/section>/.exec(html)![0];
    expect(start).toContain('data-testid="start-steps"');
    expect(start).toContain('拍一张批改过的卷子');
    expect(start).toContain('找回码跟手机号仅用于找回账户');
    expect(start).toContain('点「新增」');
    expect(start).toContain('单页');
    expect(start).toContain('多页');
    expect(start).toContain('收进错题本');
    expect(start).toContain('以照片为准');
    expect(start).not.toContain('二维码');
    expect(start).not.toContain('老师给你');
    expect(start).not.toContain('老师的二维码');
    expect(start).not.toContain('查看或换邀请码');
    const use = /<section id="use">[\s\S]*?<\/section>/.exec(html)![0];
    expect(use).toContain('Safari');
    expect(use).toContain('添加到主屏幕');
    expect(use).toContain('Chrome');
    expect(use).toContain('添加到桌面');
    expect(use).toContain('/help/img/iphone-confirm.webp');
    expect(use).toContain('/help/img/iphone-home.webp');
    expect(use).toContain('作为网页 App 打开');
    expect(use).toContain('在主屏幕上找到它');
    expect(use).toContain('超级错题本');
    expect(use).toContain('「进入我的错题本」');
    expect(html).not.toContain('loading="lazy"');
    expect(html).toContain('loading="eager"');
    const faq = /<section id="faq">[\s\S]*?<\/section>/.exec(html)![0];
    expect(faq).toContain('扫一下就能登录');
    expect(faq).toContain('登录链接和二维码');
    expect(faq).toContain('不是开学的第一步');
    expect(faq).toContain('打开链接本身不算登录');
    expect(faq).toContain('「进入我的错题本」');
    expect(faq).toContain('「复制网址」');
    expect(faq).toContain('在 Safari 中打开');
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

  it('版式跟随学生端主题，第一次用排在经常用之前，窄屏目录可收起', () => {
    expect(html).toContain('--ion-color-primary: #0066d6');
    expect(html).toContain('--ion-font-family: -apple-system, BlinkMacSystemFont, "PingFang SC"');
    expect(html).toContain('--ion-background-color: #f2f2f7');
    expect(html).toContain('--ion-item-background: #ffffff');
    expect(html).toContain('--ion-text-color: #1c1c1e');
    expect(html).toContain('--sel-muted: #6e6e73');
    expect(html).toContain('--sel-line: #e5e5ea');
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).toContain('--ion-background-color: #000000');
    expect(html).toContain('--ion-item-background: #1c1c1e');
    expect(html).toContain('--ion-text-color: #f5f5f7');
    expect(html).toContain('border-radius: 22px');
    expect(html).toContain('class="device"');
    expect(html).toContain('class="sidenav toc"');
    expect(html).toContain('<details class="toc-disclosure">');
    expect(html).toContain('<summary>目录</summary>');
    expect(html).toContain('color-scheme');
    const at = (id: string) => html.indexOf(`id="${id}"`);
    const order = ['product', 'start', 'use', 'faq', 'contact'];
    const positions = order.map(at);
    for (const pos of positions) expect(pos).toBeGreaterThan(0);
    for (let index = 1; index < positions.length; index += 1) {
      expect(positions[index], order[index]).toBeGreaterThan(positions[index - 1] ?? -1);
    }
    expect(html.indexOf('href="#start"')).toBeLessThan(html.indexOf('href="#use"'));
    expect(html.indexOf('kicker">第一次用')).toBeGreaterThan(at('product'));
    expect(html.indexOf('kicker">第一次用')).toBeLessThan(at('use'));
    expect(html).not.toContain('id="practice"');
    expect(html).not.toContain('id="home"');
  });
});

describe('说明页在 /help/，不占用学生学习站，也不看 Host', () => {
  it('GET /help/ 是说明页；/help 跳到 /help/；根路径、/s、/v1 仍走原路由', async () => {
    const port = await listen();

    const portal = await request(port, 'GET', '/help/', 'study.pccoding666.com');
    expect(portal.status).toBe(200);
    expect(portal.type).toContain('text/html');
    expect(portal.cache).toContain('public');
    expect(portal.body).toContain('拍卷子');
    const portalHeaders = await new Promise<Record<string, string | string[] | undefined>>((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, method: 'GET', path: '/help/' }, response => {
        response.resume();
        response.on('end', () => resolve(response.headers));
      });
      req.on('error', reject);
      req.end();
    });
    expect(String(portalHeaders['content-security-policy'])).toContain("img-src 'self'");

    const image = await request(port, 'GET', '/help/img/notebook-empty.webp', 'study.pccoding666.com');
    const group = await request(port, 'GET', '/help/img/wechat-group.webp', 'study.pccoding666.com');
    expect(group.status).toBe(200);
    expect(group.type).toContain('image/webp');
    expect(group.body.startsWith('RIFF')).toBe(true);
    const removed = await request(port, 'GET', '/help/img/account.webp', 'study.pccoding666.com');
    expect(removed.status).toBe(404);
    expect(image.status).toBe(200);
    expect(image.type).toContain('image/webp');
    expect(image.cache).toContain('public');
    expect(image.cache).toContain('max-age=86400');
    expect(image.body.startsWith('RIFF')).toBe(true);
    expect(image.body).toContain('WEBP');

    const missing = await request(port, 'GET', '/help/img/not-a-photo.webp', 'study.pccoding666.com');
    expect(missing.status).toBe(404);
    expect(missing.type).toContain('application/json');
    expect(missing.body).not.toContain('拍卷子');

    const traversal = await request(port, 'GET', '/help/img/..%2FhelpPortal.ts', 'study.pccoding666.com');
    expect(traversal.status).toBe(404);
    expect(traversal.body).not.toContain('拍卷子');
    expect(portal.body).toContain('href="https://study.pccoding666.com/s/"');
    expect(portal.body).toContain('href="/help/"');

    const bareHost = await request(port, 'GET', '/help/');
    expect(bareHost.status).toBe(200);
    expect(bareHost.body).toContain('超级错题本');

    const oldHost = await request(port, 'GET', '/help/', 'help.pccoding666.com');
    expect(oldHost.status).toBe(200);
    expect(oldHost.body).toContain('拍卷子');

    const head = await request(port, 'HEAD', '/help/', 'study.pccoding666.com');
    expect(head.status).toBe(200);
    expect(head.type).toContain('text/html');
    expect(head.body).toBe('');

    const slash = await request(port, 'GET', '/help', 'study.pccoding666.com');
    expect(slash.status).toBe(301);
    expect(slash.location).toBe('/help/');
    expect(slash.body).not.toContain('拍卷子');

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
    expect(oldHostRoot.body).not.toContain('拍卷子');

    const localRoot = await request(port, 'GET', '/');
    expect(localRoot.status).toBe(404);
    expect(localRoot.type).toContain('application/json');

    const student = await request(port, 'GET', '/s/', 'study.pccoding666.com');
    expect(student.status).toBe(404);
    expect(student.type).toContain('application/json');
    expect(student.body).not.toContain('拍卷子');

    const studentHelp = await request(port, 'GET', '/s/help', 'study.pccoding666.com');
    expect(studentHelp.status).toBe(404);
    expect(studentHelp.body).not.toContain('拍卷子');

    const extra = await request(port, 'GET', '/help/extra', 'study.pccoding666.com');
    expect(extra.status).toBe(404);
    expect(extra.type).toContain('application/json');
    expect(extra.body).not.toContain('拍卷子');

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
