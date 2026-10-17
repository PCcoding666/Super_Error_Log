import { expect, test, type Page } from '@playwright/test';

const WEB = 'http://127.0.0.1:3196';
const CONTROL = 'http://127.0.0.1:3197';

async function connect(page: Page, request: import('@playwright/test').APIRequestContext): Promise<void> {
  const { link } = await (await request.get(`${CONTROL}/pairing-link`)).json() as { link: string };
  await page.goto(link.replace('https://study.pccoding666.com', WEB));
  await page.getByTestId('next-step-primary').click();
  await expect(page).toHaveURL(/\/s\/(?:\?paired=1)?$/);
}

test('根导航切换页面；本周安排支持模态焦点、关闭和窄屏大字', async ({ page, request }) => {
  await connect(page, request);
  const tabs = page.getByRole('navigation', { name: '主要导航' });
  await expect(tabs.getByRole('link', { name: '今天', exact: true })).toHaveAttribute('aria-current', 'page');
  for (const name of ['错题', '练习', '今天']) {
    await tabs.getByRole('link', { name, exact: true }).click();
    await expect(tabs.getByRole('link', { name, exact: true })).toHaveAttribute('aria-current', 'page');
  }
  const opener = page.getByTestId('week-plan-open');
  await opener.click();
  const dialog = page.getByRole('dialog', { name: '本周安排' });
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  // Native dialog must retain keyboard focus, even when tabbing past every child.
  for (let index = 0; index < 16; index++) await page.keyboard.press('Tab');
  await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(opener).toBeFocused();
  await opener.click();
  await dialog.getByRole('button', { name: /关闭/ }).click();
  await expect(dialog).not.toBeVisible();
  await expect(opener).toBeFocused();
  await opener.click();
  // The exposed backdrop is outside the bottom sheet on a normal phone viewport.
  await page.mouse.click(4, 4);
  await expect(dialog).not.toBeVisible();
  await expect(opener).toBeFocused();

  await opener.click();
  await expect(dialog).toHaveClass(/sheet-visible/);
  await dialog.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
  let grabber = await dialog.getByRole('button', { name: '下拉收起本周安排' }).boundingBox();
  expect(grabber).not.toBeNull();
  // A small drag cancels; the synthetic click after pointerup must not dismiss it.
  await page.mouse.move(grabber!.x + grabber!.width / 2, grabber!.y + grabber!.height / 2);
  await page.mouse.down();
  await page.mouse.move(grabber!.x + grabber!.width / 2, grabber!.y + grabber!.height / 2 + 20, { steps: 5 });
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveClass(/sheet-visible/);
  await dialog.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
  grabber = await dialog.getByRole('button', { name: '下拉收起本周安排' }).boundingBox();
  await page.mouse.move(grabber!.x + grabber!.width / 2, grabber!.y + grabber!.height / 2);
  await page.mouse.down();
  await page.mouse.move(grabber!.x + grabber!.width / 2, grabber!.y + 110, { steps: 8 });
  await page.mouse.up();
  await expect(dialog).not.toBeVisible();
  await expect(opener).toBeFocused();

  await page.setViewportSize({ width: 320, height: 740 });
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.addStyleTag({ content: 'html{font-size:200% !important}' });
  await opener.click();
  await expect(dialog.getByRole('button', { name: /关闭/ })).toBeInViewport();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflow).toBe(false);
  await dialog.getByRole('button', { name: /关闭/ }).click();
  for (const link of await tabs.getByRole('link').all()) {
    const box = await link.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(box?.width).toBeGreaterThanOrEqual(44);
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
    await expect(page.getByRole('heading', { name: '错题本', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '物理', exact: true })).toHaveCount(0);
    await expect(page.getByTestId('item-card')).toHaveCount(0);
    await expect(page.getByText('这个年级还没有物理错题', { exact: true })).toBeVisible();
    await page.getByTestId('tab-today').click();
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
  test('无脚本可以展开完整安排并切换根页面', async ({ page, request }) => {
    await connect(page, request);
    const details = page.locator('[data-week-sheet]');
    await expect(details).not.toHaveAttribute('open');
    await page.getByTestId('week-plan-open').click();
    await expect(details).toHaveAttribute('open', '');
    await expect(page.locator('#week-plan-title')).toBeVisible();
    await page.getByTestId('week-plan-open').click();
    await expect(details).not.toHaveAttribute('open');
    await page.getByRole('navigation', { name: '主要导航' }).getByRole('link', { name: '错题', exact: true }).click();
    await expect(page).toHaveURL(`${WEB}/s/items`);
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
