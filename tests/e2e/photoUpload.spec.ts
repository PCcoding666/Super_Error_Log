/** Upload regression: isolated invitation students; fixtures contain no student photos. */
import { fork } from 'node:child_process';
import path from 'node:path';
import sharp from 'sharp';
import { expect, test as baseTest, webkit, type Page } from '@playwright/test';

const test = baseTest.extend<{ gateway: { base: string; codes: string[] } }>({
  gateway: async ({}, use) => {
    const child = fork(path.resolve('tests/e2e/studentHostServer.ts'), [], {
      execArgv: ['--import', 'tsx'], env: { ...process.env, NODE_ENV: 'test', SEL_AI_MODE: 'mock' },
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

async function enter(page: Page, gateway: { base: string; codes: string[] }) {
  await page.goto(gateway.base + '/s/');
  await page.getByLabel('12 位邀请码').fill(gateway.codes[0]!);
  await page.getByRole('button', { name: '进入我的错题本' }).click();
  await expect(page).toHaveURL(/login=1/);
  await page.goto(gateway.base + '/s/capture');
  await page.getByRole('button', { name: '同意，上传', exact: true }).click();
  await expect(page.locator('#library-input')).toBeAttached();
}
async function jpeg(width = 820, height = 1100) {
  return { name: 'page.jpg', mimeType: 'image/jpeg', buffer: await sharp({ create: { width, height, channels: 3, background: '#c6cff2' } }).jpeg().toBuffer() };
}
async function uploaded(page: Page) {
  await expect(page.getByTestId('photo-count')).toHaveText('已拍 1 张');
  await expect(page.getByTestId('photo-tile')).toHaveCount(1);
}
// Capture only synthetic upload metadata. No multipart parser assumptions or private fixtures.
async function observeUploads(page: Page) {
  const calls: { key: string; type: string; hash: string; width: number; height: number }[] = [];
  await page.exposeFunction('recordSyntheticUpload', (record: typeof calls[number]) => calls.push(record));
  await page.evaluate(() => {
    const original = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function(data) {
      if (data instanceof FormData && data.get('photo') instanceof Blob) {
        const blob = data.get('photo') as Blob;
        void (async () => {
          const bytes = await blob.arrayBuffer();
          const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(n => n.toString(16).padStart(2, '0')).join('');
          const image = await createImageBitmap(blob);
          await (window as unknown as { recordSyntheticUpload: (r: unknown) => Promise<void> }).recordSyntheticUpload({ key: data.get('key'), type: blob.type, hash, width: image.width, height: image.height });
          image.close();
        })();
      }
      original.call(this, data);
    };
  });
  return calls;
}

test('48MP camera image becomes a bounded JPEG and appears as a photo', async ({ page, gateway }) => {
  await enter(page, gateway);
  const calls = await observeUploads(page);
  await page.locator('#camera-input').setInputFiles(await jpeg(8064, 6048));
  await uploaded(page);
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0]).toMatchObject({ type: 'image/jpeg', width: 4096, height: 3072 });
});

test('bad image sends nothing and selecting a replacement works', async ({ page, gateway }) => {
  await enter(page, gateway);
  const calls = await observeUploads(page);
  await page.locator('#camera-input').setInputFiles({ name: 'bad.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('broken') });
  await expect(page.getByTestId('upload-message')).toContainText('读不了');
  await expect(page.locator('[data-upload-retry]')).toBeHidden();
  await expect(page.locator('#library-input')).toBeEnabled();
  expect(calls).toHaveLength(0);
  await page.locator('#library-input').setInputFiles(await jpeg());
  await uploaded(page);
});

test('network retry reuses the same key and exact converted bytes', async ({ page, gateway }) => {
  await enter(page, gateway);
  const calls = await observeUploads(page);
  let aborted = false;
  await page.route('**/s/capture', async route => {
    if (route.request().method() === 'POST' && !aborted) { aborted = true; await route.abort(); } else await route.continue();
  });
  await page.locator('#library-input').setInputFiles(await jpeg());
  await expect(page.getByTestId('upload-message')).toContainText('网络没连上');
  await expect.poll(() => calls.length).toBe(1);
  // Prove retry does not re-encode: any second encoding would now throw.
  await page.evaluate(() => { HTMLCanvasElement.prototype.toBlob = () => { throw new Error('must reuse prepared bytes'); }; });
  await page.locator('[data-upload-retry]').click();
  await uploaded(page);
  await expect.poll(() => calls.length).toBe(2);
  expect(calls[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
  expect(calls[1]).toEqual(calls[0]);
});

for (const fault of ['throw', 'wrong-type', 'empty'] as const) {
  test(`encoding ${fault} restores controls and permits retry`, async ({ page, gateway }) => {
    await enter(page, gateway);
    await page.evaluate(mode => {
      const original = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function(callback, ...args) {
        HTMLCanvasElement.prototype.toBlob = original;
        if (mode === 'throw') throw new Error('synthetic encoding exception');
        callback(mode === 'empty' ? null : new Blob(['not JPEG'], { type: 'image/png' }));
      };
    }, fault);
    await page.locator('#library-input').setInputFiles(await jpeg());
    await expect(page.getByTestId('upload-message')).toContainText('转换没完成');
    await expect(page.locator('#camera-input')).toBeEnabled();
    await page.locator('[data-upload-retry]').click();
    await uploaded(page);
  });
}

test('preparation timeout releases busy controls and allows a new selection', async ({ page, gateway }) => {
  await enter(page, gateway);
  await page.clock.install();
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function() { HTMLCanvasElement.prototype.toBlob = original; /* no callback */ };
  });
  await page.locator('#library-input').setInputFiles(await jpeg());
  await expect(page.locator('#camera-input')).toBeDisabled();
  await expect(page.getByTestId('upload-message')).toContainText('准备');
  await page.clock.fastForward(30001);
  await expect(page.getByTestId('upload-message')).toContainText('准备照片超时');
  await expect(page.locator('#camera-input')).toBeEnabled();
  await expect(page.locator('[data-upload-progress]')).toBeHidden();
  await page.locator('#camera-input').setInputFiles(await jpeg());
  await uploaded(page);
});

test('upload timeout and malformed success response never show a false success', async ({ page, gateway }) => {
  await enter(page, gateway);
  await page.evaluate(() => {
    const original = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function(data) {
      if (data instanceof FormData && data.has('photo')) {
        XMLHttpRequest.prototype.send = original;
        this.ontimeout?.call(this, new ProgressEvent('timeout'));
      } else original.call(this, data);
    };
  });
  await page.locator('#library-input').setInputFiles(await jpeg());
  await expect(page.getByTestId('upload-message')).toContainText('上传超时');
  await page.route('**/s/capture', async route => {
    if (route.request().method() === 'POST') await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    else await route.continue();
  });
  await page.locator('[data-upload-retry]').click();
  await expect(page.getByTestId('upload-message')).toContainText('没传上去');
  await expect(page.getByTestId('photo-tile')).toHaveCount(0);
  await expect(page.locator('#library-input')).toBeEnabled();
});

test('unsupported HEIC gives an actionable format error', async ({ page, gateway, browserName }) => {
  test.skip(browserName !== 'chromium');
  await enter(page, gateway);
  await page.locator('#library-input').setInputFiles(path.resolve('tests/fixtures/photo-upload.heic'));
  await expect(page.getByTestId('upload-message')).toContainText('HEIC');
  await expect(page.getByTestId('upload-message')).toContainText('Safari');
  await expect(page.locator('#library-input')).toBeEnabled();
  await expect(page.getByTestId('photo-tile')).toHaveCount(0);
});

test('macOS WebKit decodes real HEIC bytes and uploads through the invitation gateway', async ({ gateway }) => {
  test.skip(process.platform !== 'darwin', 'HEIC decoding requires the macOS system codec');
  const browser = await webkit.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await enter(page, gateway);
    const response = page.waitForResponse(r => r.url().endsWith('/s/capture') && r.request().method() === 'POST');
    await page.locator('#library-input').setInputFiles(path.resolve('tests/fixtures/photo-upload.heic'));
    expect((await response).status()).toBe(200);
    await uploaded(page);
  } finally { await browser.close(); }
});
