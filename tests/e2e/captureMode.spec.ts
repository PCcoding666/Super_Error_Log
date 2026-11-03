/**
 * 学生端拍照栏：默认单页仍是拍一张就上传；多页先留下缩略图，删一张、标试卷/答题卡，点「完成」再一次提交。
 */
import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';

const WEB = 'http://127.0.0.1:3196';
const CONTROL = 'http://127.0.0.1:3197';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: IPHONE, locale: 'zh-CN', serviceWorkers: 'block' });

let shade = 0;
async function synthetic(color: string): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  shade += 1;
  return { name: `page-${shade}.jpg`, mimeType: 'image/jpeg', buffer: await sharp({ create: { width: 640, height: 800, channels: 3, background: color } }).jpeg({ quality: 80 }).toBuffer() };
}

async function pair(page: Page): Promise<void> {
  const { link } = await (await fetch(`${CONTROL}/pairing-link`)).json() as { link: string };
  await page.goto(link.replace('https://study.pccoding666.com', WEB));
  await page.getByTestId('next-step-primary').click();
  await page.waitForURL(/\/s\/\?paired=1$/);
}

const dock = (page: Page) => page.locator('[data-testid="capture-dock"]:visible');

test('单页马上上传，多页攒齐后一次提交，并带上拍摄模式', async ({ page }) => {
  const posts: string[] = [];
  // 应答成功但不写进合成服务器：那台服务器是整份端到端共用的一个学生，写进去会让后面的错题本用例不再是空本。
  await page.route('**/s/capture', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    posts.push(route.request().postDataBuffer()?.toString('latin1') ?? '');
    const id = crypto.randomUUID();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, jobId: id, next: '/s/capture' }) });
  });
  await pair(page);
  const bar = dock(page).getByTestId('capture-mode-bar');
  await expect(bar).toBeVisible();
  await expect(bar.getByTestId('capture-mode-single')).toHaveAttribute('aria-checked', 'true');
  await expect(bar.getByTestId('capture-mode-multi')).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('#camera-input')).toHaveAttribute('capture', 'environment');
  await expect(page.locator('#camera-input')).not.toHaveAttribute('multiple');
  await expect(page.locator('#library-input')).toHaveAttribute('multiple', '');
  await expect(page.locator('#library-input')).not.toHaveAttribute('capture');
  const shot = '/opt/cursor/artifacts/capture-mode-bar.png';
  mkdirSync('/opt/cursor/artifacts', { recursive: true });
  await page.screenshot({ path: shot });
  await page.screenshot({ path: test.info().outputPath('capture-mode-bar.png') });

  await page.locator('#camera-input').setInputFiles(await synthetic('#efb7b2'));
  await expect.poll(() => posts.length, { timeout: 20_000 }).toBe(1);
  expect(posts[0]).toContain('"captureMode":"single"');
  await expect.poll(() => new URL(page.url()).pathname).toBe('/s/new');

  await page.getByRole('radio', { name: '多页' }).click();
  await expect(page.getByRole('radio', { name: '多页' })).toHaveAttribute('aria-checked', 'true');
  expect(await page.evaluate(() => localStorage.getItem('sel-capture-mode'))).toBe('multi');
  const before = posts.length;
  const camera = page.getByTestId('intake-camera').locator('input');
  await camera.setInputFiles(await synthetic('#b0d3e0'));
  await camera.setInputFiles(await synthetic('#c8e0b0'));
  await expect(page.getByTestId('capture-count')).toHaveText('已拍 2 张');
  await expect(page.getByTestId('capture-page')).toHaveCount(2);
  expect(posts).toHaveLength(before);
  await page.getByTestId('capture-page').nth(0).getByRole('button', { name: '试卷' }).click();
  await page.getByTestId('capture-page').nth(1).getByRole('button', { name: '答题卡' }).click();
  await page.getByTestId('capture-page-delete').first().click();
  await expect(page.getByTestId('capture-count')).toHaveText('已拍 1 张');
  await camera.setInputFiles(await synthetic('#e0d0b0'));
  await expect(page.getByTestId('capture-count')).toHaveText('已拍 2 张');
  await page.screenshot({ path: '/opt/cursor/artifacts/capture-mode-tray.png' });
  await page.getByTestId('capture-set-done').click();
  await expect.poll(() => posts.length, { timeout: 20_000 }).toBe(before + 2);
  const submitted = posts.slice(before);
  expect(submitted.every(body => body.includes('"captureMode":"multi"'))).toBe(true);
  expect(submitted.some(body => body.includes('"pageKind":"answer_sheet"'))).toBe(true);
  expect(submitted.some(body => body.includes('"pageIndex":1'))).toBe(true);
  expect(submitted.some(body => body.includes('"pageIndex":2'))).toBe(true);
  expect(submitted.some(body => body.includes('"pageCount":2'))).toBe(true);
});
