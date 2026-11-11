import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/localforage-storage", () => ({ localForageStorage: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined), removeItem: vi.fn(async () => undefined) } }));
import { createBuiltInPolicyPack, createDefaultBrand } from "@/lib/commerce/defaults";
import { createRequirementSelections, expectedAssetCount, normalizeGenerationConfig } from "@/lib/commerce/generation-config";
import { localForageStorage } from "@/lib/localforage-storage";
import type { CommerceJob, CommerceRequirementPreset, GeneratedAsset, LayeredComposition, ProductRecord } from "@/types/commerce";
import { useCommerceStore } from "./use-commerce-store";
import original40 from "@/lib/commerce/fixtures/aowei-visual-audit.json";
import { correctedPresetVisual } from "@/lib/commerce/requirement-visuals";

const preset = (id: string): CommerceRequirementPreset => ({ id, category: "通用", order: 1, title: id, stage: "marketing", enabledByDefault: true, defaultCount: 1, prompt: "场景", layout: "feature-grid", chineseCopy: "文案", translationSeeds: {}, requiredFacts: [], referenceIds: [], variantScope: "per-sku", needsReview: false, visualMode: "generate", visualKind: "scene" });
const oldPack = { ...createBuiltInPolicyPack(), id: "old", version: 1, requirementPresets: [preset("a"), preset("b")] };
const newPack = { ...oldPack, id: "new", version: 2, requirementPresets: oldPack.requirementPresets.map((item) => ({ ...item, layout: "multi-scene" as const })) };
const product: ProductRecord = { id: "p", sku: "SKU", name: "产品", productType: "", brandName: "", category: "通用", audience: "", description: "", size: "", images: [], imageUrls: [], extraFields: {}, verifiedFacts: {}, factsConfirmed: true, imageStatus: "ready" };
function current() { return useCommerceStore.getState().jobs[0]; }
function asset(id: string, stage: GeneratedAsset["stage"], requirementId?: string, sourceAssetIds?: string[]): GeneratedAsset {
    return { id, jobId: current().id, skuId: current().skus[0].id, stage, requirementId, sourceAssetIds, sequence: 1, revision: 1, title: id, url: id + ".jpg", width: 1024, height: 1024, bytes: 100, mimeType: "image/jpeg", createdAt: "2026-01-01" };
}
beforeEach(async () => {
    vi.stubGlobal("window", { __RUNTIME_CONFIG__: {} });
    // Historical v2 fixtures must not use createJob, which now creates v3 only.
    const fixture: CommerceJob = {
        id: "historical-v2", name: "test", visualPipelineVersion: 2, platform: "shopee", locales: ["en-US", "th-TH"],
        generationConfig: normalizeGenerationConfig(), policyPackId: oldPack.id, policyVersion: oldPack.version,
        status: "ready", createdAt: "2026-01-01", updatedAt: "2026-01-01",
        skus: [{ id: "historical-sku", product: structuredClone(product), stage: "draft", assets: [], selectedTemplateIds: ["a", "b"],
            requirementSelections: createRequirementSelections(oldPack.requirementPresets), compositions: [], copyZh: {}, localizedCopy: {}, approvals: [], checks: [], activeRevision: 1 }],
    };
    await useCommerceStore.setState({ hydrated: true, catalogStatus: { phase: "disabled" }, policyPacks: [structuredClone(oldPack)], brands: [createDefaultBrand()], jobs: [fixture], audit: [] });
    const job = current();
    useCommerceStore.getState().updateSku(job.id, job.skus[0].id, { assets: [asset("white", "main-white"), asset("base-a", "marketing-base", "a"), asset("render-a", "marketing", "a", ["base-a"]), asset("base-b", "marketing-base", "b"), asset("render-b", "marketing", "b", ["base-b"])], approvals: [{ gate: "white-background", approved: true, assetRevision: 1, reviewer: "owner", reviewedAt: "now" }, { gate: "content", approved: true, assetRevision: 1, reviewer: "owner", reviewedAt: "now" }], stage: "ready", copyZh: { a: "A", b: "B" } });
});
afterEach(() => vi.unstubAllGlobals());

describe("visual v2 store", () => {
    it("legacy upgrade clones known local original40 rules only on explicit action", () => {
        const local = { ...oldPack, id: "local-original40", version: 3, sourceFileName: "奥维斯美工需求.xlsx", requirementPresets: original40.map((preset) => ({ ...preset, translationSeeds: { "en-US": "preserved translation" } } as CommerceRequirementPreset)) };
        const before = structuredClone(local);
        const history = { ...current(), visualPipelineVersion: undefined, policyPackId: local.id, policyVersion: 3 };
        useCommerceStore.setState({ policyPacks: [local], jobs: [history] });
        expect(useCommerceStore.getState().policyPacks).toEqual([before]);
        useCommerceStore.getState().upgradeJobVisualPipeline(history.id);
        const state = useCommerceStore.getState();
        const corrected = state.policyPacks[0];
        expect(corrected).toMatchObject({ version: 4, status: "published", references: local.references, templates: local.templates, rules: local.rules });
        expect(corrected.id).not.toBe(local.id);
        expect(corrected.requirementPresets).toEqual(local.requirementPresets.map(correctedPresetVisual));
        expect(state.policyPacks[1]).toEqual({ ...before, status: "retired" });
        expect(local).toEqual(before);
        expect(current()).toMatchObject({ policyPackId: corrected.id, policyVersion: 4, visualPipelineVersion: 2 });
        expect(current().skus[0].assets.filter((asset) => asset.revision === 1)).toEqual(history.skus[0].assets);
        const upgraded = current();
        useCommerceStore.getState().upgradeJobVisualPipeline(history.id);
        expect(useCommerceStore.getState().policyPacks).toHaveLength(2);
        expect(current().policyPackId).toBe(corrected.id);
        expect(current()).toBe(upgraded);
    });
    it("prefers corrected published catalogs and leaves unrelated or partial local packs alone", () => {
        const local = { ...oldPack, id: "local40", version: 3, sourceFileName: "奥维斯美工需求.xlsx", requirementPresets: original40.map((preset) => ({ ...preset, translationSeeds: {} } as CommerceRequirementPreset)) };
        const corrected = { ...local, id: "server-corrected", version: 4, requirementPresets: local.requirementPresets.map(correctedPresetVisual) };
        const historical = { ...current(), visualPipelineVersion: undefined };
        useCommerceStore.setState({ policyPacks: [local, corrected], jobs: [historical] });
        useCommerceStore.getState().upgradeJobVisualPipeline(historical.id);
        expect(current().policyPackId).toBe(corrected.id);
        expect(useCommerceStore.getState().policyPacks).toEqual([local, corrected]);
        for (const unrecognized of [{ ...local, sourceFileName: "custom.xlsx" }, { ...local, requirementPresets: local.requirementPresets.slice(1) }]) {
            useCommerceStore.setState({ policyPacks: [unrecognized], jobs: [historical] });
            useCommerceStore.getState().upgradeJobVisualPipeline(historical.id);
            expect(useCommerceStore.getState().policyPacks).toEqual([unrecognized]);
            expect(current().policyVersion).toBe(3);
        }
    });
    it.each(["size", "format"] as const)("changing output %s starts an empty revision and preserves sources/history", (field) => {
        const job = current();
        const sku = job.skus[0];
        const composition: LayeredComposition = { id: "old-composition", assetId: "render-a", jobId: job.id, skuId: sku.id, requirementId: "a", revision: 1, width: 1024, height: 1024, backgroundColor: "white", layout: "single-hero", layers: [], createdAt: "now", updatedAt: "now" };
        const original = { id: "original", name: "source", url: "original.jpg", source: "upload" as const };
        useCommerceStore.getState().updateSku(job.id, sku.id, { compositions: [composition], canvasProjectId: "old-canvas", product: { ...sku.product, images: [original] } });
        const before = current().skus[0];
        const config = structuredClone(job.generationConfig);
        if (field === "size") config.outputSpec.size = 1600;
        else config.outputSpec.format = "png";
        useCommerceStore.getState().updateJobGenerationConfig(job.id, { locales: job.locales, generationConfig: config });
        const next = current().skus[0];
        expect(next).toMatchObject({ activeRevision: 2, stage: "draft", stageMessage: "输出规格变化，请重新生成/采用对应规格白底图", approvals: [], checks: [], copyZh: {}, localizedCopy: {} });
        expect(next.assets).toBe(before.assets);
        expect(next.compositions).toBe(before.compositions);
        expect(next.product).toBe(before.product);
        expect(next.assets.filter((item) => item.revision === next.activeRevision)).toEqual([]);
        expect(next.compositions.filter((item) => item.revision === next.activeRevision)).toEqual([]);
        expect(next.canvasProjectId).toBeUndefined();
        expect(current().status).toBe("draft");
        useCommerceStore.getState().updateJobGenerationConfig(job.id, { locales: job.locales, generationConfig: config });
        expect(current().skus[0].activeRevision).toBe(2);
    });
    it("delivery-only changes keep the active revision and approved white", () => {
        const job = current();
        const config = { ...job.generationConfig, delivery: "flattenedOnly" as const };
        useCommerceStore.getState().updateJobGenerationConfig(job.id, { locales: job.locales, generationConfig: config });
        const next = current().skus[0];
        expect(next.activeRevision).toBe(1);
        expect(next.assets.find((item) => item.stage === "main-white" && item.revision === 1)).toEqual(job.skus[0].assets[0]);
        expect(next.approvals.map((item) => item.gate)).toEqual(["white-background"]);
    });
    it("manual review preserves generated assets and copy while reopening content review", () => {
        const job = current();
        const sku = job.skus[0];
        useCommerceStore.getState().updateRequirementSelection(job.id, sku.id, "a", { reviewed: false });
        useCommerceStore.getState().updateRequirementSelection(job.id, sku.id, "a", { reviewed: true });
        const next = current().skus[0];
        expect(next.assets).toBe(sku.assets);
        expect(next.copyZh).toBe(sku.copyZh);
        expect(next.localizedCopy).toBe(sku.localizedCopy);
        expect(next.compositions).toBe(sku.compositions);
        expect(next.approvals.map((item) => item.gate)).toEqual(["white-background"]);
        expect(next.stage).toBe("content-review");
        expect(next.checks).toEqual([]);
    });
    it.each(["content-review", "ready"] as const)("fact edits unblock regeneration from %s without deleting sources", (stage) => {
        const job = current();
        useCommerceStore.getState().updateSku(job.id, job.skus[0].id, { stage });
        useCommerceStore.getState().updateSkuFacts(job.id, job.skus[0].id, { verifiedFacts: { 颜色: "蓝色、红色" }, factsConfirmed: false });
        expect(current().skus[0]).toMatchObject({ stage: "content-generation", checks: [], product: { verifiedFacts: { 颜色: "蓝色、红色" }, factsConfirmed: false } });
        expect(current().skus[0].assets).toBe(job.skus[0].assets);
        expect(current().skus[0].approvals.map((item) => item.gate)).toEqual(["white-background"]);
        useCommerceStore.getState().updateSkuFacts(job.id, job.skus[0].id, { factsConfirmed: true });
        expect(current().skus[0].stage).toBe("content-generation");
    });
    it("branding edits preserve unaffected and historical compositions", () => {
        const job = current();
        const sku = job.skus[0];
        const composition = (id: string, assetId: string, revision = 1): LayeredComposition => ({ id, assetId, jobId: job.id, skuId: sku.id, requirementId: "a", revision, width: 1024, height: 1024, backgroundColor: "white", layout: "single-hero", layers: [], createdAt: "now", updatedAt: "now" });
        const scene = { ...asset("scene", "scene", "s"), compositionId: "scene-composition" };
        useCommerceStore.getState().updateSku(job.id, sku.id, { assets: [...sku.assets, scene], compositions: [composition("scene-composition", "scene"), composition("marketing-composition", "render-a"), composition("historical", "old", 0)] });
        const config = structuredClone(job.generationConfig);
        config.overlay.logo.placement = "bottom-left";
        useCommerceStore.getState().updateJobGenerationConfig(job.id, { locales: job.locales, generationConfig: config });
        expect(current().skus[0].compositions.map((item) => item.id)).toEqual(["scene-composition", "historical"]);
    });
    it.each([2, 3] as const)("legacy upgrade does not alter an existing v%i job or its policy", (version) => {
        useCommerceStore.getState().updateJob(current().id, { visualPipelineVersion: version });
        const before = useCommerceStore.getState();
        useCommerceStore.getState().upgradeJobVisualPipeline(current().id);
        expect(useCommerceStore.getState().jobs).toBe(before.jobs);
        expect(useCommerceStore.getState().policyPacks).toBe(before.policyPacks);
    });
    it("rehydrates historical jobs without upgrading or clearing view/export data", async () => {
        const historical = { ...current(), visualPipelineVersion: undefined };
        vi.mocked(localForageStorage.getItem).mockResolvedValueOnce(JSON.stringify({ version: 3, state: { jobs: [historical], policyPacks: [oldPack, newPack] } }));
        await useCommerceStore.persist.rehydrate();
        expect(current()).toEqual(historical);
        expect(current().skus[0].stage).toBe("ready");
        expect(expectedAssetCount(current(), current().skus[0], oldPack.requirementPresets)).toBe(5);
    });
    it("explicitly upgrades into a new revision, preserving history and genuine overrides", () => {
        const job = current();
        const sku = job.skus[0];
        const selections = createRequirementSelections(oldPack.requirementPresets);
        selections[1] = { ...selections[1], layout: "single-hero", count: 2, promptOverride: "用户要求", visualMode: "white-layout", siteLocales: ["th-TH"] };
        useCommerceStore.getState().updateJob(job.id, { visualPipelineVersion: undefined });
        useCommerceStore.getState().updateSku(job.id, sku.id, { requirementSelections: selections });
        useCommerceStore.setState({ policyPacks: [oldPack, newPack] });
        useCommerceStore.getState().upgradeJobVisualPipeline(job.id);
        const upgraded = current();
        const next = upgraded.skus[0];
        expect(upgraded).toMatchObject({ visualPipelineVersion: 2, policyPackId: "new", policyVersion: 2, generationConfig: job.generationConfig });
        expect(next).toMatchObject({ activeRevision: 2, stage: "white-review", approvals: [], checks: [], copyZh: {}, localizedCopy: {} });
        expect(next.assets.filter((item) => item.revision === 1)).toEqual(sku.assets);
        expect(next.assets.filter((item) => item.revision === 2)).toHaveLength(1);
        expect(next.assets.at(-1)).toMatchObject({ stage: "main-white", url: "white.jpg" });
        expect(next.requirementSelections[0].layout).toBe("multi-scene");
        expect(next.requirementSelections[1]).toMatchObject({ layout: "single-hero", count: 2, promptOverride: "用户要求", visualMode: "white-layout" });
        expect(expectedAssetCount(upgraded, next, newPack.requirementPresets)).toBe(5);
        useCommerceStore.getState().upgradeJobVisualPipeline(job.id);
        expect(current()).toBe(upgraded);
    });
    it("invalidates changed requirements and derived assets while retaining unrelated results", () => {
        const job = current();
        useCommerceStore.getState().updateRequirementSelection(job.id, job.skus[0].id, "a", { count: 2 });
        const sku = current().skus[0];
        expect(sku.assets.map((item) => item.id)).toEqual(["white", "base-b", "render-b"]);
        expect(sku.copyZh).toEqual({ b: "B" });
        expect(sku.approvals.map((item) => item.gate)).toEqual(["white-background"]);
        expect(sku.stage).toBe("content-generation");
    });
    it("keeps bases for overlays but invalidates them for changed scene inputs", () => {
        const job = current();
        const config = structuredClone(job.generationConfig);
        config.overlay.logo.applyTo = "all";
        config.overlay.watermark.opacity = 0.2;
        useCommerceStore.getState().updateJobGenerationConfig(job.id, { locales: job.locales, generationConfig: config });
        expect(current().skus[0].assets.map((item) => item.id)).toEqual(["white", "base-a", "base-b"]);
        useCommerceStore.getState().updateJobGenerationConfig(job.id, { locales: ["en-US"], generationConfig: config });
        expect(current().skus[0].assets.map((item) => item.id)).toEqual(["white"]);
    });
});
