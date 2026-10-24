/**
 * 学生端单页应用（client/，Ionic React）在旧流程合成服务器（webClientServer，3196）上的主流程：
 * 配对 → 拍照 → 录入态（自动收录、勾选候选）→ 错题本（列表 / 网格 / 选择移除 / 撤销 / 搜索）→ 详情（改分类）→ 设置。
 */
import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';

const WEB = 'http://127.0.0.1:3196';
const CONTROL = 'http://127.0.0.1:3197';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: IPHONE, locale: 'zh-CN', serviceWorkers: 'block', permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] } });
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
  // 一张有批改痕迹（偏红）、一张没有（偏蓝）。
  await page.locator('#library-input').setInputFiles([await synthetic('#efb7b2'), await synthetic('#b0d3e0')]);
  await expect.poll(() => url(page)).toBe('/s/new');
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

test('详情页：照片、题干、你写的、批改痕迹、章节与知识点、正确答案、错因备注；章节可改；移除后回到错题本', async ({ page }) => {
  await pair(page);
  await page.getByTestId('item-card').first().click();
  await expect.poll(() => url(page)).toMatch(/^\/s\/q\/itm_/);
  await expect(page.getByTestId('question-text')).toContainText('解方程');
  await expect(page.locator('.item-photo img')).toHaveCount(1);
  // 大图在应用内打开，左上角有返回；返回后仍在详情页。
  await page.getByTestId('item-photo').click();
  await expect(page.locator('ion-modal.photo-viewer img')).toBeVisible();
  await page.getByTestId('photo-back').click();
  await expect(page.locator('ion-modal.photo-viewer')).toBeHidden();
  expect(url(page)).toMatch(/^\/s\/q\/itm_/);
  // 你写的只有一行（几段原作合在一起）；没有老师批改就写「没识别到」。
  await expect(page.getByTestId('item-work')).toHaveCount(1);
  await expect(page.getByTestId('item-marking')).toContainText('没识别到');
  await page.getByTestId('item-work').click();
  await expect(page.getByTestId('trace-sheet')).toContainText('x = ');
  // 点上方空白处收起（ion-modal 宿主元素一直「可见」，以 overlay-hidden 为准）。
  await page.locator('ion-modal[data-testid="trace-sheet"] ion-backdrop').click({ position: { x: 20, y: 20 } });
  await expect(page.getByTestId('trace-sheet')).toHaveClass(/overlay-hidden/);
  // AI 解答在后台排队生成（mock 模式很快）：错因块里是 AI 推测，正确答案点开是 Markdown 渲染的解题过程和交互图。
  await expect(page.getByTestId('item-mistake')).toContainText('AI 推测 · 推理步骤');
  await expect(page.getByTestId('item-mistake')).toContainText('【mock】你写的「x = ');
  await page.getByTestId('item-answer').click();
  const steps = page.getByTestId('solution-steps');
  await expect(page.getByTestId('solution-answer')).toContainText('【mock】');
  await expect(page.getByTestId('solution-sheet')).toContainText('AI 解答，仅供参考');
  // 交互图在沙箱页里，脚本真的跑起来了（自带 CSP 放行内联脚本，登录 cookie 也带上了）。
  await expect(page.frameLocator('[data-testid="solution-figure"]').locator('#t')).toContainText('mock 交互图已运行');
  await expect(steps.locator('strong')).toHaveText('思路');
  await expect(steps.locator('ol > li')).toHaveCount(3);
  await expect(steps.locator('math')).toHaveCount(2);
  await expect(steps.locator('table')).toContainText('等式的性质');
  await expect(steps).not.toContainText('$');
  await page.getByTestId('solution-close').click();
  await expect(page.getByTestId('solution-sheet')).toHaveClass(/overlay-hidden/);
  // 备注：停笔自动保存，刷新后还在。
  await page.getByTestId('item-remark').locator('textarea').fill('两轮是平方，不是乘 2');
  await expect(page.getByTestId('remark-status')).toHaveText('已保存');
  await page.reload();
  await expect(page.getByTestId('item-remark').locator('textarea')).toHaveValue('两轮是平方，不是乘 2');
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

test('详情页：识别错了能改、拍照录入答案、语音记备注', async ({ page }) => {
  await pair(page);
  await page.getByTestId('item-card').first().click();
  await expect.poll(() => url(page)).toMatch(/^\/s\/q\/itm_/);
  await expect(page.getByTestId('item-mistake')).toContainText('AI 推测');
  // 改题干：改完页面上换成新文字，解答按新内容重新排队、很快又好了。
  await page.getByTestId('stem-edit').click();
  const input = page.locator('ion-modal[data-testid="text-edit"] textarea');
  await expect(input).not.toHaveValue('');
  const stem = await input.inputValue();
  await input.fill(`${stem}（改过）`);
  await page.getByTestId('text-edit-save').click();
  await expect(page.getByTestId('text-edit')).toHaveClass(/overlay-hidden/);
  await expect(page.getByTestId('question-text')).toContainText('（改过）');
  await expect(page.getByTestId('item-mistake')).toContainText('【mock】', { timeout: 20_000 });
  // 改你写的：只能把认错的字改回来；改成另一个答案会被拒绝，提示留在弹层里。
  await page.getByTestId('item-work').click();
  await page.getByTestId('trace-edit').first().click();
  await input.fill('完全换成另一个正确答案 x = 100');
  await page.getByTestId('text-edit-save').click();
  await expect(page.getByTestId('text-edit-error')).toContainText('超过允许幅度');
  const work = await page.locator('ion-modal[data-testid="trace-sheet"] pre').first().textContent();
  await input.fill(`${work!.slice(0, -1)}9`);
  await page.getByTestId('text-edit-save').click();
  await expect(page.locator('ion-modal[data-testid="trace-sheet"] pre').first()).toHaveText(`${work!.slice(0, -1)}9`);
  await page.locator('ion-modal[data-testid="trace-sheet"] ion-backdrop').click({ position: { x: 20, y: 20 } });
  await expect(page.getByTestId('trace-sheet')).toHaveClass(/overlay-hidden/);
  // 拍照录入答案：后台转写这道题的答案，放进「正确答案」里。
  await page.getByTestId('answer-photo-input').setInputFiles([await synthetic('#ffffff')]);
  await expect(page.getByTestId('answer-photo-add')).toContainText('已录 1 张', { timeout: 20_000 });
  await page.getByTestId('item-answer').click();
  await expect(page.getByTestId('answer-photo')).toContainText('【mock】', { timeout: 20_000 });
  await expect(page.getByTestId('solution-steps')).toContainText('对照你拍的答案', { timeout: 20_000 });
  await page.getByTestId('solution-close').click();
  await expect(page.getByTestId('solution-sheet')).toHaveClass(/overlay-hidden/);
  // 语音记备注：说一段，转好的文字接在备注后面并保存。
  await page.getByTestId('voice-button').click();
  await expect(page.getByTestId('voice-button')).toContainText('说完了');
  await page.waitForTimeout(1200);
  await page.getByTestId('voice-button').click();
  await expect(page.getByTestId('item-remark').locator('textarea')).toHaveValue(/我以为移项不用变号/, { timeout: 20_000 });
  await expect(page.getByTestId('remark-status')).toHaveText('已保存');
});

test('详情页：立体图由程序画，能拖动旋转', async ({ page }) => {
  await pair(page);
  await page.getByTestId('item-card').filter({ hasText: '△' }).first().click();
  await expect.poll(() => url(page)).toMatch(/^\/s\/q\/itm_/);
  await expect(page.getByTestId('item-answer')).toContainText('AI 解答，仅供参考', { timeout: 20_000 });
  await page.getByTestId('item-answer').click();
  const figure = page.frameLocator('[data-testid="solution-figure"]');
  await expect(figure.locator('#s line')).not.toHaveCount(0);
  await expect(figure.locator('#cap')).toHaveText('【mock】红线是 BD');
  const before = await figure.locator('#s circle').first().getAttribute('cx');
  const box = (await page.getByTestId('solution-figure').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 100);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) await page.mouse.move(box.x + box.width / 2 + step * 10, box.y + 100);
  await page.mouse.up();
  await expect.poll(() => figure.locator('#s circle').first().getAttribute('cx')).not.toBe(before);
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
