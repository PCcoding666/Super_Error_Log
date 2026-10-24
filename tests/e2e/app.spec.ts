/**
 * 学生端单页应用（client/，Ionic React）在旧流程合成服务器（webClientServer，3196）上的主流程：
 * 配对 → 拍照 → 录入态（自动收录、勾选候选）→ 错题本（列表 / 网格 / 选择移除 / 撤销 / 搜索）→ 详情（改分类）→ 设置。
 */
import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';

const WEB = 'http://127.0.0.1:3196';
const CONTROL = 'http://127.0.0.1:3197';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: IPHONE, locale: 'zh-CN', serviceWorkers: 'block' });
test.describe.configure({ mode: 'serial' });

let shade = 0;
async function synthetic(color: string): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  shade += 1;
  const width = 860 + shade * 7;
  return { name: `page-${shade}.jpg`, mimeType: 'image/jpeg', buffer: await sharp({ create: { width, height: Math.round(width * 1.35), channels: 3, background: color } }).jpeg({ quality: 85 }).toBuffer() };
}

async function pair(page: Page): Promise<void> {
  const { link } = await (await fetch(`${CONTROL}/pairing-link`)).json() as { link: string };
  await page.goto(link.replace('https://study.pccoding666.com', WEB));
  await page.getByTestId('next-step-primary').click();
  await page.waitForURL(/\/s\/\?paired=1$/);
}

const url = (page: Page): string => new URL(page.url()).pathname;
/** 在最上面那张 action sheet 里点一项：上一张可能还在收起动画里，不能让两张同时匹配。 */
const pickFromSheet = (page: Page, name: string) => page.locator('ion-action-sheet:not(.overlay-hidden)').last().getByRole('button', { name, exact: true }).click();
/** 打开右上角的视图 / 筛选菜单：等上一次的菜单真的收起，再点。 */
async function openMenu(page: Page): Promise<void> {
  await expect(page.locator('ion-popover.filter-popover')).toBeHidden();
  await page.getByTestId('notebook-filters').click();
  await expect(page.locator('ion-popover.filter-popover')).toBeVisible();
}

test('配对后看到错题本，拍照进入录入态，自动收录的题左滑可删，没批改的页勾选加入', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await pair(page);
  await expect(page.getByTestId('subject-switch')).toContainText('数学');
  await expect(page.getByTestId('next-step-primary')).toBeVisible();
  await expect(page.getByTestId('corner-search')).toBeVisible();
  await expect(page.getByTestId('capture-camera')).toBeVisible();
  await expect(page.getByTestId('capture-album')).toBeVisible();
  const library = page.locator('#library-input');
  const camera = page.locator('#camera-input');
  await expect(library).toHaveAttribute('accept', 'image/*');
  await expect(library).toHaveAttribute('multiple', '');
  await expect(library).not.toHaveAttribute('capture');
  await expect(camera).toHaveAttribute('capture', 'environment');
  await expect(camera).not.toHaveAttribute('multiple');
  // 右下角和空态上的相册框要有真实面积。裁成 1px 再脚本 click()，小米 WebView 不会弹出相册。
  for (const input of [library, page.getByTestId('capture-album').locator('input')]) {
    const box = await input.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(40);
    expect(box?.height ?? 0).toBeGreaterThan(40);
  }
  // 点右下角相册圆钮本身会打开系统选择器，而不是靠脚本去点一个看不见的框。
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    library.click(),
  ]);
  expect(chooser.isMultiple()).toBe(true);
  // 一张有批改痕迹（偏红）、一张没有（偏蓝）。
  await chooser.setFiles([await synthetic('#efb7b2'), await synthetic('#b0d3e0')]);
  await expect.poll(() => url(page)).toBe('/s/new');
  await expect(page.getByTestId('intake-album').locator('input')).not.toHaveAttribute('capture');
  await expect(page.getByTestId('intake-camera').locator('input')).toHaveAttribute('capture', 'environment');
  const intakeAlbum = await page.getByTestId('intake-album').locator('input').boundingBox();
  expect(intakeAlbum?.width ?? 0).toBeGreaterThan(40);
  const marked = page.locator('section.intake-photo[data-state="done"]');
  await expect(marked).toHaveCount(1, { timeout: 40_000 });
  await expect(marked.getByTestId('intake-question')).toHaveCount(3);
  await expect(page.locator('.intake-top p')).toContainText('找到 3 道');
  const unmarked = page.locator('section.intake-photo[data-state="needsPick"]');
  await expect(unmarked).toHaveCount(1);
  await expect(unmarked.getByTestId('pick-candidate')).toHaveCount(3);
  await expect(unmarked.getByTestId('pick-submit')).toHaveAttribute('aria-disabled', 'true');
  await unmarked.getByTestId('pick-candidate').first().click();
  await expect(unmarked.getByTestId('pick-submit')).toHaveText('加入 1 道');
  await unmarked.getByTestId('pick-submit').click();
  await expect(page.locator('section.intake-photo[data-state="done"]')).toHaveCount(2, { timeout: 40_000 });
  await expect(page.locator('.intake-top p')).toContainText('找到 4 道');
  await page.getByTestId('intake-done').click();
  await expect.poll(() => url(page)).toMatch(/^\/s\/?$/);
  await expect(page.getByTestId('item-card')).toHaveCount(4);
  await expect(page.locator('.home-subtitle')).toContainText('4 道错题');
  expect(errors).toEqual([]);
});

test('网格与列表切换、选择移除并撤销、搜索与章节筛选', async ({ page }) => {
  await pair(page);
  await expect(page.getByTestId('item-card')).toHaveCount(4);
  await openMenu(page);
  await page.locator('ion-popover.filter-popover').getByText('网格', { exact: true }).click();
  await expect(page.locator('.notebook-grid [data-testid="item-card"]')).toHaveCount(4);
  await openMenu(page);
  await page.locator('ion-popover.filter-popover').getByText('列表', { exact: true }).click();
  await expect(page.locator('.notebook-list [data-testid="item-card"]')).toHaveCount(4);
  // 选择模式：移除一道，撤销后回来。
  await openMenu(page);
  await page.locator('ion-popover.filter-popover').getByText('选择', { exact: true }).click();
  await expect(page.getByTestId('discard-selected')).toHaveAttribute('aria-disabled', 'true');
  await page.getByTestId('item-card').first().click();
  await expect(page.locator('ion-header')).toContainText('已选 1 道');
  await page.getByTestId('discard-selected').click();
  await page.locator('ion-action-sheet').getByRole('button', { name: '移除', exact: true }).click();
  await expect(page.getByTestId('item-card')).toHaveCount(3);
  await page.getByRole('button', { name: '撤销' }).click();
  await expect(page.getByTestId('item-card')).toHaveCount(4);
  // 搜索只留二次函数。
  await page.getByTestId('corner-search').click();
  await page.locator('ion-searchbar input').fill('二次');
  await expect(page.getByTestId('item-card')).toHaveCount(1);
  await expect(page).toHaveURL(/q=%E4%BA%8C%E6%AC%A1/);
  await page.locator('ion-searchbar').getByRole('button', { name: '取消' }).click();
  await expect(page.getByTestId('item-card')).toHaveCount(4);
  // 章节筛选走菜单；菜单里只有一级标题（章节）和二级标题（知识点），没有练习状态。
  await openMenu(page);
  await expect(page.locator('ion-popover.filter-popover')).not.toContainText('状态');
  await expect(page.getByTestId('tag-filter')).toBeVisible();
  await page.locator('ion-popover.filter-popover').getByText('章节', { exact: true }).click();
  await pickFromSheet(page, '相似三角形');
  await expect(page.getByTestId('item-card')).toHaveCount(1);
  await expect(page.locator('.home-subtitle')).toContainText('显示 1 道');
  // 回到全部章节，再按知识点（二级标题）筛选。
  await openMenu(page);
  await page.locator('ion-popover.filter-popover').getByText('章节', { exact: true }).click();
  await pickFromSheet(page, '全部章节');
  await expect(page.getByTestId('item-card')).toHaveCount(4);
  await openMenu(page);
  await page.getByTestId('tag-filter').click();
  await pickFromSheet(page, '二次函数');
  await expect(page.getByTestId('item-card')).toHaveCount(1);
  await expect(page).toHaveURL(/tag=/);
  await openMenu(page);
  await page.getByTestId('tag-filter').click();
  await pickFromSheet(page, '全部知识点');
  await expect(page.getByTestId('item-card')).toHaveCount(4);
});

test('详情页：照片、题干、你写的、章节可改；移除后回到错题本', async ({ page }) => {
  await pair(page);
  await page.getByTestId('item-card').first().click();
  await expect.poll(() => url(page)).toMatch(/^\/s\/q\/itm_/);
  await expect(page.getByTestId('question-text')).toContainText('解方程');
  await expect(page.locator('.item-photo img')).toHaveCount(1);
  // 详情显示整张上传页，不是题目框裁出来的横条。合成页是竖图，题目框是横条。
  const photo = page.locator('.item-photo img');
  await expect(photo).toHaveAttribute('src', /\/s\/img\/item\/itm_[0-9a-f]+?\?scope=page&s=big$/);
  await expect(page.getByTestId('item-photo-note')).toContainText('整张照片');
  await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.complete && img.naturalHeight > img.naturalWidth && img.naturalWidth > 0)).toBe(true);
  // 大图在应用内打开，左上角有返回；返回后仍在详情页。
  await page.getByTestId('item-photo').click();
  const viewer = page.locator('ion-modal.photo-viewer img');
  await expect(viewer).toBeVisible();
  await expect(viewer).toHaveAttribute('src', /\/s\/img\/item\/itm_[0-9a-f]+?\?scope=page$/);
  await expect.poll(() => viewer.evaluate((img: HTMLImageElement) => img.complete && img.naturalHeight > img.naturalWidth && img.naturalWidth > 0)).toBe(true);
  await page.getByTestId('photo-back').click();
  await expect(page.locator('ion-modal.photo-viewer')).toBeHidden();
  expect(url(page)).toMatch(/^\/s\/q\/itm_/);
  await expect(page.getByTestId('item-chapter')).toContainText('一元一次方程');
  await expect(page.getByTestId('item-tags')).toContainText('一元一次方程');
  await page.getByTestId('item-chapter').click();
  // 修改分类：先从现有章节里选，再手填覆盖。
  await expect(page.locator('ion-modal.show-modal')).not.toContainText('练习状态');
  await page.getByTestId('chapter-picker').click();
  await page.getByRole('radio', { name: '相似三角形' }).click();
  await expect(page.locator('ion-modal.show-modal ion-input input').last()).toHaveValue('相似三角形');
  // 换成物理：章节候选跟着换，原来填的数学章节清掉，不会被当成物理章节存下来。（ion-select 的 action sheet 把选项渲染成 radio）
  await page.locator('ion-modal.show-modal ion-select').filter({ hasText: '学科' }).click();
  await page.locator('ion-action-sheet.select-action-sheet').getByRole('radio', { name: '物理' }).click();
  await expect(page.locator('ion-modal.show-modal ion-input input').last()).toHaveValue('');
  await page.getByTestId('chapter-picker').click();
  await expect(page.getByRole('radio', { name: '相似三角形' })).toHaveCount(0);
  await page.getByRole('radio', { name: '声现象' }).click();
  await expect(page.locator('ion-modal.show-modal ion-input input').last()).toHaveValue('声现象');
  await page.locator('ion-modal.show-modal ion-select').filter({ hasText: '学科' }).click();
  await page.locator('ion-action-sheet.select-action-sheet').getByRole('radio', { name: '数学' }).click();
  await page.getByTestId('chapter-picker').click();
  await page.getByRole('radio', { name: '相似三角形' }).click();
  await page.locator('ion-modal.show-modal ion-input input').last().fill('方程与不等式');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByTestId('item-chapter')).toContainText('方程与不等式');
  await expect(page.locator('.item-title')).toHaveText('方程与不等式');
  await page.getByTestId('item-more').click();
  await page.locator('ion-popover').getByText('不是错题，移除').click();
  await page.locator('ion-action-sheet').getByRole('button', { name: '移除', exact: true }).click();
  await expect.poll(() => url(page)).toMatch(/^\/s\/?$/);
  await expect(page.getByTestId('item-card')).toHaveCount(3);
});

test('设置页：学段、练习即将推出、添加到主屏幕；刷新深链接仍是单页应用', async ({ page }) => {
  await pair(page);
  await page.getByTestId('settings-link').click();
  await expect.poll(() => url(page)).toBe('/s/me');
  await expect(page.getByText('即将推出')).toBeVisible();
  await expect(page.getByTestId('settings-install')).toHaveAttribute('href', '/s/install');
  await expect(page.getByTestId('student-grade')).toBeVisible();
  await page.reload();
  await expect(page.getByText('即将推出')).toBeVisible();
  await page.goto(`${WEB}/s/new`);
  await expect(page.getByTestId('intake-done')).toBeVisible();
});
