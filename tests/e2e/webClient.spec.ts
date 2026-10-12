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

async function stubPrint(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.print = () => { window.dispatchEvent(new Event('afterprint')); };
  });
}

test('周末 A：只按底部下一步按钮，从配对走到「这周的事做完了」（J7 网页版）', async ({ page, request }) => {
  const { link } = await (await request.get(`${CONTROL}/pairing-link`)).json() as { link: string };
  await stubPrint(page);

  // 连接：打开配对链接 → 确认页 → 点一下连接。
  await page.goto(link.replace('https://study.pccoding666.com', WEB));
  await next(page, '连接这台手机');
  await expect(page.getByTestId('flash-ok')).toHaveText('连上了 ✓');
  await expect(page.getByTestId('install-hint')).toBeVisible();

  // 第 1 步：拍第一页（第一次上传前先看说明）。
  await expect(page.getByTestId('today-header')).toHaveText('今天大约 13 分钟，一共 5 步');
  await expect(page.getByTestId('next-step-caption')).toHaveText('第 1 步，共 5 步 · 大约 2 分钟');
  await expect(secondary(page, 'skipShoot')).toHaveText('这周没发卷子，跳过');
  await next(page, '拍第一页');
  await expect(page.getByTestId('consent')).toContainText('照片上可能有你的名字和字迹');
  await next(page, '同意，上传');
  await expect(page.locator('#camera-input')).toHaveAttribute('capture', 'environment');
  await expect(page.locator('#camera-input')).toHaveAttribute('accept', 'image/*');
  await shoot(page, await synthetic('#f2cfc6', 900), 'page-1.jpg');
  await expect(page.getByTestId('photo-count')).toHaveText('已拍 1 张', { timeout: 20_000 });

  // 第 2 步：AI 找题（等待时主按钮不可点）→ 找完了下一步自己变成第 3 步。
  await next(page, '拍完了，下一步');
  await expect(page).toHaveURL(/\/s\/photos$/);
  await waitForPrimary(page, '下一步：选这周要练的题');
  await expect(page.getByTestId('photo-row-1')).toContainText('找到 3 道有红叉的题');
  await primary(page).click();

  // 第 3 步：选题（推荐默认全选）。
  await expect(page.getByTestId('next-step-caption')).toHaveText('第 3 步，共 5 步 · 大约 1 分钟');
  await expect(page.getByTestId('choose-row')).toHaveCount(3);
  await next(page, '就练这 3 道');

  // 第 4 步：说说为什么错 → 点下一步按钮旁边的「跳过，直接打印」。
  await expect(page.getByTestId('next-step-caption')).toHaveText('第 1 道，共 3 道');
  await expect(secondary(page, 'skipWhy')).toHaveText('跳过，直接打印');
  await secondary(page, 'skipWhy').click();

  // 第 5 步：准备好后出现 A4 预览，下一步按钮是「打印」；打印后变成「打印好了，回到今天」。
  await expect(page).toHaveURL(/\/s\/print\/pkt_/);
  await waitForPrimary(page, '打印');
  await expect(page.getByTestId('print-preview')).toBeVisible();
  await expect(page.getByTestId('sheet')).toContainText('做完再看');
  const sheetUrl = await page.getByTestId('sheet-link').getAttribute('href');
  await primary(page).click();
  await next(page, '打印好了，回到今天');

  // 回到今天：这周的事做完了；没有主按钮，只留「没打出来？现在打印」。
  await expect(page.getByTestId('today-done-title')).toContainText('这周的事做完了');
  await expect(page.getByTestId('today-done')).toContainText('下个周末打开错题本，录一下做的结果。');
  await expect(page.getByTestId('next-step-caption')).toHaveText('下次打开：下个周末，录结果');
  await expect(secondary(page, 'print')).toHaveText('没打出来？现在打印');
  await expect(primary(page)).toHaveCount(0);

  // 练习纸用浏览器打印成 A4 PDF：封面、题目页、答案页。
  await page.goto(`${WEB}${sheetUrl}`);
  await page.emulateMedia({ media: 'print' });
  const pdf = await PDFDocument.load(await page.pdf({ format: 'A4', printBackground: true }));
  expect(pdf.getPageCount()).toBeGreaterThanOrEqual(3);
  const { width, height } = pdf.getPage(0).getSize();
  expect(Math.abs(width - 595.3)).toBeLessThan(2);   // A4 = 210 × 297 mm
  expect(Math.abs(height - 841.9)).toBeLessThan(2);
  await page.emulateMedia({ media: 'screen' });

  // 没联网 / 服务器连不上：Service Worker 只缓存了外壳，导航失败时给离线页（不含任何学生数据）。
  await page.goto(`${WEB}/s/`);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  await page.context().setOffline(true);
  await page.goto(`${WEB}/s/items`);
  // Playwright 的断网模拟不改 navigator.onLine，所以这里是「连不上服务器」那一版（真断网时脚本换成「没联网」）。
  await expect(page.getByTestId('offline-title')).toHaveText(/没联网|连不上服务器/);
  await expect(page.locator('html')).toHaveClass(/\bjs\b/);
  await expect(primary(page)).toHaveText('再试一次');
  const cached = await page.evaluate(async () => {
    const keys = await caches.keys();
    const urls = (await Promise.all(keys.map(async key => (await (await caches.open(key)).keys()).map(r => new URL(r.url).pathname)))).flat();
    return urls.sort();
  });
  // 外壳只有离线页、带内容指纹的样式与脚本（和页面引用的是同一个名字）、图标。
  const shell = await page.evaluate(() => [document.querySelector('link[rel=stylesheet]')?.getAttribute('href') ?? '', document.querySelector('script[src]')?.getAttribute('src') ?? '']);
  expect(shell[0]).toMatch(/^\/s\/assets\/app\.[0-9a-f]{10}\.css$/);
  expect(shell[1]).toMatch(/^\/s\/assets\/app\.[0-9a-f]{10}\.js$/);
  expect(cached).toEqual([shell[0], shell[1], '/s/assets/icon-192.png', '/s/offline'].sort());
  await page.context().setOffline(false);

  // 互动记录：页面脚本记下的点按（跳页的随下一个请求带来，拍照 / 打印这类不跳页的立刻发 HEAD）和服务器上判定的看页、提交、跳过。
  await expect.poll(async () => (await trailLines(request)).filter(line => line.startsWith('tap ')).length).toBeGreaterThan(5);
  const lines = await trailLines(request);
  expect(lines).toEqual(expect.arrayContaining([
    'tap /s/pair#primary.pair',
    'tap /s/#primary.capture',
    'tap /s/capture#primary.consent',
    'tap /s/capture#primary.capture',
    'tap /s/why/:pid#secondary.skipWhy',
    'tap /s/print/:pid#primary.print',
    'view /s/#open',
    'view /s/photos#open',
    'submit /s/consent#submit',
    'submit /s/choose#submit',
    'skip /s/skip#why',
  ]));
  expect(lines.join('\n')).not.toMatch(/pkt_|itm_[0-9a-f]|code=/);

  await page.context().storageState({ path: STATE });
});

test.describe('下个周末', () => {
  test.use({ storageState: STATE });

  test('周末 B：先拍新卷子，趁 AI 找题录上周的结果，再勾、选、用语音说一道、打印', async ({ page, request }) => {
    expect((await request.post(`${CONTROL}/time-travel?days=7`)).ok()).toBe(true);
    await stubPrint(page);
    await page.goto(`${WEB}/s/`);

    await expect(page.getByTestId('today-header')).toHaveText('今天大约 16 分钟，一共 6 步');
    await expect(page.getByTestId('today-step-record')).toContainText('录练习纸的结果');
    await expect(page.getByTestId('next-step-caption')).toHaveText('第 1 步，共 6 步 · 大约 2 分钟');

    // 拍一张没批改的答题卡页（同意过，不再问）。
    await next(page, '拍第一页');
    await expect(page).toHaveURL(/\/s\/capture$/);
    await shoot(page, await synthetic('#c6cff2', 820), 'page-2.jpg');
    await expect(page.getByTestId('photo-count')).toHaveText('已拍 1 张', { timeout: 20_000 });

    // 「拍完了，下一步」去录上周练习纸的结果（第 2 步）。
    await next(page, '拍完了，下一步');
    await expect(page).toHaveURL(/\/s\/record\/pkt_/);
    await expect(page.getByTestId('record-day')).toHaveCount(7);
    await expect(page.locator('input[name=date]:checked')).toHaveCount(0);
    await page.getByTestId('record-day').nth(3).click();
    await next(page, '下一步');
    await expect(page.getByTestId('next-step-caption')).toHaveText('第 1 道，共 3 道');
    await page.getByTestId('completion-independent').click();
    await page.getByTestId('correct-yes').click();
    await next(page, '下一道');
    await page.getByTestId('completion-hint1').click();
    await page.getByTestId('correct-yes').click();
    await next(page, '下一道');
    await expect(page.getByTestId('correct-yes')).toBeHidden();
    await page.getByTestId('completion-not_solved').click();
    await next(page, '提交 3 道结果');

    // 这次的结果：隔了几天独立做对 = 真会了；看提示、没做出来 = 下次再练。
    await expect(page.getByTestId('results-head')).toHaveText('3 道里，独立做对 1 道');
    await expect(page.locator('main')).toContainText('真会了 ✓（1 道）');
    await expect(page.locator('main')).toContainText('下次再练（2 道）');
    await waitForPrimary(page, '下一步：勾出做错的题');
    await primary(page).click();

    // 勾出没批改的页上的 2 道。
    await expect(page.getByTestId('pick-candidate')).toHaveCount(3);
    await page.getByTestId('pick-candidate').nth(0).click();
    await page.getByTestId('pick-candidate').nth(2).click();
    await next(page, '把这 2 道加入错题本');
    await expect(page).toHaveURL(/\/s\/photos\?added=2&n=1$/);
    await expect(page.getByTestId('photos-added')).toHaveText('第 1 张：2 道加进错题本了 ✓');
    await waitForPrimary(page, '下一步：选这周要练的题');
    await primary(page).click();

    // 选题：新勾的 2 道 + 上周没练会的。
    const rows = await page.getByTestId('choose-row').count();
    expect(rows).toBeGreaterThanOrEqual(2);
    await next(page, /^就练这 \d 道$/);

    // 说说为什么错：第一道用语音（假麦克风 → mock 转写放进文本框，他改完自己点「说完了」）。
    await next(page, '开始');
    await expect(page.getByTestId('ai-question')).toBeVisible();
    await expect(page.getByTestId('voice')).toBeVisible();
    await page.getByTestId('voice-button').click();
    // 开着麦克风：按钮变成「说完了」，有计时；底部主按钮先不能点（先说完再提交）。
    await expect(page.getByTestId('voice-button')).toHaveText('说完了');
    await expect(page.getByTestId('voice-timer')).toBeVisible();
    await expect(primary(page)).toBeDisabled();
    await page.waitForTimeout(1200);
    await page.getByTestId('voice-button').click();
    await expect(page.locator('#answer-text')).toHaveValue('我以为移项不用变号，就直接抄过去了。', { timeout: 15_000 });
    await expect(page.getByTestId('voice-note')).toHaveText('转好了，看一眼，不对就改');
    await next(page, '说完了');
    // mock 会再问一句：不回答，直接选。
    await secondary(page, 'skipQuestion').click();
    await expect(page.getByTestId('missing')).toHaveText('还差：有没有把握');
    await expect(primary(page)).toBeDisabled();
    await page.getByText('现在做应该会').click();
    await expect(page.getByTestId('missing')).toHaveText('');
    await primary(page).click();
    // 其余几道：不回答，这道跳过。
    await page.waitForURL(/\/s\/why\/pkt_[0-9a-f]+(\/itm_[0-9a-f]+)?$/);
    for (let guard = 0; guard < 12 && /\/s\/why\/pkt_[0-9a-f]+\/itm_/.test(page.url()); guard += 1) {
      const before = page.url();
      const button = before.endsWith('/confirm') ? secondary(page, 'pass') : secondary(page, 'skipQuestion');
      await Promise.all([page.waitForURL(url => url.toString() !== before), button.click()]);
    }
    await expect(page.getByTestId('why-done')).toContainText('说了 1 道');
    await next(page, '下一步：打印练习纸');

    await waitForPrimary(page, '打印');
    await primary(page).click();
    await next(page, '打印好了，回到今天');
    await expect(page.getByTestId('today-done-title')).toContainText('这周的事做完了');
    await expect(primary(page)).toHaveCount(0);

    // 做完以后又拍了一张（门槛 G3）：「勾出做错的题」说明新题去了哪里，下一步是回到今天，不再带去选题。
    await page.goto(`${WEB}/s/capture`);
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('add-page').click()]);
    await chooser.setFiles({ name: 'page-3.jpg', mimeType: 'image/jpeg', buffer: await synthetic('#f0c8c0', 760) });
    await expect(page.getByTestId('photo-count')).toHaveText('已拍 2 张', { timeout: 20_000 });
    await next(page, '拍完了，下一步');
    await expect(page).toHaveURL(/\/s\/photos$/);
    await expect(page.getByTestId('photos-after-week')).toContainText('新拍的题下个周末再选');
    await expect(page.getByTestId('photo-new-2')).toHaveText('新拍的');
    await expect(page.getByTestId('photo-new-1')).toHaveCount(0);
    await expect(page.getByTestId('photos-after-week')).toContainText('下个周末选题时，它们会出现在里面');
    await expect(primary(page)).toHaveText('回到今天');
    await next(page, '回到今天');
    await expect(page.getByTestId('today-done-title')).toContainText('这周的事做完了');
    fs.rmSync(STATE, { force: true });
  });
});

test.describe('关掉脚本', () => {
  test.use({ javaScriptEnabled: false });

  test('没有脚本也能走：配对、拍照上传、录结果、选题、跳过、打开练习纸、回到今天', async ({ page, request }) => {
    expect((await request.post(`${CONTROL}/time-travel?days=7`)).ok()).toBe(true);
    const { link } = await (await request.get(`${CONTROL}/pairing-link`)).json() as { link: string };
    await page.goto(link);
    await next(page, '连接这台手机');
    await expect(page.getByTestId('today-header')).toHaveText('今天大约 16 分钟，一共 6 步');
    await next(page, '拍第一页');
    await next(page, '同意，上传');
    // 没有脚本：选好照片后点「上传这张」（表单提交）。
    await page.locator('#camera-input').setInputFiles({ name: 'page-3.jpg', mimeType: 'image/jpeg', buffer: await synthetic('#f5d2c0', 760) });
    await page.getByRole('button', { name: '上传这张' }).click();
    await expect(page.getByTestId('photo-count')).toHaveText('已拍 1 张');
    // 录上一份练习纸的结果：每道都是一屏表单，答案放在隐藏字段里带到最后一次提交。
    await next(page, '拍完了，下一步');
    await expect(page).toHaveURL(/\/s\/record\/pkt_/);
    await page.getByTestId('record-day').last().click();
    await next(page, '下一步');
    for (let guard = 0; guard < 9 && /\/s\/record\//.test(page.url()); guard += 1) {
      await page.getByTestId('completion-not_done').click();
      await primary(page).click();
    }
    await expect(page.getByTestId('results-head')).toContainText('独立做对 0 道');
    // 找题中的页面靠 <meta refresh> 自己刷新。
    await page.goto(`${WEB}/s/photos`);
    await waitForPrimary(page, '下一步：选这周要练的题', 60_000);
    await primary(page).click();
    await next(page, /^就练这 \d 道$|^把勾出的题加入错题本$|^就练这/);
    await secondary(page, 'skipWhy').click();
    // 准备中靠 <meta refresh>；就绪后「打印」是去单独练习纸页的链接（用 Safari 的分享 → 打印）。
    await waitForPrimary(page, '打印', 60_000);
    await primary(page).click();
    await expect(page).toHaveURL(/\/sheet$/);
    await expect(page.getByTestId('sheet')).toContainText('做完再看');
    await next(page, '打印好了，回到今天');
    await expect(page.getByTestId('today-done-title')).toContainText('这周的事做完了');
  });
});

// ---------- quality round 2：局部轮询、关掉脚本时的 meta refresh、减少动态效果、录音反馈、服务器忙页、选项断行 ----------
// 这些用例放在本文件最后：前面的周末 A / B 要从干净的数据开始，这里的每个用例自己配新设备、自己拍需要的卷子。
// 故障注入见 tests/e2e/webClientServer.ts（POST /fault）。服务器忙的用例放在最后（限流按 IP 记一分钟）。

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
  await page.locator('#camera-input').setInputFiles({ name: 'page.jpg', mimeType: 'image/jpeg', buffer: await synthetic(color, 900) });
  await expect(page.getByTestId('photo-tile')).toHaveCount(before + 1, { timeout: 20_000 });
  return before + 1;
}

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
  const before = await allTrail();
  await page.goto(`${WEB}/s/photos`);
  await expect(row).toContainText('AI 正在找题…');
  await expect(page.locator('body')).toHaveAttribute('data-poll', '3');
  await expect(page.getByTestId('wait-line')).toContainText(/已经等了 \d+ 秒 · 找好了这一页会自己更新/);
  // 打上记号：整页刷新的话，这些记号都会没了。
  await page.evaluate(() => { (window as unknown as { __mark: number }).__mark = 1; (document.querySelector('h1') as unknown as { __mark: number }).__mark = 1; });
  const loadedAt = navigations.length;
  // 等两轮轮询：状态没变，什么都不换。
  await expect.poll(() => polls, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  const waited = await page.getByTestId('wait-line').innerText();
  await fault('vision=release');
  await expect(row).toContainText('找到 3 道有红叉的题', { timeout: 30_000 });
  await expect(page.locator('body')).not.toHaveAttribute('data-poll', /.*/, { timeout: 15_000 });
  expect(await page.evaluate(() => [(window as unknown as { __mark?: number }).__mark, (document.querySelector('h1') as unknown as { __mark?: number }).__mark])).toEqual([1, 1]);
  expect(navigations.length - loadedAt).toBe(0);
  expect(waited).toMatch(/已经等了 \d+ 秒/);
  await expect(page.getByTestId('wait-line')).toHaveCount(0);
  await expect(page.locator('[data-announcer]')).not.toBeEmpty();
  // 互动记录：这一段里只打开过一次 /s/photos；轮询不记看页；换了几次就记几条 update，比轮询次数少；没有整页刷新。
  await expect.poll(async () => count(await allTrail(), 'view /s/photos#update') - count(before, 'view /s/photos#update')).toBeGreaterThanOrEqual(1);
  const after = await allTrail();
  const updates = count(after, 'view /s/photos#update') - count(before, 'view /s/photos#update');
  expect(count(after, 'view /s/photos#open') - count(before, 'view /s/photos#open')).toBe(1);
  expect(updates).toBeLessThan(polls);
  expect(count(after, 'view /s/photos#refresh')).toBe(count(before, 'view /s/photos#refresh'));
  await page.context().close();
});

test.describe('关掉脚本（等 AI 的页面）', () => {
  test('等 AI 的页面退回 <meta refresh>：自己整页刷新，找好了就不再刷新', async ({ browser }) => {
    const page = await pairedPage(browser, { javaScriptEnabled: false });
    await fault('vision=hold');
    await page.goto(`${WEB}/s/capture`);
    const before = await page.getByTestId('photo-tile').count();
    await page.locator('#camera-input').setInputFiles({ name: 'page.jpg', mimeType: 'image/jpeg', buffer: await synthetic('#f0c8c0', 760) });
    await page.getByRole('button', { name: '上传这张' }).click();
    await expect(page.getByTestId('photo-tile')).toHaveCount(before + 1);
    const row = page.getByTestId(`photo-row-${before + 1}`);
    let loads = 0;
    page.on('load', () => { loads += 1; });
    await page.goto(`${WEB}/s/photos`);
    await expect(page.locator('meta[http-equiv=refresh]')).toHaveAttribute('content', '3');
    await expect(row).toContainText('AI 正在找题…');
    await expect.poll(() => loads, { timeout: 12_000 }).toBeGreaterThanOrEqual(2);
    await fault('vision=release');
    await expect(row).toContainText('找到 3 道有红叉的题', { timeout: 30_000 });
    await expect(page.locator('meta[http-equiv=refresh]')).toHaveCount(0);
    await page.context().close();
  });
});

test('减少动态效果：样式里的动效、过渡全关，页与页之间也不做过渡；不减少时都在', async ({ browser }) => {
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
    await Promise.all([page.waitForURL(/\/s\/items$/), page.getByTestId('today-items').click()]);
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
  expect(normal.viewTransition).toBe(true);
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
