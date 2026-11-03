/**
 * 给公开说明页拍合成示例图。只启动本机临时服务器，照片和账号都是编的，退出即删。
 * 运行：npx tsx scripts/capture-help-guide.ts
 */
import { fork, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from '@playwright/test';
import sharp from 'sharp';

const OUT = path.resolve('src/portal/help-img');
const WEB_PORT = 3320;
const CONTROL_PORT = 3321;
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
  const png = await page.screenshot({ type: 'png', animations: 'disabled' });
  const file = path.join(OUT, `${name}.webp`);
  await sharp(png).webp({ quality: 58, effort: 5 }).toFile(file);
  const kb = Math.round(fs.statSync(file).size / 1024);
  console.log(`${name}.webp ${kb}KB`);
}

function waitForHttp(url: string, child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${url}`)), 90_000);
    const poll = async (): Promise<void> => {
      if (child.exitCode !== null) { clearTimeout(timer); reject(new Error(`server exited ${child.exitCode}`)); return; }
      try {
        const response = await fetch(url);
        if (response.ok || response.status === 404) { clearTimeout(timer); resolve(); return; }
      } catch { /* still booting */ }
      setTimeout(() => { void poll(); }, 400);
    };
    void poll();
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

  const web = spawn('npx', ['tsx', 'tests/e2e/webClientServer.ts'], {
    env: { ...process.env, SEL_WEB_E2E_PORT: String(WEB_PORT), SEL_WEB_E2E_CONTROL_PORT: String(CONTROL_PORT), SEL_AI_MODE: 'mock', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  web.stdout?.on('data', chunk => process.stdout.write(chunk));
  web.stderr?.on('data', chunk => process.stderr.write(chunk));
  try {
    await waitForHttp(`http://127.0.0.1:${CONTROL_PORT}/pairing-link`, web);
    const { link } = await (await fetch(`http://127.0.0.1:${CONTROL_PORT}/pairing-link`)).json() as { link: string };
    await page.goto(link.replace('https://study.pccoding666.com', `http://127.0.0.1:${WEB_PORT}`));
    await page.getByTestId('next-step-primary').click();
    await page.waitForURL(/\/s\/\?paired=1$/);
    await page.getByTestId('empty-notebook').waitFor();
    await page.getByText('已连接').waitFor({ state: 'hidden' });
    await save(page, 'notebook-empty');

    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.locator('#library-input').click(),
    ]);
    await chooser.setFiles([
      { name: 'marked.jpg', mimeType: 'image/jpeg', buffer: await jpeg('marked') },
      { name: 'plain.jpg', mimeType: 'image/jpeg', buffer: await jpeg('plain') },
    ]);
    await page.waitForURL(/\/s\/new$/);
    const marked = page.locator('section.intake-photo[data-state="done"]');
    await marked.waitFor({ timeout: 40_000 });
    await page.locator('section.intake-photo[data-state="needsPick"]').waitFor({ timeout: 40_000 });
    await marked.scrollIntoViewIfNeeded();
    await save(page, 'intake-auto');
    const pick = page.locator('section.intake-photo[data-state="needsPick"]');
    await pick.scrollIntoViewIfNeeded();
    await pick.getByTestId('pick-candidate').first().click();
    await page.waitForTimeout(300);
    await save(page, 'intake-pick');

    await page.getByTestId('intake-done').click();
    await page.waitForURL(/\/s\/?(\?|$)/);
    await page.getByTestId('item-card').first().waitFor();
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

    await page.goto(`http://127.0.0.1:${WEB_PORT}/s/me`);
    await page.getByText('即将推出').waitFor();
    await save(page, 'settings-practice');

    await fetch(`http://127.0.0.1:${CONTROL_PORT}/time-travel?days=7`, { method: 'POST' });
    await page.goto(`http://127.0.0.1:${WEB_PORT}/s/practices`);
    await page.getByRole('heading', { name: '练习' }).waitFor();
    await page.waitForTimeout(500);
    await save(page, 'practice-home');
    const start = page.getByRole('button', { name: /开始做这/ });
    if (await start.count()) {
      await start.click();
      await page.waitForURL(/\/s\/practice\/pkt_/);
      await page.getByTestId('practice-question').waitFor({ timeout: 60_000 });
      await save(page, 'practice-question');
      await page.getByRole('link', { name: '打印练习' }).click();
      await page.getByRole('heading', { name: '打印练习纸' }).waitFor({ timeout: 60_000 });
      await page.waitForTimeout(800);
      await save(page, 'practice-print');
      const practiceUrl = page.url().replace(/\/print\/.*/, (match) => match.replace('/print/', '/practice/').replace(/\/.*/, ''));
      const id = page.url().match(/pkt_[^/?]+/)?.[0];
      if (id) {
        await page.goto(`http://127.0.0.1:${WEB_PORT}/s/practice/${id}?mode=paper&view=check`);
        await page.getByText('把纸上每道题的结果记下来').waitFor({ timeout: 30_000 });
        await save(page, 'practice-record');
        await page.goto(`http://127.0.0.1:${WEB_PORT}/s/practice/${id}/submit`);
        await page.getByRole('heading', { name: '拍照交练习' }).waitFor();
        await save(page, 'practice-submit');
      }
      void practiceUrl;
    }
  } finally {
    try { process.kill(-web.pid!, 'SIGTERM'); } catch { web.kill('SIGTERM'); }
  }

  const host = fork(path.resolve('tests/e2e/studentHostServer.ts'), [], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, NODE_ENV: 'test', SEL_AI_MODE: 'mock' },
    stdio: ['ignore', 'inherit', 'pipe', 'ipc'],
  });
  host.stderr?.on('data', chunk => process.stderr.write(chunk));
  const ready = await new Promise<{ base: string; codes: string[] }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('host timeout')), 40_000);
    host.once('exit', () => { clearTimeout(timer); reject(new Error('host exited')); });
    host.once('message', message => { clearTimeout(timer); resolve(message as { base: string; codes: string[] }); });
  });
  try {
    const base = ready.base;
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
    await page.getByLabel('12 位邀请码').fill(ready.codes[0]!);
    await page.getByRole('button', { name: '进入我的错题本' }).click();
    await page.waitForURL(/login=1/);
    if (await page.getByRole('heading', { name: '你现在读初中还是高中？' }).count()) {
      await save(page, 'stage');
      await page.getByRole('button', { name: '初中', exact: true }).click();
    }
    await page.goto(`${base}/s/me`);
    await page.getByTestId('settings-my-invite').waitFor();
    await save(page, 'settings');
    await page.goto(`${base}/s/account`);
    await page.getByRole('heading', { name: '我的邀请码' }).waitFor();
    await save(page, 'account');
    await page.goto(`${base}/s/install`);
    await page.getByRole('heading', { name: '放到主屏幕' }).waitFor();
    await save(page, 'install');
  } finally {
    if (host.connected) host.send({ stop: true });
    host.kill('SIGTERM');
    setTimeout(() => host.kill('SIGKILL'), 4000).unref();
    await context.close();
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exit(1); });
