/** #127：首页和详情页在第一份数据返回前先画骨架；数据到了换成内容，出错时让位给错误提示；之后的刷新不再闪骨架。只用合成材料。 */
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

type Outcome = 'ok' | 'fail';
const failed = (route: Route): Promise<void> => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: '合成的失败' } }) });

/**
 * 把匹配的接口请求扣住。调用返回的函数才放行：'ok' 照常回，'fail' 换成一个合成的 500。
 * 先清掉之前挂的路由（unroute 对函数匹配器按引用比较，另写一个同样的函数是摘不掉的）。
 */
async function hold(page: Page, matches: (url: URL) => boolean): Promise<(outcome?: Outcome) => void> {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  let release!: (outcome: Outcome) => void;
  const held = new Promise<Outcome>(resolve => { release = resolve; });
  await page.route(url => matches(url), async (route: Route) => {
    const outcome = await held;
    await (outcome === 'fail' ? failed(route) : route.continue()).catch(() => {});
  });
  return (outcome = 'ok') => release(outcome);
}
const isNotebook = (url: URL): boolean => url.pathname === '/s/api/notebook';
const isItem = (url: URL): boolean => /^\/s\/api\/items\/[^/]+$/.test(url.pathname);

test('首页：数据返回前显示骨架，返回后换成内容；之后的刷新不闪骨架；接口出错时骨架让位给错误提示', async ({ page }) => {
  await login(page, gateway.codes[0]!);
  let release = await hold(page, isNotebook);
  await page.reload();
  await expect(page.getByTestId('home-skeleton')).toBeVisible();
  await expect(page.locator('.home-title ion-skeleton-text')).toBeVisible();
  await expect(page.getByTestId('empty-notebook')).toHaveCount(0);
  // 骨架只是占位，不该被读屏念出来；学科还不知道，标题按钮先不能点（点开只会是一张空的选择框）。
  await expect(page.getByTestId('home-skeleton')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.getByTestId('subject-switch')).toBeDisabled();
  release();
  await expect(page.getByTestId('empty-notebook')).toBeVisible();
  await expect(page.getByTestId('home-skeleton')).toHaveCount(0);
  await expect(page.getByTestId('subject-switch')).toContainText('数学');
  await expect(page.getByTestId('subject-switch')).toBeEnabled();

  // 去设置页再回来：首页重新取数，这段时间保留旧内容，不退回骨架。
  await page.getByTestId('settings-link').click();
  await expect(page.getByRole('heading', { name: '设置' })).toBeVisible();
  release = await hold(page, isNotebook);
  const refetch = page.waitForRequest(request => isNotebook(new URL(request.url())));
  await page.getByTestId('back-link').click();
  await refetch;
  await expect(page.getByTestId('empty-notebook')).toBeVisible();
  await expect(page.getByTestId('subject-switch')).toContainText('数学');
  await expect(page.getByTestId('home-skeleton')).toHaveCount(0);
  release();

  // 第一份数据就失败：先是骨架，500 回来后换成错误提示。
  release = await hold(page, isNotebook);
  await page.reload();
  await expect(page.getByTestId('home-skeleton')).toBeVisible();
  release('fail');
  await expect(page.getByRole('alert')).toContainText('合成的失败');
  await expect(page.getByTestId('home-skeleton')).toHaveCount(0);
});

test('详情页：数据返回前显示骨架，返回后换成题目；接口出错时骨架让位给错误提示', async ({ page }) => {
  await login(page, gateway.codes[1]!);
  await page.getByTestId('next-step-primary').click();
  await page.getByTestId('capture-mode-single').locator('input').setInputFiles({ name: 'synthetic.jpg', mimeType: 'image/jpeg', buffer: await sharp({ create: { width: 240, height: 320, channels: 3, background: { r: 210, g: 220, b: 230 } } }).jpeg().toBuffer() });
  await expect(page.getByTestId('pick-candidate').first()).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('pick-page').first().click();
  await page.getByTestId('pick-submit').first().click();
  await expect(page.locator('section.intake-photo[data-state="done"]')).toHaveCount(1, { timeout: 30_000 });
  await page.getByTestId('intake-done').click();
  await expect(page.getByTestId('item-card')).toHaveCount(1);

  let release = await hold(page, isItem);
  await page.getByTestId('item-card').first().click();
  await expect(page.getByTestId('item-skeleton')).toBeVisible();
  // 这一页加载时没有别的文字，占位自己带一句读屏能念的状态。
  await expect(page.getByRole('status', { name: '正在加载题目' })).toBeVisible();
  await expect(page.locator('.item-title')).toHaveCount(0);
  release();
  await expect(page.locator('.item-title')).toBeVisible();
  await expect(page.getByTestId('item-skeleton')).toHaveCount(0);

  release = await hold(page, isItem);
  await page.reload();
  await expect(page.getByTestId('item-skeleton')).toBeVisible();
  release('fail');
  await expect(page.getByRole('alert')).toContainText('合成的失败');
  await expect(page.getByTestId('item-skeleton')).toHaveCount(0);
});
