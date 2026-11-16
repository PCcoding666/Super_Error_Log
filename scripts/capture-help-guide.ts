/**
 * 给公开说明页拍应用内配图。题目来自两份真实历史试卷（见 scripts/help-real-papers.ts），
 * 不是合成卷，也不是 mock 的 “Synthetic question”。
 * 运行：npx tsx scripts/capture-help-guide.ts
 *
 * 邀请码在截图前改成占位圆点，不把完整邀请码写进图片。
 * 不拍设置、学段、安装说明：那些页会把未发布的入口或重复说明带进帮助页。
 * iPhone 确认页、主屏幕和微信群二维码沿用已有实拍，本脚本不覆盖。
 */
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Page } from '@playwright/test';
import sharp from 'sharp';
import { prepareHelpPages } from './help-real-papers.js';

const OUT = path.resolve('src/portal/help-img');
const onlyShot = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] ?? '' : '';
const onlyNames = onlyShot ? new Set([onlyShot]) : null;
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const BANNED = ['Synthetic', '未分类', '还没有知识点', '稍后给出', '【mock】', '数学小卷', '1 + 1'];

fs.mkdirSync(OUT, { recursive: true });

async function save(page: Page, name: string): Promise<void> {
  if (onlyNames && !onlyNames.has(name)) return;
  const png = await page.screenshot({ type: 'png', animations: 'disabled' });
  const file = path.join(OUT, `${name}.webp`);
  await sharp(png).webp({ quality: 58, effort: 5 }).toFile(file);
  console.log(`${name}.webp ${Math.round(fs.statSync(file).size / 1024)}KB`);
}

async function assertReal(page: Page, label: string): Promise<void> {
  const text = await page.locator('body').innerText();
  for (const banned of BANNED) {
    if (text.includes(banned)) throw new Error(`${label} contains ${banned}`);
  }
  if (/\d{4}-\d{4}-\d{4}/.test(text)) throw new Error(`${label} still shows an invite code`);
}

function startHost(): { child: ChildProcess; ready: Promise<{ base: string }> } {
  const child = fork(path.resolve('scripts/help-real-server.ts'), [], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, SEL_HELP_CAPTURE_ORIGIN: 'https://study.pccoding666.com' },
    stdio: ['ignore', 'inherit', 'pipe', 'ipc'],
  });
  child.stderr?.on('data', chunk => process.stderr.write(chunk));
  const ready = new Promise<{ base: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('host timeout')), 60_000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`host exited ${code}`)); });
    child.once('message', message => { clearTimeout(timer); resolve(message as { base: string }); });
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

async function maskInviteCode(page: Page): Promise<void> {
  const code = page.getByTestId('registered-invite-code');
  await code.evaluate(element => { element.textContent = '••••-••••-••••'; });
}

async function main(): Promise<void> {
  const pages = await prepareHelpPages(fs.mkdtempSync(path.join(os.tmpdir(), 'sel-help-pages-')));
  const exam = fs.readFileSync(pages.exam);
  const factor = fs.readFileSync(pages.factor);
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
    const { base } = await ready;

    await page.goto(`${base}/s/`);
    await page.getByTestId('login-title').waitFor();
    await save(page, 'login');

    await page.goto(`${base}/s/recover`);
    await page.getByRole('heading', { name: '找回邀请码' }).waitFor();
    await save(page, 'recover');

    await page.goto(`${base}/s/register`);
    await page.getByRole('heading', { name: '注册账号' }).waitFor();
    await page.getByText('找回码跟手机号仅用于找回账户').waitFor();
    await save(page, 'register');

    await page.locator('#register-name').fill('帮助页示例');
    await page.locator('#register-phone').fill('13800001111');
    await page.getByTestId('register-pin-input').fill('2580');
    await page.locator('#register-form').evaluate((form: HTMLFormElement) => form.requestSubmit());
    await page.getByTestId('registered-invite-code').waitFor({ timeout: 20_000 });
    await maskInviteCode(page);
    await assertReal(page, 'register-done');
    await save(page, 'register-done');

    await page.getByRole('button', { name: '我已保存，进入错题本' }).click();
    await page.waitForURL(/\/s\//);
    if (await page.getByRole('heading', { name: '你现在读初中还是高中？' }).count()) {
      await page.getByRole('button', { name: '初中', exact: true }).click();
    }

    await page.getByTestId('empty-notebook').waitFor();
    await page.locator('[data-testid="capture-dock"]:visible').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="capture-dock"]')?.getAttribute('data-capture-choice') === 'sheet');
    await page.locator('[data-testid="capture-add"]:visible').click();
    await page.getByTestId('capture-mode-sheet').waitFor();
    await page.getByTestId('capture-mode-single').waitFor();
    await page.getByTestId('capture-mode-multi').waitFor();
    await page.getByTestId('capture-start').waitFor();
    await save(page, 'notebook-empty');

    await page.locator('#camera-input').setInputFiles([
      { name: 'exam.jpg', mimeType: 'image/jpeg', buffer: exam },
      { name: 'factor.jpg', mimeType: 'image/jpeg', buffer: factor },
    ]);
    await page.waitForURL(/\/s\/new$/);
    const examPhoto = page.locator('section.intake-photo:visible').filter({ hasText: '用配方法解方程' });
    const factorPhoto = page.locator('section.intake-photo:visible').filter({ hasText: '分解因式' });
    await examPhoto.waitFor({ timeout: 90_000 });
    await factorPhoto.waitFor({ timeout: 90_000 });
    await examPhoto.getByTestId('pick-candidate').filter({ hasText: '用配方法' }).getByTestId('pick-checkbox').click();
    await page.waitForTimeout(300);
    await assertReal(page, 'intake-pick');
    await examPhoto.scrollIntoViewIfNeeded();
    await save(page, 'intake-pick');

    for (const photo of [examPhoto, factorPhoto]) {
      await photo.getByTestId('pick-page').click();
      await photo.getByTestId('pick-submit').click();
      await photo.locator('[data-testid="intake-question"]').first().waitFor({ timeout: 40_000 });
    }
    await page.getByTestId('intake-done').click();
    await page.waitForURL(/\/s\/?(\?|$)/);
    await page.getByTestId('item-card').filter({ hasText: '用配方法' }).first().waitFor({ timeout: 40_000 });
    await page.getByText('因式分解').first().waitFor();
    await assertReal(page, 'notebook-list');
    await page.getByTestId('item-card').filter({ hasText: '用配方法' }).first().scrollIntoViewIfNeeded();
    await save(page, 'notebook-list');

    await page.getByTestId('item-card').filter({ hasText: '用配方法' }).first().click();
    const detail = page.locator('ion-content.item');
    await detail.getByTestId('question-text').waitFor();
    await detail.getByTestId('item-photo').waitFor();
    await detail.getByTestId('question-text').getByText('用配方法解方程').waitFor();
    await detail.getByText('AI 解答，仅供参考').waitFor({ timeout: 40_000 });
    await page.waitForFunction(() => !document.body.innerText.includes('稍后给出') && !document.body.innerText.includes('【mock】') && !document.body.innerText.includes('Synthetic'));
    await assertReal(page, 'item-detail');
    await detail.getByTestId('item-photo').scrollIntoViewIfNeeded();
    await save(page, 'item-detail');

    await page.getByTestId('item-answer').evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
    await page.waitForTimeout(300);
    await detail.locator('.item-chapter-name', { hasText: '一元二次方程' }).waitFor();
    await detail.getByTestId('item-tags').getByText('配方法', { exact: true }).waitFor();
    await detail.getByTestId('item-tags').getByText('一元二次方程', { exact: true }).waitFor();
    await assertReal(page, 'item-answer');
    await save(page, 'item-answer');

    await detail.getByTestId('item-photo').scrollIntoViewIfNeeded();
    await page.getByTestId('item-more').click();
    await page.locator('ion-popover').getByText('不是错题，移除').waitFor();
    await assertReal(page, 'item-menu');
    await save(page, 'item-menu');
  } finally {
    await stopHost(child);
    await context.close();
    await browser.close();
  }

  if (!onlyNames) {
    for (const stale of ['intake-auto', 'stage', 'settings', 'install', 'account']) {
      const file = path.join(OUT, `${stale}.webp`);
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        console.log(`removed ${stale}.webp`);
      }
    }
  }
}

main().catch(error => { console.error(error); process.exit(1); });
