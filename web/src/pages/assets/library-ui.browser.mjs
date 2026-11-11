// Run from web/: node src/services/membership-library.integration.e2e.mjs
// Real TS clients + HTTPS browser + real vault subprocess; only JAPI identity is simulated.
import assert from 'node:assert/strict';
import {createServer as httpServer, request} from 'node:http';
import {fork,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium} from 'playwright';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const storeDir=await mkdtemp(join(tmpdir(),'asset-client-integration-'));
const key=randomBytes(32).toString('hex');
let vite,browser,worker,port;
const receipts=[];
const auth=httpServer(async(req,res)=>{
    let id;
    if(req.url==='/api/v1/auth/login') { let data='';for await(const chunk of req)data+=chunk; id=JSON.parse(data).email.split('@')[0]; }
    else id=req.headers.authorization?.replace('Bearer test-token-','');
    if(!['1','2'].includes(id)){res.writeHead(401).end('{}');return;}
    const user={id:Number(id),email:`${id}@example.test`,status:'active'};
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:req.url.endsWith('/login')?{user,access_token:`test-token-${id}`,refresh_token:`test-refresh-${id}`,expires_in:3600}:user}));
});
await new Promise(r=>auth.listen(0,'127.0.0.1',r));
const entry=`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {App} from 'antd';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';
import AssetsPage from '/src/pages/assets/index.tsx';
import {useAssetStore} from '/src/stores/use-asset-store.ts';
import '/src/styles/globals.css';
import {uploadImage} from '/src/services/image-storage.ts';
window.createGeneratedFixture=async(model='_channel::image-v1',size='1.90:1',title='Generated fixture')=>{const canvas=document.createElement('canvas');canvas.width=4;canvas.height=4;canvas.getContext('2d').fillStyle='red';canvas.getContext('2d').fillRect(0,0,4,4);const ref=await uploadImage(canvas.toDataURL());canvas.getContext('2d').fillStyle='blue';canvas.getContext('2d').fillRect(0,0,4,4);const main=await uploadImage(canvas.toDataURL());window.localAssets.getState().addAsset({kind:'image',title,coverUrl:main.url,tags:[],data:{dataUrl:main.url,storageKey:main.storageKey,width:4,height:4,bytes:main.bytes,mimeType:main.mimeType},generation:{version:1,prompt:'Standard generated asset',model,parameters:{size,quality:'auto',background:''},references:[{id:'ref-local',name:'ref.png',type:'image/png',storageKey:ref.storageKey}],source:{kind:'image',taskId:'task-local'}}});};
window.mountAssets=()=>{const host=document.createElement('div');host.style.height='100vh';document.body.append(host);createRoot(host).render(React.createElement(QueryClientProvider,{client:new QueryClient()},React.createElement(MemoryRouter,null,React.createElement(App,null,React.createElement(AssetsPage)))));};
window.localAssets=useAssetStore;

import * as memberships from '/src/services/membership-library.ts';
import * as assets from '/src/services/asset-library.ts';
import {useServerConfigStore} from '/src/services/server-config.ts';
window.client={...memberships,...assets,async login(id){
 useServerConfigStore.setState({phase:'checking'});
 const response=await fetch('/api/config-vault/login',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({email:id+'@example.test',password:'test-only'})});
 if(!response.ok)throw Error('test login failed');const data=await response.json();
 useServerConfigStore.setState({user:data.user,phase:'ready'});
},options(){return memberships.useMembershipLibrary.getState().teams;}};
`;
async function stopWorker(){if(worker && worker.exitCode===null){const ended=once(worker,'exit');worker.send('stop');await ended;}}
async function startWorker(origin){
 worker=fork(new URL('./library-ui-worker.mjs',import.meta.url),[],{stdio:['ignore','ignore','inherit','ipc']});
 const ready=once(worker,'message');worker.send({origin,authBaseUrl:`http://127.0.0.1:${auth.address().port}/api/v1`,storeDir,key});
 port=(await ready)[0].port;
}
try {
 execFileSync(process.env.TEST_PYTHON || 'python',[resolve(root,'tests/fixtures/settings-sync-cert.py'),storeDir]);
 vite=await createServer({configFile:false,root,resolve:{alias:{'@':resolve(root,'src')}},server:{host:'127.0.0.1',port:0,https:{key:await readFile(join(storeDir,'key.pem')),cert:await readFile(join(storeDir,'cert.pem'))},hmr:false,watch:null},plugins:[react(),{
  name:'real-library-client-test',resolveId(id){if(id==='virtual:real-library-client-test')return '\0real-library-client-test';},load(id){if(id==='\0real-library-client-test')return entry;},
  configureServer(server){server.middlewares.use(async(req,res,next)=>{
   if(req.url.startsWith('/api/config-vault/')){
    const headers=Object.fromEntries(Object.entries(req.headers).filter(([name])=>!name.startsWith(':')));
    headers.host=req.headers[':authority'] || req.headers.host;
    const upstream=request({hostname:'127.0.0.1',port,path:req.url,method:req.method,headers},reply=>{
     const responseHeaders=Object.fromEntries(Object.entries(reply.headers).filter(([name])=>!['connection','keep-alive','transfer-encoding'].includes(name)));
     receipts.push({method:req.method,path:req.url,status:reply.statusCode,accountHeader:headers['x-config-user'] || null});res.writeHead(reply.statusCode,responseHeaders);reply.pipe(res);
    });upstream.on('error',()=>{res.writeHead(502).end('{}');});req.pipe(upstream);return;
   }
   if(req.url!=='/__integration')return next();res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/__integration','<script type="module" src="/@id/virtual:real-library-client-test"></script>'));
  });}
 }]});
 await vite.listen();const origin=`https://127.0.0.1:${vite.httpServer.address().port}`;await startWorker(origin);
 browser=await chromium.launch({headless:true});
 const pages=[];
 for(const id of [1,2]){
  const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}});const page=await context.newPage();page.setDefaultTimeout(45000);
  await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  await page.goto(origin+'/__integration',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>Boolean(window.client));await page.evaluate(id=>window.client.login(id),id);
  const cookie=(await context.cookies()).find(item=>item.name==='__Secure-config_vault');assert.ok(cookie?.secure && cookie?.httpOnly);pages.push(page);
 }
 const [admin,member]=pages;
 const call=(page,method,...args)=>page.evaluate(async({method,args})=>window.client[method](...args),{method,args});
 const denied=async(page,method,args,status)=>{
  const result=await page.evaluate(async({method,args})=>{try{await window.client[method](...args);return 200;}catch(e){return e.status;}},{method,args});assert.equal(result,status);
 };
 console.log('Accounts ready');
 const team=(await call(admin,'createAssetTeam','UI Team')).team;
 const invitation=(await call(admin,'inviteAssetMember',team.id,'2','read')).invitation;
 await call(member,'acceptAssetInvitation',invitation.token);
 const project=(await call(admin,'createAssetProject',team.id,'UI Project')).project;
 await call(admin,'setAssetProjectRole',team.id,project.id,'2','read');
 for(const page of pages){await page.evaluate(()=>{window.localAssets.getState().addAsset({kind:'text',title:'Local history',coverUrl:'',tags:[],data:{content:'local-data'}});window.mountAssets();});}
 const choose=async(page,label)=>{await page.getByRole('combobox',{name:'资产范围',exact:true}).click();await page.getByText(label,{exact:true}).last().click();};
 await choose(admin,'个人资产 · 可写');
 await admin.getByRole('button',{name:'上传文件',exact:true}).waitFor();
 await admin.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='上传文件'&&!b.disabled));
 await admin.getByLabel('上传服务端资产',{exact:true}).setInputFiles({name:'private.txt',mimeType:'text/plain',buffer:Buffer.from('private-data')});
 await admin.getByText('private.txt',{exact:true}).waitFor();
 const privateId=await admin.locator('[data-library-asset]').first().getAttribute('data-library-asset');
 await admin.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='上传文件'&&!b.disabled));
 await admin.getByLabel('上传服务端资产',{exact:true}).setInputFiles({name:'private.txt',mimeType:'text/plain',buffer:Buffer.from('private-data')});
 await admin.getByText(/内容已存在，复用稳定 ID/).waitFor();
 assert.equal(await admin.locator('[data-library-asset]').count(),1);
 await admin.getByLabel('上传服务端资产',{exact:true}).setInputFiles({name:'fill.txt',mimeType:'text/plain',buffer:Buffer.from('x'.repeat(1012))});
 await admin.getByText(/容量已达上限/).waitFor();
 assert.equal((await call(admin,'getLibraryQuota',{scope:'personal'})).usedBytes,1024);
 await admin.getByLabel('上传服务端资产',{exact:true}).setInputFiles({name:'overflow.txt',mimeType:'text/plain',buffer:Buffer.from('x')});
 await admin.getByText('资产操作未完成',{exact:true}).waitFor();
 await admin.getByRole('button',{name:'刷新资产',exact:true}).click();await admin.getByText('fill.txt',{exact:true}).waitFor();
 console.log('Personal quota/dedup verified');
 await choose(member,'个人资产 · 可写');await member.getByText('没有匹配的资产',{exact:true}).waitFor();
 await choose(admin,'项目 · UI Team / UI Project · 可写');
 await admin.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='上传文件'&&!b.disabled));
 await admin.getByLabel('上传服务端资产',{exact:true}).setInputFiles({name:'project.txt',mimeType:'text/plain',buffer:Buffer.from('project-data')});
 await admin.getByText('project.txt',{exact:true}).waitFor();
 await choose(member,'项目 · UI Team / UI Project · 只读');await member.getByText('project.txt',{exact:true}).waitFor();
 assert.equal(await member.getByRole('button',{name:'上传文件',exact:true}).isDisabled(),true);
 assert.equal(await member.getByRole('button',{name:'移入回收站',exact:true}).isDisabled(),true);
 const projectScope={scope:'project',teamId:team.id,projectId:project.id};
 const acl=await member.evaluate(async scope=>(await fetch('/api/config-vault'+window.client.assetLibraryPath(scope),{method:'POST',headers:{'Content-Type':'application/json','X-Config-User':'2'},body:JSON.stringify({scope:'project',name:'forged.txt',mimeType:'text/plain',data:btoa('forged')})})).status,projectScope);assert.equal(acl,403);
 await call(admin,'setAssetMemberRole',team.id,'2','write');
 await call(admin,'setAssetProjectRole',team.id,project.id,'2','write'); await member.getByRole('button',{name:'刷新范围与权限'}).click();
 await member.waitForFunction(()=>document.querySelector('button')&&Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='上传文件'&&!b.disabled));
 console.log('Project ACL verified');
 await member.getByRole('button',{name:'读取文件',exact:true}).click();await member.getByRole('button',{name:'下载原文件'}).waitFor();
 await member.getByRole('button',{name:'Close',exact:true}).click();
 await member.getByRole('button',{name:'移入回收站',exact:true}).click();await member.getByRole('dialog').getByRole('button',{name:'移入回收站',exact:true}).click();await member.getByText('没有匹配的资产',{exact:true}).waitFor();
 await member.getByRole('button',{name:'回收站',exact:true}).click();await member.getByText('project.txt',{exact:true}).waitFor();await member.getByRole('button',{name:/恢\s*复/}).click();await member.getByText('回收站为空',{exact:true}).waitFor();
 await member.getByRole('button',{name:'返回资产列表'}).click();await member.getByText('project.txt',{exact:true}).waitFor();
 await member.getByRole('button',{name:'审计记录'}).click();await member.getByText(/action：restore/).waitFor();await member.getByRole('button',{name:'Close',exact:true}).click();
 console.log('Trash/restore/audit verified');
 await admin.getByRole('button',{name:'复制本地资产到此范围'}).click();await admin.getByRole('combobox',{name:'待迁移本地资产'}).click();await admin.getByText('Local history · text',{exact:true}).last().click();await admin.getByRole('button',{name:'复制并校验映射 / 继续原迁移'}).click();await admin.getByText(/已验证并保存映射/).waitFor();
 assert.equal(await admin.evaluate(()=>window.localAssets.getState().assets.length),1);
 await admin.getByRole('button',{name:'复制并校验映射 / 继续原迁移'}).click();await admin.getByText(/恢复原映射/).waitFor();
 await admin.getByRole('button',{name:'Close',exact:true}).click();await admin.getByText('Local history',{exact:true}).waitFor();
 await admin.evaluate(()=>window.createGeneratedFixture());
 await admin.getByRole('button',{name:'复制本地资产到此范围'}).click();await admin.getByRole('combobox',{name:'待迁移本地资产'}).click();await admin.getByText('Generated fixture · image',{exact:true}).last().click();await admin.getByRole('button',{name:'复制并校验映射 / 继续原迁移'}).click();await admin.getByText(/已验证并保存映射/).waitFor();await admin.getByRole('button',{name:'Close',exact:true}).click();
 await admin.locator('[data-library-asset]').filter({has:admin.getByText('Generated fixture',{exact:true})}).getByRole('button',{name:'来源与详情'}).click();await admin.getByText('模型：_channel::image-v1',{exact:true}).waitFor();await admin.getByText(/requestedSize/).waitFor();await admin.waitForTimeout(400);await mkdir(resolve(root,'test-results/asset-library-ui'),{recursive:true});await admin.screenshot({path:resolve(root,'test-results/asset-library-ui/generated-provenance.png')});await admin.getByRole('button',{name:'Close',exact:true}).click();
 await admin.evaluate(()=>window.createGeneratedFixture('-channel::image-v1','2.5:1','Generated dash'));
 await admin.getByRole('button',{name:'复制本地资产到此范围'}).click();await admin.getByRole('combobox',{name:'待迁移本地资产'}).click();await admin.getByText('Generated dash · image',{exact:true}).last().click();await admin.getByRole('button',{name:'复制并校验映射 / 继续原迁移'}).click();await admin.getByText(/已验证并保存映射/).waitFor();await admin.getByText(/内容去重/).waitFor();await admin.getByRole('button',{name:'Close',exact:true}).click();
 await admin.reload();await admin.waitForFunction(()=>Boolean(window.client));await call(admin,'login',1);await admin.evaluate(()=>window.mountAssets());await choose(admin,'项目 · UI Team / UI Project · 可写');await admin.getByText('Generated fixture',{exact:true}).waitFor();
 const migrationWrites=receipts.filter(row=>row.method==='POST'&&row.path.includes('/migrations')).length;
 await admin.getByRole('button',{name:'复制本地资产到此范围'}).click();await admin.getByRole('combobox',{name:'待迁移本地资产'}).click();await admin.getByText('Generated dash · image',{exact:true}).last().click();await admin.getByRole('button',{name:'复制并校验映射 / 继续原迁移'}).click();await admin.getByText(/恢复原映射/).waitFor();assert.equal(receipts.filter(row=>row.method==='POST'&&row.path.includes('/migrations')).length,migrationWrites);await admin.getByRole('button',{name:'Close',exact:true}).click();
 assert.equal(await admin.evaluate(()=>window.localAssets.getState().assets.length),3);
 await admin.locator('[data-library-asset]').filter({has:admin.getByText('Generated fixture',{exact:true})}).getByRole('button',{name:'来源与详情'}).click();await admin.getByText('模型：-channel::image-v1',{exact:true}).waitFor();await admin.getByText(/2.5:1/).waitFor();await admin.getByRole('button',{name:'Close',exact:true}).click();
 await admin.locator('[data-library-asset]').filter({has:admin.getByText('Local history',{exact:true})}).getByRole('button',{name:'来源与详情'}).click();await admin.getByText(/localId：local-/).waitFor();
 await mkdir(resolve(root,'test-results/asset-library-ui'),{recursive:true});await admin.waitForTimeout(400);await admin.screenshot({path:resolve(root,'test-results/asset-library-ui/provenance.png')});
 await call(admin,'removeAssetMember',team.id,'2');await member.getByRole('button',{name:'刷新资产',exact:true}).click();await member.getByText('该范围不可用，可能已撤权或登录失效',{exact:true}).waitFor();assert.equal(await member.locator('[data-library-asset]').count(),0);
 await choose(member,'本地历史资产');await member.getByText('Local history',{exact:true}).waitFor();
 await call(member,'login',1);await choose(member,'个人资产 · 可写');await member.getByText('private.txt',{exact:true}).waitFor();
 await call(member,'login',2);assert.equal(await member.locator('[data-library-asset]').count(),0);await choose(member,'个人资产 · 可写');await member.getByText('没有匹配的资产',{exact:true}).waitFor();
 await member.reload();await member.waitForFunction(()=>Boolean(window.client));await call(member,'login',2);await member.evaluate(()=>window.mountAssets());await member.getByText('Local history',{exact:true}).waitFor();
 console.log(JSON.stringify({result:'PASS',checks:['real vault + HTTPS + 2 accounts','personal isolation','project readonly/write and direct forbidden POST','upload dedup stable ID/hash','real 1024-byte quota boundary and overflow rejection','binary read','trash/restore','audit','verified text+generated migration/defaults/_ and - channel/decimal ratios','refresh replay without POST; local retained','revocation clears data','real login switches','reload local fallback'],privateId,requests:receipts.length}));
}finally{
 await browser?.close();await stopWorker();await vite?.close();auth.closeAllConnections();await new Promise(r=>auth.close(r));
 if(!resolve(storeDir).startsWith(resolve(tmpdir())+sep))throw Error('unsafe cleanup');
 await rm(storeDir,{recursive:true,force:true});
}
