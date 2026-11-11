import { describe, expect, it } from "vitest";
import { cloneGenerationConfig, DEFAULT_COMMERCE_GENERATION_CONFIG } from "./generation-config";
import { assertVisualsReady, buildVisualPlan, matchVisualSource, matchVisualSources, isFinalAsset, visualPreflightErrors } from "./visual-plan";
import { canApproveContent, marketingLineageErrors, runDeterministicChecks } from "./policy-engine";
import type { CommerceJob, CommerceRequirementPreset, CommerceSku, GeneratedAsset, RequirementSelection } from "@/types/commerce";

export function visualFixture() {
    const preset: CommerceRequirementPreset = { id: "basket-scene", title: "客厅收纳", category: "收纳筐类", order: 1, stage: "marketing", enabledByDefault: true, defaultCount: 1, prompt: "两个收纳筐置于客厅，绿植背景", layout: "single-hero", chineseCopy: "整洁收纳", translationSeeds: {}, requiredFacts: [], referenceIds: ["ref-1"], variantScope: "per-sku", needsReview: false };
    const selection: RequirementSelection = { requirementId: preset.id, enabled: true, count: 1, referenceIds: ["ref-1"], variantScope: "per-sku", variantValues: [], reviewed: true };
    const white: GeneratedAsset = { id: "white", jobId: "job", skuId: "sku", stage: "main-white", sequence: 1, revision: 1, title: "白底", url: "white.png", width: 1024, height: 1024, bytes: 100, mimeType: "image/jpeg", createdAt: "now" };
    const sku: CommerceSku = { id: "sku", product: { id: "product", sku: "SKU", name: "篮筐", productType: "", category: "收纳筐类", brandName: "", audience: "", description: "", size: "", images: [], imageUrls: [], extraFields: {}, verifiedFacts: {}, factsConfirmed: true, imageStatus: "ready" }, stage: "content-review", assets: [white], selectedTemplateIds: [preset.id], requirementSelections: [selection], compositions: [], copyZh: { [preset.id]: "整洁收纳" }, localizedCopy: {}, checks: [], activeRevision: 1, approvals: [{ gate: "white-background", approved: true, reviewer: "owner", assetRevision: 1, reviewedAt: "now" }] };
    const job: CommerceJob = { id: "job", name: "测试", platform: "shopee", visualPipelineVersion: 2, locales: ["en-US", "ms-MY"], generationConfig: cloneGenerationConfig(DEFAULT_COMMERCE_GENERATION_CONFIG), status: "draft", skus: [sku], createdAt: "now", updatedAt: "now" };
    return { job, sku, preset, selection, white };
}

export function readyBases(job: CommerceJob, sku: CommerceSku, presets: CommerceRequirementPreset[]) {
    return buildVisualPlan(job, sku, presets).map((item, index): GeneratedAsset => ({ ...sku.assets[0], id: "base-" + index, url: "scene-" + index + ".jpg", stage: item.stage, requirementId: item.preset.id, sequence: item.sequence, variantKey: item.variantKey, siteLocale: item.siteLocale, visualKey: item.key, visualFingerprint: item.fingerprint }));
}

describe("requirement visual planning", () => {
    it("plans v3 pairs only and binds AFTER to actual BEFORE content across revision clones", () => {
        const { job, sku, preset, selection, white } = visualFixture();
        preset.generationStrategy = "paired-before-after";
        expect(buildVisualPlan(job, sku, [preset])).toHaveLength(1);
        job.visualPipelineVersion = 3;
        const make = (index: number, url: string) => {
            const item = buildVisualPlan(job, sku, [preset])[index];
            return { ...white, id: url, url, stage: item.stage, requirementId: preset.id, sequence: item.sequence, variantKey: item.variantKey, visualKey: item.key, visualFingerprint: item.fingerprint, comparisonRole: item.comparisonRole, comparisonGroupKey: item.comparisonGroupKey };
        };
        const before = make(0, "before");
        sku.assets.push(before);
        expect(() => assertVisualsReady(job, sku, [preset])).toThrow();
        const after = make(1, "after");
        sku.assets.push(after);
        expect(matchVisualSources(job, sku, preset, selection, 1, "")).toEqual([before, after]);
        expect(matchVisualSources(job, sku, preset, selection, 1, "", undefined, [after, before])).toEqual([before, after]);
        expect(() => matchVisualSources(job, sku, preset, selection, 1, "", undefined, [after])).toThrow();
        expect(() => matchVisualSources(job, sku, preset, selection, 1, "", undefined, [before, after, { ...before, id: "duplicate" }])).toThrow();
        expect(isFinalAsset(before)).toBe(false);
        expect(isFinalAsset(after)).toBe(false);
        sku.activeRevision = 2;
        sku.assets = sku.assets.map((asset) => ({ ...asset, id: asset.id + "-clone", revision: 2 }));
        expect(matchVisualSources(job, sku, preset, selection, 1, "")).toHaveLength(2);
        sku.assets[1].url = "changed-before";
        expect(() => matchVisualSources(job, sku, preset, selection, 1, "")).toThrow();
    });
    it.each(["materialDescription", "usageInstructions", "audience", "description"] as const)("invalidates v3 sources when adopted %s changes", (field) => {
        const { job, sku, preset } = visualFixture();
        job.visualPipelineVersion = 3;
        const initial = buildVisualPlan(job, sku, [preset])[0].fingerprint;
        sku.product[field] = "新采纳资料";
        expect(buildVisualPlan(job, sku, [preset])[0].fingerprint).not.toBe(initial);
    });
    it("does not invalidate visuals for taxonomy-only changes", () => {
        const { job, sku, preset } = visualFixture();
        job.visualPipelineVersion = 3;
        const initial = buildVisualPlan(job, sku, [preset])[0].fingerprint;
        sku.product.categoryPath = "Home > Storage";
        expect(buildVisualPlan(job, sku, [preset])[0].fingerprint).toBe(initial);
    });
    it("rejects incompatible paired visual modes and layouts during preflight", () => {
        const { job, sku, preset, selection } = visualFixture();
        job.visualPipelineVersion = 3;
        preset.generationStrategy = "paired-before-after";
        selection.visualMode = "white-layout";
        expect(visualPreflightErrors(job, sku, [preset]).join()).toContain("白底排版");
        expect(visualPreflightErrors(job, sku, [preset]).join()).toContain("before-after");
        selection.visualMode = "generate";
        selection.layout = "before-after";
        expect(visualPreflightErrors(job, sku, [preset])).toEqual([]);
    });
    it("keeps paired slots distinct for sequence, site and variant and ignores white-layout fallback", () => {
        const { job, sku, preset, selection } = visualFixture();
        job.visualPipelineVersion = 3;
        job.generationConfig.siteImageMode = "per-site";
        preset.generationStrategy = "paired-before-after";
        Object.assign(selection, { count: 2, variantScope: "custom", variantValues: ["red", "blue"], visualMode: "white-layout" });
        const plan = buildVisualPlan(job, sku, [preset]);
        expect(plan).toHaveLength(16);
        expect(new Set(plan.map((item) => item.key)).size).toBe(16);
        expect(plan.map((item) => item.comparisonRole)).toEqual(Array.from({ length: 8 }, () => ["before", "after"]).flat());
        expect(() => matchVisualSources(job, sku, preset, selection, 1, "red", "en-US")).toThrow();
    });
    it("generates a marketing-only requirement, never the legacy slot defaults", () => {
        const { job, sku, preset } = visualFixture();
        const plan = buildVisualPlan(job, sku, [preset]);
        expect(plan).toHaveLength(1);
        expect(plan[0].stage).toBe("marketing-base");
        expect(() => assertVisualsReady(job, sku, [preset])).toThrow("缺少对应场景");
    });
    it("does not fall back to counts when all selections are explicitly disabled", () => {
        const { job, sku, preset, selection } = visualFixture();
        selection.enabled = false;
        expect(buildVisualPlan(job, sku, [preset])).toEqual([]);
    });
    it("binds exact requirement, sequence, variant and site without modulo fallback", () => {
        const { job, sku, preset, selection } = visualFixture();
        selection.count = 2;
        selection.variantScope = "custom";
        selection.variantValues = ["红", "绿"];
        job.generationConfig.siteImageMode = "per-site";
        const bases = readyBases(job, sku, [preset]);
        expect(bases).toHaveLength(8);
        sku.assets.push(...bases);
        expect(matchVisualSource(job, sku, preset, selection, 2, "绿", "ms-MY").id).toBe("base-7");
        sku.assets.pop();
        expect(() => matchVisualSource(job, sku, preset, selection, 2, "绿", "ms-MY")).toThrow();
    });
    it("preserves bases for brand overlays but invalidates prompt/reference/product changes", () => {
        const { job, sku, preset, selection } = visualFixture();
        sku.assets.push(...readyBases(job, sku, [preset]));
        job.generationConfig.overlay.logo.placement = "off";
        expect(() => assertVisualsReady(job, sku, [preset])).not.toThrow();
        selection.promptOverride = "改成卧室";
        expect(() => assertVisualsReady(job, sku, [preset])).toThrow();
        delete selection.promptOverride;
        selection.referenceIds.push("new-ref");
        expect(() => assertVisualsReady(job, sku, [preset])).toThrow();
    });
    it("permits white layout only when explicit and white approved", () => {
        const { job, sku, preset, selection } = visualFixture();
        selection.visualMode = "white-layout";
        expect(buildVisualPlan(job, sku, [preset])).toHaveLength(0);
        expect(matchVisualSource(job, sku, preset, selection, 1, "").id).toBe("white");
        sku.approvals = [];
        expect(() => matchVisualSource(job, sku, preset, selection, 1, "")).toThrow("批准白底");
    });
    it("validates facts for no-text requirements too, and refuses unknown/empty rules", () => {
        const { job, sku, preset } = visualFixture();
        preset.stage = "detail";
        preset.requiredFacts = ["产品厚度"];
        expect(visualPreflightErrors(job, sku, [preset]).join()).toContain("产品厚度");
        sku.product.verifiedFacts["产品厚度"] = "8mm";
        expect(visualPreflightErrors(job, sku, [preset])).toEqual([]);
        preset.prompt = "无";
        expect(visualPreflightErrors(job, sku, [preset]).join()).toContain("画面要求");
        expect(visualPreflightErrors(job, sku, []).join()).toContain("找不到");
    });
    it("enforces preview lineage and excludes marketing bases from final totals", () => {
        const { job, sku, preset, white } = visualFixture();
        sku.assets.push(...readyBases(job, sku, [preset]));
        const preview: GeneratedAsset = { ...white, id: "preview", url: "preview.jpg", stage: "marketing-preview", requirementId: preset.id, templateId: preset.id, prompt: sku.copyZh[preset.id], sourceAssetIds: ["white"] };
        sku.assets.push(preview);
        expect(canApproveContent(job, sku, [preset])).toBe(false);
        preview.sourceAssetIds = ["base-0"];
        expect(canApproveContent(job, sku, [preset])).toBe(true);
        expect(marketingLineageErrors(job, sku, [preset], "marketing-preview")).toEqual([]);
        for (const locale of job.locales) {
            sku.localizedCopy[locale] = { [preset.id]: "Storage" };
            sku.assets.push({ ...preview, id: locale, url: locale + ".jpg", stage: "marketing", locale, prompt: "Storage" });
        }
        const checks = runDeterministicChecks(job, sku, { requirementPresets: [preset], rules: [], watermarkOpacityRange: [0.03, 0.3] } as never, undefined);
        expect(checks.filter((check) => check.ruleId === "system-asset-count")).toEqual([]);
    });
});
