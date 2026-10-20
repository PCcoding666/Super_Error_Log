/** Runs in its own process, with a clean temporary cwd, for ONE checkout. */
import { createElement } from 'react';
import type { ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { cards, FIXTURE_DATE, FIXTURE_WEEK, items, photo, SCENARIOS } from './fixtures.js';

const [sourceArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !outputArg) throw new Error('Internal usage: export.ts SOURCE OUT');
const source = resolve(sourceArg), output = resolve(outputArg);
const load = (file: string) => import(pathToFileURL(join(source, file)).href);
const [today, photos, itemViews, practice, login, assets, weekPlan] = await Promise.all([
  load('src/web/views/today.tsx'), load('src/web/views/photos.tsx'), load('src/web/views/items.tsx'),
  load('src/web/views/practice.tsx'), load('src/studentHost/loginView.tsx'), load('src/web/assets.ts'), load('src/web/weekPlan.ts'),
]);
const bar = { caption: '本周合成示例 · 约 1 分钟', primary: { title: '选这周要练的题', key: 'choose', href: '/s/choose' }, secondary: [{ title: '再拍一页', key: 'capture', href: '/s/capture' }] };
const plan = weekPlan.make(weekPlan.makeInput({ weekKey: FIXTURE_WEEK, today: new Date(FIXTURE_DATE), weekPhotoJobIDs: ['demo-photo'], weekItemCount: items.length, localPhotos: [{ number: 1, taskID: 'demo-photo', jobID: 'demo-photo', state: 'needsPick' }] }));
type Props = {
  login: Parameters<typeof import('../../src/studentHost/loginView.js').LoginPage>[0];
  today: Parameters<typeof import('../../src/web/views/today.js').TodayPage>[0];
  capture: Parameters<typeof import('../../src/web/views/photos.js').CapturePage>[0];
  photos: Parameters<typeof import('../../src/web/views/photos.js').PhotosPage>[0];
  pick: Parameters<typeof import('../../src/web/views/photos.js').PickPage>[0];
  items: Parameters<typeof import('../../src/web/views/items.js').ItemsPage>[0];
  practices: Parameters<typeof import('../../src/web/views/practice.js').PracticesPage>[0];
  item: Parameters<typeof import('../../src/web/views/items.js').ItemDetailPage>[0];
  choose: Parameters<typeof import('../../src/web/views/practice.js').ChoosePage>[0];
  why: Parameters<typeof import('../../src/web/views/practice.js').WhyAskPage>[0];
  confirm: Parameters<typeof import('../../src/web/views/practice.js').WhyConfirmPage>[0];
  settings: Parameters<typeof import('../../src/web/views/practice.js').SettingsPage>[0];
  install: Record<string, never>;
};
const scenes: { [K in keyof Props]: [ComponentType<Props[K]>, Props[K], string] } = {
  login: [login.LoginPage, {}, 'src/studentHost/loginView.tsx#LoginPage'],
  today: [today.TodayPage, { state: { plan, week: { week: FIXTURE_WEEK, photos: [], items, backlog: [] }, photos: [photo], practices: [], latestDetail: null, preparingPrintID: null, marks: { pickDone: new Set(), dismissed: new Set() }, skips: { steps: new Set(), passedItems: new Set() } }, practiceSlot: '周三晚自习', showInstallHint: true }, 'src/web/views/today.tsx#TodayPage'],
  capture: [photos.CapturePage, { photos: [], next: { title: '勾出错题', href: '/s/photos' }, caption: '拍完以后，看看有哪些错题' }, 'src/web/views/photos.tsx#CapturePage'],
  photos: [photos.PhotosPage, { photos: [photo, { ...photo, jobId: 'demo-finding', number: 2, state: 'finding', job: null }], bar, refresh: true, itemCount: items.length }, 'src/web/views/photos.tsx#PhotosPage'],
  pick: [photos.PickPage, { photo }, 'src/web/views/photos.tsx#PickPage'],
  items: [itemViews.ItemsPage, { items, backlog: [], anyPhoto: true, finding: false, bar }, 'src/web/views/items.tsx#ItemsPage'],
  practices: [practice.PracticesPage, { practices: [] }, 'src/web/views/practice.tsx#PracticesPage'],
  item: [itemViews.ItemDetailPage, { item: items[0]!, evidence: null, canDiscard: true, reflected: false }, 'src/web/views/items.tsx#ItemDetailPage'],
  choose: [practice.ChoosePage, { recommend: { recommended: cards.slice(0, 2), others: cards.slice(2), notes: ['合成示例：建议先练这两道题。'], limits: { min: 1, max: 8 } }, practiceSlot: '周三晚自习', caption: '选完以后，说说为什么错' }, 'src/web/views/practice.tsx#ChoosePage'],
  why: [practice.WhyAskPage, { practiceId: 'demo-practice', card: cards[0]!, index: 0, total: 2, turns: [{ turn: 1, source: 'ai', question: '从 3x − 6 = 12 到下一行，你是怎样移项的？', answer: null }], answer: '' }, 'src/web/views/practice.tsx#WhyAskPage'],
  confirm: [practice.WhyConfirmPage, { practiceId: 'demo-practice', card: cards[0]!, index: 0, total: 2, last: false, suggestion: { summary: '移项时忘记改变符号。', suggestedAttemptState: '方法基本正确但步骤出错', suggestedCause: '计算' }, previous: null }, 'src/web/views/practice.tsx#WhyConfirmPage'],
  settings: [practice.SettingsPage, { practiceSlot: '周三晚自习', paperLocation: 'school', saved: false, studentHostWorker: true }, 'src/web/views/practice.tsx#SettingsPage'],
  install: [today.InstallPage, {}, 'src/web/views/today.tsx#InstallPage'],
};
await mkdir(output, { recursive: true });
await mkdir(join(output, 'assets'), { recursive: true });
// Preserve each source stylesheet; the two extra variants only replace the appearance media condition.
await writeFile(join(output, 'assets/app.css'), assets.STYLES);
for (const theme of ['light', 'dark']) {
  const css = assets.STYLES.replace(/\(prefers-color-scheme\s*:\s*(dark|light)\)/g, (_: string, mode: string) => mode === theme ? '(min-width:0px)' : '(max-width:0px)');
  await writeFile(join(output, `assets/${theme}.css`), css);
}
await writeFile(join(output, 'assets/icon.svg'), assets.iconSvg());
await copyFile(join(source, 'src/web/examples/capture-page.jpg'), join(output, 'assets/capture-page.jpg'));
await copyFile(join(source, 'src/web/examples/capture-question.jpg'), join(output, 'assets/capture-question.jpg'));
// Reuse only the audited, network-free sheet enhancer. Upload/AI/session scripts stay excluded.
const sheetEnhancement = typeof assets.UI_SHEET_SCRIPT === 'string' ? assets.UI_SHEET_SCRIPT : null;
if (sheetEnhancement) await writeFile(join(output, 'assets/sheet.js'), sheetEnhancement);
const routes: Record<string, string> = { '/s': 'today', '/s/': 'today', '/s/login': 'login', '/s/settings': 'settings', '/s/capture': 'capture', '/s/photos': 'photos', '/s/photos/demo-photo': 'pick', '/s/items': 'items', '/s/practices': 'practices', '/s/items/demo-linear': 'item', '/s/items/demo-triangle': 'item', '/s/items/demo-fraction': 'item', '/s/choose': 'choose', '/s/why/demo-practice': 'why', '/s/why/demo-practice/demo-linear/confirm': 'confirm', '/s/install': 'install' };
const records = [];
for (const [id, title] of SCENARIOS) {
  const [Component, props, component] = scenes[id]!;
  // These are actual checkout components, rendered before any static-export transformations.
  const raw = '<!doctype html>' + renderToStaticMarkup(createElement(Component as ComponentType<object>, props));
  let html = raw.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<noscript>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<link\b[^>]*rel="(?:manifest|apple-touch-icon|icon)"[^>]*>/gi, '')
    .replace(/data-(?:refresh|poll)="[^"]*"/g, '').replace(/data-endpoint="[^"]*"/g, '')
    .replace(/<link rel="preload" as="image"[^>]*>/g, '')
    .replace(/href="\/s\/assets\/app(?:\.[a-f\d]+)?\.css[^\"]*"/g, 'href="assets/app.css" id="demo-app-style"')
    .replace(/src="\/s\/assets\/capture-page\.[a-f\d]+\.jpg"/g, 'src="assets/capture-page.jpg"')
    .replace(/src="\/s\/assets\/capture-question\.[a-f\d]+\.jpg"/g, 'src="assets/capture-question.jpg"')
    .replace(/src="\/s\/img\/(?:photo\/[^"?]+)(?:\?[^\"]*)?"/g, 'src="../assets/photo.svg"')
    .replace(/src="\/s\/img\/(?:item\/([^"?]+)|cand\/[^/]+\/([^"?]+))(?:\?[^\"]*)?"/g, (_: string, item: string, candidate: string) => `src="../assets/${items.some(i => i.id === (item || candidate)) ? (item || candidate) : items[0]!.id}.svg"`)
    .replace(/href="([^\"]*)"/g, (original: string, href: string) => {
      if (href.startsWith('/s/img/')) return 'href="../assets/photo.svg"';
      if (!href.startsWith('/s')) return original;
      const route = routes[href.split(/[?#]/)[0]!];
      return route ? `href="${route}.html"` : 'href="#demo-unavailable"';
    })
    .replace(/<form\b([^>]*)action="([^\"]*)"([^>]*)>/g, (_: string, before: string, action: string, after: string) => {
      const kind = action === '/s/login' ? 'login' : action === '/s/logout' ? 'logout' : action === '/s/settings' ? 'settings' : action === '/s/capture' ? 'photo' : action === '/s/choose' ? 'choose' : action.endsWith('/select') || action.endsWith('/none') ? 'pick' : action.endsWith('/answer') ? 'answer' : action.endsWith('/submit') ? 'reflection' : 'unsupported';
      return `<form${before}action="#demo" data-demo-form="${kind}"${after}>`;
    });
  html = html.replace('</head>', '<meta http-equiv="Content-Security-Policy" content="default-src &apos;self&apos; data: blob:; script-src &apos;self&apos;; style-src &apos;self&apos; &apos;unsafe-inline&apos;; connect-src &apos;none&apos;; form-action &apos;none&apos;; object-src &apos;none&apos;; base-uri &apos;none&apos;"><link rel="icon" href="assets/icon.svg"><link rel="stylesheet" href="../assets/demo.css"><script defer src="../assets/demo.js"></script>' + (sheetEnhancement ? '<script defer src="assets/sheet.js"></script>' : '') + '</head>')
    .replace(/<body([^>]*)>/, `<body$1 data-demo-scenario="${id}"><aside class="demo-notice" aria-label="预览说明"><b>合成数据 · 真实页面导出</b> 浏览器演示交互；不连接 AI、不上传、不保存到服务器。<a href="../index.html" target="_top">返回对照</a><span id="demo-status" role="status" aria-live="polite"></span></aside>`);
  if (/<script[^>]+src="\/s\/|(?:src|href|action)="\/s[\/"?]/.test(html)) throw new Error(`Unmapped application resource in ${id}`);
  await writeFile(join(output, `${id}.html`), html);
  records.push({ id, title, path: `${id}.html`, component, rawSsrSha256: createHash('sha256').update(raw).digest('hex') });
}
await writeFile(join(output, 'export.json'), JSON.stringify({ source, assetVersion: assets.ASSET_VERSION, sheetEnhancementIncluded: Boolean(sheetEnhancement), stylesheetSha256: createHash('sha256').update(assets.STYLES).digest('hex'), scenarios: records }, null, 2));
