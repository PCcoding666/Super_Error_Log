/**
 * issue #129 的七处界面细节：设置页分组标题对齐、去掉「服务 已连接」、选择模式去掉右上角「✓」、分组标题对比度、
 * 选学段标题不拆词、备注提示语不截断、拍照入口的焦点框只给键盘。
 * 邀请码网关 + 材料流程的合成夹具。每条用例起一份独立的夹具（全新的合成学生），不依赖别的用例留下的数据。
 */
import sharp from 'sharp';
import { expect, test as base, type Locator, type Page } from '@playwright/test';
import { materialGateway, type MaterialGateway } from '../helpers/materialGateway.js';

const test = base.extend<{ gateway: MaterialGateway }>({
  gateway: async ({}, use) => {
    const gateway = await materialGateway();
    try { await use(gateway); } finally { await gateway.close(); }
  },
});
test.use({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });

const STAGE_HEADING = '你现在读初中还是高中？';
const REMARK_PLACEHOLDER = '错在哪？下次注意什么？';

let shade = 0;
async function jpeg(): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  shade += 1;
  return { name: `synthetic-${shade}.jpg`, mimeType: 'image/jpeg', buffer: await sharp({ create: { width: 240, height: 320, channels: 3, background: { r: (shade * 53) % 256, g: (shade * 97) % 256, b: 120 } } }).jpeg().toBuffer() };
}

/** 输入邀请码，停在新账号必经的选学段页（服务端渲染）。 */
async function enterCode(page: Page, gateway: MaterialGateway): Promise<void> {
  await page.goto(gateway.base + '/s/');
  await page.getByLabel('12 位邀请码').fill(gateway.codes[0]!);
  await page.getByRole('button', { name: '进入我的错题本' }).click();
  await expect(page.getByRole('heading', { name: STAGE_HEADING })).toBeVisible();
}

/** 登录并选好初中，停在空的错题本。单页 / 多页已经在页面上，入口是文件框。 */
async function login(page: Page, gateway: MaterialGateway): Promise<void> {
  await enterCode(page, gateway);
  await page.getByRole('button', { name: '初中', exact: true }).click();
  await expect(page.getByTestId('empty-notebook')).toBeVisible();
  await expect(page.locator('[data-testid="capture-dock"]:visible')).toHaveAttribute('data-capture-choice', 'direct');
}

/** 从空错题本传一张合成照片（单页），停在录入页。 */
async function uploadSingle(page: Page): Promise<void> {
  await page.locator('[data-testid="capture-mode-single"]').last().click();
  await page.locator('#library-input').setInputFiles(await jpeg());
  await expect.poll(() => new URL(page.url()).pathname).toBe('/s/new');
}

/** 传一张合成照片，勾选整页收录，回到错题本时里面有一道题。 */
async function fileOneItem(page: Page): Promise<void> {
  await uploadSingle(page);
  const photo = page.locator('section.intake-photo');
  await expect(photo.getByTestId('pick-candidate')).toHaveCount(1, { timeout: 30_000 });
  await photo.getByTestId('pick-page').click();
  await photo.getByTestId('pick-submit').click();
  await expect(page.locator('section.intake-photo[data-state="done"]')).toHaveCount(1, { timeout: 30_000 });
  await page.getByTestId('intake-done').click();
  await expect(page.getByTestId('item-card')).toHaveCount(1);
}

/** 从错题本进设置页。转场动画中途整页带着位移，等错题本那一页真的收起来再量。 */
async function openSettings(page: Page): Promise<Locator> {
  await page.getByTestId('settings-link').click();
  await expect(page.getByTestId('settings-install')).toBeVisible();
  await expect(page.locator('div.ion-page:has(> ion-content.home)')).toHaveClass(/ion-page-hidden/);
  const content = page.locator('ion-content.settings');
  await expect.poll(() => content.evaluate(element => element.getBoundingClientRect().left)).toBe(0);
  return content;
}

/** 'rgb(r, g, b)' → WCAG 相对亮度。读不懂的写法和半透明的颜色算不准，直接判失败。 */
function luminance(css: string): number {
  const match = /^rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)$/.exec(css);
  if (!match) throw new Error(`读不懂的颜色：${css}`);
  if (match[4] !== undefined && Number(match[4]) !== 1) throw new Error(`半透明的颜色算不出对比度：${css}`);
  const [r, g, b] = [match[1], match[2], match[3]].map(part => {
    const value = Number(part) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(first: string, second: string): number {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((x, y) => y - x);
  return (lighter! + 0.05) / (darker! + 0.05);
}

/** 文字颜色，和它身后第一层不透明的底色。ion-content 把底色画在 shadow DOM 的 #background-content 上，宿主自己是透明的。 */
async function paintedColors(target: Locator): Promise<{ color: string; background: string }> {
  return target.evaluate(element => {
    const color = getComputedStyle(element).color;
    let background = '';
    for (let node: Element | null = element; node && !background; node = node.parentElement) {
      const layers: Element[] = [];
      const inner = node.shadowRoot?.querySelector('#background-content');
      if (inner) layers.push(inner);
      layers.push(node);
      for (const layer of layers) {
        const value = getComputedStyle(layer).backgroundColor;
        if (!background && value !== 'rgba(0, 0, 0, 0)' && value !== 'transparent') background = value;
      }
    }
    return { color, background };
  });
}

/** 分组标题（.group-label）在浅色和深色下对页面底色的对比度都要到 4.5:1。颜色从计算样式里读，不写死色值。 */
async function expectReadableLabels(page: Page, labels: Locator, where: string): Promise<void> {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    const all = await labels.all();
    expect(all.length, `${where}要有分组标题`).toBeGreaterThan(0);
    for (const label of all) {
      const { color, background } = await paintedColors(label);
      const ratio = contrast(color, background);
      expect(ratio, `${where}的分组标题「${(await label.textContent())?.trim()}」（${colorScheme}）：${color} 在 ${background} 上只有 ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

/** 焦点框的断言用 soft：一条用例里要看好几个入口，一次跑完能看到是哪几个不对。 */
async function expectNoRing(target: Locator, what: string): Promise<void> {
  await expect.soft(target, `${what}：不该有焦点框`).toHaveCSS('outline-style', 'none');
}

/** 键盘焦点框：有线型，也有宽度。 */
async function expectRing(target: Locator, what: string): Promise<void> {
  await expect.soft(target, `${what}：该有焦点框`).not.toHaveCSS('outline-style', 'none');
  expect.soft(parseFloat(await target.evaluate(element => getComputedStyle(element).outlineWidth)), `${what}：焦点框要有宽度`).toBeGreaterThan(0);
}

/** 用指针点开系统选择器再选一张合成照片。不用 setInputFiles：要让文件框真的被点到、拿到焦点。 */
async function pickWithPointer(page: Page, trigger: Locator): Promise<void> {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), trigger.click()]);
  await chooser.setFiles(await jpeg());
}

test('选学段页的标题在窄屏上不把「初中」「高中」拆成两行，也不撑出屏幕', async ({ page, gateway }) => {
  await enterCode(page, gateway);
  const heading = page.getByRole('heading', { name: STAGE_HEADING });
  const problems: string[] = [];
  for (const width of [280, 300, 320, 344, 360, 375, 390, 414]) {
    await page.setViewportSize({ width, height: 760 });
    // 逐字取位置，top 相同的字算同一行。
    const layout = await heading.evaluate(element => {
      const rows: Array<{ top: number; text: string }> = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? '';
        for (let index = 0; index < text.length; index += 1) {
          range.setStart(node, index);
          range.setEnd(node, index + 1);
          const rect = range.getClientRects()[0];
          if (!rect) continue;
          let row: { top: number; text: string } | undefined;
          for (const candidate of rows) {
            if (Math.abs(candidate.top - rect.top) < rect.height / 2) row = candidate;
          }
          if (row) row.text += text[index];
          else rows.push({ top: rect.top, text: text[index]! });
        }
      }
      const lines: string[] = [];
      for (const row of rows) lines.push(row.text);
      return { lines, right: element.getBoundingClientRect().right, pageWidth: document.documentElement.scrollWidth };
    });
    const seen = `宽 ${width}px 时标题排成 ${JSON.stringify(layout.lines)}`;
    expect(layout.lines.join(''), seen).toBe(STAGE_HEADING);
    for (const word of ['初中', '高中']) {
      if (!layout.lines.some(line => line.includes(word))) problems.push(`${seen}，「${word}」被拆开了`);
    }
    // 不换行的词不能把标题顶出屏幕。
    if (layout.right > width || layout.pageWidth > width) problems.push(`${seen}，标题右边到 ${layout.right}，页面宽 ${layout.pageWidth}`);
  }
  // 每个宽度都量完再报，一次能看到哪些宽度有问题。
  expect(problems).toEqual([]);
  // 服务端页面一直按「320 宽 + 字号放大到 200%」验收不横向溢出（rootPageLayout.spec.ts）。
  // 不换行的片段只能是两个字的词；包住半句话的话，这里会多出一百多像素的横向滚动。
  await page.setViewportSize({ width: 320, height: 760 });
  await page.evaluate(() => document.documentElement.style.setProperty('font-size', '200%'));
  await expect(heading).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), '320 宽、字号 200% 时页面不该横向溢出').toBeLessThanOrEqual(1);
});

test('设置页的分组标题和下面卡片里的文字左对齐', async ({ page, gateway }) => {
  await login(page, gateway);
  const content = await openSettings(page);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const groups = await content.evaluate(element => {
      const out: Array<{ title: string; left: number; rows: Array<{ text: string; left: number }> }> = [];
      for (const header of element.querySelectorAll('ion-list-header.group-label')) {
        const range = document.createRange();
        range.selectNodeContents(header);
        const rows: Array<{ text: string; left: number }> = [];
        const list = header.nextElementSibling;
        for (const label of list?.querySelectorAll('ion-item ion-label') ?? []) {
          const inner = document.createRange();
          inner.selectNodeContents(label);
          rows.push({ text: label.textContent ?? '', left: inner.getBoundingClientRect().left });
        }
        // 「学段」那一行的字在 ion-select 的 shadow DOM 里。
        for (const select of list?.querySelectorAll('ion-item ion-select') ?? []) {
          const text = select.shadowRoot?.querySelector('.label-text');
          if (!text) continue;
          const inner = document.createRange();
          inner.selectNodeContents(text);
          rows.push({ text: text.textContent ?? '', left: inner.getBoundingClientRect().left });
        }
        out.push({ title: (header.textContent ?? '').trim(), left: range.getBoundingClientRect().left, rows });
      }
      return out;
    });
    expect(groups.map(group => group.title)).toEqual(['学习', '应用', '账号']);
    for (const group of groups) {
      expect(group.rows.length, `「${group.title}」下面要有卡片行`).toBeGreaterThan(0);
      for (const row of group.rows) {
        expect(Math.abs(group.left - row.left), `宽 ${width}px：分组标题「${group.title}」左边在 ${group.left}，卡片里的「${row.text}」在 ${row.left}`).toBeLessThanOrEqual(1);
      }
    }
  }
});

test('设置页不再显示「服务 已连接」这一行', async ({ page, gateway }) => {
  await login(page, gateway);
  const content = await openSettings(page);
  // 等到页面整个出来（版本号在最后），再确认那一行不在。
  await expect(content.locator('.version')).toContainText('超级错题本');
  await expect(content.getByTestId('settings-install')).toContainText('添加到主屏幕');
  await expect(page.getByTestId('connection-ok')).toHaveCount(0);
  await expect(content).not.toContainText('已连接');
  await expect(content.locator('ion-item', { hasText: '服务' })).toHaveCount(0);
});

test('选择模式的顶栏只有「取消」和「已选 N 道」，没有右上角的「✓」', async ({ page, gateway }) => {
  await login(page, gateway);
  await fileOneItem(page);
  await page.getByTestId('notebook-filters').click();
  await page.locator('ion-popover.filter-popover').getByText('选择', { exact: true }).click();
  const header = page.locator('ion-header.select-header');
  await expect(header.locator('ion-title')).toHaveText('已选 0 道');
  await expect(header.locator('ion-button')).toHaveCount(1);
  await expect(header.locator('ion-button')).toHaveText('取消');
  await expect(page.locator('.select-done')).toHaveCount(0);
  await expect(page.getByLabel('完成选择')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '完成选择' })).toHaveCount(0);
  // 少了「✓」照样能用：勾一道，标题跟着变；「取消」退出选择模式，题还在。
  await page.getByTestId('item-card').first().click();
  await expect(header.locator('ion-title')).toHaveText('已选 1 道');
  await expect(header.locator('ion-button')).toHaveCount(1);
  await expect(page.getByTestId('discard-selected')).not.toHaveAttribute('aria-disabled', 'true');
  await header.getByRole('button', { name: '取消' }).click();
  await expect(header).toHaveCount(0);
  await expect(page.getByTestId('notebook-filters')).toBeVisible();
  await expect(page.getByTestId('item-card')).toHaveCount(1);
});

test('分组标题的颜色在错题本和设置页上对比度都不低于 4.5:1', async ({ page, gateway }) => {
  await login(page, gateway);
  await fileOneItem(page);
  await expectReadableLabels(page, page.locator('ion-content.home h2.group-label'), '错题本');
  const content = await openSettings(page);
  await expect(content.locator('ion-list-header.group-label')).toHaveCount(3);
  await expectReadableLabels(page, content.locator('ion-list-header.group-label'), '设置页');
});

test('题目详情的备注提示语是「错在哪？下次注意什么？」，一行放得下、不被截断', async ({ page, gateway }) => {
  await login(page, gateway);
  await fileOneItem(page);
  await page.getByTestId('item-card').first().click();
  // Ionic 会克隆 textarea，量真正显示的那一个。
  const remark = page.locator('[data-testid=item-remark] textarea:not(.cloned-input)');
  await expect(remark).toBeVisible();
  await expect(remark).toHaveValue('');
  await expect(remark).toHaveAttribute('placeholder', REMARK_PLACEHOLDER);
  for (const width of [390, 360, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const fit = await remark.evaluate((element: HTMLTextAreaElement) => {
      const style = getComputedStyle(element);
      const shown = getComputedStyle(element, '::placeholder');
      // 用提示语自己的字体排成不换行的一行，量它要多宽。
      const probe = document.createElement('span');
      probe.textContent = element.placeholder;
      probe.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;white-space:nowrap';
      probe.style.fontFamily = shown.fontFamily || style.fontFamily;
      probe.style.fontSize = shown.fontSize || style.fontSize;
      probe.style.fontWeight = shown.fontWeight || style.fontWeight;
      probe.style.fontStyle = shown.fontStyle || style.fontStyle;
      probe.style.letterSpacing = shown.letterSpacing || style.letterSpacing;
      document.body.appendChild(probe);
      const textWidth = probe.getBoundingClientRect().width;
      probe.remove();
      return {
        textWidth,
        room: element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      };
    });
    const seen = `宽 ${width}px：${JSON.stringify(fit)}`;
    expect(fit.textWidth, seen).toBeGreaterThan(0);
    expect(fit.textWidth, `${seen}，提示语一行放不下`).toBeLessThanOrEqual(fit.room);
    expect(fit.scrollHeight, `${seen}，提示语超出了输入框`).toBeLessThanOrEqual(fit.clientHeight);
  }
});

test('用指针点拍摄模式不会打开系统选择器；选完照片后入口不套焦点框', async ({ page, gateway }) => {
  await login(page, gateway);
  const tray = page.getByTestId('capture-tray');
  const count = page.getByTestId('capture-count');
  const multi = page.locator('[data-testid="capture-mode-multi"]').last();
  let opened = false;
  page.on('filechooser', () => { opened = true; });
  await multi.click();
  await page.waitForTimeout(150);
  expect(opened).toBe(false);
  await expect(page.getByTestId('capture-mode-sheet')).toHaveCount(0);
  const fabAlbum = page.getByTestId('next-step-primary');
  await pickWithPointer(page, fabAlbum);
  await expect(count).toHaveText('已拍 1 张');
  await expect(fabAlbum.locator('input')).toBeFocused();
  await expectNoRing(fabAlbum, '右下角的相册圆钮，指针选完照片后');
  await page.getByTestId('capture-set-discard').click();
  await expect(tray).toHaveCount(0);

  await uploadSingle(page);
  const intakeAlbum = page.getByTestId('intake-album');
  await page.locator('[data-testid="capture-mode-multi"]').last().click();
  await pickWithPointer(page, intakeAlbum);
  await expect(count).toHaveText('已拍 1 张');
  await expect(intakeAlbum.locator('input')).toBeFocused();
  await expectNoRing(intakeAlbum, '录入页的「从相册选择」，指针选完照片后');
});

test('用键盘走到「单页 / 多页」和拍照入口时有看得见的焦点框', async ({ page, gateway }) => {
  await login(page, gateway);
  const count = page.getByTestId('capture-count');
  const single = page.locator('[data-testid="capture-mode-single"]').last();
  const multi = page.locator('[data-testid="capture-mode-multi"]').last();
  await single.focus();
  await page.keyboard.press('Tab');
  await expect(multi).toBeFocused();
  await expectRing(multi, '「多页」，Tab 走到时');
  await expectNoRing(single, '「单页」，焦点离开后');
  await page.keyboard.press('Shift+Tab');
  await expect(single).toBeFocused();
  await expectRing(single, '「单页」，Shift+Tab 走到时');

  await multi.click();
  const fabCamera = page.getByTestId('capture-fab-camera');
  const fabAlbum = page.getByTestId('next-step-primary');
  await fabCamera.locator('input').setInputFiles(await jpeg());
  await expect(count).toHaveText('已拍 1 张');
  await fabCamera.locator('input').focus();
  await page.keyboard.press('Tab');
  await expect(fabAlbum.locator('input')).toBeFocused();
  await expectRing(fabAlbum, '右下角的相册圆钮，Tab 走到时');
  await expectNoRing(fabCamera, '右下角的拍照圆钮，焦点离开后');
  await page.keyboard.press('Shift+Tab');
  await expect(fabCamera.locator('input')).toBeFocused();
  await expectRing(fabCamera, '右下角的拍照圆钮，Shift+Tab 走到时');

  await page.getByTestId('capture-set-discard').click();
  await uploadSingle(page);
  await page.locator('[data-testid="capture-mode-multi"]').last().click();
  const intakeCamera = page.getByTestId('intake-camera');
  const intakeAlbum = page.getByTestId('intake-album');
  await intakeCamera.locator('input').setInputFiles(await jpeg());
  await expect(count).toHaveText('已拍 1 张');
  await intakeCamera.locator('input').focus();
  await page.keyboard.press('Tab');
  await expect(intakeAlbum.locator('input')).toBeFocused();
  await expectRing(intakeAlbum, '录入页的「从相册选择」，Tab 走到时');
  await expectNoRing(intakeCamera, '录入页的「拍照」，焦点离开后');
});
