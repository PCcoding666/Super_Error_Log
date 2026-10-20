import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { LONG_ANSWER } from '../fixtures/answerRendering.js';

let server: ChildProcess;
let base: string;
test.beforeAll(async () => {
  server = fork(path.resolve('tests/e2e/answerRenderingServer.ts'), [], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, SEL_AI_MODE: 'mock' },
  });
  let errors = '';
  server.stderr?.on('data', chunk => { errors += String(chunk); });
  base = await new Promise<string>((resolve, reject) => {
    server.once('message', message => resolve((message as { base: string }).base));
    server.once('exit', () => reject(new Error(`Answer fixture exited: ${errors}`)));
  });
});
test.afterAll(async () => {
  if (server.exitCode === null) await new Promise<void>(resolve => {
    const timer = setTimeout(() => server.kill('SIGKILL'), 10000);
    server.once('exit', () => { clearTimeout(timer); resolve(); });
    server.kill('SIGTERM');
  });
});

for (const scripting of [true, false]) test.describe(`answer rendering ${scripting ? 'with' : 'without'} JavaScript`, () => {
  test.use({ javaScriptEnabled: scripting });
  test('reads structured work, native formulas and verbatim text on mobile', async ({ page }, info) => {
    const external: string[] = [];
    page.on('request', request => { if (!request.url().startsWith(base)) external.push(request.url()); });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/s/items/synthetic`);
    const evidence = page.getByRole('region', { name: '原作答与订正' });
    await evidence.getByText('你写的', { exact: true }).click();
    await expect(evidence.locator('.answer-part')).toHaveCount(2);
    await expect(evidence.locator('.answer-case')).toHaveCount(3);
    await expect(evidence.locator('math').first()).toBeVisible();
    const fraction = evidence.locator('mfrac').first();
    const numerator = await fraction.locator(':scope > :first-child').boundingBox();
    const denominator = await fraction.locator(':scope > :last-child').boundingBox();
    expect(numerator!.y).toBeLessThan(denominator!.y);
    await expect(evidence.locator('msqrt').first()).toBeVisible();
    await evidence.getByText('老师批注', { exact: true }).click();
    await expect(evidence.locator('.answer-deduction')).toHaveText('扣 2 分');
    await page.emulateMedia({ colorScheme: 'dark' });
    await evidence.screenshot({ path: info.outputPath('answer-dark.png') });
    const original = evidence.locator('.answer-text').first().locator('.answer-original');
    await original.locator('summary').click();
    expect(await original.locator('pre').textContent()).toBe(LONG_ANSWER);
    await original.locator('summary').click();
    expect(external).toEqual([]);
  });

  test('keeps long formulas scrollable at 320px and 200% text size', async ({ page }, info) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto(`${base}/s/items/synthetic?large=1`);
    const evidence = page.getByRole('region', { name: '原作答与订正' });
    await evidence.getByText('你写的', { exact: true }).click();
    await evidence.getByText('其他笔迹', { exact: true }).click();
    const math = evidence.locator('.answer-math-display');
    await expect(math).toBeVisible();
    expect(await math.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
    await math.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => math.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await evidence.screenshot({ path: info.outputPath('answer-320-large.png') });
  });
});
