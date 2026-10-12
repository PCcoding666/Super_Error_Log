/**
 * 质量轮次的证据包（标准 §6.2）：截图、量测、axe、读屏树、状态矩阵、WebKit 文字放大、录屏、冷加载性能、练习纸 A4。
 * 来源：quality round 1 的 capture.mjs / perf-r1.mjs / video.mjs（orchestrator/reference/sel-quality-r1-iter2/scripts/，当时没有放进仓库）。
 * round 2 把它们原样搬进来（同一视口、同一 UA、同一套 round 0 / round 1 指标与判定，编号沿用），再加上本轮要的：
 *   每屏 CLS、320 / 360 / 375 / 390 px 四种宽度的孤字数、每屏的读屏树（Playwright ariaSnapshot）、
 *   用故障注入截到的等待 / 错误状态（找题中、准备中、准备失败、识别失败、上传中断、转写中、转写失败、连接过期 401、两种服务器忙）、
 *   动效期间的帧率与长任务、WebKit 下 200% 的两种放大、减少动态效果的录屏、性能里的 gzip 字节。
 *
 * 只在设了环境变量时跑（npm run verify 不依赖它）：
 *   SEL_EVIDENCE_DIR=<输出目录> SEL_EVIDENCE=capture|webkit|video|perf|sheet npx playwright test tests/e2e/qualityEvidence.spec.ts
 * 每个部分要一台刚启动的合成服务器（数据干净）：Playwright 每次运行都会重新启动 tests/e2e/webClientServer.ts（3196 / 3197）。
 * 要量别的服务器（例如基线版本）时设 SEL_EVIDENCE_WEB / SEL_EVIDENCE_CONTROL。axe-core 不在仓库依赖里：SEL_AXE_PATH 指向本机已有的 axe.min.js。
 * 所有照片、题目、录音都是合成的。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import sharp from 'sharp';
import { expect, test, webkit, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from '@playwright/test';

const OUT = process.env.SEL_EVIDENCE_DIR ?? '';
const PART = process.env.SEL_EVIDENCE ?? 'capture';
const WEB = process.env.SEL_EVIDENCE_WEB ?? 'http://127.0.0.1:3196';
const CONTROL = process.env.SEL_EVIDENCE_CONTROL ?? 'http://127.0.0.1:3197';
const AXE = process.env.SEL_AXE_PATH ?? '';
const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const WECHAT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50(0x18003237) NetType/WIFI Language/zh_CN';
const DEVICE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IPHONE_SAFARI,
  locale: 'zh-CN', permissions: ['microphone'], bypassCSP: true,
};

test.describe.configure({ mode: 'serial' });
test.skip(!OUT, '只在 SEL_EVIDENCE_DIR 设了时生成证据包');
test.use({ launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] } });

// round 0 / round 1 的编号（同一屏同一个号，便于逐张对比）；68 以后是 round 2 新增的屏和状态。
const IDS: Record<string, number> = {
  'connect-unpaired': 1, 'connect-bad-link': 2, 'pair-in-wechat': 3, 'pair-confirm': 4, 'today-weekA-first': 5, 'connect-link-used': 6, install: 7, consent: 8,
  'capture-empty': 9, 'capture-error': 10, 'capture-one': 11, 'photos-found': 12, items: 13, 'item-detail': 14, 'item-fix': 15, 'item-fix-proposal': 16, 'item-edit': 17,
  'items-removed-undo': 18, choose: 19, 'choose-none': 20, 'why-intro': 21, 'today-weekA-mid': 22, 'why-ask': 23, 'why-ask-second': 24, 'why-confirm-missing': 25,
  'why-done': 26, 'weekA-print-ready': 27, 'weekA-print-after': 28, 'sheet-mobile': 29, 'sheet-a4-print': 30, 'today-weekA-done': 31, practices: 32, settings: 33,
  'settings-saved': 34, offline: 35, 'not-found': 36, 'today-midweek': 37, 'today-weekB': 38, 'today-weekB-after-shoot': 39, 'record-date': 40, 'record-date-error': 41,
  'record-item-empty': 42, 'record-item-correct': 43, 'record-item-stuck': 44, results: 45, 'items-weekB': 46, 'photos-needs-pick': 47, pick: 48, 'pick-two': 49,
  'choose-weekB': 50, 'why-voice-listening': 51, 'why-voice-done': 52, 'weekB-print-ready': 53, 'weekB-print-after': 54, 'today-weekB-done': 55, 'photos-finding': 56,
  'capture-finding': 57, 'photos-after-done': 58, busy: 59,
  'photos-after-done-needs-pick': 60, 'today-done-new-photos': 61, 'why-intro-weekB': 62, 'print-preparing': 63, 'today-waiting-ai': 64, 'photos-after-done-finding': 65,
  'record-item-first-prev': 66, 'sheet-a4-pages': 67,
  // round 2
  'print-failed': 68, 'photos-recognition-failed': 69, 'photos-recognition-unreadable': 70, 'capture-upload-interrupted': 71, 'why-voice-transcribe-failed': 72,
  'connect-expired-401': 73, 'busy-expired': 74, 'busy-connected': 75, 'why-voice-transcribing': 76, 'print-sheet-expanded': 77, 'photos-added': 78,
  'sheet-mobile-after-print': 79, 'today-print-preparing': 80, 'why-confirm-filled': 81,
};
const idOf = (name: string): string => { const id = IDS[name]; if (!id) throw new Error(`no id for ${name}`); return String(id).padStart(2, '0'); };

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const log = (...parts: unknown[]): void => console.log(new Date().toISOString().slice(11, 19), ...parts);
const synthetic = (color: string, width: number): Promise<Buffer> => sharp({ create: { width, height: Math.round(width * 1.35), channels: 3, background: color } }).jpeg({ quality: 85 }).toBuffer();
const pairingLink = async (): Promise<string> => ((await (await fetch(`${CONTROL}/pairing-link`)).json()) as { link: string }).link.replace('https://study.pccoding666.com', WEB);
const timeTravel = async (days: number): Promise<void> => { const r = await fetch(`${CONTROL}/time-travel?days=${days}`, { method: 'POST' }); if (!r.ok) throw new Error('time-travel failed'); };
const fault = async (query: string): Promise<void> => { const r = await fetch(`${CONTROL}/fault?${query}`, { method: 'POST' }); if (!r.ok) throw new Error(`fault ${query}: ${await r.text()}`); };
const primary = (page: Page) => page.getByTestId('next-step-primary').first();
const secondary = (page: Page, key: string) => page.getByTestId(`next-step-secondary-${key}`);
async function clickNav(page: Page, locator: ReturnType<Page['locator']>): Promise<void> {
  await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 30_000 }), locator.click()]);
}
async function primaryText(page: Page): Promise<{ t: string; disabled: boolean } | null> {
  try {
    const p = primary(page);
    const t = (await p.innerText({ timeout: 1000 })).trim();
    const disabled = await p.evaluate(el => (el as HTMLButtonElement).disabled || el.classList.contains('disabled'), null, { timeout: 1000 });
    return { t, disabled };
  } catch { return null; }
}
async function waitPrimary(page: Page, re: string | RegExp, timeout = 60_000): Promise<string> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const p = await primaryText(page);
    if (p && (typeof re === 'string' ? p.t === re : re.test(p.t)) && !p.disabled) return p.t;
    await sleep(400);
  }
  throw new Error(`primary ${re} not reached; now: ${JSON.stringify(await primaryText(page))} at ${page.url()}`);
}
/** 开着脚本的拍照：label 打开文件选择，选好就上传（上传完页面自己 location.replace）。 */
async function shoot(page: Page, bytes: Buffer, name: string): Promise<void> {
  const before = await page.getByTestId('photo-tile').count();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), primary(page).click()]);
  await chooser.setFiles({ name, mimeType: 'image/jpeg', buffer: bytes });
  await expect(page.getByTestId('photo-tile')).toHaveCount(before + 1, { timeout: 30_000 });
}
async function addPhoto(page: Page, bytes: Buffer): Promise<void> {
  await page.goto(`${WEB}/s/capture`);
  const before = await page.getByTestId('photo-tile').count();
  await page.locator('#camera-input').setInputFiles({ name: 'page.jpg', mimeType: 'image/jpeg', buffer: bytes });
  await expect(page.getByTestId('photo-tile')).toHaveCount(before + 1, { timeout: 30_000 });
}
async function skipRemainingWhy(page: Page): Promise<void> {
  for (let guard = 0; guard < 16 && /\/s\/why\/pkt_[0-9a-f]+\/itm_/.test(page.url()); guard += 1) {
    const button = page.url().endsWith('/confirm') ? secondary(page, 'pass') : secondary(page, 'skipQuestion');
    await clickNav(page, button);
  }
}
/** 每一页从载入起记布局偏移（CLS，不算用户输入后 500 ms 内的）、长任务。 */
async function observe(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const w = window as unknown as { __cls: number; __long: number[] };
    w.__cls = 0; w.__long = [];
    try { new PerformanceObserver(list => { for (const e of list.getEntries() as Array<PerformanceEntry & { hadRecentInput: boolean; value: number }>) if (!e.hadRecentInput) w.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); } catch { /* 没有就算了 */ }
    try { new PerformanceObserver(list => { for (const e of list.getEntries()) w.__long.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: true }); } catch { /* 没有就算了 */ }
  });
}

// ---------- round 0 / round 1 的页面内指标（原样，来自 R1 capture.mjs；只在浏览器里跑，所以是 JS 字符串） ----------
const COLLECT_METRICS = String.raw`function collectMetrics() {
  const vis = el => {
    if (!el || el.closest('.hidden')) return false;
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const all = document.getElementsByTagName('*');
  let maxDepth = 0;
  for (const el of all) { let d = 0, p = el; while (p.parentElement) { d++; p = p.parentElement; } if (d > maxDepth) maxDepth = d; }
  const sel = 'a[href], button, input:not([type=hidden]), select, textarea, summary, label.choice, label.btn, label.add-tile, [role=button]';
  const targets = [];
  for (const el of document.querySelectorAll(sel)) {
    if (el.matches('input') && el.closest('label')) continue;
    if (el.classList.contains('visually-hidden')) continue;
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    targets.push({ tag: el.tagName.toLowerCase(), cls: el.className || '', text: (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 28), w: Math.round(r.width), h: Math.round(r.height) });
  }
  const small44 = targets.filter(t => t.w < 44 || t.h < 44);
  const small24 = targets.filter(t => t.w < 24 || t.h < 24);
  const sizes = {}; let minFont = 99; let textChars = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const n = walker.currentNode; const t = n.textContent.trim(); if (!t) continue;
    const el = n.parentElement; if (!vis(el) || el.closest('.sheet')) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize); sizes[fs] = (sizes[fs] || 0) + t.length; textChars += t.length; if (fs < minFont) minFont = fs;
  }
  const primary = document.querySelector('[data-testid=next-step-primary]');
  const pr = primary && vis(primary) ? primary.getBoundingClientRect() : null;
  const bar = document.querySelector('.next-bar');
  const barRect = bar ? bar.getBoundingClientRect() : null;
  const barButtons = bar ? [...bar.querySelectorAll('.btn')].filter(vis).map(b => { const r = b.getBoundingClientRect(); return { text: b.innerText.trim(), w: Math.round(r.width), h: Math.round(r.height), primary: b.classList.contains('primary'), disabled: b.disabled || b.classList.contains('disabled') }; }) : [];
  const mainText = (document.querySelector('main')?.innerText || '');
  const cjkAsciiPunct = (mainText.match(/[一-鿿][,:;!?](?=\s|$|[一-鿿])|[一-鿿]\.\.\./g) || []).length;
  const cjkLatinTight = (mainText.match(/[一-鿿][A-Za-z0-9]|[A-Za-z0-9][一-鿿]/g) || []).length;
  const cjkLatinSpaced = (mainText.match(/[一-鿿] [A-Za-z0-9]|[A-Za-z0-9] [一-鿿]/g) || []).length;
  const families = new Set(); for (const el of [document.body, ...document.body.querySelectorAll('*')].slice(0, 600)) { if (vis(el) && !el.closest('.sheet')) families.add(getComputedStyle(el).fontFamily); }
  const firstMainBottom = (() => { const m = document.querySelector('main'); return m ? Math.round(m.getBoundingClientRect().top) : null; })();
  return {
    title: document.title, h1: document.querySelector('h1')?.innerText.trim() ?? null, url: location.pathname + location.search.replace(/code=[^&]+/, 'code=…'),
    domNodes: all.length, maxDepth, htmlChars: document.documentElement.outerHTML.length,
    scrollHeight: document.documentElement.scrollHeight, viewportH: innerHeight,
    primary: primary ? { text: primary.innerText.trim(), disabled: !!(primary.disabled || primary.classList.contains('disabled')), visible: !!pr, top: pr && Math.round(pr.top), h: pr && Math.round(pr.height), w: pr && Math.round(pr.width) } : null,
    secondary: [...document.querySelectorAll('[data-testid^=next-step-secondary]')].filter(vis).map(e => e.innerText.trim()),
    caption: document.querySelector('[data-testid=next-step-caption]')?.innerText.trim() ?? null,
    barTop: barRect ? Math.round(barRect.top) : null, barHeight: barRect ? Math.round(barRect.height) : 0, barButtons,
    bodyPadBottom: parseFloat(getComputedStyle(document.body).paddingBottom),
    mainTop: firstMainBottom,
    mainButtons: [...document.querySelectorAll('main .btn')].filter(vis).map(e => e.innerText.trim()),
    tapTargets: targets.length, small44, small24: small24.length,
    minFont, fontSizes: sizes, textChars, fontFamilies: [...families], webfonts: document.fonts.size,
    images: document.images.length, imagesNoAlt: [...document.images].filter(i => !i.hasAttribute('alt')).length,
    cjkAsciiPunct, cjkLatinTight, cjkLatinSpaced,
    headings: [...document.querySelectorAll('h1,h2,h3')].filter(vis).map(h => h.tagName + ':' + h.innerText.trim().slice(0, 20)),
    landmarks: { main: !!document.querySelector('main'), nav: !!document.querySelector('nav'), header: !!document.querySelector('header') },
    lang: document.documentElement.lang,
  };
}`;
const COLLECT_EXTRA = String.raw`function collectExtra() {
  const vis = el => {
    if (!el || el.closest('.hidden')) return false;
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  // 单字孤行：按字符的行位置分行，任何一行只有 1 个可见字符（多行时）就记下来。
  const sel = '.btn, .choice > span, h1, h2, legend, .step-title, .step-detail, .caption, summary, .more, .more-inline, .link-btn, .field-label, .card-title, .rhythm li, .flash, .chip, .tag';
  const orphans = [];
  let checked = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (!vis(el) || el.closest('.sheet') || el.closest('.visually-hidden')) continue;
    checked += 1;
    const lines = [];
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (tw.nextNode()) {
      const n = tw.currentNode;
      for (let i = 0; i < n.data.length; i += 1) {
        const ch = n.data[i]; if (/\s/.test(ch)) continue;
        const range = document.createRange(); range.setStart(n, i); range.setEnd(n, i + 1);
        const rect = range.getClientRects()[0]; if (!rect || rect.width === 0) continue;
        const mid = rect.top + rect.height / 2;
        const line = lines.find(l => Math.abs(l.mid - mid) < 6);
        if (line) line.text += ch; else lines.push({ mid, text: ch });
      }
    }
    if (lines.length > 1 && lines.some(l => [...l.text].length === 1)) {
      const r = el.getBoundingClientRect();
      orphans.push({ cls: String(el.className || el.tagName), inBar: !!el.closest('.next-bar'), text: el.innerText.trim().replace(/\s+/g, ' ').slice(0, 40), lines: lines.sort((a, b) => a.mid - b.mid).map(l => l.text), w: Math.round(r.width) });
    }
  }
  const barLines = [...document.querySelectorAll('.next-bar .btn')].filter(vis).map(b => {
    const cs = getComputedStyle(b); const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3;
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    return { text: b.innerText.trim(), lines: Math.max(1, Math.round((b.getBoundingClientRect().height - pad) / lh - 0.2)), h: Math.round(b.getBoundingClientRect().height) };
  });
  const focusVisibleRule = [...document.styleSheets].some(s => { try { return [...s.cssRules].some(r => String(r.cssText).includes(':focus-visible')); } catch { return false; } });
  return {
    orphans, orphanChecked: checked, barLines,
    // 只数非空的行内样式（截图时浏览器会给输入框加一个空的 style 属性）；进度条宽度、预览缩放是脚本算的，不算。
    inlineStyles: [...document.querySelectorAll('body [style]')].filter(e => (e.getAttribute('style') || '').trim() !== '' && !e.closest('.sheet') && !e.matches('.progress i, .sheet-scale, .sheet-wrap')).length,
    focusVisibleRule,
    lastContentBottom: (() => { const m = document.querySelector('main'); if (!m) return null; return Math.round(m.getBoundingClientRect().bottom + scrollY); })(),
    docHeight: document.documentElement.scrollHeight,
  };
}`;

async function runAxe(page: Page, onlyContrast: boolean): Promise<unknown> {
  if (!AXE) return { error: 'SEL_AXE_PATH 没设' };
  const has = await page.evaluate(() => Boolean((window as unknown as { axe?: unknown }).axe)).catch(() => false);
  if (!has) await page.addScriptTag({ path: AXE });
  return page.evaluate(async only => {
    const axe = (window as unknown as { axe: { run: (ctx: Document, opts: unknown) => Promise<{ violations: Array<Record<string, any>>; incomplete: Array<Record<string, any>> }> } }).axe;
    const opts = only
      ? { runOnly: { type: 'rule', values: ['color-contrast'] }, resultTypes: ['violations', 'incomplete'] }
      : { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }, resultTypes: ['violations', 'incomplete'] };
    const r = await axe.run(document, opts);
    const map = (list: Array<Record<string, any>>) => list.map(v => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 5).map((n: any) => n.target.join(' ')), detail: v.nodes.slice(0, 3).map((n: any) => String(n.any[0]?.message || n.failureSummary || '').slice(0, 220)) }));
    return { violations: map(r.violations), incomplete: map(r.incomplete).map(i => ({ id: i.id, nodes: i.nodes })) };
  }, onlyContrast);
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('load').catch(() => {});
  await page.evaluate(async () => {
    await Promise.all([...document.images].filter(i => i.loading !== 'lazy' || i.getBoundingClientRect().top < innerHeight).map(img => (img.complete ? null : new Promise(r => { img.onload = img.onerror = r; setTimeout(r, 4000); }))));
    await document.fonts.ready;
    // 等说明状态的动效放完再截（转圈这种一直转的不等）。
    const end = Date.now() + 1500;
    while (Date.now() < end && document.getAnimations().some(a => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity)) await new Promise(r => setTimeout(r, 50));
  }).catch(() => {});
  await sleep(200);
}

interface SnapOptions { flow?: string; axe?: boolean; full?: boolean; widths?: boolean }
interface Rec { id: string; name: string; desc: string; flow: string; files: Record<string, unknown>; metrics: any; extra?: any; axeLight?: unknown; axeDarkContrast?: unknown; cls?: number; longTasks?: number[]; orphansByWidth?: Record<string, number>; orphansDetail?: Record<string, string[]>; a11y?: string; browser?: string }
const records: Rec[] = [];
const ORPHAN_WIDTHS = [320, 360, 375];

async function snap(page: Page, name: string, desc: string, opts: SnapOptions = {}): Promise<void> {
  const id = idOf(name);
  const base = `${id}-${name}`;
  await settle(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await sleep(80);
  await page.screenshot({ path: `${OUT}/${base}-light.jpg`, type: 'jpeg', quality: 80 });
  const metrics = await page.evaluate(`(${COLLECT_METRICS})()`);
  const extra = await page.evaluate(`(${COLLECT_EXTRA})()`) as { orphans: Array<{ text: string; lines: string[] }> };
  const { cls, longTasks } = await page.evaluate(() => { const w = window as unknown as { __cls?: number; __long?: number[] }; return { cls: Number((w.__cls ?? 0).toFixed(4)), longTasks: w.__long ?? [] }; });
  const axeLight = opts.axe === false ? null : await runAxe(page, false).catch(e => ({ error: String(e).slice(0, 200) }));
  // 读屏树（Playwright 的 aria 快照：角色、名字、层级，读屏软件按这个读）。
  fs.mkdirSync(`${OUT}/a11y`, { recursive: true });
  const a11y = `a11y/${base}.yml`;
  fs.writeFileSync(`${OUT}/${a11y}`, await page.locator('body').ariaSnapshot().catch(e => `# 取不到：${String(e).slice(0, 200)}`));
  await page.emulateMedia({ colorScheme: 'dark' });
  await sleep(150);
  await page.screenshot({ path: `${OUT}/${base}-dark.jpg`, type: 'jpeg', quality: 80 });
  const axeDark = opts.axe === false ? null : await runAxe(page, true).catch(e => ({ error: String(e).slice(0, 200) }));
  await page.emulateMedia({ colorScheme: 'light' });
  const files: Record<string, unknown> = { light: `${base}-light.jpg`, dark: `${base}-dark.jpg` };
  const m = metrics as { scrollHeight: number; viewportH: number; primary?: { text: string } | null; small44: unknown[] };
  if (m.scrollHeight > m.viewportH + 60 && opts.full !== false) {
    await page.evaluate(() => document.querySelectorAll('img[loading=lazy]').forEach(i => { (i as HTMLImageElement).loading = 'eager'; })).catch(() => {});
    await sleep(400);
    await page.screenshot({ path: `${OUT}/${base}-full-light.jpg`, type: 'jpeg', quality: 72, fullPage: true });
    files.full = `${base}-full-light.jpg`;
  }
  // 窄屏的孤字：同一页在 320 / 360 / 375 px 宽下各量一次（390 就是上面那次）。
  const orphansByWidth: Record<string, number> = { 390: extra.orphans.length };
  const orphansDetail: Record<string, string[]> = { 390: extra.orphans.map(o => `${o.text}（${o.lines.join(' / ')}）`) };
  if (opts.widths !== false) {
    const size = page.viewportSize()!;
    for (const width of ORPHAN_WIDTHS) {
      await page.setViewportSize({ width, height: size.height });
      await sleep(180);
      const narrow = await page.evaluate(`(${COLLECT_EXTRA})()`) as { orphans: Array<{ text: string; lines: string[] }> };
      orphansByWidth[width] = narrow.orphans.length;
      orphansDetail[width] = narrow.orphans.map(o => `${o.text}（${o.lines.join(' / ')}）`);
    }
    await page.setViewportSize(size);
    await sleep(120);
  }
  records.push({ id, name, desc, flow: opts.flow ?? '', files, metrics, extra, axeLight, axeDarkContrast: axeDark, cls, longTasks, orphansByWidth, orphansDetail, a11y });
  const serious = ((axeLight as { violations?: Array<{ impact: string; id: string }> } | null)?.violations ?? []).filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => v.id);
  log('snap', id, name, m.primary?.text ?? '(无主按钮)', '| small44', m.small44.length, '| orphans', JSON.stringify(orphansByWidth), '| cls', cls, serious.length ? `!!SERIOUS ${serious}` : '');
}

/** 浅色 / 深色两套 token 的对比表（原样，来自 R1）。 */
async function tokenTable(page: Page): Promise<unknown> {
  const out: Record<string, unknown> = {};
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await sleep(100);
    out[scheme] = await page.evaluate(() => {
      const css = getComputedStyle(document.documentElement);
      const v = (name: string) => css.getPropertyValue(name).trim();
      const probe = document.createElement('div'); document.body.appendChild(probe);
      const rgb = (color: string) => { probe.style.color = color; return getComputedStyle(probe).color.match(/[\d.]+/g)!.map(Number).slice(0, 3); };
      const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
      const L = (c: number[]) => 0.2126 * lin(c[0]!) + 0.7152 * lin(c[1]!) + 0.0722 * lin(c[2]!);
      const ratio = (a: string, b: string) => { const [x, y] = [L(rgb(a)), L(rgb(b))].sort((p, q) => q - p); return Math.round(((x! + 0.05) / (y! + 0.05)) * 100) / 100; };
      const mix = (a: string, b: string, p: number) => { const x = rgb(a), y = rgb(b); return `rgb(${x.map((c, i) => Math.round(c * p + y[i]! * (1 - p))).join(',')})`; };
      const bgs: Record<string, string> = { paper: v('--paper'), card: v('--card'), mint: v('--mint'), tealTint8: mix(v('--teal'), v('--card'), 0.08), tealTint14: mix(v('--teal'), v('--card'), 0.14), redTint14: mix(v('--red'), v('--card'), 0.14), disabledBg: v('--disabled-bg') };
      const rows: Record<string, Record<string, number>> = {};
      for (const fg of ['--ink', '--muted', '--teal', '--blue', '--orange', '--green', '--red']) rows[fg] = Object.fromEntries(Object.entries(bgs).map(([k, b]) => [k, ratio(v(fg), b)]));
      const nonText = { 'field/card': ratio(v('--field'), v('--card')), 'field/paper': ratio(v('--field'), v('--paper')), 'focus/paper': ratio(v('--focus'), v('--paper')), 'focus/card': ratio(v('--focus'), v('--card')), 'teal(border)/card': ratio(v('--teal'), v('--card')) };
      const buttons = { 'on-teal/teal': ratio(v('--on-teal'), v('--teal')), 'disabled-ink/disabled-bg': ratio(v('--disabled-ink'), v('--disabled-bg')) };
      probe.remove();
      return { tokens: Object.fromEntries(['--paper', '--card', '--ink', '--muted', '--teal', '--on-teal', '--mint', '--line', '--field', '--blue', '--orange', '--green', '--red', '--disabled-bg', '--disabled-ink', '--focus', '--dur-1', '--dur-2', '--dur-3', '--ease'].map(n => [n, v(n)])), text: rows, nonText, buttons };
    });
  }
  await page.emulateMedia({ colorScheme: 'light' });
  return out;
}

function writeJson(file: string, data: unknown): void { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, file), JSON.stringify(data, null, 2)); }

// =====================================================================================================
// capture：每一屏浅 / 深截图 + 指标 + axe + 读屏树 + 窄屏孤字 + CLS；状态矩阵；练习纸 A4；动效帧率
// =====================================================================================================
test('capture：每一屏、每个状态（含故障注入的状态矩阵）', async ({ browser }) => {
  test.skip(PART !== 'capture', 'SEL_EVIDENCE=capture');
  test.setTimeout(40 * 60_000);
  fs.mkdirSync(OUT, { recursive: true });
  const ctx = await browser.newContext(DEVICE);
  await observe(ctx);
  await ctx.addInitScript(() => { window.print = () => { window.dispatchEvent(new Event('afterprint')); }; });
  await mockMicrophone(ctx);
  const page = await ctx.newPage();
  const consoleErrors: Array<{ url: string; text: string }> = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push({ url: page.url().replace(/code=[^&]+/, 'code=…'), text: m.text().slice(0, 200) }); });
  page.on('pageerror', e => consoleErrors.push({ url: page.url(), text: 'pageerror: ' + String(e).slice(0, 200) }));
  const t0 = Date.now();
  let flow = '周末 A';

  // ---------- 连接 ----------
  const stranger = await browser.newContext(DEVICE);
  await observe(stranger);
  const sp = await stranger.newPage();
  await sp.goto(`${WEB}/s/`);
  await snap(sp, 'connect-unpaired', '连接页：没配对（「先连上服务器」，两种连法 + 粘贴「连接用的链接」）', { flow: '连接' });
  const tokens = await tokenTable(sp);
  await sp.goto(`${WEB}/s/pair?code=broken`);
  await sp.evaluate(() => document.querySelectorAll('details').forEach(d => { d.open = true; }));
  await snap(sp, 'connect-bad-link', '连接页：链接不完整（错误卡；「具体原因」展开）', { flow: '连接' });
  const link1 = await pairingLink();
  const wechat = await browser.newContext({ ...DEVICE, userAgent: WECHAT });
  const wp = await wechat.newPage();
  await wp.goto(link1);
  await snap(wp, 'pair-in-wechat', '配对确认页：在微信里打开（换到 Safari，主按钮不可点）', { flow: '连接' });
  await wechat.close();
  const tPair = Date.now();
  await page.goto(link1);
  await snap(page, 'pair-confirm', '配对确认页（「连接这台手机」）', { flow: '连接' });
  await clickNav(page, primary(page));
  const firstRunMs = Date.now() - tPair;
  await snap(page, 'today-weekA-first', '今天（周末 A，刚连上）：flash「连上了 ✓」+ 5 步清单', { flow });
  await clickNav(page, page.locator('[data-key=install-seen]'));
  await sp.goto(link1);
  await clickNav(sp, primary(sp));
  await sp.evaluate(() => document.querySelectorAll('details').forEach(d => { d.open = true; }));
  await snap(sp, 'connect-link-used', '连接页：链接已经用过', { flow: '连接' });
  // 401：这台手机的连接失效了（cookie 还在但无效）。
  const expired = await browser.newContext(DEVICE);
  await expired.addCookies([{ name: 'sel_device', value: 'expired-or-revoked-token', url: `${WEB}/s/` }]);
  const ep = await expired.newPage();
  await ep.goto(`${WEB}/s/`);
  await snap(ep, 'connect-expired-401', '连接失效（401，cookie 还在但无效）：「需要重新扫码」，照片和错题都还在（状态矩阵）', { flow: '状态矩阵' });

  // ---------- 周末 A ----------
  await page.goto(`${WEB}/s/install`);
  await snap(page, 'install', '放到主屏幕：4 步', { flow });
  await page.goto(`${WEB}/s/`);
  await clickNav(page, primary(page));
  await snap(page, 'consent', '上传前看一下（第一次上传前的隐私说明）', { flow });
  await clickNav(page, primary(page));
  await snap(page, 'capture-empty', '拍这周的卷子：还没拍', { flow });
  await page.goto(`${WEB}/s/capture?err=unreadable`);
  await snap(page, 'capture-error', '拍这周的卷子：上传失败提示（照片读不出来）', { flow });
  // 上传中途断网：照片还在这个页面里，「再试一次」（状态矩阵）。
  await page.goto(`${WEB}/s/capture`);
  await page.route(`${WEB}/s/capture`, route => (route.request().method() === 'POST' ? route.abort('internetdisconnected') : route.continue()));
  await page.locator('#camera-input').setInputFiles({ name: 'page-0.jpg', mimeType: 'image/jpeg', buffer: await synthetic('#f2cfc6', 900) });
  await expect(page.getByTestId('upload-message')).toHaveText('没传上去。照片还在这个页面里。');
  await snap(page, 'capture-upload-interrupted', '拍这周的卷子：上传中途断网——「没传上去。照片还在这个页面里。」+「再试一次」（状态矩阵）', { flow: '状态矩阵', widths: false });
  await page.unroute(`${WEB}/s/capture`);
  // 找题中（AI 停住）：拍卷子、今天、勾出做错的题三页都在局部轮询，写着已经等了多久。
  await page.goto(`${WEB}/s/capture`);
  await fault('vision=hold');
  await shoot(page, await synthetic('#f2cfc6', 900), 'page-1.jpg');
  await sleep(1500);
  await snap(page, 'capture-finding', '拍这周的卷子：刚上传，缩略图下「AI 正在找题」（局部轮询中）', { flow: '等待' });
  await page.goto(`${WEB}/s/`);
  await sleep(2500);
  await snap(page, 'today-waiting-ai', '今天：AI 还在找题（第 2 步「AI 正在找题（1 张）」，清单下写已经等了多久；局部轮询中）', { flow: '等待' });
  await page.goto(`${WEB}/s/photos`);
  await sleep(3500);
  await snap(page, 'photos-finding', '勾出做错的题：AI 正在找题（已经等了几秒 · 一般 1–2 分钟；局部轮询，不再整页刷新）', { flow: '等待' });
  await fault('vision=release');
  await waitPrimary(page, '下一步：选这周要练的题', 60_000);
  await snap(page, 'photos-found', '勾出做错的题：找好了——这一行和底栏是局部换上来的（同一个页面，没刷新；CLS 记的是这一页从打开到现在）', { flow });

  await page.goto(`${WEB}/s/items`);
  await snap(page, 'items', '这周的错题：卡片列表（裁图按显示尺寸下发）', { flow: '随时可以看' });
  const itemHref = (await page.getByTestId('item-card').first().getAttribute('href'))!;
  await page.goto(`${WEB}${itemHref}`);
  await snap(page, 'item-detail', '题目详情', { flow: '随时可以看' });
  await page.goto(`${WEB}${itemHref}/fix`);
  await snap(page, 'item-fix', '改一下', { flow: '随时可以看' });
  await page.locator('#fix-instruction').fill('第一行的 3 应该是 8');
  await clickNav(page, primary(page));
  await snap(page, 'item-fix-proposal', '改一下：生成的修改', { flow: '随时可以看' });
  await page.goto(`${WEB}${itemHref}/edit`);
  await snap(page, 'item-edit', '自己动手改', { flow: '随时可以看' });
  await page.goto(`${WEB}${itemHref}`);
  await clickNav(page, secondary(page, 'discard'));
  await snap(page, 'items-removed-undo', '这周的错题：「已移出这道题 撤销」', { flow: '随时可以看' });
  await clickNav(page, page.getByRole('button', { name: '撤销' }));

  await page.goto(`${WEB}/s/photos`);
  await waitPrimary(page, '下一步：选这周要练的题');
  await clickNav(page, primary(page));
  await snap(page, 'choose', '选这周要练的题', { flow });
  for (const box of await page.locator('input[name=itemIds]').all()) await box.uncheck({ force: true });
  await sleep(300);
  await snap(page, 'choose-none', '选这周要练的题：一道都不选（主按钮「至少选 1 道」）', { flow, full: false });
  for (const box of await page.locator('input[name=itemIds]').all()) await box.check({ force: true });
  await clickNav(page, primary(page));
  const whyUrl = page.url();
  await snap(page, 'why-intro', '说说为什么错：开头一屏', { flow });
  await page.goto(`${WEB}/s/`);
  await snap(page, 'today-weekA-mid', '今天（周末 A 进行中）：前 3 步打勾，第 4 步「现在做这个」（从上一次看到的清单起，刚打勾的 ✓ 弹出、现在这一步浮上来）', { flow });
  // 动效期间的帧率与长任务（CPU 4 倍降速）：回到选题那一步再回来，「今天」清单放打勾与挪到下一步的动效。
  const motion = await motionProbe(page);
  await page.goto(whyUrl);
  await clickNav(page, primary(page));
  await snap(page, 'why-ask', '说说为什么错：问答屏', { flow });
  await page.locator('#answer-text').fill('我以为移项不用变号，就直接抄过去了。');
  await clickNav(page, primary(page));
  await snap(page, 'why-ask-second', '说说为什么错：AI 再问一句', { flow });
  await clickNav(page, secondary(page, 'skipQuestion'));
  await snap(page, 'why-confirm-missing', '说说为什么错：确认屏（选项按词组断行；「有没有把握」不预选，缺项时「还差：…」）', { flow });
  await page.getByText('现在做应该会').first().click();
  await snap(page, 'why-confirm-filled', '说说为什么错：确认屏选好了（点了的选项轻轻按下去；主按钮从不能点变成能点，新字滑进来）', { flow, widths: false });
  await clickNav(page, primary(page));
  await skipRemainingWhy(page);
  await snap(page, 'why-done', '说完了 ✓（✓ 弹出来）', { flow });
  await clickNav(page, primary(page));
  // 打印：准备中（真的那一刻 mock 太快，用故障注入停在第 1 道）→ 就绪。
  const printUrl = page.url();
  await waitPrimary(page, '打印', 90_000);
  await fault('print=preparing&done=1');
  await page.goto(printUrl);
  await sleep(2500);
  await snap(page, 'print-preparing', '打印练习纸：准备中（第 1/3 道、进度条、已经等了多久、照现在的速度还要多久；局部轮询；主按钮转圈不可点，上面一行「先回到今天」）（状态矩阵）', { flow: '状态矩阵' });
  await page.goto(`${WEB}/s/`);
  await snap(page, 'today-print-preparing', '今天：练习纸准备中（第 5 步「正在准备练习纸…」，清单下写已经等了多久、照现在的速度还要多久）。注意：这一份前面「说说为什么错」是一道一道跳过的，不算整步跳过，所以现在这一步仍是第 4 步（周计划规则，本轮不改）（状态矩阵）', { flow: '状态矩阵' });
  await fault('print=failed');
  await page.goto(printUrl);
  await snap(page, 'print-failed', '打印练习纸：准备失败（服务器原文 +「再试一次」+「先回到今天」）（状态矩阵）', { flow: '状态矩阵' });
  await fault('print=restore');
  await page.goto(printUrl);
  await waitPrimary(page, '打印', 90_000);
  await snap(page, 'weekA-print-ready', '打印练习纸：就绪——首屏是第 1 道题按纸上原样、原大小；下面是题目清单；整张 A4 是可展开的缩略图（纸面本身不变）', { flow });
  await page.getByTestId('sheet-toggle').click();
  await snap(page, 'print-sheet-expanded', '打印练习纸：点「展开看整张」以后，整张 A4 在原地展开（再点收起）', { flow });
  await page.getByTestId('sheet-toggle').click();
  await primary(page).click();
  await sleep(1000);
  await snap(page, 'weekA-print-after', '打印后：主按钮换成「打印好了，回到今天」（新字滑进来），上面一行「再打印」', { flow });
  const sheetHref = (await page.getByTestId('sheet-link').getAttribute('href'))!;
  await page.goto(`${WEB}${sheetHref}`);
  await snap(page, 'sheet-mobile', '练习纸单独页：首屏和打印页一样；打印之前主按钮是「打印」（不再是「打印好了，回到今天」）', { flow });
  await primary(page).click();
  await sleep(1000);
  await snap(page, 'sheet-mobile-after-print', '练习纸单独页：打印回来以后主按钮才是「打印好了，回到今天」', { flow });
  await sheetA4(browser, ctx, sheetHref, flow);

  await page.goto(`${WEB}/s/?printed=1`);
  await snap(page, 'today-weekA-done', '今天（周末 A 做完了）：「这周的事做完了 ✓」（从清单变过来时卡片浮上来、✓ 弹出来）', { flow });
  await page.goto(`${WEB}/s/practices`);
  await snap(page, 'practices', '以前的练习', { flow: '随时可以看' });
  await page.goto(`${WEB}/s/settings`);
  await snap(page, 'settings', '设置', { flow: '随时可以看' });
  await clickNav(page, primary(page));
  await snap(page, 'settings-saved', '设置：保存好了', { flow: '随时可以看', full: false });
  await page.goto(`${WEB}/s/offline`);
  await snap(page, 'offline', '离线页（Service Worker 缓存的外壳）', { flow: '状态矩阵' });
  await page.goto(`${WEB}/s/no-such-page`);
  await snap(page, 'not-found', '404', { flow: '状态矩阵' });

  // ---------- 周中 ----------
  await timeTravel(3);
  await page.goto(`${WEB}/s/`);
  await snap(page, 'today-midweek', '今天（周中）', { flow: '周中' });

  // ---------- 周末 B ----------
  flow = '周末 B';
  await timeTravel(4);
  await page.goto(`${WEB}/s/`);
  await snap(page, 'today-weekB', '今天（周末 B）：6 步，「录练习纸的结果」在第 2 步', { flow });
  await clickNav(page, primary(page));
  await shoot(page, await synthetic('#c6cff2', 820), 'page-2.jpg');
  await page.goto(`${WEB}/s/`);
  await snap(page, 'today-weekB-after-shoot', '今天（周末 B 拍完 1 张）：第 1 步打勾，第 2 步「录练习纸的结果」现在做这个', { flow });
  await page.goto(`${WEB}/s/capture`);
  await clickNav(page, primary(page));
  await snap(page, 'record-date', '录结果：练习纸是哪天做的？（不预选）', { flow });
  await clickNav(page, primary(page));
  await snap(page, 'record-date-error', '录结果：没选日期就点下一步', { flow });
  await page.getByTestId('record-day').nth(3).click();
  await clickNav(page, primary(page));
  await snap(page, 'record-item-empty', '录结果：第 1 道', { flow });
  await page.getByTestId('completion-independent').click();
  await page.getByTestId('correct-yes').click();
  await snap(page, 'record-item-correct', '录结果：选了「独立做出」后「做对了吗？」浮上来', { flow });
  await clickNav(page, primary(page));
  await page.getByTestId('completion-hint1').click();
  await page.getByTestId('correct-yes').click();
  await clickNav(page, primary(page));
  await page.getByTestId('completion-not_solved').click();
  await page.locator('input[name=stuck]').fill('第二步移项');
  await snap(page, 'record-item-stuck', '录结果：最后一道选「没做出来」，「卡在哪一步？」', { flow });
  await clickNav(page, primary(page));
  await snap(page, 'results', '这次的结果（结果出来：头一句和几组依次浮上来）', { flow });
  await page.goto(`${WEB}/s/items`);
  await snap(page, 'items-weekB', '这周的错题（周末 B）', { flow: '随时可以看' });
  await page.goto(`${WEB}/s/photos`);
  await waitPrimary(page, /勾第|下一步：选这周要练的题/, 60_000).catch(() => {});
  await snap(page, 'photos-needs-pick', '勾出做错的题：这页没有批改痕迹，点这里勾出错题', { flow });
  const pickHref = (await page.locator('a[href^="/s/photos/"]').first().getAttribute('href'))!;
  await page.goto(`${WEB}${pickHref}`);
  await snap(page, 'pick', '勾选面板', { flow });
  await page.getByTestId('pick-candidate').nth(0).click();
  await page.getByTestId('pick-candidate').nth(2).click();
  await snap(page, 'pick-two', '勾选面板：勾了 2 道（主按钮的数字跟着变）', { flow, full: false });
  await clickNav(page, primary(page));
  await snap(page, 'photos-added', '勾出做错的题：「第 1 张：2 道加进错题本了 ✓」，那一行浮上来', { flow });
  await waitPrimary(page, '下一步：选这周要练的题', 60_000);
  await clickNav(page, primary(page));
  await snap(page, 'choose-weekB', '选这周要练的题（周末 B）', { flow });
  await clickNav(page, primary(page));
  await snap(page, 'why-intro-weekB', '说说为什么错（周末 B 开头）', { flow });
  await clickNav(page, primary(page));
  await page.getByTestId('voice-button').click();
  await expect(page.getByTestId('voice-button')).toHaveText('说完了');
  await sleep(1300);
  await snap(page, 'why-voice-listening', '说说为什么错：开着麦克风——音量条、计时、按钮「说完了」，底部主按钮「正在听你说…」先不能点', { flow, axe: false, full: false, widths: false });
  await fault('asr=hold');
  await page.getByTestId('voice-button').click();
  await expect(page.getByTestId('voice-note')).toContainText('正在转成文字');
  await sleep(2200);
  await snap(page, 'why-voice-transcribing', '说说为什么错：正在转成文字… 已经 N 秒（转写服务停住，故障注入）（状态矩阵）', { flow: '状态矩阵', axe: false, full: false, widths: false });
  await fault('asr=release');
  await page.waitForFunction(() => ((document.querySelector('#answer-text') as HTMLTextAreaElement | null)?.value.length ?? 0) > 0, null, { timeout: 15_000 });
  await snap(page, 'why-voice-done', '说说为什么错：语音转好了（文字浮上来；底部主按钮换回「说完了」）', { flow });
  await fault('asr=fail');
  await page.getByTestId('voice-button').click();
  await expect(page.getByTestId('voice-button')).toHaveText('说完了');
  await sleep(1200);
  await page.getByTestId('voice-button').click();
  await expect(page.getByTestId('voice-retry')).toBeVisible({ timeout: 15_000 });
  await snap(page, 'why-voice-transcribe-failed', '说说为什么错：转写失败——录音还在，「再转一次」用同一段；也可以直接打字（状态矩阵）', { flow: '状态矩阵', widths: false });
  await fault('asr=ok');
  await clickNav(page, primary(page));
  await clickNav(page, secondary(page, 'skipQuestion'));
  await page.getByText('现在做应该会').first().click();
  await clickNav(page, primary(page));
  await skipRemainingWhy(page);
  await clickNav(page, primary(page));
  await waitPrimary(page, '打印', 90_000);
  await snap(page, 'weekB-print-ready', '打印练习纸（周末 B）：就绪', { flow });
  await primary(page).click();
  await sleep(1000);
  await snap(page, 'weekB-print-after', '打印后（周末 B）', { flow });
  await clickNav(page, primary(page));
  await snap(page, 'today-weekB-done', '今天（周末 B 做完了）', { flow });

  // ---------- 做完以后又拍（G3）+ 识别失败（状态矩阵） ----------
  flow = '做完后又拍';
  await fault('vision=hold');
  await addPhoto(page, await synthetic('#f5d2c0', 760));
  await page.goto(`${WEB}/s/photos`);
  await sleep(2500);
  await snap(page, 'photos-after-done-finding', '做完以后又拍了一张、AI 正在找题：新题去哪（下个周末再选），主按钮「回到今天」；局部轮询', { flow });
  await fault('vision=release');
  await expect(page.locator('body')).not.toHaveAttribute('data-poll', /.*/, { timeout: 60_000 });
  await snap(page, 'photos-after-done', '做完以后又拍了一张、AI 找好了（「新拍的」小标签；主按钮「回到今天」）', { flow });
  await addPhoto(page, await synthetic('#c0cdf5', 760));
  await page.goto(`${WEB}/s/photos`);
  await expect(page.locator('body')).not.toHaveAttribute('data-poll', /.*/, { timeout: 60_000 });
  await snap(page, 'photos-after-done-needs-pick', '做完以后又拍了一张没批改的页：主按钮「勾第 n 张」，上面一行「回到今天」', { flow });
  await page.goto(`${WEB}/s/`);
  await snap(page, 'today-done-new-photos', '今天（做完了）+ 新拍的卷子要勾', { flow });
  await fault('vision=fail');
  await addPhoto(page, await synthetic('#f5d2c0', 760));
  await page.goto(`${WEB}/s/photos`);
  await expect(page.locator('body')).not.toHaveAttribute('data-poll', /.*/, { timeout: 60_000 });
  await snap(page, 'photos-recognition-failed', '勾出做错的题：这张没识别成功——「再试一次」「移除这张」（故障注入：模型输出不合法，可以重试）（状态矩阵）', { flow: '状态矩阵' });
  await fault('vision=unreadable');
  await addPhoto(page, await synthetic('#f5d2c0', 760));
  await page.goto(`${WEB}/s/photos`);
  await expect(page.locator('body')).not.toHaveAttribute('data-poll', /.*/, { timeout: 60_000 });
  await snap(page, 'photos-recognition-unreadable', '勾出做错的题：这张识别不了——「请重拍一张更清楚的」+「移除这张」（故障注入：照片读不出来，不能重试）（状态矩阵）', { flow: '状态矩阵' });
  await fault('reset=1');

  // ---------- 服务器忙：已连着（每台设备每分钟 300 次）、还没连上（配对失败 10 次）、连接过期（鉴权失败 30 次） ----------
  for (let i = 0; i < 320; i += 1) { if ((await page.request.get(`${WEB}/s/settings`)).status() === 429) break; }
  await page.goto(`${WEB}/s/`);
  await snap(page, 'busy-connected', '服务器有点忙（已连着：请求太频繁）——照片和错题都在，「设置」还在（状态矩阵）', { flow: '状态矩阵' });
  const busy = await browser.newContext(DEVICE);
  await observe(busy);
  const bp = await busy.newPage();
  let busyHit = false;
  for (let i = 0; i < 14 && !busyHit; i += 1) {
    await bp.goto(`${WEB}/s/`);
    await bp.locator('#connect-link').fill('https://example.invalid/s/pair?code=nope');
    await clickNav(bp, primary(bp));
    busyHit = (await bp.locator('h1').innerText()) === '服务器有点忙';
  }
  if (busyHit) await snap(bp, 'busy', '服务器有点忙（还没连上：连接失败太多次）——「等一会儿再试；还是不行，请大人给一个新的二维码或链接」（状态矩阵）', { flow: '状态矩阵' });
  let expiredStatus = 0;
  for (let i = 0; i < 40 && expiredStatus !== 429; i += 1) {
    await expired.addCookies([{ name: 'sel_device', value: 'expired-or-revoked-token', url: `${WEB}/s/` }]);
    expiredStatus = (await ep.goto(`${WEB}/s/`))!.status();
  }
  if (expiredStatus === 429) await snap(ep, 'busy-expired', '服务器有点忙（连接过期：cookie 无效、鉴权失败太多次）——不说「还没连上」（状态矩阵）', { flow: '状态矩阵' });
  await busy.close();
  await expired.close();
  await stranger.close();

  records.sort((a, b) => Number(a.id) - Number(b.id));
  writeJson('metrics.json', { generatedAt: new Date().toISOString(), script: 'tests/e2e/qualityEvidence.spec.ts（R1 capture.mjs 搬进仓库并扩展）', firstRunPairToTodayMs: firstRunMs, totalMs: Date.now() - t0, consoleErrors, tokens, motion, records });
  writeJson('axe.json', records.filter(r => r.axeLight !== undefined).map(r => ({ id: r.id, name: r.name, light: r.axeLight, darkContrast: r.axeDarkContrast })));
  log('done', records.length, 'records; console errors', consoleErrors.length);
  await ctx.close();
});

/** 模拟麦克风：一段忽大忽小的 220 Hz 声音（合成的，没有人声），让音量条在截图里看得出在动。 */
async function mockMicrophone(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const ac = new AudioContext();
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.frequency.value = 220;
      gain.gain.setValueAtTime(0.2, ac.currentTime);
      for (let t = 0; t < 60; t += 0.6) { gain.gain.linearRampToValueAtTime(0.7, ac.currentTime + t + 0.3); gain.gain.linearRampToValueAtTime(0.15, ac.currentTime + t + 0.6); }
      osc.connect(gain);
      const destination = ac.createMediaStreamDestination();
      gain.connect(destination);
      osc.start();
      return destination.stream;
    };
  });
}

/** 动效期间的帧率与长任务：CPU 4 倍降速，「今天」清单从「选题」那一步变成「说说为什么错」时（打勾 ✓ 弹出、下一步浮上来），数 600 ms 里的帧。 */
async function motionProbe(page: Page): Promise<unknown> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  // 让「上一次看到的清单」停在选题那一步，再打开今天：打勾和挪到下一步的动效都会放。
  await page.evaluate(() => sessionStorage.setItem('sel-today', JSON.stringify({ stage: 'weekendA', done: ['shoot', 'pick'], cur: 'choose' })));
  await page.addInitScript(() => {
    const w = window as unknown as { __frames: number[]; __anims: string[] };
    w.__frames = []; w.__anims = [];
    addEventListener('animationstart', e => { w.__anims.push(`${(e.target as Element).className}:${e.animationName}`); }, true);
    const tick = (t: number): void => { w.__frames.push(t); if (t < 1500) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await page.goto(`${WEB}/s/`);
  await sleep(1800);
  const result = await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __long: number[]; __anims: string[] };
    const animated = w.__anims;
    const frames = w.__frames.filter(t => t > 0);
    const start = frames[0] ?? 0;
    const inWindow = frames.filter(t => t - start <= 600);
    const gaps = inWindow.slice(1).map((t, i) => t - inWindow[i]!);
    return { framesIn600ms: inWindow.length, fps: Math.round((inWindow.length - 1) / ((inWindow.at(-1)! - start) / 1000)), worstFrameMs: Math.round(Math.max(0, ...gaps)), longTasksMs: w.__long, animated };
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await cdp.detach();
  log('motion', JSON.stringify(result));
  return { method: 'Chromium 无头，CPU 4× 降速；「今天」清单从「选题」变成「说说为什么错」时放打勾 / 浮上来的动效，数载入后 600 ms 内的 requestAnimationFrame 帧与长任务', ...result };
}

/** 练习纸 A4：Chromium print 媒体，794×1123 CSS px，2×；PDF + 每页图 + 几项尺寸。 */
async function sheetA4(browser: Browser, ctx: BrowserContext, sheetHref: string, flow: string): Promise<void> {
  const a4 = await browser.newContext({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 2, storageState: await ctx.storageState(), bypassCSP: true });
  const ap = await a4.newPage();
  await ap.goto(`${WEB}${sheetHref}`, { waitUntil: 'load' });
  await ap.emulateMedia({ media: 'print' });
  await sleep(500);
  const a4id = idOf('sheet-a4-print');
  await ap.screenshot({ path: `${OUT}/${a4id}-sheet-a4-print.jpg`, type: 'jpeg', quality: 80, fullPage: true });
  await ap.pdf({ path: `${OUT}/${a4id}-sheet-a4.pdf`, format: 'A4', printBackground: true });
  const pagesId = idOf('sheet-a4-pages');
  const pageShots: string[] = [];
  const pageEls = await ap.locator('.sheet .page').all();
  for (let i = 0; i < pageEls.length; i += 1) { const f = `${pagesId}-sheet-a4-page${i + 1}.png`; await pageEls[i]!.screenshot({ path: `${OUT}/${f}` }); pageShots.push(f); }
  const metrics = await ap.evaluate(() => ({
    pages: document.querySelectorAll('.sheet .page').length, height: document.documentElement.scrollHeight,
    visibleOutsideSheet: [...document.querySelectorAll('body *')].filter(el => !el.closest('.sheet') && !el.contains(document.querySelector('.sheet')) && (el as HTMLElement).offsetWidth > 0).length,
    pageRects: [...document.querySelectorAll('.sheet .page')].map(p => { const r = p.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; }),
  }));
  records.push({ id: a4id, name: 'sheet-a4-print', desc: '练习纸 A4 打印渲染（print 媒体，794×1123 CSS px，2×）+ 同名 PDF + 每页 2× 渲染图（纸面不变，见 sheet-compare.json）', flow, files: { full: `${a4id}-sheet-a4-print.jpg`, pdf: `${a4id}-sheet-a4.pdf`, pages: pageShots }, metrics });
  log('sheet', JSON.stringify(metrics));
  await a4.close();
}

// =====================================================================================================
// webkit：WebKit（Safari 的内核）下的 200% 放大，走一遍周末 A 的主流程
// =====================================================================================================
test('webkit：200% 放大走主流程（页面缩放 200% 与只放大文字 200% 两种）', async () => {
  test.skip(PART !== 'webkit', 'SEL_EVIDENCE=webkit');
  test.setTimeout(20 * 60_000);
  fs.mkdirSync(`${OUT}/webkit200`, { recursive: true });
  const wk = await webkit.launch();
  const modes: Array<{ mode: string; desc: string; options: BrowserContextOptions; textOnly: boolean }> = [
    // Safari「aA」里把字放到 200% 是整页缩放：CSS 像素翻倍，390 pt 宽的屏幕上只剩 195 个 CSS 像素宽（截图仍是 1170 px 宽，和手机上看到的一样）。
    { mode: 'zoom', desc: '页面缩放 200%（Safari「aA」的放大方式：视口 195×422 CSS px，6 倍屏）', options: { viewport: { width: 195, height: 422 }, deviceScaleFactor: 6, isMobile: true, hasTouch: true, userAgent: IPHONE_SAFARI, locale: 'zh-CN' }, textOnly: false },
    // 只放大文字（WCAG 1.4.4 的 200%）：根字号 200%，字阶都是 rem，跟着放大；布局宽度不变。
    { mode: 'text', desc: '只放大文字 200%（根字号 200%，视口 390×844）', options: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IPHONE_SAFARI, locale: 'zh-CN' }, textOnly: true },
  ];
  const results: unknown[] = [];
  for (const { mode, desc, options, textOnly } of modes) {
    const context = await wk.newContext({ ...options, bypassCSP: true });
    if (textOnly) await context.addInitScript(() => { document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = 'html{font-size:200%!important}'; document.head.appendChild(s); }); });
    await context.addInitScript(() => { window.print = () => { window.dispatchEvent(new Event('afterprint')); }; });
    const page = await context.newPage();
    const screens: unknown[] = [];
    let n = 0;
    const check = async (name: string): Promise<void> => {
      await settle(page);
      n += 1;
      const file = `webkit200/${mode}-${String(n).padStart(2, '0')}-${name}.jpg`;
      await page.screenshot({ path: `${OUT}/${file}`, type: 'jpeg', quality: 78 });
      const m = await page.evaluate(() => {
        const vis = (el: Element) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
        // 文字被截断：元素内容比框宽 / 高，而且溢出被藏起来（练习纸预览的画框本来就是缩略，不算）。
        const clipped = [...document.querySelectorAll('main *, .next-bar *')].filter(el => {
          if (!vis(el) || el.closest('.sheet') || el.closest('.sheet-frame') || el.matches('img, input, textarea, select, .visually-hidden') || el.closest('.visually-hidden')) return false;
          const cs = getComputedStyle(el); const hidden = cs.overflowX === 'hidden' || cs.overflowY === 'hidden' || cs.overflow === 'hidden' || cs.textOverflow === 'ellipsis' || cs.webkitLineClamp !== 'none';
          return hidden && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) && (el.textContent ?? '').trim() !== '';
        }).map(el => `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}「${(el.textContent ?? '').trim().slice(0, 16)}」`);
        const bar = document.querySelector('.next-bar');
        const p = document.querySelector('[data-testid=next-step-primary]');
        const pr = p && vis(p) ? p.getBoundingClientRect() : null;
        return {
          url: location.pathname.replace(/pkt_[0-9a-f]+/, 'pkt_…').replace(/itm_[0-9a-f]+/, 'itm_…'),
          viewport: `${innerWidth}×${innerHeight}`, rootFontPx: parseFloat(getComputedStyle(document.documentElement).fontSize),
          horizontalOverflowPx: Math.max(0, document.documentElement.scrollWidth - innerWidth),
          clipped, barHeightPx: bar ? Math.round(bar.getBoundingClientRect().height) : 0, barShareOfViewport: bar ? Math.round(bar.getBoundingClientRect().height / innerHeight * 100) / 100 : 0,
          primary: p ? (p as HTMLElement).innerText.trim() : null, primaryFullyVisible: pr ? pr.top >= 0 && pr.bottom <= innerHeight + 1 : null,
          bodyPadBottom: parseFloat(getComputedStyle(document.body).paddingBottom),
        };
      });
      screens.push({ n, name, file, ...m });
      log('webkit', mode, n, name, JSON.stringify(m).slice(0, 220));
    };
    const link = await pairingLink();
    await page.goto(link);
    await check('pair-confirm');
    await clickNav(page, primary(page));
    await check('today-first');
    await clickNav(page, primary(page));
    await check('consent');
    await clickNav(page, primary(page));
    await check('capture-empty');
    await page.locator('#camera-input').setInputFiles({ name: 'page.jpg', mimeType: 'image/jpeg', buffer: await synthetic(mode === 'zoom' ? '#f2cfc6' : '#efc8c0', 900) });
    await expect(page.getByTestId('photo-tile')).toHaveCount(1, { timeout: 30_000 });
    await check('capture-one');
    await page.goto(`${WEB}/s/photos`);
    await waitPrimary(page, '下一步：选这周要练的题', 60_000);
    await check('photos-found');
    await clickNav(page, primary(page));
    await check('choose');
    await clickNav(page, primary(page));
    await check('why-intro');
    await clickNav(page, primary(page));
    await check('why-ask');
    await clickNav(page, secondary(page, 'skipQuestion'));
    await check('why-confirm');
    await page.getByText('现在做应该会').first().click();
    await clickNav(page, primary(page));
    await skipRemainingWhy(page);
    await check('why-done');
    await clickNav(page, primary(page));
    await waitPrimary(page, '打印', 90_000);
    await check('print-ready');
    await primary(page).click();
    await sleep(900);
    await check('print-after');
    await clickNav(page, primary(page));
    await check('today-done');
    results.push({ mode, desc, browser: `WebKit ${wk.version()}`, screens });
    await context.close();
    // 第二种模式要一份新的「这周」：往后挪一周再走（同一台服务器，数据接着用）。
    await timeTravel(7);
  }
  writeJson('webkit-200.json', { generatedAt: new Date().toISOString(), note: 'Playwright 自带的 WebKit（不是真机 Safari）；读屏（VoiceOver）没有在这里测，要真机', results });
  await wk.close();
});

// =====================================================================================================
// video：周末 A、周末 B 的录屏（动效要看得见）+ 减少动态效果的周末 A + 一对「同一时刻」的截图
// =====================================================================================================
test('video：周末 A / B 录屏，减少动态效果的录屏与截图对照', async ({ browser }) => {
  test.skip(PART !== 'video' && PART !== 'video-reduced', 'SEL_EVIDENCE=video 或 video-reduced');
  const reducedOnly = PART === 'video-reduced';
  test.setTimeout(20 * 60_000);
  const TMP = `${OUT}/_video_tmp`;
  fs.mkdirSync(TMP, { recursive: true });
  const videoDevice: BrowserContextOptions = { ...DEVICE, deviceScaleFactor: 2, bypassCSP: false };
  async function record(name: string, options: BrowserContextOptions, run: (page: Page, ctx: BrowserContext) => Promise<void>): Promise<void> {
    const ctx = await browser.newContext({ ...videoDevice, ...options, recordVideo: { dir: TMP, size: { width: 390, height: 844 } } });
    await ctx.addInitScript(() => { window.print = () => { window.dispatchEvent(new Event('afterprint')); }; });
    const page = await ctx.newPage();
    try { await run(page, ctx); } finally {
      const video = page.video();
      await ctx.close();
      if (video) fs.renameSync(await video.path(), `${OUT}/${name}.webm`);
    }
  }
  const tap = async (page: Page, locator: ReturnType<Page['locator']>, pause = 900): Promise<void> => { await sleep(pause); await locator.click({ timeout: 20_000 }); await page.waitForLoadState('load').catch(() => {}); };
  /** 周末 A：只按底部按钮；中途回一次「今天」看打勾与挪到下一步；找题时 AI 停 6 秒，看等待与局部更新。 */
  const weekA = async (page: Page): Promise<void> => {
    await page.goto(await pairingLink());
    await tap(page, primary(page));                       // 连接这台手机
    await sleep(1200);
    await tap(page, primary(page));                       // 拍第一页
    await tap(page, primary(page));                       // 同意，上传
    await fault('vision=hold');
    await sleep(800);
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), primary(page).click()]);
    await chooser.setFiles({ name: 'page.jpg', mimeType: 'image/jpeg', buffer: await synthetic('#f2cfc6', 900) });
    await page.getByTestId('photo-count').waitFor({ timeout: 20_000 });
    await tap(page, primary(page));                       // 拍完了，下一步 → 勾出做错的题（AI 在找）
    await sleep(6000);
    await fault('vision=release');
    await waitPrimary(page, /^下一步：选这周要练的题$/);    // 局部更新：这一行和底栏换上来
    await sleep(1500);
    await tap(page, page.getByTestId('back-link'));       // 回今天：第 2 步打勾，第 3 步浮上来
    await sleep(1800);
    await tap(page, primary(page));                       // 选这周要练的题
    await sleep(600); await page.locator('input[name=itemIds]').first().uncheck({ force: true }); await sleep(900); await page.locator('input[name=itemIds]').first().check({ force: true });
    await tap(page, primary(page));                       // 就练这 3 道
    await tap(page, secondary(page, 'skipWhy'));          // 跳过，直接打印
    await waitPrimary(page, /^打印$/, 90_000);
    await sleep(1200);
    await page.mouse.wheel(0, 900); await sleep(900);
    await page.getByTestId('sheet-toggle').click(); await sleep(1500);
    await page.mouse.wheel(0, -2000); await sleep(800);
    await primary(page).click();                          // 打印
    await sleep(1500);
    await tap(page, primary(page));                       // 打印好了，回到今天：做完了的卡片浮上来、✓ 弹出
    await sleep(2200);
  };
  // 减少动态效果的周末 A 要一台干净的服务器（单独跑：SEL_EVIDENCE=video-reduced）。
  if (reducedOnly) {
    await record('video-weekA-reduced-motion', { reducedMotion: 'reduce' }, async page => { await weekA(page); });
    fs.rmSync(TMP, { recursive: true, force: true });
    return;
  }
  let state: Awaited<ReturnType<BrowserContext['storageState']>> | null = null;
  await record('video-weekA', {}, async (page, ctx) => { await weekA(page); state = await ctx.storageState(); });
  await timeTravel(7);
  await record('video-weekB', {}, async page => {
    await page.context().addCookies(state!.cookies);
    await page.goto(`${WEB}/s/`);
    await sleep(1200);
    await tap(page, primary(page));                       // 拍第一页
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), primary(page).click()]);
    await chooser.setFiles({ name: 'page.jpg', mimeType: 'image/jpeg', buffer: await synthetic('#c6cff2', 820) });
    await page.getByTestId('photo-count').waitFor({ timeout: 20_000 });
    await tap(page, primary(page));                       // 拍完了，下一步 → 录结果
    await sleep(700); await page.getByTestId('record-day').nth(3).click();
    await tap(page, primary(page));
    for (const [completion, correct] of [['independent', true], ['hint1', true], ['not_solved', false]] as const) {
      await sleep(700); await page.getByTestId(`completion-${completion}`).click();
      if (correct) { await sleep(600); await page.getByTestId('correct-yes').click(); }
      await tap(page, primary(page));
    }
    await sleep(2200);                                    // 这次的结果：几组依次浮上来
    await waitPrimary(page, /^下一步：勾出做错的题$/);
    await tap(page, primary(page));
    await sleep(600); await page.getByTestId('pick-candidate').nth(0).click();
    await sleep(500); await page.getByTestId('pick-candidate').nth(2).click();
    await tap(page, primary(page));                       // 把这 2 道加入错题本 →「2 道加进错题本了」
    await sleep(1500);
    await waitPrimary(page, /^下一步：选这周要练的题$/);
    await tap(page, primary(page));
    await tap(page, primary(page));                       // 就练这 n 道
    await tap(page, primary(page));                       // 开始
    await sleep(700); await page.getByTestId('voice-button').click();
    await expect(page.getByTestId('voice-button')).toHaveText('说完了');
    await sleep(2600);                                    // 音量条、计时
    await page.getByTestId('voice-button').click();
    await page.waitForFunction(() => ((document.querySelector('#answer-text') as HTMLTextAreaElement | null)?.value.length ?? 0) > 0, null, { timeout: 20_000 });
    await sleep(1200);
    await tap(page, primary(page));                       // 说完了
    await tap(page, secondary(page, 'skipQuestion'));
    await sleep(700); await page.getByText('现在做应该会').first().click();
    await sleep(900);
    await tap(page, primary(page));
    for (let guard = 0; guard < 12 && /\/s\/why\/pkt_[0-9a-f]+\/itm_/.test(page.url()); guard += 1) {
      await tap(page, page.url().endsWith('/confirm') ? secondary(page, 'pass') : secondary(page, 'skipQuestion'), 500);
    }
    await sleep(1200);
    await tap(page, primary(page));                       // 下一步：打印练习纸
    await waitPrimary(page, /^打印$/, 90_000);
    await sleep(1000); await primary(page).click();
    await sleep(1500);
    await tap(page, primary(page));                       // 打印好了，回到今天
    await sleep(2200);
  });
  fs.rmSync(TMP, { recursive: true, force: true });

  // 同一时刻的一对截图：「今天」从「选题」变成「说说为什么错」后 120 ms。不减少时 ✓ 正在弹出、那一行正在浮上来；减少时直接是最后的样子。
  const pair: Record<string, string> = {};
  for (const reducedMotion of ['no-preference', 'reduce'] as const) {
    const ctx = await browser.newContext({ ...DEVICE, reducedMotion });
    await ctx.addCookies(state!.cookies);
    const page = await ctx.newPage();
    await page.goto(`${WEB}/s/`);
    await page.evaluate(() => sessionStorage.setItem('sel-today', JSON.stringify({ stage: 'weekendA', done: ['shoot', 'pick'], cur: 'choose' })));
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Animation.enable');
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.1 });
    await page.goto(`${WEB}/s/`, { waitUntil: 'load' });
    await sleep(120);
    const file = `motion-pair-${reducedMotion}.jpg`;
    await page.screenshot({ path: `${OUT}/${file}`, type: 'jpeg', quality: 80 });
    pair[reducedMotion] = `${file}：${await page.evaluate(() => document.getAnimations().map(a => `${(a as CSSAnimation).animationName}@${Math.round(Number(a.currentTime))}ms`).join('、') || '没有动画')}`;
    await ctx.close();
  }
  writeJson('motion-pair.json', { note: '同一份「今天」（上一次看到的清单停在「选题」），载入后 120 ms 截图；动画放慢 10 倍便于看清。周末 A 当时那一份练习已经做完，所以这里看到的是做完了的卡片', pair });
});

// =====================================================================================================
// perf：冷加载（同 round 0 / R1 的方法：无 SW、禁用缓存、150 ms RTT、1.6 Mbps / 750 kbps、CPU 4×、导航请求再加 600 ms，每项 3 次取中位数）
// =====================================================================================================
test('perf：冷加载 11 个路由', async ({ browser }) => {
  test.skip(PART !== 'perf', 'SEL_EVIDENCE=perf');
  test.setTimeout(30 * 60_000);
  // 先造一份数据：周末 A 做完（练习 1 打好），过一周录结果，再选一份新的（练习 2 打好）。
  const ctx = await browser.newContext(DEVICE);
  const page = await ctx.newPage();
  await page.goto(await pairingLink());
  await clickNav(page, primary(page));
  const state0 = await ctx.storageState();
  const flowOnce = async (color: string): Promise<void> => {
    await page.goto(`${WEB}/s/capture`);
    if (await page.getByText('上传前看一下').count()) await clickNav(page, primary(page));
    await page.locator('#camera-input').setInputFiles({ name: 'page.jpg', mimeType: 'image/jpeg', buffer: await synthetic(color, 900) });
    await expect(page.getByTestId('photo-tile').first()).toBeVisible({ timeout: 30_000 });
    await page.goto(`${WEB}/s/choose`);
    for (let i = 0; i < 60 && !(await page.locator('#choose-form').count()); i += 1) { await sleep(1000); await page.reload(); }
    await clickNav(page, primary(page));
    await clickNav(page, secondary(page, 'skipWhy'));
    await waitPrimary(page, '打印', 90_000);
  };
  await flowOnce('#f2cfc6');
  await timeTravel(7);
  await page.goto(`${WEB}/s/practices`);
  await clickNav(page, page.getByTestId('practice-row').first());
  await page.getByTestId('record-day').last().click();
  await clickNav(page, primary(page));
  for (let guard = 0; guard < 9 && /\/s\/record\//.test(page.url()); guard += 1) { await page.getByTestId('completion-not_done').click(); await clickNav(page, primary(page)); }
  await flowOnce('#efc6be');
  await page.goto(`${WEB}/s/practices`);
  const hrefs = await page.locator('[data-testid=practice-row]').evaluateAll(as => as.map(a => a.getAttribute('href') ?? ''));
  const resultsHref = hrefs.find(h => h.startsWith('/s/results/'));
  const pids = [...new Set(hrefs.map(h => /pkt_[0-9a-f]+/.exec(h)?.[0]).filter((x): x is string => Boolean(x)))];
  await page.goto(`${WEB}/s/items`);
  const itemHref = await page.getByTestId('item-card').first().getAttribute('href');
  const state = await ctx.storageState();
  await ctx.close();
  void state0;
  const targets: Array<[string, string | null | undefined, boolean]> = [
    ['connect (未配对)', '/s/', false], ['今天', '/s/', true], ['拍卷子', '/s/capture', true], ['勾出做错的题', '/s/photos', true], ['这周的错题', '/s/items', true],
    ['题目详情', itemHref, true], ['选题', '/s/choose', true], ['这次的结果', resultsHref, true], ['打印（就绪）', `/s/print/${pids[0]}`, true],
    ['练习纸单独页', `/s/print/${pids[0]}/sheet`, true], ['设置', '/s/settings', true],
  ];
  const NAV_DELAY_MS = 600;
  async function measure(url: string, authed: boolean, throttle: boolean): Promise<Record<string, any>> {
    const c = await browser.newContext({ ...DEVICE, ...(authed ? { storageState: state } : {}), serviceWorkers: 'block' });
    const p = await c.newPage();
    await p.addInitScript(() => {
      const w = window as unknown as { __perf: { lcp: number; lcpEl: string; cls: number; tbt: number; longtasks: number } };
      w.__perf = { lcp: 0, lcpEl: '', cls: 0, tbt: 0, longtasks: 0 };
      try { new PerformanceObserver(l => { for (const e of l.getEntries() as Array<PerformanceEntry & { element?: Element; url?: string }>) { w.__perf.lcp = e.startTime; w.__perf.lcpEl = (e.element?.tagName || '') + (e.element?.className ? '.' + e.element.className : '') + ' ' + ((e.element as HTMLElement | undefined)?.innerText || e.url || '').slice(0, 24); } }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch { /* */ }
      try { new PerformanceObserver(l => { for (const e of l.getEntries() as Array<PerformanceEntry & { hadRecentInput: boolean; value: number }>) if (!e.hadRecentInput) w.__perf.cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); } catch { /* */ }
      try { new PerformanceObserver(l => { for (const e of l.getEntries()) { w.__perf.longtasks += 1; w.__perf.tbt += Math.max(0, e.duration - 50); } }).observe({ type: 'longtask', buffered: true }); } catch { /* */ }
    });
    const cdp = await c.newCDPSession(p);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    if (throttle) {
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8 });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await p.route(`${WEB}${url}`, async route => { if (route.request().isNavigationRequest()) await sleep(NAV_DELAY_MS); await route.continue(); });
    }
    await p.goto(`${WEB}${url}`, { waitUntil: 'load', timeout: 60_000 });
    await sleep(1200);
    const r = await p.evaluate(() => {
      const w = window as unknown as { __perf: { lcp: number; lcpEl: string; cls: number; tbt: number; longtasks: number } };
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
      const fcp = performance.getEntriesByName('first-contentful-paint')[0];
      const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      const kinds: Record<string, number> = {};
      for (const e of res) { const k = e.name.includes('/img/') ? 'img' : /\.css(\?|$)/.test(e.name) ? 'css' : /\.js(\?|$)/.test(e.name) ? 'js' : 'other'; kinds[k] = (kinds[k] || 0) + (e.encodedBodySize || 0); }
      return {
        ttfb: Math.round(nav.responseStart), fcp: fcp ? Math.round(fcp.startTime) : null, lcp: Math.round(w.__perf.lcp), lcpEl: w.__perf.lcpEl,
        load: Math.round(nav.loadEventEnd), cls: Number(w.__perf.cls.toFixed(4)), tbt: Math.round(w.__perf.tbt), longtasks: w.__perf.longtasks,
        requests: res.length + 1, htmlBytes: nav.encodedBodySize, bytesByKind: kinds, totalBytes: res.reduce((s, e) => s + (e.encodedBodySize || 0), 0) + nav.encodedBodySize,
        dom: document.getElementsByTagName('*').length, resources: [location.href, ...res.map(e => e.name)],
      };
    });
    await c.close();
    return r;
  }
  /** 文字类资源（页面、样式、脚本）gzip 以后多大：生产开了压缩（deploy: 那个提交）以后实际下发的大小。 */
  async function gzipBytes(urls: string[], authed: boolean): Promise<{ text: number; gzip: number }> {
    const c = await browser.newContext({ ...DEVICE, ...(authed ? { storageState: state } : {}) });
    let text = 0; let gzip = 0;
    for (const u of urls) {
      if (/\/img\//.test(u) || /\.png$/.test(u)) continue;
      const body = Buffer.from(await (await c.request.get(u)).body());
      text += body.length; gzip += zlib.gzipSync(body, { level: 6 }).length;
    }
    await c.close();
    return { text, gzip };
  }
  const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
  const perf: unknown[] = [];
  for (const [label, url, authed] of targets) {
    if (!url) continue;
    for (const throttle of [true, false]) {
      const runs: Array<Record<string, any>> = [];
      for (let i = 0; i < 3; i += 1) runs.push(await measure(url, authed, throttle));
      const pick = (k: string): number => median(runs.map(r => r[k] ?? 0));
      const gz = throttle ? await gzipBytes(runs[0]!.resources as string[], authed) : null;
      const row = { label, url: url.replace(/pkt_[0-9a-f]+/, 'pkt_…').replace(/itm_[0-9a-f]+/, 'itm_…'), throttle, ttfb: pick('ttfb'), fcp: pick('fcp'), lcp: pick('lcp'), load: pick('load'), cls: Math.max(...runs.map(r => r.cls as number)), tbt: pick('tbt'), requests: runs[0]!.requests, htmlBytes: runs[0]!.htmlBytes, totalBytes: runs[0]!.totalBytes, bytesByKind: runs[0]!.bytesByKind, textBytes: gz?.text ?? null, textGzipBytes: gz?.gzip ?? null, dom: runs[0]!.dom, lcpEl: runs[0]!.lcpEl };
      perf.push(row);
      log(label, throttle ? 'slow4G+4xCPU' : 'local', 'FCP', row.fcp, 'LCP', row.lcp, 'CLS', row.cls, 'TBT', row.tbt, 'bytes', row.totalBytes, 'gzip text', row.textGzipBytes);
    }
  }
  writeJson(process.env.SEL_EVIDENCE_PERF_FILE ?? 'perf-after.json', { generatedAt: new Date().toISOString(), web: WEB, method: 'round 0 / R1 同一方法（Playwright + Chromium headless；冷加载 serviceWorkers=block、禁用缓存；CDP 150ms RTT、1.6Mbps/750kbps、CPU 4x；每项 3 次取中位数；本机合成服务器，无 TLS；应用本身不压缩），导航请求在发出前再延迟 600 ms（建连 3 RTT + 请求 1 RTT）。textGzipBytes = 页面、样式、脚本按 gzip -6 压缩后的字节（生产开了 Caddy 压缩以后的大小；没开时按 totalBytes）', perf });
});

// =====================================================================================================
// sheet：同一份合成数据走到练习纸，出 A4 PDF 和每页图（拿基线版本的服务器再跑一次，逐像素比纸面有没有变）
// =====================================================================================================
test('sheet：练习纸 A4（用来和基线逐像素比较）', async ({ browser }) => {
  test.skip(PART !== 'sheet', 'SEL_EVIDENCE=sheet');
  test.setTimeout(10 * 60_000);
  const tag = process.env.SEL_EVIDENCE_SHEET_TAG ?? 'after';
  fs.mkdirSync(`${OUT}/sheet-compare`, { recursive: true });
  const ctx = await browser.newContext(DEVICE);
  const page = await ctx.newPage();
  await page.goto(await pairingLink());
  await clickNav(page, primary(page));
  await page.goto(`${WEB}/s/capture`);
  await clickNav(page, primary(page)); // 同意，上传
  await page.locator('#camera-input').setInputFiles({ name: 'page.jpg', mimeType: 'image/jpeg', buffer: await synthetic('#f2cfc6', 900) });
  await expect(page.getByTestId('photo-tile')).toHaveCount(1, { timeout: 30_000 });
  await page.goto(`${WEB}/s/choose`);
  for (let i = 0; i < 60 && !(await page.locator('#choose-form').count()); i += 1) { await sleep(1000); await page.reload(); }
  await clickNav(page, primary(page));
  await clickNav(page, secondary(page, 'skipWhy'));
  await waitPrimary(page, '打印', 90_000);
  const sheetHref = new URL(page.url()).pathname + '/sheet';
  const a4 = await browser.newContext({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 2, storageState: await ctx.storageState() });
  const ap = await a4.newPage();
  await ap.goto(`${WEB}${sheetHref}`, { waitUntil: 'load' });
  await ap.emulateMedia({ media: 'print' });
  await sleep(600);
  await ap.pdf({ path: `${OUT}/sheet-compare/${tag}.pdf`, format: 'A4', printBackground: true });
  // 整张打印渲染（print 媒体下页面上只剩纸）。
  await ap.screenshot({ path: `${OUT}/sheet-compare/${tag}-print.png`, fullPage: true });
  await a4.close();
  await ctx.close();
});
