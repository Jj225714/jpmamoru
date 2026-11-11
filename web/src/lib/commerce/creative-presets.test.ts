import { describe, expect, it } from "vitest";
import { createCreativeRequirementPresets } from "./creative-presets";

describe("creative recipes", () => {
    it("creates 32 stable independent recipes in four existing categories", () => {
        const presets = createCreativeRequirementPresets();
        expect(presets).toHaveLength(32);
        expect(new Set(presets.map((item) => item.id)).size).toBe(32);
        for (const slug of ["rugs", "mats", "pegboards", "baskets"]) {
            const group = presets.filter((item) => item.id.startsWith(`creative-v1-${slug}-`));
            expect(group.map((item) => item.recipeRole)).toEqual(["hero", "detail", "usage", "selling-point", "secondary-scene", "interaction", "lighting", "before-after"]);
            expect(group.filter((item) => item.enabledByDefault).every((item) => item.creativeBrief?.lighting === "natural-window")).toBe(true);
            expect(group.map((item) => item.stage)).toEqual(["scene", "detail", "usage-size", "marketing", "scene", "scene", "scene", "marketing"]);
            expect(group.map((item) => item.enabledByDefault)).toEqual([true, true, true, true, false, false, false, false]);
            expect(group.every((item) => item.defaultCount === 1 && item.variantScope === "per-sku")).toBe(true);
            expect(group[5].creativeBrief?.people).toBe("adult-partial");
            expect(group[7]).toMatchObject({ generationStrategy: "paired-before-after", layout: "before-after", creativeBrief: { people: "none" } });
            expect(group.slice(0, 7).every((item) => item.generationStrategy === "single")).toBe(true);
        }
        expect([...new Set(presets.map((item) => item.category))]).toEqual(["地毯地垫类", "桌垫类", "洞洞板类", "收纳筐类"]);
        expect(presets.every((item) => item.requiredFacts.length === 0 && item.referenceIds.length === 0 && !/右图|FAQ|\d+\s*(cm|mm|秒|kg)/i.test(item.prompt))).toBe(true);
    });

    it("uses practical default and conditional secondary scenes without shared mutable state", () => {
        const presets = createCreativeRequirementPresets();
        expect(presets.filter((item) => item.recipeRole === "hero").map((item) => item.creativeBrief?.scene)).toEqual(["客厅", "书桌桌面", "办公书桌区", "客厅"]);
        expect(presets.filter((item) => item.recipeRole === "secondary-scene").map((item) => item.creativeBrief?.scene)).toEqual(["卧室床边", "经产品用途确认适用的台面；未确认时使用书桌桌面", "兴趣用品收纳角", "衣橱收纳区"]);
        presets[0].creativeBrief!.scene = "changed";
        presets[0].requiredFacts.push("invented");
        expect(createCreativeRequirementPresets()[0].creativeBrief?.scene).toBe("客厅");
        expect(presets[1].requiredFacts).toEqual([]);
    });
});
