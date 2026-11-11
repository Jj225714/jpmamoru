import { chromium } from 'playwright';
import fs from 'node:fs/promises';
const browser = await chromium.launch({ headless: true });
try {
 const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
 page.on('pageerror',error=>console.log(error.message));
 await page.goto('http://127.0.0.1:3011/image');
 await page.locator('input[type=file]').first().waitFor({ state:'attached' });
 await page.evaluate(async()=>{(await import('/src/pages/image/canvas-reference-harness.tsx')).mount();});
 const generate=page.locator('[data-harness]').getByRole('button',{name:'生成',exact:true}).first();
 await generate.waitFor();
 await page.evaluate(()=>{for(const name of ['one','two'])window.queue.add(name,()=>new Promise(resolve=>window.resolvers.push(resolve)),()=>window.commits++);});
 if(!await generate.isDisabled())throw Error('pending enabled');
 const blocked=page.locator('[data-harness] button[title="参考图读取/上传未完成，请等待，或重试/移除失败图片"]');
 if(await blocked.count()<3||!await blocked.evaluateAll(buttons=>buttons.every(button=>button.disabled)))throw Error('not all entry buttons disabled');
 await fs.mkdir('test-results/canvas-reference-gate',{recursive:true}); await page.screenshot({path:'test-results/canvas-reference-gate/pending.png'});
 await blocked.evaluateAll(buttons=>buttons.forEach(button=>button.click()));
 await generate.evaluate(button=>button.click());
 await page.evaluate(()=>window.resolvers[0]('one')); await page.waitForTimeout(50);
 if(!await generate.isDisabled())throw Error('one remaining enabled');
 await page.evaluate(()=>window.resolvers[1]('two')); await page.waitForTimeout(50);
 if(await generate.isDisabled())throw Error('ready disabled');
 await page.evaluate(()=>{ window.fail=true; window.failedId=window.queue.add('failed',async()=>{if(window.fail)throw Error('failed');return 'ok';},()=>{}); });
 await page.waitForTimeout(50); if(!await generate.isDisabled())throw Error('failed enabled');
 await page.evaluate(()=>{window.fail=false;window.queue.retry(window.failedId);}); await page.waitForTimeout(50); if(await generate.isDisabled())throw Error('retry ready disabled');
 await page.evaluate(()=>window.queue.add('removed',()=>new Promise(()=>{}),()=>{}));
 await page.getByText('removed: 读取/上传中',{exact:true}).locator('..').getByRole('button',{name:'移除'}).click();
 if(await generate.isDisabled())throw Error('remove still disabled');
 await page.evaluate(()=>{window.queue.add('old project',()=>new Promise(resolve=>window.oldResolve=resolve),()=>window.commits++);window.setProject('B');});
 await page.waitForTimeout(50); await page.evaluate(()=>window.oldResolve('old')); await page.waitForTimeout(50);
 await page.evaluate(()=>{window.queue.add('old account',()=>new Promise(resolve=>window.oldResolve=resolve),()=>window.commits++);window.accountStore.setState({user:{id:'B'},phase:'ready'});window.oldResolve('old');});
 await page.waitForTimeout(50);
 const counts=await page.evaluate(()=>({requests:window.requests,commits:window.commits}));
 if(counts.requests!==0||counts.commits!==2)throw Error(JSON.stringify(counts));
 await fs.mkdir('test-results/canvas-reference-gate',{recursive:true}); await page.screenshot({path:'test-results/canvas-reference-gate/ready.png'});
 console.log('PASS: canvas prompt/config controls, concurrent reads, failure, retry/removal, project/account switch; blocked click zero requests.');
} finally {await browser.close();}

