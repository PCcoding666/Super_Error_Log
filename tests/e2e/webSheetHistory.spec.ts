import { expect, test } from '@playwright/test';

const WEB = 'http://127.0.0.1:3196';

test('返回先收起本周安排；显式关闭不占用下次返回，前进不恢复失效弹层', async ({page, request}) => {
  const {link} = await (await request.get('http://127.0.0.1:3197/pairing-link')).json() as {link:string};
  await page.goto(link.replace('https://study.pccoding666.com', WEB));
  await page.getByTestId('next-step-primary').click();
  await page.getByTestId('tab-items').click();
  await page.getByTestId('tab-today').click();
  const today = page.url();
  const opener = page.getByTestId('week-plan-open');
  const sheet = page.getByTestId('week-plan-sheet');
  await opener.click();
  await expect(sheet).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(today);
  await expect(sheet).not.toBeVisible();
  await expect(opener).toBeFocused();
  await expect(page.locator('body')).not.toHaveClass(/sheet-is-open/);
  await page.goForward();
  await expect(sheet).not.toBeVisible();
  await opener.click();
  await page.getByTestId('week-plan-close').click();
  await expect(sheet).not.toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(`${WEB}/s/items`);
  await page.goForward();
  await expect(page).toHaveURL(today);
  await expect(sheet).not.toBeVisible();
  await expect(page.locator('body')).not.toHaveClass(/sheet-is-open/);
});

test('从安排中的任务进入页面，返回不会多停留一个今天页面', async ({page, request}) => {
  const {link} = await (await request.get('http://127.0.0.1:3197/pairing-link')).json() as {link:string};
  await page.goto(link.replace('https://study.pccoding666.com', WEB));
  await page.getByTestId('next-step-primary').click();
  await page.getByTestId('tab-items').click();
  await page.getByTestId('tab-today').click();
  await page.getByTestId('week-plan-open').click();
  const task = page.getByTestId('week-plan-sheet').getByRole('link').first();
  const destination = await task.getAttribute('href');
  await task.click();
  await expect(page).toHaveURL(`${WEB}${destination}`);
  await page.goBack();
  await expect(page).toHaveURL(`${WEB}/s/`);
  await expect(page.getByTestId('week-plan-sheet')).not.toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(`${WEB}/s/items`);
});
