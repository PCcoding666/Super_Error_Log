import { expect, test } from '@playwright/test';
const WEB = 'http://127.0.0.1:3196';
// The calendar sheet was removed from the root screen. Verify native tab history instead.
test('三栏切换保持原生返回顺序，不再插入本周安排弹层', async ({page,request}) => {
  const {link} = await (await request.get('http://127.0.0.1:3197/pairing-link')).json() as {link:string};
  await page.goto(link.replace('https://study.pccoding666.com', WEB));
  await page.getByTestId('next-step-primary').click();
  await expect(page.getByRole('heading',{name:'错题本',exact:true})).toBeVisible();
  await page.getByTestId('tab-practices').click();
  await page.getByTestId('tab-items').click();
  await page.goBack();await expect(page).toHaveURL(`${WEB}/s/practices`);
  await page.goForward();await expect(page).toHaveURL(`${WEB}/s/items`);
  await expect(page.getByTestId('week-plan-open')).toHaveCount(0);
  await expect(page.locator('body')).not.toHaveClass(/sheet-is-open/);
});
