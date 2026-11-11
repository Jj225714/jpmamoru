import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright-core';

// External generation/segmentation is stubbed; storage, UI, render and save are real.
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/src/services/api/image.ts*', route => {
        if (new URL(route.request().url()).searchParams.has('qa-original')) return route.continue();
        return route.fulfill({contentType:'application/javascript',body:`export * from '/src/services/api/image.ts?qa-original'; export async function requestEdit() { window.__qa.generated++; return [{dataUrl: window.__qa.white}]; }`});
    });
    await page.route(/\/node_modules\/\.vite\/deps\/@huggingface_transformers\.js/, route => route.fulfill({contentType:'application/javascript',body:`export async function pipeline() { return async input => { window.__qa.extracted++; window.__qa.input = input; await new Promise(r=>setTimeout(r,500)); if(window.__qa.fail) throw new Error('模拟图层准备失败'); return [{toBlob:async()=> (await fetch(window.__qa.transparent)).blob()}]; }; }`}));
    await page.goto('http://localhost:3019/image?mode=product-white', {waitUntil:'domcontentloaded'});
    await page.getByRole('heading',{name:'商品白底图',exact:true}).waitFor();
    const imageData = await page.evaluate(async () => {
        const {useProductWhiteStore:s} = await import('/src/stores/use-product-white-store.ts');
        const {useConfigStore:c} = await import('/src/stores/use-config-store.ts');
        const {useCommerceStore:commerce} = await import('/src/stores/use-commerce-store.ts');
        await Promise.all([s,c,commerce].map(store=>new Promise(resolve=>{if(store.persist.hasHydrated())resolve();else{const off=store.persist.onFinishHydration(()=>{off();resolve();});}})));
        c.setState({isAiConfigReady:()=>true});
        commerce.setState({modelRoles:{...commerce.getState().modelRoles,removalApiUrl:'http://localhost:3019/__qa-cutout'}});
        const canvas=document.createElement('canvas');canvas.width=canvas.height=128;const ctx=canvas.getContext('2d');
        ctx.fillStyle='#709b58';ctx.fillRect(25,35,78,58);const transparent=canvas.toDataURL();
        ctx.globalCompositeOperation='destination-over';ctx.fillStyle='#fff';ctx.fillRect(0,0,128,128);const white=canvas.toDataURL();
        window.__qa={s,transparent,white,generated:0,extracted:0,fail:false};return {white,transparent};
    });
    await page.locator('input[type=file]').setInputFiles({name:'test.png',mimeType:'image/png',buffer:Buffer.from(imageData.white.split(',')[1],'base64')});
    await page.getByRole('button',{name:'生成白底图',exact:true}).click();
    const angle=page.getByRole('spinbutton',{name:'旋转角度',exact:true});
    await angle.waitFor();await page.waitForFunction(()=>!document.querySelector('input[aria-label="旋转角度"]').disabled);
    assert.equal(await page.getByRole('button',{name:'编辑构图与颜色',exact:true}).count(),0);
    assert.equal(await page.evaluate(()=>window.__qa.generated),1);
    assert.equal(await page.evaluate(()=>window.__qa.extracted),1);
    await angle.fill('32');await angle.press('Tab');
    await page.getByRole('button',{name:'保存调整',exact:true}).first().click();
    await page.waitForFunction(()=>window.__qa.s.getState().records.length===2);
    assert.equal(await page.evaluate(()=>window.__qa.s.getState().records[0].editor.applied.rotation),32);
    await page.waitForFunction(()=>!document.querySelector('input[aria-label="旋转角度"]').disabled);
    await page.evaluate(()=>{window.__qa.fail=true;});
    await page.getByRole('button',{name:'生成白底图',exact:true}).click();
    await page.getByRole('button',{name:'重试准备调整面板',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.__qa.s.getState().records.length),3);
    await page.evaluate(()=>{window.__qa.fail=false;});
    await page.getByRole('button',{name:'重试准备调整面板',exact:true}).click();
    await angle.waitFor();await page.waitForFunction(()=>!document.querySelector('input[aria-label="旋转角度"]').disabled);
    assert.equal(await page.evaluate(()=>window.__qa.generated),2);
    let apiTransparent=false;
    await page.route('**/__qa-cutout',route=>route.fulfill({contentType:'image/png',body:Buffer.from((apiTransparent?imageData.transparent:imageData.white).split(',')[1],'base64')}));
    await page.getByRole('combobox',{name:'白底处理方式',exact:true}).click();
    await page.getByText('已配置的抠图 API',{exact:true}).last().click();
    await page.getByRole('button',{name:'生成白底图',exact:true}).click();
    await page.waitForFunction(()=>window.__qa.s.getState().records.length===4 && !!window.__qa.s.getState().records[0].editor);
    await page.waitForFunction(()=>!document.querySelector('input[aria-label="旋转角度"]').disabled);
    const extractions=await page.evaluate(()=>window.__qa.extracted);
    apiTransparent=true;
    await page.getByRole('button',{name:'生成白底图',exact:true}).click();
    await page.waitForFunction(()=>window.__qa.s.getState().records.length===5 && !!window.__qa.s.getState().records[0].editor);
    await page.waitForFunction(()=>!document.querySelector('input[aria-label="旋转角度"]').disabled);
    assert.equal(await page.evaluate(()=>window.__qa.extracted),extractions);
    // Leaving during layer preparation must not write the late editor back to history.
    apiTransparent=false;
    await page.getByRole('button',{name:'生成白底图',exact:true}).click();
    await page.getByText('白底图已生成，正在准备右侧调整面板…',{exact:true}).waitFor();
    const pendingId=await page.evaluate(()=>window.__qa.s.getState().selectedId);
    await page.getByText('通用生图',{exact:true}).click();
    await page.evaluate(()=>new Promise(r=>setTimeout(r,1000)));
    assert.equal(await page.evaluate(id=>Boolean(window.__qa.s.getState().records.find(r=>r.id===id).editor),pendingId),false);
    assert.deepEqual(errors,[]);
    const result={passed:['AI generation opens editor','panel save stores adjustments','extraction failure retains image','retry does not regenerate','opaque API opens editor','transparent API reuses layer','late extraction ignored'],errors};
    await fs.mkdir('test-results/white-auto-edit',{recursive:true});await fs.writeFile('test-results/white-auto-edit/result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
} finally {await browser.close();}
