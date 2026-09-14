/**
 * E2E 核心旅程 J1–J8（串行，共享同一浏览器上下文与数据）。
 * 启动：playwright.config.ts webServer 以 mock AI + data-e2e 独立数据目录启动。
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { WEEK1_DIR } from '../../src/fixtures/generate.js';

test.describe.configure({ mode: 'serial' });

const fixturePaths = fs.readdirSync(WEEK1_DIR).sort().map((f) => path.join(WEEK1_DIR, f));

async function waitBatchDone(page: Page): Promise<void> {
  // 后台异步识别：轮询批次页直到出现 20 道题（短 ID 链接）
  for (let i = 0; i < 40; i++) {
    await page.reload();
    const text = await page.locator('body').innerText();
    const shortIds = text.match(/\b[MPCX]-\d{2}\b/g) ?? [];
    if (new Set(shortIds).size >= 20) return;
    await page.waitForTimeout(500);
  }
  throw new Error('批次处理超时');
}

test('J1 首次使用：建档 + 隐私确认', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/onboarding/);
  await page.fill('#nickname', '小舟');
  await page.check('input[name="subjects"][value="数学"]');
  await page.check('input[name="subjects"][value="物理"]');
  await page.check('input[name="subjects"][value="化学"]');
  await page.check('input[name="privacy_ack"]');
  await page.getByRole('button', { name: '完成设置，开始使用' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('body')).toContainText('小舟');
});

let batchUrl = '';

test('J2 批量采集：19 文件 → 20 题，3 道待校正', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('body')).toContainText('演示模式'); // J7：无 Key 降级可见
  await page.setInputFiles('#files', fixturePaths);
  await page.getByRole('button', { name: '开始上传并识别' }).click();
  await expect(page).toHaveURL(/\/batches\/.+/);
  batchUrl = page.url();
  await waitBatchDone(page);
  await page.goto(`${batchUrl}/review`);
  await expect(page.locator('body')).toContainText('剩余 3 道');
});

test('J2 校正：3 道低置信题全部订正', async ({ page }) => {
  await page.goto(`${batchUrl}/review`);
  for (let i = 0; i < 3; i++) {
    await page.locator('form button[type="submit"]').first().click();
    await page.waitForURL(/\/batches\/.+\/review/);
  }
  await expect(page.locator('body')).toContainText('没有需要校正');
});

test('J3 最小反思：逐项四选，AI 提示不预选', async ({ page }) => {
  for (let i = 0; i < 25; i++) {
    await page.goto('/reflect');
    if ((await page.locator('form').count()) === 0) break;
    // AI 提示仅展示：没有任何 radio 被预选
    expect(await page.locator('input[type="radio"]:checked').count()).toBe(0);
    await page.locator('input[name="attempt_state"]').first().check();
    await page.locator('input[name="cause"]').first().check();
    await page.locator('input[name="mastery_feeling"]').first().check();
    await page.locator('input[name="review_value"]').first().check();
    await page.getByRole('button', { name: '确认，下一题' }).click();
  }
  await page.goto('/reflect');
  await expect(page.locator('form')).toHaveCount(0);
});

let packetUrl = '';

test('J4 复习包：可解释推荐 → 8 题 → A4 PDF', async ({ page }) => {
  await page.goto('/plan');
  await expect(page.locator('input[name="item_ids"]:checked')).toHaveCount(8);
  await expect(page.locator('body')).toContainText('值得延迟重做'); // 可解释性可见
  await page.getByRole('button', { name: '确认计划并生成复习包' }).click();
  await expect(page).toHaveURL(/\/packets\/.+/);
  packetUrl = page.url();

  await page.getByRole('button', { name: '生成 A4 打印 PDF' }).click();
  await expect(page).toHaveURL(/ok=/);

  const [req] = await Promise.all([page.waitForEvent('download').catch(() => null), page.locator(`a[href$="/pdf"]`).first().click()]);
  void req;
  // 直接请求校验 PDF 可下载
  const res = await page.request.get(`${packetUrl}/pdf`);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('application/pdf');
  const body = await res.body();
  expect(body.length).toBeGreaterThan(10000);
  expect(body.subarray(0, 5).toString()).toBe('%PDF-');

  // 打印预览：含演算区与勾选框
  await page.goto(`${packetUrl}/print-preview`);
  await expect(page.locator('body')).toContainText('演算区');
  await expect(page.locator('body')).toContainText('独立完成');
});

test('J5 回传：混合结果各自正确流转', async ({ page }) => {
  await page.goto(`${packetUrl}/return`);
  const names: string[] = await page.$$eval(
    'input[type="radio"][name^="completion_"]',
    (els) => [...new Set(els.map((e) => e.getAttribute('name')!))],
  );
  const ids = names.map((n) => n.replace('completion_', ''));
  expect(ids).toHaveLength(8);
  const plan = [
    { c: 'independent', ok: '1' }, { c: 'independent', ok: '1' }, { c: 'independent', ok: '1' },
    { c: 'independent', ok: '1' }, { c: 'independent', ok: '1' },
    { c: 'hint_used', ok: '1' }, { c: 'independent', ok: '0' }, { c: 'unfinished', ok: '0' },
  ];
  for (let i = 0; i < ids.length; i++) {
    await page.check(`input[name="completion_${ids[i]}"][value="${plan[i]!.c}"]`);
    await page.check(`input[name="correct_${ids[i]}"][value="${plan[i]!.ok}"]`);
    // Synthetic workflow records an immediate attempt, never pretends a real delayed result.
    const today = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; });
    await page.fill(`input[name="performed_${ids[i]}"]`, today);
  }
  await page.getByRole('button', { name: '提交回传结果' }).click();
  await expect(page).toHaveURL(/ok=/);
  await expect(page.locator('body')).toContainText('已记录 8');

  await page.goto('/items?status=needs_recheck');
  // Recommendations mix subjects; assert the three actual returned item IDs, not a random subject prefix.
  for (const id of ids.slice(5)) await expect(page.locator(`a[href="/items/${id}"]`)).toBeVisible();
  await expect(page.locator('main .list > li')).toHaveCount(3);
});

test('J6 趋势：薄弱标签与复发预警可见', async ({ page }) => {
  await page.goto('/trends');
  await expect(page.locator('body')).toContainText('薄弱');
  await expect(page.locator('body')).toContainText('复发');
});

test('J7 幂等：同批文件重复上传全部标记重复', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('#files', fixturePaths);
  await page.getByRole('button', { name: '开始上传并识别' }).click();
  await expect(page).toHaveURL(/\/batches\/.+/);
  await page.waitForTimeout(1000);
  await page.reload();
  await expect(page.locator('body')).toContainText('重复');
});

test('J8 权限：家长只见聚合，受限资源 403', async ({ page }) => {
  await page.goto('/role/parent');
  await expect(page).toHaveURL(/\/parent/);
  await expect(page.locator('body')).toContainText('完成'); // 聚合区

  const denied = await page.request.get('/items');
  expect(denied.status()).toBe(403);
  const deniedApi = await page.request.get('/api/items');
  expect(deniedApi.status()).toBe(403);
  const agg = await page.request.get('/api/parent/aggregate');
  expect(agg.status()).toBe(200);
  const aggJson = await agg.json();
  expect(JSON.stringify(aggJson)).not.toContain('反思');

  // 学生页面在家长态 403
  await page.goto('/items');
  await expect(page.locator('body')).toContainText('仅学生本人可见');
  await page.goto('/role/student');
  await expect(page).toHaveURL(/\/$/);
});
