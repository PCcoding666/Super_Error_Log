/** Notebook home keeps the processing hint while a material extract is queued and no question exists yet. */
import { expect, test, type Page } from '@playwright/test';
import { materialGateway, type MaterialGateway } from '../helpers/materialGateway.js';

test.use({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
test.setTimeout(60000);

async function enter(page: Page, gateway: MaterialGateway): Promise<void> {
  await page.goto(gateway.base + '/s/');
  await page.getByLabel('12 位邀请码').fill(gateway.codes[0]!);
  await page.getByRole('button', { name: '进入我的错题本' }).click();
  await page.getByRole('button', { name: '初中', exact: true }).click();
  await expect(page.getByTestId('empty-notebook')).toBeVisible();
}

test('a queued extract with zero questions shows intake-hint above the empty notebook and the home keeps polling', async ({ page }) => {
  const gateway = await materialGateway();
  const notebookGets: number[] = [];
  page.on('request', request => {
    if (request.method() === 'GET' && new URL(request.url()).pathname === '/s/api/notebook') notebookGets.push(Date.now());
  });
  try {
    await enter(page, gateway);
    await expect(page.getByTestId('intake-hint')).toHaveCount(0);
    const seeded = await gateway.queueExtract();
    expect(seeded).toMatchObject({ state: 'queued', questions: 0 });
    const snap = await gateway.snapshot();
    expect(snap.material_question ?? []).toHaveLength(0);
    expect(snap.error_item ?? []).toHaveLength(0);
    expect(snap.material_job?.filter(job => job.kind === 'extract' && job.state === 'queued')).toHaveLength(1);

    const loaded = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/s/api/notebook' && response.ok());
    await page.reload();
    const body = await (await loaded).json() as { finding: number; pendingIntake: number; total: number };
    expect(body.finding).toBeGreaterThan(0);
    expect(body).toMatchObject({ finding: 1, pendingIntake: 0, total: 0 });

    const hint = page.getByTestId('intake-hint');
    const empty = page.getByTestId('empty-notebook');
    await expect(hint).toBeVisible();
    await expect(hint).toContainText('AI 正在找题（1 张照片）');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText('拍一张你的错题照片');
    await expect(page.locator('.home-subtitle')).toContainText('0 道错题');
    const hintBox = await hint.boundingBox();
    const emptyBox = await empty.boundingBox();
    expect(hintBox && emptyBox && hintBox.y + hintBox.height <= emptyBox.y + 1).toBe(true);
    await page.screenshot({ path: test.info().outputPath('notebook-processing-hint.png') });

    // The first paint can fetch twice (mount and view enter). The next fetch is the 3s poll.
    await expect.poll(() => notebookGets.length, { timeout: 2000 }).toBeGreaterThan(0);
    await page.waitForTimeout(400);
    const settled = notebookGets.length;
    const settledAt = notebookGets[settled - 1]!;
    await expect.poll(() => notebookGets.length, { timeout: 8000 }).toBeGreaterThan(settled);
    const gap = notebookGets[notebookGets.length - 1]! - settledAt;
    expect(gap).toBeGreaterThanOrEqual(2500);
    expect(gap).toBeLessThan(6000);

    const beforeFail = notebookGets.length;
    const failed = await gateway.failExtract();
    expect(failed.updated).toBe(1);
    await expect.poll(() => notebookGets.length, { timeout: 8000 }).toBeGreaterThan(beforeFail);
    await expect(hint).toHaveCount(0);
    await expect(empty).toBeVisible();
    const cleared = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/s/api/notebook' && response.ok());
    await page.reload();
    expect(await (await cleared).json()).toMatchObject({ finding: 0, pendingIntake: 0, total: 0 });
  } finally { await gateway.close(); }
});
