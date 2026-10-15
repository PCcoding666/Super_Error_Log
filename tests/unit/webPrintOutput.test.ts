import fs from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium, type Browser } from '@playwright/test';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrintSnapshot } from '../../src/v2/printService.js';
import { CLIENT_SCRIPT, STYLES } from '../../src/web/assets.js';
import { PrintPage, SheetPage } from '../../src/web/views/practice.js';

// Render real SSR pages in an isolated browser. All resources are synthetic;
// no application server, shared port, student data, or external network is used.
const snapshot = JSON.parse(fs.readFileSync(new URL('../fixtures/practice-sheet-snapshot.json', import.meta.url), 'utf8')) as PrintSnapshot;
const readyHtml = '<!doctype html>' + renderToStaticMarkup(PrintPage({
  practiceId: snapshot.packetId, state: { status: 'ready', snapshot }, caption: '准备打印',
}));
const preparingHtml = '<!doctype html>' + renderToStaticMarkup(PrintPage({
  practiceId: snapshot.packetId, state: { status: 'preparing', done: 0, total: snapshot.items.length }, caption: '准备打印',
}));
const sheetHtml = '<!doctype html>' + renderToStaticMarkup(SheetPage({ snapshot }));
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGN8AAAAASUVORK5CYII=', 'base64');
let browser: Browser;

beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });

async function printOutput(html: string, pollToReady = false) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.route('**/*', route => route.fulfill({
      status: 200,
      contentType: route.request().resourceType() === 'image' ? 'image/png' : route.request().resourceType() === 'stylesheet' ? 'text/css' : 'text/javascript',
      body: route.request().resourceType() === 'image' ? pixel : '',
    }));
    await page.setContent(html.replace('<head>', '<head><base href="https://print.invalid/">'));
    await page.addStyleTag({ content: STYLES });
    await page.evaluate(ready => {
      // Exercise the public polling code with a complete SSR response, including
      // its DOM replacement and enhancement. HEAD interaction logging is inert.
      window.fetch = async (_url, options) => {
        const response = new Response(options?.method === 'HEAD' ? '' : ready, {
          headers: { 'content-type': 'text/html' },
        });
        Object.defineProperty(response, 'url', { value: location.href });
        return response;
      };
    }, readyHtml);
    await page.addScriptTag({ content: CLIENT_SCRIPT });
    await page.evaluate(() => document.dispatchEvent(new Event('DOMContentLoaded')));
    if (pollToReady) await page.waitForFunction(() => !document.body.hasAttribute('data-poll'));
    await page.emulateMedia({ media: 'print' });
    if (pollToReady) {
      // The arrival animation must not fade/translate the paper or add a blank page.
      expect(await page.locator('[data-live="print"]').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
    }
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(Array.from(document.images, image => image.decode().catch(() => {})));
    });
    const bytes = await page.pdf({ format: 'A4', printBackground: true });
    const loadingTask = getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
    const pdf = await loadingTask.promise;
    try {
      const pages = [];
      for (let number = 1; number <= pdf.numPages; number += 1) {
        const printedPage = await pdf.getPage(number);
        const viewport = printedPage.getViewport({ scale: 1 });
        const content = await printedPage.getTextContent();
        pages.push({
          width: viewport.width, height: viewport.height,
          text: content.items.map(item => 'str' in item ? item.str : '').join('').replace(/\s+/gu, ''),
        });
      }
      return pages;
    } finally { await loadingTask.destroy(); }
  } finally { await page.context().close(); }
}

describe('A4 output from the main print page', () => {
  it.each([false, true])('matches SheetPage page dimensions and text after polling=%s', async pollToReady => {
    const expected = await printOutput(sheetHtml);
    expect(expected).toHaveLength(3);
    expect(expected[0]!.text).toContain('本周练习');
    expect(expected[1]!.text).toContain('2x+3=7');
    expect(expected[2]!.text).toContain('做完再看');
    for (const page of expected) {
      expect(Math.abs(page.width - 595.3)).toBeLessThan(2);
      expect(Math.abs(page.height - 841.9)).toBeLessThan(2);
    }
    const actual = await printOutput(pollToReady ? preparingHtml : readyHtml, pollToReady);
    expect(actual).toEqual(expected);
  });
});
