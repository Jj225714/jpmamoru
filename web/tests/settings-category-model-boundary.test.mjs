import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createVaultHandler } from '../../config-vault/server.mjs';
const fixture=()=>({policyPack:{id:'initial',name:'规则',version:2,status:'draft',sourceFileName:'test',createdAt:'2026-09-30',publishedAt:'',profiles:[],rules:[],templates:[],references:[],requirementPresets:[],siteReferences:[],globalStandards:['保真'],categories:[]},brands:[]});
async function setup(t, admin=true) {
    const dir=await mkdtemp(join(tmpdir(),'settings-test-'));const key=randomBytes(32);const adminUsersFile=join(dir,'admins.json');await writeFile(adminUsersFile,JSON.stringify(admin?[1]:[]));
    const fetchImpl=async(url,opts)=>{const route=new URL(url).pathname;const id=route==='/auth/login'?JSON.parse(opts.body).email.split('@')[0]:opts.headers.authorization.split('-')[1];const user={id:Number(id),email:`${id}@example.com`,status:'active'};return {ok:true,json:async()=>({data:route==='/auth/login'?{user,access_token:`token-${id}`,refresh_token:'refresh',expires_in:3600}:user})};};
    let server;let port;
    const start=async()=>{server=createServer(createVaultHandler({origin:'https://vault.example',authBaseUrl:'https://auth.example',storeDir:dir,key,fetchImpl,adminUsersFile,publicRulesDir:dir}));await new Promise(r=>server.listen(0,'127.0.0.1',r));port=server.address().port;};
    const stop=async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));};await start();
    t.after(async()=>{await stop();await rm(dir,{recursive:true,force:true});});
    const call=(route,{method='GET',body,cookie,user,raw=false}={})=>new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port,path:'/api/config-vault'+route,method,headers:{host:'vault.example',origin:'https://vault.example',...(body?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{}),...(user?{'X-Config-User':String(user)}:{})}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{const data=Buffer.concat(chunks);resolve({status:res.statusCode,body:raw?data:JSON.parse(data.toString()),cookie:res.headers['set-cookie']?.[0].split(';')[0]});});});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);});
    const login=async id=>(await call('/login',{method:'POST',body:{email:`${id}@example.com`,password:'password'}})).cookie;
    return {call,login,dir,key,restart:async()=>{await stop();await start();},adminUsersFile};
}
test('reproduces category-shaped draft replacement dropping modelConfig from subsequent publication',async t=>{
 const {call,login}=await setup(t);const admin={cookie:await login(1),user:1};
 const value=fixture();value.modelConfig={channels:[{id:'test',name:'Synthetic',baseUrl:'https://model.invalid',apiKey:'',apiFormat:'openai',models:[{name:'model',capability:'image'}]}],defaults:{model:'test::model',imageModel:'test::model',textModel:'test::model',audioModel:'test::model',videoModel:'test::model'},roles:{sceneModel:'',repairModel:'',copyModel:'',translationModel:'',complianceModel:'',removalApiUrl:'',removalApiKey:''}};
 const draft=await call('/settings/team/draft',{...admin,method:'PUT',body:{revision:0,value}});assert.equal(draft.status,200);
 const first=await call('/settings/team/publish',{...admin,method:'POST',body:{revision:draft.body.revision}});assert.equal(first.status,200,JSON.stringify(first.body));assert.ok(first.body.value.modelConfig);
 const envelope=(await call('/settings',{cookie:admin.cookie})).body;
 // Exact category-admin save payload shape, without modifying its implementation.
 const categoryValue={policyPack:envelope.draft.value.policyPack,brands:envelope.draft.value.brands};
 const secondDraft=await call('/settings/team/draft',{...admin,method:'PUT',body:{revision:envelope.draft.revision,value:categoryValue}});assert.equal(secondDraft.status,200);assert.equal(secondDraft.body.value.modelConfig,undefined);
 assert.ok((await call('/settings',{cookie:admin.cookie})).body.team.value.modelConfig,'Saving draft alone does not replace published team');
 const second=await call('/settings/team/publish',{...admin,method:'POST',body:{revision:secondDraft.body.revision}});assert.equal(second.status,200);assert.equal(second.body.value.modelConfig,undefined);
 assert.equal((await call('/settings',{cookie:await login(2)})).body.team.value.modelConfig,undefined);
});


