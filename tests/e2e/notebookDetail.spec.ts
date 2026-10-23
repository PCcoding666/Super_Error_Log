import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import net from 'node:net';
import {fork} from 'node:child_process';
import {expect,test as baseTest,type Page,type APIRequestContext,type TestInfo} from '@playwright/test';

type DetailServer = {WEB:string;CONTROL:string};
async function freePort():Promise<number> {
  const server=net.createServer();
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve,reject)=>server.close(error=>error ? reject(error) : resolve()));
  return port;
}
// Own the synthetic student records; do not alter the shared legacy week-journey fixture.
const test=baseTest.extend<{detailServer:DetailServer}>({
  detailServer:async ({},use)=>{
    const port=await freePort();let control=await freePort();
    while(control===port) control=await freePort();
    const WEB=`http://127.0.0.1:${port}`,CONTROL=`http://127.0.0.1:${control}`;
    const child=fork(path.resolve('tests/e2e/webClientServer.ts'),[],{
      execArgv:['--import','tsx'],
      env:{...process.env,SEL_WEB_E2E_PORT:String(port),SEL_WEB_E2E_CONTROL_PORT:String(control),SEL_AI_MODE:'mock'},
      stdio:['ignore','ignore','pipe','ipc'],
    });
    let errors='';child.stderr?.on('data',chunk=>{errors+=String(chunk);});
    try {
      await expect.poll(async()=>{
        if(child.exitCode!==null) throw new Error(`Detail fixture exited: ${errors}`);
        try{return (await fetch(`${WEB}/s/manifest.webmanifest`)).ok;}catch{return false;}
      },{timeout:20000}).toBe(true);
      await use({WEB,CONTROL});
    }finally{
      if(child.exitCode===null) await new Promise<void>(resolve=>{
        const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
        child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');
      });
    }
  },
});
const idsIn = (html:string) => [...html.matchAll(/name="itemIds"(?: checked="")? value="(itm_[0-9a-f]+)"/g)].map(match=>match[1]!);
async function fixture(page:Page,request:APIRequestContext,{WEB,CONTROL}:DetailServer):Promise<string> {
  const {link} = await (await request.get(`${CONTROL}/pairing-link`)).json() as {link:string};
  await page.goto(link.replace('https://study.pccoding666.com',WEB));
  await page.getByTestId('next-step-primary').click();
  const before = new Set(idsIn(await (await page.request.get(`${WEB}/s/choose`)).text()));
  const rows = [0,1,2].map(i=>`<g transform="translate(100 ${100+i*420})"><text y="35" font-size="38">${i+1}) ${i+1}x + 3 = ${(i+1)*2+3}</text><text x="120" y="130" font-size="38" fill="#374151">x = ${i+3}</text><path d="M420 95 l35 45 m0 -45 l-35 45" stroke="#ae2932" stroke-width="6"/><text x="150" y="220" font-size="34" fill="#ae2932">Correction: x = 2</text></g>`).join('');
  const photo = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1350"><rect width="100%" height="100%" fill="white"/><g font-family="sans-serif"><text x="20" y="30" font-size="18">Synthetic ${crypto.randomBytes(4).toString('hex')}</text>${rows}</g></svg>`)).jpeg().toBuffer();
  const upload = await page.request.post(`${WEB}/s/capture`,{headers:{origin:WEB,accept:'application/json'},multipart:{key:crypto.randomUUID(),photo:{name:'synthetic-detail.jpg',mimeType:'image/jpeg',buffer:photo}}});
  expect(upload.status()).toBe(200);
  let id = '';
  await expect(async()=>{
    const ids = idsIn(await (await page.request.get(`${WEB}/s/choose`)).text()).filter(value=>!before.has(value));
    expect(ids).toHaveLength(3); id=ids[0]!;
  }).toPass({timeout:30000});
  return id;
}
async function shot(page:Page,info:TestInfo,name:string):Promise<void> {
  const out = process.env.NOTEBOOK_DETAIL_EVIDENCE;
  if (out) fs.mkdirSync(out,{recursive:true});
  await page.screenshot({path:out ? path.join(out,`${name}.png`) : info.outputPath(`${name}.png`),fullPage:false});
}

for (const scripting of [true,false]) test.describe(`single-question learning ${scripting ? 'enhanced' : 'without JavaScript'}`,()=>{
  test.use({javaScriptEnabled:scripting});
  test('read confirmed reflection, retry, resume, and truthful history with accessible mobile layout',async({page,request,detailServer:{WEB,CONTROL}},info)=>{
    const id = await fixture(page,request,{WEB,CONTROL});
    const returnTo = `/s/items?grade=初中&subject=数学&chapter=一元一次方程&q=方程#item-${id}`;
    const url = `${WEB}/s/items/${id}?returnTo=${encodeURIComponent(returnTo)}`;
    await page.goto(url);
    await expect(page.getByTestId('next-step-primary')).toHaveText('重做这题');
    await expect(page.getByTestId('item-reflection')).toContainText('还没有已确认的错因记录');
    await expect(page.getByTestId('question-text')).toBeVisible();
    const photo = page.getByRole('img',{name:'整题照片',exact:true});
    await expect(photo).toHaveAttribute('src',`/s/img/item/${id}?scope=full&s=big`);
    expect(await photo.evaluate((img:HTMLImageElement)=>img.complete&&img.naturalWidth>0)).toBe(true);
    const original = page.getByText('你写的',{exact:true});
    await original.click();
    await expect(page.getByText('x = 2',{exact:true})).toBeVisible();
    await original.click();
    await page.getByTestId('next-step-primary').click();
    await expect(page).toHaveURL(/\/s\/practice\/pkt_[0-9a-f]+\?item=/);
    const practice = new URL(page.url()).pathname;
    const pid = practice.split('/').pop()!;
    // Native forms still own mutation, including with scripts disabled.
    await expect(async()=>{
      await page.reload();await expect(page.getByTestId('practice-question')).toBeVisible();
    }).toPass({timeout:30000});
    await page.goto(url);
    await expect(page.getByTestId('next-step-primary')).toHaveText('继续练习');
    await page.getByTestId('next-step-primary').click();
    await expect(page).toHaveURL(new RegExp(`${pid}\\?item=${id}$`));
    await page.goto(`${WEB}/s/why/${pid}/${id}/confirm`);
    await page.locator('input[name=attemptState][value="方法基本正确但步骤出错"]').check();
    await page.locator('input[name=cause][value="计算"]').check();
    await page.locator('input[name=masteryFeeling][value="2"]').check();
    await page.locator('textarea[name=summary]').fill('移项时忘了变号，下次先写出等式两边的变化。');
    await page.getByTestId('next-step-primary').click();
    await page.goto(`${WEB}${practice}?item=${id}&view=check`);
    await page.getByRole('button',{name:'做对了',exact:true}).click();
    await page.goto(url);
    await expect(page.getByTestId('item-reflection')).toContainText('移项时忘了变号');
    await expect(page.getByTestId('item-reflection')).toContainText('现在重做应该会');
    await expect(page.getByTestId('item-practice-history')).toContainText('当天独立做对 · 未计入延迟掌握');
    const mode = scripting ? 'js' : 'nojs';
    await shot(page,info,`detail-${mode}-light`);
    await page.getByTestId('item-reflection').scrollIntoViewIfNeeded();
    await shot(page,info,`detail-${mode}-reflection`);
    await page.getByTestId('next-step-primary').click();
    await expect(async()=>{await page.reload();await expect(page.getByTestId('practice-question')).toBeVisible();}).toPass({timeout:30000});
    await page.getByRole('button',{name:'卡住了，看提示',exact:true}).click();
    await page.getByRole('link',{name:'做完了，对答案',exact:true}).click();
    await expect(page.getByText('你看过提示，这道记为「看提示后做的」。')).toBeVisible();
    await page.getByRole('button',{name:'做对了',exact:true}).click();
    await page.goto(url);
    await expect(page.getByTestId('item-practice-history')).toContainText('用了一级提示后做对');
    await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});
    await shot(page,info,`detail-${mode}-dark`);
    await page.getByTestId('item-practice-history').scrollIntoViewIfNeeded();
    await shot(page,info,`detail-${mode}-history-dark`);
    await page.setViewportSize({width:320,height:740});
    await page.evaluate(()=>document.documentElement.style.setProperty('font-size','200%','important'));
    await page.getByText('题目信息与管理',{exact:true}).click();
    const controls = page.locator('a,button,summary');
    for (const control of await controls.all()) if (await control.isVisible()) {
      const box = await control.boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(44);expect(box!.width).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
    await page.getByTestId('back-link').focus();
    await page.keyboard.press('Tab');
    const focus = await page.evaluate(()=>{const element=document.activeElement!;const style=getComputedStyle(element);return {outline:parseFloat(style.outlineWidth),focus:element.matches(':focus-visible')};});
    expect(focus.focus).toBe(true);expect(focus.outline).toBeGreaterThanOrEqual(3);
    const category = page.getByRole('link',{name:'修改分类',exact:true});
    await category.scrollIntoViewIfNeeded();
    const box=await category.boundingBox(); const bar=await page.getByTestId('next-step-bar').boundingBox();
    expect(box!.y+box!.height).toBeLessThanOrEqual(bar!.y);
    await shot(page,info,`detail-${mode}-320-large`);
    await expect(page.getByTestId('back-link')).toHaveAttribute('href',new RegExp(`^/s/items\\?.*q=%E6%96%B9%E7%A8%8B#item-${id}$`));
    await page.getByTestId('back-link').click();
    await expect(page).toHaveURL(/\/s\/items\?.*q=.*#item-/);
    await page.goBack();
    await expect(page.getByTestId('item-reflection')).toContainText('移项时忘了变号');
    await page.route(`**/s/img/item/${id}*`,route=>route.abort());
    await page.reload();
    await expect.poll(()=>photo.evaluate((img:HTMLImageElement)=>img.complete&&img.naturalWidth===0)).toBe(true);
    await expect(page.getByTestId('question-text')).toContainText('解方程');
    await expect(page.getByRole('link',{name:'打开整题原图（新窗口）'})).toHaveAttribute('href',`/s/img/item/${id}?scope=full`);
  });
  test('native management actions preserve filtered selection through errors, saves, cancel and undo',async({page,request,detailServer:{WEB,CONTROL}})=>{
    const id=await fixture(page,request,{WEB,CONTROL});
    await page.goto(`${WEB}/s/items`);
    const ids=await page.getByTestId('item-card').evaluateAll(nodes=>nodes.slice(0,2).map(node=>node.id.slice('item-'.length)));
    for(const itemId of ids) await page.request.post(`${WEB}/s/items/${itemId}/category`,{headers:{origin:WEB},form:{grade:'初中',subject:'数学',chapter:'管理往返'}});
    const filters={grade:'初中',subject:'数学',chapter:'管理往返',status:'ready_for_reflection',q:'x',mode:'select'};
    await page.goto(`${WEB}/s/items?${new URLSearchParams(filters)}`);
    for(const checkbox of await page.locator('input[name=itemIds]').all()) await checkbox.check();
    await page.locator(`#item-${id}`).click();
    let detailUrl=page.url(),returnTo=new URL(detailUrl).searchParams.get('returnTo')!;
    const checkSelection=async()=>{
      expect(await page.locator('input[name=itemIds]:checked').evaluateAll(nodes=>nodes.map(node=>(node as HTMLInputElement).value).sort())).toEqual([...ids].sort());
      await expect(page.getByTestId('next-step-caption')).toHaveText('已选 2 道 / 最多 8 道');
      expect(new URL(page.url()).searchParams.get('chapter')).toBe('管理往返');
    };
    const backRoundtrip=async()=>{
      await expect(page).toHaveURL(detailUrl);
      await page.getByTestId('back-link').click();await expect(page).toHaveURL(`${WEB}${returnTo}`);
      await checkSelection();await page.locator(`#item-${id}`).click();
      // Native resubmission follows current DOM order (a reclassified item is a recovery row).
      const reopened=new URL(page.url()).searchParams.get('returnTo')!;
      const canonical=(value:string)=>{const url=new URL(value,WEB);const ids=url.searchParams.getAll('itemIds').sort();url.searchParams.delete('itemIds');for(const itemId of ids) url.searchParams.append('itemIds',itemId);url.searchParams.sort();return url.pathname+url.search+url.hash;};
      expect(canonical(reopened)).toBe(canonical(returnTo));
      detailUrl=page.url();returnTo=reopened;
    };
    const manage=async(name:string)=>{await page.getByText('题目信息与管理',{exact:true}).click();await page.getByRole('link',{name,exact:true}).click();};
    const manual=async()=>{await manage('字认错了？改一下');await page.getByRole('link',{name:/^自己\s*动手改/}).click();};
    await manage('修改分类');
    await expect(page.locator('input[name=returnTo]')).toHaveValue(returnTo);
    await page.getByLabel('章节或知识主题',{exact:true}).fill(' ');
    await page.getByTestId('next-step-primary').click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.locator('input[name=returnTo]')).toHaveValue(returnTo);
    await page.getByTestId('back-link').click();await backRoundtrip();
    await manage('修改分类');
    await page.getByLabel('章节或知识主题',{exact:true}).fill('改后章节');
    await page.getByTestId('next-step-primary').click();await backRoundtrip();
    await manual();await page.getByTestId('next-step-secondary-cancel').click();await backRoundtrip();
    await manual();await page.getByTestId('next-step-primary').click();await backRoundtrip();
    await manual();const original=await page.locator('#edit-text').inputValue();
    await page.locator('#edit-text').fill(original+'（改）');
    await page.getByTestId('next-step-primary').click();await backRoundtrip();
    await manage('字认错了？改一下');
    await page.locator('#fix-instruction').fill(' ');await page.getByTestId('next-step-primary').click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.locator('input[name=returnTo]')).toHaveValue(returnTo);
    await page.locator('#fix-instruction').fill('题干末尾补上记号');await page.getByTestId('next-step-primary').click();
    await expect(page.getByTestId('proposal')).toBeVisible();await page.getByTestId('next-step-primary').click();await backRoundtrip();
    await page.getByText('题目信息与管理',{exact:true}).click();
    await page.getByRole('button',{name:'这不是错题',exact:true}).click();
    await expect(page.getByTestId('removed')).toBeVisible();
    await page.getByRole('button',{name:'撤销',exact:true}).click();await expect(page).toHaveURL(`${WEB}${returnTo}`);
    await checkSelection();
  });

});
