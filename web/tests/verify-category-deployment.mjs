// Read-only production smoke check in an empty browser context. No model calls or writes.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const output = "test-results/category-server-sync-20260924";
await fs.mkdir(output, { recursive: true });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = [];
    const requests = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => requests.push({ method: request.method(), url: request.url() }));
    const response = await page.goto("https://103.79.187.126/config", { waitUntil: "domcontentloaded" });
    assert.equal(response.status(), 200);
    await page.getByRole("tab", { name: "跨境类目规则", exact: true }).click();
    await page.getByText("原文件分类：3 个大类、10 个子类。", { exact: false }).waitFor();
    for (const name of ["地毯类", "地垫类", "桌垫类"]) await page.getByRole("heading", { name, exact: true }).waitFor();
    assert.equal(await page.getByLabel("管理员服务端访问码").count(), 0);
    await page.locator(".ant-collapse-header").filter({ hasText: "厨房地垫" }).click();
    await page.waitForFunction(() => { const image = document.querySelector('img[alt="厨房地垫示例图"]'); return image?.complete && image.naturalWidth > 0; });
    await page.getByRole("tab", { name: "账号与同步", exact: true }).waitFor();
    await page.screenshot({ path: output + "/live-category-config.png", fullPage: true });
    assert.deepEqual(errors, []);
    assert.equal(requests.some((request) => new URL(request.url).pathname.startsWith("/api/managed/")), false);
    assert.equal(requests.some((request) => request.method === "POST"), false);
    const result = { url: page.url(), status: "passed", groups: 3, subcategories: 10, exampleLoaded: true, accountSyncVisible: true, pageErrors: errors, productionWrites: 0, modelCalls: 0 };
    await fs.writeFile(output + "/result.json", JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
} finally {
    await browser.close();
}
