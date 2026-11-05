/**
 * 生产学生空间走材料上传（/s/materials/uploads），多页在这里合成一次提交。
 * 邀请码网关每个用例单独起，不碰 3196 那台共用的旧流程服务器。
 */
import { mkdirSync } from 'node:fs';
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
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error('fixture exited')); });
        child.once('message', message => { clearTimeout(timer); resolve(message as { base: string; codes: string[] }); });
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
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });

let shade = 0;
async function jpeg(): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  shade += 1;
  return { name: `page-${shade}.jpg`, mimeType: 'image/jpeg', buffer: await sharp({ create: { width: 240, height: 320, channels: 3, background: { r: 40 + shade * 30, g: 80, b: 140 } } }).jpeg().toBuffer() };
}

test('材料流程的多页一次提交，两张照片共用一个拍摄批次', async ({ page, gateway }) => {
  const uploads: string[] = [];
  const legacy: string[] = [];
  await page.route('**/s/materials/uploads', async route => {
    uploads.push(route.request().postDataBuffer()?.toString('latin1') ?? '');
    await route.continue();
  });
  page.on('request', request => { if (request.method() === 'POST' && /\/s\/capture$/.test(request.url())) legacy.push(request.url()); });
  await page.goto(gateway.base + '/s/');
  await page.getByLabel('12 位邀请码').fill(gateway.codes[0]!);
  await page.getByRole('button', { name: '进入我的错题本' }).click();
  await page.getByRole('button', { name: '初中', exact: true }).click();
  await expect(page.getByTestId('empty-notebook')).toBeVisible();
  await expect(page.getByTestId('capture-mode-multi')).toBeVisible();
  mkdirSync('/opt/cursor/artifacts', { recursive: true });
  await page.screenshot({ path: '/opt/cursor/artifacts/capture-mode-bar.png' });
  await page.getByTestId('capture-mode-multi').click();
  const camera = page.locator('#camera-input');
  await camera.setInputFiles(await jpeg());
  await camera.setInputFiles(await jpeg());
  await expect(page.getByTestId('capture-count')).toHaveText('已拍 2 张');
  await page.getByTestId('capture-page').nth(0).getByRole('button', { name: '试卷' }).click();
  await page.getByTestId('capture-page').nth(1).getByRole('button', { name: '答题卡' }).click();
  await page.getByTestId('capture-page-delete').first().click();
  await expect(page.getByTestId('capture-count')).toHaveText('已拍 1 张');
  await page.getByTestId('capture-set-discard').click();
  await expect(page.getByTestId('capture-tray')).toHaveCount(0);
  await camera.setInputFiles(await jpeg());
  await camera.setInputFiles(await jpeg());
  await page.getByTestId('capture-page').nth(1).getByRole('button', { name: '答题卡' }).click();
  await page.screenshot({ path: '/opt/cursor/artifacts/capture-mode-tray.png' });
  expect(uploads).toEqual([]);
  await page.getByTestId('capture-set-done').click();
  await expect.poll(() => uploads.length, { timeout: 20_000 }).toBe(2);
  expect(legacy).toEqual([]);
  expect(uploads.every(body => body.includes('"captureMode":"multi"'))).toBe(true);
  expect(uploads.some(body => body.includes('"pageIndex":1'))).toBe(true);
  expect(uploads.some(body => body.includes('"pageIndex":2'))).toBe(true);
  expect(uploads.some(body => body.includes('"pageKind":"answer_sheet"'))).toBe(true);
  const captureIds = uploads.map(body => body.match(/cap_[0-9a-f]{16}/)?.[0]);
  expect(captureIds[0]).toBeTruthy();
  expect(captureIds[1]).toBe(captureIds[0]);
  await expect(page.locator('section.intake-photo')).toHaveCount(2, { timeout: 30_000 });
});
