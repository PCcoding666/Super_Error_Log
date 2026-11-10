// 高保真 E2E 驱动：Playwright WebKit + iPhone 15 模拟，经本地 HTTPS 代理访问生产入口。每个子命令是一步，cookie 状态存在 state.json。
import { webkit, chromium, devices } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.HF_BASE ?? 'https://127.0.0.1:3443';
const here = path.dirname(new URL(import.meta.url).pathname);
const stateFile = path.join(here, 'state.json');
const shotsDir = path.join(here, '..', 'shots');
const logFile = path.join(here, 'log.txt');
const counterFile = path.join(here, 'shot-counter');
const engine = process.env.HF_BROWSER === 'chromium' ? chromium : webkit;
const device = devices[process.env.HF_DEVICE ?? 'iPhone 15'];
const [cmdRaw, ...args] = process.argv.slice(2);
const cmd = { 'edit-stem': 'editStem' }[cmdRaw] ?? cmdRaw;
const flags = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
const positional = args.filter(a => !a.startsWith('--'));

function log(...parts) { const line = `${new Date().toISOString()} ${parts.map(p => typeof p === 'string' ? p : JSON.stringify(p)).join(' ')}`; console.log(line); fs.appendFileSync(logFile, line + '\n'); }
async function shot(page, name) { const n = Number(fs.existsSync(counterFile) ? fs.readFileSync(counterFile, 'utf8') : 0) + 1; fs.writeFileSync(counterFile, String(n)); const p = path.join(shotsDir, `${String(n).padStart(2, '0')}-${name}.png`); await page.screenshot({ path: p }); log('shot', p); return p; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function text(loc) { try { return (await loc.innerText({ timeout: 2000 })).replace(/\s+/g, ' ').trim(); } catch { return null; } }

async function open() {
  const browser = await engine.launch();
  const ctx = await browser.newContext({ ...device, ignoreHTTPSErrors: true, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', ...(fs.existsSync(stateFile) ? { storageState: stateFile } : {}) });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') log('console.' + m.type(), m.text().slice(0, 300)); });
  page.on('pageerror', e => log('pageerror', e.message.slice(0, 300)));
  page.on('response', r => { const u = r.url(); if (r.status() >= 400 && !/\/favicon/.test(u)) log('http', r.status(), r.request().method(), u.replace(BASE, '')); });
  page.on('requestfailed', r => log('requestfailed', r.method(), r.url().replace(BASE, ''), r.failure()?.errorText));
  return { browser, ctx, page };
}
async function close({ browser, ctx }) { await ctx.storageState({ path: stateFile }); await browser.close(); }
const dock = page => page.locator('[data-testid="capture-dock"]:visible');

const commands = {
  async login({ page }) {
    const [code, stage] = positional;
    await page.goto(BASE + '/s/');
    await shot(page, 'login-page');
    await page.getByLabel('12 位邀请码').fill(code);
    await page.getByRole('button', { name: '进入我的错题本' }).click();
    await page.waitForLoadState('networkidle');
    log('after-login url', page.url());
    const gate = page.getByRole('heading', { name: '你现在读初中还是高中？' });
    if (await gate.isVisible().catch(() => false)) { await shot(page, 'stage-gate'); await page.getByRole('button', { name: stage ?? '初中', exact: true }).click(); }
    await page.waitForURL(/\/s\/?(\?.*)?$/, { timeout: 15000 }).catch(() => {});
    await sleep(1500);
    log('home url', page.url(), 'empty-notebook', await page.getByTestId('empty-notebook').isVisible().catch(() => false));
    await shot(page, 'home-after-login');
  },
  // upload <single|multi> <file...>
  async upload({ page }) {
    const [mode, ...files] = positional;
    await page.goto(BASE + (flags.from === 'new' ? '/s/new' : '/s/'));
    await sleep(1500);
    await shot(page, 'before-upload');
    const d = dock(page);
    log('dock', { route: await d.getAttribute('data-capture-route'), choice: await d.getAttribute('data-capture-choice') });
    if (flags.from === 'new') await d.getByText('从相册选择').click(); else await page.getByTestId('next-step-primary').click();
    await page.getByTestId('capture-mode-sheet').waitFor();
    await shot(page, 'choice-sheet');
    const sheet = page.getByTestId('capture-mode-sheet');
    if (mode === 'single') {
      await sheet.getByTestId('capture-mode-single').locator('input').setInputFiles(files);
    } else {
      await sheet.getByTestId('capture-mode-multi').locator('input').setInputFiles(files[0]);
      for (const f of files.slice(1)) { await page.locator('#library-input').waitFor({ state: 'attached' }); await page.locator('#library-input').setInputFiles(f); await sleep(500); }
      log('tray count', await text(page.getByTestId('capture-count')));
      await shot(page, 'multi-tray');
      await page.getByTestId('capture-set-done').click();
    }
    await page.waitForURL(/\/s\/new/, { timeout: 20000 });
    log('intake url', page.url());
    await sleep(1000);
    await shot(page, 'uploading');
    // 等上传队列清空（状态行不再含「正在上传」）
    const deadline = Date.now() + Number(flags.wait ?? 180) * 1000;
    while (Date.now() < deadline) {
      const status = await text(page.locator('.intake-top p').first());
      if (status && !status.includes('正在上传')) { log('upload status', status); break; }
      await sleep(2000);
    }
    await shot(page, 'uploaded');
    log('rows', await page.locator('section.intake-photo').evaluateAll(rows => rows.map(r => ({ id: r.dataset.testid, state: r.dataset.state }))));
  },
  // intake [--wait=600] [--pick=all|none|1,2] 轮询录入态直到没有 finding
  async intake({ page }) {
    await page.goto(BASE + '/s/new');
    const deadline = Date.now() + Number(flags.wait ?? 600) * 1000;
    let last = '';
    while (Date.now() < deadline) {
      const rows = await page.locator('section.intake-photo').evaluateAll(rows => rows.map(r => ({ id: r.getAttribute('data-testid'), state: r.dataset.state, title: r.querySelector('h2,h3,.intake-photo-title')?.textContent?.trim()?.slice(0, 40), questions: [...r.querySelectorAll('[data-testid="intake-question"]')].map(q => q.textContent.replace(/\s+/g, ' ').trim().slice(0, 120)), candidates: [...r.querySelectorAll('[data-testid="pick-candidate"]')].map(q => q.textContent.replace(/\s+/g, ' ').trim().slice(0, 120)) })));
      const status = await text(page.locator('.intake-top p').first());
      const sig = JSON.stringify({ status, rows });
      if (sig !== last) { log('intake', { status, rows }); await shot(page, 'intake-' + rows.map(r => r.state?.slice(0, 4)).join('_')); last = sig; }
      if (!rows.some(r => r.state === 'finding') && status && !status.includes('正在')) break;
      await sleep(5000);
    }
    if (flags.pick && flags.pick !== 'none') {
      for (const photo of await page.locator('section.intake-photo[data-state="needsPick"]').all()) {
        const boxes = photo.getByTestId('pick-checkbox');
        const n = await boxes.count();
        const wanted = flags.pick === 'all' ? [...Array(n).keys()] : String(flags.pick).split(',').map(Number).map(i => i - 1);
        for (const i of wanted) if (i < n) await boxes.nth(i).click();
        await shot(page, 'picked');
        await photo.getByTestId('pick-submit').click();
        await sleep(2000);
      }
      await commands.intake({ page });
    }
    await shot(page, 'intake-final');
  },
  async notebook({ page }) {
    await page.goto(BASE + '/s/');
    await sleep(2000);
    await commands.chooseSubject(page);
    const cards = await page.getByTestId('item-card').evaluateAll(cards => cards.map(c => c.textContent.replace(/\s+/g, ' ').trim().slice(0, 160)));
    log('notebook cards', cards.length, cards);
    await shot(page, 'notebook');
    const api = await page.request.get(BASE + '/s/api/notebook' + (flags.subject ? `?subject=${encodeURIComponent(String(flags.subject))}` : ''));
    const j = await api.json();
    log('notebook api', { status: api.status(), groups: j.groups?.map(g => ({ label: g.label, n: g.items?.length })), filters: Object.keys(j).filter(k => k !== 'groups') });
    fs.writeFileSync(path.join(here, 'notebook.json'), JSON.stringify(j, null, 2));
  },
  // detail <index> [--wait=240]
  async detail({ page }) {
    const index = Number(positional[0] ?? 0);
    const id = await commands.openItem(page, index);
    await sleep(500);
    await shot(page, `detail-${index}-top`);
    const fields = {};
    for (const t of ['question-text', 'item-work', 'item-mistake', 'item-category', 'item-chapter', 'item-tags', 'item-answer', 'item-remark', 'item-photo-note']) fields[t] = await text(page.getByTestId(t).first());
    log('detail', id, fields);
    const deadline = Date.now() + Number(flags.wait ?? 240) * 1000;
    while (Date.now() < deadline) {
      const a = await text(page.getByTestId('item-answer').first());
      if (a && (a.includes('AI 解答') || a.includes('重试'))) break;
      await sleep(5000);
    }
    log('answer block', await text(page.getByTestId('item-answer').first()));
    await page.getByTestId('item-answer').first().scrollIntoViewIfNeeded();
    await shot(page, `detail-${index}-answer`);
    await page.getByTestId('item-answer').first().click();
    await sleep(1500);
    await shot(page, `detail-${index}-solution`);
    log('solution answer', await text(page.getByTestId('solution-answer')));
    log('solution steps', (await text(page.getByTestId('solution-steps')))?.slice(0, 1500));
    log('solution figure', await page.getByTestId('solution-figure').count());
    await page.getByTestId('solution-close').click().catch(() => {});
    const api = await page.request.get(BASE + `/s/api/items/${id}`);
    const j = await api.json();
    fs.writeFileSync(path.join(here, `item-${index}.json`), JSON.stringify(j, null, 2));
    log('item api', api.status(), Object.keys(j));
  },
  async api({ page }) {
    const r = await page.request.get(BASE + positional[0]);
    const body = await r.text();
    log('api', positional[0], r.status(), body.slice(0, Number(flags.max ?? 4000)));
    if (flags.save) fs.writeFileSync(path.join(here, flags.save), body);
  },
  async goto({ page }) { await page.goto(BASE + positional[0]); await sleep(Number(flags.sleep ?? 2000)); await shot(page, positional[1] ?? 'goto'); log('url', page.url()); if (flags.text) log('text', (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 3000)); },
  // retry <photoNumber>：在录入页点那一张的「重试」
  async retry({ page }) {
    const n = positional[0];
    await page.goto(BASE + '/s/new');
    await sleep(2000);
    const earlier = page.locator('details.intake-earlier summary');
    if (await earlier.count()) { await earlier.click(); await sleep(500); }
    const row = page.getByTestId(`photo-row-${n}`);
    log('row before', { state: await row.getAttribute('data-state'), text: await text(row) });
    await shot(page, `retry-${n}-before`);
    await row.getByRole('button', { name: '重试' }).click();
    await sleep(3000);
    log('row after', { state: await row.getAttribute('data-state'), text: await text(row) });
    await shot(page, `retry-${n}-after`);
  },
  async chooseSubject(page) {
    if (!flags.subject) return;
    await page.getByTestId('subject-switch').click(); await sleep(600);
    await page.locator('ion-action-sheet button, .action-sheet-button').filter({ hasText: String(flags.subject) }).first().click(); await sleep(1500);
    log('subject now', await text(page.getByTestId('subject-switch')));
  },
  async openItem(page, index) {
    await page.goto(BASE + '/s/');
    await sleep(2000);
    await commands.chooseSubject(page);
    await page.getByTestId('item-card').nth(index).click();
    await page.waitForURL(/\/s\/q\//);
    await sleep(1500);
    return page.url().split('/s/q/')[1];
  },
  // remark <index> <text>
  async remark({ page }) {
    const [index, ...words] = positional; const value = words.join(' ');
    const id = await commands.openItem(page, Number(index));
    const area = page.getByTestId('item-remark').locator('textarea:not(.cloned-input)').first();
    await area.scrollIntoViewIfNeeded();
    await area.click();
    await area.fill(value);
    await sleep(2500);
    log('remark status', await text(page.getByTestId('remark-status')));
    await page.getByTestId('item-mistake').scrollIntoViewIfNeeded();
    await shot(page, `remark-${index}`);
    await page.reload(); await sleep(2000);
    log('remark after reload', await text(page.getByTestId('item-remark')));
    const api = await page.request.get(BASE + `/s/api/items/${id}`); const j = await api.json();
    log('remark api', JSON.stringify(j.remark ?? j.note ?? j.studentNote ?? null).slice(0, 300));
  },
  // edit-stem <index> <text>
  async editStem({ page }) {
    const [index, ...words] = positional; const value = words.join(' ');
    const id = await commands.openItem(page, Number(index));
    log('stem before', await text(page.getByTestId('question-text')));
    await page.getByTestId('stem-edit').click();
    await page.getByTestId('text-edit-input').locator('textarea').waitFor();
    await shot(page, `edit-stem-${index}-modal`);
    await page.getByTestId('text-edit-input').locator('textarea').fill(value);
    await page.getByTestId('text-edit-save').click();
    await sleep(2500);
    log('edit error', await text(page.getByTestId('text-edit-error')));
    log('stem after', await text(page.getByTestId('question-text')));
    await shot(page, `edit-stem-${index}-after`);
    const api = await page.request.get(BASE + `/s/api/items/${id}`); const j = await api.json();
    log('stem api', JSON.stringify(j.questionText ?? j.question ?? null).slice(0, 300), 'insight', JSON.stringify(j.insight?.state ?? j.insight));
  },
  // discard <index>
  async discard({ page }) {
    const index = Number(positional[0]);
    const id = await commands.openItem(page, index);
    await page.getByTestId('discard').scrollIntoViewIfNeeded();
    await page.getByTestId('discard').click();
    await sleep(800);
    await shot(page, `discard-${index}-confirm`);
    const sheetEl = page.locator('ion-action-sheet[is-open]:not(.overlay-hidden)').last(); await sheetEl.waitFor({ state: 'visible' }); await sleep(600);
    log('sheet buttons', await sheetEl.locator('button').allInnerTexts());
    await sheetEl.locator('button.action-sheet-destructive').first().click({ force: true });
    await sleep(2500);
    log('after discard url', page.url());
    await shot(page, `discard-${index}-after`);
    const nb = await page.request.get(BASE + '/s/api/notebook'); const j = await nb.json();
    log('notebook after discard', j.groups?.map(g => `${g.label}:${g.items?.length}`).join(' '), 'total', j.total ?? '-');
    if (flags.restore) { const r = await page.request.post(BASE + `/s/api/items/${id}/restore`, { headers: { 'content-type': 'application/json', origin: BASE }, data: {} }); log('restore', r.status(), (await r.text()).slice(0, 200)); const nb2 = await page.request.get(BASE + '/s/api/notebook'); const j2 = await nb2.json(); log('notebook after restore', j2.groups?.map(g => `${g.label}:${g.items?.length}`).join(' ')); }
  },
  async settings({ page }) {
    await page.goto(BASE + '/s/me'); await sleep(2000);
    log('settings', { grade: await text(page.getByTestId('student-grade')), role: await text(page.getByTestId('account-role')), invite: await page.getByTestId('settings-my-invite').getAttribute('href'), body: (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 400) });
    await shot(page, 'settings');
    await page.goto(BASE + '/s/account'); await sleep(1500); await shot(page, 'account-page');
    log('account page', (await page.locator('body').innerText()).replace(/\s+/g, ' ').replace(/[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/g, '<code>').slice(0, 500));
    await page.goto(BASE + '/s/install'); await sleep(1500); await shot(page, 'install-page');
    if (flags.logout) {
      await page.goto(BASE + '/s/me'); await sleep(1500);
      await page.getByTestId('logout').click(); await sleep(2000);
      log('after logout url', page.url(), 'login visible', await page.getByLabel('12 位邀请码').isVisible().catch(() => false));
      await shot(page, 'after-logout');
      const r = await page.request.get(BASE + '/s/api/notebook'); log('api after logout', r.status(), r.headers()['content-type']);
    }
  },
  async openIntakeRow(page, n) {
    await page.goto(BASE + '/s/new'); await sleep(2000);
    const earlier = page.locator('details.intake-earlier summary');
    const row = page.getByTestId(`photo-row-${n}`);
    if (!(await row.isVisible().catch(() => false)) && await earlier.count()) { await earlier.click(); await sleep(500); }
    await row.scrollIntoViewIfNeeded();
    return row;
  },
  // candidate <photoNumber> <index1based>：打开候选题详情弹层
  async candidate({ page }) {
    const [n, i] = positional.map(Number);
    const row = await commands.openIntakeRow(page, n);
    await shot(page, `intake-row-${n}`);
    const cand = row.getByTestId('pick-candidate').nth(i - 1);
    log('candidate text', await text(cand));
    await cand.getByText('查看详情').click(); await sleep(1500);
    await shot(page, `candidate-${n}-${i}`);
    const sheet = page.getByTestId('candidate-detail-sheet');
    log('candidate detail', (await text(sheet))?.slice(0, 1200));
    for (const t of ['candidate-stem', 'candidate-work', 'candidate-mark', 'candidate-grade', 'candidate-answer', 'candidate-uncertain', 'candidate-stem-empty', 'candidate-traces-empty', 'candidate-judgment-empty', 'candidate-detail-error']) { const v = await text(page.getByTestId(t).first()); if (v) log('  ' + t, v.slice(0, 300)); }
    if (flags.select) { await page.getByTestId('detail-select').click(); await sleep(800); log('selected via detail'); }
    await page.getByTestId('candidate-detail-close').click().catch(() => {});
  },
  // pick <photoNumber> <i,j,...>（1-based）：勾选后点「加入」
  async pick({ page }) {
    const n = Number(positional[0]); const idx = String(positional[1] ?? '').split(',').filter(Boolean).map(Number);
    const row = await commands.openIntakeRow(page, n);
    const boxes = row.getByTestId('pick-checkbox');
    log('candidates on row', await boxes.count());
    for (const i of idx) await boxes.nth(i - 1).click();
    await sleep(500);
    log('pick-submit label', await text(row.getByTestId('pick-submit')), 'intake-selected', await text(page.getByTestId('intake-selected')));
    await shot(page, `pick-${n}`);
    await row.getByTestId('pick-submit').click(); await sleep(2500);
    log('row after pick', { state: await row.getAttribute('data-state'), text: (await text(row))?.slice(0, 200) });
    await shot(page, `pick-${n}-after`);
  },
  async reset() { for (const f of [stateFile, counterFile]) fs.rmSync(f, { force: true }); log('state reset'); },
};

if (!commands[cmd]) { console.error('commands:', Object.keys(commands).join(', ')); process.exit(2); }
fs.mkdirSync(shotsDir, { recursive: true });
if (cmd === 'reset') { await commands.reset(); process.exit(0); }
const session = await open();
try { await commands[cmd](session); } catch (e) { log('ERROR', e.message); await shot(session.page, 'error').catch(() => {}); process.exitCode = 1; } finally { await close(session); }
