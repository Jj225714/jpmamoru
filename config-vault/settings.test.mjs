import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createVaultHandler, decrypt } from './server.mjs';
import { deflateSync } from 'node:zlib';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGf8AAAAASUVORK5CYII=';
const config={channels:[{id:'p',name:'Private',baseUrl:'https://model.example',apiKey:'secret-api-key',apiFormat:'openai',models:[]}],model:'p::model'};
const fixture=()=>({policyPack:{id:'initial',name:'规则',version:2,status:'draft',sourceFileName:'test',createdAt:'2026-09-30',publishedAt:'',profiles:[],rules:[],templates:[],references:[],requirementPresets:[],siteReferences:[],globalStandards:['保真'],categories:[]},brands:[]});
function largePng() {
    const table=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
    const chunk=(type,data)=>{const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(type,4,'ascii');data.copy(b,8);let crc=0xffffffff;for(const byte of b.subarray(4,-4))crc=table[(crc^byte)&255]^(crc>>>8);b.writeUInt32BE((crc^0xffffffff)>>>0,b.length-4);return b;};
    const width=2048,height=2048,stride=width*3+1;const pixels=randomBytes(stride*height);for(let row=0;row<height;row++)pixels[row*stride]=0;
    const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
    return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels,{level:0})),chunk('IEND',Buffer.alloc(0))]);
}
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
test('personal settings restore, first revision, encryption, legacy preservation and two-account isolation',async t=>{
    const {call,login,dir,key,restart}=await setup(t);const c1=await login(1),c2=await login(2);
    assert.equal((await call('/settings')).status,401);
    const fresh=(await call('/settings',{cookie:c1})).body;assert.equal(fresh.schemaVersion,2);assert.equal(fresh.permissions.manageTeam,true);assert.equal(fresh.personal.revision,0);assert.equal(fresh.draft.value,null);
    assert.equal((await call('/settings',{cookie:c2})).body.draft,undefined);
    const value={config,appearance:{theme:'dark',locale:'zh-CN'},webdav:{url:'https://dav.example',username:'u',password:'secret-dav',directory:'/'},modelRoles:{sceneModel:'p::model',repairModel:'',copyModel:'',translationModel:'',complianceModel:'',removalApiUrl:'',removalApiKey:'secret-removal'},promptSources:{sources:[],schedule:{intervalMinutes:60}}};
    assert.equal((await call('/settings/personal',{method:'PUT',cookie:c1,body:{revision:0,value}})).status,409);
    assert.equal((await call('/settings/personal',{method:'PUT',cookie:c1,user:2,body:{revision:0,value}})).status,409);
    const saved=await call('/settings/personal',{method:'PUT',cookie:c1,user:1,body:{revision:0,value}});assert.equal(saved.status,200);assert.deepEqual(saved.body.value,value);
    assert.equal((await call('/settings',{cookie:c2})).body.personal.value,null);
    const c1b=await login(1);assert.deepEqual((await call('/settings',{cookie:c1b})).body.personal.value,value);
    const concurrent=await Promise.all([1,2].map(()=>call('/settings/personal',{method:'PUT',cookie:c1,user:1,body:{revision:1,value}})));assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);
    assert.equal((await call('/config',{method:'PUT',cookie:c1,body:{revision:2,config:{...config,model:'new'}}})).status,200);
    const after=(await call('/settings',{cookie:c1})).body.personal;assert.equal(after.value.webdav.password,'secret-dav');assert.equal(after.value.config.model,'new');assert.equal(after.revision,3);
    const raw=await readFile(join(dir,'user-1.enc'),'utf8');assert.ok(!raw.includes('secret'));assert.equal(decrypt(raw,key).settings.modelRoles.removalApiKey,'secret-removal');
    await restart();assert.equal((await call('/settings/versions',{cookie:c1})).body.personal,3);
    assert.equal((await call('/logout',{method:'POST',cookie:c1})).status,200);
    assert.equal((await call('/settings/personal',{method:'PUT',cookie:c1,user:1,body:{revision:3,value}})).status,401);
});
test('team authorization, scoped uploads, strict draft safety, publish/history/rollback and immutable IDs',async t=>{
    const {call,login,restart}=await setup(t);const c1=await login(1),c2=await login(2);const admin={cookie:c1,user:1};const member={cookie:c2,user:2};
    const upload={scope:'team',name:'image.png',mimeType:'image/png',data:png};
    assert.equal((await call('/assets',{...member,method:'POST',body:upload})).status,403);
    assert.equal((await call('/assets',{...admin,method:'POST',body:{...upload,mimeType:'image/svg+xml'}})).status,400);
    const asset=(await call('/assets',{...admin,method:'POST',body:upload})).body;
    assert.equal((await call(asset.url.replace('/api/config-vault',''),{cookie:c2,raw:true})).body.toString('base64'),png);
    const privateAsset=(await call('/assets',{...admin,method:'POST',body:{...upload,scope:'personal'}})).body;
    assert.equal((await call(privateAsset.url.replace('/api/config-vault',''),{cookie:c2})).status,404);
    const font=Buffer.alloc(32);font.writeUInt32BE(0x10000,0);font.writeUInt16BE(1,4);font.write('name',12,'ascii');font.writeUInt32BE(28,20);font.writeUInt32BE(4,24);
    const uploadedFont=await call('/assets',{...admin,method:'POST',body:{scope:'team',name:'font.ttf',mimeType:'application/octet-stream',data:font.toString('base64')}});assert.equal(uploadedFont.status,200);assert.equal(uploadedFont.body.mimeType,'font/ttf');
    assert.equal((await call('/assets',{...admin,method:'POST',body:{scope:'team',name:'bad.ttf',mimeType:'',data:Buffer.from('not a font').toString('base64')}})).status,400);
    const value=fixture();value.policyPack.references=[{id:'r',name:'参考',url:asset.url,source:'upload',sheet:'',anchor:'',kind:'example'}];
    assert.equal((await call('/settings/team/draft',{...member,method:'PUT',body:{revision:0,value}})).status,403);
    const save=v=>call('/settings/team/draft',{...admin,method:'PUT',body:{revision:0,value:v}});
    const leak=structuredClone(value);leak.policyPack.apiKey='leak';assert.equal((await save(leak)).status,422);
    const local=structuredClone(value);local.policyPack.references[0].url='blob:private';assert.equal((await save(local)).status,422);
    const privateRef=structuredClone(value);privateRef.policyPack.references[0].url=privateAsset.url;assert.equal((await save(privateRef)).status,422);
    const missing=structuredClone(value);missing.policyPack.references[0].url='/api/config-vault/assets/team/'+'0'.repeat(64);assert.equal((await save(missing)).status,422);
    assert.equal((await save(value)).status,200);
    const concurrent=await Promise.all([1,2].map(()=>call('/settings/team/publish',{...admin,method:'POST',body:{revision:1}})));assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);
    const first=concurrent.find(r=>r.status===200).body;assert.equal(first.value.policyPack.version,3);assert.match(first.value.policyPack.id,/^server-aoweisi-team-v3-[a-f0-9]{12}$/);
    assert.equal((await call('/settings',{cookie:c2})).body.team.value.policyPack.id,first.value.policyPack.id);
    await restart();assert.equal((await call('/settings/team/history',{cookie:c1})).body.history.length,1);
    assert.equal((await call('/settings/team/history',{cookie:c2})).status,403);
    const rollback=await call('/settings/team/rollback',{...admin,method:'POST',body:{revision:2,version:3}});assert.equal(rollback.status,200);assert.equal(rollback.body.value.policyPack.version,4);assert.notEqual(rollback.body.value.policyPack.id,first.value.policyPack.id);
});
test('team model configuration is shared, encrypted and revisioned separately from personal settings',async t=>{
    const {call,login,dir,key}=await setup(t);const admin={cookie:await login(1),user:1};
    const value=fixture();value.modelConfig={channels:[{id:'team-openai',name:'团队主渠道',baseUrl:'https://models.example/v1',apiKey:'TEAM-SECRET',apiFormat:'openai',models:[{name:'gpt-team',capability:'text',supportsImageInput:true}]}],defaults:{model:'team-openai::gpt-team',imageModel:'team-openai::gpt-team',videoModel:'team-openai::gpt-team',textModel:'team-openai::gpt-team',audioModel:'team-openai::gpt-team'},roles:{sceneModel:'team-openai::gpt-team',repairModel:'',copyModel:'team-openai::gpt-team',translationModel:'',complianceModel:'team-openai::gpt-team',removalApiUrl:'',removalApiKey:'TEAM-REMOVE-SECRET'}};
    const saved=await call('/settings/team/draft',{...admin,method:'PUT',body:{revision:0,value}});assert.equal(saved.status,200,JSON.stringify(saved.body));
    const published=await call('/settings/team/publish',{...admin,method:'POST',body:{revision:saved.body.revision}});assert.equal(published.status,200);
    const member={cookie:await login(2),user:2};const sessionCheck=await call('/session',{cookie:member.cookie});assert.equal(sessionCheck.status,200,JSON.stringify(sessionCheck));
    const visible=await call('/settings',{cookie:member.cookie});assert.ok(visible.body.team,JSON.stringify(visible));assert.equal(visible.body.team.value.modelConfig.channels[0].apiKey,'TEAM-SECRET',JSON.stringify(visible.body));assert.equal(visible.body.team.value.modelConfig.roles.sceneModel,'team-openai::gpt-team');
    assert.equal(visible.body.team.value.modelConfig.channels[0].models[0].supportsImageInput,true); assert.equal((await call('/settings')).status,401); assert.ok(!JSON.stringify((await call('/settings/versions',{cookie:member.cookie})).body).includes('TEAM-SECRET'));
    const raw=await readFile(join(dir,'settings-team.enc'),'utf8');assert.ok(!raw.includes('TEAM-SECRET'));assert.equal(decrypt(raw,key).published.value.modelConfig.defaults.textModel,'team-openai::gpt-team');
    assert.equal((await call('/settings/team/draft',{...member,method:'PUT',body:{revision:1,value}})).status,403);
});
test('published brands and categories retain historical identity across edits and rollback',async t=>{
    const {call,login,dir,key}=await setup(t);const admin={cookie:await login(1),user:1};const value=fixture();
    value.brands=[{id:'local-brand',name:'Brand',primaryColor:'#111111',secondaryColor:'#eeeeee',fontFamily:'Arial',terminology:{},bannedWords:[],generationDefaults:{assetCounts:{scene:1,detail:0,'usage-size':0,'detail-white':0},marketingEnabled:false,outputSpec:{size:1024,format:'png',maxBytes:2000000,colorSpace:'sRGB',dpi:96},siteImageMode:'shared',delivery:'flattenedOnly',overlay:{logo:{placement:'off',applyTo:'marketing',customStages:[]},watermark:{mode:'off',position:'center',opacity:.1,applyTo:'marketing',customStages:[]}},locales:['en-US']},requirementDefaultsByCategory:{},createdAt:'2026-09-30',updatedAt:'2026-09-30'}];
    await call('/settings/team/draft',{...admin,method:'PUT',body:{revision:0,value}});const first=(await call('/settings/team/publish',{...admin,method:'POST',body:{revision:1}})).body;assert.match(first.value.brands[0].id,/^server-brand-/);
    value.policyPack.categories=[{id:'new-category',name:'New',aliases:[],active:false,order:0,rules:[],referenceIds:[],requirementIds:[]}];value.brands[0].name='Changed';await call('/settings/team/draft',{...admin,method:'PUT',body:{revision:2,value}});const second=(await call('/settings/team/publish',{...admin,method:'POST',body:{revision:3}})).body;assert.notEqual(second.value.brands[0].id,first.value.brands[0].id);
    const old=decrypt(await readFile(join(dir,'settings-release-3.enc'),'utf8'),key);assert.equal(old.value.brands[0].name,'Brand');assert.equal(old.value.policyPack.categories.length,0);
    const rollback=await call('/settings/team/rollback',{...admin,method:'POST',body:{revision:4,version:3}});assert.equal(rollback.status,200);assert.equal(rollback.body.value.brands[0].name,'Brand');assert.equal(rollback.body.value.policyPack.categories[0].id,'new-category');assert.equal(rollback.body.value.policyPack.categories[0].active,false);
});
test('publication requires complete schema and rejects category conflicts and missing required references',async t=>{
    const {call,login}=await setup(t);const admin={cookie:await login(1),user:1};
    const validate=value=>call('/settings/team/validate',{...admin,method:'POST',body:{value}});
    assert.equal((await validate({policyPack:{name:'Incomplete'},brands:[]})).body.valid,false);
    const value=fixture();value.policyPack.categories=[{id:'root',name:'大类',aliases:[],active:true,order:0,rules:[],referenceIds:[],requirementIds:[]}];
    assert.equal((await validate(value)).body.valid,false);
    value.policyPack.categories[0].active=false;assert.equal((await validate(value)).body.valid,true);
    value.policyPack.categories.push({...value.policyPack.categories[0],id:'child',name:'子类',parentId:'missing'});assert.equal((await validate(value)).body.valid,false);
    value.policyPack.categories[1].parentId='root';value.policyPack.categories[0].rules=[{id:'people',text:'不带人',strength:'required',key:'people',value:'none',stages:['scene']}];value.policyPack.categories[1].rules=[{id:'people-child',text:'带人',strength:'required',key:'people',value:'adult-half',stages:['scene']}];assert.equal((await validate(value)).body.valid,false);
});
test('administrator permission defaults closed and grants require exact account ID',async t=>{
    const {call,login,adminUsersFile}=await setup(t,false);const cookie=await login(1);assert.equal((await call('/settings',{cookie})).body.permissions.manageTeam,false);await writeFile(adminUsersFile,'[2]');assert.equal((await call('/settings',{cookie})).body.permissions.manageTeam,false);await writeFile(adminUsersFile,'[1]');assert.equal((await call('/settings',{cookie})).body.permissions.manageTeam,true);
});
test('uploads a complete PNG above 10MB and below 20MB and preserves original bytes',async t=>{
    const {call,login}=await setup(t);const admin={cookie:await login(1),user:1};const image=largePng();assert.ok(image.length>10*1024*1024&&image.length<20*1024*1024);
    const upload=await call('/assets',{...admin,method:'POST',body:{scope:'team',name:'large-example.png',mimeType:'image/png',data:image.toString('base64')}});assert.equal(upload.status,200);assert.equal(upload.body.bytes,image.length);
    const restored=await call(upload.body.url.replace('/api/config-vault',''),{cookie:admin.cookie,raw:true});assert.equal(restored.status,200);assert.deepEqual(restored.body,image);
});
