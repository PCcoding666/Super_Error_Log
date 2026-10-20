import { expect, test } from '@playwright/test';
import { CLIENT_SCRIPT } from '../../src/web/clientScript.js';

const markup = `<meta charset="utf-8"><form id="save" data-wait="正在保存…"><input name="answer" value="synthetic"></form>
<button type="submit" form="save"><span>保存结果</span></button><button disabled id="unrelated">尚不能提交</button>`;

test('等待提交阻止同一帧重复提交；恢复缓存页面后还原按钮和可访问状态', async ({ page }) => {
  await page.setContent(markup);
  await page.addScriptTag({ content: CLIENT_SCRIPT });
  await page.evaluate(() => document.dispatchEvent(new Event('DOMContentLoaded')));
  const accepted = await page.evaluate(() => {
    const form = document.querySelector('form')!;
    const button = document.querySelector('button')!;
    let count = 0;
    form.addEventListener('submit', event => { if (!event.defaultPrevented) count++; event.preventDefault(); });
    form.requestSubmit(button);
    form.requestSubmit(button);
    return count;
  });
  expect(accepted).toBe(1);
  const submit = page.locator('button[form=save]');
  await expect(submit).toBeDisabled();
  await expect(submit).toHaveText('正在保存…');
  await expect(page.locator('form')).toHaveAttribute('aria-busy', 'true');
  // Exercise the BFCache pageshow lifecycle explicitly; headless navigation may reload instead.
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(submit).toBeEnabled();
  await expect(submit.locator('span')).toHaveText('保存结果');
  await expect(submit).not.toHaveAttribute('aria-label');
  await expect(page.locator('form')).not.toHaveAttribute('aria-busy');
  await expect(page.locator('#unrelated')).toBeDisabled();
});

test('取消的提交不进入等待状态；正常 POST 保留提交按钮的 name/value', async ({ page }) => {
  await page.route('https://form.example.test/**', route => route.fulfill({contentType:'text/html', body: markup.replace('<form ', '<form method="post" action="/saved" ').replace('type="submit"', 'name="action" value="save" type="submit"')}));
  await page.goto('https://form.example.test/');
  await page.evaluate(() => document.querySelector('form')!.addEventListener('submit', event => event.preventDefault(), { once: true }));
  await page.addScriptTag({content:CLIENT_SCRIPT});
  await page.evaluate(() => document.dispatchEvent(new Event('DOMContentLoaded')));
  const submit = page.locator('button[form=save]');
  await submit.click();
  await expect(submit).toBeEnabled();
  await expect(submit).toHaveText('保存结果');
  const posted = page.waitForRequest(request => request.method() === 'POST');
  await submit.click();
  expect(new URLSearchParams((await posted).postData()!)).toEqual(new URLSearchParams({answer:'synthetic',action:'save'}));
});
