import { expect, test } from '@playwright/test';
import sharp from 'sharp';
import { materialGateway } from '../helpers/materialGateway.js';

test.use({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
test('first crops are selectable while enrichment runs; picks and pending filing survive polling and reload', async ({ page }, testInfo) => {
  const pages = [{ parts: [{ role: 'question' as const, text: '求 1 + 1 的结果。', number: '1' }] }];
  const g = await materialGateway({ pages, progressStage: 'located' });
  try {
    await page.goto(g.base + '/s/');
    await page.getByLabel('12 位邀请码').fill(g.codes[0]!);
    await page.getByRole('button', { name: '进入我的错题本' }).click();
    await page.getByRole('button', { name: '初中', exact: true }).click();
    await expect(page.getByTestId('empty-notebook')).toBeVisible();
    const start = Date.now();
    await page.locator('#library-input:visible').setInputFiles({ name: 'synthetic.jpg', mimeType: 'image/jpeg', buffer: await sharp({ create: { width: 240, height: 320, channels: 3, background: '#fff' } }).jpeg().toBuffer() });
    const candidate = page.getByTestId('pick-candidate');
    await expect(candidate).toHaveCount(1);
    await expect(candidate).toContainText('待识别');
    await expect(page.getByText('这页没有批改痕迹，勾出做错的题', { exact: true })).toHaveCount(0);
    await expect.poll(() => candidate.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    await expect(candidate.getByTestId('pick-checkbox')).toBeEnabled();
    const firstSelectableMs = Date.now() - start;
    expect(firstSelectableMs).toBeLessThan(30_000); // Synthetic, not a real-model P50.
    await testInfo.attach('first-selectable-timing', { body: JSON.stringify({ firstSelectableMs, firstBatchCount: 1, synthetic: true }), contentType: 'application/json' });
    await candidate.getByTestId('pick-checkbox').click();
    await g.configure({ pages, progressStage: 'read' });
    await expect(candidate).toContainText('求 1 + 1 的结果。', { timeout: 10000 });
    await expect(candidate).toContainText('校验中');
    await expect(candidate.getByTestId('pick-checkbox')).toBeChecked();
    expect((await g.snapshot()).error_item).toHaveLength(0);
    await page.getByTestId('pick-submit').click();
    await expect(candidate).toContainText('已选，校验通过后加入');
    await page.reload();
    await expect(candidate).toContainText('已选，校验通过后加入');
    await expect(candidate.getByTestId('pick-checkbox')).toBeChecked();
    expect((await g.snapshot()).error_item).toHaveLength(0);
    await g.configure({ pages, progressStage: 'done' });
    await expect(page.getByTestId('intake-question')).toHaveCount(1, { timeout: 15000 });
    await expect(candidate).toHaveCount(0);
    expect((await g.snapshot()).error_item).toHaveLength(1);
  } finally { await g.close(); }
});

test('terminal uncertain selection explains why it was not filed and how to recover', async ({ page }) => {
  const pages = [{ parts: [{ role: 'question' as const, text: '看不清的条件', number: '1', check: 'low' as const, uncertainties: ['blurry'] }] }];
  const g = await materialGateway({ pages, progressStage: 'located' });
  try {
    await page.goto(g.base + '/s/');
    await page.getByLabel('12 位邀请码').fill(g.codes[0]!);
    await page.getByRole('button', { name: '进入我的错题本' }).click();
    await page.getByRole('button', { name: '初中', exact: true }).click();
    await expect(page.getByTestId('empty-notebook')).toBeVisible();
    await page.locator('#library-input:visible').setInputFiles({name:'synthetic.jpg',mimeType:'image/jpeg',buffer:await sharp({create:{width:240,height:320,channels:3,background:'#fff'}}).jpeg().toBuffer()});
    const candidate = page.getByTestId('pick-candidate');
    await candidate.getByTestId('pick-checkbox').click();
    await page.getByTestId('pick-submit').click();
    await g.configure({pages,progressStage:'done'});
    await expect(candidate).toContainText('暂未收录');
    await expect(candidate).toContainText('补拍');
    await expect(candidate).not.toContainText('校验通过后加入');
    await candidate.getByTestId('candidate-detail').click();
    const sheet = page.getByTestId('candidate-detail-sheet');
    await expect(sheet).toContainText('暂未收录');
    await expect(sheet).toContainText('补拍');
    await expect(sheet).not.toContainText('校验通过后会加入');
    expect((await g.snapshot()).error_item).toHaveLength(0);
  } finally { await g.close(); }
});
