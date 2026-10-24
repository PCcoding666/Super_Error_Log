/** P0-4 / P0-5 / P1-2 browser flows on the real invitation gateway. Model replies are synthetic; no real names or photos. */
import sharp from 'sharp';
import { expect, test, type Page } from '@playwright/test';
import { materialGateway, type MaterialGateway } from '../helpers/materialGateway.js';
test.use({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
test.setTimeout(120000);

async function enter(page: Page, g: MaterialGateway, stage: '初中' | '高中' = '高中') {
  await page.goto(g.base + '/s/');
  await page.getByLabel('12 位邀请码').fill(g.codes[0]!);
  await page.getByRole('button', { name: '进入我的错题本' }).click();
  // A new account picks its stage once before the notebook.
  await expect(page.getByRole('heading', { name: '你现在读初中还是高中？' })).toBeVisible();
  await expect(page.getByTestId('stage-subjects')).toHaveText('目前只支持数学、物理、化学。');
  await page.getByRole('button', { name: stage, exact: true }).click();
  await expect(page.getByTestId('subject-switch')).toBeVisible();
  await page.goto(g.base + '/s/');
  await expect(page.getByRole('heading', { name: '你现在读初中还是高中？' })).toHaveCount(0);
}
async function photo(page: Page, text: string) {
  await page.goto(page.url().replace(/\/s\/.*$/, '/s/capture?legacy=1'));
  const svg = `<svg width="780" height="1000"><rect width="100%" height="100%" fill="white"/><text x="50" y="100" font-size="24">${text}</text></svg>`;
  await page.locator('#library-input').setInputFiles({ name: 'synthetic.jpg', mimeType: 'image/jpeg', buffer: await sharp(Buffer.from(svg)).jpeg().toBuffer() });
  await expect(page.getByText('照片已保存，可以先离开', { exact: true })).toBeVisible();
}
async function settled(g: MaterialGateway) {
  await expect.poll(async () => (await g.snapshot()).material_job!.every(j => !['running', 'queued'].includes(j.state))).toBe(true);
}

test('new account picks 高中, sees what was not included and includes a whole page or ticked questions', async ({ page }) => {
  const g = await materialGateway({ pages: [
    { parts: [
      { role: 'question', number: '1', text: '1. 已知函数 f(x)=x²，求 f(2)。（6分）' }, { role: 'teacher_mark', number: '1', text: '-6' },
      { role: 'question', number: '2', text: '2. 解方程 2x+1=5。' }, { role: 'question', number: '3', text: '3. 求椭圆的离心率。' },
    ] },
    { parts: [{ role: 'question', number: '4', text: '4. 计算 3+4。' }, { role: 'question', number: '5', text: '5. 计算 5+6。' }] },
  ] });
  try {
    await enter(page, g);
    await photo(page, 'PAGE ONE');
    await settled(g);
    await page.goto(g.base + '/s/materials');
    // The "-6" deduction is included automatically; the other two wait for one tap.
    const metas = page.getByTestId('material-question-meta');
    await expect(metas.filter({ hasText: '求 f(2)' })).toContainText('数学');
    await expect(metas.filter({ hasText: '求 f(2)' })).toContainText('已收录');
    await expect(metas.filter({ hasText: '解方程 2x+1=5。' })).toContainText('未收录');
    await expect(page.getByText('照片 1：本页还有 2 道没收录')).toBeVisible();
    // The notebook points back to the questions waiting to be included.
    await page.goto(g.base + '/s/items');
    await expect(page.getByTestId('material-intake')).toContainText('还有 2 道题没收进错题本');
    await page.getByRole('link', { name: /还有 2 道题没收进错题本/ }).click();
    await page.getByRole('button', { name: '本页 2 道全部收录' }).click();
    await expect(page.getByTestId('include-done')).toContainText('已收进错题本 2 道。');
    await expect(page.getByTestId('material-pending')).toHaveCount(0);
    await expect(page.getByTestId('material-inclusion').filter({ hasText: '未收录' })).toHaveCount(0);
    // Second page: tick one question only.
    await photo(page, 'PAGE TWO');
    await settled(g);
    await page.goto(g.base + '/s/materials');
    await expect(page.getByText('照片 2：本页还有 2 道没收录')).toBeVisible();
    await page.getByRole('checkbox', { name: /第 4 题/ }).check();
    await page.getByRole('button', { name: '收录勾选的题' }).click();
    await expect(page.getByTestId('include-done')).toContainText('已收进错题本 1 道。');
    await expect(page.getByText('照片 2：本页还有 1 道没收录')).toBeVisible();
    const state = await g.snapshot();
    expect(state.error_item).toHaveLength(4);
    await page.getByRole('link', { name: '去错题本看看 ›' }).click();
    await expect(page.locator('.page-subtitle')).toContainText('高中 · 4 道错题');
    // 高中 keeps the AI chapter text instead of folding it into a junior chapter.
    expect(state.error_item!.every(i => i.subject === '数学')).toBe(true);
  } finally { await g.close(); }
});

test('failed photos are summarized at the top and re-extracted in one tap; the page refreshes itself while working', async ({ page }) => {
  const g = await materialGateway({ pages: [
    { failOnce: true, delayMs: 1500, parts: [{ role: 'question', number: '1', text: '1. 计算 1+1。' }, { role: 'teacher_mark', number: '1', text: '×' }] },
  ] });
  try {
    await enter(page, g, '初中');
    await photo(page, 'FAILS ONCE');
    await settled(g);
    await page.goto(g.base + '/s/items');
    await expect(page.getByTestId('material-intake')).toContainText('1 张照片没整理成功');
    await page.goto(g.base + '/s/materials');
    const failed = page.getByTestId('material-failed');
    await expect(failed).toContainText('1 张照片没整理成功，原图已保留。');
    await expect(page.getByTestId('material-done')).toHaveCount(0);
    await failed.getByRole('button', { name: '一键重新整理' }).click();
    await expect(page.getByTestId('include-done')).toContainText('已重新开始整理 1 张照片。');
    // While the retry runs the page polls; the result appears without a manual refresh.
    await expect(page.getByTestId('material-status')).toContainText('正在整理 1 张照片');
    await expect(page.getByTestId('material-done')).toContainText('照片都整理好了，共找到 1 道题。', { timeout: 30000 });
    await expect(page.getByTestId('material-question-meta')).toContainText('已收录');
    await expect(page.getByTestId('material-failed')).toHaveCount(0);
    expect((await g.snapshot()).error_item).toHaveLength(1);
  } finally { await g.close(); }
});

test('a paper of another subject gets a clear message, no questions and no error', async ({ page }) => {
  const g = await materialGateway({ pages: [{ subject: '英语', parts: [{ role: 'question', number: '1', text: 'Choose the best answer.' }, { role: 'teacher_mark', number: '1', text: '×' }] }] });
  try {
    await enter(page, g);
    await photo(page, 'ENGLISH PAPER');
    await settled(g);
    await page.goto(g.base + '/s/materials');
    await expect(page.getByTestId('material-unsupported')).toContainText('目前只支持数学、物理、化学。');
    await expect(page.getByTestId('material-unsupported')).toContainText('照片 1（英语）不会整理成错题');
    await expect(page.getByTestId('material-failed')).toHaveCount(0);
    const state = await g.snapshot();
    expect(state.material_job!.map(j => j.state)).toEqual(['succeeded']);
    expect(state.material_question).toHaveLength(0);
    expect(state.error_item).toHaveLength(0);
  } finally { await g.close(); }
});
