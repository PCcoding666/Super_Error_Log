/**
 * 学生网页版（/s/）的手机尺寸 E2E：iPhone 13 视口（390×844、3 倍屏、触屏、iOS Safari UA，Chromium 内核）。
 * 合成服务器见 tests/e2e/webClientServer.ts（真实云端装配 + 合成识别 + mock 语音转写）。
 *
 * J7-网页版：周末 A 只按底部「下一步」按钮走完（主按钮或它旁边的次要按钮）。下面几处不是下一步按钮、但没法替他点：
 * 系统相机 / 相册（选一张）、选题页与录结果页上的勾选（页面内容本身）。
 * 周末 B：把记录整体往前挪 7 天（= 过了一周），先拍、再录上周练习纸的结果、勾没批改的页、选题、
 * 用语音（Chromium 的假麦克风 → mock 转写）说一道为什么错，打印，回到今天。
 * 文件最后是 quality round 2 的行为：局部轮询、关掉脚本时的 meta refresh、减少动态效果、录音反馈、服务器忙页、选项断行。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { expect, test, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';

const WEB = 'http://127.0.0.1:3196';
const CONTROL = 'http://127.0.0.1:3197';
const STATE = path.join(os.tmpdir(), 'sel-web-e2e-storage.json');
const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';

test.describe.configure({ mode: 'serial' });
test.use({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IPHONE_SAFARI,
  locale: 'zh-CN', permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
});

async function synthetic(color: string, width: number): Promise<Buffer> {
  return sharp({ create: { width, height: Math.round(width * 1.35), channels: 3, background: color } }).jpeg({ quality: 85 }).toBuffer();
}

const primary = (page: Page) => page.getByTestId('next-step-primary');
const secondary = (page: Page, key: string) => page.getByTestId(`next-step-secondary-${key}`);

/** 底部下一步按钮在，并且主按钮写的是 title；然后点它。 */
async function next(page: Page, title: string | RegExp, timeout = 20_000): Promise<void> {
  await expect(page.getByTestId('next-step-bar')).toBeVisible();
  await expect(primary(page)).toHaveText(title, { timeout });
  await expect(primary(page)).toBeEnabled();
  await primary(page).click();
}

/** 等自动刷新的页面（找题中 / 准备中）变成下一步。 */
async function waitForPrimary(page: Page, title: string | RegExp, timeout = 45_000): Promise<void> {
  await expect(async () => {
    await expect(primary(page)).toHaveText(title, { timeout: 1_000 });
    await expect(primary(page)).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout });
}

async function shoot(page: Page, bytes: Buffer, name: string): Promise<void> {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), primary(page).click()]);
  expect(chooser.isMultiple()).toBe(false);
  await chooser.setFiles({ name, mimeType: 'image/jpeg', buffer: bytes });
}

/** 打印：拦下系统打印对话框（headless 没有打印机），照样触发 afterprint。 */
/** 网页版互动记录（服务器审计日志里 web_* 的行），按「类型 路由#动作」列出。 */
async function trailLines(request: import('@playwright/test').APIRequestContext): Promise<string[]> {
  const rows = await (await request.get(`${CONTROL}/trail`)).json() as Array<{ kind: string; route: string; action: string }>;
  return rows.map(row => `${row.kind} ${row.route}#${row.action}`);
}

/**
 * 整段流程里的页面报错与控制台 error（含未处理的 promise 拒绝，例如跨文档过渡被跳过时的 AbortError）。
 * 返回一个数组，流程走完断言它是空的；每条带上当时的路由模板，方便定位。
 */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  const where = (): string => new URL(page.url()).pathname.replace(/pkt_[0-9a-f]+/, ':pid').replace(/itm_[0-9a-f]+/, ':itemId');
  page.on('pageerror', error => errors.push(`pageerror @${where()} ${String(error).slice(0, 160)}`));
  page.on('console', message => { if (message.type() === 'error') errors.push(`console @${where()} ${message.text().slice(0, 160)}`); });
  return errors;
}

async function stubPrint(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.print = () => { window.dispatchEvent(new Event('afterprint')); };
  });
}

test('三栏入口可以录入、选题并继续现有打印流程', async ({browser}) => {
  const page = await pairedPage(browser);
  await expect(page.getByRole('heading',{name:'错题本',exact:true})).toBeVisible();
  await upload(page,'#efb7b2');
  await page.goto(`${WEB}/s/photos`);
  await expect(page.locator('body')).not.toHaveAttribute('data-poll',/.*/, {timeout:30000});
  await page.goto(`${WEB}/s/choose`);await primary(page).click();
  await page.waitForURL(/\/s\/why\/pkt_/);
  const packetId = page.url().split('/').pop()!;
  await page.request.post(`${WEB}/s/skip`,{headers:{origin:WEB},form:{step:'why',practice:packetId}});
  await page.goto(`${WEB}/s/print/${packetId}`);
  await expect(page.getByTestId('sheet')).toBeVisible({timeout:30000});
  await page.context().storageState({path:STATE});
  await page.context().close();
});

const DEVICE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IPHONE_SAFARI, locale: 'zh-CN', permissions: ['microphone'],
};

async function fault(query: string): Promise<void> {
  const response = await fetch(`${CONTROL}/fault?${query}`, { method: 'POST' });
  if (!response.ok) throw new Error(`fault ${query}: ${response.status} ${await response.text()}`);
}

async function allTrail(): Promise<string[]> {
  const rows = await (await fetch(`${CONTROL}/trail`)).json() as Array<{ kind: string; route: string; action: string }>;
  return rows.map(row => `${row.kind} ${row.route}#${row.action}`);
}
const count = (lines: string[], line: string): number => lines.filter(entry => entry === line).length;

/** 新开一台「手机」并连上（点配对链接 → 连接这台手机）；同意过上传说明。 */
async function pairedPage(browser: Browser, options: BrowserContextOptions = {}): Promise<Page> {
  const context = await browser.newContext({ ...DEVICE, ...options });
  const page = await context.newPage();
  const { link } = await (await fetch(`${CONTROL}/pairing-link`)).json() as { link: string };
  await page.goto(link.replace('https://study.pccoding666.com', WEB));
  await primary(page).click();
  await page.waitForURL(/\/s\/\?paired=1$/);
  const consent = await page.request.post(`${WEB}/s/consent`, { headers: { origin: WEB }, maxRedirects: 0 });
  expect(consent.status()).toBe(303);
  return page;
}

/** 拍一张（开着脚本：选好就上传）。返回这一周现在一共几张。 */
async function upload(page: Page, color: string): Promise<number> {
  await page.goto(`${WEB}/s/capture`);
  const before = await page.getByTestId('photo-tile').count();
  await page.locator('#camera-input').setInputFiles({ name: 'page.jpg', mimeType: 'image/jpeg', buffer: await synthetic(color, 900 + before) });
  await expect(page.getByTestId('photo-tile')).toHaveCount(before + 1, { timeout: 20_000 });
  return before + 1;
}

test('拍照页识别结束后自动移除正在找题提示', async ({ browser }) => {
  const page = await pairedPage(browser);
  await fault('vision=hold');
  try {
    const number = await upload(page, '#f0c1b8');
    const status = page.locator('[data-live="capture-status"]');
    await expect(status).toHaveText('照片已收到，正在找题。');
    await fault('vision=release');
    await expect(status).toBeEmpty({ timeout: 15000 });
    await expect(page.getByTestId('photo-tile').nth(number - 1)).toContainText('找好了');
  } finally {
    await fault('vision=release');
    await page.context().close();
  }
});

test('等 AI 时局部轮询：只换状态区域（不整页刷新、标题和页面上的东西都还是原来那个），状态变了只记一次 update', async ({ browser }) => {
  const page = await pairedPage(browser);
  await fault('vision=hold');
  const number = await upload(page, '#f2cfc6');
  const row = page.getByTestId(`photo-row-${number}`);
  const navigations: string[] = [];
  let polls = 0;
  page.on('request', request => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations.push(request.url());
    if (request.headers()['x-sel-poll'] === '1') polls += 1;
  });
  await page.goto(`${WEB}/s/photos`);
  await expect(row).toContainText('照片已收到，正在找题。');
  await expect(page.locator('body')).toHaveAttribute('data-poll', '3');
  await expect(page.getByTestId('wait-line')).toContainText(/已经等了 \d+ 秒 · 找好了这一页会自己更新/);
  // Start after navigation has settled. Chromium/SW can issue more than one
  // initial navigation request; the invariant here is no new page-view writes
  // during polling, not how many requests opened the page in the first place.
  const before = await allTrail();
  expect(before).toContain('view /s/photos#open');
  // 打上记号：整页刷新的话，这些记号都会没了。
  await page.evaluate(() => { (window as unknown as { __mark: number }).__mark = 1; (document.querySelector('h1') as unknown as { __mark: number }).__mark = 1; });
  const loadedAt = navigations.length;
  // 等两轮轮询：状态没变，什么都不换。
  await expect.poll(() => polls, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  const waited = await page.getByTestId('wait-line').innerText();
  await fault('vision=release');
  await expect(row).toContainText('已新增 3 道错题', { timeout: 30_000 });
  await expect(page.locator('body')).not.toHaveAttribute('data-poll', /.*/, { timeout: 15_000 });
  expect(await page.evaluate(() => [(window as unknown as { __mark?: number }).__mark, (document.querySelector('h1') as unknown as { __mark?: number }).__mark])).toEqual([1, 1]);
  expect(navigations.length - loadedAt).toBe(0);
  expect(waited).toMatch(/已经等了 \d+ 秒/);
  await expect(page.getByTestId('wait-line')).toHaveCount(0);
  await expect(page.locator('[data-announcer]')).not.toBeEmpty();
  // 互动记录：加载完成后轮询不再记看页；换了几次就记几条 update，比轮询次数少；没有整页刷新。
  await expect.poll(async () => count(await allTrail(), 'view /s/photos#update') - count(before, 'view /s/photos#update')).toBeGreaterThanOrEqual(1);
  const after = await allTrail();
  const updates = count(after, 'view /s/photos#update') - count(before, 'view /s/photos#update');
  expect(count(after, 'view /s/photos#open')).toBe(count(before, 'view /s/photos#open'));
  expect(updates).toBeLessThan(polls);
  expect(count(after, 'view /s/photos#refresh')).toBe(count(before, 'view /s/photos#refresh'));
  await page.context().close();
});

test('轮询遇到 503 和挂起仍能恢复；待重试的照片和当前页面不丢', async ({ browser }) => {
  test.setTimeout(90_000);
  const page = await pairedPage(browser);
  await fault('vision=hold');
  try {
    await upload(page, '#d8e3c9');
    let failedUpload = false;
    await page.route('**/s/capture', async route => {
      if (route.request().method() === 'POST' && !failedUpload) { failedUpload = true; await route.abort('connectionfailed'); }
      else await route.continue();
    });
    await page.locator('#library-input').setInputFiles({ name: 'retry.jpg', mimeType: 'image/jpeg', buffer: await synthetic('#b0d3e0', 800) });
    await expect(page.locator('[data-upload-retry]')).toBeVisible();
    await page.evaluate(() => { (window as unknown as { marker: string }).marker = 'keep-upload'; });
    let polls = 0;
    await page.route('**/s/capture', async route => {
      if (route.request().headers()['x-sel-poll'] !== '1') { await route.fallback(); return; }
      polls += 1;
      if (polls === 1) await route.fulfill({ status: 503, body: 'temporary' });
      else if (polls === 2) { /* no headers/body: client must time out */ }
      else await route.continue();
    });
    await expect.poll(() => polls, { timeout: 55_000 }).toBeGreaterThanOrEqual(3);
    expect(await page.evaluate(() => (window as unknown as { marker: string }).marker)).toBe('keep-upload');
    await expect(page.locator('[data-upload-retry]')).toBeVisible();
    const before = await page.getByTestId('photo-tile').count();
    await page.locator('[data-upload-retry]').click();
    await expect(page.getByTestId('photo-tile')).toHaveCount(before + 1);
  } finally { await fault('vision=release'); await page.context().close(); }
});

test.describe('关掉脚本（等 AI 的页面）', () => {
  test('等 AI 的页面退回 <meta refresh>：自己整页刷新，找好了就不再刷新', async ({ browser }) => {
    const page = await pairedPage(browser, { javaScriptEnabled: false });
    await fault('vision=hold');
    await page.goto(`${WEB}/s/capture`);
    const before = await page.getByTestId('photo-tile').count();
    await page.locator('#camera-input').setInputFiles({ name: 'page.jpg', mimeType: 'image/jpeg', buffer: await synthetic('#f0c8c0', 760 + before) });
    await page.getByRole('button', { name: '上传这张' }).click();
    await expect(page.getByTestId('photo-tile')).toHaveCount(before + 1);
    const row = page.getByTestId(`photo-row-${before + 1}`);
    let loads = 0;
    page.on('load', () => { loads += 1; });
    await page.goto(`${WEB}/s/photos`);
    await expect(page.locator('meta[http-equiv=refresh]')).toHaveAttribute('content', '3');
    await expect(row).toContainText('照片已收到，正在找题。');
    await expect.poll(() => loads, { timeout: 12_000 }).toBeGreaterThanOrEqual(2);
    await fault('vision=release');
    await expect(row).toContainText('已新增 3 道错题', { timeout: 30_000 });
    await expect(page.locator('meta[http-equiv=refresh]')).toHaveCount(0);
    await page.context().close();
  });
});

test('减少动态效果：样式里的动效、过渡全关，页间保持原生跳转；不减少时保留状态动效', async ({ browser }) => {
  const probe = async (reducedMotion: 'reduce' | 'no-preference') => {
    const page = await pairedPage(browser, { reducedMotion });
    await page.addInitScript(() => {
      addEventListener('pagereveal', event => { (window as unknown as { __vt: boolean }).__vt = Boolean((event as Event & { viewTransition?: unknown }).viewTransition); });
    });
    await page.goto(`${WEB}/s/`);
    const styles = await page.evaluate(() => {
      const main = document.querySelector('main')!;
      const make = (html: string): HTMLElement => { const box = document.createElement('div'); box.innerHTML = html; main.appendChild(box); return box.firstElementChild as HTMLElement; };
      const rise = make('<p class="m-rise">x</p>');
      const pop = make('<span class="m-pop tick">✓</span>');
      const bar = make('<div class="progress"><i></i></div>').querySelector('i')!;
      const meter = make('<span class="meter"><i></i></span>');
      const read = (el: Element) => { const cs = getComputedStyle(el); return { animation: cs.animationName, duration: cs.animationDuration, transition: cs.transitionDuration, display: cs.display }; };
      return { rise: read(rise), pop: read(pop), progress: read(bar), meter: read(meter) };
    });
    // 跨文档过渡：点「这周的错题」跳到下一页，看新的一页是不是带着过渡出来的。
    await Promise.all([page.waitForURL(/\/s\/items$/), page.getByTestId('tab-items').click()]);
    await page.waitForLoadState('load');
    // pagereveal 在新的一页第一次画出来之前发生（有过渡时会晚于 load 一点），等它到。
    await expect.poll(() => page.evaluate(() => (window as unknown as { __vt?: boolean }).__vt ?? null), { timeout: 5_000 }).not.toBeNull();
    const viewTransition = await page.evaluate(() => (window as unknown as { __vt?: boolean }).__vt ?? null);
    await page.context().close();
    return { ...styles, viewTransition };
  };
  const reduced = await probe('reduce');
  expect(reduced.rise.animation).toBe('none');
  expect(reduced.pop.animation).toBe('none');
  expect(reduced.progress.transition).toBe('0s');
  expect(reduced.meter.display).toBe('none');
  expect(reduced.viewTransition).toBe(false);
  const normal = await probe('no-preference');
  expect(normal.rise).toMatchObject({ animation: 'rise', duration: '0.3s' });
  expect(normal.pop).toMatchObject({ animation: 'pop', duration: '0.3s' });
  expect(normal.progress.transition).toBe('0.3s');
  expect(normal.meter.display).not.toBe('none');
  expect(normal.viewTransition).toBe(false);
});

test.describe('说说为什么错：录音时的反馈，选项断行', () => {
  test('开着麦克风：音量条在动、计时在走、按钮是「说完了」、底部主按钮先不能点；转写失败录音还在，「再转一次」用同一段；360/375/390 px 选项没有单字孤行', async ({ browser }) => {
    const page = await pairedPage(browser);
    // 模拟麦克风：一个 440 Hz 的正弦波（有音量），换掉浏览器的 getUserMedia。
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        const ac = new AudioContext();
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        gain.gain.value = 0.6;
        osc.frequency.value = 440;
        osc.connect(gain);
        const destination = ac.createMediaStreamDestination();
        gain.connect(destination);
        osc.start();
        return destination.stream;
      };
    });
    await upload(page, '#efc4bc');
    await page.goto(`${WEB}/s/photos`);
    await expect(page.locator('body')).not.toHaveAttribute('data-poll', /.*/, { timeout: 30_000 });
    await page.goto(`${WEB}/s/choose`);
    await expect(primary(page)).toHaveText(/^就练这 \d 道$/);
    await primary(page).click();
    await page.waitForURL(/\/s\/why\/pkt_[0-9a-f]+$/);
    await primary(page).click();
    await page.waitForURL(/\/s\/why\/pkt_[0-9a-f]+\/itm_[0-9a-f]+$/);
    await expect(page.getByTestId('voice')).toBeVisible();

    await page.getByTestId('voice-button').click();
    await expect(page.getByTestId('voice-button')).toHaveText('说完了');
    await expect(page.getByTestId('voice-meter')).toBeVisible();
    await expect(primary(page)).toHaveText('正在听你说…');
    await expect(primary(page)).toBeDisabled();
    await expect.poll(async () => Number(await page.getByTestId('voice-meter').getAttribute('data-level')), { timeout: 5_000 }).toBeGreaterThan(0);
    await expect(page.getByTestId('voice-timer')).toHaveText(/^0:0[1-9]$/, { timeout: 5_000 });
    await page.getByTestId('voice-button').click();
    await expect(page.locator('#answer-text')).toHaveValue('我以为移项不用变号，就直接抄过去了。', { timeout: 15_000 });
    await expect(page.getByTestId('voice-note')).toHaveText('转好了，看一眼，不对就改');
    await expect(page.getByTestId('voice-live')).toBeHidden();
    await expect(primary(page)).toHaveText('说完了');
    await expect(primary(page)).toBeEnabled();

    // 转写失败：刚才那段录音留在页面里，「再转一次」用同一段，不用重新说。
    await fault('asr=fail');
    await page.getByTestId('voice-button').click();
    await expect(page.getByTestId('voice-button')).toHaveText('说完了');
    await page.waitForTimeout(1_200);
    await page.getByTestId('voice-button').click();
    await expect(page.getByTestId('voice-retry')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('voice-note')).toHaveText('这次没转成文字。刚才的录音还在：点「再转一次」，或者直接打字。');
    await expect(primary(page)).toBeEnabled();
    await fault('asr=ok');
    let posts = 0;
    page.on('request', request => { if (request.url().endsWith('/s/voice') && request.method() === 'POST') posts += 1; });
    await page.getByTestId('voice-retry').click();
    await expect(page.locator('#answer-text')).toHaveValue('我以为移项不用变号，就直接抄过去了。 我以为移项不用变号，就直接抄过去了。', { timeout: 15_000 });
    expect(posts).toBe(1);
    await expect(page.getByTestId('voice-retry')).toBeHidden();
    // 互动记录：转写失败（client:voice_502）和「再转一次」的点按都记下了，只有路由模板和固定的键。
    await expect.poll(async () => (await allTrail()).includes('tap /s/why/:pid/:itemId#content.voice-retry')).toBe(true);
    expect(await allTrail()).toContain('error /s/why/:pid/:itemId#client:voice_502');

    // 确认屏的选项（两列）：360 / 375 / 390 px 都没有单字孤行（「推理中间断 / 了」这类）。
    await page.getByTestId('next-step-secondary-skipQuestion').click();
    await page.waitForURL(/\/confirm$/);
    for (const width of [360, 375, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.reload();
      const orphans = await page.evaluate(() => {
        const found: string[] = [];
        for (const el of document.querySelectorAll('.choice > span, legend, .field-label, .btn, .caption')) {
          if ((el as HTMLElement).offsetWidth < 2 || el.closest('.hidden')) continue;
          const lines: Array<{ mid: number; text: string }> = [];
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const node = walker.currentNode as Text;
            for (let i = 0; i < node.data.length; i += 1) {
              if (/\s/.test(node.data[i]!)) continue;
              const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 1);
              const rect = range.getClientRects()[0]; if (!rect || rect.width === 0) continue;
              const mid = rect.top + rect.height / 2;
              const line = lines.find(entry => Math.abs(entry.mid - mid) < 6);
              if (line) line.text += node.data[i]; else lines.push({ mid, text: node.data[i]! });
            }
          }
          if (lines.length > 1 && lines.some(line => [...line.text].length === 1)) found.push(lines.map(line => line.text).join(' / '));
        }
        return found;
      });
      expect(orphans, `${width} px`).toEqual([]);
    }
    await page.context().close();
  });
});

/** 页面上的短句按字分行：单字孤行（多行时某一行只有一个字）、标点落在行首（，。、；：！？）」等）或行尾（（「等）。 */
async function lineReport(page: Page): Promise<{ orphans: string[]; punctuation: string[] }> {
  return page.evaluate(() => {
    const orphans: string[] = []; const punctuation: string[] = [];
    const sel = '.btn, .choice > span, h1, h2, legend, .step-title, .step-detail, .caption, .caption-flow, summary, .more, .more-inline, .link-btn, .field-label, .card-title, .rhythm li, .flash, .chip, .tag, .wait-line, .meta-line';
    for (const el of document.querySelectorAll(sel)) {
      const box = el.getBoundingClientRect(); const cs = getComputedStyle(el);
      if (box.width < 2 || cs.display === 'none' || cs.visibility === 'hidden' || el.closest('.hidden') || el.closest('.sheet') || el.closest('.visually-hidden')) continue;
      const lines: Array<{ mid: number; text: string }> = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        for (let i = 0; i < node.data.length; i += 1) {
          if (/\s/.test(node.data[i]!)) continue;
          const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 1);
          const rect = range.getClientRects()[0]; if (!rect || rect.width === 0) continue;
          const mid = rect.top + rect.height / 2;
          const line = lines.find(entry => Math.abs(entry.mid - mid) < 6);
          if (line) line.text += node.data[i]; else lines.push({ mid, text: node.data[i]! });
        }
      }
      lines.sort((a, b) => a.mid - b.mid);
      const shown = lines.map(line => line.text).join(' / ');
      if (lines.length > 1 && lines.some(line => [...line.text].length === 1)) orphans.push(shown);
      lines.forEach((line, i) => {
        if (i > 0 && /^[，。、；：！？）」』】]/.test(line.text)) punctuation.push(`行首 ${shown}`);
        if (i < lines.length - 1 && /[（「『【]$/.test(line.text)) punctuation.push(`行尾 ${shown}`);
      });
    }
    return { orphans, punctuation };
  });
}

test('页面缩放 200%（195×422 CSS px）：没有单字孤行或标点落行首，固定导航不超过半屏，当前操作完整可见', async ({ browser }) => {
  const page = await pairedPage(browser, { viewport: { width: 195, height: 422 }, deviceScaleFactor: 6 });
  await page.goto(`${WEB}/s/practices`);
  const hrefs = await page.getByTestId('practice-row').evaluateAll(rows => rows.map(row => row.getAttribute('href') ?? ''));
  const printed = hrefs.map(href => /\/s\/(?:record|results|practice)\/(pkt_[0-9a-f]+)/.exec(href)?.[1]).find(Boolean);
  expect(printed).toBeTruthy();
  for (const path of ['/s/', '/s/settings', '/s/choose', `/s/print/${printed}`, `/s/print/${printed}/sheet`, '/s/practices']) {
    await page.goto(`${WEB}${path}`);
    const inlinePrimary = page.locator('.next-bar-inline [data-testid=next-step-primary]');
    if (await inlinePrimary.count()) await inlinePrimary.scrollIntoViewIfNeeded();
    const report = await lineReport(page);
    expect(report.orphans, `${path} 单字孤行`).toEqual([]);
    expect(report.punctuation, `${path} 标点落在行首 / 行尾`).toEqual([]);
    const layout = await page.evaluate(() => {
      const bar = document.querySelector('.tab-bar, .next-bar:not(.next-bar-inline)')?.getBoundingClientRect();
      const primary = document.querySelector('[data-testid=next-step-primary]');
      const p = primary ? primary.getBoundingClientRect() : null;
      return { barShare: bar ? bar.height / innerHeight : null, overflow: document.documentElement.scrollWidth - innerWidth, primaryVisible: p ? p.top >= 0 && p.bottom <= innerHeight + 1 : null };
    });
    if (path === '/s/settings') {
      expect(layout.barShare, '设置页不再有固定操作栏').toBeNull();
    } else {
      expect(layout.barShare, `${path} 保留导航`).not.toBeNull();
      expect(layout.barShare, `${path} 底栏占视口`).toBeLessThanOrEqual(0.5);
    }
    expect(layout.overflow, `${path} 横向溢出`).toBeLessThanOrEqual(0);
    expect(layout.primaryVisible, `${path} 主按钮`).not.toBe(false);
  }
  // 打印回来以后（底栏最高的时候）：说明挪到内容最后，底栏只留「再打印」和主按钮。
  await page.goto(`${WEB}/s/print/${printed}`);
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await expect(page.getByTestId('next-step-primary')).toHaveText('打印好了，回到今天');
  await expect(page.getByTestId('next-step-caption')).toBeHidden();
  await expect(page.locator('[data-caption-flow]')).toContainText('打印机没反应');
  const share = await page.evaluate(() => document.querySelector('.next-bar')!.getBoundingClientRect().height / innerHeight);
  expect(share).toBeLessThanOrEqual(0.5);
  expect((await lineReport(page)).orphans).toEqual([]);
  await page.context().close();
});

test('服务器忙：还没连上的人看到「等一会儿再试；还是不行，请大人给一个新的二维码或链接」，连接过期的人不被说成「还没连上」', async ({ browser }) => {
  // 还没连上：连接失败太多次（每个 IP 每分钟 10 次）。
  const stranger = await browser.newContext(DEVICE);
  const page = await stranger.newPage();
  let busy = false;
  for (let attempt = 0; attempt < 14 && !busy; attempt += 1) {
    await page.goto(`${WEB}/s/`);
    await page.locator('#connect-link').fill('https://example.invalid/s/pair?code=nope');
    await Promise.all([page.waitForLoadState('load'), primary(page).click()]);
    busy = (await page.locator('h1').innerText()) === '服务器有点忙';
  }
  expect(busy).toBe(true);
  await expect(page.getByTestId('busy-note')).toHaveText('还没连上服务器。等一会儿再试；还是不行，请大人给一个新的二维码或链接。');
  await expect(primary(page)).toHaveText('过一会儿再试');
  await stranger.close();

  // 连接过期：cookie 还在但已经无效（鉴权失败太多次，每个 IP 每分钟 30 次）。
  const expired = await browser.newContext(DEVICE);
  const expiredPage = await expired.newPage();
  let status = 0;
  for (let attempt = 0; attempt < 40 && status !== 429; attempt += 1) {
    await expired.addCookies([{ name: 'sel_device', value: 'expired-or-revoked-token', url: `${WEB}/s/` }]);
    status = (await expiredPage.goto(`${WEB}/s/`))!.status();
  }
  expect(status).toBe(429);
  await expect(expiredPage.getByTestId('busy-note')).toHaveText('连接过期了，要请大人给一个新的二维码或链接。照片和错题都还在服务器上。');
  await expect(expiredPage.locator('main')).not.toContainText('还没连上');
  await expired.close();
});
