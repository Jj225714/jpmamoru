import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { inflateSync } from 'node:zlib';
import { invalid, shape, validateTeam } from './validation.mjs';

const PREFIX = '/api/config-vault';
const hash = v => createHash('sha256').update(v).digest('hex');
const empty = () => ({revision:0,savedAt:null,value:null});
const personal = r => r ? {revision:r.revision,savedAt:r.savedAt,value:{...(r.settings||{}),config:r.config}} : empty();
const revision = v => {if(!Number.isSafeInteger(v)||v<0)throw invalid('无效修订号',400);};
const check = (supplied, current) => {revision(supplied);if(supplied!==(current?.revision||0))throw invalid('Configuration conflict',409);};
const now = () => new Date().toISOString();
const mimes = ['image/png','image/jpeg','image/webp','image/gif','font/ttf','font/otf','font/woff','font/woff2'];
function assetMime(declared,data) {
    if(mimes.includes(declared))return declared;
    if(!['','application/octet-stream','application/font-woff','application/x-font-ttf','application/x-font-opentype','application/vnd.ms-opentype','font/sfnt'].includes(declared))throw invalid('附件类型不支持',400);
    const hex=data.subarray(0,4).toString('hex');const magic=data.subarray(0,4).toString('ascii');
    const inferred=hex==='00010000'?'font/ttf':magic==='OTTO'?'font/otf':magic==='wOFF'?'font/woff':magic==='wOF2'?'font/woff2':null;
    if(!inferred)throw invalid('字体内容与类型不匹配',400);
    return inferred;
}
function checkAsset(data,mime) {
    const sig=data.subarray(0,12).toString('hex'); const ascii=data.subarray(0,12).toString('ascii');
    const valid = mime==='image/png'? sig.startsWith('89504e470d0a1a0a')&&data.length>32&&data.readUInt32BE(16)>0&&data.readUInt32BE(20)>0&&data.readUInt32BE(16)*data.readUInt32BE(20)<=40000000
        :mime==='image/jpeg'?sig.startsWith('ffd8ff')&&data.subarray(-2).toString('hex')==='ffd9'
        :mime==='image/webp'?ascii.startsWith('RIFF')&&ascii.endsWith('WEBP')&&data.readUInt32LE(4)+8===data.length
        :mime==='image/gif'?/^GIF8[79]a/.test(ascii)&&data.length>13&&data[data.length-1]===59
        :mime==='font/ttf'?sig.startsWith('00010000')&&data.length>12
        :mime==='font/otf'?ascii.startsWith('OTTO')&&data.length>12
        :mime==='font/woff'?ascii.startsWith('wOFF')&&data.length>=44&&data.readUInt32BE(8)===data.length
        :mime==='font/woff2'?ascii.startsWith('wOF2')&&data.length>=48&&data.readUInt32BE(8)===data.length:false;
    if(!valid)throw invalid('附件内容与类型不匹配',400);
    if(mime==='image/png') {
        let offset=8,ended=false;const compressed=[];
        while(offset+12<=data.length){const size=data.readUInt32BE(offset),kind=data.toString('ascii',offset+4,offset+8);if(size>data.length-offset-12)throw invalid('PNG文件损坏',400);if(kind==='IDAT')compressed.push(data.subarray(offset+8,offset+8+size));offset+=size+12;if(kind==='IEND'){ended=true;break;}}
        try{if(!ended||offset!==data.length||!compressed.length||!inflateSync(Buffer.concat(compressed),{maxOutputLength:160*1024*1024}).length)throw Error();}catch{throw invalid('PNG文件无法解码',400);}
    }
    if(mime==='font/ttf'||mime==='font/otf') {
        const count=data.readUInt16BE(4);if(!count||count>4096||12+count*16>data.length)throw invalid('字体目录损坏',400);
        for(let i=0;i<count;i++){const at=12+i*16,start=data.readUInt32BE(at+8),length=data.readUInt32BE(at+12);if(start<12+count*16||start+length>data.length)throw invalid('字体表损坏',400);}
    }
}
export function createSettingsService({read,write,locked,body,cleanConfig,adminUsersFile,publicRulesDir}) {
    const isAdmin = async user => {
        if(!adminUsersFile)return false;
        try {const ids=JSON.parse(await readFile(adminUsersFile,'utf8'));return Array.isArray(ids)&&ids.some(id=>String(id)===String(user.id));}
        catch(error){if(error.code==='ENOENT')return false;throw invalid('管理员权限配置不可用',503);}
    };
    const state = async () => await read('settings-team') || {published:empty(),draft:empty(),history:[]};
    async function assetRefs(value, scope, user, strict = true) {
        async function visit(v,key='') {
            if(typeof v==='string') {
                if(/^(blob:|data:|file:)/i.test(v))throw invalid('配置含本机附件，请先上传');
                if(!['url','dataUrl'].includes(key)||!v)return;
                const match=v.match(/^\/api\/config-vault\/assets\/(team|personal)\/([a-f0-9]{64})$/);
                if(match) {if(scope==='team'&&match[1]!=='team')throw invalid('团队配置不能引用个人附件');const file=await read(`asset-${match[1]==='team'?'team':`user-${user.id}`}-${match[2]}`);if(!file)throw invalid('配置附件缺失');return;}
                if(scope==='team') {
                    if(!/^\/public-rules\/[A-Za-z0-9_./-]+$/.test(v)||v.includes('..'))throw invalid('团队附件须为服务器文件');
                    if(strict){if(!publicRulesDir)throw invalid('尚未配置公共规则目录');const root=resolve(publicRulesDir);const file=resolve(root,v.slice('/public-rules/'.length));if(!file.startsWith(root+sep))throw invalid('附件路径无效');try{if(!(await stat(file)).isFile())throw Error();}catch{throw invalid('公共规则附件缺失');}}
                }
            } else if(Array.isArray(v)){for(const x of v)await visit(x,key);}
            else if(v&&typeof v==='object'){for(const [k,x]of Object.entries(v)){if(['storageKey','sourceImageIds','primaryImageId','primaryImageIds'].includes(k))throw invalid('团队配置不能包含本机或商品素材引用');await visit(x,k);}}
        }
        await visit(value);
    }
    function personalValue(v) {
        if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!['config','modelRoles','webdav','promptSources','appearance'].includes(k)))throw invalid('个人配置格式无效',400);
        const output={config:cleanConfig(v.config)};
        const shapes={modelRoles:{sceneModel:'string',repairModel:'string',copyModel:'string',translationModel:'string',complianceModel:'string',removalApiUrl:'string',removalApiKey:'string'},webdav:{url:'string',username:'string',password:'string',directory:'string'},promptSources:{sources:[{id:'string',name:'string',url:'string',homepage:'string',enabled:'boolean',builtIn:'boolean'}],schedule:{intervalMinutes:'number'}},appearance:{theme:'string',locale:'string'}};
        for(const[k,s]of Object.entries(shapes))if(v[k]!==undefined){shape(v[k],s,k);output[k]=v[k];}
        if(v.appearance&&(!['light','dark'].includes(v.appearance.theme)||!['zh-CN','en-US'].includes(v.appearance.locale)))throw invalid('外观设置无效');
        if(v.promptSources&&(!Number.isSafeInteger(v.promptSources.schedule.intervalMinutes)||v.promptSources.schedule.intervalMinutes<0||v.promptSources.schedule.intervalMinutes>525600))throw invalid('更新频率无效');
        return output;
    }
    const guard = async (req,session,work) => {
        if(String(req.headers['x-config-user']||'')!==String(session.user.id))throw invalid('账号已变更，请重新加载',409);
        return locked(session.name,async()=>{if(!(await read(session.name)))throw invalid('登录已失效',401);return work();});
    };
    async function publish(s,value,session,rollbackOf) {
        const oldCats=[];for(const h of s.history){const release=await read(`settings-release-${h.version}`);oldCats.push(...(release?.value.policyPack.categories||[]));}
        if(rollbackOf){const ids=new Set(value.policyPack.categories?.map(c=>c.id)||[]);for(const c of oldCats)if(!ids.has(c.id)){ids.add(c.id);(value.policyPack.categories??=[]).push({id:c.id,name:`历史停用 ${c.id}`,aliases:[],active:false,order:c.order,rules:[],referenceIds:[],requirementIds:[]});}}
        validateTeam(value,false,oldCats);await assetRefs(value,'team',session.user);
        const stamp=now();const version=Math.max(value.policyPack.version,...s.history.map(h=>h.version),0)+1;const suffix=hash(JSON.stringify(value)+stamp).slice(0,12);
        value.policyPack={...value.policyPack,id:`server-aoweisi-team-v${version}-${suffix}`,version,status:'published',publishedAt:stamp};
        value.brands=value.brands.map(b=>({...b,id:`server-brand-${hash(b.id.replace(/-v\d+-[a-f0-9]{12}$/,'')).slice(0,12)}-v${version}-${suffix}`,updatedAt:stamp}));
        const section={revision:s.published.revision+1,savedAt:stamp,value};
        const entry={version,revision:section.revision,savedAt:stamp,actor:session.user.id,...(rollbackOf?{rollbackOf}:{})};
        // Immutable release first; settings-team is the sole commit point containing pointer, draft and audit.
        // A crash before its atomic rename leaves only an unreferenced release; after rename all state agrees.
        if(!await isAdmin(session.user))throw invalid('需要规则管理员权限',403);
        await write(`settings-release-${version}`,section);
        if(!await isAdmin(session.user))throw invalid('需要规则管理员权限',403);
        await write('settings-team',{published:section,draft:{...section,revision:s.draft.revision+1},history:[...s.history,entry]});
        return section;
    }
    return {async handle(req,res,session,send){
        const route=req.url.slice(PREFIX.length);const user=session.user;const admin=await isAdmin(user);
        if(req.method==='GET'&&['/settings','/settings/versions'].includes(route)){
            const p=personal(await read(`user-${user.id}`));const s=await state();
            if(route.endsWith('/versions'))return send({user,personal:p.revision,team:s.published.revision,...(admin?{draft:s.draft.revision}:{}),permissions:{manageTeam:admin}});
            return send({schemaVersion:2,user,permissions:{manageTeam:admin},personal:p,team:s.published,...(admin?{draft:s.draft}:{})});
        }
        const assetMatch=route.match(/^\/assets\/(team|personal)\/([a-f0-9]{64})$/);
        if(req.method==='GET'&&assetMatch){const record=await read(`asset-${assetMatch[1]==='team'?'team':`user-${user.id}`}-${assetMatch[2]}`);if(!record)throw invalid('附件不存在',404);res.setHeader('Content-Type',record.mimeType);res.setHeader('Content-Disposition',"inline; filename*=UTF-8''"+encodeURIComponent(record.name));res.setHeader('Content-Length',record.bytes);return res.end(Buffer.from(record.data,'base64'));}
        if(req.method==='GET'&&route==='/settings/team/history'){if(!admin)throw invalid('需要规则管理员权限',403);return send({history:(await state()).history});}
        return guard(req,session,async()=>{
            if(req.method==='PUT'&&route==='/settings/personal'){
                const input=await body(req,2*1024*1024);const value=personalValue(input.value);
                return locked(`user-${user.id}`,async()=>{const old=await read(`user-${user.id}`);check(input.revision,old);const savedAt=now();const {config,...settings}=value;const record={...old,revision:input.revision+1,savedAt,config,settings,schemaVersion:2,source:'browser',channelCount:config.channels.length,updatedAt:savedAt};await write(`user-${user.id}`,record);send(personal(record));});
            }
            if(req.method==='POST'&&route==='/assets'){
                const input=await body(req,30*1024*1024);if(!['team','personal'].includes(input.scope)||typeof input.mimeType!=='string'||typeof input.name!=='string'||!input.name||input.name.length>512||typeof input.data!=='string'||input.data.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(input.data))throw invalid('附件请求无效',400);
                if(input.scope==='team'&&!admin)throw invalid('需要规则管理员权限',403);
                const bytes=Buffer.from(input.data,'base64');if(!bytes.length||bytes.length>20*1024*1024)throw invalid('附件不得超过20MB',413);const mimeType=assetMime(input.mimeType,bytes);checkAsset(bytes,mimeType);
                const digest=hash(bytes);const asset={id:digest,url:`${PREFIX}/assets/${input.scope}/${digest}`,contentHash:digest,name:input.name,mimeType,bytes:bytes.length};
                await locked(`asset-${input.scope}-${user.id}-${digest}`,async()=>{if(input.scope==='team'&&!await isAdmin(user))throw invalid('需要规则管理员权限',403);const name=`asset-${input.scope==='team'?'team':`user-${user.id}`}-${digest}`;if(!await read(name))await write(name,{...asset,data:input.data});});return send(asset);
            }
            if(!admin)throw invalid('需要规则管理员权限',403);
            if(req.method==='POST'&&route==='/settings/team/validate'){
                const input=await body(req,8*1024*1024);try{validateTeam(input.value);await assetRefs(input.value,'team',user);return send({valid:true,errors:[]});}catch(error){if(error.status===422)return send({valid:false,errors:[error.message]});throw error;}
            }
            return locked('settings-team',async()=>{
                const s=await state();const input=await body(req,8*1024*1024);check(input.revision,s.draft);
                if(!await isAdmin(user))throw invalid('需要规则管理员权限',403);
                if(req.method==='PUT'&&route==='/settings/team/draft'){
                    validateTeam(input.value,true);await assetRefs(input.value,'team',user);if(!await isAdmin(user))throw invalid('需要规则管理员权限',403);s.draft={revision:s.draft.revision+1,savedAt:now(),value:input.value};await write('settings-team',s);return send(s.draft);
                }
                if(req.method==='POST'&&route==='/settings/team/publish'){if(!s.draft.value)throw invalid('请先保存草稿');return send(await publish(s,structuredClone(s.draft.value),session));}
                if(req.method==='POST'&&route==='/settings/team/rollback'){if(!s.history.some(h=>h.version===input.version))throw invalid('历史版本不存在',404);const old=await read(`settings-release-${input.version}`);return send(await publish(s,structuredClone(old.value),session,input.version));}
                throw invalid('接口不存在',404);
            });
        });
    }};
}
