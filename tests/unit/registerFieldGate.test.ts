import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium, expect as pw, type Browser, type Page } from '@playwright/test';
import { CLIENT_SCRIPT } from '../../src/web/clientScript.js';

/**
 * 注册页脚本：空的 / 好猜的找回码在格子下面写红字，不发请求；
 * Android 键盘用 visualViewport 把底栏抬到键盘上方，并把焦点滚进可视区域。
 */
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; 2304FPN6DC) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

function registerHtml(): string {
  return `<!doctype html><html><head><style>
    :root{--keyboard-inset:0px;--bar-h:120px}
    body{margin:0;padding-bottom:calc(var(--bar-h) + var(--keyboard-inset) + 24px)}
    .next-bar{position:fixed;left:0;right:0;bottom:var(--keyboard-inset);background:#fff}
    input{display:block;height:48px;margin:12px}
    .field-error[hidden]{display:none}
    #spacer{height:900px}
  </style></head><body>
    <form id="register-form" data-field-gate data-pin-guard="set" data-wait="正在注册…">
      <input id="register-name" name="name" required data-invalid-message="请填写学生姓名（可以写化名）。" data-caption="请先填写姓名">
      <p class="field-error" id="register-name-error" hidden></p>
      <input id="register-phone" name="phone" type="tel" required data-invalid-message="请填写有效手机号。" data-caption="请先填对手机号">
      <p class="field-error" id="register-phone-error" hidden></p>
      <div id="spacer"></div>
      <input id="register-pin" name="pin" required pattern="[0-9]{4}" minlength="4" maxlength="4" data-invalid-message="请设一个 4 位数字的找回码（不要用 1234、0000 这种），忘了邀请码时要用它。" data-caption="请先设好 4 位找回码">
      <p class="field-error" id="register-pin-error" hidden></p>
    </form>
    <nav class="next-bar"><p data-testid="next-step-caption">注册后请保存你的专属邀请码</p>
      <button type="submit" form="register-form" data-testid="next-step-primary">注册并生成邀请码</button></nav>
  </body></html>`;
}

let browser: Browser;
const pages: Page[] = [];
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterEach(async () => { await Promise.all(pages.splice(0).map(page => page.context().close())); });
afterAll(async () => { await browser?.close(); });

async function open(options?: { android?: boolean; keyboard?: boolean }): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 360, height: 740 },
    userAgent: options?.android ? ANDROID : undefined,
    isMobile: options?.android === true,
    hasTouch: options?.android === true,
  });
  const page = await context.newPage();
  pages.push(page);
  await page.setContent(registerHtml());
  if (options?.keyboard) {
    const stubError = await page.evaluate(() => {
      const listeners: Record<string, Array<() => void>> = {};
      const vv = {
        width: 360, height: 740, offsetTop: 0, offsetLeft: 0, scale: 1, pageTop: 0, pageLeft: 0,
        addEventListener(type: string, fn: () => void) { (listeners[type] ??= []).push(fn); },
        removeEventListener(type: string, fn: () => void) { listeners[type] = (listeners[type] ?? []).filter(item => item !== fn); },
        dispatch() { for (const fn of [...(listeners.resize ?? []), ...(listeners.scroll ?? [])]) fn(); },
      };
      try {
        Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => vv });
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      (window as unknown as { __setKeyboard: (height: number) => void }).__setKeyboard = (height: number) => {
        vv.height = height;
        vv.dispatch();
      };
      return '';
    });
    expect(stubError).toBe('');
  }
  await page.addScriptTag({ content: CLIENT_SCRIPT });
  await page.evaluate(() => document.dispatchEvent(new Event('DOMContentLoaded')));
  return page;
}

describe('注册表单：点按钮就能看见哪一格不行', () => {
  it('空的找回码不提交，红字在格子下面，底栏说明也变', async () => {
    const page = await open();
    let posted = 0;
    await page.exposeFunction('__posted', () => { posted += 1; });
    await page.locator('#register-form').evaluate(form => {
      form.addEventListener('submit', event => { event.preventDefault(); (window as unknown as { __posted: () => void }).__posted(); });
    });
    await page.locator('#register-name').fill('pctest002');
    await page.locator('#register-phone').fill('18924082429');
    await page.getByRole('button', { name: '注册并生成邀请码' }).click();
    await pw(page.getByText('请设一个 4 位数字的找回码')).toBeVisible();
    await pw(page.locator('#register-pin')).toHaveAttribute('aria-invalid', 'true');
    await pw(page.getByTestId('next-step-caption')).toHaveText('请先设好 4 位找回码');
    expect(posted).toBe(0);
  });

  it('4567 这种顺着数的找回码同样留在这一页', async () => {
    const page = await open();
    let posted = 0;
    await page.exposeFunction('__posted', () => { posted += 1; });
    await page.locator('#register-form').evaluate(form => {
      form.addEventListener('submit', event => { event.preventDefault(); (window as unknown as { __posted: () => void }).__posted(); });
    });
    await page.locator('#register-name').fill('pctest002');
    await page.locator('#register-phone').fill('18924082429');
    await page.locator('#register-pin').fill('4567');
    await page.getByRole('button', { name: '注册并生成邀请码' }).click();
    await pw(page.locator('#register-pin-error')).toContainText('1234、0000');
    expect(posted).toBe(0);
    await page.locator('#register-pin').fill('2580');
    await page.getByRole('button', { name: '注册并生成邀请码' }).click();
    await expect.poll(() => posted).toBe(1);
    await pw(page.getByTestId('next-step-primary')).toHaveText('正在注册…');
  });

  it('手机号 002 标在手机号上，合格的找回码不会被一起标红', async () => {
    const page = await open();
    await page.locator('#register-name').fill('pctest002');
    await page.locator('#register-phone').fill('002');
    await page.locator('#register-pin').fill('2580');
    await page.getByRole('button', { name: '注册并生成邀请码' }).click();
    await pw(page.locator('#register-phone-error')).toContainText('有效手机号');
    await pw(page.locator('#register-pin')).not.toHaveAttribute('aria-invalid', 'true');
    await pw(page.locator('#register-phone')).toBeFocused();
  });

  it('novalidate 时交给服务器，脚本不拦好猜的找回码', async () => {
    const page = await open();
    let posted = 0;
    await page.exposeFunction('__posted', () => { posted += 1; });
    await page.locator('#register-form').evaluate(form => {
      form.setAttribute('novalidate', '');
      form.addEventListener('submit', event => { event.preventDefault(); (window as unknown as { __posted: () => void }).__posted(); });
    });
    await page.locator('#register-name').fill('pctest002');
    await page.locator('#register-phone').fill('18924082429');
    await page.locator('#register-pin').fill('1234');
    await page.getByRole('button', { name: '注册并生成邀请码' }).click();
    await expect.poll(() => posted).toBe(1);
  });
});

describe('Android 键盘：找回码和底栏留在键盘上面', () => {
  it('焦点在找回码上时，底栏抬到模拟键盘上方，输入框滚进可视区域', async () => {
    const page = await open({ android: true, keyboard: true });
    await page.locator('#register-pin').focus();
    await page.evaluate(() => new Promise<void>(resolve => { setTimeout(resolve, 120); }));
    await page.evaluate(() => { (window as unknown as { __setKeyboard: (height: number) => void }).__setKeyboard(340); });
    await pw.poll(() => page.evaluate(() => {
      const input = document.getElementById('register-pin')!;
      const bar = document.querySelector('.next-bar')!;
      const visible = 340;
      const inputBox = input.getBoundingClientRect();
      const barBox = bar.getBoundingClientRect();
      const inset = getComputedStyle(document.documentElement).getPropertyValue('--keyboard-inset').trim();
      const expected = `${Math.round(window.innerHeight - visible)}px`;
      return inset === expected && inputBox.bottom <= barBox.top + 2 && barBox.bottom <= visible + 2 && inputBox.top >= -2 && inputBox.bottom <= visible + 2;
    })).toBe(true);
  });
});
