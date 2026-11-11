// Run from web/: node tests/settings-team-acceptance.e2e.mjs
// Real HTTPS vault and encrypted storage. Synthetic identities/data only; no real model calls.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chromium } from "playwright";
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "settings-sync-real-"));
const output = path.resolve("test-results/settings-team-acceptance-20261025");
await fs.mkdir(output, { recursive: true });
const children = [];
let browser;
let logs = "";
const checks = [];
const errors = [];
function start(command, args) {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    child.stderr.on("data", (chunk) => (logs += chunk));
    return child;
}
async function waitReady(child) {
    return new Promise((resolve, reject) => {
        let text = "";
        const timer = setTimeout(() => reject(Error("Fixture startup timeout: " + logs)), 60000);
        child.once("exit", () => {
            clearTimeout(timer);
            reject(Error("Fixture exited: " + logs));
        });
        child.stdout.on("data", (chunk) => {
            text += chunk;
            const line = text.split("\n").find((line) => line.startsWith('{"url"'));
            if (line) {
                clearTimeout(timer);
                resolve(JSON.parse(line));
            }
        });
    });
}
async function until(action, reason) {
    const end = Date.now() + 45000;
    while (Date.now() < end) {
        if (await action()) return;
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw Error(reason);
}
async function settings(page) {
    return page.evaluate(async () => {
        const r = await fetch("/api/config-vault/settings");
        if (!r.ok) throw Error(`settings ${r.status}`);
        return r.json();
    });
}
async function stores(page) {
    return page.evaluate(async () => {
        const c = (await import("/src/stores/use-config-store.ts")).useConfigStore.getState();
        const e = (await import("/src/stores/use-commerce-store.ts")).useCommerceStore.getState();
        return {
            config: c.config,
            webdav: c.webdav,
            roles: e.modelRoles,
            brands: e.brands,
            pack: e.policyPacks.find((p) => p.id === e.teamPolicyPackId),
            theme: (await import("/src/stores/use-theme-store.ts")).useThemeStore.getState().theme,
            prompts: (await import("/src/stores/use-prompt-source-store.ts")).usePromptSourceStore.getState().sources,
        };
    });
}
async function openAccount(page) {
    await page.getByRole("tab", { name: "账号与同步", exact: true }).click();
}
async function login(page, id) {
    await openAccount(page);
    await page.getByLabel("服务器配置账号邮箱").fill(`${id}@settings.test`);
    await page.getByLabel("服务器配置密码").fill("synthetic-password");
    await page.getByRole("button", { name: "登录并恢复配置", exact: true }).click();
    await until(
        async () =>
            page.evaluate(async () => {
                const s = (await import("/src/services/server-config.ts")).useServerConfigStore.getState();
                return s.phase === "ready";
            }),
        "Login did not reach ready",
    );
}
async function confirm(page) {
    await page.locator(".ant-modal-confirm-btns .ant-btn-primary").click();
}
try {
    const python = start(process.env.COMMERCE_TEST_PYTHON || "python", ["tests/fixtures/settings-sync-cert.py", temp]);
    const [code] = await once(python, "exit");
    assert.equal(code, 0, logs);
    const vitePort = Number(process.env.SETTINGS_TEST_VITE_PORT || 3100);
    process.env.SETTINGS_TEST_VITE_PORT = String(vitePort);
    let viteAvailable = false;
    try {
        viteAvailable = (await fetch(`http://127.0.0.1:${vitePort}/@vite/client`)).ok;
    } catch {}
    if (viteAvailable) throw Error("The isolated test Vite port is already in use; set SETTINGS_TEST_VITE_PORT to a free port.");
    if (!viteAvailable) {
        start(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"]);
        await until(async () => {
            try {
                return (await fetch(`http://127.0.0.1:${vitePort}/@vite/client`)).ok;
            } catch {
                return false;
            }
        }, "Vite did not start");
    }
    const fixture = start(process.execPath, ["tests/fixtures/settings-team-acceptance-server.mjs", temp]);
    const ready = await waitReady(fixture);
    browser = await chromium.launch({ headless: true });
    const newDevice = async () => {
        const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1500, height: 1100 } });
        await context.route(/^https?:\/\/(?!localhost[:/]|127\.0\.0\.1[:/])/, (route) => {
            const url = new URL(route.request().url());
            if (["localhost", "127.0.0.1"].includes(url.hostname) || url.protocol === "data:" || url.protocol === "blob:") return route.continue();
            return route.abort();
        });
        const page = await context.newPage();
        page.setDefaultTimeout(45000);
        page.on("pageerror", (error) => {
            errors.push(error.message);
            console.error("Page error: " + error.message);
        });
        page.on("requestfailed", (req) => {
            const url = new URL(req.url());
            if (url.hostname === "localhost" && url.pathname.startsWith("/api/config-vault")) console.error("Request failed: " + url.pathname + " " + req.failure()?.errorText);
        });
        await page.goto(ready.url + "/config");
        await page.getByRole("tab", { name: "账号与同步", exact: true }).waitFor({ timeout: 120000 });
        return { context, page };
    };
    const admin = (await newDevice()).page;
    await admin.evaluate(async () => {
        await (await import('/src/services/settings-data.ts')).waitForSettingsHydration();
        const { useConfigStore, defaultConfig } = await import('/src/stores/use-config-store.ts');
        const { useCommerceStore } = await import('/src/stores/use-commerce-store.ts');
        const { defaultModelRoles } = await import('/src/lib/commerce/defaults.ts');
        useConfigStore.setState({config:{...defaultConfig, channels:[{id:'acceptance',name:'Synthetic team',baseUrl:'https://models.invalid/v1',apiKey:'SYNTHETIC-TEAM-ACCEPTANCE',apiFormat:'openai',models:[{name:'scene',capability:'image'},{name:'copy',capability:'text',supportsImageInput:true}]}],model:'acceptance::scene',imageModel:'acceptance::scene',textModel:'acceptance::copy',systemPrompt:'admin-private-preference'}});
        useCommerceStore.setState({policyPacks:[{id:'legacy-test',name:'Synthetic rules',version:2,status:'published',sourceFileName:'test',createdAt:'2026-10-25',publishedAt:'',profiles:[],rules:[],templates:[],references:[],requirementPresets:[],siteReferences:[],globalStandards:['test'],categories:[]}],brands:[],modelRoles:{...defaultModelRoles,sceneModel:'acceptance::scene',copyModel:'acceptance::copy'}});
        (await import('/src/stores/use-theme-store.ts')).useThemeStore.getState().setTheme('light');
    });
    await login(admin,1);
    await admin.getByRole('button',{name:'一次迁移旧电脑配置',exact:true}).click();
    await admin.getByRole('button',{name:'确认迁移个人配置',exact:true}).click();
    await confirm(admin);
    await until(async () => (await settings(admin)).personal.revision===1,'Migration failed');
    await admin.reload();
    await openAccount(admin);
    await until(async()=>admin.evaluate(async()=>(await import('/src/services/server-config.ts')).useServerConfigStore.getState().phase==='ready'),'Restore failed');
    await admin.getByRole('button',{name:'一次迁移旧电脑配置',exact:true}).click();
    await admin.getByRole('button',{name:'上传附件并保存团队迁移草稿',exact:true}).click();
    await confirm(admin);
    await until(async () => (await settings(admin)).draft.revision>0,'Draft failed');
    assert.equal((await settings(admin)).team.revision,0);
    console.log('Checkpoint',checks.length+1); checks.push('T3: legacy personal migration and candidate survive reload; draft does not auto-publish');
    await admin.getByRole('tab',{name:'跨境类目规则',exact:true}).click();
    await admin.getByRole('button',{name:'发布已保存草稿',exact:true}).click();
    await confirm(admin);
    await until(async () => (await settings(admin)).team.revision>0,'Publish failed');
    const first = (await settings(admin)).team;
    assert.equal(first.value.appearance,undefined);
    assert.equal(first.value.modelConfig.systemPrompt,undefined);
    const member=(await newDevice()).page;
    await login(member,2);
    let state=await stores(member);
    assert.equal((await settings(member)).team.revision,first.revision);
    assert.equal(state.roles.sceneModel,'acceptance::scene');
    assert.equal(state.roles.copyModel,'acceptance::copy');
    assert.equal(state.config.textModel,'acceptance::copy');
    assert.equal(state.config.channels[0].models[1].supportsImageInput,true);
    assert.ok(state.config.channels[0].apiKey==='SYNTHETIC-TEAM-ACCEPTANCE','Authenticated member receives team key');
    assert.notEqual(state.config.systemPrompt,'admin-private-preference');
    assert.equal(state.theme,'dark');
    console.log('Checkpoint',checks.length+1); checks.push('T1: real admin UI publication; fresh member restores identical revision, channels, defaults, scene/copy roles and image-input metadata');
    async function api(page,route,method='GET',body) {
        return page.evaluate(async({route,method,body})=>{
            const s=(await import('/src/services/server-config.ts')).useServerConfigStore.getState();
            const r=await fetch('/api/config-vault'+route,{method,headers:{'Content-Type':'application/json','X-Config-User':String(s.user.id)},...(body?{body:JSON.stringify(body)}:{})});
            return {status:r.status,data:await r.json()};
        },{route,method,body});
    }
    assert.equal((await api(member,'/settings/team/publish','POST',{revision:1})).status,403);
    assert.equal((await api(member,'/settings/team/draft','PUT',{revision:1,value:first.value})).status,403);
    await member.getByRole('tab',{name:'跨境类目规则',exact:true}).click();
    assert.equal(await member.getByRole('button',{name:'发布已保存草稿',exact:true}).count(),0);
    console.log('Checkpoint',checks.length+1); checks.push('T3: member publish control absent; actual draft and publish requests denied 403');
    const third=(await newDevice()).page;
    await login(third,3);
    assert.equal((await settings(third)).team.revision,first.revision);
    assert.equal((await settings(third)).personal.revision,0);
    console.log('Checkpoint',checks.length+1); checks.push('T4: third active identity receives same deployment-wide team config; this is not asset-team membership ACL');
    // Use real personal stores, allow actual autosave, then reload an independent context.
    await member.evaluate(async()=>{
        (await import('/src/stores/use-theme-store.ts')).useThemeStore.getState().setTheme('light');
        (await import('/src/stores/use-config-store.ts')).useConfigStore.getState().updateConfig('systemPrompt','member-private');
        (await import('/src/stores/use-prompt-source-store.ts')).usePromptSourceStore.setState({sources:[{id:'member-source',name:'Member',url:'https://prompts.invalid/list.json',homepage:'https://prompts.invalid',enabled:false,builtIn:false}],schedule:{intervalMinutes:45,lastFetchedAt:''}});
        await (await import('/src/i18n/index.ts')).changeAppLocale('en-US');
        await (await import('/src/services/server-config.ts')).saveServerConfiguration();
    });
    await until(async () => (await settings(member)).personal.value?.appearance?.locale==='en-US','Member locale did not persist');
    const memberAgain=(await newDevice()).page;
    await login(memberAgain,2);
    await memberAgain.reload();
    await until(async()=>memberAgain.evaluate(async()=>(await import('/src/services/server-config.ts')).useServerConfigStore.getState().phase==='ready'),'Member reload failed');
    const personal=await memberAgain.evaluate(async()=>(await import('/src/services/settings-data.ts')).captureLocalPersonalSettings());
    assert.equal(personal.appearance.locale,'en-US');
    assert.equal(personal.appearance.theme,'light');
    assert.equal(personal.config.systemPrompt,'member-private');
    assert.equal(personal.promptSources.sources[0].id,'member-source');
    assert.notEqual((await stores(third)).config.systemPrompt,'member-private');
    console.log('Checkpoint',checks.length+1); checks.push('T2: member personal theme/locale/prompts/preferences restore in independent browser after reload and do not reach third account');
    const draftBefore=(await settings(admin)).draft;
    const next=structuredClone(first.value);
    next.modelConfig.channels[0].name='Synthetic revised team';
    const saved=await api(admin,'/settings/team/draft','PUT',{revision:draftBefore.revision,value:next});
    assert.equal(saved.status,200);
    await admin.getByRole('button',{name:'发布已保存草稿',exact:true}).click();
    await confirm(admin);
    await admin.getByText('当前草稿修改仍保留。可重试；若提示版本冲突，请先对比服务器草稿。',{exact:true}).waitFor();
    await admin.screenshot({path:path.join(output,'team-cas-conflict.png'),fullPage:true});
    checks.push('T3: stale admin UI publish shows visible conflict and preserves current draft');
    assert.equal((await api(admin,'/settings/team/draft','PUT',{revision:draftBefore.revision,value:first.value})).status,409);
    assert.equal((await settings(admin)).draft.value.modelConfig.channels[0].name,'Synthetic revised team');
    assert.equal((await api(admin,'/settings/team/publish','POST',{revision:saved.data.revision})).status,200);
    console.log('Checkpoint',checks.length+1); checks.push('T3: stale real draft CAS returns 409 and preserves winning draft');
    await member.evaluate(async()=>{
        (await import('/src/stores/use-config-store.ts')).useConfigStore.getState().updateConfig('systemPrompt','unsaved-member');
        await (await import('/src/services/server-config.ts')).reloadTeamConfiguration();
    });
    assert.equal((await stores(member)).config.systemPrompt,'unsaved-member');
    assert.equal((await stores(member)).config.channels[0].name,'Synthetic revised team');
    assert.equal((await stores(member)).prompts[0].id,'member-source');
    console.log('Checkpoint',checks.length+1); checks.push('T2: team-only refresh applies latest channels while preserving unsaved personal preference and prompt source');
    const currentDraft=(await settings(admin)).draft;
    const rollback=await api(admin,'/settings/team/rollback','POST',{revision:currentDraft.revision,version:first.value.policyPack.version});
    assert.equal(rollback.status,200);
    assert.ok(rollback.data.revision>first.revision);
    assert.equal(rollback.data.value.modelConfig.channels[0].name,'Synthetic team');
    const history=(await api(admin,'/settings/team/history')).data.history;
    assert.equal(history.at(-1).rollbackOf,first.value.policyPack.version);
    assert.equal(history.at(-1).actor,1);
    console.log('Checkpoint',checks.length+1); checks.push('T3: real rollback creates a newer revision and records original version plus actor');
    await member.evaluate(async()=>{
        const s=await import('/src/services/server-config.ts');
        await s.logoutServerConfiguration();
        await s.loginServerConfiguration('3@settings.test','synthetic-password');
    });
    assert.notEqual((await stores(member)).config.systemPrompt,'unsaved-member');
    assert.equal((await stores(member)).theme,'dark');
    assert.ok(!(await stores(member)).prompts.some(p=>p.id==='member-source'));
    console.log('Checkpoint',checks.length+1); checks.push('T2: same-browser logout/account switch clears previous personal data and applies shared team config');
    const anonymous=await browser.newContext({ignoreHTTPSErrors:true});
    assert.equal((await anonymous.request.get(ready.url+'/api/config-vault/settings',{headers:{Origin:ready.url}})).status(),401);
    assert.ok(!JSON.stringify((await api(third,'/settings/versions')).data).includes('SYNTHETIC-TEAM-ACCEPTANCE'));
    let encryptedCount=0;
    for(const file of await fs.readdir(path.join(temp,'vault'),{recursive:true})) {
        if(!file.endsWith('.enc')) continue;
        encryptedCount++;
        const bytes=await fs.readFile(path.join(temp,'vault',file),'utf8');
        assert.ok(!bytes.includes('SYNTHETIC-TEAM-ACCEPTANCE'));
        assert.ok(!bytes.includes('synthetic-token'));
    }
    assert.ok(encryptedCount>0);
    console.log('Checkpoint',checks.length+1); checks.push('T4: anonymous settings GET 401; versions contain no team key; actual encrypted files contain no plaintext synthetic key/token');
    await fs.writeFile(path.join(output,'report.json'),JSON.stringify({passed:true,checks,limitations:['No supplier/model inference calls','No production deployment or real credentials'],pageErrors:errors},null,2));
    console.log(JSON.stringify({passed:true,checks,pageErrors:errors},null,2));
} catch(error) {
    await fs.writeFile(path.join(output,'report.json'),JSON.stringify({passed:false,checks,error:error.message},null,2));
    console.error(JSON.stringify({passed:false,checks,error:error.message}));
    throw error;
} finally {
    await browser?.close();
    for(const child of children.reverse()) if(child.exitCode===null) { const done=once(child,'exit');child.kill();await done; }
    assert.equal(path.dirname(temp),path.resolve(os.tmpdir()));
    await fs.rm(temp,{recursive:true,force:true});
}
