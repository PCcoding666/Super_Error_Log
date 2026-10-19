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
    const idsIn = (html:string) => [...new Set([...html.matchAll(/href="\/s\/items\/(itm_[0-9a-f]+)\?/g)].map(match => match[1]!))];
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
    await page.getByText('题目信息与管理',{exact:true}).click();
    await page.getByRole('link',{name:'修改分类'}).click();
    await expect(page.getByLabel('年级',{exact:true})).toHaveValue('初二');
    await page.getByLabel('年级',{exact:true}).selectOption('初三');
    await page.getByTestId('next-step-primary').click();
    await expect(page.getByTestId('item-category')).toHaveText(`初三 · ${subject} · 一元二次方程`);
    await page.getByText('题目信息与管理',{exact:true}).click();
    await page.getByRole('link',{name:'修改分类'}).click();
    await page.getByLabel('年级',{exact:true}).selectOption('初二');
    await page.getByTestId('next-step-primary').click();

    await page.goto(`${WEB}/s/items?${new URLSearchParams({grade:'初二',subject})}`);
    await expect(page.getByRole('heading',{name:'错题本',exact:true})).toBeVisible();
    // Returning from a question must preserve its grade, subject and chapter position,
    // even when the student's default grade differs. This also runs without JavaScript.
    await page.request.post(`${WEB}/s/settings/grade`, {headers,form:{grade:'初三'}});
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await expect(page.getByTestId('item-card')).toHaveCount(9);
    await page.locator(`#item-${ids[0]}`).click();
    await page.getByTestId('back-link').click();
    await page.getByTestId('notebook-filters').locator('summary').click();
    await expect(page.getByLabel('年级', {exact:true})).toHaveValue('初二');
    await page.getByTestId('notebook-filters').locator('summary').click();
    await expect(page.getByTestId('subject-switch')).toContainText(subject);
    await expect(page.locator(`#item-${ids[0]}`)).toBeInViewport();
    await page.getByRole('link',{name:'选题练习',exact:true}).click();
    await page.getByRole('button',{name:'添加 一元二次方程',exact:true}).click();
    await expect(page.locator('input[name=itemIds]:checked')).toHaveCount(5);
    await page.getByRole('button',{name:'添加 二次函数',exact:true}).click();
    await expect(page.locator('input[name=itemIds]:checked')).toHaveCount(9);
    await expect(page.getByTestId('next-step-caption')).toHaveText('已选 9 道 / 最多 8 道');
    await page.screenshot({path:testInfo.outputPath('explicit-selection.png'),fullPage:true});
    if(javaScriptEnabled) await expect(page.getByTestId('next-step-primary')).toBeDisabled();
    else {
      await page.getByTestId('next-step-primary').click();
      await expect(page.getByRole('alert')).toContainText('最多 8 道');
    }
    await expect(page.locator('input[name=itemIds]:checked')).toHaveCount(9);
    await page.locator('input[name=itemIds]:checked').first().uncheck();
    if (javaScriptEnabled) {
      await expect(page.getByTestId('next-step-caption')).toHaveText('已选 8 道 / 最多 8 道');
      await expect(page.getByTestId('next-step-primary')).toBeEnabled();
    }
    await page.getByTestId('next-step-primary').click();
    await expect(page).toHaveURL(/\/s\/practice\/pkt_/);
    await page.request.post(`${WEB}/s/settings/grade`, {headers,form:{grade:'初三'}});
  });
  test('阅读、联合搜索、返回定位与选题恢复在浅深色和大字下可用', async ({page,request,categoryServer:{WEB,CONTROL}},testInfo)=>{
    const {link}=await (await request.get(`${CONTROL}/pairing-link`)).json() as {link:string};
    await page.goto(link.replace('https://study.pccoding666.com',WEB));
    await page.getByTestId('next-step-primary').click();
    const headers={origin:WEB};
    await page.request.post(`${WEB}/s/consent`,{headers});
    const image=await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200">
      <rect width="900" height="1200" fill="white"/>
      <g fill="#191919" font-family="sans-serif" font-size="36">
      <text x="90" y="140">1. 解方程：x + 3 = 5，</text><text x="90" y="200">求 x 的值。</text>
      <text x="90" y="510">2. 已知 y = x² − 2x + 2，</text><text x="90" y="570">求二次函数的对称轴。</text>
      <text x="90" y="885">3. △ABC ∽ △DEF，AB = 3，</text><text x="90" y="945">DE = 6，求相似比。</text></g>
      <g fill="#b22932" font-family="sans-serif" font-size="32"><text x="110" y="300">x = 3  ×</text><text x="110" y="670">x = 2  ×</text><text x="110" y="1045">3 : 1  ×</text></g></svg>`)).jpeg().toBuffer();
    await page.request.post(`${WEB}/s/capture`,{headers,multipart:{key:crypto.randomUUID(),photo:{name:'synthetic.jpg',mimeType:'image/jpeg',buffer:image}}});
    const library=`${WEB}/s/items?${new URLSearchParams({grade:'初三',subject:'数学'})}`;
    await expect.poll(async()=>{
      const html=await (await page.request.get(library)).text();
      return [...html.matchAll(/data-testid="item-card"/g)].length;
    }).toBe(3);
    await page.goto(library);
    const cards=page.getByTestId('item-card');
    await expect(cards).toHaveCount(3);
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await expect(cards.first()).toBeVisible();
    await expect(cards.first()).toBeInViewport();
    const id=(await cards.first().getAttribute('id'))!.slice('item-'.length);
    await page.request.post(`${WEB}/s/items/${id}/category`,{headers,form:{grade:'初三',subject:'数学',chapter:'阅读定位'}});
    await page.reload();
    await page.getByLabel('搜索题目',{exact:true}).fill('x');
    await page.getByTestId('notebook-filters').locator('summary').click();
    await page.getByLabel('章节',{exact:true}).selectOption('阅读定位');
    await page.getByLabel('学习状态',{exact:true}).selectOption('ready_for_reflection');
    await page.getByRole('button',{name:'查看',exact:true}).click();
    await expect(cards).toHaveCount(1);
    const expected=`${WEB}/s/items?${new URLSearchParams({grade:'初三',subject:'数学',chapter:'阅读定位',status:'ready_for_reflection',q:'x'})}#item-${id}`;
    const photo=cards.locator('img');
    await expect(photo).toHaveAttribute('src',/\?scope=full&s=big$/);
    await expect.poll(()=>photo.evaluate((img:HTMLImageElement)=>img.complete&&img.naturalWidth>0)).toBe(true);
    const dimensions=await photo.evaluate((img:HTMLImageElement)=>({natural:img.naturalWidth/img.naturalHeight,rendered:img.width/img.height}));
    expect(dimensions.rendered).toBeCloseTo(dimensions.natural,1);
    expect((await photo.boundingBox())!.height).toBeGreaterThan(100);
    await cards.click();
    await expect(page.getByTestId('next-step-primary')).toHaveText('重做这题');
    await expect(page.getByTestId('item-reflection')).toContainText('还没有已确认的错因记录');
    await expect(page.locator('input[name=returnTo]')).toHaveValue(expected.slice(WEB.length));
    await page.getByTestId('back-link').click();
    await expect(page).toHaveURL(expected);
    await expect(cards).toBeInViewport();
    await cards.click();
    await page.goBack();
    await expect(page.getByLabel('搜索题目',{exact:true})).toHaveValue('x');
    await page.getByTestId('notebook-filters').locator('summary').click();
    await expect(page.getByLabel('章节',{exact:true})).toHaveValue('阅读定位');
    await page.getByRole('link',{name:'清除筛选',exact:true}).click();
    await page.getByLabel('搜索题目',{exact:true}).fill('没有匹配的题目');
    await page.getByRole('button',{name:'查看',exact:true}).click();
    await expect(page.getByRole('heading',{name:'没有符合筛选的题目'})).toBeVisible();
    await page.getByRole('link',{name:'查看全部数学错题',exact:true}).click();
    await expect(cards).toHaveCount(3);
    await page.getByRole('link',{name:'选题练习',exact:true}).click();
    const countStatus=page.getByTestId('next-step-caption');
    await expect(countStatus).toHaveAttribute('role','status');
    await expect(countStatus).toHaveAttribute('aria-live','polite');
    await expect(countStatus).toHaveAttribute('aria-atomic','true');
    await expect(page.getByTestId('next-step-primary')).toHaveAttribute('aria-describedby','notebook-selection-count notebook-selection-hint');
    await expect(page.getByTestId('next-step-primary')).toHaveAccessibleDescription('已选 0 道 / 最多 8 道 至少选 1 道题');
    await expect(page.getByTestId('next-step-bar').locator('[aria-live]')).toHaveCount(1);
    if(javaScriptEnabled) await expect(page.getByTestId('next-step-primary')).toBeDisabled();
    else {
      await page.getByTestId('next-step-primary').click();
      await expect(page.getByRole('alert')).toContainText('至少选 1 道');
    }
    await page.setViewportSize({width:844,height:390});
    await page.locator('input[name=itemIds]').first().check();
    if(!javaScriptEnabled) await page.getByRole('button',{name:'添加 阅读定位',exact:true}).click();
    await expect(countStatus).toBeVisible();
    await expect(countStatus).toHaveText('已选 1 道 / 最多 8 道');
    await expect(page.locator('[data-caption-flow]')).not.toBeVisible();
    await expect(page.getByTestId('next-step-primary')).toHaveAccessibleDescription('已选 1 道 / 最多 8 道 可逐题取消');
    await expect(page.getByTestId('next-step-bar').locator('[aria-live]')).toHaveCount(1);
    const landscapeOriginal=page.getByRole('link',{name:/查看原图/}).last();
    await landscapeOriginal.scrollIntoViewIfNeeded();
    const landscapeFinalBox=(await landscapeOriginal.boundingBox())!,landscapeBar=(await page.getByTestId('next-step-bar').boundingBox())!;
    expect(landscapeFinalBox.y+landscapeFinalBox.height).toBeLessThanOrEqual(landscapeBar.y);
    await expect(page.getByTestId('next-step-primary')).toBeInViewport();
    await page.screenshot({path:testInfo.outputPath('selection-landscape-count.png')});
    await page.setViewportSize({width:390,height:844});
    if(javaScriptEnabled) {
      await expect(page.getByTestId('next-step-caption')).toHaveText('已选 1 道 / 最多 8 道');
      await expect(page.getByTestId('next-step-primary')).toBeEnabled();
      await page.locator('input[name=itemIds]').nth(1).check();
      await expect(countStatus).toHaveText('已选 2 道 / 最多 8 道');
      await expect(page.getByTestId('next-step-primary')).toHaveAccessibleDescription('已选 2 道 / 最多 8 道 可逐题取消');
      await page.locator('input[name=itemIds]').nth(1).uncheck();
      await expect(countStatus).toHaveText('已选 1 道 / 最多 8 道');
      expect(await countStatus.evaluate(el=>{
        const observer=new MutationObserver(()=>{});
        observer.observe(el,{childList:true,characterData:true,subtree:true});
        document.querySelector('#notebook-selection')!.dispatchEvent(new Event('change',{bubbles:true}));
        window.dispatchEvent(new Event('pageshow'));
        const mutations=observer.takeRecords().length;
        observer.disconnect();return mutations;
      })).toBe(0);
      await cards.first().click();
      await page.goBack();
      await expect(page.locator('input[name=itemIds]:checked')).toHaveCount(1);
      await expect(page.getByTestId('next-step-caption')).toHaveText('已选 1 道 / 最多 8 道');
      await expect(page.getByTestId('next-step-primary')).toBeEnabled();
    }
    await page.getByRole('button',{name:'查看',exact:true}).click();
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await page.getByRole('link',{name:'选题练习',exact:true}).click();
    await expect(page.locator('input[name=itemIds]:checked')).toHaveCount(0);
    await page.getByRole('link',{name:'取消选题',exact:true}).click();
    // Real keyboard traversal and visible focus, with an associated native label.
    await page.getByLabel('搜索题目',{exact:true}).focus();
    await page.getByTestId('notebook-filters').locator('summary').focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('年级',{exact:true})).toBeFocused();
    expect(await page.getByLabel('年级',{exact:true}).evaluate(el=>getComputedStyle(el).outlineStyle)).not.toBe('none');
    await page.getByTestId('notebook-filters').locator('summary').click();
    expect((await cards.first().boundingBox())!.y).toBeLessThan(320);
    for(const colorScheme of ['light','dark'] as const){
      await page.emulateMedia({colorScheme,reducedMotion:'reduce'});
      await page.setViewportSize({width:390,height:844});
      await page.screenshot({path:testInfo.outputPath(`reading-${colorScheme}.png`),fullPage:true});
      await page.setViewportSize({width:1200,height:900});
      await page.screenshot({path:testInfo.outputPath(`reading-${colorScheme}-desktop.png`),fullPage:true});
      for(const width of [320,1200]){
        await page.setViewportSize({width,height:900});
        await page.evaluate(()=>document.documentElement.style.setProperty('font-size','200%'));
        expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
        await page.getByTestId('notebook-filters').locator('summary').click();
        for(const selector of ['#library-search','#library-grade','select[name=chapter]','select[name=status]','.notebook-title .link-btn','.notebook-original']){
          const box=await page.locator(selector).first().boundingBox();
          expect(box!.width).toBeGreaterThanOrEqual(44);
          expect(box!.height).toBeGreaterThanOrEqual(44);
        }
        await page.getByTestId('notebook-filters').locator('summary').click();
        await page.screenshot({path:testInfo.outputPath(`reading-${colorScheme}-${width}-200.png`),fullPage:true});
        await page.evaluate(()=>document.documentElement.style.removeProperty('font-size'));
      }
    }
    await page.setViewportSize({width:320,height:740});
    await page.getByRole('link',{name:'选题练习',exact:true}).click();
    for(const target of [page.locator('.notebook-choice').first(),page.getByRole('button',{name:'添加 阅读定位',exact:true}),page.getByRole('link',{name:'取消选题',exact:true}),page.getByTestId('next-step-primary')]){
      const box=(await target.boundingBox())!;expect(box.width).toBeGreaterThanOrEqual(44);expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await page.locator('input[name=itemIds]').first().focus();
    expect(await page.locator('input[name=itemIds]').first().evaluate(el=>getComputedStyle(el).outlineStyle)).not.toBe('none');
    await page.screenshot({path:testInfo.outputPath('selection-dark.png'),fullPage:true});
    await page.evaluate(()=>document.documentElement.style.setProperty('font-size','200%'));
    const submit=page.getByTestId('next-step-primary');
    await submit.scrollIntoViewIfNeeded();
    await expect(page.getByRole('navigation',{name:'主要导航'})).toHaveCount(0);
    const submitBox=(await submit.boundingBox())!;
    expect(submitBox.y+submitBox.height).toBeLessThanOrEqual(740);
    await page.getByRole('link',{name:/查看原图/}).last().scrollIntoViewIfNeeded();
    const finalBox=(await page.getByRole('link',{name:/查看原图/}).last().boundingBox())!,barBox=(await page.getByTestId('next-step-bar').boundingBox())!;
    expect(finalBox.y+finalBox.height).toBeLessThanOrEqual(barBox.y);
    await expect(submit).toBeInViewport();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
    // A failed photograph still leaves the text and original image link usable.
    await page.route('**/s/img/item/**',route=>route.abort());
    await page.reload();
    await expect(page.getByTestId('item-card').first().locator('.excerpt')).not.toBeEmpty();
    await expect(page.getByRole('link',{name:/查看原图/}).first()).toBeVisible();
  });

});
