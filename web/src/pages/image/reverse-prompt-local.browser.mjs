import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
const url=process.env.LOCAL_IMAGE_URL || 'http://127.0.0.1:3000/image';
const browser=await chromium.launch({headless:true});
try {
 for (const mode of ['unconfigured','unknown','ready']) {
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const page=await context.newPage();const errors=[];let requests=0;
  page.on('pageerror',error=>errors.push(error.message));
  // Deny external networking and proxy/API calls; only this test's response is fulfilled.
  await page.route('**/*',route=>{const target=new URL(route.request().url());return target.origin===new URL(url).origin && !target.pathname.startsWith('/api/') ? route.continue():route.abort();});
  await page.route('**/responses',async route=>{
   requests++;const data=route.request().postDataJSON();assert.equal(data.model,'vision');
   const images=data.input.flatMap(message=>message.content||[]).filter(item=>item.type==='input_image');assert.equal(images.length,1);
   await route.fulfill({contentType:'text/event-stream',body:'data: '+JSON.stringify({type:'response.output_text.delta',delta:'模拟反推：柔和光线，居中构图，织物纹理，近景镜头，安静氛围。'})+'\n\ndata: [DONE]\n\n'});
  });
  await page.addInitScript(mode=>{
   const config={textModel:mode==='unconfigured'?'':'local-test::vision',model:'',channels:mode==='unconfigured'?[]:[{id:'local-test',name:'Local test',provider:'general',apiFormat:'openai',baseUrl:'https://example.test/v1',apiKey:'LOCAL_TEST_ONLY',models:[{name:'vision',capability:'text',...(mode==='ready'?{supportsImageInput:true}:{})}]}]};
   localStorage.setItem('infinite-canvas:ai_config_store',JSON.stringify({version:1,state:{config}}));
  },mode);
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:120000});
  const entry=page.locator('#root').getByRole('button',{name:'反推提示词',exact:true});await entry.waitFor();await page.waitForTimeout(1000);await entry.click();
  const panel=page.locator('section[aria-label="反推提示词"]');
  const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=32;c.height=32;const x=c.getContext('2d');x.fillStyle='#6677aa';x.fillRect(0,0,32,32);return c.toDataURL().split(',')[1];});
  await panel.locator('input[type=file]').setInputFiles({name:'independent.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
  await panel.getByAltText('反推图片预览').waitFor();assert.equal(requests,0);assert.equal(await page.locator('[data-reference-id]').count(),0);
  const run=panel.getByRole('button',{name:'反推提示词',exact:true});
  if(mode!=='ready') {
   await panel.getByText(mode==='unconfigured'?'请先配置支持图片输入的文本模型；如无配置权限，请联系管理员。':'当前文本模型的图片输入能力尚未确认，请在模型配置中确认或联系管理员。',{exact:true}).waitFor();
   assert.equal(await run.isDisabled(),true);assert.equal(requests,0);
  } else {
   await run.click();const result=panel.getByRole('textbox',{name:'可编辑的反推结果'});
   await page.waitForFunction(()=>document.querySelector('[aria-label="可编辑的反推结果"]').value.includes('模拟反推'));
   await result.fill('编辑后的本地测试提示词');await panel.getByRole('button',{name:'填入提示词'}).click();
   assert.equal(await page.locator('#root textarea').first().inputValue(),'编辑后的本地测试提示词');
   assert.equal(await page.locator('[data-reference-id]').count(),0);assert.equal(requests,1);
  }
  await page.waitForTimeout(350);assert.deepEqual(errors,[]);
  await mkdir('test-results/local-preview',{recursive:true});await page.screenshot({path:`test-results/local-preview/${mode}.png`});
  console.log(`PASS live local app: ${mode}; independent image; requests=${requests}; no uncaught page errors`);
  await context.close();
 }
} finally {await browser.close();}
