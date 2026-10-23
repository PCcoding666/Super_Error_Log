/**
 * 学生端单页应用在邀请码网关 + 材料流程上的主流程：登录 → 先选学段 → 拍照 → 录入态勾选收录 → 错题本 → 详情（材料裁图）→ 设置退出。
 */
import { fork } from 'node:child_process';
import path from 'node:path';
import sharp from 'sharp';
import { expect, test as base, type Page } from '@playwright/test';

const test = base.extend<{ gateway: { base: string; codes: string[] } }>({
  gateway: async ({}, use) => {
    const child = fork(path.resolve('tests/e2e/studentHostServer.ts'), [], {
      execArgv: ['--import', 'tsx'], env: { ...process.env, NODE_ENV: 'test', SEL_AI_MODE: 'mock', SEL_E2E_MATERIAL_CAPTURE: '1' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    try {
      const ready = await new Promise<{ base: string; codes: string[] }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('fixture startup timeout')), 20000);
        child.once('error', e => { clearTimeout(timer); reject(e); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error('fixture exited')); });
        child.once('message', m => { clearTimeout(timer); resolve(m as { base: string; codes: string[] }); });
      });
      await use(ready);
    } finally {
      if (child.exitCode === null) await new Promise<void>(resolve => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        if (child.connected) child.send({ stop: true }, () => {}); else child.kill('SIGTERM');
      });
    }
  },
});
test.use({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });

let shade = 0;
async function jpeg(): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  shade += 1;
  return { name: `synthetic-${shade}.jpg`, mimeType: 'image/jpeg', buffer: await sharp({ create: { width: 240, height: 320, channels: 3, background: { r: (shade * 53) % 256, g: (shade * 97) % 256, b: 120 } } }).jpeg().toBuffer() };
}
const url = (page: Page): string => new URL(page.url()).pathname;

test('邀请码登录后先选学段，拍照收录材料里的题，详情显示材料裁图，可以退出', async ({ page, gateway }) => {
  await page.goto(gateway.base + '/s/');
  await page.getByLabel('12 位邀请码').fill(gateway.codes[0]!);
  await page.getByRole('button', { name: '进入我的错题本' }).click();
  await expect(page).toHaveURL(/login=1/);
  // 新账号先在服务端的选学段页选一次，然后才进单页应用。
  await expect(page.getByRole('heading', { name: '你现在读初中还是高中？' })).toBeVisible();
  await page.getByRole('button', { name: '初中', exact: true }).click();
  await expect(page.getByTestId('empty-notebook')).toBeVisible();
  await page.locator('#library-input').setInputFiles([await jpeg()]);
  await expect.poll(() => url(page)).toBe('/s/new');
  // 合成提取：一道题「1 + 1 = ?」带作答和参考答案，没有老师批改痕迹 → 等学生勾选。
  const photo = page.locator('section.intake-photo[data-state="needsPick"]');
  await expect(photo).toHaveCount(1, { timeout: 30_000 });
  await expect(photo.getByTestId('pick-candidate')).toHaveCount(1);
  await photo.getByTestId('pick-candidate').first().click();
  await photo.getByTestId('pick-submit').click();
  await expect(page.locator('section.intake-photo[data-state="done"]')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator('.intake-top p')).toContainText('找到 1 道');
  await page.getByTestId('intake-done').click();
  await expect(page.getByTestId('item-card')).toHaveCount(1);
  await page.getByTestId('item-card').first().click();
  await expect(page.getByTestId('question-text')).toContainText('1 + 1');
  await expect(page.locator('.item-photo img').first()).toHaveAttribute('src', /\/s\/materials\/fragments\//);
  await page.getByTestId('back-link').click();
  await page.getByTestId('settings-link').click();
  await expect(page.getByTestId('settings-my-invite')).toHaveAttribute('href', '/s/account');
  await page.getByTestId('logout').click();
  await expect(page.getByLabel('12 位邀请码')).toBeVisible();
});
