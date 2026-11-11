import assert from "node:assert/strict";
import { chromium } from "playwright";
const browser=await chromium.launch({headless:true});
try{
    const page=await browser.newPage();
    await page.goto((process.env.WHITE_TEST_URL||"http://127.0.0.1:3018")+"/image?mode=product-white");
    await page.getByRole("button",{name:"上传商品图片",exact:true}).waitFor();
    const png=await page.evaluate(async()=>{
        const {useServerConfigStore}=await import("/src/services/server-config.ts");
        useServerConfigStore.setState({user:{id:101},phase:"ready"});
        const descriptor=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,"src");
        window.__delayedWhiteRead=false;
        Object.defineProperty(HTMLImageElement.prototype,"src",{...descriptor,set(value){
            if(value.startsWith("blob:")&&!window.__delayedWhiteRead){window.__delayedWhiteRead=true;setTimeout(()=>{descriptor.set.call(this,value);window.__whiteDelayFinished=true;},1200);}
            else descriptor.set.call(this,value);
        }});
        const canvas=document.createElement("canvas");canvas.width=canvas.height=16;canvas.getContext("2d").fillRect(2,2,12,12);return canvas.toDataURL().split(",")[1];
    });
    await page.locator('input[type="file"]').setInputFiles({name:"account-A.png",mimeType:"image/png",buffer:Buffer.from(png,"base64")});
    await page.waitForFunction(()=>window.__delayedWhiteRead);
    await page.evaluate(async()=>{(await import("/src/services/server-config.ts")).useServerConfigStore.setState({user:{id:202},phase:"ready"});});
    await page.waitForFunction(()=>window.__whiteDelayFinished);
    // Let decode, IndexedDB write and thumbnail creation finish after the account switch.
    await page.waitForTimeout(500);
    assert.ok(await page.getByRole("button",{name:"生成白底图",exact:true}).isDisabled());
    assert.equal(await page.getByText("account-A.png: 已就绪",{exact:false}).count(),0);
    await page.locator('input[type="file"]').setInputFiles({name:"account-B.png",mimeType:"image/png",buffer:Buffer.from(png,"base64")});
    await page.getByText("account-B.png: 已就绪",{exact:false}).waitFor();
    assert.ok(await page.getByRole("button",{name:"生成白底图",exact:true}).isEnabled());
    console.log("PASS: real account-store A→B notification invalidates delayed upload; B can select a new source");
}finally{await browser.close();}
