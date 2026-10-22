/**
 * Material-sourced questions through the whole practice loop: photo capture -> include
 * into the notebook -> online practice (per-item result) -> whole-task photo check ->
 * confirm. Real invitation gateway and SSR; model replies are synthetic (mock mode).
 */
import sharp from 'sharp';
import { expect, test, type Page } from '@playwright/test';
import { materialGateway, type MaterialGateway } from '../helpers/materialGateway.js';
test.use({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
test.setTimeout(120000);

const jpeg = (text: string) => sharp(Buffer.from(`<svg width="780" height="1000"><rect width="100%" height="100%" fill="white"/><text x="50" y="100" font-size="24">${text}</text></svg>`)).jpeg().toBuffer();
const marked = (n: string, q: string) => [{ role: 'question' as const, number: n, text: `${n}. ${q}` }, { role: 'student_work' as const, number: n, text: `${n}. 合成作答` }, { role: 'teacher_mark' as const, number: n, text: '×' }];
async function settled(g: MaterialGateway) { await expect.poll(async () => (await g.snapshot()).material_job!.every(j => !['running', 'queued'].includes(j.state)), { timeout: 30000 }).toBe(true); }
async function noServerError(page: Page) { await expect(page.locator('body')).not.toContainText('服务器暂时没处理好'); }

test('material questions: capture -> include -> practice -> per-item result -> photo check -> confirm', async ({ page }) => {
  const g = await materialGateway({ pages: [{ parts: [...marked('1', 'Solve x + 1 = 3'), ...marked('2', 'Solve y + 2 = 5'), { role: 'question', number: '3', text: '3. Solve z - 1 = 4' }, { role: 'student_work', number: '3', text: '3. z=5' }] }] });
  try {
    await page.goto(g.base + '/s/');
    await page.getByLabel('12 位邀请码').fill(g.codes[0]!);
    await page.getByRole('button', { name: '进入我的错题本' }).click();
    // #54：新账号第一次进入先选学段。
    await page.getByRole('button', { name: '初中', exact: true }).click();
    await page.goto(g.base + '/s/capture');
    await page.locator('#library-input').setInputFiles({ name: 'paper.jpg', mimeType: 'image/jpeg', buffer: await jpeg('SYNTHETIC 1/2/3') });
    await expect(page.getByText('照片已保存，可以先离开', { exact: true })).toBeVisible({ timeout: 30000 });
    await settled(g);

    // Marked questions are included automatically; the unmarked one is included by the student.
    expect((await g.snapshot()).error_item).toHaveLength(2);
    await page.goto(g.base + '/s/materials');
    await page.getByRole('link', { name: '第 3 题', exact: true }).click();
    await page.getByRole('button', { name: '收录到错题本', exact: true }).click();
    await expect.poll(async () => (await g.snapshot()).error_item!.length).toBe(3);

    await page.goto(g.base + '/s/practices');
    await page.getByRole('button', { name: /就练这 3 道/ }).click();
    await page.waitForURL(/\/s\/practice\/pkt_/);
    const pid = page.url().match(/pkt_[^/?]+/)![0];
    await expect(page.getByTestId('practice-question')).toBeVisible({ timeout: 60000 });

    // Tapping a question number / "done, check myself" must work for material items.
    const items = (await g.snapshot()).error_item!;
    expect((await page.request.get(g.base + `/s/practice/${pid}?item=${items[0]!.id}`)).status()).toBe(200);
    await page.getByRole('link', { name: '这道做完了，自己核对' }).click();
    await noServerError(page);
    await page.getByRole('link', { name: '不上传，直接核对' }).click();
    await noServerError(page);
    await page.getByRole('button', { name: '做对了' }).click();
    await noServerError(page);
    await expect(page.locator('main')).toContainText('已记录 1 道结果');
    expect((await g.snapshot()).review_attempt).toHaveLength(1);

    // Whole-task photo submission and check.
    await page.goto(g.base + `/s/practice/${pid}/submit`);
    await page.locator('#library-input').setInputFiles({ name: 'work.jpg', mimeType: 'image/jpeg', buffer: await jpeg('1. x=2  2. y=3  3. z=5') });
    await expect(page.getByRole('heading', { name: '已保存 1 张' })).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: '照片交齐了，查看反馈' }).click();
    await noServerError(page);
    const outcomes = page.locator('#submission-confirm select[name^="outcome_"]');
    await expect.poll(async () => { await page.goto(g.base + `/s/practice/${pid}/feedback`); return outcomes.count(); }, { timeout: 30000 }).toBe(2);
    await expect(page.locator('main')).not.toContainText('这次没能完成核对');
    for (let i = 0; i < 2; i++) await outcomes.nth(i).selectOption(i === 0 ? 'correct' : 'incorrect');
    await page.locator('#submission-confirm select[name="help"]').selectOption('independent');
    await page.getByRole('button', { name: '确认以上结果' }).click();
    await noServerError(page);
    await expect(page.locator('main')).toContainText('已记录 3 道结果');

    const final = await g.snapshot();
    expect(final.review_attempt).toHaveLength(3);
    // Same-day correct answers never count as mastery.
    expect(final.error_item!.map(i => i.status).sort()).toEqual(['attempted', 'attempted', 'needs_recheck']);
    expect((await page.request.get(g.base + `/s/practice/${pid}?item=${items[1]!.id}&view=check`)).status()).toBe(200);
  } finally { await g.close(); }
});
