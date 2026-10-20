import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { expect, test } from '@playwright/test';
let child: ChildProcess;
let fixture: { base: string; password: string; accounts: string[] };
test.beforeAll(async () => {
  child = fork(path.resolve('tests/e2e/adminDashboardServer.ts'), [], { execArgv: ['--import', 'tsx'],
    env: { ...process.env, NODE_ENV: 'test', SEL_AI_MODE: 'mock' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  fixture = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('admin browser fixture startup timed out')), 20000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('admin browser fixture exited during startup')); });
    child.once('message', message => { clearTimeout(timer); resolve(message as typeof fixture); });
  });
});
test.afterAll(async () => {
  if (!child || child.exitCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    if (child.connected) child.send({ stop: true }, () => {}); else child.kill('SIGTERM');
  });
});
test('administrator login, account ownership, filters, pagination and mobile layout', async ({ page, browser }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(fixture.base + '/admin/');
  await expect(page).toHaveURL(/\/admin\/login$/);
  await page.getByLabel('管理员密码', { exact: true }).fill(fixture.password);
  const submission = page.waitForRequest(request => request.url().endsWith('/admin/login') && request.method() === 'POST');
  await page.getByRole('button', { name: '进入管理后台' }).click();
  expect((await submission).headers().origin).toBe(fixture.base);
  await expect(page).toHaveTitle('用量与性能 · 纸错题管理后台');
  await expect(page.locator('#accounts .account-name')).toHaveCount(2);
  await expect(page.getByText('54 条记录')).toBeVisible();
  await page.screenshot({ path: info.outputPath('admin-desktop.png'), fullPage: true });
  await page.screenshot({ path: info.outputPath('admin-desktop-overview.png') });
  await page.getByText('查看全部邀请码对应关系', { exact: true }).click();
  await expect(page.locator('.invite-details tbody tr')).toHaveCount(4);
  await page.getByLabel('账号', { exact: true }).selectOption(fixture.accounts[0]!);
  await page.getByLabel('模型', { exact: true }).selectOption('synthetic-vision');
  await page.getByLabel('开始日期', { exact: true }).fill('2026-10-20');
  await page.getByLabel('结束日期', { exact: true }).fill('2026-10-20');
  await page.getByRole('button', { name: '应用筛选' }).click();
  await expect(page.locator('#accounts .account-name')).toHaveCount(1);
  await expect(page.getByText('51 条记录')).toBeVisible();
  await page.getByRole('link', { name: '下一页', exact: true }).click();
  await expect(page.locator('.calls-table tbody tr')).toHaveCount(1);
  await expect(page).toHaveURL(/page=2/);
  await expect(page.getByLabel('模型', { exact: true })).toHaveValue('synthetic-vision');
  await expect(page.getByLabel('账号', { exact: true })).toHaveValue(fixture.accounts[0]!);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('link', { name: '重置', exact: true }).click();
  await expect(page.getByTestId('total-tokens')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('admin-mobile.png'), fullPage: true });
  await page.screenshot({ path: info.outputPath('admin-mobile-overview.png') });
  const other = await browser.newContext();
  try {
    const anonymous = await other.newPage(); await anonymous.goto(fixture.base + '/admin/');
    await expect(anonymous.getByRole('heading', { name: '管理员登录' })).toBeVisible();
    await expect(anonymous.getByText('小林（合成示例）')).toHaveCount(0);
  } finally { await other.close(); }
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.goto(fixture.base + '/admin/');
  await expect(page.getByRole('heading', { name: '管理员登录' })).toBeVisible();
});
