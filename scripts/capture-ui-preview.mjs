#!/usr/bin/env node
/** Capture only the generated synthetic preview; never contact a student service. */
import { chromium } from '@playwright/test';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
if (!args.includes('--url') || !args.includes('--out')) throw new Error('Usage: node scripts/capture-ui-preview.mjs --url http://127.0.0.1:3188 --out OUTPUT/evidence');
const base = new URL(value('--url'));
if (!['127.0.0.1', 'localhost'].includes(base.hostname)) throw new Error('Capture the local generated synthetic preview only.');
const out = path.resolve(value('--out'));
await mkdir(out, { recursive: true });
const manifest = await (await fetch(new URL('manifest.json', base))).json();
if (!['sel-ui-preview-v1', 'sel-ui-preview-v2'].includes(manifest.generator) || !manifest.syntheticDataOnly) throw new Error('Expected a generated synthetic comparison.');
const browser = await chromium.launch({ headless: true });
const issues = [];
const captures = [];
function watch(page) {
  page.on('pageerror', error => issues.push(String(error)));
  page.on('request', request => {
    if (request.method() !== 'GET' || new URL(request.url()).origin !== base.origin) issues.push(`Unexpected request: ${request.method()} ${new URL(request.url()).pathname}`);
  });
}
async function ready(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    for (const image of document.images) image.loading = 'eager';
    await Promise.all([...document.images].map(image => image.decode().catch(() => {})));
  });
}
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, locale: 'zh-CN', colorScheme: 'light' });
  watch(page);
  for (const scenario of manifest.scenarios) {
    for (const version of ['before', 'after']) {
      await page.goto(new URL(`${version}/${scenario.id}.html?theme=light`, base).href);
      await ready(page);
      const name = `${version}-${scenario.id}.png`;
      await page.screenshot({ path: path.join(out, name), animations: 'disabled' });
      captures.push({ scenario: scenario.id, title: scenario.title, version, file: name });
    }
  }
  if (manifest.sources.after.sheetEnhancementIncluded) {
    for (const appearance of ['light', 'dark']) {
      await page.goto(new URL(`after/today.html?theme=${appearance}`, base).href);
      await ready(page);
      await page.getByTestId('week-plan-open').click();
      await page.waitForFunction(() => getComputedStyle(document.querySelector('dialog')).opacity === '1');
      const name = `after-week-plan-${appearance}.png`;
      await page.screenshot({ path: path.join(out, name), animations: 'disabled' });
      captures.push({ scenario: 'week-plan', title: `本周安排 · ${appearance === 'light' ? '浅色' : '深色'}`, version: 'after', file: name });
    }
  }
  const report = await browser.newPage({ viewport: { width: 1200, height: 1100 }, deviceScaleFactor: 1, locale: 'zh-CN' });
  watch(report);
  for (const appearance of ['light', 'dark']) {
    await report.goto(new URL(`?scenario=today&appearance=${appearance}`, base).href);
    for (const frame of report.frames().filter(frame => frame.parentFrame())) await frame.waitForLoadState('load');
    await report.screenshot({ path: path.join(out, `comparison-${appearance}.png`), fullPage: true, animations: 'disabled' });
  }
  for (const version of ['before', 'after']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, locale: 'zh-CN', colorScheme: 'light', recordVideo: { dir: out, size: { width: 390, height: 844 } } });
    const demo = await context.newPage();
    watch(demo);
    await demo.goto(new URL(`${version}/choose.html?theme=light`, base).href);
    await ready(demo);
    await demo.waitForTimeout(500);
    const checkboxes = demo.locator('#choose-form input[type=checkbox]');
    await checkboxes.first().uncheck();
    await demo.waitForTimeout(400);
    await checkboxes.first().check();
    await demo.getByTestId('next-step-primary').click();
    await demo.locator('#answer-text').fill('移项时忘记变号，这是合成演示。');
    await demo.waitForTimeout(500);
    await demo.getByTestId('next-step-primary').click();
    await demo.waitForTimeout(500);
    const video = demo.video();
    await context.close();
    await rename(await video.path(), path.join(out, `${version}.webm`));
  }
} finally {
  await browser.close();
}
if (issues.length) throw new Error(JSON.stringify(issues));
const escape = text => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
await writeFile(path.join(out, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>界面对照截图与录屏</title><style>body{font:16px/1.6 system-ui,sans-serif;background:#f2f3f7;color:#20252d;max-width:1000px;margin:auto;padding:24px}a{color:#146b65}h1{font-size:28px}.pair{display:flex;gap:20px;overflow:auto}figure{margin:0;min-width:260px}img,video{width:100%;max-width:390px;border-radius:12px;border:1px solid #d5dbe2}section{margin:32px 0}figcaption{font-weight:600;margin:8px 0}</style><h1>界面对照截图与录屏</h1><p><a href="../index.html">返回可操作对照</a> · 相同合成数据、390×844 画面。</p><p>录屏展示静态演示的选题和文字输入，AI、上传、录音与服务器保存由真实应用另行验证。</p><section><h2>交互录屏</h2><div class="pair">${['before', 'after'].map(version => `<figure><figcaption>${version === 'before' ? '改前' : '改后'}</figcaption><video controls playsinline preload="metadata" src="${version}.webm"></video></figure>`).join('')}</div></section>${manifest.scenarios.map(scenario => `<section><h2>${escape(scenario.title)}</h2><div class="pair">${['before', 'after'].map(version => `<figure><figcaption>${version === 'before' ? '改前' : '改后'}</figcaption><a href="${version}-${scenario.id}.png"><img loading="lazy" src="${version}-${scenario.id}.png" alt="${version === 'before' ? '改前' : '改后'}：${escape(scenario.title)}"></a></figure>`).join('')}</div></section>`).join('')}</html>`);
await writeFile(path.join(out, 'capture.json'), JSON.stringify({ sourceManifest: manifest.sources, viewport: { width: 390, height: 844 }, captures, videos: ['before.webm', 'after.webm'], pageErrors: issues }, null, 2));
console.log(`Captured ${captures.length} page screenshots, 2 comparison images and 2 interaction videos.\n${path.join(out, 'index.html')}`);
