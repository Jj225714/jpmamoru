import assert from "node:assert/strict";
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage();
    const url = (process.env.WHITE_TEST_URL || "http://127.0.0.1:3018") + "/image?mode=product-white";
    await page.goto(url);
    await page.getByRole("button", { name: "上传商品图片", exact: true }).waitFor();
    await page.evaluate(async () => {
        const { localForageStorage } = await import("/src/lib/localforage-storage.ts");
        const { DEFAULT_WHITE_ADJUSTMENTS, updateWhiteAdjustments } = await import("/src/lib/commerce/white-image-edit.ts");
        const canvas = document.createElement("canvas"); canvas.width = canvas.height = 32;
        canvas.getContext("2d").fillRect(8, 8, 16, 16);
        const image = { url: canvas.toDataURL(), width: 32, height: 32, bytes: 100, mimeType: "image/png" };
        const base = { width: 0.8, height: 0.8, bounds: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } };
        const enabled = updateWhiteAdjustments(base, DEFAULT_WHITE_ADJUSTMENTS, { perspectiveEnabled: true });
        const applied = updateWhiteAdjustments(base, enabled, { scale: 150, backgroundColor: "#123456", backgroundOpacity: 25 });
        const records = ["saved", "original"].map(id => ({ id, source: { id: "source", name: "刷新测试", url: image.url, source: "upload" }, image, editor: { version: 1, layer: image, base, applied }, output: { size: 800, format: "png" }, createdAt: "2026-10-25" }));
        const { useProductWhiteStore } = await import("/src/stores/use-product-white-store.ts");
        useProductWhiteStore.setState({ records, selectedId: "saved" });
        await localForageStorage.setItem("infinite-canvas:product-white", JSON.stringify({ state: { records, selectedId: "saved" }, version: 0 }));
    });
    // A slow IndexedDB read must never be overtaken by page initialization writes.
    await page.route("**/src/lib/localforage-storage.ts*", async route => {
        const response = await route.fetch();
        const body = (await response.text()).replace('getItem: async (name) => {', 'getItem: async (name) => { if (name === "infinite-canvas:product-white") await new Promise(r => setTimeout(r, 1200));');
        await route.fulfill({ response, body });
    });
    for (let i = 0; i < 2; i++) {
        await page.reload();
        await page.getByText("白底处理记录", { exact: true }).waitFor({ timeout: 15000 });
        await page.getByLabel("等比缩放", { exact: true }).waitFor();
        assert.equal(await page.getByLabel("等比缩放", { exact: true }).inputValue(), "150");
        assert.equal(await page.getByLabel("背景颜色", { exact: true }).inputValue(), "#123456");
        const state = await page.evaluate(async () => {
            const { useProductWhiteStore } = await import("/src/stores/use-product-white-store.ts");
            return { records: useProductWhiteStore.getState().records.length, selectedId: useProductWhiteStore.getState().selectedId };
        });
        assert.deepEqual(state, { records: 2, selectedId: "saved" });
    }
    await page.getByLabel("等比缩放", { exact: true }).fill("170");
    await page.getByLabel("背景透明度", { exact: true }).fill("60");
    await page.getByRole("button", { name: "保存调整", exact: true }).first().click();
    await page.waitForFunction(async () => {
        const { useProductWhiteStore } = await import("/src/stores/use-product-white-store.ts");
        return useProductWhiteStore.getState().records.length === 3;
    });
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载白底图", exact: true }).click();
    assert.equal(await (await download).failure(), null);
    await page.reload();
    await page.getByLabel("等比缩放", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("等比缩放", { exact: true }).inputValue(), "170");
    assert.equal(await page.getByLabel("背景透明度", { exact: true }).inputValue(), "60");
    assert.equal(await page.getByLabel("背景颜色", { exact: true }).inputValue(), "#123456");
    assert.equal(await page.evaluate(async () => (await import("/src/stores/use-product-white-store.ts")).useProductWhiteStore.getState().records.length), 3);
    console.log("PASS: delayed IndexedDB hydration, repeated reloads, actual save/download/reload, selected perspective/background restored");
} finally { await browser.close(); }
