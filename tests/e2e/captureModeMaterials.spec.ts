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

const dock = (page: Page) => page.locator('[data-testid="capture-dock"]:visible');
const shot = (name: string): string => `/opt/cursor/artifacts/${name}.png`;

async function openChoice(page: Page, entry: 'camera' | 'album'): Promise<void> {
  await expect(dock(page)).toHaveAttribute('data-capture-choice', 'choice');
  await expect(dock(page).getByTestId('capture-mode-bar')).toHaveCount(0);
  await page.getByTestId(entry === 'camera' ? 'capture-fab-camera' : 'next-step-primary').click();
  await expect(page.getByTestId('capture-mode-sheet')).toBeVisible();
}

function choiceInput(page: Page, mode: 'single' | 'multi') {
  return page.getByTestId('capture-mode-sheet').getByTestId(mode === 'single' ? 'capture-mode-single' : 'capture-mode-multi').locator('input');
}

let shade = 0;
async function jpeg(): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  shade += 1;
  return { name: `page-${shade}.jpg`, mimeType: 'image/jpeg', buffer: await sharp({ create: { width: 240, height: 320, channels: 3, background: { r: 40 + shade * 30, g: 80, b: 140 } } }).jpeg().toBuffer() };
}

test('材料流程的多页一次提交，两张照片共用一个拍摄批次', async ({ page, gateway }) => {
  test.setTimeout(120_000);
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
  await expect(dock(page)).toHaveAttribute('data-capture-route', 'materials');
  await expect(dock(page)).toHaveAttribute('data-capture-choice', 'choice');
  await expect(page.getByTestId('capture-mode-bar')).toHaveCount(0);
  await expect(page.locator('#camera-input')).toHaveCount(0);
  await expect(page.locator('#library-input')).toHaveCount(0);
  await expect(page.getByTestId('capture-camera').locator('input')).toHaveCount(0);
  await expect(page.getByTestId('capture-album').locator('input')).toHaveCount(0);
  mkdirSync('/opt/cursor/artifacts', { recursive: true });
  // Browser-test captures from Playwright Chromium, not a real Android or iOS picker.
  await page.screenshot({ path: shot('browser-test-idle-home-mobile') });
  await openChoice(page, 'camera');
  const multi = choiceInput(page, 'multi');
  await expect(multi).toHaveAttribute('capture', 'environment');
  await expect(multi).not.toHaveAttribute('multiple');
  const multiBox = await multi.boundingBox();
  expect(multiBox?.width ?? 0).toBeGreaterThan(40);
  expect(multiBox?.height ?? 0).toBeGreaterThan(40);
  await page.screenshot({ path: shot('browser-test-mode-chooser-mobile') });
  await multi.setInputFiles(await jpeg());
  await expect(page.getByTestId('capture-mode-sheet')).toHaveCount(0);
  await expect(page.getByTestId('capture-count')).toHaveText('已拍 1 张');
  const camera = page.locator('#camera-input');
  await expect(camera).toHaveAttribute('capture', 'environment');
  await camera.setInputFiles(await jpeg());
  await expect(page.getByTestId('capture-count')).toHaveText('已拍 2 张');
  await expect(dock(page).getByTestId('capture-mode-bar')).toBeVisible();
  await page.screenshot({ path: shot('browser-test-multipage-tray-mobile') });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: shot('browser-test-multipage-tray-desktop') });
  await page.getByTestId('capture-page').nth(0).getByRole('button', { name: '试卷' }).click();
  await page.getByTestId('capture-page').nth(1).getByRole('button', { name: '答题卡' }).click();
  await page.getByTestId('capture-page-delete').first().click();
  await expect(page.getByTestId('capture-count')).toHaveText('已拍 1 张');
  await page.getByTestId('capture-set-discard').click();
  await expect(page.getByTestId('capture-tray')).toHaveCount(0);
  await expect(dock(page)).toHaveAttribute('data-capture-choice', 'choice');
  await expect(page.locator('#camera-input')).toHaveCount(0);
  await page.screenshot({ path: shot('browser-test-idle-home-desktop') });
  await openChoice(page, 'camera');
  await page.screenshot({ path: shot('browser-test-mode-chooser-desktop') });
  await page.getByTestId('capture-mode-cancel').click();
  await expect(page.getByTestId('capture-mode-sheet')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await openChoice(page, 'camera');
  await choiceInput(page, 'multi').setInputFiles(await jpeg());
  await page.locator('#camera-input').setInputFiles(await jpeg());
  await page.getByTestId('capture-page').nth(1).getByRole('button', { name: '答题卡' }).click();
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

test('单页和相册都先选模式，录入页同样不常驻模式条，托盘改回单页时不另开一次上传', async ({ page, gateway }) => {
  test.setTimeout(90_000);
  const uploads: string[] = [];
  await page.route('**/s/materials/uploads', async route => {
    uploads.push(route.request().postDataBuffer()?.toString('latin1') ?? '');
    await route.continue();
  });
  await page.goto(gateway.base + '/s/');
  await page.getByLabel('12 位邀请码').fill(gateway.codes[0]!);
  await page.getByRole('button', { name: '进入我的错题本' }).click();
  await page.getByRole('button', { name: '初中', exact: true }).click();
  await expect(page.getByTestId('empty-notebook')).toBeVisible();
  await expect(dock(page)).toHaveAttribute('data-capture-choice', 'choice');
  await page.getByTestId('capture-album').click();
  await expect(page.getByTestId('capture-mode-sheet')).toBeVisible();
  await expect(page.getByRole('dialog', { name: '怎么从相册选' })).toBeVisible();
  const albumSingle = choiceInput(page, 'single');
  const albumMulti = choiceInput(page, 'multi');
  await expect(albumSingle).toHaveAttribute('multiple', '');
  await expect(albumSingle).not.toHaveAttribute('capture');
  await expect(albumMulti).toHaveAttribute('multiple', '');
  const albumBox = await albumSingle.boundingBox();
  expect(albumBox?.width ?? 0).toBeGreaterThan(40);
  expect(albumBox?.height ?? 0).toBeGreaterThan(40);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    albumSingle.click(),
  ]);
  expect(chooser.isMultiple()).toBe(true);
  await chooser.setFiles(await jpeg());
  await expect.poll(() => uploads.length, { timeout: 20_000 }).toBe(1);
  expect(uploads[0]).toContain('"captureMode":"single"');
  expect(uploads[0]).not.toContain('"pageIndex"');
  await expect.poll(() => new URL(page.url()).pathname).toBe('/s/new');
  const inline = page.locator('.capture-inline');
  await expect(inline).toHaveAttribute('data-capture-choice', 'choice');
  await expect(inline.getByTestId('capture-mode-bar')).toHaveCount(0);
  await expect(page.getByTestId('intake-camera').locator('input')).toHaveCount(0);
  await page.getByTestId('intake-camera').click();
  await expect(page.getByRole('dialog', { name: '怎么拍照' })).toBeVisible();
  await expect(choiceInput(page, 'single')).toHaveAttribute('capture', 'environment');
  await choiceInput(page, 'multi').setInputFiles(await jpeg());
  await expect(page.getByTestId('capture-count')).toHaveText('已拍 1 张');
  await expect(inline.getByTestId('capture-mode-bar')).toBeVisible();
  await expect(uploads).toHaveLength(1);
  await inline.getByTestId('capture-mode-single').click();
  await expect(page.getByTestId('capture-mode-hold')).toBeVisible();
  await expect(page.getByTestId('intake-camera')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('intake-album')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('intake-camera').locator('input')).toHaveCount(0);
  await expect(page.locator('#camera-input')).toHaveCount(0);
  await page.getByTestId('intake-camera').click({ force: true });
  await expect(page.getByTestId('capture-count')).toHaveText('已拍 1 张');
  await expect.poll(() => new URL(page.url()).pathname).toBe('/s/new');
  await inline.getByTestId('capture-mode-multi').click();
  await expect(page.getByTestId('capture-mode-hold')).toHaveCount(0);
  await page.getByTestId('intake-camera').locator('input').setInputFiles(await jpeg());
  await expect(page.getByTestId('capture-count')).toHaveText('已拍 2 张');
  await page.getByTestId('capture-set-discard').click();
  await expect(page.getByTestId('capture-tray')).toHaveCount(0);
  await expect(inline).toHaveAttribute('data-capture-choice', 'choice');
  await expect(inline.getByTestId('capture-mode-bar')).toHaveCount(0);
  expect(uploads).toHaveLength(1);
});

test('打开选择器之后材料路由才返回：文件不丢，存储的多页也不会先塞进托盘', async ({ page, gateway }) => {
  test.setTimeout(90_000);
  const uploads: string[] = [];
  await page.addInitScript(() => localStorage.setItem('sel-capture-mode', 'multi'));
  let release = (): void => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/s/api/upload', async route => { await gate; await route.continue(); });
  await page.route('**/s/materials/uploads', async route => {
    uploads.push(route.request().postDataBuffer()?.toString('latin1') ?? '');
    await route.continue();
  });
  await page.goto(gateway.base + '/s/');
  await page.getByLabel('12 位邀请码').fill(gateway.codes[0]!);
  await page.getByRole('button', { name: '进入我的错题本' }).click();
  await page.getByRole('button', { name: '初中', exact: true }).click();
  await expect(page.getByTestId('empty-notebook')).toBeVisible();
  // Do not wait for data-capture-choice=choice. That wait hides this race.
  await expect(dock(page)).toHaveAttribute('data-capture-route', 'pending');
  await expect(page.locator('#camera-input')).toBeAttached();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('#camera-input').click(),
  ]);
  release();
  await expect(dock(page)).toHaveAttribute('data-capture-route', 'materials');
  await expect(dock(page)).toHaveAttribute('data-capture-choice', 'choice');
  await expect(page.locator('#camera-input')).toBeAttached();
  await chooser.setFiles(await jpeg());
  await expect.poll(() => uploads.length, { timeout: 20_000 }).toBe(1);
  expect(uploads[0]).toContain('"captureMode":"single"');
  expect(uploads[0]).not.toContain('"pageIndex"');
  await expect(page.getByTestId('capture-tray')).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).pathname).toBe('/s/new');
  expect(await page.evaluate(() => localStorage.getItem('sel-capture-mode'))).toBe('single');
});

test('取消多页选择器不会把多页写进本地，刷新后也不会出现托盘', async ({ page, gateway }) => {
  test.setTimeout(90_000);
  await page.goto(gateway.base + '/s/');
  await page.getByLabel('12 位邀请码').fill(gateway.codes[0]!);
  await page.getByRole('button', { name: '进入我的错题本' }).click();
  await page.getByRole('button', { name: '初中', exact: true }).click();
  await expect(dock(page)).toHaveAttribute('data-capture-choice', 'choice');
  await openChoice(page, 'camera');
  await Promise.all([
    page.waitForEvent('filechooser'),
    choiceInput(page, 'multi').click(),
  ]);
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => localStorage.getItem('sel-capture-mode'))).not.toBe('multi');
  await page.reload();
  await expect(dock(page)).toHaveAttribute('data-capture-choice', 'choice');
  await expect(page.getByTestId('capture-tray')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('sel-capture-mode'))).not.toBe('multi');
});

const ANDROID_SHELL = 'Mozilla/5.0 (Linux; U; Android 14; zh-cn; 23013RK75C Build/UKQ1.230804.001) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/118.0.0.0 Mobile Safari/537.36 XiaoMi/MiuiBrowser/18.4.30';
/** Matches client/src/lib/chooserWatch.ts. Android with no cover ends the lease after this. */
const NO_COVER_MS = 2000;
/** Matches PICKER_RETURN_GRACE_MS. A late change inside this window must beat focus/visibility. */
const RETURN_GRACE_MS = 1000;

async function enterMaterials(page: Page, gateway: { base: string; codes: string[] }): Promise<void> {
  await page.goto(gateway.base + '/s/');
  await page.getByLabel('12 位邀请码').fill(gateway.codes[0]!);
  await page.getByRole('button', { name: '进入我的错题本' }).click();
  await page.getByRole('button', { name: '初中', exact: true }).click();
  await expect(page.getByTestId('empty-notebook')).toBeVisible();
}

/** Real tap on the file input. Playwright holds the dialog open until setFiles or Escape. */
async function openChooser(page: Page, selector: string) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator(selector).click(),
  ]);
  return chooser;
}

async function setCovered(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate(isHidden => {
    const doc = document as Document & { __selVis?: string };
    doc.__selVis = isHidden ? 'hidden' : 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => doc.__selVis ?? 'visible' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => (doc.__selVis ?? 'visible') === 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event(isHidden ? 'blur' : 'focus'));
  }, hidden);
}

test('页面重新可见后，迟到的 change 仍能送出照片，空等超过宽限才算取消', async ({ page, gateway }) => {
  test.setTimeout(90_000);
  let release = (): void => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/s/api/upload', async route => { await gate; await route.continue(); });
  await enterMaterials(page, gateway);
  await expect(dock(page)).toHaveAttribute('data-capture-route', 'pending');
  const chooser = await openChooser(page, '#camera-input');
  release();
  await expect(dock(page)).toHaveAttribute('data-capture-route', 'materials');
  await expect(page.locator('#camera-input')).toBeAttached();
  await setCovered(page, true);
  await setCovered(page, false);
  await page.waitForTimeout(250);
  await expect(page.locator('#camera-input')).toBeAttached();
  await chooser.setFiles(await jpeg());
  await expect.poll(() => new URL(page.url()).pathname).toBe('/s/new');
});

test('选择器盖住页面后又露出、且没有文件，宽限结束后才松开输入框', async ({ page, gateway }) => {
  test.setTimeout(90_000);
  let release = (): void => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/s/api/upload', async route => { await gate; await route.continue(); });
  await enterMaterials(page, gateway);
  const chooser = await openChooser(page, '#camera-input');
  release();
  await expect(dock(page)).toHaveAttribute('data-capture-route', 'materials');
  await setCovered(page, true);
  await setCovered(page, false);
  await page.waitForTimeout(250);
  await expect(page.locator('#camera-input')).toBeAttached();
  await expect(page.locator('#camera-input')).toHaveCount(0, { timeout: RETURN_GRACE_MS + 800 });
  await expect.poll(() => new URL(page.url()).pathname).not.toBe('/s/new');
  await chooser.setFiles([]).catch(() => {});
});

test('非安卓页面一直可见时，两秒内不会放开租约；cancel 事件会放开', async ({ page, gateway }) => {
  test.setTimeout(90_000);
  let release = (): void => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/s/api/upload', async route => { await gate; await route.continue(); });
  await enterMaterials(page, gateway);
  const chooser = await openChooser(page, '#camera-input');
  release();
  await expect(dock(page)).toHaveAttribute('data-capture-route', 'materials');
  await page.waitForTimeout(NO_COVER_MS + 400);
  await expect(page.locator('#camera-input')).toBeAttached();
  await page.locator('#camera-input').evaluate((input: HTMLInputElement) => input.dispatchEvent(new Event('cancel', { bubbles: true })));
  await expect(page.locator('#camera-input')).toHaveCount(0);
  await chooser.setFiles([]).catch(() => {});
});

test.describe('安卓壳没有盖住页面', () => {
  test.use({ userAgent: ANDROID_SHELL });
  test('点了输入框但页面从未被盖住，宽限后放开租约，不把没打开的选择器一直占着', async ({ page, gateway }) => {
    test.setTimeout(90_000);
    let release = (): void => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/s/api/upload', async route => { await gate; await route.continue(); });
    await enterMaterials(page, gateway);
    await expect(dock(page)).toHaveAttribute('data-capture-route', 'pending');
    const chooser = await openChooser(page, '#camera-input');
    release();
    await expect(dock(page)).toHaveAttribute('data-capture-route', 'materials');
    await expect(page.locator('#camera-input')).toBeAttached();
    await expect(page.locator('#camera-input')).toHaveCount(0, { timeout: NO_COVER_MS + 1500 });
    await expect.poll(() => new URL(page.url()).pathname).not.toBe('/s/new');
    await chooser.setFiles([]).catch(() => {});
  });
});

test('关掉模式层会清掉租约，离开再回来不会把层重新打开', async ({ page, gateway }) => {
  test.setTimeout(90_000);
  await enterMaterials(page, gateway);
  await expect(dock(page)).toHaveAttribute('data-capture-choice', 'choice');
  await openChoice(page, 'camera');
  const chooser = await openChooser(page, '[data-testid="capture-mode-sheet"] [data-testid="capture-mode-multi"] input');
  await page.getByTestId('capture-mode-cancel').click();
  await chooser.setFiles([]).catch(() => {});
  await expect(page.getByTestId('capture-mode-sheet')).toHaveCount(0);
  await page.getByTestId('settings-link').click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/s/me');
  await page.goBack();
  await expect(dock(page)).toBeVisible();
  await expect(page.getByTestId('capture-mode-sheet')).toHaveCount(0);
});

test('托盘改成单页时，已经点开的输入框要留到这次选择结束', async ({ page, gateway }) => {
  test.setTimeout(90_000);
  await enterMaterials(page, gateway);
  await expect(dock(page)).toHaveAttribute('data-capture-choice', 'choice');
  await openChoice(page, 'camera');
  await choiceInput(page, 'multi').setInputFiles(await jpeg());
  await expect(page.getByTestId('capture-count')).toHaveText('已拍 1 张');
  const chooser = await openChooser(page, '#camera-input');
  await dock(page).getByTestId('capture-mode-single').click();
  await expect(page.locator('#camera-input')).toBeAttached();
  await chooser.setFiles(await jpeg());
  await expect(page.getByTestId('capture-count')).toHaveText('已拍 2 张');
  await expect.poll(() => new URL(page.url()).pathname).not.toBe('/s/new');
});
