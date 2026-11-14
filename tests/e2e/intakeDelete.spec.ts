/** Intake delete: select-all still only adds; candidates can be removed without filing; filed questions confirm before delete; swipe still deletes. */
import sharp from 'sharp';
import { expect, test, type Page } from '@playwright/test';
import { materialGateway } from '../helpers/materialGateway.js';

test.use({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });

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

async function uploadOne(page: Page, file: { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
  await page.locator('#library-input:visible').setInputFiles(file);
  await expect.poll(() => new URL(page.url()).pathname).toBe('/s/new');
}

const openSheet = (page: Page) => page.locator('ion-action-sheet:not(.overlay-hidden)').last();
const sheetButton = (page: Page, name: string) => openSheet(page).getByRole('button', { name, exact: true });

test('select-all still only adds, candidates delete without filing, filed questions confirm, and swipe still deletes', async ({ page }) => {
  test.setTimeout(120_000);
  const g = await materialGateway({ pages: [{ parts: [
    { role: 'question', number: '1', text: '1. KEEP-CANDIDATE 计算 1+1。' },
    { role: 'question', number: '2', text: '2. DROP-CANDIDATE 计算 2+2。' },
    { role: 'question', number: '3', text: '3. FILED-VISIBLE 计算 3+3。' },
    { role: 'teacher_mark', number: '3', text: '×' },
    { role: 'question', number: '4', text: '4. FILED-SWIPE 计算 4+4。' },
    { role: 'teacher_mark', number: '4', text: '×' },
  ] }] });
  const posts: { path: string; body: string }[] = [];
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    const path = new URL(request.url()).pathname;
    if (/\/select$|\/dismiss-candidates$|\/items\/discard$/.test(path)) posts.push({ path, body: request.postData() ?? '' });
  });
  try {
    await login(page, g.base, g.codes[0]!);
    await uploadOne(page, await jpeg({ r: 210, g: 220, b: 230 }));
    await expect.poll(async () => (await g.snapshot()).material_job!.every(job => !['running', 'queued'].includes(String(job.state)))).toBe(true);
    const photo = page.locator('section.intake-photo');
    await expect(photo.getByText('KEEP-CANDIDATE')).toBeVisible({ timeout: 20_000 });
    await expect(photo.getByTestId('pick-candidate')).toHaveCount(2);
    await expect(photo.getByTestId('intake-question')).toHaveCount(2);
    expect((await g.snapshot()).error_item!.some(item => String(item.text_excerpt).includes('DROP-CANDIDATE'))).toBe(false);

    await photo.getByTestId('pick-page').click();
    await expect(photo.getByTestId('pick-page')).toHaveText('取消全选');
    await expect(photo.getByTestId('pick-submit')).toHaveText('加入 2 道');
    await expect(photo.getByTestId('candidate-delete-selected')).toHaveText('删除所选');
    for (const box of await photo.getByTestId('pick-checkbox').all()) await expect(box).toBeChecked();
    expect(posts).toEqual([]);
    await photo.getByTestId('pick-page').click();
    await expect(photo.getByTestId('pick-submit')).toHaveText('加入');
    await expect(photo.getByTestId('pick-submit')).toHaveAttribute('aria-disabled', 'true');
    expect(posts).toEqual([]);

    const drop = photo.locator('[data-testid="pick-candidate"]', { hasText: 'DROP-CANDIDATE' });
    await drop.getByTestId('candidate-delete').click();
    await expect(openSheet(page)).toContainText('不会加入错题本');
    await sheetButton(page, '取消').click();
    await expect(drop).toBeVisible();
    expect(posts).toEqual([]);
    expect(new URL(page.url()).pathname).toBe('/s/new');

    await drop.getByTestId('candidate-delete').click();
    await expect(openSheet(page)).toContainText('不会加入错题本');
    await sheetButton(page, '删除').click();
    await expect(drop).toHaveCount(0);
    await expect(photo.getByText('KEEP-CANDIDATE')).toBeVisible();
    await expect.poll(() => posts.some(entry => entry.path.endsWith('/dismiss-candidates'))).toBe(true);
    expect(posts.some(entry => entry.path.endsWith('/select'))).toBe(false);
    expect((await g.snapshot()).error_item!.some(item => String(item.text_excerpt).includes('DROP-CANDIDATE'))).toBe(false);
    expect((await g.snapshot()).error_item!.some(item => String(item.text_excerpt).includes('KEEP-CANDIDATE'))).toBe(false);

    const keep = (await g.snapshot()).material_question!.find(question => question.number === '1')!;
    await photo.getByTestId('pick-page').click();
    await expect(photo.getByTestId('pick-submit')).toHaveText('加入 1 道');
    await photo.getByTestId('pick-submit').click();
    await expect.poll(() => posts.filter(entry => entry.path.endsWith('/select')).length).toBe(1);
    expect(posts.find(entry => entry.path.endsWith('/select'))!.body).toContain(String(keep.id));
    expect(posts.filter(entry => entry.path.endsWith('/dismiss-candidates'))).toHaveLength(1);
    await expect(photo.getByTestId('pick-candidate')).toHaveCount(0);
    await expect(photo.getByText('KEEP-CANDIDATE')).toBeVisible();
    expect((await g.snapshot()).error_item!.some(item => String(item.text_excerpt).includes('KEEP-CANDIDATE'))).toBe(true);
    expect((await g.snapshot()).error_item!.some(item => String(item.text_excerpt).includes('DROP-CANDIDATE'))).toBe(false);

    const visible = page.locator('ion-item-sliding', { hasText: 'FILED-VISIBLE' });
    await visible.getByTestId('question-delete').click();
    await expect(openSheet(page)).toContainText('移出错题本');
    await sheetButton(page, '取消').click();
    await expect(visible).toBeVisible();
    expect(posts.some(entry => entry.path.endsWith('/items/discard'))).toBe(false);
    expect(new URL(page.url()).pathname).toBe('/s/new');
    await visible.getByTestId('question-delete').click();
    await sheetButton(page, '删除').click();
    await expect(page.getByText('FILED-VISIBLE')).toHaveCount(0);
    await expect.poll(() => posts.some(entry => entry.path.endsWith('/items/discard'))).toBe(true);

    const swipe = page.locator('ion-item-sliding', { hasText: 'FILED-SWIPE' });
    const discards = () => posts.filter(entry => entry.path.endsWith('/items/discard')).length;
    const beforeSwipe = discards();
    await swipe.evaluate(async element => {
      const sliding = element as HTMLElement & { open: (side: string) => Promise<void> };
      await sliding.open('end');
    });
    await swipe.getByTestId('question-swipe-delete').click();
    await expect(page.getByText('FILED-SWIPE')).toHaveCount(0);
    await expect.poll(discards).toBe(beforeSwipe + 1);

    await page.getByTestId('intake-done').click();
    await expect(page.getByText('KEEP-CANDIDATE')).toBeVisible();
    await expect(page.getByText('DROP-CANDIDATE')).toHaveCount(0);
    await expect(page.getByText('FILED-VISIBLE')).toHaveCount(0);
    await expect(page.getByText('FILED-SWIPE')).toHaveCount(0);
  } finally { await g.close(); }
});

test('selected candidates can be deleted together, and cancelling the confirm sheet leaves them unfiled', async ({ page }) => {
  test.setTimeout(120_000);
  const g = await materialGateway({ pages: [{ parts: [
    { role: 'question', number: '1', text: '1. BATCH-ONE 计算 3+3。' },
    { role: 'question', number: '2', text: '2. BATCH-TWO 计算 4+4。' },
  ] }] });
  const posts: string[] = [];
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    const path = new URL(request.url()).pathname;
    if (/\/select$|\/dismiss-candidates$/.test(path)) posts.push(path);
  });
  try {
    await login(page, g.base, g.codes[0]!);
    await uploadOne(page, await jpeg({ r: 180, g: 210, b: 190 }));
    await expect.poll(async () => (await g.snapshot()).material_job!.every(job => !['running', 'queued'].includes(String(job.state)))).toBe(true);
    const photo = page.locator('section.intake-photo');
    await expect(photo.getByTestId('pick-candidate')).toHaveCount(2, { timeout: 20_000 });
    await photo.getByTestId('pick-page').click();
    await expect(photo.getByTestId('pick-page')).toHaveText('取消全选');
    await expect(photo.getByTestId('pick-submit')).toHaveText('加入 2 道');
    expect(posts).toEqual([]);
    await photo.getByTestId('candidate-delete-selected').click();
    await expect(openSheet(page)).toContainText('不会加入错题本');
    await sheetButton(page, '取消').click();
    await expect(photo.getByTestId('pick-candidate')).toHaveCount(2);
    expect(posts).toEqual([]);
    await photo.getByTestId('candidate-delete-selected').click();
    await expect(openSheet(page)).toContainText('不会加入错题本');
    await sheetButton(page, '删除').click();
    await expect(photo.getByTestId('pick-candidate')).toHaveCount(0);
    await expect.poll(() => posts.some(path => path.endsWith('/dismiss-candidates'))).toBe(true);
    expect(posts.some(path => path.endsWith('/select'))).toBe(false);
    const items = (await g.snapshot()).error_item ?? [];
    expect(items.some(item => String(item.text_excerpt).includes('BATCH-'))).toBe(false);
    expect(items).toHaveLength(0);
  } finally { await g.close(); }
});
