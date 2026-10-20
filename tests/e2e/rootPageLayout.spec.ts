import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { expect, test } from '@playwright/test';

let server: ChildProcess;
let base: string;
test.beforeAll(async () => {
  server = fork(path.resolve('tests/e2e/rootPageLayoutServer.ts'), [], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, SEL_AI_MODE: 'mock' },
  });
  let errors = '';
  server.stderr?.on('data', chunk => { errors += String(chunk); });
  base = await new Promise<string>((resolve, reject) => {
    server.once('message', message => resolve((message as { base: string }).base));
    server.once('error', reject);
    server.once('exit', () => reject(new Error(`Layout fixture exited: ${errors}`)));
  });
});
test.afterAll(async () => {
  if (server.exitCode === null) await new Promise<void>(resolve => {
    const timer = setTimeout(() => server.kill('SIGKILL'), 10000);
    server.once('exit', () => { clearTimeout(timer); resolve(); });
    server.kill('SIGTERM');
  });
});

for (const scripting of [true, false]) test.describe(`root page layout ${scripting ? 'with' : 'without'} JavaScript`, () => {
  test.use({ javaScriptEnabled: scripting, serviceWorkers: 'block' });

  test('capture stays compact and its upload actions remain reachable regardless of history size', async ({ page }, info) => {
    for (const size of [
      { width: 796, height: 546, font: '100%', colorScheme: 'dark' as const },
      { width: 390, height: 844, font: '100%', colorScheme: 'light' as const },
      { width: 320, height: 740, font: '200%', colorScheme: 'dark' as const },
    ]) {
      await page.setViewportSize(size);
      await page.emulateMedia({ colorScheme: size.colorScheme });
      let populatedHeight: number | undefined;
      for (const count of [8, 0, 1, 2, 3, 9, 100]) {
        await page.goto(`${base}/s/capture?count=${count}`);
        await page.evaluate(font => document.documentElement.style.setProperty('font-size', font), size.font);
        await expect(page.getByTestId('photo-tile')).toHaveCount(0);
        await expect(page.locator('img[src*="/s/img/photo/"]')).toHaveCount(0);
        await expect(page.getByRole('navigation', { name: '错题录入视图' }).getByRole('link', { name: '已上传记录', exact: true })).toHaveAttribute('href', '/s/photos');
        const layout = await page.evaluate(() => {
          const action = document.querySelector('[data-testid="next-step-bar"]')!.getBoundingClientRect();
          const form = document.querySelector('#upload-form')!.getBoundingClientRect();
          return {
            compatMode: document.compatMode,
            overflow: document.documentElement.scrollWidth - innerWidth,
            actionBottom: action.bottom, formTop: form.top,
            mainHeight: document.querySelector('main')!.getBoundingClientRect().height,
          };
        });
        expect(layout.compatMode).toBe('CSS1Compat');
        expect(layout.overflow, `${count} photos at ${size.width}px`).toBeLessThanOrEqual(1);
        expect(layout.actionBottom).toBeLessThanOrEqual(layout.formTop);
        if (count > 0) {
          populatedHeight ??= layout.mainHeight;
          expect(Math.abs(layout.mainHeight - populatedHeight)).toBeLessThanOrEqual(1);
        }
        for (const testId of ['next-step-primary', 'next-step-secondary-library']) {
          await expect(page.getByTestId(testId)).toBeInViewport();
        }
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        const tabs = await page.getByTestId('root-tabs').boundingBox();
        for (const testId of ['next-step-primary', 'next-step-secondary-library']) {
          const action = await page.getByTestId(testId).boundingBox();
          expect(action!.y).toBeGreaterThanOrEqual(0);
          expect(tabs!.y - (action!.y + action!.height), `${testId} above tabs at ${size.width}px`).toBeGreaterThanOrEqual(8);
        }
        if (count === 8) {
          await page.screenshot({ path: info.outputPath(`capture-${size.width}.png`) });
          const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('next-step-primary').click()]);
          expect(chooser.isMultiple()).toBe(false);
        }
      }
    }
  });

  test('practice dashboard makes the next task action visible without overflow', async ({ page }, info) => {
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ colorScheme: width === 320 ? 'dark' : 'light' });
      for (const hasPractices of [true, false]) {
        await page.goto(`${base}/s/practices${hasPractices ? '' : '?empty=1'}`);
        if (width === 320) await page.evaluate(() => document.documentElement.style.setProperty('font-size', '200%'));
        const action=hasPractices?page.getByRole('link',{name:'查看题目',exact:true}):page.getByRole('button',{name:'就练这 3 道',exact:true});
        await expect(action).toBeVisible();
        expect((await action.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
        await expect(page.getByRole('link',{name:'自己选题',exact:true})).toHaveAttribute('href','/s/choose');
        if(hasPractices)await expect(page.getByTestId('practice-latest')).toContainText('还没有收到作答');
        else await expect(page.getByTestId('practice-recommendation')).toContainText('为什么练');
        await page.screenshot({ path: info.outputPath(`practices-${width}-${hasPractices}.png`),fullPage:true });
      }
    }
  });
});
