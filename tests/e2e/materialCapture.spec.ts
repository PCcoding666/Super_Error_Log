/** Upload regression: isolated invitation students; fixtures contain no student photos. */
import { fork } from 'node:child_process';
import path from 'node:path';
import sharp from 'sharp';
import { expect, test as baseTest, type Page } from '@playwright/test';
const test = baseTest.extend<{
    gateway: {
        base: string;
        codes: string[];
    };
}>({
    gateway: async ({}, use) => {
        const child = fork(path.resolve('tests/e2e/studentHostServer.ts'), [], {
            execArgv: ['--import', 'tsx'], env: { ...process.env, NODE_ENV: 'test', SEL_AI_MODE: 'mock', SEL_E2E_MATERIAL_CAPTURE: '1' },
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        try {
            const ready = await new Promise<{
                base: string;
                codes: string[];
            }>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('fixture startup timeout')), 20000);
                child.once('error', e => { clearTimeout(timer); reject(e); });
                child.once('exit', () => { clearTimeout(timer); reject(new Error('fixture exited')); });
                child.once('message', m => { clearTimeout(timer); resolve(m as {
                    base: string;
                    codes: string[];
                }); });
            });
            await use(ready);
        }
        finally {
            if (child.exitCode === null)
                await new Promise<void>(resolve => {
                    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
                    child.once('exit', () => { clearTimeout(timer); resolve(); });
                    if (child.connected)
                        child.send({ stop: true }, () => { });
                    else
                        child.kill('SIGTERM');
                });
        }
    },
});
// Failure injection must intercept the actual request; SW cache/privacy is covered by studentHost.spec.ts.
test.use({ serviceWorkers: 'block' });
async function enter(page: Page, gateway: {
    base: string;
    codes: string[];
}, index = 0) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(gateway.base + '/s/');
    await page.getByLabel('12 位邀请码').fill(gateway.codes[index]!);
    await page.getByRole('button', { name: '进入我的错题本' }).click();
    await page.getByRole('button', { name: '初中', exact: true }).click();
    await page.goto(gateway.base + '/s/capture');
    await expect(page.locator('[data-material-capture]')).toBeVisible();
    await expect(page.getByTestId('capture-examples')).toBeVisible();
    await expect(page.getByText('阿里云')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '同意，上传' })).toHaveCount(0);
}
// Each call is a different synthetic page: byte-identical photos are deduplicated per student (P1-1).
let shade = 0;
async function jpeg() { shade += 1; return { name: 'synthetic.jpg', mimeType: 'image/jpeg', buffer: await sharp({ create: { width: 240, height: 320, channels: 3, background: { r: (shade * 53) % 256, g: (shade * 97) % 256, b: (shade * 31) % 256 } } }).jpeg().toBuffer() }; }
test('finishes continuous and multi-photo capture without a per-photo picker', async ({ page, gateway }) => {
    await enter(page, gateway);
    await page.locator('#camera-input').setInputFiles(await jpeg());
    await page.locator('#library-input').setInputFiles([await jpeg(), await jpeg()]);
    await expect(page.getByText('照片已保存，可以先离开', { exact: true })).toBeVisible();
    await expect(page.getByTestId('photo-count')).toHaveText('已拍 3 张');
    await expect(page.getByText('勾出做错的题', { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '/tmp/task5-capture-390.png', fullPage: true });
    await page.getByRole('link', { name: '拍完了，查看材料' }).click();
    await expect(page.getByRole('heading', { name: '我的材料' })).toBeVisible();
});
test('never calls a local draft saved and recovers after response loss and reopen', async ({ page, gateway, context }) => {
    await enter(page, gateway);
    await page.route('**/s/materials/uploads**', async (route) => { await route.fetch(); await route.abort(); });
    await page.locator('#library-input').setInputFiles(await jpeg());
    await expect(page.getByText('照片已保存，可以先离开', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '重试', exact: true })).toBeVisible();
    await page.close();
    const reopened = await context.newPage();
    await reopened.goto(gateway.base + '/s/capture');
    await expect(reopened.getByText('照片已保存，可以先离开', { exact: true })).toBeVisible();
    await expect(reopened.getByTestId('photo-count')).toHaveText('已拍 1 张');
});
test('does not accept a queued student A request after switching to B', async ({ page, gateway, context }) => {
    await enter(page, gateway);
    const ns = await page.locator('[data-draft-namespace]').getAttribute('data-draft-namespace');
    await page.request.post(gateway.base + '/s/login', { form: { code: gateway.codes[1]! } }); await page.request.post(gateway.base + '/s/stage', { form: { grade: '初中' } });
    const response = await page.request.post(gateway.base + '/s/materials/captures', { headers: { accept: 'application/json', 'x-draft-namespace': ns! }, data: { requestId: crypto.randomUUID() } });
    expect(response.status()).toBe(409);
    await page.goto(gateway.base + '/s/capture');
    await expect(page.getByTestId('photo-count')).toHaveText('已拍 0 张');
});
test('new queue normalizes a 48MP image to a real bounded JPEG and tags remain optional', async ({ page, gateway }) => {
    await enter(page, gateway);
    let observed: {
        type: string;
        width: number;
        height: number;
    } | undefined;
    await page.exposeFunction('observeMaterial', (v: typeof observed) => { observed = v; });
    await page.evaluate(() => { const send = XMLHttpRequest.prototype.send; XMLHttpRequest.prototype.send = function (data) { if (data instanceof FormData && data.get('photo') instanceof Blob) {
        const blob = data.get('photo') as Blob;
        void createImageBitmap(blob).then(async (image) => { await (window as unknown as {
            observeMaterial: (v: unknown) => Promise<void>;
        }).observeMaterial({ type: blob.type, width: image.width, height: image.height }); image.close(); });
    } send.call(this, data); }; });
    await page.locator('#camera-input').setInputFiles({ name: '48mp.jpg', mimeType: 'image/jpeg', buffer: await sharp({ create: { width: 8064, height: 6048, channels: 3, background: '#bbb' } }).jpeg().toBuffer() });
    await expect(page.getByText('照片已保存，可以先离开', { exact: true })).toBeVisible();
    expect(observed).toEqual({ type: 'image/jpeg', width: 4096, height: 3072 });
});
test('IndexedDB refusal visibly falls back to sequential direct upload without dropping a multi-selection', async ({ page, gateway }) => {
    await page.addInitScript(() => { IDBObjectStore.prototype.put = function () { throw new DOMException('synthetic quota', 'QuotaExceededError'); }; });
    await enter(page, gateway);
    await page.locator('#library-input').setInputFiles([await jpeg(), await jpeg(), await jpeg()]);
    await expect(page.getByText('照片已保存，可以先离开', { exact: true })).toBeVisible();
    await expect(page.getByTestId('photo-count')).toHaveText('已拍 3 张');
    await expect(page.locator('[data-queue-warning]')).toContainText('逐张直传');
});
test('a saved photo never hides a later pending photo and 400 does not loop', async ({ page, gateway }) => {
    await enter(page, gateway);
    await page.locator('#camera-input').setInputFiles(await jpeg());
    await expect(page.getByText('照片已保存，可以先离开', { exact: true })).toBeVisible();
    let requests = 0;
    await page.route('**/s/materials/uploads**', route => { requests++; return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { message: '合成图片错误' } }) }); });
    await page.locator('#library-input').setInputFiles(await jpeg());
    await expect(page.getByRole('button', { name: '重试', exact: true })).toBeVisible();
    await expect(page.getByText('照片已保存，可以先离开', { exact: true })).toHaveCount(0);
    expect(requests).toBe(1);
    await page.getByRole('button', { name: '删除待传', exact: true }).click();
    await expect(page.getByText('照片已保存，可以先离开', { exact: true })).toBeVisible();
});
test('429 respects Retry-After and retries the identical upload ID', async ({ page, gateway }) => {
    await enter(page, gateway);
    const requests: {
        time: number;
        id: string | undefined;
    }[] = [];
    await page.route('**/s/materials/uploads**', async (route) => { requests.push({ time: Date.now(), id: route.request().headers()['x-upload-id'] }); if (requests.length === 1)
        await route.fulfill({ status: 429, headers: { 'retry-after': '2' }, contentType: 'application/json', body: JSON.stringify({ error: { message: '稍后再试' } }) });
    else
        await route.continue(); });
    await page.locator('#library-input').setInputFiles(await jpeg());
    await expect(page.getByText('照片已保存，可以先离开', { exact: true })).toBeVisible({ timeout: 10000 });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.time - requests[0]!.time).toBeGreaterThanOrEqual(1900);
    expect(requests[1]!.id).toBe(requests[0]!.id);
});
test('session expiry preserves its pending namespace and pauses upload', async ({ page, gateway, context }) => {
    await enter(page, gateway);
    await page.route('**/s/materials/uploads**', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { message: '重新登录' } }) }));
    await page.locator('#camera-input').setInputFiles(await jpeg());
    await expect(page.locator('[data-queue-message]')).toContainText('已暂停');
    const count = await page.evaluate(() => new Promise<number>((resolve, reject) => { const open = indexedDB.open('sel-material-drafts', 1); open.onsuccess = () => { const req = open.result.transaction('uploads').objectStore('uploads').count(); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }; }));
    expect(count).toBe(1);
    await expect(page.getByText('照片已保存，可以先离开', { exact: true })).toHaveCount(0);
});
test('settings logout warns about drafts, deletes them and aborts the other tab', async ({ page, gateway, context }) => {
    await enter(page, gateway);
    await page.route('**/s/materials/uploads**', route => route.abort());
    await page.locator('#camera-input').setInputFiles(await jpeg());
    await expect(page.getByRole('button', { name: '重试', exact: true })).toBeVisible();
    const settings = await context.newPage();
    await settings.goto(gateway.base + '/s/settings');
    await settings.getByTestId('logout').click();
    await expect(settings.getByRole('link', { name: '继续上传', exact: true })).toBeVisible();
    await settings.getByRole('button', { name: '删除待传后退出' }).click();
    await expect(settings.getByLabel('12 位邀请码')).toBeVisible();
    await expect(page.locator('[data-queue-message]')).toContainText('已暂停');
});
test('no-JS real invitation form saves one material photo', async ({ browser, gateway }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    try {
        await enter(page, gateway);
        await page.locator('#camera-input').setInputFiles(await jpeg());
        await page.getByRole('button', { name: '上传这张照片' }).click();
        await expect(page.getByRole('heading', { name: '我的材料' })).toBeVisible();
        // The original photo is listed in the folded「整理工具」, which opens without scripts too.
        await page.getByTestId('material-tools').locator('summary').first().click();
        await expect(page.getByAltText('照片 1 原图')).toBeVisible();
        await expect(page.getByText('勾出做错的题', { exact: true })).toHaveCount(0);
    }
    finally {
        await context.close();
    }
});
test('an already dispatched A upload is rejected when released under B cookie', async ({ page, gateway }) => {
    await enter(page, gateway);
    let pending: import('@playwright/test').Route | undefined;
    await page.route('**/s/materials/uploads**', route => { pending = route; });
    await page.locator('#camera-input').setInputFiles(await jpeg());
    await expect.poll(() => !!pending).toBe(true);
    await page.request.post(gateway.base + '/s/login', { form: { code: gateway.codes[1]! } }); await page.request.post(gateway.base + '/s/stage', { form: { grade: '初中' } });
    const next = await page.request.get(gateway.base + '/s/materials/session');
    const ns = (await next.json()).draftNamespace;
    // Re-dispatch the exact delayed body with the now-current cookie, as a queued browser request would.
    const request = pending!.request();
    const result = await page.request.post(request.url(), { headers: { accept: 'application/json', 'content-type': request.headers()['content-type']!, 'x-draft-namespace': request.headers()['x-draft-namespace']!, 'x-upload-id': request.headers()['x-upload-id']! }, data: request.postDataBuffer()! });
    expect(result.status()).toBe(409);
    await pending!.abort();
    const state = await (await page.request.get(gateway.base + '/s/materials/session')).json();
    expect(state).toMatchObject({ draftNamespace: ns, assetCount: 0 });
});
test('same-student reauthentication resumes retained drafts and a stale settings form cannot change B', async ({ page, gateway, context }) => {
    await enter(page, gateway);
    const settings = await context.newPage();
    await settings.goto(gateway.base + '/s/settings');
    await page.route('**/s/materials/uploads**', route => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":{"message":"重新登录"}}' }));
    await page.locator('#camera-input').setInputFiles(await jpeg());
    await expect(page.locator('[data-queue-message]')).toContainText('已暂停');
    await page.unroute('**/s/materials/uploads**');
    await page.request.post(gateway.base + '/s/login', { form: { code: gateway.codes[2]! } });
    await page.reload();
    await expect(page.getByText('照片已保存，可以先离开', { exact: true })).toBeVisible();
    await expect(page.getByTestId('photo-count')).toHaveText('已拍 1 张');
    const oldNamespace = await settings.locator('input[name=namespace]').first().inputValue();
    await page.request.post(gateway.base + '/s/login', { form: { code: gateway.codes[1]! } }); await page.request.post(gateway.base + '/s/stage', { form: { grade: '初中' } });
    expect((await settings.request.post(gateway.base + '/s/settings', { form: { namespace: oldNamespace, practiceSlot: 'changed', paperHome: 'home' } })).status()).toBe(409);
    expect((await settings.request.post(gateway.base + '/s/logout', { form: { namespace: oldNamespace } })).status()).toBe(409);
});
test('cross-tab logout aborts an in-flight upload and clears that draft namespace', async ({ page, gateway, context }) => {
    await enter(page, gateway);
    let held: import('@playwright/test').Route | undefined;
    await page.route('**/s/materials/uploads**', r => { held = r; });
    await page.locator('#camera-input').setInputFiles(await jpeg());
    await expect.poll(() => !!held).toBe(true);
    const settings = await context.newPage();
    await settings.goto(gateway.base + '/s/settings');
    const aborted = page.waitForEvent('requestfailed', r => r.url().endsWith('/materials/uploads'));
    await settings.getByTestId('logout').click();
    await settings.getByRole('button', { name: '删除待传后退出' }).click();
    await aborted;
    await expect(settings.getByLabel('12 位邀请码')).toBeVisible();
    await expect(page.locator('[data-upload-queue] li')).toHaveCount(0);
    await held!.abort().catch(() => { });
});
test('contextual supplement survives a lost response and reload with explicit attempt hints', async ({ page, gateway }) => {
    await enter(page, gateway);
    await page.locator('#camera-input').setInputFiles(await jpeg());
    await expect(page.getByText('照片已保存，可以先离开', { exact: true })).toBeVisible();
    await expect.poll(async () => { await page.goto(gateway.base + '/s/materials'); return page.locator('a[href^="/s/materials/questions/"]').count(); }).toBeGreaterThan(0);
    await page.locator('a[href^="/s/materials/questions/"]').first().click();
    // Supplementing is a folded tool on the question page.
    await page.getByText('补充或调整材料', { exact: true }).click();
    const href = await page.getByRole('link', { name: '补充第 1 次作答', exact: true }).getAttribute('href');
    expect(href).toBeTruthy();
    await page.goto(gateway.base + href!);
    const params = new URLSearchParams(href!.split('?')[1]);
    const hints: {
        questionId?: string;
        attemptId?: string;
    }[] = [];
    await page.route('**/s/materials/uploads**', async (route) => { const body = route.request().postDataBuffer()!.toString(); const value = body.match(/name="hints"\r\n\r\n([^\r]+)/)![1]!; hints.push(JSON.parse(value)); await route.fetch(); await route.abort(); });
    await page.locator('#library-input').setInputFiles(await jpeg());
    await expect(page.getByRole('button', { name: '重试', exact: true })).toBeVisible();
    await page.unroute('**/s/materials/uploads**');
    await page.route('**/s/materials/uploads**', async (route) => { const body = route.request().postDataBuffer()!.toString(); hints.push(JSON.parse(body.match(/name="hints"\r\n\r\n([^\r]+)/)![1]!)); await route.continue(); });
    await page.reload();
    await expect(page.getByText('照片已保存，可以先离开', { exact: true })).toBeVisible();
    expect(hints).toHaveLength(2);
    expect(hints[0]).toEqual({ questionId: params.get('questionId'), attemptId: params.get('attemptId') });
    expect(hints[1]).toEqual(hints[0]);
    await expect(page.getByTestId('photo-count')).toHaveText('已拍 2 张');
});
test('a new account can log out from settings before choosing 初中 or 高中', async ({ page, gateway }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(gateway.base + '/s/');
    await page.getByLabel('12 位邀请码').fill(gateway.codes[0]!);
    await page.getByRole('button', { name: '进入我的错题本' }).click();
    await expect(page.getByTestId('stage-choice')).toBeVisible();
    await page.goto(gateway.base + '/s/settings');
    await page.getByTestId('logout').click();
    await expect(page.getByLabel('12 位邀请码')).toBeVisible();
});
test('logout remains usable when browser draft storage is unavailable', async ({ page, gateway }) => {
    await page.addInitScript(() => { IDBFactory.prototype.open = function () { throw new DOMException('synthetic unavailable', 'SecurityError'); }; });
    await enter(page, gateway);
    await page.goto(gateway.base + '/s/settings');
    await page.getByTestId('logout').click();
    await expect(page.getByText('暂时无法查看待传照片。其他拍照页面可能还有照片没上传。')).toBeVisible();
    await page.getByRole('button', { name: '删除待传后退出' }).click();
    await expect(page.getByLabel('12 位邀请码')).toBeVisible();
});
test('namespace recheck rate limits pause and resume rather than discard drafts', async ({ page, gateway }) => {
    await enter(page, gateway);
    let blocked = false;
    let first = 0;
    let resumed = 0;
    await page.route('**/s/materials/session', async (route) => { if (!blocked) {
        blocked = true;
        first = Date.now();
        await route.fulfill({ status: 429, headers: { 'retry-after': '1' }, contentType: 'application/json', body: '{"error":{"message":"稍后再试"}}' });
    }
    else {
        if (!resumed)
            resumed = Date.now();
        await route.continue();
    } });
    await page.locator('#camera-input').setInputFiles(await jpeg());
    await expect(page.getByText('照片已保存，可以先离开', { exact: true })).toBeVisible({ timeout: 10000 });
    expect(resumed - first).toBeGreaterThanOrEqual(900);
});

test('malformed successful upload responses never acknowledge a saved photo',async({page,gateway})=>{
 await page.route('**/s/materials/uploads**',route=>route.fulfill({status:200,contentType:'application/json',body:'{"ok":true,"assetId":"made-up","job":{}}'}));await enter(page,gateway);await page.locator('#camera-input').setInputFiles(await jpeg());await expect(page.getByRole('button',{name:'重试',exact:true})).toBeVisible();await expect(page.getByText('照片已保存，可以先离开',{exact:true})).toHaveCount(0);
});

test('later draft-update quota failure does not resurrect an acknowledged raw blob',async({page,gateway})=>{
 await page.addInitScript(()=>{const put=IDBObjectStore.prototype.put;let calls=0;IDBObjectStore.prototype.put=function(value,key){if(++calls>1)throw new DOMException('synthetic later quota','QuotaExceededError');return key===undefined?put.call(this,value):put.call(this,value,key)}});
 await enter(page,gateway);await page.locator('#camera-input').setInputFiles(await jpeg());await expect(page.getByText('照片已保存，可以先离开',{exact:true})).toBeVisible();await expect(page.locator('[data-queue-warning]')).toContainText('逐张直传');
 const pending=await page.evaluate(()=>new Promise<number>((resolve,reject)=>{const open=indexedDB.open('sel-material-drafts',1);open.onsuccess=()=>{const count=open.result.transaction('uploads').objectStore('uploads').count();count.onsuccess=()=>resolve(count.result);count.onerror=()=>reject(count.error)}}));expect(pending).toBe(0);await page.reload();await expect(page.getByTestId('photo-count')).toHaveText('已拍 1 张');await expect(page.locator('[data-upload-queue] li')).toHaveCount(0);
});
test('later draft-update failure still deletes its earlier raw row and reports failed deletion honestly',async({page,gateway})=>{
 await page.addInitScript(()=>{const put=IDBObjectStore.prototype.put;let calls=0;IDBObjectStore.prototype.put=function(value,key){if(++calls>1)throw new DOMException('synthetic later quota','QuotaExceededError');return key===undefined?put.call(this,value):put.call(this,value,key)}});
 await enter(page,gateway);await page.route('**/s/materials/uploads**',route=>route.abort());await page.locator('#camera-input').setInputFiles(await jpeg());await expect(page.getByRole('button',{name:'重试',exact:true})).toBeVisible();
 await page.evaluate(()=>{const remove=IDBObjectStore.prototype.delete;IDBObjectStore.prototype.delete=function(key){IDBObjectStore.prototype.delete=remove;throw new DOMException('synthetic deletion failure','UnknownError')}});await page.getByRole('button',{name:'删除待传',exact:true}).click();await expect(page.locator('[data-queue-warning]')).toHaveText('没能删除，请重试。');await expect(page.locator('[data-upload-queue] li')).toHaveCount(1);
 await page.getByRole('button',{name:'删除待传',exact:true}).click();await expect(page.locator('[data-upload-queue] li')).toHaveCount(0);await page.reload();await expect(page.locator('[data-upload-queue] li')).toHaveCount(0);await expect(page.getByTestId('photo-count')).toHaveText('已拍 0 张');
});

test('restore-time quota failure uploads readable drafts with identical IDs and prepared bytes', async ({ page, gateway }) => {
    await page.route('**/s/materials/uploads**', route => route.abort());
    await enter(page, gateway);
    await page.locator('#camera-input').setInputFiles(await jpeg());
    await expect(page.getByRole('button', { name: '重试', exact: true })).toBeVisible();
    const pending = await page.evaluate(() => new Promise<{ uploadId: string; captureId: string; prepared: boolean; bytes: number[] }>((resolve, reject) => {
        const open = indexedDB.open('sel-material-drafts', 1);
        open.onsuccess = () => { const read = open.result.transaction('uploads').objectStore('uploads').getAll(); read.onsuccess = async () => { const row = read.result[0]; resolve({ uploadId: row.uploadId, captureId: row.captureId, prepared: row.prepared, bytes: Array.from(new Uint8Array(await row.blob.arrayBuffer())) }); open.result.close(); }; read.onerror = () => reject(read.error); };
    }));
    expect(pending.prepared).toBe(true);
    await page.unroute('**/s/materials/uploads**');
    let replayId = '', replayBody: Buffer | null = null;
    await page.route('**/s/materials/uploads**', async route => { replayId = route.request().headers()['x-upload-id']!; replayBody = route.request().postDataBuffer(); await route.continue(); });
    await page.addInitScript(() => { IDBObjectStore.prototype.put = function () { throw new DOMException('synthetic restore quota', 'QuotaExceededError'); }; });
    await page.reload();
    await expect(page.locator('[data-queue-warning]')).toContainText('逐张直传');
    await expect(page.getByText('照片已保存，可以先离开', { exact: true })).toBeVisible();
    expect(replayId).toBe(pending.uploadId);
    expect(replayBody!.includes(Buffer.from(pending.bytes))).toBe(true);
    expect(replayBody!.includes(Buffer.from(pending.captureId))).toBe(true);
    await expect(page.locator('[data-upload-queue] li')).toHaveCount(0);
    expect(await page.evaluate(() => new Promise<number>((resolve, reject) => {
        const open = indexedDB.open('sel-material-drafts', 1);
        open.onsuccess = () => { const count = open.result.transaction('uploads').objectStore('uploads').count(); count.onsuccess = () => { resolve(count.result); open.result.close(); }; count.onerror = () => reject(count.error); };
    }))).toBe(0);
    await page.reload();
    await expect(page.getByTestId('photo-count')).toHaveText('已拍 1 张');
    await expect(page.locator('[data-upload-queue] li')).toHaveCount(0);
    // The account was never paused: new captures still work with the same storage failure.
    await page.locator('#camera-input').setInputFiles(await jpeg());
    await expect(page.getByTestId('photo-count')).toHaveText('已拍 2 张');
});

test('lost acknowledgement replays after optional hints and document edits without reverting metadata', async ({ page, gateway }) => {
    let saved: { assetId: string; job: { id: string } } | undefined;
    await page.route('**/s/materials/uploads**', async route => { saved = await (await route.fetch()).json(); await route.abort(); });
    await enter(page, gateway);
    await page.locator('#camera-input').setInputFiles(await jpeg());
    await expect(page.getByRole('button', { name: '重试', exact: true })).toBeVisible();
    const namespace = await page.locator('[data-material-capture]').getAttribute('data-draft-namespace');
    const headers = { accept: 'application/json', 'x-draft-namespace': namespace! };
    expect((await page.request.post(gateway.base + `/s/materials/assets/${saved!.assetId}/hints`, { headers, data: { label: 'later label', roles: ['reference_answer'], marking: 'unmarked' } })).status()).toBe(200);
    expect((await page.request.post(gateway.base + `/s/materials/assets/${saved!.assetId}/document`, { headers, data: { newDocument: true, expectedRevision: 1 } })).status()).toBe(200);
    await page.unroute('**/s/materials/uploads**');
    let replay: typeof saved;
    await page.route('**/s/materials/uploads**', async route => { const response = await route.fetch(); replay = await response.json(); await route.fulfill({ response }); });
    await page.reload();
    await expect(page.getByText('照片已保存，可以先离开', { exact: true })).toBeVisible();
    expect(replay).toMatchObject({ assetId: saved!.assetId, job: { id: saved!.job.id }, created: false });
    await expect(page.getByTestId('photo-count')).toHaveText('已拍 1 张');
    await expect(page.locator('[data-upload-queue] li')).toHaveCount(0);
    await page.goto(gateway.base + '/s/materials');
    // Original photos and page ownership live in the folded「整理工具」.
    await page.getByTestId('material-tools').locator('summary').first().click();
    await expect(page.getByRole('heading', { name: '照片 1 · later label' })).toBeVisible();
});

test('a temporary restore preflight failure recovers without claiming an account change', async ({ page, gateway }) => {
    await page.route('**/s/materials/uploads**', route => route.abort());
    await enter(page, gateway);
    await page.locator('#camera-input').setInputFiles(await jpeg());
    await expect(page.getByRole('button', { name: '重试', exact: true })).toBeVisible();
    await page.unroute('**/s/materials/uploads**');
    let failed = false;
    await page.route('**/s/materials/session', route => {
        if (!failed) { failed = true; return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }); }
        return route.continue();
    });
    await page.reload();
    await expect(page.locator('[data-queue-warning]')).toContainText('暂时无法恢复');
    await expect(page.locator('[data-queue-message]')).not.toContainText('登录状态');
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.getByText('照片已保存，可以先离开', { exact: true })).toBeVisible();
    await expect(page.getByTestId('photo-count')).toHaveText('已拍 1 张');
});

test('unverifiable legacy upload identity retains the server photo and offers local cleanup without retrying', async ({ page, gateway }) => {
    let requests = 0;
    // HTTP migration behavior is covered by materialRoutes; inject its exact terminal response here.
    await page.route('**/s/materials/uploads**', async route => {
        requests++;
        await route.fetch();
        await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'upload_identity_unavailable', message: '这张照片已保留在服务器，但旧上传信息无法核对。请先点“拍完了，查看材料”核对，再删除这条待传记录；不用重新拍照。' } }) });
    });
    await enter(page, gateway);
    await page.locator('#camera-input').setInputFiles(await jpeg());
    await expect(page.locator('[data-upload-queue]')).toContainText('已保留在服务器');
    await expect(page.getByRole('button', { name: '重试', exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.locator('[data-upload-queue]')).toContainText('删除这条待传记录');
    expect(requests).toBe(1);
    await page.getByRole('button', { name: '删除待传', exact: true }).click();
    await expect(page.locator('[data-upload-queue] li')).toHaveCount(0);
    await expect(page.getByTestId('photo-count')).toHaveText('已拍 1 张');
});

// ---------- P0-13 / P1-3 / P1-4 / P1-1：上传韧性（合成照片、合成学生） ----------
async function pendingDrafts(page: Page): Promise<number> {
    return page.evaluate(() => new Promise<number>((resolve, reject) => { const open = indexedDB.open('sel-material-drafts', 1); open.onsuccess = () => { const req = open.result.transaction('uploads').objectStore('uploads').count(); req.onsuccess = () => { resolve(req.result); open.result.close(); }; req.onerror = () => reject(req.error); }; }));
}
test('P0-13: a release restart (empty 502/503) is retried automatically with the same upload ID', async ({ page, gateway }) => {
    await enter(page, gateway);
    const seen: { at: number; id: string | undefined }[] = [];
    await page.route('**/s/materials/uploads**', async route => {
        seen.push({ at: Date.now(), id: route.request().headers()['x-upload-id'] });
        if (seen.length === 1) return route.fulfill({ status: 502, body: '' });
        if (seen.length === 2) return route.fulfill({ status: 503, contentType: 'text/html', body: '<h1>暂时进不去</h1>' });
        return route.continue();
    });
    await page.locator('#library-input').setInputFiles([await jpeg(), await jpeg()]);
    await expect(page.locator('[data-queue-message]')).toContainText('暂时连不上服务器');
    await expect(page.getByRole('button', { name: '全部重试', exact: true })).toBeVisible();
    await expect(page.getByText('请先留在这一页')).toHaveCount(0);
    await expect(page.getByText('照片已保存，可以先离开', { exact: true })).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId('photo-count')).toHaveText('已拍 2 张');
    expect(seen.length).toBe(4);
    expect(seen[1]!.id).toBe(seen[0]!.id);
    expect(seen[2]!.id).toBe(seen[0]!.id);
    expect(seen[1]!.at - seen[0]!.at).toBeGreaterThanOrEqual(1500);
    expect(seen[2]!.at - seen[1]!.at).toBeGreaterThanOrEqual(3000);
    await expect(page.getByRole('button', { name: '全部重试', exact: true })).toBeHidden();
    expect(await pendingDrafts(page)).toBe(0);
});
test('P0-13: dropped connections back off by themselves; 全部重试 skips the remaining wait', async ({ page, gateway }) => {
    await enter(page, gateway);
    let down = true; let requests = 0;
    await page.route('**/s/materials/uploads**', route => { requests++; return down ? route.abort('connectionreset') : route.continue(); });
    await page.locator('#library-input').setInputFiles([await jpeg(), await jpeg(), await jpeg()]);
    await expect.poll(() => requests, { timeout: 15000 }).toBeGreaterThanOrEqual(3);
    await expect(page.locator('[data-upload-queue]')).toContainText('秒后自动重试');
    expect(await pendingDrafts(page)).toBe(3);
    down = false;
    const before = requests;
    await page.getByRole('button', { name: '全部重试', exact: true }).click();
    await expect(page.getByText('照片已保存，可以先离开', { exact: true })).toBeVisible({ timeout: 8000 });
    await expect(page.getByTestId('photo-count')).toHaveText('已拍 3 张');
    expect(requests - before).toBe(3);
});
test('P1-4: a corrupt photo is marked as unusable without a doomed retry while the others upload', async ({ page, gateway }) => {
    await enter(page, gateway);
    let requests = 0;
    await page.route('**/s/materials/uploads**', route => { requests++; return route.continue(); });
    await page.locator('#library-input').setInputFiles([await jpeg(), { name: 'broken.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('synthetic broken bytes') }, await jpeg()]);
    await expect(page.getByTestId('photo-count')).toHaveText('已拍 2 张', { timeout: 15000 });
    const broken = page.locator('[data-upload-queue] li');
    await expect(broken).toHaveCount(1);
    await expect(broken).toContainText('传不上去');
    await expect(broken).toContainText('可能已经损坏');
    await expect(page.getByRole('button', { name: '重试', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '全部重试', exact: true })).toBeHidden();
    await expect(page.locator('[data-queue-message]')).toHaveText('其他照片已保存。有 1 张传不了，删掉后重新选择。');
    await expect(page.getByRole('link', { name: '拍完了，查看材料' })).toBeVisible();
    expect(requests).toBe(2);
    await page.waitForTimeout(2500);
    expect(requests).toBe(2);
    await page.getByRole('button', { name: '删除待传', exact: true }).click();
    await expect(page.getByText('照片已保存，可以先离开', { exact: true })).toBeVisible();
});
test('P1-4: a server-rejected unreadable image is not offered a retry', async ({ page, gateway }) => {
    await enter(page, gateway);
    let requests = 0;
    await page.route('**/s/materials/uploads**', route => { requests++; return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { code: 'invalid_image', message: '照片无法读取、已损坏或超过像素限制，请补拍。' } }) }); });
    await page.locator('#camera-input').setInputFiles(await jpeg());
    await expect(page.locator('[data-upload-queue]')).toContainText('传不上去：照片无法读取');
    await expect(page.getByRole('button', { name: '重试', exact: true })).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(500);
    expect(requests).toBe(1);
});
test('P1-4: while uploading, the hint and the way out both say leaving is fine', async ({ page, gateway }) => {
    await enter(page, gateway);
    // Nothing taken yet: one filled button, no way out and no upload status.
    await expect(page.locator('.btn.primary:visible')).toHaveText(['拍照']);
    await expect(page.getByTestId('capture-done')).toBeHidden();
    await expect(page.getByTestId('photo-count')).toBeHidden();
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/s/materials/uploads**', async route => { await gate; await route.continue(); });
    await page.locator('#library-input').setInputFiles([await jpeg(), await jpeg()]);
    const done = page.getByTestId('capture-done');
    await expect(done).toHaveAccessibleName('上传中 0/2（可以离开）');
    await expect(done.locator('[data-done-text]')).toHaveText('上传中 0/2（可以离开）');
    await expect(page.locator('[data-queue-message]')).toContainText('可以先离开，回到这一页会接着传');
    await expect(page.getByText('请先留在这一页')).toHaveCount(0);
    release();
    await expect(page.getByText('照片已保存，可以先离开', { exact: true })).toBeVisible();
    await expect(done.locator('[data-done-text]')).toHaveText('拍完了，查看材料');
    await expect(page.locator('.btn.primary:visible')).toHaveText(['继续拍照']);
    await expect(page.locator('[data-capture-thumbs] img')).toHaveCount(2);
});
test('P1-3: photos chosen at the moment the login expired stay on the phone and resume after logging in again', async ({ page, gateway }) => {
    await enter(page, gateway);
    // The session ends while the capture page is open (the browser then drops its cookie).
    expect((await page.request.post(gateway.base + '/s/logout', { headers: { origin: gateway.base } })).status()).toBeLessThan(400);
    await page.locator('#library-input').setInputFiles([await jpeg(), await jpeg()]);
    await expect(page.locator('[data-queue-message]')).toContainText('登录已过期，上传已暂停。还没传的 2 张照片存在这台手机上，重新登录后回到这一页会接着传。');
    await expect(page.getByRole('link', { name: '重新登录', exact: true })).toBeVisible();
    expect(await pendingDrafts(page)).toBe(2);
    await page.getByRole('link', { name: '重新登录', exact: true }).click();
    await page.getByLabel('12 位邀请码').fill(gateway.codes[2]!);
    await page.getByRole('button', { name: '进入我的错题本' }).click();
    await expect(page.locator('[data-pending-uploads]')).toContainText('还有 2 张照片没传完');
    await page.getByRole('link', { name: '回拍照页继续上传' }).click();
    await expect(page.getByText('照片已保存，可以先离开', { exact: true })).toBeVisible();
    await expect(page.getByTestId('photo-count')).toHaveText('已拍 2 张');
    expect(await pendingDrafts(page)).toBe(0);
});
test('P1-3: another account logging in on this phone does not inherit the pending photos', async ({ page, gateway }) => {
    await enter(page, gateway);
    expect((await page.request.post(gateway.base + '/s/logout', { headers: { origin: gateway.base } })).status()).toBeLessThan(400);
    await page.locator('#camera-input').setInputFiles(await jpeg());
    await expect(page.locator('[data-queue-message]')).toContainText('登录已过期');
    await page.goto(gateway.base + '/s/');
    await page.getByLabel('12 位邀请码').fill(gateway.codes[1]!);
    await page.getByRole('button', { name: '进入我的错题本' }).click();
    // A new account picks its stage once when the first-run stage gate exists (no-op otherwise).
    await page.request.post(gateway.base + '/s/stage', { form: { grade: '初中' } });
    await page.goto(gateway.base + '/s/capture');
    await expect(page.getByTestId('photo-count')).toHaveText('已拍 0 张');
    await expect(page.locator('[data-upload-queue] li')).toHaveCount(0);
    await expect.poll(() => pendingDrafts(page)).toBe(0);
});
