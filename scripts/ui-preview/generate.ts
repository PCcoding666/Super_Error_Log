#!/usr/bin/env node
/** Export real SSR pages from two checkouts without starting either application. */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, copyFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { cards, FIXTURE_DATE, FIXTURE_WEEK, items, photo, photoSvg, questionSvg, SCENARIOS } from './fixtures.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: npm run ui:preview -- --before BASELINE_CHECKOUT --after CURRENT_CHECKOUT --out STATIC_OUTPUT');
  process.exit(0);
}
const options: Record<string, string> = {};
for (let i = 0; i < args.length; i += 2) {
  const key = args[i], value = args[i + 1];
  if (!key || !['--before', '--after', '--out'].includes(key) || !value || value.startsWith('--')) throw new Error('Expected --before PATH --after PATH --out PATH. Use --help.');
  options[key] = resolve(value);
}
const before = options['--before'], after = options['--after'], output = options['--out'];
if (!before || !after || !output) throw new Error('All three paths are required. Use --help.');
if (before === after) throw new Error('Use independent before and after checkouts.');
for (const source of [before, after]) {
  await stat(join(source, 'src/web/views/layout.tsx'));
  // Output inside a checkout is allowed only in its ignored dist directory.
  const local = relative(source, output);
  if (!local || !local.startsWith('..') && !isAbsolute(local) && local.split('/')[0] !== 'dist') throw new Error('Output must be outside source checkouts, or inside their ignored dist/ directory.');
}
const git = (source: string, ...command: string[]) => execFileSync('git', ['-C', source, ...command], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).trim();
function provenance(source: string) {
  const status = git(source, 'status', '--porcelain=v1', '--untracked-files=all');
  return { source, commit: git(source, 'rev-parse', 'HEAD'), dirty: Boolean(status), status: status.split('\n').filter(Boolean), trackedDiffSha256: createHash('sha256').update(git(source, 'diff', 'HEAD', '--')).digest('hex') };
}
const sources = { before: provenance(before), after: provenance(after) };
// Refuse to erase an arbitrary folder. Reruns are safe only for our own prior exports.
try {
  const contents = await readdir(output);
  if (contents.length) {
    const previous = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
    if (previous.generator !== 'sel-ui-preview-v1') throw new Error('Unrecognized output directory');
    await rm(output, { recursive: true });
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  // A missing manifest in an existing nonempty directory must not authorize deletion.
  try { if ((await readdir(output)).length) throw new Error('Refusing nonempty output directory without a preview manifest.'); } catch (nested) { if ((nested as NodeJS.ErrnoException).code !== 'ENOENT') throw nested; }
}
await mkdir(join(output, 'assets'), { recursive: true });
await writeFile(join(output, 'manifest.json'), JSON.stringify({ generator: 'sel-ui-preview-v1', incomplete: true }));
await Promise.all(['demo.js', 'demo.css', 'report.js', 'report.css'].map(file => copyFile(join(scriptDir, file), join(output, 'assets', file))));
await writeFile(join(output, 'assets/photo.svg'), photoSvg());
await Promise.all(items.map((item, i) => writeFile(join(output, `assets/${item.id}.svg`), questionSvg(i))));
const temp = await mkdtemp(join(tmpdir(), 'sel-ui-preview-'));
try {
  for (const [version, source] of Object.entries({ before, after })) {
    // Source imports can load config.ts: a clean cwd and minimal env prevent .env/credential reads.
    execFileSync(process.execPath, ['--import', join(after, 'node_modules/tsx/dist/loader.mjs'), join(scriptDir, 'export.ts'), source, join(output, version)], {
      cwd: temp, env: { PATH: process.env.PATH || '', TSX_TSCONFIG_PATH: join(source, 'tsconfig.json'), SEL_AI_MODE: 'mock', SEL_DATA_DIR: join(temp, 'unused-data'), TZ: 'UTC' }, stdio: 'pipe', maxBuffer: 5 * 1024 * 1024,
    });
  }
  if ((await readdir(temp)).length) throw new Error('SSR export unexpectedly wrote data in the isolated cwd.');
} finally { await rm(temp, { recursive: true, force: true }); }
const exports = Object.fromEntries(await Promise.all(['before', 'after'].map(async version => [version, JSON.parse(await readFile(join(output, version, 'export.json'), 'utf8'))])));
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
const manifest = {
  generator: 'sel-ui-preview-v1', generatedAt: new Date().toISOString(), fixedFixtureDate: FIXTURE_DATE, fixtureWeek: FIXTURE_WEEK,
  fixtureSha256: createHash('sha256').update(JSON.stringify({ items, cards, photo, date: FIXTURE_DATE })).digest('hex'),
  syntheticDataOnly: true, productionScriptsIncluded: false, serverRequired: false,
  sources: Object.fromEntries(Object.entries(sources).map(([version, source]) => [version, { ...source, ...exports[version] }])),
  scenarios: SCENARIOS.map(([id, title]) => ({ id, title, before: `before/${id}.html`, after: `after/${id}.html` })),
  viewports: ['390x844', '320x740', '430x932'],
  limitations: ['Real SSR exports with a separate browser demo adapter; no React hydration.', 'Fixed synthetic recognition/reflection inputs; no AI, upload, recording, printing, or server persistence.', 'Demo settings and text can use tab-local sessionStorage; selected images use temporary blob URLs only.'],
};
await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(join(output, 'index.html'), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'; form-action 'none'; object-src 'none'; base-uri 'none'"><title>错题本 · 视觉基础前后对照</title><link rel="stylesheet" href="assets/report.css"><script defer src="assets/report.js"></script></head><body><header><h1>错题本 · 视觉基础前后对照</h1><p>两侧分别导出各自版本的真实 React 服务端页面，使用同一组合成数学题和固定日期。页面中的交互由独立浏览器演示脚本提供。</p><p><b>合成数据演示：</b>不连接 AI、不上传照片、不录音、不保存到服务器；打印和结果记录只给出演示提示。原页面中「服务器已连接」等文字也是固定样例。请勿输入真实邀请码。</p></header><div class="controls"><label>查看页面<select id="scenario">${SCENARIOS.map(([id, title]) => `<option value="${id}"${id === 'today' ? ' selected' : ''}>${escape(title)}</option>`).join('')}</select></label><label>外观<select id="appearance"><option value="light">浅色</option><option value="dark">深色</option><option value="system">跟随系统</option></select></label><label>手机尺寸<select id="viewport"><option value="390x844">390 × 844</option><option value="320x740">320 × 740（窄屏）</option><option value="430x932">430 × 932</option></select></label><label class="mobile-version">当前版本<select id="version"><option value="after">新版</option><option value="before">旧版</option></select></label><label class="check"><input type="checkbox" id="text">200% 文字</label><label class="check"><input type="checkbox" id="motion">减少动态</label></div><div class="panels">${(['before', 'after'] as const).map(version => `<section class="panel" id="${version}-panel"><h2>${version === 'before' ? '改前' : '改后'}</h2><p class="meta">${escape(sources[version].commit.slice(0, 12))}${sources[version].dirty ? ' + 工作区改动' : ' · 干净快照'}</p><a class="direct" id="${version}-link" href="${version}/today.html" target="_blank" rel="noopener">单独打开${version === 'before' ? '旧版' : '新版'} ↗</a><div class="frame"><iframe id="${version}-frame" src="${version}/today.html" title="${version === 'before' ? '改前' : '改后'}手机页面" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-top-navigation-by-user-activation" loading="eager"></iframe></div></section>`).join('')}</div><footer><p>固定数据日期：${FIXTURE_DATE} · 两侧页面内可独立操作；更换场景会重新对齐。</p><p>电脑并排查看；手机通过「当前版本」切换。画面自动按可用宽度等比缩放，内部仍保持所选手机尺寸；可单独打开原尺寸页面。原生勾选、文本、单选框、演示跳转和当前标签页设置可用。</p><p><a href="manifest.json" target="_blank">来源与场景清单</a> · 不含原应用客户端脚本、Service Worker、真实数据、登录会话或凭证。</p></footer></body></html>`);

// Validate deliverable links/assets, not a mirrored implementation of the app.
let files = 0;
async function validateDirectory(dir: string, root: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { await validateDirectory(path, root); continue; }
    files++;
    if (!entry.name.endsWith('.html')) continue;
    const html = await readFile(path, 'utf8');
    if (/<script[^>]+src="[^\"]*(?:app\.js|https?:)|serviceWorker|document\.cookie|http-equiv="refresh"/i.test(html)) throw new Error(`Unsafe production behavior in ${path}`);
    for (const [, link] of html.matchAll(/(?:src|href)="([^\"]+)"/g)) {
      if (link!.startsWith('#')) continue;
      if (/^(?:https?:|\/\/|\/s\/)/.test(link!)) throw new Error(`Non-local resource ${link} in ${path}`);
      const local = resolve(dirname(path), link!.split(/[?#]/)[0]!);
      if (relative(root, local).startsWith('..')) throw new Error(`Resource escapes output: ${link}`);
      await stat(local);
    }
  }
}
await validateDirectory(output, output);
console.log(`Exported ${SCENARIOS.length} actual SSR scenarios × 2 versions (${files} files).\n${join(output, 'index.html')}\nManifest: ${join(output, 'manifest.json')}`);
