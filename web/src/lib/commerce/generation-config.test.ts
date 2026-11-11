import { describe, expect, it } from "vitest";

import { exportName } from "@/lib/commerce/export-name";
import { createCreativeRequirementPresets } from "./creative-presets";
import { cloneGenerationConfig } from "./generation-config";
import { createRequirementSelections, expectedAssetCount, expectedStageCounts, normalizeGenerationConfig, requirementFactFields, requirementVariantValues } from "@/lib/commerce/generation-config";
import type { CommerceJob, CommerceRequirementPreset, CommerceSku } from "@/types/commerce";

describe("commerce generation config", () => {
    it("preserves optional briefs and clones only explicit selection overrides", () => {
        expect(normalizeGenerationConfig()).not.toHaveProperty("creativeBrief");
        const config = normalizeGenerationConfig({ creativeBrief: { scene: "  office  " } });
        expect(config.creativeBrief).toEqual({ scene: "office" });
        const clone = cloneGenerationConfig(config);
        clone.creativeBrief!.scene = "changed";
        expect(config.creativeBrief?.scene).toBe("office");
        const presets = createCreativeRequirementPresets();
        const selections = createRequirementSelections(presets);
        expect(selections[5].creativeBrief).toBeUndefined();
        selections[5].creativeBrief = { scene: "  kitchen  ", people: "none" };
        const copied = createRequirementSelections(presets, selections);
        expect(copied[5].creativeBrief).toEqual({ scene: "kitchen", people: "none" });
        copied[5].creativeBrief!.people = "adult-full";
        expect(selections[5].creativeBrief.people).toBe("none");
    });

    it.each(["地毯地垫类", "桌垫类", "洞洞板类", "收纳筐类"])("counts default %s recipes as 4 + L finals with no implicit variants", (category) => {
        const presets = createCreativeRequirementPresets().filter((item) => item.category === category);
        const sku = { product: { verifiedFacts: { 颜色: "红、蓝", 尺寸列表: "大、小" }, extraFields: {}, size: "" }, requirementSelections: createRequirementSelections(presets), assets: [{ stage: "comparison-source" }, { stage: "comparison-source" }] } as unknown as CommerceSku;
        const job = { visualPipelineVersion: 3, locales: ["en-US", "th-TH", "id-ID"], generationConfig: normalizeGenerationConfig() } as CommerceJob;
        expect(expectedAssetCount(job, sku, presets)).toBe(7);
        expect(expectedStageCounts(job, sku, presets)).toMatchObject({ "main-white": 1, scene: 1, detail: 1, "usage-size": 1, marketing: 3 });
        expect(requirementFactFields(job, sku, presets)).toEqual([]);
        sku.requirementSelections[7].enabled = true;
        expect(expectedAssetCount(job, sku, presets)).toBe(10);
        job.generationConfig.marketingEnabled = false;
        expect(expectedAssetCount(job, sku, presets)).toBe(4);
        job.generationConfig.siteImageMode = "per-site";
        expect(expectedAssetCount(job, sku, presets)).toBe(10);
    });
    it("expands empty-selection fallback content per site only for v2", () => {
        const sku = { requirementSelections: [], selectedTemplateIds: [] } as unknown as CommerceSku;
        const job = { visualPipelineVersion: 2, locales: ["en-US", "th-TH"], generationConfig: normalizeGenerationConfig({ siteImageMode: "per-site", marketingEnabled: false }) } as CommerceJob;
        expect(expectedAssetCount(job, sku)).toBe(7);
        expect(expectedStageCounts(job, sku)).toMatchObject({ "main-white": 1, scene: 2, detail: 2, "usage-size": 2, "detail-white": 0, "marketing-base": 0, marketing: 0 });
        const legacy = { ...job, visualPipelineVersion: undefined };
        expect(expectedAssetCount(legacy, sku)).toBe(4);
        expect(expectedStageCounts(legacy, sku)).toMatchObject({ scene: 1, detail: 1, "usage-size": 1 });
        const shared = { ...job, generationConfig: { ...job.generationConfig, siteImageMode: "shared" as const } };
        expect(expectedAssetCount(shared, sku)).toBe(4);
        expect(expectedStageCounts(shared, sku)).toMatchObject({ scene: 1, detail: 1, "usage-size": 1 });
    });
    it("exposes variant facts without marketing or preset required facts", () => {
        const presets = [{ ...preset("color", "scene"), variantScope: "per-color" as const }, { ...preset("size", "detail"), variantScope: "per-size" as const }, { ...preset("custom", "detail"), variantScope: "custom" as const }, { ...preset("m", "marketing"), requiredFacts: ["营销参数"] }];
        const sku = { product: { verifiedFacts: { 颜色: "蓝、红", 尺寸列表: "大、小" }, extraFields: {}, size: "" }, requirementSelections: createRequirementSelections(presets) } as unknown as CommerceSku;
        const job = { generationConfig: normalizeGenerationConfig({ marketingEnabled: false }) } as CommerceJob;
        expect(requirementFactFields(job, sku, presets)).toEqual(["颜色", "尺寸列表"]);
        expect(requirementVariantValues(sku, sku.requirementSelections[0])).toEqual(["蓝", "红"]);
        expect(requirementVariantValues(sku, sku.requirementSelections[1])).toEqual(["大", "小"]);
        expect(requirementVariantValues(sku, { ...sku.requirementSelections[2], variantValues: ["蓝-大", "红-小"] })).toEqual(["蓝-大", "红-小"]);
    });
    it("snapshots visual settings and explicit empty references", () => {
        const source = { ...preset("m", "marketing"), visualMode: "generate" as const, visualKind: "scene" as const, referenceIds: ["preset-ref"] };
        const selections = createRequirementSelections([source]);
        expect(selections[0]).toMatchObject({ visualMode: "generate", visualKind: "scene" });
        expect(createRequirementSelections([source], [{ ...selections[0], visualMode: "white-layout", visualKind: "detail", referenceIds: [] }])[0]).toMatchObject({ visualMode: "white-layout", visualKind: "detail", referenceIds: [] });
    });

    it("never falls back to legacy counts for explicitly disabled selections or missing presets", () => {
        const sku = { selectedTemplateIds: ["m"], requirementSelections: createRequirementSelections([preset("m", "marketing")]).map((item) => ({ ...item, enabled: false })) } as CommerceSku;
        const job = { locales: ["en-US"], generationConfig: normalizeGenerationConfig() } as CommerceJob;
        expect(expectedAssetCount(job, sku)).toBe(1);
        expect(expectedAssetCount(job, sku, [preset("m", "marketing")])).toBe(1);
        expect(expectedStageCounts(job, sku)).toMatchObject({ scene: 0, marketing: 0, "marketing-base": 0 });
    });

    it("counts only matching selected locales for scenes and marketing", () => {
        const presets = [preset("s", "scene"), preset("m", "marketing")];
        const sku = { product: { verifiedFacts: {}, extraFields: {}, size: "" }, selectedTemplateIds: ["m"], requirementSelections: createRequirementSelections(presets).map((item) => ({ ...item, siteLocales: ["th-TH", "id-ID"] })) } as CommerceSku;
        const job = { locales: ["en-US", "th-TH"], generationConfig: normalizeGenerationConfig({ siteImageMode: "per-site" }) } as CommerceJob;
        expect(expectedAssetCount(job, sku, presets)).toBe(3);
        expect(expectedStageCounts(job, sku, presets)).toMatchObject({ scene: 1, marketing: 1, "marketing-base": 0 });
    });
    it("requires fresh review for revised presets despite previously reviewed brand defaults, preserving old snapshots", () => {
        const original = preset("marketing", "marketing");
        const oldSelections = createRequirementSelections([original]);
        expect(oldSelections[0].reviewed).toBe(true);
        const snapshot = structuredClone(oldSelections);
        const revised = { ...original, chineseCopy: "修改后的文案", needsReview: true };
        const newSelections = createRequirementSelections([revised], oldSelections);
        expect(newSelections[0].reviewed).toBe(false);
        expect(newSelections[0]).not.toBe(oldSelections[0]);
        expect(oldSelections).toEqual(snapshot);
        expect(createRequirementSelections([revised])[0].reviewed).toBe(false);
        expect(createRequirementSelections([original], [{ ...oldSelections[0], reviewed: false }])[0].reviewed).toBe(false);
        expect(createRequirementSelections([original], oldSelections)[0].reviewed).toBe(true);
    });

    it("clamps quantities and watermark opacity", () => {
        const config = normalizeGenerationConfig({ assetCounts: { scene: 9, detail: -1, "usage-size": 2, "detail-white": 1 }, watermark: { mode: "single", position: "center", opacity: 0.8 } });
        expect(config.assetCounts).toEqual({ scene: 4, detail: 0, "usage-size": 2, "detail-white": 1 });
        expect(config.overlay.watermark.opacity).toBe(0.3);
    });

    it("calculates dynamic outputs and unique filenames", () => {
        const sku = { selectedTemplateIds: ["a", "b"] } as CommerceSku;
        const job = { locales: ["en-US", "th-TH"], generationConfig: normalizeGenerationConfig({ assetCounts: { scene: 2, detail: 1, "usage-size": 0, "detail-white": 1 } }) } as CommerceJob;
        expect(expectedAssetCount(job, sku)).toBe(9);
        expect(exportName({ stage: "scene", sequence: 2 }, "jpg")).toBe("02-scene-02.jpg");
        expect(exportName({ stage: "detail-white", sequence: 1 }, "png")).toBe("05-detail-white-01.png");
    });

    it("calculates requirement counts by color, site, language, and selected quantity", () => {
        const config = normalizeGenerationConfig({ siteImageMode: "per-site" });
        const sku = { product: { verifiedFacts: { 颜色: "米色、棕色" }, extraFields: {}, size: "" }, selectedTemplateIds: ["marketing"], requirementSelections: [
            { requirementId: "scene", enabled: true, count: 2, referenceIds: [], variantScope: "per-color", variantValues: [] },
            { requirementId: "marketing", enabled: true, count: 1, referenceIds: [], variantScope: "per-color", variantValues: [] },
        ] } as unknown as CommerceSku;
        const job = { locales: ["en-US", "th-TH"], generationConfig: config } as CommerceJob;
        const presets: CommerceRequirementPreset[] = [preset("scene", "scene"), preset("marketing", "marketing")];
        expect(expectedAssetCount(job, sku, presets)).toBe(13);
        expect(expectedStageCounts(job, sku, presets)).toMatchObject({ "main-white": 1, scene: 8, marketing: 4 });
    });

    it("uses requirement identifiers, site and variant in collision-free export names", () => {
        expect(exportName({ stage: "scene", requirementId: "basket-scene", siteLocale: "th-TH", variantKey: "棕色", sequence: 2 }, "jpg")).toBe("02-scene-basket-scene-th-TH-棕色-02.jpg");
    });
});

function preset(id: string, stage: CommerceRequirementPreset["stage"]): CommerceRequirementPreset { return { id, category: "收纳筐类", order: 1, title: id, stage, enabledByDefault: true, defaultCount: 1, prompt: id, layout: "single-hero", chineseCopy: id, translationSeeds: {}, requiredFacts: [], referenceIds: [], variantScope: "per-sku", needsReview: false }; }
