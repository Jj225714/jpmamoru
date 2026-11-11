import { describe, expect, it } from "vitest";
import type { CommerceProductSuggestion, ProductRecord } from "@/types/commerce";
import { adoptProductSuggestion, parseCommerceProductSuggestion, productSuggestionFingerprint, resolveProductUncertainty, suggestedProductCategory, suggestedUncertaintyFactKey } from "./product-suggestions";

const product = { id: "p", sku: "s", name: "人工名称", productType: "垫", brandName: "", category: "内部类目", audience: "", description: "", size: "", images: [], imageUrls: [], extraFields: { 定制: "保留" }, verifiedFacts: { 材质: "棉" }, factsConfirmed: false, imageStatus: "ready" } satisfies ProductRecord;
const information = { name: "建议名称", audience: "居家用户", sellingPoints: "条纹外观", material: "可见纹理", usage: "桌面摆放", category: "Home & Kitchen > Mats" };
const draft = (): CommerceProductSuggestion => ({ information: { ...information }, uncertainties: ["成分待确认"], sourceFingerprint: productSuggestionFingerprint(product), createdAt: "2026-09-17" });

describe("product suggestion boundaries", () => {
    it.each([["地毯", "地毯地垫类"], ["桌垫", "桌垫类"], ["洞洞板", "洞洞板类"], ["收纳篮", "收纳筐类"]])("maps unambiguous identity %s to internal category %s", (name, expected) => {
        expect(suggestedProductCategory({ name, productType: "" }, { ...information, name, category: "" })).toBe(expected);
    });
    it("uses only specific taxonomy leaves and omits unknown or conflicting categories", () => {
        const empty = { name: "", productType: "" };
        expect(suggestedProductCategory(empty, { ...information, category: "Home & Kitchen > Storage Baskets" })).toBe("收纳筐类");
        expect(suggestedProductCategory(empty, information)).toBeUndefined();
        expect(suggestedProductCategory({ ...empty, name: "地毯" }, { ...information, category: "Office > Desk Mats" })).toBeUndefined();
        expect(suggestedProductCategory({ ...empty, name: "桌垫与地毯" }, information)).toBeUndefined();
    });
    it("uses canonical inputs and excludes saved drafts/loading state", () => {
        expect(productSuggestionFingerprint({ ...product, informationSuggestion: draft(), imageStatus: "loading" })).toBe(productSuggestionFingerprint(product));
        expect(productSuggestionFingerprint({ ...product, extraFields: { b: "2", a: "1" } })).toBe(productSuggestionFingerprint({ ...product, extraFields: { a: "1", b: "2" } }));
        for (const patch of [{ name: "changed" }, { factsConfirmed: true }, { verifiedFacts: {} }, { images: [{ id: "new", name: "x", url: "x", source: "upload" as const }] }, { materialDescription: "棉" }]) {
            expect(() => adoptProductSuggestion({ ...product, ...patch }, draft(), ["name"])).toThrow("已改变");
        }
    });
    it("fills selected blanks, explicitly replaces, and never approves facts or changes internal category", () => {
        const original = structuredClone(product);
        const adopted = adoptProductSuggestion(product, draft(), ["name", "material", "category"]);
        expect(adopted).toMatchObject({ name: product.name, materialDescription: information.material, categoryPath: information.category, category: product.category, factsConfirmed: false, verifiedFacts: product.verifiedFacts, description: "" });
        expect(adoptProductSuggestion(product, draft(), ["name"], true).name).toBe(information.name);
        expect(product).toEqual(original);
    });
    it("moves uncertain sentences out of claims even during adoption", () => {
        const value = draft();
        value.information.sellingPoints = "条纹外观。可能防水，耐热待确认。";
        const parsed = parseCommerceProductSuggestion(JSON.stringify(value));
        expect(parsed.information.sellingPoints).toBe("条纹外观。");
        expect(parsed.uncertainties).toContain("可能防水，耐热待确认。");
        expect(adoptProductSuggestion(product, value, ["sellingPoints"]).description).toBe("条纹外观。");
    });
    it.each(["{}", "not JSON", JSON.stringify({ information, uncertainties: "unknown" }), JSON.stringify({ information: { ...information, material: 12 }, uncertainties: [] }), JSON.stringify({ information: { ...information, category: "内部类目" }, uncertainties: [] })])("rejects malformed responses: %s", (answer) => {
        expect(() => parseCommerceProductSuggestion(answer)).toThrow("有效的六项");
    });
    it("allows unknown fields to remain empty with a separate uncertainty list", () => {
        const parsed = parseCommerceProductSuggestion(JSON.stringify({ information: Object.fromEntries(Object.keys(information).map((key) => [key, ""])), uncertainties: ["图片不清晰"] }));
        expect(parsed.information.name).toBe("");
    });
    it("confirms one uncertainty into facts without certifying all facts", () => {
        const next = resolveProductUncertainty(product, draft(), "成分待确认", { status: "confirmed", factKey: "材质", value: "聚酯纤维", resolvedAt: "now" });
        expect(next.verifiedFacts).toEqual({ 材质: "聚酯纤维" });
        expect(next.factsConfirmed).toBe(false);
        expect(next.informationSuggestion?.uncertaintyResolutions?.["成分待确认"].status).toBe("confirmed");
        expect(next.informationSuggestion?.sourceFingerprint).toBe(productSuggestionFingerprint(next));
    });
    it("ignores or restores uncertainty without changing facts", () => {
        const ignored = resolveProductUncertainty(product, draft(), "成分待确认", { status: "ignored", resolvedAt: "now" });
        expect(ignored.verifiedFacts).toEqual(product.verifiedFacts);
        expect(resolveProductUncertainty(ignored, ignored.informationSuggestion!, "成分待确认").informationSuggestion?.uncertaintyResolutions).toEqual({});
        expect(() => resolveProductUncertainty(product, draft(), "成分待确认", { status: "confirmed", factKey: "材质", value: "仍待确认", resolvedAt: "now" })).toThrow("仍包含待确认");
        expect(suggestedUncertaintyFactKey("尺寸规格未确认")).toBe("尺寸规格");
    });
});
