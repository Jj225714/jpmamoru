import { describe, expect, it } from "vitest";
import { createBuiltInPolicyPack } from "./defaults";
import { createCategorySeedPack } from "./category-seed";
import { categoryPreflightErrors, categoryPrompt, categoryRequirements, resolveCategory, validateCategories } from "./category-rules";

function fixture() {
    const pack = createCategorySeedPack(createBuiltInPolicyPack());
    for (const node of pack.categories!.filter((node) => !node.parentId && ["pegboards", "baskets"].includes(node.id))) { node.referenceIds = [pack.references.at(-1)!.id]; node.active = true; }
    return pack;
}
const kitchen = { category: "地垫类", categoryId: "floor-mats", subcategoryId: "kitchen-mat" };
describe("category rules", () => {
    it("can publish the ten workbook subcategories without inventing examples for unrelated legacy categories", () => {
        const pack = createCategorySeedPack(createBuiltInPolicyPack());
        expect(pack.categories!.filter((node) => ["pegboards", "baskets"].includes(node.id)).every((node) => !node.active)).toBe(true);
        expect(pack.categories!.filter((node) => node.parentId && node.active)).toHaveLength(10);
        expect(validateCategories(pack)).toEqual([]);
    });
    it("opens subsequent drafts without resetting rules or duplicating seed resources", () => {
        const pack = fixture();
        pack.categories![0].name = "管理员调整后的地毯";
        const next = createCategorySeedPack(pack);
        expect(next.categories).toEqual(pack.categories);
        expect(next.references).toHaveLength(pack.references.length);
        expect(next.requirementPresets).toHaveLength(pack.requirementPresets.length);
        expect(next).not.toBe(pack);
    });
    it("maps all ten worksheet rows and preserves source text separately", () => {
        const pack = fixture();
        expect(pack.categories!.filter((node) => node.parentId)).toHaveLength(10);
        expect(pack.categories!.filter((node) => !node.parentId)).toHaveLength(5);
        const living = pack.categories!.find((node) => node.id === "living-room-rug")!;
        expect(living.source!.originalText).toContain("透视比例真实，畸变");
        expect(living.rules[0].text).toContain("透视比例真实，不畸变");
        expect(pack.categories!.find((node) => node.id === "dining-table-mat")!.name).toBe("餐桌垫");
        expect(new Set(pack.categories!.filter((node) => node.parentId).flatMap((node) => node.referenceIds)).size).toBe(10);
        expect(validateCategories(pack)).toEqual([]);
    });
    it("inherits parent requirements and hard rules, but uses child references and defaults", () => {
        const pack = fixture();
        const parent = pack.categories!.find((node) => node.id === kitchen.categoryId)!;
        parent.rules.push({ id: "preserve", text: "保留花纹", strength: "required", stages: ["scene"] });
        parent.referenceIds = ["parent-example"];
        parent.creativeBrief = { scene: "旧场景", lighting: "soft-studio" };
        const result = resolveCategory(pack, kitchen)!;
        expect(result.rules.some((rule) => rule.id === "preserve")).toBe(true);
        expect(result.referenceIds).toEqual(["category-example-kitchen-mat"]);
        expect(result.creativeBrief).toMatchObject({ people: "adult-half", scene: "厨房水槽或柜体前", lighting: "soft-studio" });
        expect(categoryRequirements(pack, kitchen)).toHaveLength(9);
        expect(categoryPrompt(pack, kitchen, "scene")).toContain("厨房");
        expect(categoryPrompt(pack, kitchen, "detail")).toBe("");
        pack.categories!.find((node) => node.id === kitchen.subcategoryId)!.referenceIds = [];
        expect(resolveCategory(pack, kitchen)!.referenceIds).toEqual(["parent-example"]);
    });
    it("rejects inherited rule weakening and structured conflicts only in overlapping stages", () => {
        const pack = fixture();
        const parent = pack.categories!.find((node) => node.id === kitchen.categoryId)!;
        parent.rules.push({ id: "person", text: "无人", strength: "required", stages: ["scene"], key: "people", value: "none" });
        expect(validateCategories(pack).join()).toContain("硬性要求冲突");
        parent.rules[0].stages = ["detail"];
        expect(validateCategories(pack)).toEqual([]);
        pack.categories!.find((node) => node.id === kitchen.subcategoryId)!.rules.push({ ...parent.rules[0], strength: "guide" });
        expect(validateCategories(pack).join()).toContain("不得覆盖");
    });
    it("requires explicit child choice and accepts new configurable root categories", () => {
        const pack = fixture();
        expect(categoryPreflightErrors(pack, { category: "地毯类" }).join()).toContain("请选择细分类目");
        expect(categoryPreflightErrors(pack, { ...kitchen, categoryId: "rugs" }).join()).toContain("不匹配");
        pack.categories!.push({ id: "new-root", name: "新商品", active: true, aliases: [], order: 10, rules: [], referenceIds: [], requirementIds: ["category-v1-rugs-detail"] });
        expect(categoryRequirements(pack, { category: "新商品", categoryId: "new-root" }).map((item) => item.id)).toEqual(["category-v1-rugs-detail"]);
        expect(categoryPreflightErrors(pack, { category: "新商品", categoryId: "new-root" })).toEqual([]);
    });
    it("rejects global alias ambiguity while allowing the same node's own name as an alias", () => {
        const pack = fixture();
        pack.categories![0].aliases.push(pack.categories![0].name);
        expect(validateCategories(pack)).toEqual([]);
        pack.categories![1].aliases.push(pack.categories![0].name);
        expect(validateCategories(pack).join()).toContain("类目名称或别名重复");
    });
    it("requires an example for implicit scene marketing, and prohibits people in detail", () => {
        const pack = fixture();
        const root = pack.categories!.find((node) => node.id === "baskets")!;
        const marketing = pack.requirementPresets.find((preset) => preset.id === "category-v1-baskets-selling-point")!;
        marketing.visualKind = undefined;
        root.requirementIds = [marketing.id];
        root.referenceIds = [];
        expect(validateCategories(pack).join()).toContain("场景方案缺少示例图");
        root.rules.push({ id: "bad-detail", text: "细节有人", key: "people", value: "adult-half", strength: "required", stages: ["detail-white"] });
        expect(validateCategories(pack).join()).toContain("细节图片不能要求人物");
    });
});
