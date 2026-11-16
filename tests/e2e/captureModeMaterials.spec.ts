/**
 * 生产学生空间走材料上传（/s/materials/uploads），多页在这里合成一次提交。
 * 邀请码网关每个用例单独起，不碰 3196 那台共用的旧流程服务器。
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
const shot = (name: string): string => test.info().outputPath(`${name}.png`);

async function chooseMode(page: Page, mode: 'single' | 'multi'): Promise<void> {
  if (await page.locator('[data-testid="capture-mode-bar"]:visible').count() === 0) {
    await page.locator('[data-testid="capture-add"]:visible').last().click();
    await expect(page.getByTestId('capture-mode-sheet')).toBeVisible();
  }
  let opened = false;
  const mark = () => { opened = true; };
  page.on('filechooser', mark);
  await page.locator(`[data-testid="capture-mode-${mode}"]:visible`).click();
  await page.waitForTimeout(80);
  page.off('filechooser', mark);
  expect(opened, '拍摄模式不是文件框，不该打开系统选择器').toBe(false);
}

function entryInput(page: Page) {
  return page.locator('#camera-input');
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
  await expect(dock(page)).toHaveAttribute('data-capture-choice', 'sheet');
  await expect(page.getByTestId('capture-mode-bar')).toHaveCount(0);
  await expect(page.locator('#camera-input')).toHaveCount(0);
  await expect(page.locator('#library-input')).toHaveCount(0);
  await expect(page.locator('[data-testid="capture-add"]:visible').last()).toHaveText('新增');
  // Browser-test captures from Playwright Chromium, not a real Android or iOS picker.
  await page.screenshot({ path: shot('browser-test-idle-home-mobile') });
  await page.locator('[data-testid="capture-add"]:visible').last().click();
  await expect(page.getByTestId('capture-mode-sheet')).toBeVisible();
  await expect(page.getByTestId('capture-mode-note')).toHaveText('一张纸拍完就用单页');
  await page.getByTestId('capture-mode-multi').click();
  await expect(page.getByTestId('capture-mode-note')).toHaveText('适用于答题卡与试卷不在一页上的情况');
  await page.getByTestId('capture-mode-single').click();
  await expect(page.getByTestId('capture-mode-note')).toHaveText('一张纸拍完就用单页');
  await page.getByTestId('capture-mode-cancel').click();
  await expect(page.getByTestId('capture-mode-sheet')).toHaveCount(0);
  await chooseMode(page, 'multi');
  await expect(page.getByTestId('capture-mode-note')).toHaveText('适用于答题卡与试卷不在一页上的情况');
  const multi = entryInput(page);
  await expect(multi).not.toHaveAttribute('capture');
  await expect(multi).toHaveAttribute('multiple', '');
  const multiBox = await multi.boundingBox();
  expect(multiBox?.width ?? 0).toBeGreaterThan(40);
  expect(multiBox?.height ?? 0).toBeGreaterThan(40);
  await page.screenshot({ path: shot('browser-test-mode-chooser-mobile') });
  await multi.setInputFiles(await jpeg());
  await expect(page.getByTestId('capture-mode-sheet')).toHaveCount(0);
  await expect(page.getByTestId('capture-count')).toHaveText('已拍 1 张');
  await expect(page.getByTestId('capture-mode-sheet')).toHaveCount(0);
  const camera = page.locator('#camera-input');
  await expect(camera).not.toHaveAttribute('capture');
  await expect(camera).toHaveAttribute('multiple', '');
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
  await expect(dock(page)).toHaveAttribute('data-capture-choice', 'sheet');
  await expect(page.locator('#camera-input')).toHaveCount(0);
  await page.screenshot({ path: shot('browser-test-idle-home-desktop') });
  await chooseMode(page, 'single');
  await page.screenshot({ path: shot('browser-test-mode-chooser-desktop') });
  await expect(page.getByTestId('capture-mode-sheet')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await chooseMode(page, 'multi');
  await entryInput(page).setInputFiles(await jpeg());
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
  await expect(dock(page)).toHaveAttribute('data-capture-choice', 'sheet');
  await chooseMode(page, 'single');
  const albumSingle = entryInput(page);
  await expect(albumSingle).toHaveAttribute('multiple', '');
  await expect(albumSingle).not.toHaveAttribute('capture');
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
  await expect(inline).toHaveAttribute('data-capture-choice', 'sheet');
  await expect(inline.getByTestId('capture-mode-bar')).toHaveCount(0);
  await chooseMode(page, 'multi');
  await page.locator('#camera-input').setInputFiles(await jpeg());
  await expect(page.getByTestId('capture-count')).toHaveText('已拍 1 张');
  await expect(inline.getByTestId('capture-mode-bar')).toBeVisible();
  await expect(uploads).toHaveLength(1);
  await inline.getByTestId('capture-mode-single').click();
  await expect(page.locator('[data-testid="capture-mode-note"]:visible')).toHaveText('一张纸拍完就用单页');
  await expect(page.getByTestId('capture-mode-hold')).toBeVisible();
  const add = page.locator('[data-testid="capture-add"]:visible').last();
  await expect(add).toHaveAttribute('aria-disabled', 'true');
  await expect(add.locator('input')).toHaveCount(0);
  await expect(page.locator('#camera-input')).toHaveCount(0);
  await add.click({ force: true });
  await expect(page.getByTestId('capture-count')).toHaveText('已拍 1 张');
  await expect.poll(() => new URL(page.url()).pathname).toBe('/s/new');
  await inline.getByTestId('capture-mode-multi').click();
  await expect(page.getByTestId('capture-mode-hold')).toHaveCount(0);
  await expect(page.locator('[data-testid="capture-mode-note"]:visible')).toHaveText('适用于答题卡与试卷不在一页上的情况');
  await page.locator('#camera-input').setInputFiles(await jpeg());
  await expect(page.getByTestId('capture-count')).toHaveText('已拍 2 张');
  await page.getByTestId('capture-set-discard').click();
  await expect(page.getByTestId('capture-tray')).toHaveCount(0);
  await expect(inline).toHaveAttribute('data-capture-choice', 'sheet');
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
  await expect(dock(page)).toHaveAttribute('data-capture-choice', 'sheet');
  await expect(page.locator('#camera-input')).toBeAttached();
  await chooser.setFiles(await jpeg());
  await expect.poll(() => uploads.length, { timeout: 20_000 }).toBe(1);
  expect(uploads[0]).toContain('"captureMode":"single"');
  expect(uploads[0]).not.toContain('"pageIndex"');
  await expect(page.getByTestId('capture-tray')).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).pathname).toBe('/s/new');
  expect(await page.evaluate(() => localStorage.getItem('sel-capture-mode'))).toBe('single');
});

test('点「多页」会记住模式，取消系统选择器不会开出托盘', async ({ page, gateway }) => {
  test.setTimeout(90_000);
  await page.goto(gateway.base + '/s/');
  await page.getByLabel('12 位邀请码').fill(gateway.codes[0]!);
  await page.getByRole('button', { name: '进入我的错题本' }).click();
  await page.getByRole('button', { name: '初中', exact: true }).click();
  await expect(dock(page)).toHaveAttribute('data-capture-choice', 'sheet');
  await page.locator('[data-testid="capture-add"]:visible').last().click();
  await page.getByTestId('capture-mode-multi').click();
  const chooser = await openChooser(page, '#camera-input');
  expect(await page.evaluate(() => localStorage.getItem('sel-capture-mode'))).toBe('multi');
  await page.keyboard.press('Escape');
  await chooser.setFiles([]).catch(() => {});
  await expect(page.getByTestId('capture-tray')).toHaveCount(0);
  await page.reload();
  await expect(dock(page)).toHaveAttribute('data-capture-choice', 'sheet');
  await expect(page.getByTestId('capture-tray')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('sel-capture-mode'))).toBe('multi');
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
  await page.waitForTimeout(RETURN_GRACE_MS + 400);
  await expect(page.locator('#camera-input')).toHaveCount(0);
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
  await expect.poll(() => new URL(page.url()).pathname).not.toBe('/s/new');
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
    await page.waitForTimeout(NO_COVER_MS + 400);
    await expect(page.locator('#camera-input')).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).pathname).not.toBe('/s/new');
    await chooser.setFiles([]).catch(() => {});
  });
});

test('取消选择器后离开再回来，不会自己弹出系统选择器', async ({ page, gateway }) => {
  test.setTimeout(90_000);
  await enterMaterials(page, gateway);
  await expect(dock(page)).toHaveAttribute('data-capture-choice', 'sheet');
  await page.locator('[data-testid="capture-add"]:visible').last().click();
  const chooser = await openChooser(page, '#camera-input');
  await page.keyboard.press('Escape');
  await chooser.setFiles([]).catch(() => {});
  await expect(page.getByTestId('capture-mode-sheet')).toHaveCount(0);
  await page.getByTestId('settings-link').click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/s/me');
  await page.goBack();
  await expect(dock(page)).toBeVisible();
  await expect(page.getByTestId('capture-mode-sheet')).toHaveCount(0);
});

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

test.describe('手机入口不按系统拆开', () => {
  for (const [name, ua] of [
    ['iPhone', IPHONE],
    ['Android', ANDROID_SHELL],
  ] as const) {
    test.describe(name, () => {
      test.use({ userAgent: ua });
      test('只有一个「新增」，选完模式再打开选择器', async ({ page, gateway }) => {
        test.setTimeout(90_000);
        await enterMaterials(page, gateway);
        await expect(dock(page)).toHaveAttribute('data-capture-choice', 'sheet');
        await expect(page.locator('[data-testid="capture-add"]:visible').last()).toHaveText('新增');
        await expect(page.locator('#camera-input')).toHaveCount(0);
        await expect(page.locator('#library-input')).toHaveCount(0);
        await page.locator('[data-testid="capture-add"]:visible').last().click();
        await expect(page.getByTestId('capture-mode-sheet')).toBeVisible();
        let opened = false;
        page.on('filechooser', () => { opened = true; });
        await page.getByTestId('capture-mode-multi').click();
        await page.waitForTimeout(150);
        expect(opened).toBe(false);
        const input = page.locator('#camera-input');
        await expect(input).not.toHaveAttribute('capture');
        await expect(input).toHaveAttribute('multiple', '');
        const chooser = await openChooser(page, '#camera-input');
        expect(chooser.isMultiple()).toBe(true);
        await expect(page.getByTestId('capture-mode-sheet')).toHaveCount(0);
        await chooser.setFiles(await jpeg());
        await expect(page.getByTestId('capture-count')).toHaveText('已拍 1 张');
        await page.screenshot({ path: shot(`${name}-mode-then-tray`) });
      });
    });
  }
});

test('托盘改成单页时，已经点开的输入框要留到这次选择结束', async ({ page, gateway }) => {
  test.setTimeout(90_000);
  await enterMaterials(page, gateway);
  await expect(dock(page)).toHaveAttribute('data-capture-choice', 'sheet');
  await chooseMode(page, 'multi');
  await entryInput(page).setInputFiles(await jpeg());
  await expect(page.getByTestId('capture-count')).toHaveText('已拍 1 张');
  const chooser = await openChooser(page, '#camera-input');
  await dock(page).getByTestId('capture-mode-single').click();
  await expect(page.locator('#camera-input')).toBeAttached();
  await chooser.setFiles(await jpeg());
  await expect(page.getByTestId('capture-count')).toHaveText('已拍 2 张');
  await expect.poll(() => new URL(page.url()).pathname).not.toBe('/s/new');
});
