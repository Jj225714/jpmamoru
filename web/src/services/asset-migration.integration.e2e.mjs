// Run from web/: node src/services/asset-migration.integration.e2e.mjs
// Real TS clients + HTTPS browser + real vault subprocess; only JAPI identity is simulated.
import assert from 'node:assert/strict';
import {createServer as httpServer, request} from 'node:http';
import {fork,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readFile,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium} from 'playwright';
const root=fileURLToPath(new URL('../../',import.meta.url));
const storeDir=await mkdtemp(join(tmpdir(),'asset-client-integration-'));
const key=randomBytes(32).toString('hex');
let vite,browser,worker,port;
const receipts=[];
const checks=[];
const bounded=(promise,label,ms=45000)=>{let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' timed out')),ms);})]).finally(()=>clearTimeout(timer));};
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
import * as memberships from '/src/services/membership-library.ts';
import * as assets from '/src/services/asset-library.ts';
import localforage from 'localforage';
import {useServerConfigStore} from '/src/services/server-config.ts';
window.client={...memberships,...assets,async migrate(scope,localId,text,extra={}){
 return assets.migrateLibraryAsset(scope,{libraryId:'integration-library',localId,name:'fixture.txt',blob:new Blob([text],{type:'text/plain'}),metadata:{version:1,kind:'original'},...extra});
},async receipt(key){return localforage.createInstance({name:'infinite-canvas',storeName:'asset_migration_receipts'}).getItem(key);},async localPut(){await localforage.setItem('acceptance-old-asset',new Blob(['old-local-source']));},async localPresent(){return (await localforage.getItem('acceptance-old-asset')) instanceof Blob;},async login(id){
 useServerConfigStore.setState({phase:'checking'});
 const response=await fetch('/api/config-vault/login',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({email:id+'@example.test',password:'test-only'})});
 if(!response.ok)throw Error('test login failed');const data=await response.json();
 useServerConfigStore.setState({user:data.user,phase:'ready'});
},options(){return memberships.useMembershipLibrary.getState().teams;}};
`;
async function stopWorker(){if(worker && worker.exitCode===null){const ended=once(worker,'exit');worker.send('stop');try{await bounded(ended,'worker stop');}catch(error){worker.kill();throw error;}}}
async function startWorker(origin){
 worker=fork(new URL('./membership-library.integration-worker.mjs',import.meta.url),[],{stdio:['ignore','ignore','inherit','ipc']});
 const ready=once(worker,'message');worker.send({origin,authBaseUrl:`http://127.0.0.1:${auth.address().port}/api/v1`,storeDir,key});
 port=(await bounded(ready,'worker start'))[0].port;
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
  const context=await browser.newContext({ignoreHTTPSErrors:true});const page=await context.newPage();page.setDefaultTimeout(45000);
  await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  await page.goto(origin+'/__integration',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>Boolean(window.client));await page.evaluate(id=>window.client.login(id),id);
  const cookie=(await context.cookies()).find(item=>item.name==='__Secure-config_vault');assert.ok(cookie?.secure && cookie?.httpOnly);pages.push(page);
 }
 const [admin,member]=pages;
 const call=(page,method,...args)=>page.evaluate(async({method,args})=>window.client[method](...args),{method,args});
 const denied=async(page,method,args,status)=>{
  const result=await page.evaluate(async({method,args})=>{try{await window.client[method](...args);return 200;}catch(e){return e.status;}},{method,args});assert.equal(result,status);
 };
 const personal={scope:'personal'};
 await call(admin,'localPut');
 const defaultRecords=[];
 for(const [index,{size,model}] of [{size:'1:1',model:'default::gpt-image-2'},{size:'auto',model:'default::gpt-image-2'},{size:'1.90:1',model:'_nanoid::gpt-image-2'},{size:'2.5:1',model:'-nanoid::gpt-image-2'},{size:'0.1:0.3',model:'default::gpt-image-2'}].entries()) {
   const source={version:1,prompt:'Default source',model,parameters:{size,quality:'auto',background:'',count:'1'},references:[],generatedAt:'2026-10-25',source:{kind:'image',taskId:'defaults-task'}};
   const metadata=await call(admin,'mapLegacyAssetMetadata',{kind:'generated',generation:source});
   const options={metadata};const localId='defaults-'+index;
   const result=await call(admin,'migrate',personal,localId,'default-'+size,options);
   assert.equal(result.verified,true);
   assert.equal(result.asset.metadataEntries[0].generation.model,source.model);
   assert.deepEqual(result.asset.metadataEntries[0].generation.parameters,{count:1,quality:'auto',background:'unspecified',requestedSize:size});
   assert.equal((await call(admin,'migrate',personal,localId,'default-'+size,options)).mapping.fingerprint,result.mapping.fingerprint);
   if(size==='1.90:1') {
     const changed=structuredClone(metadata);changed.generation.parameters.requestedSize='1.9:1';
     await denied(admin,'migrate',[personal,localId,'default-'+size,{metadata:changed}],409);
   }
   defaultRecords.push({localId,body:'default-'+size,options,result});
 }
 checks.push('default/nanoid channel selectors, ratio/auto/decimal spelling and empty background migrate without inference; exact replay succeeds and changed spelling conflicts');
 const oldLocalId=await call(admin,'namespaceLibraryLocalId','integration-library','old-pixel');
 const oldMetadata={version:1,kind:'generated',source:{taskId:'old-task',localId:oldLocalId},generation:{version:1,prompt:'Old pixel source',model:'old-model',parameters:{width:1024,height:512,count:1,quality:'high',background:'white'}}};
 const seeded=await call(admin,'libraryRequest','/asset-library/migrations','POST',{scope:'personal',localId:oldLocalId,name:'fixture.txt',mimeType:'text/plain',data:Buffer.from('old-pixel-body').toString('base64'),metadata:oldMetadata});
 const oldAdapted=await call(admin,'mapLegacyAssetMetadata',{kind:'generated',generation:{version:1,prompt:'Old pixel source',model:'old-model',parameters:{size:'1024x512',count:'1',quality:'high',background:'white'},references:[],source:{kind:'image',taskId:'old-task'}}});
 const oldResumed=await call(admin,'migrate',personal,'old-pixel','old-pixel-body',{metadata:oldAdapted});
 assert.equal(oldResumed.mapping.fingerprint,seeded.mapping.fingerprint);assert.equal(oldResumed.resumed,true);
 checks.push('pre-extension pixel metadata binding resumes without fingerprint change');
 for(const parameters of [{size:'3.001:1'},{size:'auto',quality:'unknown'}]) {
   await denied(admin,'mapLegacyAssetMetadata',[{kind:'generated',generation:{version:1,prompt:'Preserve original',model:'default::image',parameters,references:[],source:{kind:'image'}}}],400);
 }
 assert.equal(await call(admin,'localPresent'),true);
 const first=await call(admin,'migrate',personal,'old-1','content-a');
 assert.equal(first.verified,true);
 const identical=await call(admin,'migrate',personal,'old-1','content-a');
 assert.equal(identical.asset.id,first.asset.id);
 assert.equal(identical.resumed,true);
 await denied(admin,'migrate',[personal,'old-1','changed-body'],409);
 await denied(admin,'migrate',[personal,'old-1','content-a',{name:'changed.txt'}],409);
 checks.push('verified first migration, exact replay, changed bytes/name conflicts');
 const provenance=await call(admin,'migrate',personal,'old-2','content-a',{name:'second-name.txt',metadata:{version:1,kind:'generated',generation:{version:1,prompt:'Studio light',model:'test-model',parameters:{width:512,height:512}}}});
 assert.equal(provenance.asset.id,first.asset.id);
 assert.equal(provenance.asset.name,'fixture.txt');
 assert.equal(provenance.asset.metadataEntries.length,2);
 checks.push('same-container content dedup preserves first name and appends distinct provenance');
 const adapted=await call(admin,'mapLegacyAssetMetadata',{kind:'generated',generation:{version:1,prompt:'Two reference inputs',model:'test-model',parameters:{size:'512x512'},source:{kind:'image',taskId:'test-task'},references:[{id:'ref-a',name:'A',type:'image'},{id:'ref-b',name:'B',type:'image'}]},referenceIds:[first.asset.id,provenance.asset.id]});
 assert.deepEqual(adapted.referenceIds,[first.asset.id]);
 const dependent=await call(admin,'migrate',personal,'dependent','dependent-content',{metadata:adapted});
 assert.deepEqual(dependent.asset.metadataEntries[0].referenceIds,[first.asset.id]);
 checks.push('multiple old references deduplicating to one server ID retain valid provenance');
 const team=(await call(admin,'createAssetTeam','Migration team')).team;
 const scope={scope:'team',teamId:team.id};
 const project=(await call(admin,'createAssetProject',team.id,'Migration project')).project;
 const projectScope={scope:'project',teamId:team.id,projectId:project.id};
 const teamResult=await call(admin,'migrate',scope,'old-1','content-a');
 const projectResult=await call(admin,'migrate',projectScope,'old-1','content-a');
 assert.notEqual(teamResult.asset.id,first.asset.id);
 assert.notEqual(projectResult.asset.id,teamResult.asset.id);
 assert.notEqual(teamResult.receiptKey,projectResult.receiptKey);
 assert.notEqual(teamResult.receiptKey,first.receiptKey);
 checks.push('same old ID resolves independently in personal/team/project containers');
 const invitation=(await call(admin,'inviteAssetMember',team.id,'2','read')).invitation;
 await call(member,'acceptAssetInvitation',invitation.token);
 await denied(member,'migrate',[scope,'old-1','content-a'],403);
 await call(admin,'setAssetMemberRole',team.id,'2','write');
 const otherActor=await call(member,'migrate',scope,'old-1','content-a');
 assert.equal(otherActor.asset.id,teamResult.asset.id);
 assert.notEqual(otherActor.mapping.actorId,teamResult.mapping.actorId);
 assert.notEqual(otherActor.receiptKey,teamResult.receiptKey);
 checks.push('read-only denial and actor-isolated mapping with shared content dedup');
 // Real server commit followed by loss of only its response, not a fabricated API result.
 let dropped=false;
 const recoveryStart=receipts.length;
 await admin.route('**/api/config-vault/asset-library/migrations',async route=>{
   if(route.request().method()==='POST'&&!dropped){dropped=true;const committed=await route.fetch();assert.equal(committed.status(),200);await route.abort('failed');}
   else await route.continue();
 });
 const recovered=await call(admin,'migrate',personal,'lost-response','content-b');
 await admin.unroute('**/api/config-vault/asset-library/migrations');
 assert.equal(dropped,true);assert.equal(recovered.confirmedAfterError,true);assert.equal(recovered.verified,true);
 const recoveryRequests=receipts.slice(recoveryStart);
 assert.equal(recoveryRequests.filter(r=>r.method==='POST'&&r.path.includes('/migrations')).length,1);
 assert.ok(recoveryRequests.some((r,index)=>r.method==='GET'&&r.path.includes(recovered.mapping.localId)&&recoveryRequests.slice(0,index).some(previous=>previous.method==='POST')));
 const persistedBefore=await call(admin,'receipt',recovered.receiptKey);
 assert.equal(persistedBefore.mapping.assetId,recovered.asset.id);assert.equal(persistedBefore.sha256,recovered.asset.sha256);
 checks.push('lost POST response after genuine commit recovered by GET mapping without repeated POST');
 await admin.context().setOffline(true);
 const offline=await admin.evaluate(async()=>{try{await window.client.migrate({scope:'personal'},'offline','content-c');return false;}catch{return true;}});
 assert.equal(offline,true);await admin.context().setOffline(false);
 assert.equal(await call(admin,'localPresent'),true);
 const oldPid=worker.pid;await stopWorker();await startWorker(origin);assert.notEqual(worker.pid,oldPid);
 await admin.reload();await admin.waitForFunction(()=>Boolean(window.client));await call(admin,'login',1);
 assert.deepEqual(await call(admin,'receipt',recovered.receiptKey),persistedBefore);
 for(const {localId,body,options,result} of defaultRecords) {
   const afterRestart=await call(admin,'migrate',personal,localId,body,options);
   assert.equal(afterRestart.mapping.fingerprint,result.mapping.fingerprint);
   assert.equal(afterRestart.asset.id,result.asset.id);assert.equal(afterRestart.resumed,true);
 }
 checks.push('default-source mappings survive real vault restart/browser reload; invalid inputs retain local blob');
 const resumed=await call(admin,'migrate',personal,'lost-response','content-b');
 assert.equal(resumed.asset.id,recovered.asset.id);assert.equal(resumed.resumed,true);
 assert.equal(await call(admin,'localPresent'),true);
 checks.push('offline failure retains old local blob; server restart/browser reload resumes mapping');
 await call(admin,'trashLibraryAsset',personal,recovered.asset.id);
 await denied(admin,'migrate',[personal,'lost-response','content-b'],409);
 await call(admin,'restoreLibraryAsset',personal,recovered.asset.id);
 await call(admin,'removeAssetMember',team.id,'2');
 await denied(member,'migrate',[scope,'old-1','content-a'],403);
 checks.push('existing local receipt does not bypass trash state or revoked permissions');
 await call(admin,'login',2);
 const switched=await call(admin,'migrate',personal,'old-1','content-a');
 assert.notEqual(switched.asset.id,first.asset.id);assert.notEqual(switched.receiptKey,first.receiptKey);
 await call(admin,'login',1);
 assert.equal((await call(admin,'migrate',personal,'old-1','content-a')).asset.id,first.asset.id);
 assert.equal(await call(admin,'localPresent'),true);
 checks.push('real same-browser account switches isolate mappings and keep source blob');
 // Suspend a genuine GET response while a real login changes identity.
 let release;const gate=new Promise(r=>release=r);let reached;const waiting=new Promise(r=>reached=r);
 const mapped=await call(admin,'namespaceLibraryLocalId','integration-library','old-1');
 await admin.route('**/api/config-vault/asset-library/migrations/'+mapped,async route=>{const reply=await route.fetch();reached();await gate;await route.fulfill({response:reply});});
 const delayed=admin.evaluate(async()=>{try{await window.client.migrate({scope:'personal'},'old-1','content-a');return 200;}catch(e){return e.status;}});
 try {await bounded(waiting,'intercept mapping');await call(admin,'login',2);} finally {release();}
 assert.equal(await bounded(delayed,'delayed mapping result'),409);
 await admin.unroute('**/api/config-vault/asset-library/migrations/'+mapped);
 checks.push('in-flight actual mapping response rejected after account switch');
 assert.ok(receipts.filter(r=>r.method!=='GET'&&!r.path.endsWith('/login')).every(r=>r.accountHeader));
 const report={result:'PASS',transport:'HTTPS browser -> real vault subprocess -> synthetic JAPI',requests:receipts.length,checks,localSourceRetained:true,productionModified:false};
 const output=resolve(root,'test-results/asset-migration-20261025');await mkdir(output,{recursive:true});await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));
} finally {
 await browser?.close();await stopWorker();await vite?.close();auth.closeAllConnections();await new Promise(r=>auth.close(r));
 assert.equal(resolve(storeDir,'..'),resolve(tmpdir()));await rm(storeDir,{recursive:true,force:true});
}
