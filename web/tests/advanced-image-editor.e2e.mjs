// Browser workflow tests use a deterministic provider stub, not a claim of real model quality.
// Run with a local Vite server: node tests/advanced-image-editor.e2e.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");

const base = process.env.EDITOR_TEST_URL || "http://127.0.0.1:3000";
const output = new URL("../test-results/advanced-image-editor/", import.meta.url);
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
page.setDefaultNavigationTimeout(60000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
let configured = false,
    delayed = false,
    canceled = false;
const calls = [];
let fixtures;
const pendingJobs = new Map();
await page.addInitScript(() => {
    Object.defineProperty(window, "__RUNTIME_CONFIG__", { configurable: true, get: () => ({ managedModelGatewayEnabled: true }), set: () => {} });
});
await page.route("**/api/providers/**", async (route) => {
    const request = route.request(),
        url = new URL(request.url()),
        path = url.pathname;
    const send = (body) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (path.endsWith("/cancel")) {
        canceled = true;
        return send({});
    }
    if (path.endsWith("/azure/read")) {
        calls.push({ operation: "ocr" });
        return send({
            readResult: {
                blocks: [
                    {
                        lines: [
                            {
                                text: "SAMPLE",
                                words: [{ confidence: 0.97 }],
                                boundingPolygon: [
                                    { x: 40, y: 32 },
                                    { x: 200, y: 32 },
                                    { x: 200, y: 72 },
                                    { x: 40, y: 72 },
                                ],
                            },
                        ],
                    },
                ],
            },
        });
    }
    if (path.includes("/submit/")) {
        const input = request.postDataJSON(),
            alias = path.split("/").at(-1);
        calls.push(input);
        const id = `job-${calls.length}`;
        pendingJobs.set(id, { alias, input });
        return send({ request_id: id });
    }
    if (path.endsWith("/status")) return send({ status: delayed ? "IN_PROGRESS" : "COMPLETED" });
    if (path.endsWith("/result")) {
        const id = path.split("/").at(-2),
            job = pendingJobs.get(id);
        if (job.alias === "qwen-layered") return send({ images: [{ url: "https://fal.media/background.png" }, { url: "https://fal.media/product.png" }] });
        if (job.alias === "esrgan") return send({ image: { url: "https://fal.media/upscaled.png" } });
        return send({ images: [{ url: "https://fal.media/background.png" }] });
    }
    if (path.endsWith("/media")) {
        const name = new URL(url.searchParams.get("url")).pathname.slice(1).replace(".png", "");
        return route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from(fixtures[name].split(",")[1], "base64") });
    }
    return route.fulfill({ status: 404 });
});
try {
    await page.goto(base + "/image?mode=advanced", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "上传图片编辑", exact: true }).waitFor();
    fixtures = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 480;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#f8efdf";
        ctx.fillRect(0, 0, 640, 480);
        const background = canvas.toDataURL();
        ctx.fillStyle = "#164c3e";
        ctx.fillRect(240, 145, 160, 255);
        ctx.fillStyle = "#d2ae65";
        ctx.fillRect(275, 105, 90, 40);
        ctx.fillRect(265, 230, 110, 80);
        ctx.fillStyle = "#222222";
        ctx.font = "32px Arial";
        ctx.fillText("SAMPLE", 40, 64);
        const source = canvas.toDataURL();
        ctx.clearRect(0, 0, 640, 480);
        ctx.fillStyle = "#164c3e";
        ctx.fillRect(240, 145, 160, 255);
        const product = canvas.toDataURL();
        const high = document.createElement("canvas");
        high.width = 1280;
        high.height = 960;
        const highContext = high.getContext("2d");
        highContext.fillStyle = "white";
        highContext.fillRect(0, 0, high.width, high.height);
        highContext.drawImage(canvas, 0, 0, high.width, high.height);
        return { source, background, product, upscaled: high.toDataURL() };
    });
    await page
        .locator('input[type="file"]')
        .first()
        .setInputFiles({ name: "sample-product.png", mimeType: "image/png", buffer: Buffer.from(fixtures.source.split(",")[1], "base64") });
    const editor = page.getByRole("dialog", { name: "高级通用生图编辑器", exact: true });
    await editor.getByRole("button", { name: "添加文字", exact: true }).waitFor();
    await editor.getByLabel("设计名称", { exact: true }).fill("高级生图验收稿");
    await editor.getByRole("button", { name: "添加文字", exact: true }).click();
    await editor.getByLabel("文字内容", { exact: true }).fill("自然香氛\nNEW COLLECTION");
    await editor.getByLabel("字号", { exact: true }).fill("28");
    await editor.getByLabel("x", { exact: true }).fill("45");
    await editor.getByLabel("y", { exact: true }).fill("65");
    const beforeX = await editor.getByLabel("x", { exact: true }).inputValue();
    const rect = editor.locator("svg > g").last().locator("rect").first();
    const bounds = await rect.boundingBox();
    await page.mouse.move(bounds.x + 20, bounds.y + 20);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 70, bounds.y + 50, { steps: 4 });
    await page.mouse.up();
    assert.notEqual(await editor.getByLabel("x", { exact: true }).inputValue(), beforeX);
    await editor.getByRole("button", { name: /撤\s*销/ }).click();
    assert.equal(await editor.getByLabel("x", { exact: true }).inputValue(), beforeX);
    await editor.getByRole("button", { name: /重\s*做/ }).click();
    await editor.getByLabel("锁定", { exact: true }).first().check();
    assert.equal(await editor.getByLabel("x", { exact: true }).isDisabled(), true);
    await editor.getByLabel("锁定", { exact: true }).first().uncheck();
    const download = page.waitForEvent("download");
    await editor.getByRole("button", { name: "下载 PNG", exact: true }).click();
    const file = await download;
    await file.saveAs(new URL("export.png", output).pathname.replace(/^\/(\w:)/, "$1"));
    await editor.getByText("已保存到当前浏览器", { exact: true }).waitFor();
    await page.reload();
    await page.getByRole("button", { name: /我的编辑稿/ }).click();
    await page.getByRole("button", { name: /高级生图验收稿/ }).click();
    await editor.getByRole("button", { name: /原始图片/ }).click();
    await editor.getByRole("button", { name: "消除", exact: true }).click();
    let modal = page.getByRole("dialog", { name: "消除", exact: true });
    await modal.getByText(/请选择|请在.*选择消除/).waitFor();
    assert.equal(await modal.getByRole("button", { name: "生成预览" }).isDisabled(), true);
    await modal.getByRole("button", { name: /关\s*闭/ }).click();
    configured = true;
    await page.evaluate(() => {
        const key = "infinite-canvas:ai_config_store",
            stored = JSON.parse(localStorage.getItem(key)) || { state: { config: { channels: [] } }, version: 1 };
        stored.state.config.channels.push(
            {
                id: "test-fal",
                name: "fal test",
                provider: "fal",
                apiFormat: "openai",
                apiKey: "test-only",
                baseUrl: "https://queue.fal.run",
                models: [
                    { name: "fal-ai/flux-pro/v1/fill", capability: "image", editorOperations: ["erase", "expand"] },
                    { name: "fal-ai/esrgan", capability: "image", editorOperations: ["upscale"] },
                    { name: "fal-ai/qwen-image-layered", capability: "image", editorOperations: ["layers"] },
                ],
            },
            { id: "test-azure", name: "azure test", provider: "azure-vision", apiFormat: "openai", apiKey: "test-only", baseUrl: "https://test.cognitiveservices.azure.com", models: [{ name: "read", capability: "text", editorOperations: ["ocr"] }] },
        );
        stored.state.config.editorBindings = { erase: "test-fal::fal-ai/flux-pro/v1/fill", expand: "test-fal::fal-ai/flux-pro/v1/fill", upscale: "test-fal::fal-ai/esrgan", layers: "test-fal::fal-ai/qwen-image-layered", ocr: "test-azure::read" };
        localStorage.setItem(key, JSON.stringify(stored));
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /我的编辑稿/ }).click();
    await page.getByRole("button", { name: /高级生图验收稿/ }).click();
    await editor.getByRole("button", { name: /原始图片/ }).click();
    await editor.getByRole("button", { name: "消除", exact: true }).click();
    modal = page.getByRole("dialog", { name: "消除", exact: true });
    const brush = modal.getByLabel("涂抹选区");
    await brush.hover();
    const area = await brush.boundingBox();
    await page.mouse.move(area.x + 80, area.y + 80);
    await page.mouse.down();
    await page.mouse.move(area.x + 140, area.y + 80, { steps: 5 });
    await page.mouse.up();
    await modal.getByRole("button", { name: "生成预览" }).click();
    await editor.getByRole("button", { name: "应用结果", exact: true }).click();
    assert.ok(calls.at(-1).mask_url.startsWith("data:image/png;base64,"));
    await editor.getByRole("button", { name: "编辑文字", exact: true }).click();
    modal = page.getByRole("dialog", { name: "编辑原图文字", exact: true });
    await modal.getByRole("button", { name: "识别文字", exact: true }).click();
    await modal.getByLabel("识别文字", { exact: true }).fill("新品上市");
    await modal.getByRole("button", { name: "清除旧字并生成文字层" }).click();
    await editor.getByRole("button", { name: "应用结果", exact: true }).click();
    assert.equal(await editor.getByLabel("文字内容", { exact: true }).inputValue(), "新品上市");
    await editor.getByRole("button", { name: /原始图片/ }).click();
    await editor.getByRole("button", { name: "拆分图层", exact: true }).click();
    modal = page.getByRole("dialog", { name: "复杂图层拆分", exact: true });
    await modal.getByRole("button", { name: "生成预览" }).click();
    await editor.getByRole("button", { name: "应用结果", exact: true }).click();
    await editor.getByRole("button", { name: /拆分图层 2/ }).click();
    await editor.getByRole("button", { name: "高清", exact: true }).click();
    modal = page.getByRole("dialog", { name: "高清增强", exact: true });
    await modal.getByRole("button", { name: "生成预览" }).click();
    await editor.getByRole("button", { name: "应用结果", exact: true }).click();
    await editor.getByRole("button", { name: "扩图", exact: true }).click();
    modal = page.getByRole("dialog", { name: "扩图", exact: true });
    await modal.getByRole("button", { name: "生成预览" }).click();
    await editor.getByRole("button", { name: "应用结果", exact: true }).click();
    await editor.getByText(/896 × 736px/).waitFor();
    await editor.getByRole("button", { name: /拆分图层 2/ }).click();
    delayed = true;
    await editor.getByRole("button", { name: "拆分图层", exact: true }).click();
    modal = page.getByRole("dialog", { name: "复杂图层拆分", exact: true });
    await modal.getByRole("button", { name: "生成预览" }).click();
    await modal.getByText("处理中…", { exact: true }).waitFor();
    await modal.getByRole("button", { name: "取消处理", exact: true }).click();
    await modal.getByText("已取消，原图未改变").waitFor();
    assert.equal(canceled, true);
    await modal.getByRole("button", { name: /关\s*闭/ }).click();
    await editor.getByRole("button", { name: /撤\s*销/ }).click();
    await editor.getByText(/640 × 480px/).waitFor();
    await editor.getByRole("button", { name: /重\s*做/ }).click();
    await editor.getByText(/896 × 736px/).waitFor();
    await page.screenshot({ path: new URL("editor.png", output).pathname.replace(/^\/(\w:)/, "$1"), fullPage: true });
    assert.deepEqual(errors, []);
    console.log(
        JSON.stringify({
            passed: true,
            workflows: ["advanced entry", "upload", "text", "drag", "undo/redo", "lock", "PNG export", "refresh recovery", "missing config", "erase mask", "OCR editable text", "split layers", "upscale", "expand", "cancel"],
            provider: "deterministic stub; real API credentials required",
            requests: calls.length,
        }),
    );
} catch (error) {
    await page.screenshot({ path: new URL("failure.png", output).pathname.replace(/^\/(\w:)/, "$1"), fullPage: true }).catch(() => {});
    console.error(error);
    console.error((await page.locator("body").innerText()).slice(-6000));
    process.exitCode = 1;
} finally {
    await browser.close();
}
