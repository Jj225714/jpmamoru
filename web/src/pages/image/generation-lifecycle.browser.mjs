import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium} from 'playwright';
const root=process.cwd();let vite,browser;
const entry=`
import localforage from 'localforage';window.readGenerationLogs=async()=>{const rows=[];await localforage.createInstance({name:'infinite-canvas',storeName:'image_generation_logs'}).iterate(v=>{rows.push(v);});return rows;};
import React from 'react';import {createRoot} from 'react-dom/client';import {App} from 'antd';import {MemoryRouter,useNavigate,useLocation} from 'react-router-dom';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import ImagePage from '/src/pages/image/index.tsx';import {useConfigStore,defaultConfig} from '/src/stores/use-config-store.ts';import {useServerConfigStore} from '/src/services/server-config.ts';import '/src/styles/globals.css';
window.__RUNTIME_CONFIG__={gptImageJobsEnabled:false,serverConfigEnabled:false};
useConfigStore.setState({config:{...defaultConfig,quality:'low',size:'auto',count:'1',channels:[{...defaultConfig.channels[0],apiKey:'LOCAL_SHARED_TEAM_KEY',baseUrl:'https://llm.zhitouzhuan.com/v1'}]}});
window.configRefresh=()=>{const config=useConfigStore.getState().config;useConfigStore.setState({config:{...config,channels:config.channels.map(c=>({...c,name:c.name+' refreshed'}))}});};
window.phaseRefresh=()=>{useServerConfigStore.setState({phase:'checking'});setTimeout(()=>useServerConfigStore.setState({phase:'ready'}),50);};
window.setAccount=id=>useServerConfigStore.setState({user:id?{id}:null,phase:id?'ready':'signed-out'});
function TestPage(){window.navigate=useNavigate();window.currentPath=useLocation().search;return React.createElement(ImagePage);}
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(QueryClientProvider,{client:new QueryClient()},React.createElement(MemoryRouter,{initialEntries:['/image']},React.createElement(App,null,React.createElement(TestPage))))));
`;
try{
 vite=await createServer({configFile:false,root,cacheDir:resolve(root,'test-results/generation-lifecycle/vite-cache'),resolve:{alias:{'@':resolve(root,'src')}},server:{host:'127.0.0.1',port:0,hmr:false,watch:null},plugins:[react(),{name:'image-safety-fixture',resolveId(id){if(id==='virtual:image-safety')return '\0image-safety.tsx';},load(id){if(id==='\0image-safety.tsx')return entry;},configureServer(server){server.middlewares.use(async(req,res,next)=>{if(req.url!=='/image')return next();res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/image','<div id="root" style="height:100vh"></div><script type="module" src="/@id/virtual:image-safety"></script>'));});}}]});

 await vite.listen();browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(60000);
 await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
 await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/image`,{waitUntil:'domcontentloaded',timeout:180000});
 await page.locator('textarea').first().fill('DELAYED RUN');
 const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=8;c.height=8;return c.toDataURL().split(',')[1];});
 await page.locator('input[type=file][multiple]').setInputFiles({name:'reference.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});await page.locator('img[alt="reference.png"]').waitFor();
 let release,arrived;const accepted=new Promise(resolve=>arrived=resolve);let submits=0,finished=false;
 await page.route('**/images/edits',async route=>{submits++;arrived();await new Promise(resolve=>release=resolve);try{await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data:[{b64_json:png}]})});finished=true;}catch{}});
 const records=()=>page.evaluate(()=>window.readGenerationLogs());
 await page.getByRole('button',{name:'开始生成',exact:true}).click();await accepted;
 for(let i=0;i<10;i++)await page.mouse.move(100+i*80,300+i*20);
 assert.equal(await page.locator('textarea').first().inputValue(),'DELAYED RUN');
 await page.evaluate(()=>window.configRefresh());
 await page.waitForTimeout(200);
 if(process.argv.includes('--expect-bug')){
  assert.equal(await page.locator('textarea').first().inputValue(),'');assert.equal((await records()).length,0);
  release();await page.waitForTimeout(500);assert(finished);assert.equal((await records()).length,0);
  console.log('REPRO mouse alone retained UI; same-account channel rename remounted it; HTTP returned but no result/history; submits='+submits);
 }else{
  assert.equal(await page.locator('textarea').first().inputValue(),'DELAYED RUN');assert.equal((await records())[0].status,'running');
  await page.evaluate(()=>window.phaseRefresh());await page.waitForTimeout(100);assert.equal(await page.locator('textarea').first().inputValue(),'DELAYED RUN');
  release();await page.getByRole('button',{name:'分层编辑',exact:true}).waitFor();await page.waitForTimeout(200);assert.equal((await records())[0].status,'success');assert.equal(submits,1);
  await mkdir('test-results/generation-lifecycle',{recursive:true});await page.screenshot({path:'test-results/generation-lifecycle/completed.png'});
  console.log('PASS mouse/config/phase changes preserve pending UI and one request finishes into saved history');
  await page.unroute('**/images/edits');
  await page.route('**/images/edits',route=>{submits++;return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:{message:'synthetic failure'}})});});
  await page.locator('textarea').first().fill('FAILED RUN');await page.getByRole('button',{name:'开始生成',exact:true}).click();
  await page.locator('aside').getByText('生成失败',{exact:true}).waitFor();
  assert((await records()).some(r=>r.prompt==='FAILED RUN'&&r.status==='failed'&&r.error.includes('synthetic failure')));
  await page.unroute('**/images/edits');
  await page.route('**/images/edits',route=>{submits++;return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data:[{b64_json:png}]})});});
  await mkdir('test-results/generation-lifecycle',{recursive:true});await page.screenshot({path:'test-results/generation-lifecycle/failure.png'});
  await page.getByRole('button',{name:/^重\s*试$/}).click();await page.getByRole('button',{name:'分层编辑',exact:true}).waitFor();
  await page.waitForTimeout(200);assert((await records()).some(r=>r.prompt==='FAILED RUN'&&r.status==='success'));
  // Reload during a synchronous request: receipt survives, no automatic resubmit.
  await page.unroute('**/images/edits');let acceptedReload,releaseReload;const accepted2=new Promise(resolve=>acceptedReload=resolve);
  await page.route('**/images/edits',async route=>{submits++;acceptedReload();await new Promise(resolve=>releaseReload=resolve);try{await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data:[{b64_json:png}]})});}catch{}});
  await page.locator('textarea').first().fill('REFRESH RUN');await page.getByRole('button',{name:'开始生成',exact:true}).click();await accepted2;
  const beforeRefresh=submits;await page.reload({waitUntil:'domcontentloaded'});
  await page.locator('aside').getByText('跟踪已中断 · 待核实',{exact:true}).waitFor();releaseReload();await page.waitForTimeout(200);assert.equal(submits,beforeRefresh);
  // Actual account boundary in the page store, including a synchronous ABA batch.
  for(const aba of [false,true]){
   await page.evaluate(()=>window.setAccount('A'));await page.locator('textarea').first().fill(aba?'ABA RUN':'ACCOUNT RUN');
   await page.locator('input[type=file][multiple]').setInputFiles({name:'reference.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});await page.locator('img[alt="reference.png"]').waitFor();
   await page.unroute('**/images/edits');let accept,releaseAccount;const waiting=new Promise(resolve=>accept=resolve);
   await page.route('**/images/edits',async route=>{submits++;accept();await new Promise(resolve=>releaseAccount=resolve);await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data:[{b64_json:png}]})});});
   await page.getByRole('button',{name:'开始生成',exact:true}).click();await waiting;
   await page.evaluate(aba=>{window.setAccount('B');if(aba)window.setAccount('A');},aba);
   assert.equal(await page.locator('textarea').first().inputValue(),'');assert.equal(await page.locator('img[alt="reference.png"]').count(),0);
   if(!aba)assert.equal(await page.locator('aside').getByText('ACCOUNT RUN',{exact:true}).count(),0);
   releaseAccount();await page.waitForTimeout(300);assert.equal(await page.getByRole('button',{name:'分层编辑',exact:true}).count(),0);
   const saved=(await records()).find(r=>r.prompt===(aba?'ABA RUN':'ACCOUNT RUN'));
   assert.equal(saved.accountId,'A');assert.equal(saved.status,'interrupted');
  }
  console.log('PASS failure and explicit retry history; reload preserves uncertain receipt without POST; A/B and ABA clear private inputs and block late response; submits='+submits);
 }
 await mkdir('test-results/generation-lifecycle',{recursive:true});await page.screenshot({path:'test-results/generation-lifecycle/'+(process.argv.includes('--expect-bug')?'before':'after')+'.png'});
}finally{await browser?.close();await vite?.close();}
