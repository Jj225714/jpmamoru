import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("http://localhost:3000/config");
    await page.getByRole("tab", { name: "跨境类目规则", exact: true }).click();
    await page.getByText("原文件分类：3 个大类、10 个子类。", { exact: false }).waitFor();
    const groups = { 地毯类: ["客厅地毯", "餐厅地毯"], 地垫类: ["卧室床边地垫", "厨房地垫", "浴室地垫", "入户门地垫", "淋浴房地垫"], 桌垫类: ["大尺寸鼠标垫", "餐桌垫", "沥水垫"] };
    for (const [root, children] of Object.entries(groups)) {
        const card = page
            .locator(".ant-card")
            .filter({ has: page.getByRole("heading", { name: root, exact: true }) })
            .last();
        for (const name of children) assert.ok((await card.innerText()).includes(name), `${root} must contain ${name}`);
        assert.equal(await card.locator(".ant-collapse-header").count(), children.length);
    }
    await page.locator(".ant-collapse-header").filter({ hasText: "厨房地垫" }).click();
    await page.getByRole("img", { name: "厨房地垫示例图", exact: true }).waitFor();
    await page.waitForFunction(() => {
        const img = document.querySelector('img[alt="厨房地垫示例图"]');
        return img?.complete && img.naturalWidth > 0;
    });
    await page.getByText("人物出现半身，自然进行厨房操作", { exact: false }).first().waitFor();
    await fs.mkdir("test-results/category-hierarchy", { recursive: true });
    await page.screenshot({ path: "test-results/category-hierarchy/three-groups.png", fullPage: true });
    assert.deepEqual(errors, []);
    console.log("PASS: three worksheet parent categories, 10 correctly nested child categories, matching kitchen requirements and full reference image; legacy categories separate");
} finally {
    await browser.close();
}
