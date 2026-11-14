/**
 * 给公开说明页拍合成示例图。只启动本机临时服务器，照片和账号都是编的，退出即删。
 * 运行：npx tsx scripts/capture-help-guide.ts
 *
 * 错题本 / 录入 / 详情走邀请码网关 + 材料流程。空闲首页只有拍照和相册；单页 / 多页在点开之后的选择层里。
 * 注册 / 登录 / 找回等仍用同一网关。练习截图不再拍：设置里写着即将推出，学生端没有入口。
 */
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from '@playwright/test';
import sharp from 'sharp';

const OUT = path.resolve('src/portal/help-img');
/** `npx tsx scripts/capture-help-guide.ts --only account` 只重拍我的邀请码，避免盖掉其它图。 */
const onlyShot = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] ?? '' : '';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

fs.mkdirSync(OUT, { recursive: true });

/** 合成试卷：偏红 = 有批改痕迹，偏蓝 = 没有。文字是编的，不是学生作业。 */
async function jpeg(kind: 'marked' | 'plain'): Promise<Buffer> {
  const paper = kind === 'marked' ? '#f7d4cf' : '#d7e7f3';
  const mark = kind === 'marked'
    ? '<g stroke="#c8402f" stroke-width="8" stroke-linecap="round"><line x1="760" y1="250" x2="820" y2="310"/><line x1="820" y1="250" x2="760" y2="310"/></g>'
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="860" height="1160">
    <rect width="860" height="1160" fill="${paper}"/>
    <text x="48" y="90" font-size="28" font-family="sans-serif" fill="#222">数学小卷（合成示例）</text>
    <text x="48" y="180" font-size="24" font-family="sans-serif" fill="#222">1. 解方程：x + 3 = 5</text>
    <text x="48" y="280" font-size="24" font-family="sans-serif" fill="#222">2. 求 y = x² − 2x + 2 的对称轴</text>
    <text x="48" y="380" font-size="24" font-family="sans-serif" fill="#222">3. 相似三角形，求相似比</text>
    ${mark}
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toBuffer();
}

async function save(page: Page, name: string): Promise<void> {
  if (onlyShot && onlyShot !== name) return;
  const png = await page.screenshot({ type: 'png', animations: 'disabled' });
  const file = path.join(OUT, `${name}.webp`);
  await sharp(png).webp({ quality: 58, effort: 5 }).toFile(file);
  const kb = Math.round(fs.statSync(file).size / 1024);
  console.log(`${name}.webp ${kb}KB`);
}

function startHost(): { child: ChildProcess; ready: Promise<{ base: string; codes: string[] }> } {
  const child = fork(path.resolve('tests/e2e/studentHostServer.ts'), [], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, NODE_ENV: 'test', SEL_AI_MODE: 'mock', SEL_E2E_MATERIAL_CAPTURE: '1' },
    stdio: ['ignore', 'inherit', 'pipe', 'ipc'],
  });
  child.stderr?.on('data', chunk => process.stderr.write(chunk));
  const ready = new Promise<{ base: string; codes: string[] }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('host timeout')), 60_000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error('host exited')); });
    child.once('message', message => { clearTimeout(timer); resolve(message as { base: string; codes: string[] }); });
  });
  return { child, ready };
}

async function stopHost(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 8_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    if (child.connected) child.send({ stop: true }, () => {}); else child.kill('SIGTERM');
  });
}

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: IPHONE,
    locale: 'zh-CN',
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  const { child, ready } = startHost();
  try {
    const { base, codes } = await ready;

    await page.goto(`${base}/s/`);
    await page.getByTestId('login-title').waitFor();
    await save(page, 'login');

    await page.goto(`${base}/s/register`);
    await page.getByRole('heading', { name: '注册账号' }).waitFor();
    await save(page, 'register');
    await page.locator('#register-name').fill('示例学生');
    await page.locator('#register-phone').fill('13800001111');
    await page.getByTestId('register-pin-input').fill('2580');
    await page.locator('#register-form').evaluate((form: HTMLFormElement) => form.requestSubmit());
    await page.getByTestId('registered-invite-code').waitFor({ timeout: 20_000 });
    await save(page, 'register-done');

    await page.goto(`${base}/s/recover`);
    await page.getByRole('heading', { name: '找回邀请码' }).waitFor();
    await save(page, 'recover');

    await page.goto(`${base}/s/`);
    await page.getByLabel('12 位邀请码').fill(codes[0]!);
    await page.getByRole('button', { name: '进入我的错题本' }).click();
    await page.waitForURL(/login=1/);
    if (await page.getByRole('heading', { name: '你现在读初中还是高中？' }).count()) {
      await save(page, 'stage');
      await page.getByRole('button', { name: '初中', exact: true }).click();
    }

    if (onlyShot === 'account') {
      await page.goto(`${base}/s/account`);
      await page.getByRole('heading', { name: '我的邀请码' }).waitFor();
      await page.getByTestId('my-invite-qr').waitFor();
      await page.getByTestId('my-invite-link').waitFor();
      await page.getByTestId('my-invite-link-block').evaluate((node: HTMLElement) => node.scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(300);
      await save(page, 'account');
      return;
    }

    await page.getByTestId('empty-notebook').waitFor();
    await page.locator('[data-testid="capture-dock"]:visible').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="capture-dock"]')?.getAttribute('data-capture-choice') === 'choice');
    await page.waitForTimeout(400);
    await save(page, 'notebook-empty');

    await page.getByTestId('next-step-primary').click();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('capture-mode-single').locator('input').click(),
    ]);
    // 材料合成提取默认给出没有批改痕迹、需要勾选的题；再传一张同批照片只为占位。
    await chooser.setFiles([
      { name: 'plain.jpg', mimeType: 'image/jpeg', buffer: await jpeg('plain') },
      { name: 'marked.jpg', mimeType: 'image/jpeg', buffer: await jpeg('marked') },
    ]);
    await page.waitForURL(/\/s\/new$/);
    // Ionic keeps the previous page mounted. Idle 录入 has no mode bar; the choice sheet opens from the inline buttons.
    await page.locator('.capture-inline').waitFor();
    await page.waitForFunction(() => {
      const dock = document.querySelector('.capture-inline');
      return dock?.getAttribute('data-capture-choice') === 'choice' && !dock.querySelector('[data-testid="capture-mode-bar"]');
    });
    const pick = page.locator('section.intake-photo[data-state="needsPick"]').first();
    await pick.waitFor({ timeout: 60_000 });
    await page.waitForTimeout(500);
    await save(page, 'intake-auto');
    await pick.scrollIntoViewIfNeeded();
    await pick.getByTestId('pick-candidate').first().click();
    await page.waitForTimeout(300);
    await save(page, 'intake-pick');
    await pick.getByTestId('pick-submit').click();
    await page.locator('section.intake-photo[data-state="done"]').first().waitFor({ timeout: 40_000 });

    await page.getByTestId('intake-done').click();
    await page.waitForURL(/\/s\/?(\?|$)/);
    await page.getByTestId('item-card').first().waitFor({ timeout: 40_000 });
    await page.waitForTimeout(400);
    await save(page, 'notebook-list');

    await page.getByTestId('item-card').first().click();
    await page.getByTestId('question-text').waitFor();
    await page.getByTestId('item-photo').waitFor();
    await page.waitForTimeout(400);
    await save(page, 'item-detail');
    await page.getByTestId('item-answer').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await save(page, 'item-answer');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.getByTestId('item-more').click();
    await page.locator('ion-popover').getByText('不是错题，移除').waitFor();
    await save(page, 'item-menu');

    await page.goto(`${base}/s/me`);
    await page.getByText('即将推出').waitFor();
    await page.getByTestId('settings-my-invite').waitFor();
    await save(page, 'settings');
    await page.goto(`${base}/s/account`);
    await page.getByRole('heading', { name: '我的邀请码' }).waitFor();
    // 登录链接和二维码只在本机看得到邀请码、且 Host 能拼出入口时出现。没出来就不要盖掉旧图。
    await page.getByTestId('my-invite-qr').waitFor();
    await page.getByTestId('my-invite-link').waitFor();
    await page.getByTestId('my-invite-link-block').evaluate((node: HTMLElement) => node.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(300);
    await save(page, 'account');
    await page.goto(`${base}/s/install`);
    await page.getByRole('heading', { name: '放到主屏幕' }).waitFor();
    await save(page, 'install');
  } finally {
    await stopHost(child);
    await context.close();
    await browser.close();
  }

  for (const stale of ['practice-home', 'practice-question', 'practice-print', 'practice-record', 'practice-submit', 'settings-practice']) {
    const file = path.join(OUT, `${stale}.webp`);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      console.log(`removed ${stale}.webp`);
    }
  }
}

main().catch(error => { console.error(error); process.exit(1); });
