import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium} from 'playwright';
const root=process.cwd();let vite,browser;
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';import {App} from 'antd';import {MemoryRouter,useNavigate,useLocation} from 'react-router-dom';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import ImagePage from '/src/pages/image/index.tsx';import {useConfigStore,defaultConfig} from '/src/stores/use-config-store.ts';import {useServerConfigStore} from '/src/services/server-config.ts';import '/src/styles/globals.css';
window.__RUNTIME_CONFIG__={gptImageJobsEnabled:false,serverConfigEnabled:false};
useConfigStore.setState({config:{...defaultConfig,quality:'low',size:'auto',count:'1',channels:[{...defaultConfig.channels[0],apiKey:'LOCAL_SHARED_TEAM_KEY',baseUrl:'https://llm.zhitouzhuan.com/v1'}]}});
function TestPage(){window.navigate=useNavigate();window.currentPath=useLocation().search;return React.createElement(ImagePage);}
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(QueryClientProvider,{client:new QueryClient()},React.createElement(MemoryRouter,{initialEntries:['/image']},React.createElement(App,null,React.createElement(TestPage))))));
`;
try{
 vite=await createServer({configFile:false,root,resolve:{alias:{'@':resolve(root,'src')}},server:{host:'127.0.0.1',port:0,hmr:false,watch:null},plugins:[{name:'controlled-upload-delays',enforce:'pre',transform(code,id){
 if(id.endsWith('/pages/assets/generation-info.ts'))return code.replace('export async function restoreGenerationInput(info: AssetGenerationInfo) {','export async function restoreGenerationInput(info: AssetGenerationInfo) { await (globalThis as any).__restoreGate?.();');
 if(id.endsWith('/services/image-storage.ts'))return code.replace('return diagnose("uploadImage",','await (globalThis as any).__uploadGate?.(args[0]); return diagnose("uploadImage",');
 }},react(),{name:'image-safety-fixture',resolveId(id){if(id==='virtual:image-safety')return '\0image-safety.tsx';},load(id){if(id==='\0image-safety.tsx')return entry;},configureServer(server){server.middlewares.use(async(req,res,next)=>{if(req.url!=='/image')return next();res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/image','<div id="root" style="height:100vh"></div><script type="module" src="/@id/virtual:image-safety"></script>'));});}}]});
 await vite.listen();

 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(90000);
 await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
 await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/image`,{waitUntil:'domcontentloaded',timeout:180000});await page.locator('textarea').first().fill('manual prompt');
 const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=8;c.height=8;return c.toDataURL().split(',')[1];});
 const namedImages=await page.evaluate(names=>Object.fromEntries(names.map((name,i)=>{const c=document.createElement('canvas');c.width=8;c.height=8;const x=c.getContext('2d');x.fillStyle=`rgb(${i*19},${250-i*13},${i*7})`;x.fillRect(0,0,8,8);return [name,c.toDataURL().split(',')[1]];})),['A.png','B.png','C.png','D.png','NEW.png','SLOW.png','LATEST.png','RETRY.png','AFTER-REUSE.png','SECOND.png','AFTER-HISTORY.png']);
 const file=name=>({name,mimeType:'image/png',buffer:Buffer.from(namedImages[name],'base64')});
 await page.locator('input[type=file][multiple]').setInputFiles(['A','B','C','D'].map(n=>file(n+'.png')));
 await page.waitForFunction(()=>document.querySelectorAll('img[alt$=".png"]').length===4);
 const originalOrder=await page.locator('img[alt$=".png"]').evaluateAll(items=>items.map(i=>i.alt));assert.deepEqual(originalOrder,['A.png','B.png','C.png','D.png']);
 await page.locator('input[type=file][multiple]').setInputFiles(file('NEW.png'));
 await page.locator('img[alt="NEW.png"]').waitFor();
 const visibility=await page.locator('img[alt="NEW.png"]').evaluate(img=>{const strip=img.closest('.overflow-x-scroll');const a=img.getBoundingClientRect(),b=strip.getBoundingClientRect();return {left:strip.scrollLeft,visible:a.left>=b.left&&a.right<=b.right};});
 if(process.argv.includes('--expect-bug')){assert.equal(visibility.visible,false);console.log('REPRO newest image offscreen, strip remains on old images',visibility);}
 else {assert.equal(visibility.visible,true);console.log('PASS newest image visible',visibility);await mkdir('test-results/reference-focus',{recursive:true});await page.screenshot({path:'test-results/reference-focus/new-upload-visible.png'});}
 if(!process.argv.includes('--expect-bug')){
 // Explicit reorder and delete retain the visible target by ID, not array index.
 const strip=page.locator('[aria-label="参考图列表"]');
 await strip.getByRole('button',{name:'参考图 5前移',exact:true}).click();
 assert.deepEqual(await strip.locator('img').evaluateAll(items=>items.map(i=>i.alt)),[...originalOrder.slice(0,3),'NEW.png',originalOrder[3]]);
 await strip.locator('[data-reference-id]').filter({has:page.locator('img[alt="NEW.png"]')}).getByRole('button',{name:'移除参考图',exact:true}).click();
 assert.equal(await strip.locator('img[alt="NEW.png"]').count(),0);
 // Older completion cannot move the strip away from the newer upload.
 await page.evaluate(()=>{window.__uploadGate=file=>file?.name==='SLOW.png'?new Promise(resolve=>window.releaseUpload=resolve):undefined;});
 await page.locator('input[type=file][multiple]').setInputFiles(file('SLOW.png'));
 await page.locator('input[type=file][multiple]').setInputFiles(file('LATEST.png'));
 await strip.locator('img[alt="LATEST.png"]').waitFor();
 const position=await strip.evaluate(el=>el.scrollLeft);
 await page.evaluate(()=>window.releaseUpload());await strip.locator('img[alt="SLOW.png"]').waitFor();
 const visible=await strip.locator('img[alt="LATEST.png"]').evaluate(img=>{const a=img.getBoundingClientRect(),b=img.closest('[aria-label="参考图列表"]').getBoundingClientRect();return a.left>=b.left&&a.right<=b.right;});assert(visible);
 const names=await strip.locator('img').evaluateAll(items=>items.map(i=>i.alt));assert(names.indexOf('SLOW.png')<names.indexOf('LATEST.png'));
 // Fail once, then retry the same queued file successfully.
 await page.evaluate(()=>{let failed=false;window.__uploadGate=file=>{if(file?.name==='RETRY.png'&&!failed){failed=true;throw Error('synthetic read failure');}};});
 await page.locator('input[type=file][multiple]').setInputFiles(file('RETRY.png'));
 await page.getByRole('button',{name:'重试',exact:true}).click();await strip.locator('img[alt="RETRY.png"]').waitFor();
 // Delay the real asset restore; new upload must cancel its replacement commit and consume the URL.
 await page.evaluate(async png=>{
  const {useAssetStore}=await import('/src/stores/use-asset-store.ts');
  const id=useAssetStore.getState().addAsset({kind:'image',title:'old source',coverUrl:'',tags:[],data:{dataUrl:'',width:8,height:8,bytes:10,mimeType:'image/png'},generation:{version:1,prompt:'OLD PROMPT',model:'default::gpt-image-2',parameters:{size:'2:3'},references:[{id:'old',name:'RESTORED-OLD.png',type:'image/png',dataUrl:'data:image/png;base64,'+png}],source:{kind:'image'}}});
  window.oldAssetId=id;
  window.__restoreGate=()=>new Promise(resolve=>{window.releaseRestore=resolve;});
  window.navigate('/image?reuseAsset='+id+'&reuseRequest=slow');
 },png);
 await page.waitForFunction(()=>typeof window.releaseRestore==='function');
 await page.locator('input[type=file][multiple]').setInputFiles(file('AFTER-REUSE.png'));
 await strip.locator('img[alt="AFTER-REUSE.png"]').waitFor();await page.evaluate(()=>window.releaseRestore());
 await page.waitForTimeout(200);
 assert.equal(await strip.locator('img[alt="RESTORED-OLD.png"]').count(),0);
 assert.equal(await page.locator('textarea').first().inputValue(),'');
 assert.equal(await page.evaluate(()=>window.currentPath),'');
 // Submit exactly the currently visible references after explicit reordering.
 await page.evaluate(()=>{window.__restoreGate=undefined;});
 await page.locator('input[type=file][multiple]').setInputFiles(file('SECOND.png'));
 await strip.locator('img[alt="SECOND.png"]').waitFor();
 const beforeOrder=await strip.locator('img').evaluateAll(items=>items.map(i=>i.alt));
 await strip.getByRole('button',{name:'参考图 2前移',exact:true}).click();
 const expectedOrder=[beforeOrder[1],beforeOrder[0]];
 assert.deepEqual(await strip.locator('img').evaluateAll(items=>items.map(i=>i.alt)),expectedOrder);
 const expectedBytes=await strip.locator('img').evaluateAll(async items=>Promise.all(items.map(async img=>Array.from(new Uint8Array(await(await fetch(img.src)).arrayBuffer())))));
 let submission;
 await page.route('**/images/edits',async route=>{submission={body:route.request().postDataBuffer(),headers:route.request().headers()};await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data:[{b64_json:png}]})});});
 await page.locator('textarea').first().fill('CURRENT INPUT');await page.getByRole('button',{name:'开始生成',exact:true}).click();
 await page.getByRole('button',{name:'分层编辑',exact:true}).waitFor();
 assert(submission);const form=await new Request('http://local.test',{method:'POST',headers:submission.headers,body:submission.body}).formData();
 const files=form.getAll('image[]');assert.equal(files.length,2);
 for(let i=0;i<files.length;i++)assert.deepEqual(Array.from(new Uint8Array(await files[i].arrayBuffer())),expectedBytes[i]);
 console.log('PASS distinct multipart bytes match current reference order; no stale restored image submitted');
 const history=page.locator('aside [data-generation-status="success"]').getByText('CURRENT INPU',{exact:true});await history.click();
 await page.locator('input[type=file][multiple]').setInputFiles(file('AFTER-HISTORY.png'));
 await strip.locator('img[alt="AFTER-HISTORY.png"]').waitFor();
 assert.equal(await page.getByRole('button',{name:'分层编辑',exact:true}).count(),0);
 await history.click();await page.getByRole('button',{name:'分层编辑',exact:true}).waitFor();
 assert.deepEqual(await strip.locator('img').evaluateAll(items=>items.map(i=>i.alt)),expectedOrder);
 await page.evaluate(()=>window.navigate('/image?reuseAsset='+window.oldAssetId+'&reuseRequest=explicit-again'));
 await strip.locator('img[alt="RESTORED-OLD.png"]').waitFor();
 assert.equal(await page.locator('textarea').first().inputValue(),'OLD PROMPT');
 console.log('PASS history preview detached on new upload, old history and explicit asset reuse still accessible');
 console.log('PASS reorder/delete, delayed older upload, failed retry, late asset restore suppressed and reuse URL consumed');
 }
 await mkdir('test-results/reference-focus' ,{recursive:true});await page.screenshot({path:'test-results/reference-focus/'+(process.argv.includes('--expect-bug')?'before':'after')+'.png'});
}finally{await browser?.close();await vite?.close();}
