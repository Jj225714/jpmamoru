import { readFileSync } from 'node:fs';
export const policyShape = JSON.parse(readFileSync(new URL('./commerce-policy-schema.json', import.meta.url), 'utf8'));
// Draft publication metadata is optional in the browser's PolicyPack contract.
policyShape['publishedAt?'] = policyShape.publishedAt;
delete policyShape.publishedAt;
policyShape['editSummary?'] = ['string'];
policyShape['diffSummary?'] = Object.fromEntries('rulesAdded rulesChanged rulesRemoved severityChanged templatesAdded templatesChanged templatesRemoved'.split(' ').map(k=>[k,'number']));
const plain = v => v && typeof v === 'object' && !Array.isArray(v);
export const invalid = (message, status = 422) => Object.assign(new Error(message), { status });
export function shape(value, schema, label = '配置', partial = false) {
    if (typeof schema === 'string') {
        if (typeof value !== schema || (schema === 'number' && !Number.isFinite(value)) || (schema === 'string' && value.length > 100000)) throw invalid(`${label}格式无效`);
        return;
    }
    if (Array.isArray(schema)) {
        if (!Array.isArray(value) || value.length > 10000) throw invalid(`${label}数组无效`);
        value.forEach((v, i) => shape(v, schema[0], `${label}[${i}]`, partial)); return;
    }
    if (!plain(value)) throw invalid(`${label}对象无效`);
    if (schema['*']) { Object.values(value).forEach(v => shape(v, schema['*'], label, partial)); return; }
    const allowed = new Set(Object.keys(schema).map(k => k.replace(/\?$/, '')));
    if (Object.keys(value).some(k => !allowed.has(k))) throw invalid(`${label}含有不支持的字段`);
    for (const [field, child] of Object.entries(schema)) {
        const key = field.replace(/\?$/, '');
        if (!(key in value)) { if (!partial && !field.endsWith('?')) throw invalid(`${label}.${key}必填`); }
        else shape(value[key], child, `${label}.${key}`, partial);
    }
}
const selection = { requirementId:'string', enabled:'boolean', count:'number', 'promptOverride?':'string', referenceIds:['string'], 'layout?':'string', variantScope:'string', variantValues:['string'], 'siteLocales?':['string'], 'reviewed?':'boolean', 'visualMode?':'string', 'visualKind?':'string', 'creativeBrief?':policyShape['generationDefaults?']['creativeBrief?'], 'detailPurpose?':'string', 'detailRenderMode?':'string' };
const brandDefaults = Object.fromEntries(Object.entries(policyShape['generationDefaults?']).map(([key,value])=>[key==='creativeBrief?'?key:key.replace(/\?$/,''),value]));
export const brandShape = { id:'string', name:'string', 'logo?':{id:'string',name:'string',url:'string',source:'string'}, primaryColor:'string',secondaryColor:'string',fontFamily:'string','thaiFont?':{name:'string',family:'string',dataUrl:'string'}, terminology:{'*':'string'},bannedWords:['string'],generationDefaults:{...brandDefaults,locales:['string']},requirementDefaultsByCategory:{'*':[selection]},createdAt:'string',updatedAt:'string' };
const options = {
    severity:'BLOCK WARN GUIDE', platforms:'shopee tiktok', phase:'prompt preflight post-render', checker:'metadata text vision manual',
    stage:'scene detail usage-size detail-white marketing',assetStages:'main-white scene detail usage-size detail-white marketing-preview marketing',
    visualMode:'generate white-layout', visualKind:'scene detail usage-size detail-white', generationStrategy:'single paired-before-after', recipeRole:'hero detail usage selling-point secondary-scene interaction lighting before-after', slot:'scene detail usage-size marketing',
    layout:'single-hero feature-grid before-after competitor-comparison size-comparison color-options multi-scene layer-structure lighting-comparison installation-methods installation-steps faq custom-reference',variantScope:'per-sku per-color per-size per-site custom',kind:'reference example',detailPurpose:'front-texture back edge side accessory other',people:'none adult-partial adult-half adult-full',lighting:'natural-window soft-studio warm-indoor side-light',framing:'auto close medium wide',source:'upload url zip generated rule-reference',locale:'en-US th-TH vi-VN ms-MY fil-PH id-ID',locales:'en-US th-TH vi-VN ms-MY fil-PH id-ID',siteLocales:'en-US th-TH vi-VN ms-MY fil-PH id-ID',delivery:'flattenedOnly editableCanvas',siteImageMode:'shared per-site',detailRenderMode:'optimize original'
};
export function validateTeam(value, partial = false, historical = []) {
    const modelShape = {
        channels: [{ id:'string', name:'string', baseUrl:'string', apiKey:'string', apiFormat:'string', 'provider?':'string', models:[{ name:'string', capability:'string', 'supportsImageInput?':'boolean', 'script?':'string', 'editorOperations?':['string'] }] }],
        defaults: { model:'string', imageModel:'string', videoModel:'string', textModel:'string', audioModel:'string' },
        roles: { sceneModel:'string', repairModel:'string', copyModel:'string', translationModel:'string', complianceModel:'string', removalApiUrl:'string', removalApiKey:'string' },
    };
    shape(value, {policyPack:policyShape,brands:[brandShape],'modelConfig?':modelShape}, '团队配置', partial);
    const walk = (v, key = '') => {
        if (typeof v === 'string') {
            if (/^(blob:|data:|file:)/i.test(v)) throw invalid('请先上传配置附件');
            if (options[key] && !options[key].split(' ').includes(v)) throw invalid(`${key}取值无效`);
        } else if (Array.isArray(v)) v.forEach(x => walk(x, key));
        else if (plain(v)) Object.entries(v).forEach(([k,x]) => walk(x,k));
    };
    walk(value);
    if (value.modelConfig && !partial) {
        const { channels, defaults, roles } = value.modelConfig;
        if (channels.length > 100) throw invalid('团队渠道数量无效');
        const ids = new Set();
        for (const channel of channels) {
            if (ids.has(channel.id) || !channel.id.trim() || !channel.baseUrl.trim() || !['openai','gemini'].includes(channel.apiFormat)) throw invalid('团队渠道配置无效');
            ids.add(channel.id);
            try { if (!['http:','https:'].includes(new URL(channel.baseUrl).protocol)) throw Error(); } catch { throw invalid('团队渠道地址无效'); }
            if (channel.models.length > 1000 || channel.models.some(model => !model.name.trim() || !['image','video','text','audio'].includes(model.capability))) throw invalid('团队模型列表无效');
        }
        for (const value of Object.values(defaults)) if (!value || !value.includes('::')) throw invalid('团队默认模型必须绑定渠道');
        for (const key of ['sceneModel','repairModel','copyModel','translationModel','complianceModel']) { const value = roles[key]; if (value && !value.includes('::')) throw invalid('团队模型角色必须绑定渠道'); }
    }
    if (partial) return;
    const p = value.policyPack;
    if (!p.name.trim() || !Number.isSafeInteger(p.version) || p.version < 0 || !['draft','published','retired'].includes(p.status)) throw invalid('规则包名称、版本或状态无效');
    if (p.creativeLibraryVersion !== undefined && p.creativeLibraryVersion !== 1) throw invalid('推荐方案版本无效');
    function unique(items, label) { const ids = items.map(x=>x.id); if (ids.some(id=>!id.trim()) || new Set(ids).size !== ids.length) throw invalid(`${label} ID重复或为空`); }
    for (const k of ['rules','templates','references','requirementPresets','siteReferences']) unique(p[k], k);
    unique(value.brands,'品牌');
    if(value.brands.some(b=>!b.name.trim()||!/^#[a-f0-9]{6}$/i.test(b.primaryColor)||!/^#[a-f0-9]{6}$/i.test(b.secondaryColor)))throw invalid('品牌名称或颜色无效');
    const refs = new Set(p.references.map(x=>x.id)); const presets = new Map(p.requirementPresets.map(x=>[x.id,x]));
    if(p.references.some(r=>!r.name.trim()||!r.url.trim()))throw invalid('示例名称与图片地址不能为空');
    if(value.brands.some(b=>(b.logo&&(!b.logo.url.trim()||!b.logo.name.trim()))||(b.thaiFont&&(!b.thaiFont.dataUrl.trim()||!b.thaiFont.family.trim()))))throw invalid('品牌附件信息不完整');
    const subset = (ids, set, label) => { if (ids.some(id=>!set.has(id))) throw invalid(`${label}引用不存在`); };
    const int = (v,min,max,label) => { if (!Number.isInteger(v)||v<min||v>max) throw invalid(`${label}范围无效`); };
    const countries = new Set();
    for (const r of p.profiles) { if (!/^[A-Z]{2}$/.test(r.countryCode)||countries.has(r.countryCode)||!r.countryName.trim()) throw invalid('国家配置无效'); countries.add(r.countryCode); }
    for (const r of p.rules) { if (!r.title.trim()||!r.description.trim()||r.countries.some(x=>!/^[A-Z]{2}$/.test(x))) throw invalid('规则内容无效'); int(r.priority,0,100,'优先级'); }
    for (const r of [...p.templates,...p.requirementPresets]) {
        if (!r.title.trim()||!r.category.trim()||!(r.prompt??r.requirement)?.trim()) throw invalid('方案内容不能为空');
        int(r.order,0,9999,'排序'); if(r.defaultCount!==undefined) int(r.defaultCount,0,4,'数量'); subset(r.referenceIds,refs,'方案示例');
        for (const locale of Object.keys(r.translationSeeds)) if (!options.locale.split(' ').includes(locale)) throw invalid('翻译语言无效');
        if(r.generationStrategy==='paired-before-after'&&(r.stage!=='marketing'||r.layout!=='before-after'||r.visualMode==='white-layout')) throw invalid('前后对比方案配置无效');
        if((r.recipeRole==='detail'||r.generationStrategy==='paired-before-after')&&r.creativeBrief?.people&&r.creativeBrief.people!=='none') throw invalid('细节和前后对比不能加入人物');
    }
    for (const r of p.siteReferences) {if(!r.product.trim())throw invalid('站点商品不能为空');subset(r.referenceIds,refs,'站点示例');}
    if(p.globalStandards.some(x=>!x.trim())) throw invalid('全局要求不能为空');
    const cats = p.categories || []; unique(cats,'类目'); const byId = new Map(cats.map(x=>[x.id,x])); const aliases=new Map();
    for (const c of cats) {
        int(c.order,0,9999,'类目排序'); const parent=byId.get(c.parentId);
        if(!c.name.trim()||(c.parentId&&(!parent||parent.parentId||parent.id===c.id))||(c.active&&parent&&!parent.active)) throw invalid('类目名称或父类层级无效');
        for (const alias of [c.name,...c.aliases]) { const a=alias.trim().toLowerCase(); if(!a||(aliases.has(a)&&aliases.get(a)!==c.id)) throw invalid('类目名称或别名重复'); aliases.set(a,c.id); }
        unique(c.rules,'类目规则'); const structured=new Map();
        for(const r of [...(parent?.rules||[]),...c.rules]) {
            if(!r.text.trim()||!['required','guide'].includes(r.strength)||!r.stages.length||r.stages.some(x=>!['scene','detail','usage-size','detail-white'].includes(x))) throw invalid('类目规则格式无效');
            if(r.key && (!['scene','people'].includes(r.key)||!r.value?.trim()||(r.key==='people'&&!options.people.split(' ').includes(r.value)))) throw invalid('结构化规则无效');
            if(r.key==='people'&&r.value!=='none'&&r.stages.some(x=>x==='detail'||x==='detail-white')) throw invalid('细节阶段不能要求人物');
            if(r.strength==='required'&&r.key) for(const stage of r.stages){const k=r.key+stage;if(structured.has(k)&&structured.get(k)!==r.value) throw invalid('结构化硬性条件冲突');structured.set(k,r.value);}
        }
        for(const r of parent?.rules||[]) {const own=c.rules.find(x=>x.id===r.id);if(r.strength==='required'&&own&&JSON.stringify(own)!==JSON.stringify(r)) throw invalid('不可覆盖父类硬性规则');}
        const cr=c.referenceIds.length?c.referenceIds:parent?.referenceIds||[]; const cp=c.requirementIds.length?c.requirementIds:parent?.requirementIds||[];
        subset(cr,refs,'类目示例');subset(cp,presets,'类目方案');
        if(c.active&&!cats.some(x=>x.active&&x.parentId===c.id)) {
            if(!cp.length) throw invalid('启用类目必须有生成方案');
            for(const id of cp){const r=presets.get(id);const kind=r.visualKind||(r.stage==='marketing'?'scene':r.stage);if(['detail','detail-white'].includes(kind)&&!r.detailPurpose)throw invalid('细节方案必须指定素材用途');if(['scene','usage-size'].includes(kind)&&!cr.length)throw invalid('场景方案必须绑定示例图');}
        }
    }
    for (const old of historical) if (!byId.has(old.id)) throw invalid('已发布类目不能删除，请停用');
    for (const b of value.brands) for(const selections of Object.values(b.requirementDefaultsByCategory)) for(const s of selections){subset([s.requirementId],presets,'品牌方案');subset(s.referenceIds,refs,'品牌示例');int(s.count,0,4,'品牌方案数量');}
    for(const defaults of [p.generationDefaults,...value.brands.map(b=>b.generationDefaults)].filter(Boolean)) {
        for(const n of Object.values(defaults.assetCounts||{}))int(n,0,4,'默认数量');
        for(const stage of [...(defaults.overlay?.logo.customStages||[]),...(defaults.overlay?.watermark.customStages||[])])if(!options.assetStages.split(' ').includes(stage))throw invalid('覆盖图片类型无效');
        const o=defaults.outputSpec;if(o&&(![800,1024,1254,1600].includes(o.size)||![96,120,150].includes(o.dpi)||!['png','jpeg'].includes(o.format)||o.colorSpace!=='sRGB'||o.maxBytes<262144||o.maxBytes>20971520))throw invalid('输出规格无效');
        const overlay=defaults.overlay;if(overlay){const {logo,watermark:w}=overlay;const range=p.watermarkOpacityRange||[.03,.3];if(!['off','top-left','top-right','bottom-left','bottom-right'].includes(logo.placement)||!['off','single','tile'].includes(w.mode)||!['top-left','top-center','top-right','center-left','center','center-right','bottom-left','bottom-center','bottom-right'].includes(w.position)||w.opacity<range[0]||w.opacity>range[1])throw invalid('Logo或水印设置无效');for(const x of [logo,w])if(!['marketing','all','custom'].includes(x.applyTo)||(x.applyTo==='custom'&&!x.customStages.length))throw invalid('覆盖范围无效');}
    }
    if(p.watermarkOpacityRange&&(p.watermarkOpacityRange.length!==2||p.watermarkOpacityRange[0]<.03||p.watermarkOpacityRange[1]>.3||p.watermarkOpacityRange[0]>p.watermarkOpacityRange[1]))throw invalid('水印范围无效');
}
