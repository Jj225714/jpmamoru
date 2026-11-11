// Run from web/: node src/services/membership-library.integration.e2e.mjs
// Real TS clients + HTTPS browser + real vault subprocess; only JAPI identity is simulated.
import assert from 'node:assert/strict';
import {createServer as httpServer, request} from 'node:http';
import {fork,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
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
 worker=fork(new URL('./membership-library.integration-worker.mjs',import.meta.url),[],{stdio:['ignore','ignore','inherit','ipc']});
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
 const team=(await call(admin,'createAssetTeam','Real HTTP Team')).team;
 const invitation=(await call(admin,'inviteAssetMember',team.id,'2','read')).invitation;
 await denied(admin,'acceptAssetInvitation',[invitation.token],403);
 await call(member,'acceptAssetInvitation',invitation.token);
 await denied(member,'acceptAssetInvitation',[invitation.token],403);
 const project=(await call(admin,'createAssetProject',team.id,'Real HTTP Project')).project;
 const scope={scope:'project',teamId:team.id,projectId:project.id};
 await denied(member,'listLibraryAssets',[scope],403);
 await call(admin,'setAssetProjectRole',team.id,project.id,'2','read');
 assert.deepEqual((await call(member,'listLibraryAssets',scope)).assets,[]);
 const upload=(page,target,text)=>page.evaluate(({target,text})=>window.client.uploadLibraryAsset(target,'fixture.txt',new Blob([text],{type:'text/plain'})),{target,text});
 const deniedUpload=async()=>{
  const status=await member.evaluate(async target=>{try{await window.client.uploadLibraryAsset(target,'fixture.txt',new Blob(['denied'],{type:'text/plain'}));return 200;}catch(e){return e.status;}},scope);assert.equal(status,403);
 };
 await deniedUpload();
 await call(admin,'setAssetMemberRole',team.id,'2','write');await deniedUpload();
 await call(admin,'setAssetProjectRole',team.id,project.id,'2','write');
 const asset=(await upload(member,scope,'shared-body')).asset;
 assert.equal(await admin.evaluate(async({scope,id})=>(await window.client.getLibraryAssetContent(scope,id)).text(),{scope,id:asset.id}),'shared-body');
 await call(member,'setLibraryThumbnail',scope,asset.id,null);
 await call(member,'getLibraryQuota',scope);await call(member,'getLibraryAudit',scope);
 await call(member,'trashLibraryAsset',scope,asset.id);assert.equal((await call(member,'listLibraryAssets',scope,true)).assets.length,1);
 await call(member,'restoreLibraryAsset',scope,asset.id);
 const personal=(await upload(admin,{scope:'personal'},'private-body')).asset;
 const unknown=await admin.evaluate(()=>window.client.uploadLibraryAsset({scope:'personal'},'unknown-type',new Blob(['unknown-type-body'])));
 assert.equal(unknown.asset.mimeType,'application/octet-stream');
 await denied(member,'getLibraryAsset',[{scope:'personal'},personal.id],404);
 await upload(admin,{scope:'team',teamId:team.id},'team-body');
 assert.equal((await call(member,'listLibraryAssets',{scope:'team',teamId:team.id})).assets.length,1);
 const oldPid=worker.pid;await stopWorker();await startWorker(origin);assert.notEqual(worker.pid,oldPid);
 assert.equal((await call(member,'refreshMemberships'))[0].id,team.id);
 assert.equal((await call(member,'getLibraryAsset',scope,asset.id)).asset.id,asset.id);
 // Real login to another account in the same browser, not a client-only identity change.
 await call(member,'login',1);assert.deepEqual(await call(member,'options'),[]);
 assert.equal((await call(member,'getLibraryAsset',{scope:'personal'},personal.id)).asset.id,personal.id);
 await call(member,'login',2);assert.deepEqual(await call(member,'options'),[]);
 await denied(member,'getLibraryAsset',[{scope:'personal'},personal.id],404);
 await call(admin,'removeAssetMember',team.id,'2');
 await denied(member,'getLibraryAssetContent',[scope,asset.id],403);
 await denied(member,'listLibraryAssets',[{scope:'team',teamId:team.id}],403);
 assert.deepEqual(await call(member,'options'),[]);
 const renewed=(await call(admin,'inviteAssetMember',team.id,'2','write')).invitation;
 await call(member,'acceptAssetInvitation',renewed.token);await denied(member,'listLibraryAssets',[scope],403);
 assert.ok(receipts.filter(item=>item.method!=='GET'&&!item.path.endsWith('/login')).every(item=>item.accountHeader));
 console.log(JSON.stringify({result:'PASS',transport:'HTTPS browser -> real vault HTTP subprocess -> simulated JAPI HTTP',browserContexts:2,restarted:true,requests:receipts.length,checks:['secure HttpOnly cookies and account headers','targeted invitation and replay','project read/write intersections','upload/content/quota/audit/trash/restore','unknown MIME fallback','personal isolation','team scope','subprocess restart/session persistence','real account switch','revocation','rejoin without project grant']},null,2));
 // Only methods, paths and statuses: never print tokens, cookies, keys or bodies.
 console.log(JSON.stringify(receipts,null,2));
} finally {
 await browser?.close();await stopWorker();await vite?.close();auth.closeAllConnections();await new Promise(r=>auth.close(r));
 await rm(storeDir,{recursive:true,force:true});
}
