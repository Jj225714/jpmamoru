import { describe, expect, it } from "vitest";
import { compileCreativePrompt, normalizeCreativeBrief, resolveCreativeBrief } from "./creative-brief";
import { createCreativeRequirementPresets } from "./creative-presets";
import { createRequirementSelections, normalizeGenerationConfig } from "./generation-config";
import type { CommerceCreativeBrief, CommerceJob, CommerceSku } from "../../types/commerce";

function fixture(index = 5) {
    const preset = createCreativeRequirementPresets()[index];
    const selection = createRequirementSelections([preset])[0];
    const job = { platform: "shopee", locales: ["th-TH", "id-ID"], generationConfig: normalizeGenerationConfig() } as CommerceJob;
    const sku = { product: { name: "Sample", audience: "日常居家用户", description: "素色外观", materialDescription: "已提供的材质说明", usageInstructions: "平铺使用", verifiedFacts: { 颜色: "米色" }, extraFields: { unknownClaim: "manufactured" } } } as unknown as CommerceSku;
    return { job, sku, preset, selection };
}

describe("creative brief compiler", () => {
    it("preserves missing values and rejects unknown enum values", () => {
        expect(normalizeCreativeBrief()).toEqual({});
        expect(normalizeCreativeBrief({ scene: "  ", audience: "  家庭  ", people: "child", lighting: "bad", framing: "bad" } as unknown as CommerceCreativeBrief)).toEqual({ audience: "家庭" });
        expect(normalizeCreativeBrief({ people: "none" })).toEqual({ people: "none" });
    });

    it("resolves system < recipe < job < selection without filling missing overrides", () => {
        const { job, sku, preset, selection } = fixture();
        expect(resolveCreativeBrief(job, sku, preset, selection)).toMatchObject({ people: "adult-partial", audience: "日常居家用户", scene: "客厅" });
        preset.creativeBrief = { ...preset.creativeBrief, audience: "recipe audience" };
        job.generationConfig.creativeBrief = { scene: "job scene", lighting: "warm-indoor", audience: "job audience" };
        selection.creativeBrief = { scene: "selection scene", framing: "close" };
        expect(resolveCreativeBrief(job, sku, preset, selection)).toEqual({ scene: "selection scene", lighting: "warm-indoor", people: "adult-partial", audience: "job audience", framing: "close" });
        selection.creativeBrief.audience = "selection audience";
        job.generationConfig.creativeBrief.people = "none";
        expect(resolveCreativeBrief(job, sku, preset, selection)).toMatchObject({ audience: "selection audience", people: "none" });
        selection.creativeBrief.people = "adult-full";
        expect(resolveCreativeBrief(job, sku, preset, selection).people).toBe("adult-full");
        preset.creativeBrief = undefined;
        selection.creativeBrief = undefined;
        job.generationConfig.creativeBrief = undefined;
        expect(resolveCreativeBrief(job, sku, preset, selection)).toMatchObject({ lighting: "natural-window", people: "none", framing: "auto" });
    });

    it.each([1, 7, 9, 15, 17, 23, 25, 31])("keeps people choices available for detail and comparison recipe %i", (index) => {
        const { job, sku, preset, selection } = fixture(index);
        job.generationConfig.creativeBrief = { people: "adult-half" };
        selection.creativeBrief = { people: "adult-full" };
        expect(resolveCreativeBrief(job, sku, preset, selection).people).toBe("adult-full");
        expect(compileCreativePrompt(job, sku, preset, selection)).toContain("成人全身");
    });

    it("compiles supplied facts and suggestions deterministically without demographic or fabricated defaults", () => {
        const { job, sku, preset, selection } = fixture();
        const snapshot = structuredClone({ job, sku, preset, selection });
        const prompt = compileCreativePrompt(job, sku, preset, selection);
        expect(prompt).toContain("已提供的材质说明");
        expect(prompt).toContain("平铺使用");
        expect(prompt).toContain("已记录事实 颜色：米色");
        expect(prompt).toContain("非硬性规则");
        expect(prompt).not.toMatch(/manufactured|modelPreference|穆斯林|泰裔|东南亚|PU|PVC|30\*45/);
        expect(compileCreativePrompt({ ...job, locales: ["en-US"] }, sku, preset, selection)).toBe(prompt);
        expect({ job, sku, preset, selection }).toEqual(snapshot);
        selection.promptOverride = "自定义构图";
        expect(compileCreativePrompt(job, sku, preset, selection)).toContain("拍摄任务：自定义构图");
    });

    it("compiles distinct single-image before and after instructions", () => {
        const { job, sku, preset, selection } = fixture(7);
        const before = compileCreativePrompt(job, sku, preset, selection, "before");
        const after = compileCreativePrompt(job, sku, preset, selection, "after");
        expect(before).toContain("当前为使用前：不出现目标商品");
        expect(after).toContain("当前为使用后");
        expect(before).toContain("不生成拼接图");
        expect(after).toContain("相同人物、机位、光线、背景");
        expect(before).not.toBe(after);
    });
});
