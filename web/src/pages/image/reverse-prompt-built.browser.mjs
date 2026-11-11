import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {preview} from 'vite';
import {chromium} from 'playwright';
let server,browser;
try {
 server=await preview({configFile:false,root:process.cwd(),preview:{host:'127.0.0.1',port:0,open:false}});
 const url=server.resolvedUrls.local[0];console.log('Local production preview:',url);
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
 await page.addInitScript(()=>{localStorage.setItem('infinite-canvas:ai_config_store',JSON.stringify({version:1,state:{config:{channels:[],textModel:'',model:''}}}));});
 await page.goto(url+'image',{waitUntil:'domcontentloaded'});
 await page.waitForTimeout(1000);
 await page.locator('#root').getByRole('button',{name:'反推提示词',exact:true}).click();
 const panel=page.locator('section[aria-label="反推提示词"]');
 await panel.getByText('请先配置支持图片输入的文本模型；如无配置权限，请联系管理员。',{exact:true}).waitFor();
 assert.equal(await panel.getByRole('button',{name:'反推提示词',exact:true}).isDisabled(),true);
 await page.waitForTimeout(350);assert.equal(await panel.isVisible(),true);assert.deepEqual(errors,[]);
 await mkdir('test-results/reverse-prompt',{recursive:true});await page.screenshot({path:'test-results/reverse-prompt/production-preview.png'});
 console.log('PASS production build /image renders, reverse prompt modal opens, missing-model notice shown, no uncaught page errors');
} finally {await browser?.close();await new Promise(resolve=>server?server.httpServer.close(resolve):resolve());}

