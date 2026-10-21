import { expect, test, type Page } from '@playwright/test';

const WEB = 'http://127.0.0.1:3196';
const CONTROL = 'http://127.0.0.1:3197';

async function connect(page: Page, request: import('@playwright/test').APIRequestContext): Promise<void> {
  const { link } = await (await request.get(`${CONTROL}/pairing-link`)).json() as { link: string };
  await page.goto(link.replace('https://study.pccoding666.com', WEB));
  await page.getByTestId('next-step-primary').click();
  await expect(page).toHaveURL(/\/s\/(?:\?paired=1)?$/);
}

test('三栏导航在窄屏大字下可用，根页面不再显示本周安排', async ({page,request}) => {
  await connect(page,request);
  const tabs = page.getByRole('navigation',{name:'主要导航'});
  await expect(tabs.getByRole('link',{name:'错题本',exact:true})).toHaveAttribute('aria-current','page');
  for (const name of ['错题录入','练习','错题本']) {
    await tabs.getByRole('link',{name,exact:true}).click();
    await expect(tabs.getByRole('link',{name,exact:true})).toHaveAttribute('aria-current','page');
  }
  await expect(page.getByTestId('week-plan-open')).toHaveCount(0);
  await page.setViewportSize({width:320,height:740});
  await page.emulateMedia({reducedMotion:'reduce',colorScheme:'dark'});
  await page.addStyleTag({content:'html{font-size:200% !important}'});
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  for (const link of await tabs.getByRole('link').all()) {
    const box = await link.boundingBox();expect(box?.height).toBeGreaterThanOrEqual(44);expect(box?.width).toBeGreaterThanOrEqual(44);
  }
});

test.describe('网页渐进增强', () => {
  test.use({ javaScriptEnabled: false });
  test('错题学科切换无需脚本，返回列表记住选择且窄屏大字不溢出', async ({ page, request }, testInfo) => {
    await connect(page, request);
    await page.getByTestId('tab-items').click();
    const switcher = page.getByTestId('subject-switch');
    await expect(switcher).toContainText('数学');
    const left = await switcher.boundingBox();
    const right = await page.getByTestId('settings-link').boundingBox();
    expect(left!.x + left!.width).toBeLessThan(right!.x);
    await switcher.click();
    await page.getByRole('navigation', { name: '选择学科' }).getByRole('link', { name: '物理' }).click();
    await expect(switcher).toContainText('物理');
    await expect(page).toHaveTitle(/^错题本 · /);
    await expect(page.getByRole('heading', { name: '物理', exact: true })).toHaveCount(0);
    await expect(page.getByTestId('item-card')).toHaveCount(0);
    await expect(page.getByText('还没有物理错题', { exact: true })).toBeVisible();
    await page.getByTestId('tab-practices').click();
    await page.getByTestId('tab-items').click();
    await expect(switcher).toContainText('物理');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: testInfo.outputPath('items-subject-dark.png') });
    await page.setViewportSize({ width: 320, height: 740 });
    // addStyleTag waits for a load handler that cannot run with page scripts disabled.
    await page.evaluate(() => document.documentElement.style.setProperty('font-size', '200%', 'important'));
    await switcher.click();
    const chemistry = page.getByRole('navigation', { name: '选择学科' }).getByRole('link', { name: '化学' });
    await expect(chemistry).toBeInViewport();
    expect((await chemistry.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath('items-subject-menu-large.png') });
    await chemistry.click();
    await expect(switcher).toContainText('化学');
  });
  test('无脚本可切换三个独立入口', async ({page,request}) => {
    await connect(page,request);
    await page.getByTestId('tab-practices').click();
    await expect(page.getByRole('heading',{name:'练习',exact:true})).toBeVisible();
    await page.getByTestId('tab-items').click();
    await expect(page).toHaveURL(`${WEB}/s/items`);
    await page.getByTestId('tab-capture').click();
    await expect(page).toHaveURL(`${WEB}/s/capture`);
  });
});

test('学科菜单可以按 Escape 或点击外部收起，Escape 返回触发控件', async ({ page, request }) => {
  await connect(page, request);
  await page.getByTestId('tab-items').click();
  const switcher = page.getByTestId('subject-switch');
  const menu = page.getByRole('navigation', { name: '选择学科' });
  await switcher.click();
  await menu.getByRole('link', { name: '物理', exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(menu).not.toBeVisible();
  await expect(switcher).toBeFocused();
  await switcher.click();
  await page.mouse.click(380, 640); // Empty content outside the menu and bottom navigation.
  await expect(menu).not.toBeVisible();
  await switcher.click();
  await menu.getByRole('link', { name: '物理', exact: true }).click();
  await expect(switcher).toContainText('物理');
});
