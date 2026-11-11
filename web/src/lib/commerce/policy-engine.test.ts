import { describe, expect, it } from "vitest";

import { activeRules, canApproveContent, canExportSku, marketingLineageErrors, promptGuidance, retainManualDecisions, runDeterministicChecks } from "@/lib/commerce/policy-engine";
import { buildVisualPlan } from "@/lib/commerce/visual-plan";
import { createBuiltInPolicyPack, createDefaultBrand } from "@/lib/commerce/defaults";
import { DEFAULT_COMMERCE_GENERATION_CONFIG } from "@/lib/commerce/generation-config";
import type { CommerceJob, CommerceRequirementPreset, CommerceSku, GeneratedAsset, ProductRecord } from "@/types/commerce";

const product: ProductRecord = { id: "product", sku: "SKU-1", productType: "地毯", name: "测试地毯", brandName: "品牌", category: "地毯地垫类", audience: "家庭", description: "柔软防滑", size: "160×230cm", images: [], imageUrls: [], extraFields: {}, verifiedFacts: {}, factsConfirmed: false, imageStatus: "ready" };

function asset(index: number): GeneratedAsset {
    const locales = ["en-US", "th-TH", "vi-VN", "ms-MY", "fil-PH", "id-ID"] as const;
    if (index === 0) return { id: "a0", jobId: "job", skuId: "sku", stage: "main-white", sequence: 1, revision: 1, title: "白底", url: "blob:white", storageKey: "image:white", width: 1024, height: 1024, bytes: 200000, mimeType: "image/jpeg", createdAt: "2026-09-13T00:00:00.000Z" };
    if (index < 4) return { id: "a" + index, jobId: "job", skuId: "sku", stage: ["scene", "detail", "usage-size"][index - 1] as GeneratedAsset["stage"], sequence: 1, revision: 1, title: "无文字图", url: "blob:" + index, storageKey: "image:" + index, width: 1024, height: 1024, bytes: 200000, mimeType: "image/jpeg", createdAt: "2026-09-13T00:00:00.000Z" };
    const n = index - 4; const locale = locales[Math.floor(n / 3)]; const templateId = "t" + ((n % 3) + 1);
    return { id: "a" + index, jobId: "job", skuId: "sku", stage: "marketing", locale, templateId, sequence: 1, revision: 1, title: "营销图", url: "blob:" + index, storageKey: "image:" + index, width: 1024, height: 1024, bytes: 200000, mimeType: "image/jpeg", createdAt: "2026-09-13T00:00:00.000Z" };
}

function fixture() {
    const assets = [...Array.from({ length: 22 }, (_, index) => asset(index)), ...["t1", "t2", "t3"].map((templateId, index): GeneratedAsset => ({ id: "p" + index, jobId: "job", skuId: "sku", stage: "marketing-preview", templateId, sequence: 1, revision: 1, title: "中文预览", url: "blob:preview-" + index, storageKey: "image:preview-" + index, width: 1024, height: 1024, bytes: 200000, mimeType: "image/jpeg", prompt: "文案" + ["一", "二", "三"][index], createdAt: "2026-09-13T00:00:00.000Z" }))];
    const copy = Object.fromEntries(["en-US", "th-TH", "vi-VN", "ms-MY", "fil-PH", "id-ID"].map((locale) => [locale, { t1: "文案一", t2: "文案二", t3: "文案三" }]));
    const sku: CommerceSku = { id: "sku", product, stage: "ready", assets, selectedTemplateIds: ["t1", "t2", "t3"], requirementSelections: [], compositions: [], copyZh: { t1: "文案一", t2: "文案二", t3: "文案三" }, localizedCopy: copy, approvals: [], checks: [], activeRevision: 1 };
    const pack = createBuiltInPolicyPack();
    const job: CommerceJob = { id: "job", name: "任务", platform: "shopee", locales: ["en-US", "th-TH", "vi-VN", "ms-MY", "fil-PH", "id-ID"], generationConfig: DEFAULT_COMMERCE_GENERATION_CONFIG, policyPackId: pack.id, policyVersion: 1, skus: [sku], status: "ready", createdAt: "2026-09-13T00:00:00.000Z", updatedAt: "2026-09-13T00:00:00.000Z" };
    return { sku, job, pack };
}

describe("commerce policy engine", () => {
    it("filters manual rules and preserves only unchanged manually reviewed evidence", () => {
        const { job, sku, pack } = fixture();
        const rule = { id: "manual", title: "Manual", description: "", severity: "BLOCK" as const, priority: 1, countries: [], platforms: ["tiktok" as const], categories: [], locales: [], assetStages: [], phase: "post-render" as const, checker: "manual" as const, source: { fileName: "", sheet: "", range: "" } };
        pack.rules = [rule];
        expect(runDeterministicChecks(job, sku, pack, undefined).some((check) => check.ruleId === "manual")).toBe(false);
        job.platform = "tiktok";
        const checks = runDeterministicChecks(job, sku, pack, undefined);
        sku.checks = checks.map((check) => ({ ...check, reviewedAsFalsePositive: true }));
        expect(retainManualDecisions(checks, job, sku, pack).find((check) => check.ruleId === "manual")?.reviewedAsFalsePositive).toBe(true);
        const changed = checks.map((check) => ({ ...check, evidence: "changed" }));
        expect(retainManualDecisions(changed, job, sku, pack).some((check) => check.reviewedAsFalsePositive)).toBe(false);
        expect(retainManualDecisions(checks, job, sku, pack).filter((check) => check.ruleId !== "manual").some((check) => check.reviewedAsFalsePositive)).toBe(false);
    });
    it("uses siteLocale for site-specific imagery and all selected markets for shared guidance", () => {
        const { job, sku, pack } = fixture();
        job.locales = ["en-US", "th-TH"];
        pack.profiles = [
            { countryCode: "US", countryName: "US", locale: "en-US", audience: "", visualKeywords: "US-VISUAL", mainImageStyle: "", preferredColors: [], avoidedColors: [], modelPreference: "" },
            { countryCode: "TH", countryName: "TH", locale: "th-TH", audience: "", visualKeywords: "TH-VISUAL", mainImageStyle: "", preferredColors: [], avoidedColors: [], modelPreference: "" },
        ];
        pack.rules = ["en-US", "th-TH", "vi-VN"].map((locale) => ({ id: locale, title: locale, description: locale + "-RULE", severity: "GUIDE", priority: 1, countries: [], platforms: [], categories: [], locales: [locale as "en-US"], assetStages: [], phase: "prompt", checker: "manual", source: { fileName: "", sheet: "", range: "" } }));
        const shared = promptGuidance(pack, job, sku);
        expect(shared).toContain("US-VISUAL");
        expect(shared).toContain("TH-VISUAL");
        expect(shared).not.toContain("vi-VN-RULE");
        const thai = promptGuidance(pack, job, sku, "th-TH");
        expect(thai).not.toContain("en-US-RULE");
        expect(activeRules(pack, job, sku, { ...asset(1), siteLocale: "th-TH" }).map((rule) => rule.id)).toEqual(["th-TH"]);
    });
    it("accepts the migrated 22-asset default structure when font and copy are complete", () => {
        const { sku, job, pack } = fixture();
        const brand = { ...createDefaultBrand(), thaiFont: { name: "thai.ttf", family: "KodchiangUPC", dataUrl: "data:font/ttf;base64,AA==" } };
        const checks = runDeterministicChecks(job, sku, pack, brand);
        expect(checks.some((check) => check.severity === "BLOCK" && check.status === "violation")).toBe(false);
    });

    it("blocks missing Thai font and unresolved placeholders", () => {
        const { sku, job, pack } = fixture();
        sku.localizedCopy["th-TH"]!.t1 = "厚度 XXXmm";
        const checks = runDeterministicChecks(job, sku, pack, createDefaultBrand());
        expect(checks.some((check) => check.ruleId === "thai-font")).toBe(true);
        expect(checks.some((check) => check.ruleId === "system-placeholder")).toBe(true);
    });

    it("applies all selected-country rules to shared no-text scenes", () => {
        const { sku, job, pack } = fixture();
        const rules = activeRules(pack, job, sku, sku.assets.find((item) => item.stage === "scene"));
        expect(rules.some((rule) => rule.id === "builtin-id-redline")).toBe(true);
        expect(rules.some((rule) => rule.id === "builtin-th-redline")).toBe(true);
    });

    it("requires template variables and confirmed facts before content approval", () => {
        const { sku } = fixture();
        const templates = [requirement("t1", ["产品厚度"]), requirement("t2"), requirement("t3")];
        const { job } = fixture();
        sku.requirementSelections = templates.map((item) => ({ requirementId: item.id, enabled: true, count: 1, referenceIds: [], layout: item.layout, variantScope: "per-sku", variantValues: [], reviewed: true }));
        expect(canApproveContent(job, sku, templates)).toBe(false);
        sku.product = { ...sku.product, verifiedFacts: { 产品厚度: "8" }, factsConfirmed: true };
        expect(canApproveContent(job, sku, templates)).toBe(true);
        sku.copyZh.t1 = "修改后的文案";
        expect(canApproveContent(job, sku, templates)).toBe(false);
        sku.assets.find((item) => item.stage === "marketing-preview" && item.templateId === "t1")!.prompt = "修改后的文案";
        expect(canApproveContent(job, sku, templates)).toBe(true);
    });

    it("accepts a dynamic no-marketing structure", () => {
        const { sku, job, pack } = fixture();
        job.generationConfig = { ...DEFAULT_COMMERCE_GENERATION_CONFIG, assetCounts: { scene: 2, detail: 0, "usage-size": 0, "detail-white": 1 }, marketingEnabled: false };
        job.locales = ["en-US"];
        sku.selectedTemplateIds = [];
        sku.assets = [asset(0), { ...asset(1), sequence: 1 }, { ...asset(1), id: "scene-2", storageKey: "scene-2", url: "scene-2", sequence: 2 }, { ...asset(2), id: "detail-white", storageKey: "detail-white", url: "detail-white", stage: "detail-white", sequence: 1 }];
        const checks = runDeterministicChecks(job, sku, pack, createDefaultBrand());
        expect(checks.some((check) => check.severity === "BLOCK" && check.status === "violation")).toBe(false);
        expect(canApproveContent(job, sku, [])).toBe(true);
    });

    it("does not export unresolved block checks", () => {
        const { sku } = fixture();
        sku.checks = [{ id: "c", ruleId: "r", severity: "BLOCK", status: "uncertain", message: "待确认", checkedAt: "2026-09-13T00:00:00.000Z" }];
        expect(canExportSku(sku)).toBe(false);
        sku.checks[0].reviewedAsFalsePositive = true;
        expect(canExportSku(sku)).toBe(true);
    });
});

function requirement(id: string, requiredFacts: string[] = []): CommerceRequirementPreset { return { id, category: "地毯地垫类", order: Number(id.slice(1)), title: id, stage: "marketing", enabledByDefault: true, defaultCount: 1, prompt: id, layout: "feature-grid", chineseCopy: id, translationSeeds: {}, requiredFacts, referenceIds: [], variantScope: "per-sku", needsReview: false }; }

function pairedFixture() {
    const { job, sku, pack } = fixture();
    const preset: CommerceRequirementPreset = { ...requirement("t1"), layout: "before-after", generationStrategy: "paired-before-after" };
    job.visualPipelineVersion = 3;
    job.locales = ["en-US"];
    pack.requirementPresets = [preset];
    pack.rules = [];
    sku.assets = [asset(0)];
    sku.requirementSelections = [{ requirementId: preset.id, enabled: true, count: 1, referenceIds: [], variantScope: "per-sku", variantValues: [], reviewed: true }];
    sku.selectedTemplateIds = [preset.id];
    sku.approvals = (["white-background", "content"] as const).map((gate) => ({ gate, approved: true, reviewer: "user", reviewedAt: "now", assetRevision: 1 }));
    const sources: GeneratedAsset[] = [];
    for (const role of ["before", "after"] as const) {
        const item = buildVisualPlan(job, sku, [preset]).find((item) => item.comparisonRole === role)!;
        const source: GeneratedAsset = { ...asset(0), id: role, url: "blob:" + role, storageKey: role,
            stage: item.stage, requirementId: preset.id, visualKey: item.key, visualFingerprint: item.fingerprint,
            comparisonRole: role, comparisonGroupKey: item.comparisonGroupKey, variantKey: item.variantKey };
        sources.push(source);
        sku.assets.push(source);
    }
    for (const stage of ["marketing-preview", "marketing"] as const) {
        sku.assets.push({ ...asset(0), id: stage, url: "blob:" + stage, storageKey: stage, stage, requirementId: preset.id,
            templateId: preset.id, compositionId: stage, locale: stage === "marketing" ? "en-US" : undefined,
            prompt: sku.copyZh[preset.id], sourceAssetIds: sources.map((source) => source.id) });
        sku.compositions.push({ id: stage, jobId: job.id, skuId: sku.id, requirementId: preset.id,
            revision: 1, width: 1024, height: 1024, layout: "before-after", backgroundColor: "#fff", createdAt: "now", updatedAt: "now",
            layers: sources.map((source, index) => ({ id: stage + source.id, name: source.id, type: "background",
                sourceAssetId: source.id, comparisonRole: source.comparisonRole, content: source.url,
                x: index * 512, y: 96, width: 512, height: 512, visible: true, opacity: 1, rotation: 0, locked: false, zIndex: 10 + index })) });
    }
    return { job, sku, pack };
}

describe("paired composition policy gates", () => {
    it("allows a valid pair through approval and deterministic export checks", () => {
        const { job, sku, pack } = pairedFixture();
        expect(canApproveContent(job, sku, pack.requirementPresets)).toBe(true);
        expect(marketingLineageErrors(job, sku, pack.requirementPresets, "marketing")).toEqual([]);
        expect(runDeterministicChecks(job, sku, pack, undefined).filter((check) => check.severity === "BLOCK")).toEqual([]);
    });

    it.each(["hidden", "transparent", "offcanvas", "overlap", "wrong source", "missing", "old revision"])("blocks %s pair compositions at approval and export", (change) => {
        const { job, sku, pack } = pairedFixture();
        for (const composition of sku.compositions) {
            const layer = composition.layers[0];
            if (change === "hidden") layer.visible = false;
            if (change === "transparent") layer.opacity = 0;
            if (change === "offcanvas") layer.y = -2;
            if (change === "overlap") layer.x = 5;
            if (change === "wrong source") Object.assign(layer, { sourceAssetId: "unrelated-source" });
            if (change === "old revision") composition.revision = 0;
        }
        if (change === "missing") sku.compositions = [];
        expect(canApproveContent(job, sku, pack.requirementPresets)).toBe(false);
        expect(marketingLineageErrors(job, sku, pack.requirementPresets, "marketing-preview").length).toBeGreaterThan(0);
        expect(marketingLineageErrors(job, sku, pack.requirementPresets, "marketing").length).toBeGreaterThan(0);
        expect(runDeterministicChecks(job, sku, pack, undefined)).toEqual(expect.arrayContaining([
            expect.objectContaining({ ruleId: "system-visual-lineage", severity: "BLOCK", status: "violation" }),
        ]));
    });
});
