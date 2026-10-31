/** Real browser acceptance of invitations; only synthetic, isolated students. */
import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { expect, test } from '@playwright/test';

let base: string;
let codes: string[];
let expiringCode: string;
let linkCode: string;
let child: ChildProcess;
const WECHAT_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50(0x1800322f) NetType/WIFI Language/zh_CN';

test.beforeAll(async () => {
  child = fork(path.resolve('tests/e2e/studentHostServer.ts'), [], { execArgv: ['--import', 'tsx'], env: { ...process.env, NODE_ENV: 'test', SEL_AI_MODE: 'mock' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const ready = await new Promise<{ base: string; codes: string[]; expiringCode: string; linkCode: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('browser fixture startup timed out')), 20000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('browser fixture exited during startup')); });
    child.once('message', message => { clearTimeout(timer); resolve(message as { base: string; codes: string[]; expiringCode: string; linkCode: string }); });
  });
  base = ready.base;
  codes = ready.codes;
  expiringCode = ready.expiringCode;
  linkCode = ready.linkCode;
});

test.afterAll(async () => {
  if (!child || child.exitCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    if (child.connected) child.send({ stop: true }, () => {}); else child.kill('SIGTERM');
  });
});

test('mobile invitation login, compact settings, connection retry, logout, and offline privacy', async ({ browser, page, context }, info) => {
  await page.goto(base + '/s/');
  await expect(page.getByRole('heading', { name: '输入邀请码' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('invite-login.png'), fullPage: true });
  // 未登录也必须能拿到真正的带指纹 CSS/JS；不能把登录 HTML 当作资源缓存。
  const assets = await page.locator('link[rel=stylesheet],script[src]').evaluateAll(nodes => nodes.map(n => n.getAttribute('href') ?? n.getAttribute('src')!));
  expect(assets).toHaveLength(2);
  for (const asset of assets) {
    expect(asset).toMatch(/\/s\/assets\/app\.[0-9a-f]{10}\.(css|js)$/);
    const response = await page.request.get(base + asset);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain(asset.endsWith('.css') ? 'text/css' : 'javascript');
    expect(response.headers()['cache-control']).toContain('immutable');
  }
  await expect(page.locator('html')).toHaveClass(/js/);
  await page.getByLabel('12 位邀请码').fill('wrong');
  await page.getByRole('button', { name: '进入我的错题本' }).click();
  await expect(page.getByText('这个邀请码进不去')).toBeVisible();
  await page.getByLabel('12 位邀请码').fill(codes[0]!);
  await page.getByRole('button', { name: '进入我的错题本' }).click();
  await page.goto(base + '/s/settings');
  await expect(page.getByRole('heading', { name: '设置' })).toBeVisible();
  await expect(page.getByTestId('account-role')).toHaveText('学生');
  await expect(page.getByTestId('connection-ok')).toHaveText('已连接');
  await expect(page.getByRole('radio')).toHaveCount(0);
  await expect(page.getByTestId('next-step-bar')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '错题本', exact: true })).toBeVisible();

  await context.setOffline(true);
  await expect(page.getByTestId('connection-ok')).toHaveText('连接失败');
  await expect(page.getByRole('button', { name: '重试', exact: true })).toBeVisible();
  await context.setOffline(false);
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByTestId('connection-ok')).toHaveText('已连接');
  await expect(page.getByRole('button', { name: '重试', exact: true })).toBeHidden();

  // 能联网也可能连不上服务；503 时保留重试，恢复后才显示已连接。
  await page.route('**/s/settings', route => route.request().method() === 'HEAD'
    ? route.fulfill({ status: 503, body: '' }) : route.continue());
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByTestId('connection-ok')).toHaveText('连接失败');
  await expect(page.getByRole('button', { name: '重试', exact: true })).toBeEnabled();
  await page.unroute('**/s/settings');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByTestId('connection-ok')).toHaveText('已连接');

  const b = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const other = await b.newPage();
    await other.goto(base + '/s/');
    await other.getByLabel('12 位邀请码').fill(codes[1]!);
    await other.getByRole('button', { name: '进入我的错题本' }).click();
    await other.goto(base + '/s/settings');
    await expect(other.getByTestId('account-role')).toHaveText('管理员');
    await expect(other.getByText('专属功能后续开放', { exact: false })).toHaveCount(0);
    await expect(other.getByRole('radio')).toHaveCount(0);
    await expect(other.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('student-settings.png'), fullPage: true });

    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '输入邀请码' })).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId('connection-ok')).toHaveCount(0);
    await page.goto(base + '/s/settings');
    await expect(page.getByRole('heading', { name: '输入邀请码' })).toBeVisible();
    // Wait for the static offline shell; student pages must never be cached.
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByTestId('offline-title')).toBeVisible();
    await expect(page.getByTestId('connection-ok')).toHaveCount(0);
  } finally {
    await context.setOffline(false);
    await b.close();
  }
});


test('name, phone and recovery-code registration works without JavaScript; the code works after logout and can be recovered', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    await page.goto(base + '/s/');
    await page.getByRole('link', { name: '首次使用，注册账号' }).click();
    await expect(page.getByRole('heading', { name: '注册账号' })).toBeVisible();
    await expect(page.getByLabel('注册码（8 位，老师发的）')).toHaveCount(0);
    await page.getByLabel('学生姓名（可以写化名）').fill('合成浏览器学生');
    await page.getByLabel('手机号', { exact: true }).fill('+6587654321');
    await page.getByLabel('设一个找回码（4 位数字）').fill('2580');
    await page.getByRole('button', { name: '注册并生成邀请码' }).click();
    await expect(page.getByRole('heading', { name: '注册成功' })).toBeVisible();
    const code = (await page.getByTestId('registered-invite-code').textContent())!;
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(page.url()).not.toContain(code);
    await page.getByRole('button', { name: '我已保存，进入错题本' }).click();
    await page.goto(base + '/s/settings');
    await expect(page.getByTestId('account-role')).toHaveText('学生');
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await page.getByLabel('12 位邀请码').fill(code);
    await page.getByRole('button', { name: '进入我的错题本' }).click();
    await page.goto(base + '/s/settings');
    await expect(page.getByRole('heading', { name: '设置' })).toBeVisible();
    await expect(page.getByTestId('account-role')).toHaveText('学生');
    // 忘了邀请码：用姓名、手机号和找回码换新码，旧码作废。
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await page.getByTestId('recover-link').click();
    await expect(page.getByRole('heading', { name: '找回邀请码' })).toBeVisible();
    await page.getByLabel('学生姓名（和注册时一样）').fill('合成浏览器学生');
    await page.getByLabel('手机号', { exact: true }).fill('+65 8765 4321');
    await page.getByLabel('找回码（4 位数字）').fill('2580');
    await page.getByRole('button', { name: '找回邀请码' }).click();
    await expect(page.getByRole('heading', { name: '找回成功' })).toBeVisible();
    const recovered = (await page.getByTestId('registered-invite-code').textContent())!;
    expect(recovered).not.toBe(code);
    await page.goto(base + '/s/');
    await page.getByLabel('12 位邀请码').fill(code);
    await page.getByRole('button', { name: '进入我的错题本' }).click();
    await expect(page.getByText('这个邀请码进不去')).toBeVisible();
    await page.getByLabel('12 位邀请码').fill(recovered);
    await page.getByRole('button', { name: '进入我的错题本' }).click();
    await page.goto(base + '/s/settings');
    await expect(page.getByTestId('account-role')).toHaveText('学生');
  } finally { await context.close(); }
});

test('registration refuses an easy-to-guess recovery code on the server too, and there is no privacy-rules page', async ({ page }) => {
  await page.goto(base + '/s/register');
  await expect(page.getByRole('link', { name: '《个人信息处理规则》' })).toHaveCount(0);
  // 绕过浏览器端的格式检查，确认服务端也拦。
  await page.locator('#register-form').evaluate(form => form.setAttribute('novalidate', ''));
  await page.getByLabel('学生姓名（可以写化名）').fill('合成无码学生');
  await page.getByLabel('手机号', { exact: true }).fill('+6587650000');
  await page.getByLabel('设一个找回码（4 位数字）').fill('1234');
  await page.getByRole('button', { name: '注册并生成邀请码' }).click();
  await expect(page.getByTestId('register-pin-error')).toContainText('请设一个 4 位数字的找回码');
  await expect(page.getByTestId('problem')).toContainText('请设一个 4 位数字的找回码');
  await expect(page.getByTestId('registered-invite-code')).toHaveCount(0);
  await expect(page.getByTestId('offline-title')).toHaveCount(0);
  await page.goto(base + '/s/privacy');
  await expect(page.getByRole('heading', { name: '个人信息处理规则' })).toHaveCount(0);
});

test('empty or easy recovery code is marked on the field without leaving the register page', async ({ page }) => {
  await page.goto(base + '/s/register');
  await page.getByLabel('学生姓名（可以写化名）').fill('pctest002');
  await page.getByLabel('手机号', { exact: true }).fill('18924082429');
  await page.getByRole('button', { name: '注册并生成邀请码' }).click();
  await expect(page).toHaveURL(/\/s\/register$/);
  // 没有整页提交：上面不会出现服务器的「暂时没能注册」，红字就在找回码下面。
  await expect(page.getByTestId('problem')).toHaveCount(0);
  await expect(page.getByTestId('register-pin-error')).toBeVisible();
  await expect(page.getByTestId('register-pin-error')).toContainText('4 位数字');
  await expect(page.getByTestId('next-step-caption')).toContainText('找回码');
  await expect(page.getByTestId('offline-title')).toHaveCount(0);
  await expect(page.locator('#register-pin')).toBeFocused();

  await page.getByLabel('设一个找回码（4 位数字）').fill('4567');
  await page.getByRole('button', { name: '注册并生成邀请码' }).click();
  await expect(page).toHaveURL(/\/s\/register$/);
  await expect(page.getByTestId('problem')).toHaveCount(0);
  await expect(page.getByLabel('设一个找回码（4 位数字）')).toHaveValue('4567');
  await expect(page.getByTestId('register-pin-error')).toContainText('1234、0000');
  await expect(page.getByTestId('registered-invite-code')).toHaveCount(0);

  await page.getByLabel('手机号', { exact: true }).fill('002');
  await page.getByLabel('设一个找回码（4 位数字）').fill('2580');
  await page.getByRole('button', { name: '注册并生成邀请码' }).click();
  await expect(page).toHaveURL(/\/s\/register$/);
  await expect(page.getByTestId('problem')).toHaveCount(0);
  await expect(page.getByLabel('手机号', { exact: true })).toHaveValue('002');
  await expect(page.getByTestId('register-phone-error')).toBeVisible();
  await expect(page.getByTestId('register-phone-error')).toContainText('有效手机号');
  await expect(page.locator('#register-phone')).toBeFocused();
});

test('a controlled service worker still shows register validation instead of the offline page', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage();
    await page.goto(base + '/s/register');
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    // 客户端会先拦住好猜的码；关掉它，确认服务端的 400 也不会被 Service Worker 换成离线页。
    await page.locator('#register-form').evaluate(form => form.setAttribute('novalidate', ''));
    await page.getByLabel('学生姓名（可以写化名）').fill('pctest002');
    await page.getByLabel('手机号', { exact: true }).fill('18924082429');
    await page.getByLabel('设一个找回码（4 位数字）').fill('4567');
    await page.getByRole('button', { name: '注册并生成邀请码' }).click();
    await expect(page.getByTestId('offline-title')).toHaveCount(0);
    await expect(page.getByTestId('register-pin-error')).toBeVisible();
    await expect(page.getByTestId('problem')).toContainText('4 位数字');
    await expect(page.getByLabel('学生姓名（可以写化名）')).toHaveValue('pctest002');
    await page.getByLabel('设一个找回码（4 位数字）').fill('2580');
    await page.getByRole('button', { name: '注册并生成邀请码' }).click();
    await expect(page.getByRole('heading', { name: '注册成功' })).toBeVisible();
    await expect(page.getByTestId('offline-title')).toHaveCount(0);
  } finally { await context.close(); }
});

test('WeChat in-app browser sees an "open in browser" hint on login and registration', async ({ browser }, info) => {
  const context = await browser.newContext({ userAgent: WECHAT_UA, viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    await page.goto(base + '/s/');
    await expect(page.getByTestId('in-app-browser-notice')).toContainText('在浏览器打开');
    await page.screenshot({ path: info.outputPath('wechat-login.png'), fullPage: true });
    await page.goto(base + '/s/register');
    await expect(page.getByTestId('in-app-browser-notice')).toContainText('先截图或复制保存');
  } finally { await context.close(); }
  const plain = await browser.newPage();
  await plain.goto(base + '/s/');
  await expect(plain.getByTestId('in-app-browser-notice')).toHaveCount(0);
  await plain.close();
});

test('a login link with ?code= prefills the code; nothing is redeemed until one tap; my invite code shows the same link as a QR', async ({ browser }, info) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    await page.goto(`${base}/s/?code=${linkCode}`);
    await expect(page.getByRole('heading', { name: '输入邀请码' })).toBeVisible();
    await expect(page.getByLabel('12 位邀请码')).toHaveValue(linkCode);
    await expect(page.getByTestId('prefill-lead')).toContainText('已经从链接里填好');
    // 打开链接只是预览：没有会话 cookie
    expect((await context.cookies()).some(cookie => cookie.name === 'sel_student')).toBe(false);
    await page.screenshot({ path: info.outputPath('invite-link-prefilled.png'), fullPage: true });
    await page.getByRole('button', { name: '进入我的错题本' }).click();
    await expect(page).not.toHaveURL(/code=/);
    expect((await context.cookies()).some(cookie => cookie.name === 'sel_student')).toBe(true);
    await page.goto(base + '/s/settings');
    await expect(page.getByRole('heading', { name: '设置' })).toBeVisible();
    await page.getByTestId('settings-my-invite').click();
    await expect(page.getByRole('heading', { name: '我的邀请码' })).toBeVisible();
    await expect(page.getByTestId('my-invite-code')).toHaveText(linkCode);
    await expect(page.getByTestId('my-invite-link')).toHaveText(`${base}/s/?code=${linkCode}`);
    await expect(page.getByTestId('my-invite-qr')).toBeVisible();
    await expect(page.getByTestId('my-invite-link-copy')).toBeVisible();
    await page.screenshot({ path: info.outputPath('my-invite-link-qr.png'), fullPage: true });
    // 已登录的手机再打开带码链接：还是登录页（说明会换账号），没有自动换
    await page.goto(`${base}/s/?code=${linkCode}`);
    await expect(page.getByRole('heading', { name: '输入邀请码' })).toBeVisible();
    await expect(page.getByTestId('prefill-lead')).toContainText('原来的账号在这台手机上退出');
  } finally { await context.close(); }
});

test('WeChat with a code link: step-by-step guidance, and "copy URL" copies the link with the code', async ({ browser }, info) => {
  const context = await browser.newContext({ userAgent: WECHAT_UA, viewport: { width: 390, height: 844 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  try {
    const page = await context.newPage();
    await page.goto(`${base}/s/?code=${linkCode}`);
    await expect(page.getByTestId('in-app-browser-steps')).toContainText('右上角「…」');
    await expect(page.getByTestId('in-app-browser-steps')).toContainText('在浏览器打开');
    await expect(page.getByLabel('12 位邀请码')).toHaveValue(linkCode);
    await page.screenshot({ path: info.outputPath('wechat-login-link.png'), fullPage: true });
    await page.getByTestId('in-app-copy-url').click();
    await expect(page.getByText('已复制。')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${base}/s/?code=${linkCode}`);
    expect((await context.cookies()).some(cookie => cookie.name === 'sel_student')).toBe(false);
  } finally { await context.close(); }
});

test('settings warns about an expiring code; my invite code can be viewed, copied and regenerated', async ({ browser }, info) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  try {
    const page = await context.newPage();
    await page.goto(base + '/s/');
    await page.getByLabel('12 位邀请码').fill(expiringCode);
    await page.getByRole('button', { name: '进入我的错题本' }).click();
    await page.goto(base + '/s/settings');
    await expect(page.getByTestId('invite-expiring')).toContainText('天后');
    await page.screenshot({ path: info.outputPath('settings-invite-expiring.png'), fullPage: true });
    await page.getByTestId('settings-my-invite').click();
    await expect(page.getByRole('heading', { name: '我的邀请码' })).toBeVisible();
    await expect(page.getByTestId('my-invite-code')).toHaveText(expiringCode);
    await page.getByTestId('my-invite-code-copy').click();
    await expect(page.getByText('已复制。')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expiringCode);
    await page.goto(base + '/s/settings');
    await page.getByTestId('regenerate-invitation').click();
    await expect(page.getByTestId('flash-ok')).toContainText('已经换成新邀请码');
    const fresh = (await page.getByTestId('my-invite-code').textContent())!;
    expect(fresh).not.toBe(expiringCode);
    await expect(page.getByTestId('invite-expiring')).toHaveCount(0);
    await page.goto(base + '/s/settings');
    await expect(page.getByTestId('invite-expiring')).toHaveCount(0);
    // 旧码已作废，新码能在另一台设备登录
    const other = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const second = await other.newPage();
      await second.goto(base + '/s/');
      await second.getByLabel('12 位邀请码').fill(expiringCode);
      await second.getByRole('button', { name: '进入我的错题本' }).click();
      await expect(second.getByText('这个邀请码进不去')).toBeVisible();
      await second.getByLabel('12 位邀请码').fill(fresh);
      await second.getByRole('button', { name: '进入我的错题本' }).click();
      await second.goto(base + '/s/settings');
      await expect(second.getByRole('heading', { name: '设置' })).toBeVisible();
    } finally { await other.close(); }
  } finally { await context.close(); }
});

test('P1-9: the service worker shows server answers as they are and the offline page only without a network', async ({ browser }) => {
  // A tiny stand-in for the reverse proxy: pass through, answer an empty 502 (app restarting),
  // answer the app's own 503 body, or drop the connection (no network).
  const http = await import('node:http');
  let mode: 'pass' | 'empty502' | 'body503' | 'down' = 'pass';
  const upstream = new URL(base);
  const proxy = http.createServer((req, res) => {
    if (mode === 'down') { req.socket.destroy(); return; }
    if (mode === 'empty502' && req.headers['sec-fetch-mode'] === 'navigate') { res.writeHead(502, { 'content-length': '0' }); res.end(); return; }
    if (mode === 'body503' && req.headers['sec-fetch-mode'] === 'navigate') { res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'retry-after': '30' }); res.end('<!doctype html><title>人有点多</title><h1 data-testid="busy-title">人有点多</h1>'); return; }
    const forward = http.request({ host: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers: req.headers }, r => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    forward.on('error', () => { if (!res.headersSent) { res.writeHead(502, { 'content-length': '0' }); res.end(); } else res.destroy(); });
    req.pipe(forward);
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const front = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    await page.goto(front + '/s/');
    await page.getByLabel('12 位邀请码').fill(codes[0]!);
    await page.getByRole('button', { name: '进入我的错题本' }).click();
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

    mode = 'body503';
    await page.goto(front + '/s/settings');
    await expect(page.getByTestId('busy-title')).toBeVisible();
    await expect(page.getByTestId('offline-title')).toHaveCount(0);

    mode = 'empty502';
    await page.goto(front + '/s/settings');
    await expect(page.getByTestId('updating-title')).toHaveText('服务器正在更新');
    await expect(page.getByText('还没传完的照片先存在这台手机上')).toBeVisible();
    expect(await page.locator('meta[http-equiv="refresh"]').getAttribute('content')).toBe('15');
    await expect(page.getByTestId('offline-title')).toHaveCount(0);
    mode = 'pass';
    await page.getByRole('link', { name: '现在重试' }).click();
    await expect(page.getByRole('heading', { name: '设置' })).toBeVisible();

    mode = 'down';
    await page.goto(front + '/s/settings').catch(() => undefined);
    await expect(page.getByTestId('offline-title')).toBeVisible();
    await expect(page.getByText('还没传完的照片先存在这台手机上')).toBeVisible();
  } finally {
    await context.close();
    await new Promise<void>(resolve => { proxy.closeAllConnections(); proxy.close(() => resolve()); });
  }
});
