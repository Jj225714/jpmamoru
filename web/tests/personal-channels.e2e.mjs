import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium } from "playwright";
const base = process.env.EDITOR_TEST_URL || "http://127.0.0.1:3000";
const output = new URL("../test-results/personal-channels/", import.meta.url);
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultNavigationTimeout(60000);
const errors = [],
    managedRequests = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => {
    if (request.url().includes("/api/managed/")) managedRequests.push(request.url());
});
await page.addInitScript(() => {
    Object.defineProperty(window, "__RUNTIME_CONFIG__", { configurable: true, get: () => ({ managedModelGatewayEnabled: true }), set: () => {} });
    if (!localStorage.getItem("seeded-personal-test")) {
        localStorage.setItem(
            "infinite-canvas:ai_config_store",
            JSON.stringify({
                state: {
                    config: {
                        channels: [
                            {
                                id: "old",
                                name: "已有通用渠道",
                                baseUrl: "https://example.test",
                                apiKey: "old-personal-key",
                                apiFormat: "openai",
                                models: [
                                    { name: "gpt-image-2", capability: "image" },
                                    { name: "gpt-5.5", capability: "text" },
                                ],
                            },
                        ],
                        imageModel: "old::gpt-image-2",
                        textModel: "old::gpt-5.5",
                        managedPrincipalId: "expired-user",
                    },
                },
                version: 0,
            }),
        );
        localStorage.setItem("seeded-personal-test", "1");
    }
});
try {
    await page.goto(base + "/config?access_code=expired", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "新增渠道", exact: true }).waitFor();
    assert.ok(!(await page.locator("body").innerText()).includes("输入访问码"));
    assert.ok(!page.url().includes("access_code"));
    await page.getByRole("button", { name: "切换到浅色主题", exact: true }).click();
    await page.waitForFunction(() => !document.documentElement.classList.contains("dark"));
    await page.reload();
    await page.getByRole("button", { name: "切换到深色主题", exact: true }).waitFor();
    const add = async (provider, name, address, key) => {
        await page.getByRole("button", { name: "新增渠道", exact: true }).click();
        const drawer = page.getByRole("dialog").last();
        await drawer.getByLabel("服务类型", { exact: true }).click();
        await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: provider }).click();
        await drawer.getByLabel("渠道名称", { exact: true }).fill(name);
        await drawer.getByLabel("接口地址", { exact: true }).fill(address);
        await drawer.getByLabel("渠道 API Key", { exact: true }).fill(key);
        await drawer.getByRole("button", { name: /保\s*存/ }).click();
        await drawer.waitFor({ state: "hidden" });
    };
    await add("fal 图片工具", "我的 fal", "https://queue.fal.run", "fal-test-only");
    await add("Azure Vision 文字识别", "我的 OCR", "https://example.cognitiveservices.azure.com", "azure-test-only");
    await page.getByRole("tab", { name: "高级图片工具", exact: true }).click();
    for (const [operation, model] of [
        ["消除", "fal-ai/flux-pro/v1/fill"],
        ["扩图", "fal-ai/flux-pro/v1/fill"],
        ["高清", "fal-ai/esrgan"],
        ["文字识别", "read"],
        ["复杂拆层", "fal-ai/qwen-image-layered"],
    ]) {
        const picker = page.getByLabel(operation + "模型", { exact: true });
        await picker.focus();
        await picker.press("ArrowDown");
        await picker.press("Enter");
        await picker.press("Tab");
        const key = { 消除: "erase", 扩图: "expand", 高清: "upscale", 文字识别: "ocr", 复杂拆层: "layers" }[operation];
        await page.waitForFunction(({ key, model }) => JSON.parse(localStorage.getItem("infinite-canvas:ai_config_store")).state.config.editorBindings?.[key]?.endsWith("::" + model), { key, model });
    }
    await page.reload();
    await page.getByRole("tab", { name: "高级图片工具", exact: true }).click();
    const config = await page.evaluate(() => JSON.parse(localStorage.getItem("infinite-canvas:ai_config_store")).state.config);
    assert.equal(config.channels[0].apiKey, "old-personal-key");
    assert.equal(config.channels[1].apiKey, "fal-test-only");
    assert.equal(config.channels[2].apiKey, "azure-test-only");
    assert.equal(Object.keys(config.editorBindings).length, 5);
    assert.ok(!("managedPrincipalId" in config));
    assert.ok(!config.models.some((m) => m.includes("fal-ai/")));
    await page.goto(base + "/image?mode=advanced", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "上传图片编辑", exact: true }).waitFor();
    const png = await page.evaluate(() => {
        const c = document.createElement("canvas");
        c.width = 256;
        c.height = 192;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#eeddcc";
        ctx.fillRect(0, 0, 256, 192);
        return c.toDataURL().split(",")[1];
    });
    await page
        .locator('input[type="file"]')
        .first()
        .setInputFiles({ name: "theme-test.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
    const editor = page.getByRole("dialog", { name: "高级通用生图编辑器", exact: true });
    await editor.getByRole("button", { name: "添加文字", exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('canvas[aria-label="设计画布"]')?.width === 256);
    const pixels = () => editor.locator('canvas[aria-label="设计画布"]').evaluate((canvas) => canvas.toDataURL());
    const before = await pixels();
    await editor.getByRole("button", { name: "切换到深色主题", exact: true }).click();
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
    assert.equal(await pixels(), before);
    assert.equal(await editor.evaluate((el) => getComputedStyle(el).colorScheme), "dark");
    await page.screenshot({ path: new URL("editor-dark.png", output).pathname.replace(/^\/(\w:)/, "$1") });
    await editor.getByRole("button", { name: "消除", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "消除", exact: true });
    assert.equal(await modal.getByRole("button", { name: "生成预览" }).isEnabled(), true);
    await modal.getByRole("button", { name: /关\s*闭/ }).click();
    await editor.getByRole("button", { name: "切换到浅色主题", exact: true }).click();
    await page.waitForFunction(() => !document.documentElement.classList.contains("dark"));
    assert.equal(await pixels(), before);
    await page.screenshot({ path: new URL("editor-light.png", output).pathname.replace(/^\/(\w:)/, "$1") });
    await editor.getByRole("button", { name: "配置", exact: true }).click();
    const configuration = page.getByRole("dialog", { name: /配置与用户偏好/ });
    await configuration.getByRole("tab", { name: "偏好设置", exact: true }).click();
    await configuration.locator(".canvas-composer-model-picker").first().click();
    await page.getByRole("option", { name: /gpt-image-2/ }).click();
    await configuration.locator(".ant-modal-close").click();
    await editor.getByRole("button", { name: /返回/ }).click();
    await page.goto(base + "/config");
    const falRow = page.getByText("我的 fal", { exact: true }).locator("../..");
    await falRow.getByRole("button").last().click();
    await page.getByRole("tab", { name: "高级图片工具", exact: true }).click();
    await page.getByText(/选择消除使用的渠道/).waitFor();
    const final = await page.evaluate(() => JSON.parse(localStorage.getItem("infinite-canvas:ai_config_store")).state.config);
    assert.equal(final.channels[0].apiKey, "old-personal-key");
    assert.equal(final.channels.length, 2);
    assert.deepEqual(managedRequests, []);
    assert.deepEqual(errors, []);
    console.log(
        JSON.stringify({
            passed: true,
            flows: [
                "obsolete access code ignored",
                "personal configuration migration",
                "fal channel UI",
                "Azure channel UI",
                "five model bindings",
                "reload persistence",
                "deleted channel requires configuration",
                "light/dark editor and dialogs",
                "unchanged image pixels",
                "no authorization requests",
            ],
        }),
    );
} catch (error) {
    await page.screenshot({ path: new URL("failure.png", output).pathname.replace(/^\/(\w:)/, "$1") }).catch(() => {});
    console.error(error);
    console.error((await page.locator("body").innerText()).slice(-4500));
    process.exitCode = 1;
} finally {
    await browser.close();
}
