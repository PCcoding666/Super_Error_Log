/** Real browser acceptance of invitations; only synthetic, isolated students. */
import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { expect, test } from '@playwright/test';

let base: string;
let codes: string[];
let child: ChildProcess;

test.beforeAll(async () => {
  child = fork(path.resolve('tests/e2e/studentHostServer.ts'), [], { execArgv: ['--import', 'tsx'], env: { ...process.env, NODE_ENV: 'test', SEL_AI_MODE: 'mock' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const ready = await new Promise<{ base: string; codes: string[] }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('browser fixture startup timed out')), 20000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('browser fixture exited during startup')); });
    child.once('message', message => { clearTimeout(timer); resolve(message as { base: string; codes: string[] }); });
  });
  base = ready.base;
  codes = ready.codes;
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
