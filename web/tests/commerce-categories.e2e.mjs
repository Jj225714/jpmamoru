// Deterministic UI acceptance: real browser/components/storage, mocked managed policy HTTP only.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const failures = [];
page.on("pageerror", (e) => failures.push(e.message));
let draft = null,
    revision = 0;
await page.route("**/api/managed/session", (r) => r.fulfill({ json: { enabled: true, authenticated: true, principal: { id: "ui-admin", name: "UI test" } } }));
await page.route("**/api/managed/commerce-policies", async (r) => {
    const body = r.request().method() === "POST" ? r.request().postDataJSON() : {};
    if (body.action === "save") {
        draft = body.package;
        revision++;
    }
    if (body.action === "validate") return r.fulfill({ json: { valid: true, errors: [] } });
    return r.fulfill({ json: { canManage: true, revision, draft, history: [], activeVersion: 1 } });
});
await page.goto("http://127.0.0.1:3000/commerce");
await page.waitForTimeout(1200);
const fixture = await page.evaluate(async () => {
    const { useCommerceStore } = await import("/src/stores/use-commerce-store.ts");
    const { createCategorySeedPack } = await import("/src/lib/commerce/category-seed.ts");
    const { createBuiltInPolicyPack } = await import("/src/lib/commerce/defaults.ts");
    const pack = createCategorySeedPack(createBuiltInPolicyPack());
    pack.status = "published";
    pack.version = 100;
    useCommerceStore.setState({ policyPacks: [pack], catalogStatus: { phase: "success" }, hydrated: true });
    const id = useCommerceStore.getState().createJob({
        name: "类目细节浏览器验收",
        products: [
            {
                id: "p1",
                sku: "SKU-UI",
                productType: "test",
                name: "真实商品",
                brandName: "",
                category: "厨房地垫",
                audience: "",
                description: "",
                size: "",
                images: [],
                imageUrls: [],
                extraFields: {},
                verifiedFacts: {},
                factsConfirmed: false,
                imageStatus: "missing",
            },
        ],
    });
    return { pack, id, legacy: createBuiltInPolicyPack() };
});
// Existing installations already have a legacy public draft: the seed import must still be offered.
draft = fixture.legacy;
await page.goto("http://127.0.0.1:3000/commerce/settings");
await page.getByRole("tab", { name: "平台类目管理" }).click();
await page.getByRole("button", { name: "从当前规则创建类目草稿" }).click();
await page.getByRole("button", { name: "地垫类", exact: true }).click();
await page.getByLabel("类目名称", { exact: true }).fill("地垫类验收");
await page.getByRole("button", { name: "新增规则", exact: true }).click();
await page.getByLabel("规则内容").last().fill("浏览器验收规则");
assert.equal(await page.getByLabel("规则内容").last().inputValue(), "浏览器验收规则");
await page.getByLabel("规则内容").last().blur();
await page.waitForTimeout(300);
await page.getByRole("button", { name: "最终生效预览" }).click();
await page.getByRole("dialog").getByRole("tab", { name: "地垫类验收", exact: true }).click();

await page.getByRole("dialog").getByText("浏览器验收规则", { exact: false }).waitFor();
await fs.mkdir("test-results/commerce-categories", { recursive: true });
await page.screenshot({ path: "test-results/commerce-categories/admin-preview.png", fullPage: true });
await page.getByRole("button", { name: "完成校对" }).click();
await page.getByRole("button", { name: "复制当前类目", exact: true }).click();
assert.equal(await page.getByLabel("类目名称", { exact: true }).inputValue(), "地垫类验收 副本");
await page.getByLabel("所属大类", { exact: true }).click();
await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "桌垫类" }).click();
await page.getByText("↳ 地垫类验收 副本（停用）", { exact: true }).waitFor();
await page.goto("http://127.0.0.1:3000/commerce/" + fixture.id);
await page.getByLabel("商品大类", { exact: true }).click();
await page.getByText("地垫类", { exact: true }).last().click();
await page.getByLabel("商品细分类目", { exact: true }).click();
await page.locator(".ant-select-item-option").filter({ hasText: "厨房" }).click();
await page.getByText("SKU 细节实拍素材", { exact: true }).waitFor();
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l7cAAAAASUVORK5CYII=", "base64");
await page.locator("input[type=file]").filter({ visible: false }).first().setInputFiles({ name: "真实纹理.png", mimeType: "image/png", buffer: png });
await page.getByText("真实纹理.png", { exact: true }).waitFor();
await page.getByLabel("素材用途", { exact: true }).click();
await page.locator(".ant-select-item-option").filter({ hasText: "正面纹理" }).click();
await page.keyboard.press("Escape");
await page.getByText("所有变体通用", { exact: true }).click();
await page.getByLabel("绑定细节实拍", { exact: true }).first().click();
await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "真实纹理.png" }).click();
await page.keyboard.press("Escape");
await page.getByLabel("原图主图", { exact: true }).first().press("ArrowDown");
await page.getByLabel("原图主图", { exact: true }).first().press("Enter");
await page.getByLabel("细节渲染方式", { exact: true }).first().click();
await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "实拍原图排版" }).click();
const selected = await page.evaluate(async () => {
    const { useCommerceStore } = await import("/src/stores/use-commerce-store.ts");
    await useCommerceStore.persist.rehydrate();
    const sku = useCommerceStore.getState().jobs[0].skus[0];
    return { product: sku.product, selection: sku.requirementSelections.find((s) => s.detailRenderMode === "original") };
});
assert.equal(selected.product.subcategoryId, "kitchen-mat");
assert.equal(selected.product.detailImages[0].shared, true);
assert.ok(selected.product.detailImages[0].contentHash);
assert.equal(selected.selection.count, 1);
assert.equal(selected.selection.sourceImageIds.length, 1);
assert.ok(selected.selection.primaryImageIds[""]);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
await page.screenshot({ path: "test-results/commerce-categories/sku-materials.png", fullPage: true });
await page.goto("http://127.0.0.1:3000/config");
await page.getByRole("tab", { name: "跨境类目规则", exact: true }).click();
await page.getByText("直接在网页新增或修改大类", { exact: false }).waitFor();
await page.getByRole("button", { name: "从当前规则创建类目草稿", exact: true }).waitFor();
assert.deepEqual(failures, []);
console.log("PASS real browser: category admin editing+effective preview, SKU category selection, private photo upload+purpose+shared tagging; policy HTTP mocked; no model calls");
await browser.close();
