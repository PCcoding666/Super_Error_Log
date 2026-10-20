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

  test('photo grid contains every tile and caption above the next action', async ({ page }, info) => {
    for (const size of [
      { width: 796, height: 546, font: '100%', colorScheme: 'dark' as const },
      { width: 390, height: 844, font: '100%', colorScheme: 'light' as const },
      { width: 320, height: 740, font: '200%', colorScheme: 'dark' as const },
    ]) {
      await page.setViewportSize(size);
      await page.emulateMedia({ colorScheme: size.colorScheme });
      for (const count of [8, 0, 1, 2, 3, 9]) {
        await page.goto(`${base}/s/capture?count=${count}`);
        await page.evaluate(font => document.documentElement.style.setProperty('font-size', font), size.font);
        await expect(page.getByTestId('photo-tile')).toHaveCount(count);
        await page.locator('[data-photo-grid] img').evaluateAll(async elements => {
          await Promise.all(elements.map(element => { const img = element as HTMLImageElement; img.loading = 'eager'; return img.decode(); }));
        });
        const layout = await page.evaluate(() => {
          const grid = document.querySelector('[data-photo-grid]')!.getBoundingClientRect();
          const tiles = Array.from(document.querySelectorAll('[data-photo-grid] > *')).map(tile => tile.getBoundingClientRect());
          const captions = Array.from(document.querySelectorAll('[data-photo-grid] figcaption')).map(caption => caption.getBoundingClientRect());
          const action = document.querySelector('[data-testid="next-step-bar"]')!.getBoundingClientRect();
          return {
            compatMode: document.compatMode,
            overflow: document.documentElement.scrollWidth - innerWidth,
            gridBottom: grid.bottom, actionTop: action.top,
            tileBottoms: tiles.map(tile => tile.bottom), captionBottoms: captions.map(caption => caption.bottom),
            widths: tiles.map(tile => tile.width),
          };
        });
        expect(layout.compatMode).toBe('CSS1Compat');
        expect(layout.overflow, `${count} photos at ${size.width}px`).toBeLessThanOrEqual(1);
        for (const bottom of [...layout.tileBottoms, ...layout.captionBottoms]) {
          expect(bottom, `grid contains ${count} photos at ${size.width}px`).toBeLessThanOrEqual(layout.gridBottom + 1);
          expect(bottom).toBeLessThan(layout.actionTop);
        }
        if (layout.widths.length) expect(Math.max(...layout.widths) - Math.min(...layout.widths)).toBeLessThanOrEqual(1);
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        const tabs = await page.getByTestId('root-tabs').boundingBox();
        for (const testId of ['next-step-primary', 'next-step-secondary-library']) {
          const action = await page.getByTestId(testId).boundingBox();
          expect(tabs!.y - (action!.y + action!.height), `${testId} above tabs at ${size.width}px`).toBeGreaterThanOrEqual(8);
        }
        if (count === 8) {
          await page.screenshot({ path: info.outputPath(`capture-${size.width}.png`) });
          // The add-page tile remains usable, including the native camera chooser.
          const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('add-page').click()]);
          expect(chooser.isMultiple()).toBe(false);
        }
      }
    }
  });

  test('practice creation button has space before its introduction and cards', async ({ page }, info) => {
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ colorScheme: width === 320 ? 'dark' : 'light' });
      for (const hasPractices of [true, false]) {
        await page.goto(`${base}/s/practices${hasPractices ? '' : '?empty=1'}`);
        if (width === 320) await page.evaluate(() => document.documentElement.style.setProperty('font-size', '200%'));
        const create = page.getByRole('link', { name: '新建练习', exact: true });
        const button = await create.boundingBox();
        const following = await page.locator(hasPractices ? 'main .lead' : 'main .card').boundingBox();
        expect(following!.y - (button!.y + button!.height)).toBeGreaterThanOrEqual(8);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
        await expect(create).toHaveAttribute('href', '/s/choose');
        if (hasPractices) {
          await expect(page.getByTestId('practice-latest')).toContainText('继续练习');
          await page.screenshot({ path: info.outputPath(`practices-${width}.png`) });
        }
      }
    }
  });
});
