import assert from "node:assert/strict";
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });
    await page.goto(process.env.WHITE_TEST_URL || "http://127.0.0.1:3018");
    const report = await page.evaluate(async () => {
        const edit = await import("/src/lib/commerce/white-image-edit.ts");
        const renderer = await import("/src/lib/commerce/white-image-renderer.ts");
        const storage = await import("/src/services/image-storage.ts");
        const source = document.createElement("canvas"); source.width = source.height = 256;
        const c=source.getContext("2d"); c.fillStyle="#eee";c.fillRect(0,0,256,256);
        c.strokeStyle="#555";c.lineWidth=1;
        for(let n=0;n<=256;n+=32){c.beginPath();c.moveTo(n,0);c.lineTo(n,256);c.moveTo(0,n);c.lineTo(256,n);c.stroke();}
        c.fillStyle="#ff0000";
        for(const y of [0.25,0.5,0.75])for(const x of [0.25,0.5,0.75]){c.beginPath();c.arc(x*256,y*256,1.5,0,Math.PI*2);c.fill();}
        const layer={url:source.toDataURL(),width:256,height:256,bytes:100,mimeType:"image/png"};
        const base={width:0.8,height:0.8,bounds:{x:0,y:0,width:1,height:1}};
        const editor={version:1,layer,base,applied:edit.DEFAULT_WHITE_ADJUSTMENTS};
        const settings={...edit.DEFAULT_WHITE_ADJUSTMENTS,perspectiveEnabled:true,perspectiveInitialized:true,perspective:{topLeft:{x:0.2,y:0.2},topRight:{x:0.8,y:0.2},bottomRight:{x:0.9,y:0.8},bottomLeft:{x:0.1,y:0.8}}};
        const prepared=await renderer.loadWhiteLayer(layer),canvas=document.createElement("canvas");
        renderer.drawWhiteImage(canvas,prepared,editor,settings,1024);
        const before=canvas.getContext("2d").getImageData(0,0,1024,1024).data;
        const measure=(formula)=>{
            const data=canvas.getContext("2d").getImageData(0,0,1024,1024).data;let max=0;
            for(const v of [0.25,0.5,0.75])for(const u of [0.25,0.5,0.75]){
                const [x,y]=formula(u,v);let nearest=Infinity;
                for(let py=Math.floor(y)-3;py<=Math.ceil(y)+3;py++)for(let px=Math.floor(x)-3;px<=Math.ceil(x)+3;px++){
                    const i=(py*1024+px)*4;if(data[i]>220&&data[i+1]<60&&data[i+2]<60)nearest=Math.min(nearest,Math.hypot(px+0.5-x,py+0.5-y));
                }max=Math.max(max,nearest);
            }return max;
        };
        // Independent closed-form trapezoid reference, not the production matrix helper.
        const warpError=measure((u,v)=>[(0.6*u-0.125*v+0.2)/(1-0.25*v)*1024,(0.4*v+0.2)/(1-0.25*v)*1024]);
        const exported=await renderer.renderWhiteImage(editor,settings,{size:1024,format:"png"});
        const bitmap=await createImageBitmap(await fetch(await storage.imageToDataUrl(exported)).then(r=>r.blob()));
        canvas.getContext("2d").clearRect(0,0,1024,1024);canvas.getContext("2d").drawImage(bitmap,0,0);bitmap.close();
        const after=canvas.getContext("2d").getImageData(0,0,1024,1024).data;
        const exportEqual=before.every((v,i)=>v===after[i]);
        renderer.drawWhiteImage(canvas,prepared,editor,edit.correctWhitePerspective(base,settings),1024);
        const correctionError=measure((u,v)=>[(0.1+0.8*u)*1024,(0.1+0.8*v)*1024]);
        const ReactModule=await import("/node_modules/.vite/deps/react.js"),React=ReactModule.default||ReactModule;
        const client=await import("/node_modules/.vite/deps/react-dom_client.js");
        const {ProductWhiteEditor}=await import("/src/pages/image/product-white-editor.tsx");
        document.body.innerHTML='<div id="test"></div>';document.documentElement.classList.remove("dark");document.body.style.background="#fff";document.body.style.color="#111";
        function Harness(){const[value,setValue]=React.useState(settings);return React.createElement(ProductWhiteEditor,{editor,value,disabled:false,onChange:setValue,outputFormat:"png"});}
        (client.createRoot||client.default.createRoot)(document.getElementById("test")).render(React.createElement(Harness));
        return {warpError,correctionError,exportEqual};
    });
    assert.ok(report.warpError<1,JSON.stringify(report));assert.ok(report.correctionError<1,JSON.stringify(report));assert.ok(report.exportEqual);
    await page.getByLabel("吸附距离",{exact:true}).fill("0");
    const canvas=page.getByLabel("商品编辑画布");const box=await canvas.boundingBox();
    await page.mouse.move(box.x+box.width*0.9,box.y+box.height*0.8);await page.mouse.down();await page.mouse.move(box.x+box.width*0.85,box.y+box.height*0.75,{steps:4});await page.mouse.up();
    await page.waitForFunction(()=>Math.abs(Number(document.querySelector('[aria-label="bottomRight X"]').value)-0.85)<0.01);
    await page.getByRole("button",{name:/撤\s*销/}).click();
    assert.equal(Number(await page.getByLabel("bottomRight X",{exact:true}).inputValue()),0.9);
    await page.screenshot({path:"test-results/white-perspective-warped.png",fullPage:true});
    await page.getByRole("button",{name:/重\s*做/}).click();
    await page.getByRole("button",{name:"一键透视校正",exact:true}).click();
    assert.equal(Number(await page.getByLabel("bottomRight X",{exact:true}).inputValue()),0.9);
    assert.equal(Number(await page.getByLabel("bottomRight Y",{exact:true}).inputValue()),0.9);
    await page.screenshot({path:"test-results/white-perspective-grid.png",fullPage:true});
    console.log("PASS",JSON.stringify(report),"corner drag, undo/redo and correction");
}finally{await browser.close();}
