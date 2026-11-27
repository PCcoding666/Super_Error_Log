/** Intake delete: select-all still only adds; candidates can be removed without filing; filed questions confirm before delete; swipe still deletes.
 * A grouped card that spans photos dismisses every selected row, one request per photo. */
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
  await page.locator('[data-testid="capture-add"]:visible').last().click();
  await page.getByTestId('capture-mode-single').click();
  await page.locator('#camera-input').setInputFiles(file);
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

async function uploadPaperAndSheet(page: Page): Promise<void> {
  await page.locator('[data-testid="capture-add"]:visible').last().click();
  await expect(page.getByTestId('capture-mode-sheet')).toBeVisible();
  await page.getByTestId('capture-mode-multi').click();
  const camera = page.locator('#camera-input');
  await camera.setInputFiles(await jpeg({ r: 200, g: 180, b: 160 }));
  await expect(page.getByTestId('capture-count')).toHaveText('已拍 1 张');
  await camera.setInputFiles(await jpeg({ r: 160, g: 190, b: 210 }));
  await expect(page.getByTestId('capture-count')).toHaveText('已拍 2 张');
  await page.getByTestId('capture-page').nth(0).getByRole('button', { name: '试卷', exact: true }).click();
  await page.getByTestId('capture-page').nth(1).getByRole('button', { name: '答题卡', exact: true }).click();
  await page.getByTestId('capture-set-done').click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/s/new');
}

type Row = Record<string, unknown>;
function stemOf(snapshot: Record<string, Row[] | undefined>, text: string): { questionId: string; photoId: string } {
  const fragment = (snapshot.material_fragment ?? []).find(row => String(row.content_json).includes(text));
  if (!fragment) throw new Error(`missing synthetic stem ${text}`);
  const link = [...(snapshot.material_link_event ?? [])].reverse().find(row => row.fragment_id === fragment.id && row.question_id);
  if (!link?.question_id) throw new Error(`missing link for ${text}`);
  return { questionId: String(link.question_id), photoId: String(fragment.asset_id) };
}

test('a grouped card dismisses selected rows on every photo, and per-row delete removes only that row', async ({ page }) => {
  test.setTimeout(180_000);
  const g = await materialGateway({ pages: [
    { parts: [
      { role: 'question', number: '5', subpart: '(1)', text: 'CROSS-ONE 计算 1+1。' },
      { role: 'question', number: '5', subpart: '(3)', text: 'CROSS-KEEP 计算 3+3。' },
    ] },
    { parts: [
      { role: 'question', number: '5', subpart: '(2)', text: 'CROSS-TWO 计算 2+2。' },
    ] },
  ] });
  const posts: { path: string; body: string }[] = [];
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    const path = new URL(request.url()).pathname;
    if (/\/select$|\/dismiss-candidates$/.test(path)) posts.push({ path, body: request.postData() ?? '' });
  });
  const intakeGate: { release: (() => void) | null } = { release: null };
  let holdNextIntake = false;
  await page.route(/\/s\/api\/intake(?:\?|$)/, async route => {
    if (holdNextIntake && route.request().method() === 'GET') {
      holdNextIntake = false;
      await new Promise<void>(resolve => { intakeGate.release = () => resolve(); });
    }
    await route.continue();
  });
  const dismisses = () => posts.filter(entry => entry.path.endsWith('/dismiss-candidates'));
  const photoOf = (path: string) => path.match(/\/photos\/([^/]+)\/dismiss-candidates$/)?.[1] ?? '';
  try {
    await login(page, g.base, g.codes[0]!);
    await uploadPaperAndSheet(page);
    await expect.poll(async () => (await g.snapshot()).material_job!.every(job => !['running', 'queued'].includes(String(job.state))), { timeout: 60_000 }).toBe(true);
    const card = page.getByTestId('intake-question-card');
    await expect(card).toHaveCount(1, { timeout: 20_000 });
    await expect(card).toHaveAttribute('data-question', '第 5 题');
    await expect(card.getByTestId('pick-candidate')).toHaveCount(3);
    const placed = await g.snapshot();
    const one = stemOf(placed, 'CROSS-ONE');
    const keep = stemOf(placed, 'CROSS-KEEP');
    const two = stemOf(placed, 'CROSS-TWO');
    expect(new Set([one.photoId, two.photoId]).size).toBe(2);
    expect(keep.photoId).toBe(one.photoId);
    expect(one.photoId).not.toBe(two.photoId);

    await card.getByTestId('pick-page').click();
    await expect(card.getByTestId('pick-page')).toHaveText('取消全选');
    await expect(card.getByTestId('pick-submit')).toHaveText('加入 3 道');
    expect(posts).toEqual([]);
    await card.getByTestId('candidate-delete-selected').click();
    await expect(openSheet(page)).toContainText('去掉这 3 道还没加入的题');
    await expect(openSheet(page)).toContainText('不会加入错题本');
    await sheetButton(page, '取消').click();
    await expect(card.getByTestId('pick-candidate')).toHaveCount(3);
    expect(posts).toEqual([]);
    expect((await g.snapshot()).error_item ?? []).toHaveLength(0);

    const drop = card.locator('[data-testid="pick-candidate"]', { hasText: 'CROSS-KEEP' });
    await drop.getByTestId('candidate-delete').click();
    await expect(openSheet(page)).toContainText('去掉这道还没加入的题');
    await expect(openSheet(page)).toContainText('不会加入错题本');
    await sheetButton(page, '取消').click();
    await expect(drop).toBeVisible();
    expect(posts).toEqual([]);
    await drop.getByTestId('candidate-delete').click();
    await sheetButton(page, '删除').click();
    await expect(card.getByText('CROSS-KEEP')).toHaveCount(0);
    await expect(card.getByText('CROSS-ONE')).toBeVisible();
    await expect(card.getByText('CROSS-TWO')).toBeVisible();
    await expect.poll(() => dismisses().length).toBe(1);
    expect(photoOf(dismisses()[0]!.path)).toBe(keep.photoId);
    expect(dismisses()[0]!.body).toContain(keep.questionId);
    expect(dismisses()[0]!.body).not.toContain(one.questionId);
    expect(dismisses()[0]!.body).not.toContain(two.questionId);
    expect(posts.some(entry => entry.path.endsWith('/select'))).toBe(false);

    // Select-all from the cancel step is still on. Another click would clear the two rows that remain.
    await expect(card.getByTestId('pick-submit')).toHaveText('加入 2 道');
    await card.getByTestId('candidate-delete-selected').click();
    await expect(openSheet(page)).toContainText('去掉这 2 道还没加入的题');
    holdNextIntake = true;
    await sheetButton(page, '删除').click();
    await expect.poll(() => dismisses().length).toBe(3);
    await expect.poll(() => intakeGate.release !== null).toBe(true);
    await expect(card.getByTestId('pick-candidate')).toHaveCount(0);
    const bulk = dismisses().slice(1);
    expect(new Set(bulk.map(entry => photoOf(entry.path)))).toEqual(new Set([one.photoId, two.photoId]));
    expect(bulk.find(entry => photoOf(entry.path) === one.photoId)!.body).toContain(one.questionId);
    expect(bulk.find(entry => photoOf(entry.path) === two.photoId)!.body).toContain(two.questionId);
    expect(posts.some(entry => entry.path.endsWith('/select'))).toBe(false);
    intakeGate.release?.();
    await expect(card.getByText('CROSS-ONE')).toHaveCount(0);
    await expect(card.getByText('CROSS-TWO')).toHaveCount(0);
    const after = await g.snapshot();
    expect(after.error_item ?? []).toHaveLength(0);
    const excluded = (after.material_inclusion ?? []).filter(row => Number(row.included) === 0).map(row => String(row.question_id));
    expect(new Set(excluded)).toEqual(new Set([one.questionId, keep.questionId, two.questionId]));
  } finally {
    intakeGate.release?.();
    await g.close();
  }
});

test('a dismiss response that removes nothing keeps the row and says so', async ({ page }) => {
  test.setTimeout(120_000);
  const g = await materialGateway({ pages: [{ parts: [
    { role: 'question', number: '1', text: '1. STAY-CANDIDATE 计算 6+6。' },
  ] }] });
  const posts: string[] = [];
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    const path = new URL(request.url()).pathname;
    if (/\/select$|\/dismiss-candidates$/.test(path)) posts.push(path);
  });
  await page.route(/\/dismiss-candidates$/, async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ removed: [], failed: [{ id: 'synthetic', message: '这道题已经不在待选列表里，请刷新后再试。' }] }),
    });
  });
  try {
    await login(page, g.base, g.codes[0]!);
    await uploadOne(page, await jpeg({ r: 190, g: 170, b: 200 }));
    await expect.poll(async () => (await g.snapshot()).material_job!.every(job => !['running', 'queued'].includes(String(job.state)))).toBe(true);
    const photo = page.locator('section.intake-photo');
    const row = photo.locator('[data-testid="pick-candidate"]', { hasText: 'STAY-CANDIDATE' });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.getByTestId('candidate-delete').click();
    await expect(openSheet(page)).toContainText('不会加入错题本');
    await sheetButton(page, '删除').click();
    await expect(row).toBeVisible();
    await expect.poll(() => posts.some(path => path.endsWith('/dismiss-candidates'))).toBe(true);
    expect(posts.some(path => path.endsWith('/select'))).toBe(false);
    const toastText = async (): Promise<string> => {
      const toasts = page.locator('ion-toast');
      const messages: string[] = [];
      for (let index = 0; index < await toasts.count(); index += 1) messages.push(await toasts.nth(index).evaluate(element => (element as { message?: string }).message ?? ''));
      return messages.join('\n');
    };
    await expect.poll(toastText).toContain('没有去掉，还在列表里');
    await expect.poll(toastText).toContain('请刷新后再试');
    expect((await g.snapshot()).error_item ?? []).toHaveLength(0);
    expect((await g.snapshot()).material_inclusion ?? []).toHaveLength(0);
  } finally { await g.close(); }
});
