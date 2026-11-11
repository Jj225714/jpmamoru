// Production browser bundle + real Python gateway + isolated local HTTPS/publication storage.
// No API routes are mocked, and the fixture gateway cannot call external models.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chromium } from "playwright";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "commerce-local-test-"));
const server = spawn(process.env.COMMERCE_TEST_PYTHON || "python", ["tests/fixtures/commerce-local-server.py", "--directory", temp], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let stderr = "";
server.stderr.on("data", (chunk) => {
    stderr += chunk;
});
let browser;
const output = "test-results/commerce-local-real";
await fs.mkdir(output, { recursive: true });
try {
    const ready = await new Promise((resolve, reject) => {
        let data = "";
        const timer = setTimeout(() => reject(new Error("Local fixture server did not start")), 60000);
        server.once("exit", () => {
            clearTimeout(timer);
            reject(new Error("Local fixture startup failed: " + stderr));
        });
        server.stdout.on("data", (chunk) => {
            data += chunk;
            if (data.includes("\n")) {
                clearTimeout(timer);
                resolve(JSON.parse(data.split("\n")[0]));
            }
        });
    });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1500, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const api = (page, endpoint) =>
        page.evaluate(async (url) => {
            const response = await fetch(url, { cache: "no-store" });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
        }, endpoint);
    const catalog = (page) => api(page, "/public-rules/catalog-creative-v1.json");
    const adminState = (page) => api(page, "/api/managed/commerce-policies");
    const login = async (target, code) => {
        await target.goto(ready.url + "/config");
        await target.getByRole("tab", { name: "跨境类目规则", exact: true }).click();
        await target.getByLabel("管理员服务端访问码").fill(code);
        await target.getByRole("button", { name: "登录管理会话", exact: true }).click();
    };
    await login(page, ready.code);
    await page.getByRole("button", { name: "↳ 厨房测试地垫", exact: true }).click();
    const original = await catalog(page);
    assert.equal(original.policyPacks[0].version, 1);
    await page.getByRole("button", { name: "新增规则", exact: true }).click();
    await page.getByLabel("规则内容", { exact: true }).last().fill("本地真实接口测试：商品图案保持清晰，禁止遮住主要花纹。");
    const uploadResponse = page.waitForResponse((r) => r.url().endsWith("/api/managed/commerce-policies") && r.request().postDataJSON()?.action === "upload");
    uploadResponse.catch(() => {});
    await page
        .locator(".ant-upload")
        .filter({ has: page.getByRole("button", { name: "上传公共示例", exact: true }) })
        .locator("input[type=file]")
        .setInputFiles("public/commerce-categories/image5.jpg");
    assert.equal((await uploadResponse).status(), 200);
    await page.getByRole("img", { name: "image5.jpg", exact: true }).waitFor();
    const savedResponse = page.waitForResponse((r) => r.url().endsWith("/api/managed/commerce-policies") && r.request().postDataJSON()?.action === "save");
    await page.getByRole("button", { name: "保存草稿", exact: true }).click();
    assert.equal((await savedResponse).status(), 200);
    assert.equal((await catalog(page)).revision, original.revision, "Draft saving must not publish");
    await page.getByRole("button", { name: /^校\s*验$/ }).click();
    await page.getByText("结构化校验通过，请人工校对最终规则", { exact: true }).waitFor();
    await page.getByRole("button", { name: "发布已保存草稿", exact: true }).click();
    const publishResponse = page.waitForResponse((r) => r.url().endsWith("/api/managed/commerce-policies") && r.request().postDataJSON()?.action === "publish");
    await page.locator(".ant-modal-confirm-btns .ant-btn-primary").click();
    assert.equal((await publishResponse).status(), 200);
    await page.getByText("类目规则已发布", { exact: true }).waitFor();
    const published = await catalog(page);
    assert.equal(published.policyPacks[0].version, 2);
    assert.equal(published.policyPacks[0].categories[1].rules.length, 2);
    assert.equal(published.policyPacks[0].categories[1].referenceIds.length, 2);
    const referenceStatus = await page.evaluate(async (url) => (await fetch(url)).status, published.policyPacks[0].references.at(-1).url);
    assert.equal(referenceStatus, 200);
    await page.screenshot({ path: output + "/published-config.png", fullPage: true });

    // A separate browser context loads the published directory without sharing browser storage.
    const second = await browser.newContext({ ignoreHTTPSErrors: true });
    const other = await second.newPage();
    await other.goto(ready.url + "/commerce");
    assert.equal((await catalog(other)).revision, published.revision);
    await login(other, ready.code);
    await other.getByRole("button", { name: "↳ 厨房测试地垫", exact: true }).click();
    await other.getByLabel("类目名称", { exact: true }).fill("并发编辑不应覆盖");
    await page.getByLabel("类目名称", { exact: true }).fill("先保存的厨房地垫");
    const firstSave = page.waitForResponse((r) => r.url().endsWith("/api/managed/commerce-policies") && r.request().postDataJSON()?.action === "save");
    await page.getByRole("button", { name: "保存草稿", exact: true }).click();
    assert.equal((await firstSave).status(), 200);
    const staleSave = other.waitForResponse((r) => r.url().endsWith("/api/managed/commerce-policies") && r.request().postDataJSON()?.action === "save");
    await other.getByRole("button", { name: "保存草稿", exact: true }).click();
    assert.equal((await staleSave).status(), 409);
    await other.getByText("草稿已被其他管理员更新，请刷新后重新编辑。", { exact: true }).waitFor();
    assert.equal((await adminState(page)).draft.categories[1].name, "先保存的厨房地垫");
    assert.equal((await catalog(other)).policyPacks[0].categories[1].name, "厨房测试地垫");

    // Real rollback creates a new version, leaving the old release immutable.
    await page.getByRole("button", { name: "回滚至此内容", exact: true }).first().click();
    const rollbackResponse = page.waitForResponse((r) => r.url().endsWith("/api/managed/commerce-policies") && r.request().postDataJSON()?.action === "rollback");
    await page.locator(".ant-modal-confirm-btns .ant-btn-primary").click();
    assert.equal((await rollbackResponse).status(), 200);
    await page.getByText("旧内容已重新发布为新版本", { exact: true }).waitFor();
    const rolledBack = await catalog(other);
    assert.equal(rolledBack.policyPacks[0].version, 3);
    assert.equal(rolledBack.policyPacks[0].categories[1].rules.length, 1);
    const oldRelease = await api(other, `/public-rules/releases/${published.revision}/catalog.json`);
    assert.equal(oldRelease.policyPacks[0].version, 2);

    const viewerContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const viewer = await viewerContext.newPage();
    await login(viewer, ready.viewerCode);
    await viewer.getByText("当前账号为只读，无类目管理权限。请联系平台管理员授权后刷新。", { exact: true }).waitFor();
    const denied = await viewer.evaluate(async () => {
        const session = await fetch("/api/managed/session").then((r) => r.json());
        return (await fetch("/api/managed/commerce-policies", { method: "POST", headers: { "Content-Type": "application/json", "X-Managed-Principal": session.principal.id }, body: JSON.stringify({ action: "publish", revision: 0 }) })).status;
    });
    assert.equal(denied, 403);
    assert.deepEqual(pageErrors, []);
    const report = {
        passed: true,
        environment: "local production bundle + real Python service over isolated HTTPS",
        checks: ["web admin login", "public example upload", "draft remains private", "publish", "new browser reads new version", "stale revision rejected", "rollback creates new version", "old release immutable", "viewer cannot publish"],
        modelCalls: 0,
        productionModified: false,
    };
    await fs.writeFile(output + "/report.json", JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
} catch (error) {
    const failedPage = browser?.contexts()[0]?.pages()[0];
    if (failedPage && !failedPage.isClosed()) await failedPage.screenshot({ path: output + "/failure.png", fullPage: true }).catch(() => {});
    if (stderr) await fs.writeFile(output + "/server-errors.log", stderr);
    throw error;
} finally {
    if (browser) await browser.close();
    const exited = server.exitCode === null ? once(server, "exit") : Promise.resolve();
    server.kill();
    await exited;
    assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith("commerce-local-test-"));
    await fs.rm(temp, { recursive: true, force: true });
}
