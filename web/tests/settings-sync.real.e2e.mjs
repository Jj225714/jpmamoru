// Run from web/: node tests/settings-sync.real.e2e.mjs
// Real HTTPS vault and encrypted storage. Synthetic identities/data only; no real model calls.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chromium } from "playwright";
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "settings-sync-real-"));
const output = path.resolve("test-results/settings-sync-real");
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
    const fixture = start(process.execPath, ["tests/fixtures/settings-sync-server.mjs", temp]);
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
    console.log("Opening synthetic old device");
    const old = await newDevice();
    const page = old.page;
    const fontCandidates = [process.env.SETTINGS_TEST_FONT, "C:/Windows/Fonts/arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"].filter(Boolean);
    let font;
    for (const candidate of fontCandidates) {
        try {
            font = await fs.readFile(candidate);
            break;
        } catch {}
    }
    assert.ok(font, "Set SETTINGS_TEST_FONT to a real TTF/OTF file");
    await page.evaluate(async (fontBase64) => {
        const { waitForSettingsHydration } = await import("/src/services/settings-data.ts");
        await waitForSettingsHydration();
        const { useConfigStore, defaultConfig } = await import("/src/stores/use-config-store.ts");
        const { useCommerceStore } = await import("/src/stores/use-commerce-store.ts");
        const { createDefaultBrand, createBuiltInPolicyPack } = await import("/src/lib/commerce/defaults.ts");
        const { createCategorySeedPack } = await import("/src/lib/commerce/category-seed.ts");
        useConfigStore.setState({
            config: {
                ...defaultConfig,
                channelMode: "personal",
                apiKey: "SYNTHETIC-PRIVATE-KEY",
                channels: [{ id: "test-channel", name: "测试渠道", baseUrl: "https://models.invalid/v1", apiKey: "SYNTHETIC-PRIVATE-KEY", apiFormat: "openai", models: [{ name: "gpt-image-test", capability: "image" }] }],
                imageModel: "test-channel::gpt-image-test",
                model: "test-channel::gpt-image-test",
                proxyEnabled: true,
                proxyUrl: "http://127.0.0.1:19999",
            },
            webdav: { url: "https://dav.invalid", username: "synthetic-user", password: "SYNTHETIC-DAV-PASSWORD", directory: "test-config", lastSyncedAt: "" },
        });
        const brand = createDefaultBrand();
        brand.name = "合成迁移品牌";
        brand.terminology = { mat: "地垫" };
        brand.bannedWords = ["虚构性能"];
        brand.logo = { id: "test-logo", name: "test-logo.jpg", url: "/commerce-categories/image4.jpg", source: "upload" };
        brand.thaiFont = { name: "test-font.ttf", family: "TestFont", dataUrl: `data:font/ttf;base64,${fontBase64}` };
        const pack = createCategorySeedPack(createBuiltInPolicyPack());
        pack.status = "published";
        useCommerceStore.setState({
            policyPacks: [pack],
            brands: [brand],
            modelRoles: { sceneModel: "test-channel::gpt-image-test", repairModel: "", copyModel: "", translationModel: "", complianceModel: "", removalApiUrl: "https://remove.invalid", removalApiKey: "SYNTHETIC-REMOVE-KEY" },
        });
        (await import("/src/stores/use-prompt-source-store.ts")).usePromptSourceStore.setState({
            sources: [{ id: "test-source", name: "合成提示词来源", url: "https://prompts.invalid/list.json", homepage: "https://prompts.invalid", enabled: false, builtIn: false }],
            schedule: { intervalMinutes: 60, lastFetchedAt: "" },
        });
        (await import("/src/stores/use-theme-store.ts")).useThemeStore.getState().setTheme("light");
    }, font.toString("base64"));
    console.log("Logging in seeded old device");
    await login(page, 1);
    assert.equal((await settings(page)).personal.revision, 0);
    await page.getByRole("button", { name: "一次迁移旧电脑配置", exact: true }).click();
    assert.ok(!(await page.locator("body").innerText()).includes("SYNTHETIC-PRIVATE-KEY"));
    await page.getByRole("button", { name: "确认迁移个人配置", exact: true }).click();
    await confirm(page);
    await until(async () => (await settings(page)).personal.revision === 1, "Personal migration failed");
    const migrated = await settings(page);
    assert.equal(migrated.personal.value.config.channels[0].apiKey, "SYNTHETIC-PRIVATE-KEY");
    assert.equal(migrated.personal.value.config.proxyUrl, undefined);
    checks.push("old-device UI personal migration with masked diff and no proxy migration");
    await page.reload();
    await openAccount(page);
    await until(async () => page.evaluate(async () => (await import("/src/services/server-config.ts")).useServerConfigStore.getState().phase === "ready"), "Session restore after reload failed");
    await page.getByRole("button", { name: "一次迁移旧电脑配置", exact: true }).click();
    checks.push("old-device migration candidate survives reload before team migration");
    console.log("Migrating team attachments");
    await page.getByRole("button", { name: "上传附件并保存团队迁移草稿", exact: true }).click();
    await confirm(page);
    await until(async () => (await settings(page)).draft.revision > 0, "Team draft migration failed");
    assert.equal((await settings(page)).team.revision, 0, "Draft must not silently publish");
    const validation = await page.evaluate(async () => {
        const data = await fetch("/api/config-vault/settings").then((r) => r.json());
        const r = await fetch("/api/config-vault/settings/team/validate", { method: "POST", headers: { "Content-Type": "application/json", "X-Config-User": "1" }, body: JSON.stringify({ value: data.draft.value }) });
        return r.json();
    });
    assert.equal(validation.valid, true, JSON.stringify(validation));
    await page.getByRole("tab", { name: "跨境类目规则", exact: true }).click();
    await page.getByRole("button", { name: "发布已保存草稿", exact: true }).click();
    await confirm(page);
    await until(async () => (await settings(page)).team.revision > 0, "Team publication failed");
    checks.push("real attachment upload before team draft; explicit publication of 3 roots and 10 subcategories");
    await page.getByText("类目规则已发布", { exact: true }).waitFor();
    await page.locator(".ant-modal-confirm").waitFor({ state: "hidden" });
    await page.screenshot({ path: path.join(output, "team-published.png"), fullPage: true });
    console.log("Checking clean second browser");
    const fresh = await newDevice();
    await login(fresh.page, 1);
    const recovered = await stores(fresh.page);
    assert.equal(recovered.config.channels[0].apiKey, "SYNTHETIC-PRIVATE-KEY");
    assert.equal(recovered.roles.removalApiKey, "SYNTHETIC-REMOVE-KEY");
    assert.equal(recovered.roles.sceneModel, "test-channel::gpt-image-test");
    assert.equal(recovered.webdav.password, "SYNTHETIC-DAV-PASSWORD");
    assert.equal(recovered.theme, "light");
    assert.ok(recovered.prompts.some((p) => p.id === "test-source"));
    assert.notEqual(recovered.config.proxyUrl, "http://127.0.0.1:19999");
    assert.equal(recovered.pack.categories.filter((c) => c.parentId).length, 10);
    assert.ok(recovered.pack.categories.filter((c) => !c.parentId).length >= 3);
    const brand = recovered.brands.find((b) => b.name === "合成迁移品牌");
    assert.ok(brand);
    assert.match(brand.logo.url, /^\/api\/config-vault\/assets\/team\//);
    assert.match(brand.thaiFont.dataUrl, /^\/api\/config-vault\/assets\/team\//);
    const attachments = [...recovered.pack.references.map((r) => r.url), brand.logo.url, brand.thaiFont.dataUrl];
    assert.ok((await fresh.page.evaluate(async (urls) => Promise.all(urls.map(async (url) => (await fetch(url)).status)), attachments)).every((status) => status === 200));
    checks.push("independent empty browser restores keys, models, WebDAV, prompts, theme, brand, font, examples and categories");
    console.log("Checking other account");
    const member = await newDevice();
    await login(member.page, 2);
    assert.equal((await settings(member.page)).personal.revision, 0);
    assert.equal((await stores(member.page)).config.channels.filter((c) => c.apiKey).length, 0);
    await member.page.getByRole("tab", { name: "跨境类目规则", exact: true }).click();
    await member.page.getByText("当前账号可查看团队规则；修改与发布需管理员授权。", { exact: true }).waitFor();
    assert.equal(await member.page.getByRole("button", { name: "发布已保存草稿", exact: true }).count(), 0);
    const denied = await member.page.evaluate(async () => (await fetch("/api/config-vault/settings/team/publish", { method: "POST", headers: { "Content-Type": "application/json", "X-Config-User": "2" }, body: JSON.stringify({ revision: 1 }) })).status);
    assert.equal(denied, 403);
    // Editing a new user's first configuration must save at revision zero without an explicit migration.
    await member.page.evaluate(async () => {
        (await import("/src/stores/use-config-store.ts")).useConfigStore.getState().updateConfig("systemPrompt", "synthetic first save");
    });
    await until(async () => (await settings(member.page)).personal.revision > 0, "First-save autosync did not run at revision zero");
    checks.push("separate account has no private key; cannot publish; first edit autosaves at revision zero");
    // Updated config becomes available in the other context via the same focus/poll implementation.
    await page.evaluate(async () => {
        (await import("/src/stores/use-config-store.ts")).useConfigStore.getState().updateConfig("systemPrompt", "synthetic updated prompt");
    });
    await until(async () => (await settings(page)).personal.value.config.systemPrompt === "synthetic updated prompt", "Update did not save");
    await fresh.page.evaluate(async () => {
        await (await import("/src/services/server-config.ts")).checkServerConfigurationVersions();
    });
    assert.equal((await stores(fresh.page)).config.systemPrompt, "synthetic updated prompt");
    // Force a realistic in-flight local edit versus another device's saved revision, before the debounce saves.
    await fresh.page.evaluate(async () => {
        const { useConfigStore } = await import("/src/stores/use-config-store.ts");
        const { checkServerConfigurationVersions } = await import("/src/services/server-config.ts");
        const envelope = await fetch("/api/config-vault/settings").then((r) => r.json());
        const value = structuredClone(envelope.personal.value);
        value.config.systemPrompt = "synthetic competing remote";
        useConfigStore.getState().updateConfig("systemPrompt", "synthetic unsaved local");
        await fetch("/api/config-vault/settings/personal", { method: "PUT", headers: { "Content-Type": "application/json", "X-Config-User": "1" }, body: JSON.stringify({ revision: envelope.personal.revision, value }) });
        await checkServerConfigurationVersions();
    });
    await until(async () => fresh.page.evaluate(async () => (await import("/src/services/server-config.ts")).useServerConfigStore.getState().phase === "conflict"), "Concurrent edit conflict not shown");
    await fresh.page.getByText("个人配置冲突对比", { exact: true }).waitFor();
    assert.equal((await stores(fresh.page)).config.systemPrompt, "synthetic unsaved local");
    await fresh.page.getByRole("button", { name: "确认保留当前本机修改", exact: true }).click();
    await confirm(fresh.page);
    await until(async () => (await settings(fresh.page)).personal.value.config.systemPrompt === "synthetic unsaved local", "Explicit conflict resolution failed");
    checks.push("cross-device version update and concurrent-edit conflict preserves local edits until explicit confirmation");
    await fresh.page.getByRole("button", { name: "退出登录", exact: true }).click();
    await fresh.page.getByRole("button", { name: "登录并恢复配置", exact: true }).waitFor();
    const loggedOut = await stores(fresh.page);
    assert.equal(loggedOut.config.channels.filter((c) => c.apiKey).length, 0);
    assert.equal(loggedOut.webdav.password, "");
    assert.equal(loggedOut.roles.removalApiKey, "");
    checks.push("logout clears private model, WebDAV and removal credentials");
    const vaultFiles = await fs.readdir(path.join(temp, "vault"), { recursive: true });
    for (const file of vaultFiles.filter((f) => f.endsWith(".enc"))) {
        const content = await fs.readFile(path.join(temp, "vault", file), "utf8");
        assert.ok(!content.includes("SYNTHETIC-PRIVATE-KEY"));
        assert.ok(!content.includes("SYNTHETIC-DAV-PASSWORD"));
        assert.ok(!content.includes("synthetic-token"));
    }
    checks.push("real encrypted files contain no plaintext private keys or session tokens");
    assert.deepEqual(errors, []);
    const report = { passed: true, syntheticData: true, productionModified: false, modelCalls: 0, checks };
    await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
} catch (error) {
    if (browser?.contexts()[0]?.pages()[0])
        await browser
            .contexts()[0]
            .pages()[0]
            .screenshot({ path: path.join(output, "failure.png"), fullPage: true })
            .catch(() => {});
    await fs.writeFile(path.join(output, "server-errors.log"), logs);
    console.error(logs);
    for (const context of browser?.contexts() || []) for(const failed of context.pages()) { console.error("Context state", await failed.evaluate(async()=>{const state=(await import("/src/services/server-config.ts")).useServerConfigStore.getState();return {phase:state.phase,message:state.message,user:state.user?.id};}).catch(()=>null)); }
    if (browser?.contexts()[0]?.pages()[0]) console.error((await browser.contexts()[0].pages()[0].locator("body").innerText()).slice(-1600));
    throw error;
} finally {
    await browser?.close();
    for (const child of children.reverse()) {
        if (child.exitCode === null) {
            const done = once(child, "exit");
            child.kill();
            await done;
        }
    }
    assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
    await fs.rm(temp, { recursive: true, force: true });
}
