import { readFile } from 'node:fs/promises';
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

// Execute the actual commerce merge helper; no implementation copy in this test.
import ts from 'typescript';
const helperSource=await readFile(new URL('../src/pages/commerce/components/category-team-draft.ts',import.meta.url),'utf8');
const helperCode=ts.transpileModule(helperSource,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {prepareCategoryTeamDraft}=await import('data:text/javascript;base64,'+Buffer.from(helperCode).toString('base64'));
const models=(name)=>({channels:[{id:'test',name:'Synthetic',baseUrl:'https://model.invalid',apiKey:'',apiFormat:'openai',models:[{name,capability:'image'}]}],defaults:{model:'test::'+name,imageModel:'test::'+name,textModel:'test::'+name,audioModel:'test::'+name,videoModel:'test::'+name},roles:{sceneModel:'',repairModel:'',copyModel:'',translationModel:'',complianceModel:'',removalApiUrl:'',removalApiKey:''}});
test('fixed category save/validate preserve server model config, new member refresh, CAS, rollback and legacy drafts',async t=>{
 const {call,login}=await setup(t);const admin={cookie:await login(1),user:1};
 const load=async()=>{const r=await call('/settings',admin);assert.equal(r.status,200);return r.body;};
 const put=async(value,revision)=>call('/settings/team/draft',{...admin,method:'PUT',body:{value,revision}});
 const publish=async revision=>call('/settings/team/publish',{...admin,method:'POST',body:{revision}});
 const value={...fixture(),modelConfig:models('model-v1')};
 const firstDraft=await put(value,0);assert.equal(firstDraft.status,200);
 const first=await publish(firstDraft.body.revision);assert.equal(first.status,200,JSON.stringify(first.body));
 let envelope=await load();
 const edits={policyPack:{...envelope.draft.value.policyPack,name:'类目编辑'},brands:envelope.draft.value.brands};
 const prepare=(edits,revision,loadOverride=load)=>prepareCategoryTeamDraft(edits,revision,{load:loadOverride,prepare:async v=>structuredClone(v),isCurrent:()=>true});
 const prepared=await prepare(edits,envelope.draft.revision);
 assert.deepEqual(prepared.value.modelConfig,value.modelConfig);
 const validation=await call('/settings/team/validate',{...admin,method:'POST',body:{value:prepared.value}});assert.equal(validation.status,200);assert.equal(validation.body.valid,true);
 const saved=await put(prepared.value,prepared.revision);assert.equal(saved.status,200);assert.deepEqual(saved.body.value.modelConfig,value.modelConfig);
 const second=await publish(saved.body.revision);assert.equal(second.status,200);assert.deepEqual(second.body.value.modelConfig,value.modelConfig);
 const member=await login(2);assert.deepEqual((await call('/settings',{cookie:member})).body.team.value.modelConfig,value.modelConfig);
 // Model edit before category refresh: stale category draft must remain blocked.
 envelope=await load();const staleRevision=envelope.draft.revision;
 const updated={...envelope.draft.value,modelConfig:models('model-v2')};const modelSave=await put(updated,staleRevision);assert.equal(modelSave.status,200);
 await assert.rejects(prepare(edits,staleRevision),/版本冲突.*本地修改已保留/);
 assert.deepEqual((await load()).draft.value.modelConfig,updated.modelConfig);
 // Update after GET but before category PUT: server CAS still protects newer model state.
 const newerPrepared=await prepare(edits,modelSave.body.revision);const newerModel={...modelSave.body.value,modelConfig:models('model-v3')};
 const concurrent=await put(newerModel,modelSave.body.revision);assert.equal(concurrent.status,200);
 assert.equal((await put(newerPrepared.value,newerPrepared.revision)).status,409);
 assert.deepEqual((await load()).draft.value.modelConfig,newerModel.modelConfig);
 const third=await publish(concurrent.body.revision);assert.equal(third.status,200);
 envelope=await load();
 const rollback=await call('/settings/team/rollback',{...admin,method:'POST',body:{revision:envelope.draft.revision,version:first.body.value.policyPack.version}});assert.equal(rollback.status,200,JSON.stringify(rollback.body));
 envelope=await load();const rolled=await prepare({policyPack:envelope.draft.value.policyPack,brands:envelope.draft.value.brands},envelope.draft.revision);
 assert.deepEqual(rolled.value.modelConfig,envelope.draft.value.modelConfig);
 assert.deepEqual((await call('/settings',{cookie:member})).body.team.value.modelConfig,envelope.team.value.modelConfig);
 // Legacy draft lacks a field that exists in published settings: preserve the published value.
 const legacy={...envelope.draft.value};delete legacy.modelConfig;
 const legacySave=await put(legacy,envelope.draft.revision);assert.equal(legacySave.status,200);
 const legacyPrepared=await prepare({policyPack:legacy.policyPack,brands:legacy.brands},legacySave.body.revision);
 assert.deepEqual(legacyPrepared.value.modelConfig,envelope.team.value.modelConfig);
 const legacyStored=await put(legacyPrepared.value,legacyPrepared.revision);assert.equal(legacyStored.status,200);
 assert.deepEqual(legacyStored.body.value.modelConfig,envelope.team.value.modelConfig);
});
