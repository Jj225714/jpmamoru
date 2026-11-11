import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/localforage-storage", () => ({ localForageStorage: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined), removeItem: vi.fn(async () => undefined) } }));

import { createBuiltInPolicyPack, createDefaultBrand } from "@/lib/commerce/defaults";
import { createCreativeRequirementPresets } from "@/lib/commerce/creative-presets";
import { createRequirementSelections, expectedAssetCount, normalizeGenerationConfig } from "@/lib/commerce/generation-config";
import { productSuggestionFingerprint } from "@/lib/commerce/product-suggestions";
import type { CommerceJob, CommerceProductSuggestion, CommerceSku, GeneratedAsset, LayeredComposition, PolicyPack, ProductRecord } from "@/types/commerce";
import original40 from "@/lib/commerce/fixtures/aowei-visual-audit.json";
import { useCommerceStore } from "./use-commerce-store";

const categories = ["地毯地垫类", "桌垫类", "洞洞板类", "收纳筐类"];
const request = vi.fn(async () => { throw new Error("Store actions must not make network requests"); });
const product: ProductRecord = {
    id: "product", sku: "SKU", name: "Original name", productType: "custom-type", brandName: "Custom brand", category: "地毯地垫类",
    audience: "", description: "Original description", size: "", images: [{ id: "upload", name: "original", url: "original.jpg", source: "upload" }], imageUrls: [],
    extraFields: { custom: "preserve" }, verifiedFacts: { 颜色: "米色" }, factsConfirmed: false, imageStatus: "ready",
};

function current(id?: string) { return id ? useCommerceStore.getState().jobs.find((job) => job.id === id)! : useCommerceStore.getState().jobs[0]; }
function create(products = [structuredClone(product)]) { return useCommerceStore.getState().createJob({ name: "Creative", products, locales: ["en-US", "th-TH"] }); }
function sourcePack(): PolicyPack {
    return {
        ...createBuiltInPolicyPack(), id: "old40", version: 3, sourceFileName: "奥维斯美工需求.xlsx",
        requirementPresets: original40.map((item) => ({ ...item, translationSeeds: { "en-US": "Custom translation" } })) as PolicyPack["requirementPresets"],
        globalStandards: ["Custom global standard"], generationDefaults: { creativeBrief: { lighting: "warm-indoor" } },
        references: [{ id: "custom-ref", name: "Reference", url: "reference.jpg", source: "rule-reference", sheet: "Custom", anchor: "A1", kind: "reference" }],
        siteReferences: [{ id: "site-ref", product: "SKU", locale: "th-TH", note: "Custom site note", referenceIds: ["custom-ref"] }],
        editSummary: ["Owner customized country rules"], watermarkOpacityRange: [0.04, 0.2],
    };
}
function asset(job: CommerceJob, sku: CommerceSku, id: string, stage: GeneratedAsset["stage"], requirementId?: string, revision = sku.activeRevision): GeneratedAsset {
    return { id, jobId: job.id, skuId: sku.id, stage, requirementId, sequence: 1, revision, title: id, url: id + ".jpg", width: 1024, height: 1024, bytes: 100, mimeType: "image/jpeg", createdAt: "2026-01-01" };
}
function composition(job: CommerceJob, sku: CommerceSku, id: string, requirementId: string, assetId: string, revision = sku.activeRevision): LayeredComposition {
    return { id, jobId: job.id, skuId: sku.id, assetId, requirementId, revision, width: 1024, height: 1024, backgroundColor: "white", layout: "single-hero", layers: [], createdAt: "then", updatedAt: "then" };
}
function withOutputs(job: CommerceJob): CommerceJob {
    const sku = job.skus[0];
    const a = sku.requirementSelections[0].requirementId;
    const b = sku.requirementSelections[1].requirementId;
    return { ...job, status: "ready", skus: [{ ...sku, stage: "ready", canvasProjectId: "old-canvas",
        assets: [asset(job, sku, "white", "main-white"), asset(job, sku, "source-a", "comparison-source", a),
            { ...asset(job, sku, "render-a", "marketing", a), sourceAssetIds: ["source-a"] },
            { ...asset(job, sku, "downstream", "marketing-preview", "derived"), sourceAssetIds: ["render-a"] },
            asset(job, sku, "scene-b", "scene", b), asset(job, sku, "history", "marketing", a, 0)],
        compositions: [composition(job, sku, "composition-a", a, "render-a"), composition(job, sku, "composition-derived", "derived", "downstream"), composition(job, sku, "composition-b", b, "scene-b"), composition(job, sku, "history-composition", a, "history", 0)],
        copyZh: { [a]: "A", [b]: "B", derived: "D" }, localizedCopy: { "en-US": { [a]: "A en", [b]: "B en", derived: "D en" } },
        approvals: [{ gate: "white-background", approved: true, assetRevision: sku.activeRevision, reviewer: "owner", reviewedAt: "then" }, { gate: "content", approved: true, assetRevision: sku.activeRevision, reviewer: "owner", reviewedAt: "then" }],
        checks: [{ id: "check", ruleId: "rule", severity: "GUIDE", status: "pass", message: "Reviewed", checkedAt: "then" }],
    }, ...job.skus.slice(1)] };
}
function seedOutputs() {
    const job = withOutputs(current(create()));
    useCommerceStore.setState({ jobs: [job] });
    return job;
}
function draft(sku: CommerceSku): CommerceProductSuggestion {
    return { information: { name: "Suggested name", audience: "Home users", sellingPoints: "Suggested description", material: "Cotton", usage: "Lay flat", category: "Home > Rugs" }, uncertainties: ["Thickness needs confirmation"], sourceFingerprint: productSuggestionFingerprint(sku.product), createdAt: "2026-09-17" };
}

beforeEach(() => {
    request.mockClear();
    vi.stubGlobal("fetch", request);
    vi.stubGlobal("window", { __RUNTIME_CONFIG__: {} });
    useCommerceStore.setState({ hydrated: true, catalogStatus: { phase: "disabled" }, policyPacks: [sourcePack()], brands: [createDefaultBrand()], jobs: [], audit: [] });
});
afterEach(() => {
    expect(request).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
});

describe("creative v3 job creation", () => {
    it("creates a new 32-recipe policy without mutating old packs, jobs, products or brand defaults", () => {
        const state = useCommerceStore.getState();
        const source = state.policyPacks[0];
        const input = categories.map((category) => ({ ...structuredClone(product), id: category, category }));
        const snapshot = structuredClone({ source, brands: state.brands, input });
        const id = create(input);
        const job = current(id);
        const pack = useCommerceStore.getState().policyPacks.find((item) => item.id === job.policyPackId)!;
        expect(job).toMatchObject({ visualPipelineVersion: 3, policyVersion: pack.version, status: "draft" });
        expect(pack).toMatchObject({ creativeLibraryVersion: 1, status: "published" });
        expect(pack.version).toBeGreaterThan(source.version);
        expect(pack.id).not.toBe(source.id);
        expect(pack.requirementPresets).toHaveLength(32);
        expect(new Set(pack.requirementPresets.map((item) => item.id)).size).toBe(32);
        for (const sku of job.skus) {
            expect(pack.requirementPresets.filter((item) => item.category === sku.product.category)).toHaveLength(8);
            expect(sku.requirementSelections).toHaveLength(8);
            expect(sku.requirementSelections.map((item) => item.enabled)).toEqual([true, true, true, true, false, false, false, false]);
            expect(sku.requirementSelections.every((item) => item.count === 1)).toBe(true);
            expect(sku.selectedTemplateIds).toHaveLength(1);
            expect(sku).toMatchObject({ assets: [], compositions: [], approvals: [], checks: [], activeRevision: 1 });
            expect(expectedAssetCount(job, sku, pack.requirementPresets)).toBe(6);
        }
        expect(useCommerceStore.getState().policyPacks.find((item) => item.id === source.id)).toBe(source);
        expect({ source, brands: state.brands, input }).toEqual(snapshot);
        expect(job.skus[0].product).not.toBe(input[0]);
        const second = create();
        expect(current(second).policyPackId).toBe(pack.id);
        expect(useCommerceStore.getState().policyPacks).toHaveLength(2);
        expect(current(id)).toBe(job);
    });

    it("clones the newest published source's country rules, references and custom settings", () => {
        const old = useCommerceStore.getState().policyPacks[0];
        const latest = { ...structuredClone(old), id: "latest", version: 9 };
        latest.rules[0].description = "Owner country restriction";
        latest.profiles[0].visualKeywords = "Owner visual preference";
        const newerDraft = { ...structuredClone(latest), id: "draft", version: 20, status: "draft" as const };
        useCommerceStore.setState({ policyPacks: [old, newerDraft, latest] });
        const snapshot = structuredClone(useCommerceStore.getState().policyPacks);
        const job = current(create());
        const pack = useCommerceStore.getState().policyPacks[0];
        expect(job.policyPackId).toBe(pack.id);
        for (const key of ["rules", "profiles", "references", "siteReferences", "globalStandards", "generationDefaults", "watermarkOpacityRange", "editSummary"] as const) {
            expect(pack[key]).toEqual(latest[key]);
            expect(pack[key]).not.toBe(latest[key]);
        }
        expect(useCommerceStore.getState().policyPacks.slice(1)).toEqual(snapshot);
        expect(pack.requirementPresets).toEqual(createCreativeRequirementPresets());
        expect(pack.templates.map((item) => item.id)).toEqual(pack.requirementPresets.filter((item) => item.stage === "marketing").map((item) => item.id));
    });

    it("reuses an existing creative policy and preserves explicit inherited brand overrides", () => {
        const presets = createCreativeRequirementPresets();
        const older = { ...sourcePack(), id: "older-creative", version: 5, creativeLibraryVersion: 1 as const, requirementPresets: presets };
        const latest = { ...structuredClone(older), id: "latest-creative", version: 6 };
        latest.requirementPresets[0] = { ...latest.requirementPresets[0], layout: "multi-scene", visualKind: "detail", variantScope: "per-color" };
        const defaults = createRequirementSelections(presets.filter((item) => item.category === product.category));
        defaults[0] = { ...defaults[0], visualMode: "white-layout" };
        defaults[1] = { ...defaults[1], layout: "feature-grid", visualKind: "detail-white", variantScope: "custom", variantValues: ["custom"], creativeBrief: { scene: "Custom studio" } };
        const brand = { ...createDefaultBrand(), requirementDefaultsByCategory: { [product.category]: defaults } };
        const snapshot = structuredClone(brand);
        useCommerceStore.setState({ policyPacks: [older, latest], brands: [brand] });
        const job = current(create());
        expect(job).toMatchObject({ visualPipelineVersion: 3, policyPackId: latest.id, policyVersion: 6 });
        expect(useCommerceStore.getState().policyPacks).toEqual([older, latest]);
        expect(job.skus[0].requirementSelections[0]).toMatchObject({ layout: "multi-scene", visualKind: "detail", variantScope: "per-color", visualMode: "white-layout" });
        expect(job.skus[0].requirementSelections[1]).toMatchObject({ layout: "feature-grid", visualKind: "detail-white", variantScope: "custom", variantValues: ["custom"], creativeBrief: { scene: "Custom studio" } });
        expect(useCommerceStore.getState().brands[0]).toBe(brand);
        expect(brand).toEqual(snapshot);
    });

    it.each(["unsupported-category", "", " "])("rejects unsupported internal category %j atomically", (category) => {
        const before = useCommerceStore.getState();
        expect(() => create([{ ...product, category }])).toThrow("没有可用推荐方案");
        expect(useCommerceStore.getState().jobs).toBe(before.jobs);
        expect(useCommerceStore.getState().policyPacks).toBe(before.policyPacks);
    });
});

describe("explicit creative copies", () => {
    function historical() {
        const pack = useCommerceStore.getState().policyPacks[0];
        const job: CommerceJob = { id: "historical-v2", name: "Original", visualPipelineVersion: 2, platform: "tiktok", locales: ["th-TH", "en-US"], generationConfig: normalizeGenerationConfig({ creativeBrief: { scene: "Custom room" } }), policyPackId: pack.id, policyVersion: pack.version, status: "ready", createdAt: "then", updatedAt: "then",
            skus: [{ id: "old-sku", product: structuredClone(product), stage: "ready", assets: [], requirementSelections: createRequirementSelections(pack.requirementPresets.filter((item) => item.category === product.category)), selectedTemplateIds: ["legacy-custom"], compositions: [], copyZh: {}, localizedCopy: {}, approvals: [], checks: [], activeRevision: 3 }] };
        const filled = withOutputs(job);
        filled.skus[0].requirementSelections[0] = { ...filled.skus[0].requirementSelections[0], enabled: false, count: 4, promptOverride: "Legacy custom prompt" };
        useCommerceStore.setState({ jobs: [filled] });
        return filled;
    }

    it("preserves every original field and creates fresh recipe defaults with only eligible white pending review", () => {
        const original = historical();
        const snapshot = structuredClone(original);
        const oldPack = useCommerceStore.getState().policyPacks[0];
        const id = useCommerceStore.getState().createCreativeJobCopy(original.id);
        const copy = current(id);
        const sku = copy.skus[0];
        expect(current(original.id)).toBe(original);
        expect(original).toEqual(snapshot);
        expect(useCommerceStore.getState().policyPacks.find((item) => item.id === oldPack.id)).toBe(oldPack);
        expect(copy.id).not.toBe(original.id);
        expect(sku.id).not.toBe(original.skus[0].id);
        expect(copy).toMatchObject({ visualPipelineVersion: 3, platform: original.platform, locales: original.locales, generationConfig: original.generationConfig, status: "waiting-review" });
        expect(sku.product).toEqual(original.skus[0].product);
        expect(sku.product).not.toBe(original.skus[0].product);
        expect(sku.requirementSelections).toEqual(createRequirementSelections(createCreativeRequirementPresets().filter((item) => item.category === product.category)));
        expect(sku).toMatchObject({ stage: "white-review", activeRevision: 1, approvals: [], checks: [], compositions: [], copyZh: {}, localizedCopy: {} });
        expect(sku.canvasProjectId).toBeUndefined();
        expect(sku.assets).toHaveLength(1);
        expect(sku.assets[0]).toMatchObject({ stage: "main-white", jobId: id, skuId: sku.id, revision: 1, url: "white.jpg", sourceAssetIds: ["white"] });
        expect(sku.assets[0].id).not.toBe("white");
        expect(sku.assets[0].visualFingerprint).toBeUndefined();
    });

    it.each([
        ["old revision", { revision: 2 }], ["width", { width: 800 }], ["height", { height: 800 }],
        ["format", { mimeType: "image/png" }], ["byte limit", { bytes: 3 * 1024 * 1024 }],
    ] as const)("does not reuse a white image with incompatible %s", (_reason, patch) => {
        const original = historical();
        original.skus[0].assets[0] = { ...original.skus[0].assets[0], ...patch };
        const snapshot = structuredClone(original);
        const copy = current(useCommerceStore.getState().createCreativeJobCopy(original.id));
        expect(copy.skus[0]).toMatchObject({ stage: "draft", assets: [], approvals: [] });
        expect(original).toEqual(snapshot);
    });
});

describe("suggestion drafts and explicit adoption", () => {
    it("saves an isolated draft without changing product inputs, assets, approvals or downstream state", () => {
        const job = seedOutputs();
        const sku = job.skus[0];
        const suggestion = draft(sku);
        const before = structuredClone(sku);
        useCommerceStore.getState().saveProductSuggestion(job.id, sku.id, suggestion);
        const next = current().skus[0];
        expect(next).toEqual({ ...before, product: { ...before.product, informationSuggestion: suggestion } });
        expect(next.assets).toBe(sku.assets);
        expect(next.approvals).toBe(sku.approvals);
        expect(current().status).toBe(job.status);
        suggestion.information.name = "Mutated draft";
        expect(next.product.informationSuggestion?.information.name).toBe("Suggested name");
    });

    it("fills only selected blank fields without overwriting known values or certifying facts", () => {
        const job = seedOutputs();
        const sku = job.skus[0];
        useCommerceStore.getState().applyProductSuggestion(job.id, sku.id, draft(sku), ["name", "audience", "material"], false);
        const next = current().skus[0].product;
        expect(next).toEqual({ ...sku.product, audience: "Home users", materialDescription: "Cotton" });
        expect(next.categoryPath).toBeUndefined();
        expect(next.category).toBe(product.category);
        expect(next.factsConfirmed).toBe(false);
        expect(next.verifiedFacts).toEqual(product.verifiedFacts);
        expect(next.usageInstructions).toBeUndefined();
    });

    it("adopts taxonomy only when selected, into categoryPath, preserving internal category and visual results", () => {
        const job = seedOutputs();
        const sku = job.skus[0];
        useCommerceStore.getState().applyProductSuggestion(job.id, sku.id, draft(sku), ["category"], false);
        const next = current().skus[0];
        expect(next.product).toEqual({ ...sku.product, categoryPath: "Home > Rugs" });
        expect(next.assets).toBe(sku.assets);
        expect(next.approvals).toBe(sku.approvals);
        expect(next.requirementSelections).toBe(sku.requirementSelections);
    });

    it("leaves visuals approved when selected existing fields are not explicitly replaced", () => {
        const job = seedOutputs();
        const sku = job.skus[0];
        useCommerceStore.getState().applyProductSuggestion(job.id, sku.id, draft(sku), ["name", "sellingPoints"], false);
        expect(current().skus[0]).toEqual(sku);
        expect(current().skus[0].assets).toBe(sku.assets);
        expect(current().skus[0].approvals).toBe(sku.approvals);
    });

    it("explicit replacement clears active nonwhite sources and downstream state while preserving white and history", () => {
        const job = seedOutputs();
        const sku = job.skus[0];
        useCommerceStore.getState().applyProductSuggestion(job.id, sku.id, draft(sku), ["name", "sellingPoints"], true);
        const next = current().skus[0];
        expect(next.product).toEqual({ ...sku.product, name: "Suggested name", description: "Suggested description" });
        expect(next.assets.map((item) => item.id)).toEqual(["white", "history"]);
        expect(next.compositions.map((item) => item.id)).toEqual(["history-composition"]);
        expect(next).toMatchObject({ stage: "content-generation", copyZh: {}, localizedCopy: {}, checks: [], activeRevision: sku.activeRevision });
        expect(next.approvals).toEqual([sku.approvals[0]]);
        expect(sku.assets).toHaveLength(6);
    });

    it.each([
        ["save", "image"], ["apply", "image"], ["save", "name"], ["apply", "name"],
    ] as const)("rejects stale %s atomically after %s changes", (action, field) => {
        const job = seedOutputs();
        const sku = job.skus[0];
        const suggestion = draft(sku);
        const changedProduct = field === "image" ? { ...sku.product, images: [{ ...sku.product.images[0], url: "new-image.jpg" }] } : { ...sku.product, name: "Edited name" };
        useCommerceStore.getState().updateSku(job.id, sku.id, { product: changedProduct });
        const before = useCommerceStore.getState();
        const snapshot = structuredClone(before.jobs);
        expect(() => action === "save" ? before.saveProductSuggestion(job.id, sku.id, suggestion) : before.applyProductSuggestion(job.id, sku.id, suggestion, ["name"], true)).toThrow(/变化|改变/);
        expect(useCommerceStore.getState().jobs).toBe(before.jobs);
        expect(useCommerceStore.getState().jobs).toEqual(snapshot);
    });
});

describe("creative brief invalidation", () => {
    it("global brief changes clear active visuals but preserve white, history and approved white", () => {
        const job = seedOutputs();
        const config = { ...job.generationConfig, creativeBrief: { ...job.generationConfig.creativeBrief, scene: "New room" } };
        useCommerceStore.getState().updateJobGenerationConfig(job.id, { locales: job.locales, generationConfig: config });
        const sku = current().skus[0];
        expect(sku.assets.map((item) => item.id)).toEqual(["white", "history"]);
        expect(sku.compositions.map((item) => item.id)).toEqual(["history-composition"]);
        expect(sku).toMatchObject({ stage: "content-generation", copyZh: {}, localizedCopy: {}, checks: [], activeRevision: 1 });
        expect(sku.approvals).toEqual([job.skus[0].approvals[0]]);
        useCommerceStore.getState().updateJobGenerationConfig(job.id, { locales: job.locales, generationConfig: config });
        expect(current().skus[0]).toBe(sku);
    });

    it("per-recipe brief changes invalidate only that recipe and its transitive descendants", () => {
        const job = seedOutputs();
        const sku = job.skus[0];
        const a = sku.requirementSelections[0].requirementId;
        const b = sku.requirementSelections[1].requirementId;
        useCommerceStore.getState().updateRequirementSelection(job.id, sku.id, a, { creativeBrief: { scene: "New room" } });
        const next = current().skus[0];
        expect(next.assets.map((item) => item.id)).toEqual(["white", "scene-b", "history"]);
        expect(next.compositions.map((item) => item.id)).toEqual(["composition-b", "history-composition"]);
        expect(next.copyZh).toEqual({ [b]: "B" });
        expect(next.localizedCopy).toEqual({ "en-US": { [b]: "B en" } });
        expect(next.approvals).toEqual([sku.approvals[0]]);
        expect(next.stage).toBe("content-generation");
        expect(next.requirementSelections[1]).toBe(sku.requirementSelections[1]);
        expect(next.requirementSelections[0].creativeBrief).toEqual({ scene: "New room" });
    });
});
