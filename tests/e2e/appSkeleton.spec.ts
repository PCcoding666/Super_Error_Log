/** #127：首页和详情页在第一份数据返回前先画骨架；数据到了换成内容，出错时让位给错误提示。只用合成材料。 */
import sharp from 'sharp';
import { expect, test, type Page, type Route } from '@playwright/test';
import { materialGateway, type MaterialGateway } from '../helpers/materialGateway.js';

test.use({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });

let gateway: MaterialGateway;
test.beforeAll(async () => {
  gateway = await materialGateway({ pages: [{ parts: [{ role: 'question', number: '1', text: '1. 计算 9 + 9。' }] }] });
});
test.afterAll(async () => { await gateway.close(); });

async function login(page: Page, code: string): Promise<void> {
  await page.goto(gateway.base + '/s/');
  await page.getByLabel('12 位邀请码').fill(code);
  await page.getByRole('button', { name: '进入我的错题本' }).click();
  await page.getByRole('button', { name: '初中', exact: true }).click();
  await expect(page.getByTestId('empty-notebook')).toBeVisible();
}

/** 把匹配的接口请求扣住，调用返回的函数后才放行。 */
async function hold(page: Page, matches: (url: URL) => boolean): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(url => matches(url), async (route: Route) => { await held; await route.continue().catch(() => {}); });
  return release;
}
const isNotebook = (url: URL): boolean => url.pathname === '/s/api/notebook';
const isItem = (url: URL): boolean => /^\/s\/api\/items\/[^/]+$/.test(url.pathname);
const failed = (route: Route): Promise<void> => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: '合成的失败' } }) });

test('首页：数据返回前显示骨架，返回后换成内容；接口出错时显示错误提示而不是骨架', async ({ page }) => {
  await login(page, gateway.codes[0]!);
  const release = await hold(page, isNotebook);
  await page.reload();
  await expect(page.getByTestId('home-skeleton')).toBeVisible();
  await expect(page.locator('.home-title ion-skeleton-text')).toBeVisible();
  await expect(page.getByTestId('empty-notebook')).toHaveCount(0);
  // 骨架只是占位，不该被读屏念出来。
  await expect(page.getByTestId('home-skeleton')).toHaveAttribute('aria-hidden', 'true');
  release();
  await expect(page.getByTestId('empty-notebook')).toBeVisible();
  await expect(page.getByTestId('home-skeleton')).toHaveCount(0);
  await expect(page.getByTestId('subject-switch')).toContainText('数学');

  await page.unroute(url => isNotebook(url));
  await page.route(url => isNotebook(url), failed);
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('合成的失败');
  await expect(page.getByTestId('home-skeleton')).toHaveCount(0);
});

test('详情页：数据返回前显示骨架，返回后换成题目；接口出错时显示错误提示而不是骨架', async ({ page }) => {
  await login(page, gateway.codes[1]!);
  await page.getByTestId('next-step-primary').click();
  await page.getByTestId('capture-mode-single').locator('input').setInputFiles({ name: 'synthetic.jpg', mimeType: 'image/jpeg', buffer: await sharp({ create: { width: 240, height: 320, channels: 3, background: { r: 210, g: 220, b: 230 } } }).jpeg().toBuffer() });
  await expect(page.getByTestId('pick-candidate').first()).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('pick-page').first().click();
  await page.getByTestId('pick-submit').first().click();
  await expect(page.locator('section.intake-photo[data-state="done"]')).toHaveCount(1, { timeout: 30_000 });
  await page.getByTestId('intake-done').click();
  await expect(page.getByTestId('item-card')).toHaveCount(1);

  const release = await hold(page, isItem);
  await page.getByTestId('item-card').first().click();
  await expect(page.getByTestId('item-skeleton')).toBeVisible();
  await expect(page.locator('.item-title')).toHaveCount(0);
  release();
  await expect(page.locator('.item-title')).toBeVisible();
  await expect(page.getByTestId('item-skeleton')).toHaveCount(0);

  await page.unroute(url => isItem(url));
  await page.route(url => isItem(url), failed);
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('合成的失败');
  await expect(page.getByTestId('item-skeleton')).toHaveCount(0);
});
