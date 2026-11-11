import { describe, expect, it, vi } from "vitest";
vi.mock("@/services/image-storage", () => ({ imageToDataUrl: vi.fn() }));
import { createBuiltInPolicyPack } from "./defaults";
import { cloneGenerationConfig, DEFAULT_COMMERCE_GENERATION_CONFIG } from "./generation-config";
import { detailSourceImages } from "./detail-sources";
import { generationReferences, categorySelectionErrors } from "./generation-inputs";
import { preflightGenerationInputs } from "./generation-preflight";
import { buildVisualPlan } from "./visual-plan";
import { invalidateCategoryInputs } from "./category-input-state";
import type { CommerceJob, CommerceSku, CommerceRequirementPreset, RequirementSelection } from "@/types/commerce";

function fixture() {
    const pack = createBuiltInPolicyPack();
    const preset: CommerceRequirementPreset = {
        id: "back",
        category: "垫",
        order: 1,
        title: "背面",
        stage: "detail",
        enabledByDefault: true,
        defaultCount: 1,
        prompt: "背面实拍",
        layout: "single-hero",
        chineseCopy: "",
        translationSeeds: {},
        requiredFacts: [],
        referenceIds: [],
        variantScope: "per-sku",
        needsReview: false,
        detailPurpose: "back",
    };
    pack.requirementPresets = [preset];
    pack.categories = [{ id: "mat", name: "垫", aliases: [], active: true, order: 0, rules: [], referenceIds: [], requirementIds: [preset.id] }];
    const selection: RequirementSelection = {
        requirementId: preset.id,
        enabled: true,
        count: 1,
        referenceIds: [],
        variantScope: "per-sku",
        variantValues: [],
        sourceImageIds: ["back-photo"],
        primaryImageId: "back-photo",
        detailPurpose: "back",
        detailRenderMode: "optimize",
    };
    const sku: CommerceSku = {
        id: "s",
        product: {
            id: "p",
            sku: "S",
            productType: "垫",
            name: "商品",
            brandName: "",
            category: "垫",
            categoryId: "mat",
            audience: "",
            description: "",
            size: "",
            images: [{ id: "front", name: "正面", url: "front", source: "upload" }],
            imageUrls: [],
            extraFields: {},
            verifiedFacts: {},
            factsConfirmed: true,
            imageStatus: "ready",
            detailImages: [{ id: "back-photo", name: "背面", url: "back", source: "upload", purposes: ["back"], variantKey: "", shared: false, contentHash: "hash-back" }],
        },
        stage: "content-generation",
        assets: [],
        compositions: [],
        approvals: [],
        checks: [],
        activeRevision: 1,
        requirementSelections: [selection],
        selectedTemplateIds: [],
        copyZh: {},
        localizedCopy: {},
    };
    const job: CommerceJob = {
        id: "j",
        name: "test",
        platform: "shopee",
        locales: ["en-US"],
        generationConfig: cloneGenerationConfig(DEFAULT_COMMERCE_GENERATION_CONFIG),
        policyPackId: pack.id,
        policyVersion: pack.version,
        visualPipelineVersion: 3,
        skus: [sku],
        status: "draft",
        createdAt: "",
        updatedAt: "",
    };
    job.generationConfig.marketingEnabled = false;
    return { pack, preset, selection, sku, job };
}

describe("independent detail sources", () => {
    it("uses only back photographs, never the white front or category example", () => {
        const { pack, sku, preset, selection } = fixture();
        expect(generationReferences(pack, sku, preset, selection, "", { id: "white", name: "白底", url: "white", source: "generated" }).map((ref) => ref.id)).toEqual(["back-photo"]);
    });
    it("rejects missing purpose, primary, generated sources and variant mismatch", () => {
        const { sku, preset, selection } = fixture();
        expect(() => detailSourceImages(sku, preset, { ...selection, primaryImageId: undefined })).toThrow("主参考图");
        expect(() => detailSourceImages(sku, preset, { ...selection, detailPurpose: "edge" })).toThrow("包边");
        expect(() => detailSourceImages(sku, preset, selection, "蓝色")).toThrow("对应细节实拍");
        sku.product.detailImages![0].source = "generated";
        expect(() => detailSourceImages(sku, preset, selection)).toThrow("真实商品照片");
    });
    it("allows explicit shared sources and per-variant primaries, not implicit reuse", () => {
        const { sku, preset, selection } = fixture();
        sku.product.detailImages![0].shared = true;
        expect(detailSourceImages(sku, preset, selection, "蓝色")).toHaveLength(1);
        expect(() => detailSourceImages(sku, preset, { ...selection, detailRenderMode: "original", count: 2 })).toThrow("只能输出一张");
    });
    it("decodes all bound media before returning and rejects missing inputs before any reads", async () => {
        const { pack, sku, job, selection } = fixture();
        const read = vi.fn().mockResolvedValue({ dataUrl: "data:back", contentHash: "hash-back", mimeType: "image/jpeg" });
        expect((await preflightGenerationInputs(job, sku, pack, read)).size).toBe(2);
        selection.sourceImageIds = [];
        read.mockClear();
        await expect(preflightGenerationInputs(job, sku, pack, read)).rejects.toThrow("缺少背面实拍");
        expect(read).not.toHaveBeenCalled();
    });
    it("propagates unreadable media failure and rejects conflicting required people", async () => {
        const { pack, sku, job, selection, preset } = fixture();
        await expect(
            preflightGenerationInputs(job, sku, pack, async () => {
                throw new Error("无法解码");
            }),
        ).rejects.toThrow("无法解码");
        pack.categories![0].rules = [{ id: "people", text: "需要手部", key: "people", value: "adult-partial", strength: "required", stages: ["scene"] }];
        preset.stage = "scene";
        selection.creativeBrief = { people: "none" };
        expect(categorySelectionErrors(pack, job, sku, preset, selection).join()).not.toContain("人物设置");
    });
    it("checks image capacity before decoding and the aggregate request size before generation", async () => {
        const { pack, sku, job, preset } = fixture();
        const read = vi.fn().mockResolvedValue({ dataUrl: "data:large", contentHash: "hash", mimeType: "image/jpeg", bytes: 65 * 1024 * 1024 });
        await expect(preflightGenerationInputs(job, sku, pack, read)).rejects.toThrow("合计超过64MB");
        preset.stage = "scene";
        sku.product.images = Array.from({ length: 16 }, (_, i) => ({ id: `p${i}`, name: `photo${i}`, url: "photo", source: "upload" }));
        read.mockClear();
        await expect(preflightGenerationInputs(job, sku, pack, read)).rejects.toThrow("参考图过多");
        expect(read).not.toHaveBeenCalled();
    });
    it("fingerprints bound detail content but ignores unrelated photos and front white", () => {
        const { sku, job, pack } = fixture();
        const before = buildVisualPlan(job, sku, pack.requirementPresets)[0].fingerprint;
        sku.product.images[0].url = "different-front";
        sku.product.detailImages!.push({ ...sku.product.detailImages![0], id: "unrelated", contentHash: "other" });
        expect(buildVisualPlan(job, sku, pack.requirementPresets)[0].fingerprint).toBe(before);
        sku.product.detailImages![0].contentHash = "replaced";
        expect(buildVisualPlan(job, sku, pack.requirementPresets)[0].fingerprint).not.toBe(before);
    });
    it("invalidates replaced back assets and dependent marketing, retaining unrelated scene and white", () => {
        const { sku, job, pack } = fixture();
        const base = { jobId: job.id, skuId: sku.id, revision: 1, title: "图", url: "image", width: 1024, height: 1024, bytes: 10, mimeType: "image/jpeg", sequence: 1, createdAt: "" };
        sku.assets = [
            { ...base, id: "white", stage: "main-white" },
            { ...base, id: "scene", stage: "scene" },
            { ...base, id: "detail", stage: "detail", requirementId: "back", sourceAssetIds: ["back-photo"] },
            { ...base, id: "marketing", stage: "marketing", sourceAssetIds: ["detail"] },
        ];
        const next = structuredClone(sku);
        next.product.detailImages![0].contentHash = "replaced";
        expect(invalidateCategoryInputs(job, sku, next, pack).assets.map((asset) => asset.id)).toEqual(["white", "scene"]);
    });
});
