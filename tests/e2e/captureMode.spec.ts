/**
 * 旧单学生演示服务器走 /s/capture，不会把多页合成一份。多页入口只在材料流程里出现。
 * 多页提交的端到端见 captureModeMaterials.spec.ts。
 */
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

test('旧流程只保留单页，拍一张就上传', async ({ page }) => {
  const posts: string[] = [];
  // 应答成功但不写进合成服务器：那台服务器是整份端到端共用的一个学生，写进去会让后面的错题本用例不再是空本。
  await page.route('**/s/capture', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    posts.push(route.request().postDataBuffer()?.toString('latin1') ?? '');
    const id = crypto.randomUUID();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, jobId: id, next: '/s/capture' }) });
  });
  await pair(page);
  await expect(dock(page)).toHaveAttribute('data-capture-route', 'legacy');
  await expect(dock(page)).toHaveAttribute('data-capture-choice', 'direct');
  await expect(page.getByTestId('capture-mode-bar')).toHaveCount(0);
  await expect(page.getByTestId('capture-mode-sheet')).toHaveCount(0);
  await expect(page.getByTestId('capture-mode-multi')).toHaveCount(0);
  await expect(page.locator('#camera-input')).toHaveAttribute('capture', 'environment');
  await expect(page.locator('#camera-input')).not.toHaveAttribute('multiple');
  await expect(page.locator('#library-input')).toHaveAttribute('multiple', '');
  await expect(page.locator('#library-input')).not.toHaveAttribute('capture');
  const cameraBox = await page.locator('#camera-input').boundingBox();
  expect(cameraBox?.width ?? 0).toBeGreaterThan(40);
  expect(cameraBox?.height ?? 0).toBeGreaterThan(40);

  await page.locator('#camera-input').setInputFiles(await synthetic('#efb7b2'));
  await expect.poll(() => posts.length, { timeout: 20_000 }).toBe(1);
  expect(posts[0]).toContain('"captureMode":"single"');
  await expect.poll(() => new URL(page.url()).pathname).toBe('/s/new');
  await expect(page.locator('.capture-inline')).toHaveAttribute('data-capture-choice', 'direct');
  await expect(page.locator('.capture-inline').getByTestId('capture-mode-bar')).toHaveCount(0);
  await expect(page.getByTestId('capture-mode-multi')).toHaveCount(0);
});
