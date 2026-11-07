/** Intake candidates: select a source page, keep hidden picks, and review details without saving. Synthetic pages only. */
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { expect, test, type Page } from '@playwright/test';
import { materialGateway, type MaterialGateway } from '../helpers/materialGateway.js';

test.use({ viewport: { width: 360, height: 640 }, serviceWorkers: 'block' });

const shots = '/opt/cursor/artifacts';

async function screenshot(page: Page, name: string): Promise<void> {
  if (!fs.existsSync('/opt/cursor')) return;
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, name) });
}

async function jpeg(color: { r: number; g: number; b: number }): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  return { name: 'synthetic.jpg', mimeType: 'image/jpeg', buffer: await sharp({ create: { width: 240, height: 320, channels: 3, background: color } }).jpeg().toBuffer() };
}

async function login(page: Page, base: string, code: string): Promise<void> {
  await page.goto(base + '/s/');
  await page.getByLabel('12 位邀请码').fill(code);
  await page.getByRole('button', { name: '进入我的错题本' }).click();
  await expect(page.getByRole('heading', { name: '你现在读初中还是高中？' })).toBeVisible();
  await page.getByRole('button', { name: '初中', exact: true }).click();
  await expect(page.getByTestId('empty-notebook')).toBeVisible();
}

async function uploadOne(page: Page, file: { name: string; mimeType: string; buffer: Buffer }, fromIntake: boolean): Promise<void> {
  await page.getByTestId(fromIntake ? 'intake-album' : 'next-step-primary').click();
  await page.getByTestId('capture-mode-single').locator('input').setInputFiles(file);
  if (!fromIntake) await expect.poll(() => new URL(page.url()).pathname).toBe('/s/new');
}

async function scrollTop(page: Page): Promise<number> {
  return page.locator('ion-content.intake').evaluate(async element => {
    const content = element as HTMLElement & { getScrollElement: () => Promise<HTMLElement> };
    return (await content.getScrollElement()).scrollTop;
  });
}

test('students can select one source page and review an unsaved candidate without losing filter, selection or scroll', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const long = `1. PAGE-A-ONE ${'甲'.repeat(80)}`;
  const g = await materialGateway({ pages: [
    { parts: [
      { role: 'question', number: '1', text: long },
      { role: 'student_work', number: '1', text: 'PAGE-A-WORK' },
      { role: 'teacher_mark', number: '1', text: '已阅 PAGE-A-MARK' },
      { role: 'reference_answer', number: '1', text: 'PAGE-A-ANSWER' },
      { role: 'question', number: '2', text: '2. PAGE-A-TWO 看不清的式子', check: 'low', uncertainties: ['blurry'] },
    ] },
    { parts: [
      { role: 'question', number: '8', text: '8. PAGE-B-ONE 计算 9+9。' },
      { role: 'question', number: '10', text: '10. PAGE-B-TWO 计算 8+8。' },
      { role: 'question', number: '11', text: '11. PAGE-B-THREE 计算 7+7。' },
      { role: 'question', number: '12', text: '12. PAGE-B-FOUR 计算 6+6。' },
    ] },
    { parts: [
      { role: 'question', number: '9', text: '9. PAGE-C-AUTO' },
      { role: 'teacher_mark', number: '9', text: '×' },
    ] },
  ] });
  const selectPosts: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && /\/intake\/photos\/[^/]+\/select$/.test(new URL(request.url()).pathname)) selectPosts.push(request.postData() ?? '');
  });
  try {
    await login(page, g.base, g.codes[0]!);
    await uploadOne(page, await jpeg({ r: 210, g: 220, b: 230 }), false);
    await uploadOne(page, await jpeg({ r: 180, g: 210, b: 190 }), true);
    await uploadOne(page, await jpeg({ r: 230, g: 190, b: 190 }), true);
    await expect.poll(async () => (await g.snapshot()).material_job!.every(job => !['running', 'queued'].includes(String(job.state)))).toBe(true);
    await expect(page.getByText('PAGE-A-ONE').first()).toBeVisible({ timeout: 20_000 });
    const pageA = page.locator('section.intake-photo', { hasText: 'PAGE-A-ONE' });
    const pageB = page.locator('section.intake-photo', { hasText: 'PAGE-B-ONE' });
    const saved = page.locator('section.intake-photo', { hasText: 'PAGE-C-AUTO' });
    await expect(pageA.getByTestId('pick-candidate')).toHaveCount(2);
    await expect(pageB.getByTestId('pick-candidate')).toHaveCount(4);
    await expect(saved.getByTestId('pick-page')).toHaveCount(0);
    await expect(saved.getByTestId('pick-candidate')).toHaveCount(0);
    await expect(page.getByTestId('intake-selected')).toHaveText('已选 0 题');

    const checkbox = pageA.getByTestId('pick-checkbox').first().boundingBox();
    const detail = pageA.getByTestId('candidate-detail').first().boundingBox();
    const [checkBox, detailBox] = await Promise.all([checkbox, detail]);
    expect(checkBox!.width).toBeGreaterThan(24);
    expect(detailBox!.height).toBeGreaterThanOrEqual(44);
    expect(checkBox!.x + checkBox!.width).toBeLessThanOrEqual(detailBox!.x + 1);

    await pageA.getByTestId('pick-checkbox').first().focus();
    await page.keyboard.press('Tab');
    await expect(pageA.getByTestId('candidate-detail').first()).toBeFocused();

    const jobsBefore = (await g.snapshot()).material_job!.length;
    await pageA.getByRole('button', { name: '查看第 1 题的详情' }).click();
    const sheet = page.getByTestId('candidate-detail-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('甲'.repeat(70));
    await expect(sheet).toContainText('PAGE-A-WORK');
    await expect(sheet).toContainText('已阅 PAGE-A-MARK');
    await expect(sheet).toContainText('PAGE-A-ANSWER');
    await expect(sheet).toContainText('照片里的');
    await expect(sheet.getByRole('button', { name: /生成|问 AI/ })).toHaveCount(0);
    await expect(sheet.locator('img[alt="题目裁图"]')).toBeVisible();
    await expect(sheet.locator('img[alt="来源页"]')).toBeVisible();
    await expect(sheet.getByRole('checkbox', { name: '勾选这道题' })).not.toBeChecked();
    expect(selectPosts).toEqual([]);
    expect((await g.snapshot()).material_job).toHaveLength(jobsBefore);
    await screenshot(page, 'intake-detail-light.png');
    await page.getByTestId('candidate-detail-close').click();
    await expect(sheet).toBeHidden();
    await expect(pageA.getByRole('checkbox', { name: '选择第 1 题' })).not.toBeChecked();

    await pageA.getByRole('button', { name: '查看第 1 题的详情' }).click();
    await expect(sheet).toContainText('PAGE-A-ANSWER');
    await page.getByTestId('candidate-detail-close').click();
    await expect(sheet).toBeHidden();

    await pageA.getByRole('button', { name: '查看第 2 题的详情' }).click();
    await expect(sheet.getByTestId('candidate-uncertain')).toBeVisible();
    await expect(sheet.getByTestId('candidate-judgment-empty')).toHaveText('还没有答案或判断。');
    await expect(sheet).not.toContainText('blurry');
    await expect(sheet).not.toContainText('PAGE-A-ANSWER');
    await page.getByTestId('detail-select').click();
    await page.getByTestId('candidate-detail-close').click();
    await expect(pageA.getByRole('checkbox', { name: '选择第 2 题' })).toBeChecked();
    await expect(pageA.getByRole('checkbox', { name: '选择第 1 题' })).not.toBeChecked();
    expect(selectPosts).toEqual([]);

    await pageA.getByTestId('pick-page').click();
    await expect(pageA.getByTestId('pick-page')).toHaveText('取消全选');
    await expect(pageA.getByTestId('pick-page')).toHaveAttribute('aria-pressed', 'true');
    await expect(pageA.getByRole('checkbox', { name: '选择第 1 题' })).toBeChecked();
    await expect(pageA.getByRole('checkbox', { name: '选择第 2 题' })).toBeChecked();
    for (const box of await pageB.getByTestId('pick-checkbox').all()) await expect(box).not.toBeChecked();
    await screenshot(page, 'intake-candidates-light.png');
    await pageA.getByRole('checkbox', { name: '选择第 2 题' }).click();
    await expect(pageA.getByTestId('pick-page')).toHaveText('全选本页');
    await expect(pageA.getByTestId('pick-page')).toHaveAttribute('aria-pressed', 'mixed');
    await pageA.getByTestId('pick-page').click();
    await expect(pageA.getByTestId('pick-page')).toHaveText('取消全选');
    await pageA.getByTestId('pick-page').click();
    await expect(pageA.getByRole('checkbox', { name: '选择第 1 题' })).not.toBeChecked();
    await expect(pageA.getByRole('checkbox', { name: '选择第 2 题' })).not.toBeChecked();
    for (const box of await pageB.getByTestId('pick-checkbox').all()) await expect(box).not.toBeChecked();

    await pageB.getByRole('checkbox', { name: '选择第 8 题' }).click();
    await expect(page.getByTestId('intake-selected')).toHaveText('已选 1 题');
    await page.getByTestId('day-filter-toggle').click();
    const today = await page.getByTestId('day-filter-date').inputValue();
    await pageB.getByRole('button', { name: '查看第 8 题的详情' }).click();
    await expect(sheet).toContainText('PAGE-B-ONE');
    await expect(sheet.getByTestId('candidate-stem-empty')).toHaveCount(0);
    await page.getByTestId('candidate-detail-close').click();
    await expect(page.getByTestId('day-filter-date')).toHaveValue(today);
    await expect(page.getByTestId('day-filter-date')).toBeVisible();
    await expect(pageB.getByRole('checkbox', { name: '选择第 8 题' })).toBeChecked();

    const detailButton = pageA.getByRole('button', { name: '查看第 1 题的详情' });
    await detailButton.scrollIntoViewIfNeeded();
    const before = await scrollTop(page);
    expect(before).toBeGreaterThan(40);
    await detailButton.click();
    await expect(sheet).toBeVisible();
    await page.getByTestId('candidate-detail-close').click();
    await expect(sheet).toBeHidden();
    await expect.poll(async () => Math.abs(await scrollTop(page) - before)).toBeLessThan(5);
    await expect(page.getByTestId('day-filter-date')).toHaveValue(today);

    await page.getByTestId('day-filter-date').fill('2020-01-01');
    await expect(page.getByTestId('day-filter-empty')).toBeVisible();
    await expect(page.getByTestId('pick-page')).toHaveCount(0);
    await expect(page.getByTestId('intake-selected')).toHaveText('已选 1 题（其中 1 题不在当前列表，仍会保留）');
    await page.getByTestId('day-filter-date').fill(today);
    await expect(pageB.getByRole('checkbox', { name: '选择第 8 题' })).toBeChecked();
    await pageA.getByTestId('pick-page').click();
    await expect(pageA.getByRole('checkbox', { name: '选择第 1 题' })).toBeChecked();
    await expect(pageA.getByRole('checkbox', { name: '选择第 2 题' })).toBeChecked();
    await expect(pageB.getByRole('checkbox', { name: '选择第 8 题' })).toBeChecked();
    await expect(pageB.getByRole('checkbox', { name: '选择第 10 题' })).not.toBeChecked();
    await pageA.getByTestId('pick-page').click();
    await expect(pageA.getByRole('checkbox', { name: '选择第 1 题' })).not.toBeChecked();
    await expect(pageA.getByRole('checkbox', { name: '选择第 2 题' })).not.toBeChecked();
    await expect(pageB.getByRole('checkbox', { name: '选择第 8 题' })).toBeChecked();
    await expect(page.getByTestId('intake-selected')).toHaveText('已选 1 题');

    await page.emulateMedia({ colorScheme: 'dark' });
    await pageA.getByRole('button', { name: '查看第 1 题的详情' }).click();
    await expect(sheet).toBeVisible();
    const colors = await sheet.locator('h2').evaluate(element => {
      const color = getComputedStyle(element).color;
      let node: Element | null = element;
      let background = '';
      while (node) {
        const value = getComputedStyle(node).backgroundColor;
        if (value && value !== 'rgba(0, 0, 0, 0)' && value !== 'transparent') { background = value; break; }
        node = node.parentElement;
      }
      return { color, background };
    });
    const text = colors.color.match(/\d+/g)?.slice(0, 3).map(Number) ?? [];
    expect(Math.max(...text)).toBeGreaterThan(180);
    await screenshot(page, 'intake-detail-dark.png');
    await page.getByTestId('candidate-detail-close').click();

    const row = (await g.snapshot()).material_question!.find(question => question.number === '8')!;
    const detailPath = `/s/api/intake/candidates/${row.id}?revision=${row.revision}`;
    const own = await page.evaluate(async path => {
      const response = await fetch(path, { headers: { accept: 'application/json' } });
      return { status: response.status, text: await response.text() };
    }, detailPath);
    expect(own.status).toBe(200);
    expect(own.text).toContain('PAGE-B-ONE');
    const stale = await page.evaluate(async path => {
      const response = await fetch(path, { headers: { accept: 'application/json' } });
      return { status: response.status, text: await response.text() };
    }, `/s/api/intake/candidates/${row.id}?revision=${Number(row.revision) + 1}`);
    expect(stale.status).toBe(409);
    expect(stale.text).not.toContain('PAGE-B-ONE');
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    try {
      await login(otherPage, g.base, g.codes[1]!);
      const foreign = await otherPage.evaluate(async path => {
        const response = await fetch(path, { headers: { accept: 'application/json' } });
        return { status: response.status, text: await response.text() };
      }, detailPath);
      expect(foreign.status).toBe(404);
      expect(foreign.text).not.toContain('PAGE-B-ONE');
    } finally { await other.close(); }
    const anonymous = await fetch(g.base + detailPath, { headers: { accept: 'application/json' }, redirect: 'manual' });
    expect(await anonymous.text()).not.toContain('PAGE-B-ONE');

    expect(selectPosts).toEqual([]);
    await pageB.getByTestId('pick-submit').click();
    await expect.poll(() => selectPosts.length).toBe(1);
    expect(selectPosts[0]).toContain(String(row.id));
    await expect(pageB.getByRole('checkbox', { name: '选择第 8 题' })).toHaveCount(0);
    await expect(pageA.getByTestId('pick-candidate')).toHaveCount(2);
  } finally { await g.close(); }
});

test('a legacy candidate opens details from the crop it already has and does not pretend to know the answer', async ({ page }) => {
  test.setTimeout(90_000);
  const port = 3188;
  const controlPort = 3189;
  const child: ChildProcess = fork(path.resolve('tests/e2e/webClientServer.ts'), [], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, SEL_WEB_E2E_PORT: String(port), SEL_WEB_E2E_CONTROL_PORT: String(controlPort), SEL_AI_MODE: 'mock', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let log = '';
  child.stdout?.on('data', chunk => { log += String(chunk); });
  child.stderr?.on('data', chunk => { log += String(chunk); });
  const base = `http://127.0.0.1:${port}`;
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 10_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
  };
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(log);
      try {
        if ((await fetch(`${base}/s/manifest.webmanifest`)).ok) break;
      } catch { /* still booting */ }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!(await fetch(`${base}/s/manifest.webmanifest`)).ok) throw new Error(log || 'legacy fixture did not start');
    const { link } = await (await fetch(`http://127.0.0.1:${controlPort}/pairing-link`)).json() as { link: string };
    await page.goto(link.replace('https://study.pccoding666.com', base));
    await page.getByTestId('next-step-primary').click();
    await page.waitForURL(/\/s\/\?paired=1$/);
    await page.locator('#library-input').setInputFiles(await jpeg({ r: 176, g: 211, b: 224 }));
    await expect.poll(() => new URL(page.url()).pathname).toBe('/s/new');
    const unmarked = page.locator('section.intake-photo[data-state="needsPick"]');
    await expect(unmarked.getByTestId('pick-candidate')).toHaveCount(3, { timeout: 40_000 });
    const posts: string[] = [];
    page.on('request', request => { if (request.method() === 'POST') posts.push(new URL(request.url()).pathname); });
    await unmarked.getByRole('button', { name: '查看第 4 题的详情' }).click();
    const sheet = page.getByTestId('candidate-detail-sheet');
    await expect(sheet.getByTestId('candidate-stem-empty')).toHaveText('还没有识别出题目文字。');
    await expect(sheet.getByTestId('candidate-judgment-empty')).toHaveText('还没有答案或判断。');
    await expect(sheet.getByTestId('candidate-traces-empty')).toBeVisible();
    await expect(sheet.locator('img[alt="题目裁图"]')).toBeVisible();
    await expect(sheet.locator('img[alt="来源页"]')).toBeVisible();
    await expect(sheet.getByRole('checkbox', { name: '勾选这道题' })).not.toBeChecked();
    await screenshot(page, 'intake-detail-legacy.png');
    await page.getByTestId('candidate-detail-close').click();
    await expect(sheet).toBeHidden();
    await expect(unmarked.getByRole('checkbox', { name: '选择第 4 题' })).not.toBeChecked();
    expect(posts.filter(pathname => pathname.includes('/select'))).toEqual([]);
    await unmarked.getByTestId('pick-page').click();
    await expect(unmarked.getByTestId('pick-page')).toHaveText('取消全选');
    await expect(unmarked.getByRole('checkbox')).toHaveCount(3);
    for (const box of await unmarked.getByRole('checkbox').all()) await expect(box).toBeChecked();
    await unmarked.getByTestId('pick-page').click();
    for (const box of await unmarked.getByRole('checkbox').all()) await expect(box).not.toBeChecked();
  } finally { await stop(); }
});
