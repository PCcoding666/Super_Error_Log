import sharp from 'sharp';
import net from 'node:net';
import { fork } from 'node:child_process';
import path from 'node:path';
import { expect, test as baseTest } from '@playwright/test';

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
// Never mutate the shared week-journey fixture: each case owns its synthetic server and records.
const test = baseTest.extend<{ categoryServer: { WEB: string; CONTROL: string } }>({
  categoryServer: async ({}, use) => {
    const port = await freePort(), control = await freePort();
    const WEB = `http://127.0.0.1:${port}`, CONTROL = `http://127.0.0.1:${control}`;
    const child = fork(path.resolve('tests/e2e/webClientServer.ts'), [], {
      execArgv: ['--import', 'tsx'],
      env: {...process.env, SEL_WEB_E2E_PORT:String(port), SEL_WEB_E2E_CONTROL_PORT:String(control), SEL_AI_MODE:'mock'},
      stdio: ['ignore','ignore','pipe','ipc'],
    });
    let errors = '';
    child.stderr?.on('data', chunk => { errors += String(chunk); });
    try {
      await expect.poll(async () => {
        if (child.exitCode !== null) throw new Error(`Category fixture exited: ${errors}`);
        try { return (await fetch(`${WEB}/s/manifest.webmanifest`)).ok; } catch { return false; }
      }, {timeout:20000}).toBe(true);
      await use({WEB,CONTROL});
    } finally {
      if (child.exitCode === null) await new Promise<void>(resolve => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill('SIGTERM');
      });
    }
  },
});

for (const javaScriptEnabled of [true, false]) test.describe(`章节选题（脚本${javaScriptEnabled ? '开启' : '关闭'}）`, () => {
  test.use({ javaScriptEnabled });
  test('单题修改、跨章节全选、超过8题不截断，调整后继续现有练习', async ({ page, request, categoryServer: {WEB, CONTROL} }, testInfo) => {
    const { link } = await (await request.get(`${CONTROL}/pairing-link`)).json() as {link:string};
    await page.goto(link.replace('https://study.pccoding666.com', WEB));
    await page.getByTestId('next-step-primary').click();
    const headers = {origin:WEB};
    await page.request.post(`${WEB}/s/consent`, {headers});
    await page.request.post(`${WEB}/s/settings/grade`, {headers, form:{grade:'初二'}});
    const idsIn = (html:string) => [...new Set([...html.matchAll(/href="\/s\/items\/(itm_[0-9a-f]+)"/g)].map(match => match[1]!))];
    const libraryUrl = `${WEB}/s/items?grade=${encodeURIComponent('初二')}&subject=${encodeURIComponent('数学')}`;
    const before = new Set(idsIn(await (await page.request.get(libraryUrl)).text()));
    for (let i=0;i<3;i++) {
      const image = await sharp({create:{width:611+i+(javaScriptEnabled?10:20),height:800,channels:3,background:'#f4c2b1'}}).jpeg().toBuffer();
      const upload = await page.request.post(`${WEB}/s/capture`, {headers, multipart:{key:crypto.randomUUID(),photo:{name:'synthetic.jpg',mimeType:'image/jpeg',buffer:image}}});
      expect(upload.ok()).toBeTruthy();
    }
    let ids:string[] = [];
    await expect.poll(async () => {
      ids = idsIn(await (await page.request.get(libraryUrl)).text()).filter(id => !before.has(id));
      return ids.length;
    }).toBe(9);
    const subject = javaScriptEnabled ? '数学选题验证' : '无脚本选题验证';
    for (const [i,id] of ids.entries()) {
      const result = await page.request.post(`${WEB}/s/items/${id}/category`, {headers,form:{grade:'初二',subject,chapter:i<5?'一元二次方程':'二次函数'}});
      expect(result.ok()).toBeTruthy();
    }
    await page.goto(`${WEB}/s/items/${ids[0]}`);
    await page.getByRole('link',{name:'修改分类'}).click();
    await expect(page.getByLabel('年级',{exact:true})).toHaveValue('初二');
    await page.getByLabel('年级',{exact:true}).selectOption('初三');
    await page.getByTestId('next-step-primary').click();
    await expect(page.getByTestId('item-category')).toHaveText(`初三 · ${subject} · 一元二次方程`);
    await page.getByRole('link',{name:'修改分类'}).click();
    await page.getByLabel('年级',{exact:true}).selectOption('初二');
    await page.getByTestId('next-step-primary').click();

    await page.goto(`${WEB}/s/items?${new URLSearchParams({grade:'初二',subject})}`);
    await expect(page.getByRole('heading',{name:'错题本',exact:true})).toBeVisible();
    // Returning from a question must preserve its grade, subject and chapter position,
    // even when the student's default grade differs. This also runs without JavaScript.
    await page.request.post(`${WEB}/s/settings/grade`, {headers,form:{grade:'初三'}});
    await page.getByText('查看这 5 道题', {exact:true}).click();
    await page.locator(`a[href="/s/items/${ids[0]}"]`).click();
    await page.getByTestId('back-link').click();
    await expect(page.getByLabel('年级', {exact:true})).toHaveValue('初二');
    await expect(page.getByTestId('subject-switch')).toContainText(subject);
    const returnedItem = page.locator(`a[href="/s/items/${ids[0]}"]`);
    await expect(returnedItem).toBeInViewport();
    await expect(returnedItem.locator('xpath=ancestor::details')).toHaveAttribute('open', '');
    await page.getByRole('checkbox',{name:'一元二次方程 （5 道）'}).check();
    await page.getByRole('checkbox',{name:'二次函数 （4 道）'}).check();
    await page.screenshot({path:testInfo.outputPath('chapters.png'),fullPage:true});
    await page.getByRole('button',{name:'查看已选题目'}).click();
    await expect(page.locator('input[name=itemIds]:checked')).toHaveCount(9);
    await expect(page.getByTestId('next-step-primary')).toBeDisabled();
    await page.getByRole('radio', {name:'周末',exact:true}).check();
    await expect(page.getByRole('radio', {name:'周末',exact:true})).toBeChecked();
    await expect(page.locator('input[name=itemIds]:checked')).toHaveCount(9);
    await page.locator('input[name=itemIds]:checked').first().uncheck();
    if (javaScriptEnabled) {
      await expect(page.getByTestId('next-step-primary')).toBeEnabled();
      await page.getByTestId('next-step-primary').click();
      await expect(page).toHaveURL(/\/s\/why\/pkt_/);
    } else {
      // No JS must still be able to submit adjusted choices; the server enforces the limit.
      await page.getByRole('button',{name:'提交调整后的选择'}).click();
      await expect(page).toHaveURL(/\/s\/why\/pkt_/);
    }
    await page.request.post(`${WEB}/s/settings/grade`, {headers,form:{grade:'初三'}});
  });
});
