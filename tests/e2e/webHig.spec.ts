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
  const grabber = await dialog.getByRole('button', { name: '下拉收起本周安排' }).boundingBox();
  expect(grabber).not.toBeNull();
  // A small drag cancels; the synthetic click after pointerup must not dismiss it.
  await page.mouse.move(grabber!.x + grabber!.width / 2, grabber!.y + grabber!.height / 2);
  await page.mouse.down();
  await page.mouse.move(grabber!.x + grabber!.width / 2, grabber!.y + grabber!.height / 2 + 20, { steps: 5 });
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveClass(/sheet-visible/);
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
