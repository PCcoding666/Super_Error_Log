/** Intake list presentation: outcome copy, wrong-row focus, and clearance above the fixed bar. */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { expect, test, type Page } from '@playwright/test';
import { materialGateway } from '../helpers/materialGateway.js';

test.use({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });

const questions = Array.from({ length: 8 }, (_, index) => ({
  role: 'question' as const,
  number: String(index + 1),
  text: `${index + 1}. 计算 ${index + 1}+${index + 1}。`,
  ...(index === 7 ? { check: 'low' as const, uncertainties: ['edge_cut'] } : {}),
}));

async function jpeg(): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  return { name: 'synthetic.jpg', mimeType: 'image/jpeg', buffer: await sharp({ create: { width: 240, height: 320, channels: 3, background: '#d7e4f5' } }).jpeg().toBuffer() };
}

async function login(page: Page, base: string, code: string): Promise<void> {
  await page.goto(base + '/s/');
  await page.getByLabel('12 位邀请码').fill(code);
  await page.getByRole('button', { name: '进入我的错题本' }).click();
  await page.getByRole('button', { name: '初中', exact: true }).click();
  await expect(page.getByTestId('empty-notebook')).toBeVisible();
}

async function upload(page: Page): Promise<void> {
  await page.locator('[data-testid="capture-add"]:visible').last().click();
  await page.getByTestId('capture-mode-single').click();
  await page.locator('#camera-input').setInputFiles(await jpeg());
  await expect.poll(() => new URL(page.url()).pathname).toBe('/s/new');
}

async function scrollIntakeToEnd(page: Page): Promise<void> {
  await page.locator('ion-content.intake').evaluate(async element => {
    const scroller = await (element as HTMLElement & { getScrollElement: () => Promise<HTMLElement> }).getScrollElement();
    scroller.scrollTop = scroller.scrollHeight;
  });
}

async function lastRowClearsTheBar(page: Page): Promise<boolean> {
  await scrollIntakeToEnd(page);
  const row = await page.getByTestId('pick-checkbox').last().boundingBox();
  const bar = await page.locator('.intake-bottom').boundingBox();
  const pad = await page.getByTestId('intake-scroll-pad').boundingBox();
  if (!row || !bar || !pad) return false;
  return row.y >= 0 && row.y + row.height <= bar.y + 1 && pad.height + 1 >= bar.height;
}

test('an eight-question page keeps the last row tappable and does not talk about recognition confidence', async ({ page }) => {
  test.setTimeout(120_000);
  const g = await materialGateway({ pages: [{ parts: questions }] });
  try {
    await login(page, g.base, g.codes[0]!);
    await upload(page);
    const rows = page.getByTestId('pick-candidate');
    await expect(rows).toHaveCount(8, { timeout: 30_000 });
    await expect(page.locator('ion-content.intake')).not.toContainText('不确定');
    await expect(page.getByTestId('candidate-outcome')).toHaveCount(0);
    await expect(page.getByTestId('intake-page-note')).toContainText('勾出做错的题');
    const text = await rows.allTextContents();
    expect(text.findIndex(line => line.includes('第 1 题'))).toBeLessThan(text.findIndex(line => line.includes('第 8 题')));
    expect(text.map(line => line.match(/第 \d+ 题/)?.[0])).toEqual(['第 1 题', '第 2 题', '第 3 题', '第 4 题', '第 5 题', '第 6 题', '第 7 题', '第 8 题']);

    await expect.poll(() => lastRowClearsTheBar(page)).toBe(true);
    await page.getByTestId('pick-checkbox').last().click();
    await expect(page.getByTestId('intake-selected')).toHaveText('已选 1 题');
    await expect(page.getByRole('checkbox', { name: '选择第 8 题' })).toBeChecked();

    await page.getByRole('button', { name: '查看第 8 题的详情' }).click();
    const sheet = page.getByTestId('candidate-detail-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).not.toContainText('不确定');
    await expect(sheet.getByTestId('candidate-uncertain')).toHaveCount(0);
    await page.getByTestId('candidate-detail-close').click();
    await expect(sheet).toBeHidden();

    const before = await page.getByTestId('intake-scroll-pad').evaluate(element => element.getBoundingClientRect().height);
    await page.addStyleTag({ content: '.intake-bottom { padding-bottom: 96px !important; }' });
    await expect.poll(() => page.getByTestId('intake-scroll-pad').evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(before + 40);
    await expect.poll(() => lastRowClearsTheBar(page)).toBe(true);

    await page.locator('[data-testid="capture-add"]:visible').last().click();
    await page.getByTestId('capture-mode-multi').click();
    await page.locator('#camera-input').setInputFiles(await jpeg());
    await expect(page.getByTestId('capture-tray')).toBeVisible();
    await expect.poll(() => lastRowClearsTheBar(page)).toBe(true);
    await expect(page.getByRole('checkbox', { name: '选择第 8 题' })).toBeChecked();
  } finally { await g.close(); }
});

test('wrong verdicts are distinct and come first, and right rows stay off the add path', async ({ page }) => {
  test.setTimeout(120_000);
  await page.route(/\/s\/api\/intake(?:\?|$)/, async route => {
    if (route.request().method() !== 'GET') { await route.continue(); return; }
    const response = await route.fetch();
    const payload = await response.json() as { photos?: Array<{ candidates?: Array<{ label?: string; verdict?: string; preselected?: boolean }> }> };
    for (const photo of payload.photos ?? []) {
      for (const candidate of photo.candidates ?? []) {
        if (candidate.label === '第 1 题') { candidate.verdict = 'partial'; candidate.preselected = true; }
        else if (candidate.label === '第 2 题') candidate.verdict = 'right';
        else if (candidate.label === '第 3 题') candidate.verdict = 'confirm';
        else if (candidate.label === '第 8 题') { candidate.verdict = 'wrong'; candidate.preselected = true; }
      }
    }
    await route.fulfill({ response, json: payload });
  });
  const g = await materialGateway({ pages: [{ parts: questions }] });
  try {
    await login(page, g.base, g.codes[0]!);
    await upload(page);
    const rows = page.getByTestId('pick-candidate');
    await expect(rows).toHaveCount(8, { timeout: 30_000 });
    await expect(page.locator('ion-content.intake')).not.toContainText('不确定');
    await expect(page.getByTestId('intake-page-note')).toContainText('排在前面');
    const text = await rows.allTextContents();
    for (const line of text) {
      expect(line).not.toContain('做错');
      expect(line).not.toContain('做对');
      expect(line).not.toContain('请确认');
    }
    expect(text.map(line => line.match(/第 \d+ 题/)?.[0])).toEqual(['第 1 题', '第 8 题', '第 2 题', '第 3 题', '第 4 题', '第 5 题', '第 6 题', '第 7 题']);

    const focus = page.locator('[data-intake-focus="wrong"]');
    await expect(focus).toHaveCount(2);
    await expect(rows.nth(0)).toHaveClass(/intake-candidate-focus/);
    await expect(rows.nth(1)).toHaveClass(/intake-candidate-focus/);
    await expect(rows.nth(2)).toHaveClass(/intake-candidate-right/);
    await expect(rows.nth(2)).toHaveAttribute('data-verdict', 'right');
    const focusBg = await focus.first().evaluate(element => getComputedStyle(element).backgroundColor);
    const plainBg = await rows.nth(4).evaluate(element => getComputedStyle(element).backgroundColor);
    expect(focusBg).not.toBe(plainBg);
    await page.locator('ion-content.intake').evaluate(async element => {
      const scroller = await (element as HTMLElement & { getScrollElement: () => Promise<HTMLElement> }).getScrollElement();
      scroller.scrollTop = 0;
    });
    if (fs.existsSync('/opt/cursor')) {
      fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
      await page.screenshot({ path: path.join('/opt/cursor/artifacts', 'intake-mixed-verdicts.png') });
    }
    const focusBox = await focus.first().boundingBox();
    const bar = await page.locator('.intake-bottom').boundingBox();
    expect(focusBox).toBeTruthy();
    expect(bar).toBeTruthy();
    expect(focusBox!.y + focusBox!.height).toBeLessThanOrEqual(bar!.y + 1);

    await expect(page.getByRole('checkbox', { name: '选择第 1 题' })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: '选择第 8 题' })).toBeChecked();
    await expect(page.getByTestId('intake-selected')).toHaveText('已选 2 题');
    await expect(rows.nth(2).getByTestId('pick-checkbox')).toHaveCount(0);
    await page.getByRole('checkbox', { name: '选择第 8 题' }).click();
    await expect(page.getByRole('checkbox', { name: '选择第 8 题' })).not.toBeChecked();
    await expect(page.getByTestId('intake-selected')).toHaveText('已选 1 题');

    await page.getByRole('button', { name: '查看第 2 题的详情' }).click();
    const sheet = page.getByTestId('candidate-detail-sheet');
    await expect(sheet).not.toContainText('做错');
    await expect(sheet).not.toContainText('做对');
    await expect(sheet).not.toContainText('请确认');
    await expect(sheet).not.toContainText('不确定');
    await expect(sheet.getByTestId('detail-select')).toHaveCount(0);
    await page.getByTestId('candidate-detail-close').click();

    await page.getByRole('button', { name: '查看第 8 题的详情' }).click();
    await expect(sheet).not.toContainText('做错');
    await expect(sheet).not.toContainText('做对');
    await expect(sheet).not.toContainText('请确认');
    await expect(sheet).not.toContainText('不确定');
    await expect(sheet.getByTestId('detail-select')).toBeVisible();
    await page.getByTestId('candidate-detail-close').click();

    await page.getByTestId('pick-submit').click();
    await expect(page.getByTestId('intake-question')).toHaveCount(1, { timeout: 20_000 });
    await expect(page.getByRole('checkbox', { name: '选择第 8 题' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: '选择第 8 题' })).not.toBeChecked();
    await expect(page.locator('[data-verdict="right"]')).toBeVisible();
    await expect(page.locator('[data-verdict="right"]')).not.toContainText('做对');
  } finally { await g.close(); }
});
