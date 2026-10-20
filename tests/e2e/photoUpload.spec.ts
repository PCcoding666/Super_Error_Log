/** Upload regression: isolated invitation students; fixtures contain no student photos. */
import { fork } from 'node:child_process';
import path from 'node:path';
import sharp from 'sharp';
import { expect, test as baseTest, webkit, type Page } from '@playwright/test';

const test = baseTest.extend<{ gateway: { base: string; codes: string[]; reloginCodes: string[] } }>({
  gateway: async ({}, use) => {
    const child = fork(path.resolve('tests/e2e/studentHostServer.ts'), [], {
      execArgv: ['--import', 'tsx'], env: { ...process.env, NODE_ENV: 'test', SEL_AI_MODE: 'mock' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    try {
      const ready = await new Promise<{ base: string; codes: string[]; reloginCodes: string[] }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('fixture startup timeout')), 20000);
        child.once('error', e => { clearTimeout(timer); reject(e); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error('fixture exited')); });
        child.once('message', m => { clearTimeout(timer); resolve(m as { base: string; codes: string[]; reloginCodes: string[] }); });
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
async function jpeg(width = 820, height = 1100, background = '#c6cff2') {
  return { name: 'page.jpg', mimeType: 'image/jpeg', buffer: await sharp({ create: { width, height, channels: 3, background } }).jpeg().toBuffer() };
}
async function uploaded(page: Page) {
  await expect(page.getByTestId('photo-count')).toHaveText('已拍 1 张');
  await expect(page.getByTestId('photo-tile')).toHaveCount(0);
  await expect(page.locator('#upload-form')).not.toHaveAttribute('data-upload-pending');
}

test('5-question paper stays intact after adding 2 questions from home, refresh and invitation relogin', async ({ page, gateway }, info) => {
  test.setTimeout(120000);
  await page.addInitScript(() => { window.print = () => window.dispatchEvent(new Event('afterprint')); });
  await enter(page, gateway);
  // Each synthetic worker photo has one unmarked candidate. All data enters through the real gateway.
  const addOne = async (number: number) => {
    await page.locator('#library-input').setInputFiles(await jpeg(820 + number, 1100));
    await expect(page.getByTestId('photo-count')).toHaveText(`已拍 ${number} 张`);
    await expect(page.locator('#upload-form')).not.toHaveAttribute('data-upload-pending');
    await expect(page.getByTestId('next-step-primary')).toHaveText('拍照录入');
    await page.getByRole('link',{name:'已上传记录',exact:true}).click();
    await expect(page).toHaveURL(/\/s\/photos(?:\?|$)/);
    const row = page.getByTestId(`photo-row-${number}`);
    await expect(row).toContainText('这页没有批改痕迹', { timeout: 15000 });
    await row.getByRole('link', { name: '勾出错题', exact: true }).click();
    await page.getByTestId('pick-candidate').click();
    await page.getByTestId('next-step-primary').click();
    await expect(page.getByTestId(`photo-row-${number}`)).toContainText('已新增 1 道错题', { timeout: 15000 });
  };
  for (let number = 1; number <= 5; number++) {
    if (number > 1) await page.goto(gateway.base + '/s/capture');
    await addOne(number);
  }
  await page.goto(gateway.base + '/s/choose');
  await expect(page.getByTestId('choose-row')).toHaveCount(5);
  await page.getByTestId('next-step-primary').click();
  await expect(page.getByTestId('practice-question')).toBeVisible({timeout:15000});
  await page.getByRole('link',{name:'打印练习',exact:true}).click();
  await expect(page.getByTestId('next-step-primary')).toHaveText('打印', { timeout: 15000 });
  const printPath = new URL(page.url()).pathname;
  const sheetPath = await page.getByTestId('sheet-link').getAttribute('href');
  expect(sheetPath).toBeTruthy();
  // Relogin rotates the voice-context session marker; compare all paper markup unchanged.
  const paperMarkup = (html: string) => html.replace(/<meta name="sel-voice-context" content="[^"]*"\s*\/>/g, '');
  const beforeSheet = paperMarkup(await (await page.request.get(gateway.base + sheetPath)).text());
  await page.getByTestId('next-step-primary').click();
  await page.getByTestId('next-step-primary').click();
  await expect(page.getByTestId('practice-question')).toBeVisible();
  await page.goto(gateway.base + '/s/');
  const add = page.getByTestId('tab-capture');
  await expect(add).toBeVisible();
  await page.screenshot({ path: info.outputPath('home-paper-ready.png'), fullPage: true });
  for (let number = 6; number <= 7; number++) {
    await page.goto(gateway.base + '/s/capture');
    await expect(page).toHaveURL(/\/s\/capture$/);
    await addOne(number);
    if (number === 6) await page.goto(gateway.base + '/s/');
  }
  await expect(page.getByTestId('photos-added-status')).toHaveText('已新增 2 道错题');
  await expect(page.getByTestId('photos-after-week')).toContainText('已保存到错题本，这次补充不会改变之前的练习纸。');
  await page.screenshot({ path: info.outputPath('supplement-saved.png'), fullPage: true });
  await page.getByTestId('photos-items').click();
  await expect(page.getByTestId('item-card')).toHaveCount(7);
  const numbers = await page.getByTestId('item-card').locator('.meta-line.muted').allTextContents();
  for (let n = 1; n <= 7; n++) expect(numbers.join('\n')).toContain(`M-${String(n).padStart(2, '0')}`);
  for (const group of await page.locator('.chapter-group details').all()) {
    if (!(await group.getAttribute('open'))) await group.locator('summary').click();
  }
  await page.getByTestId('item-card').last().click();
  await expect(page.getByTestId('question-text')).toHaveText('求 x 的值。');
  await page.goto(gateway.base + '/s/');
  await page.reload();
  await expect(add).toBeVisible();
  await expect(page.getByRole('heading',{name:'错题本',exact:true})).toBeVisible();
  await page.goto(gateway.base + '/s/settings');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '输入邀请码' })).toBeVisible();
  await page.getByLabel('12 位邀请码').fill(gateway.reloginCodes[0]!);
  await page.getByRole('button', { name: '进入我的错题本' }).click();
  await expect(add).toBeVisible();
  await expect(page.getByRole('heading',{name:'错题本',exact:true})).toBeVisible();
  await page.goto(gateway.base + printPath);
  await expect(page.getByTestId('print-summary')).toContainText('这张练习纸上有 5 道题');
  expect(paperMarkup(await (await page.request.get(gateway.base + sheetPath)).text())).toBe(beforeSheet);
  await page.getByTestId('next-step-primary').click();
  await expect(page.getByTestId('next-step-primary')).toHaveText('打印好了，记录结果');
  // Existing result entry still contains exactly the original five questions.
  await page.goto(gateway.base + printPath.replace('/print/', '/record/'));
  await page.getByTestId('record-day').first().click();
  await page.getByTestId('next-step-primary').click();
  for (let i = 1; i <= 5; i++) {
    await expect(page.getByTestId('next-step-caption')).toHaveText(`第 ${i} 道，共 5 道`);
    await page.getByTestId('completion-independent').click();
    await page.getByTestId('correct-yes').click();
    await page.getByTestId('next-step-primary').click();
  }
  await expect(page.getByTestId('results-head')).toHaveText('5 道里，独立做对 5 道');
});
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

test('album queue uploads five photos once, keeps four successes, and retries only the failed photo', async ({ page, gateway }) => {
  await enter(page, gateway);
  const calls = await observeUploads(page);
  let releaseFirst!: () => void;
  const held = new Promise<void>(resolve => { releaseFirst = resolve; });
  let posts = 0, active = 0, maxActive = 0;
  const accepted: string[] = [];
  await page.route('**/s/capture', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    const attempt = ++posts;
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      if (attempt === 1) await held;
      if (attempt === 3) { await route.abort(); return; }
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      accepted.push((await response.json() as { jobId: string }).jobId);
      await route.fulfill({ response });
    } finally { active -= 1; }
  });
  const files = await Promise.all(['#c6cff2', '#c7cff2', '#c8cff2', '#c9cff2', '#cAcff2'].map(async (color, i) => ({ ...await jpeg(820, 1100, color), name: `卷子-${i + 1}.jpg` })));
  await expect(page.locator('#library-input')).toHaveAttribute('multiple');
  await expect(page.locator('#camera-input')).toHaveAttribute('capture', 'environment');
  await expect(page.locator('#camera-input')).not.toHaveAttribute('multiple');
  await page.locator('#library-input').setInputFiles(files);
  await expect(page.locator('#upload-form')).toHaveAttribute('data-upload-pending');
  await expect.poll(() => posts).toBe(1);
  const rows = page.locator('[data-upload-item]');
  await expect(rows).toHaveCount(5);
  await expect(rows.first()).toContainText('卷子-1.jpg');
  await expect(rows.nth(1)).toContainText('等待上传');
  await expect(page.locator('#library-input')).toBeDisabled();
  await expect(page.locator('[data-upload-progress]')).toBeVisible();
  await expect(page.getByRole('progressbar', { name: '整批上传进度' })).not.toHaveAttribute('aria-valuenow', '100');
  // Duplicate DOM events and form submits cannot enqueue another copy of the selected batch.
  await page.evaluate(() => {
    document.querySelector('#library-input')!.dispatchEvent(new Event('change'));
    document.querySelector('#upload-form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  });
  releaseFirst();
  await expect(page.getByTestId('upload-message')).toContainText('已上传 4/5 张');
  await expect(page.getByTestId('upload-message')).toContainText('1 张失败');
  await expect(rows.locator('[data-upload-state="succeeded"]')).toHaveCount(4);
  await expect(rows.locator('[data-upload-state="failed"]')).toHaveCount(1);
  await expect(page.getByRole('progressbar', { name: '整批上传进度' })).toHaveAttribute('aria-valuenow', '80');
  await expect(page.locator('[data-upload-next]')).toBeVisible();
  await expect(page.getByTestId('capture-tips')).toBeHidden();
  await expect(page.getByTestId('next-step-primary')).toHaveText('再拍一页');
  expect(await page.locator('[data-upload-retry]').evaluate(button => {
    const bounds = button.getBoundingClientRect();
    return bounds.top >= 0 && bounds.bottom <= window.innerHeight - 100;
  })).toBe(true);
  await expect.poll(async () => {
    const html = await (await page.request.get(gateway.base + '/s/photos')).text();
    return (html.replace(/<[^>]+>/g, '').match(/这页没有批改痕迹/g) ?? []).length;
  }).toBe(4);
  expect(posts).toBe(5);
  expect(maxActive).toBe(1);
  expect(new Set(accepted).size).toBe(4);
  await expect.poll(() => calls.length).toBe(5);
  // All prepared bytes remain reusable, and rapid retry clicks must start only one request.
  await page.evaluate(() => {
    HTMLCanvasElement.prototype.toBlob = () => { throw new Error('successful preparation must be reused'); };
    const retry = document.querySelector<HTMLButtonElement>('[data-upload-retry]')!;
    retry.click(); retry.click(); retry.dispatchEvent(new Event('click'));
  });
  await expect(page.getByTestId('photo-count')).toHaveText('已拍 5 张');
  await expect(page.getByTestId('photo-tile')).toHaveCount(0);
  await expect(page.locator('#upload-form')).not.toHaveAttribute('data-upload-pending');
  await expect.poll(() => calls.length).toBe(6);
  expect(calls[5]).toEqual(calls[2]);
  expect(new Set(calls.map(call => call.key)).size).toBe(5);
  expect(new Set(accepted).size).toBe(5);
  expect(posts).toBe(6);
  expect(maxActive).toBe(1);
});

test('per-photo and batch progress wait for the final server acknowledgement', async ({ page, gateway }) => {
  await enter(page, gateway);
  await page.evaluate(() => {
    const original = XMLHttpRequest.prototype.send;
    let sent = 0;
    XMLHttpRequest.prototype.send = function(data) {
      if (data instanceof FormData && data.has('photo') && ++sent === 5) {
        const xhr = this;
        const controls = window as unknown as { finishSyntheticProgress: () => void; resumeSyntheticUpload: () => void };
        xhr.upload.dispatchEvent(new ProgressEvent('progress', { lengthComputable: true, loaded: 50, total: 100 }));
        controls.finishSyntheticProgress = () => { xhr.upload.dispatchEvent(new ProgressEvent('progress', { lengthComputable: true, loaded: 100, total: 100 })); };
        controls.resumeSyntheticUpload = () => original.call(xhr, data);
      } else original.call(this, data);
    };
  });
  const files = await Promise.all(['#a1bbcc', '#a2bbcc', '#a3bbcc', '#a4bbcc', '#a5bbcc'].map(color => jpeg(820, 1100, color)));
  await page.locator('#library-input').setInputFiles(files);
  const progress = page.getByRole('progressbar', { name: '整批上传进度' });
  await expect(page.getByRole('progressbar', { name: '第 5 张上传进度' })).toHaveAttribute('aria-valuenow', '50');
  await expect(page.locator('[data-upload-item]').nth(4)).toContainText('正在上传 50%');
  await expect(progress).toHaveAttribute('aria-valuenow', '90');
  await page.evaluate(() => (window as unknown as { finishSyntheticProgress: () => void }).finishSyntheticProgress());
  await expect(page.locator('[data-upload-item]').nth(4)).toContainText('上传完成，正在处理照片');
  await expect(progress).toHaveAttribute('aria-valuenow', '99');
  await expect(page.getByTestId('upload-message')).toContainText('已上传 4/5 张');
  await page.evaluate(() => (window as unknown as { resumeSyntheticUpload: () => void }).resumeSyntheticUpload());
  await expect(page.getByTestId('photo-count')).toHaveText('已拍 5 张');
  // Success returns to an empty upload form, without historical photos.
  await expect(page.locator('[data-upload-item]')).toHaveCount(0);
  await expect(page.getByTestId('photo-tile')).toHaveCount(0);
  await expect(page.locator('#upload-form')).not.toHaveAttribute('data-upload-pending');
});

test('a lost success response retries the existing recognition job instead of creating another', async ({ page, gateway }) => {
  await enter(page, gateway);
  const calls = await observeUploads(page);
  const jobs: string[] = [];
  await page.route('**/s/capture', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    jobs.push((await response.json() as { jobId: string }).jobId);
    if (jobs.length === 1) await route.abort();
    else await route.fulfill({ response });
  });
  await page.locator('#library-input').setInputFiles(await jpeg());
  await expect(page.getByTestId('upload-message')).toContainText('网络没连上');
  await page.locator('[data-upload-retry]').click();
  await uploaded(page);
  await expect.poll(() => calls.length).toBe(2);
  expect(calls[1]).toEqual(calls[0]);
  expect(jobs).toHaveLength(2);
  expect(jobs[1]).toBe(jobs[0]);
});

test('an unreadable photo does not stop later photos or discard earlier successes on a new selection', async ({ page, gateway }) => {
  await enter(page, gateway);
  const calls = await observeUploads(page);
  await page.locator('#library-input').setInputFiles([
    { ...await jpeg(), name: '第一页.jpg' },
    { name: '<坏图>.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('broken') },
    { ...await jpeg(820, 1100, '#aabbcc'), name: '第三页.jpg' },
  ]);
  await expect(page.getByTestId('upload-message')).toContainText('已上传 2/3 张');
  await expect(page.locator('[data-upload-item]').nth(1)).toContainText('<坏图>.jpg');
  await expect(page.locator('[data-upload-item]').nth(1)).toContainText('读不了');
  await expect(page.locator('[data-upload-retry]')).toBeHidden();
  await expect(page.locator('#camera-input')).toBeEnabled();
  await page.locator('#library-input').setInputFiles({ ...await jpeg(820, 1100, '#ccbbaa'), name: '替换照片.jpg' });
  await expect(page.getByTestId('upload-message')).toContainText('已上传 3/4 张');
  await expect(page.locator('[data-upload-item]')).toHaveCount(4);
  expect(calls).toHaveLength(3);
  expect(new Set(calls.map(call => call.key)).size).toBe(3);
});

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


test('upload entry stays in the first screen and history shows compact previews', async ({ page, gateway }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await enter(page, gateway);
  const files = await Promise.all(['#a1bbcc', '#a2bbcc', '#a3bbcc', '#a4bbcc', '#a5bbcc'].map(color => jpeg(820, 1100, color)));
  await page.locator('#library-input').setInputFiles(files);
  await expect(page.getByTestId('photo-count')).toHaveText('已拍 5 张');
  await expect(page.locator('#upload-form')).not.toHaveAttribute('data-upload-pending');
  await expect(page.getByTestId('next-step-primary')).toHaveText('拍照录入');
  await expect(page.getByTestId('next-step-primary')).toBeInViewport();
  await expect(page.getByTestId('next-step-secondary-library')).toBeInViewport();
  await expect(page.locator('img[src*="/s/img/photo/"]')).toHaveCount(0);
  await page.getByRole('link', { name: '已上传记录', exact: true }).click();
  const previews = page.locator('.photo-record img');
  await expect(previews).toHaveCount(5);
  await expect(page.locator('.photo-record').first()).toHaveAttribute('data-testid', 'photo-row-5');
  expect((await page.locator('.photo-record').allTextContents()).join('')).not.toMatch(/第.*张/);
  const preview = previews.first();
  expect(await preview.evaluate(img => {
    const box = img.getBoundingClientRect();
    return box.width <= 100 && box.height <= 120;
  })).toBe(true);
  await expect(preview).toHaveAttribute('loading', 'lazy');
  const original = page.waitForEvent('popup');
  await page.locator('.photo-preview').first().click();
  const popup = await original;
  await expect(popup).toHaveURL(/\/s\/img\/photo\/[^?]+\?full=1$/);
  await popup.close();
  await expect(page).toHaveURL(/\/s\/photos$/);
  await page.getByRole('link', { name: '新增录入', exact: true }).click();
  await expect(page.getByTestId('next-step-primary')).toBeInViewport();
});
