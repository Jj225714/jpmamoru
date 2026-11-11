import { describe, expect, it, vi } from "vitest";
vi.mock("@/services/image-storage", () => ({ imageToDataUrl: vi.fn() }));
import { createBuiltInPolicyPack } from "./defaults";
import { createCategorySeedPack } from "./category-seed";
import { categoryRequirements } from "./category-rules";
import { categoryBrief, categorySelectionErrors, generationCategoryPrompt, generationReferences } from "./generation-inputs";
import { preflightGenerationInputs } from "./generation-preflight";
import { createRequirementSelections, normalizeGenerationConfig } from "./generation-config";
import type { CommerceJob, CommerceSku } from "../../types/commerce";

function fixture() {
    const pack = createCategorySeedPack(createBuiltInPolicyPack());
    const sku: CommerceSku = {
        id: "sku",
        product: {
            id: "p",
            sku: "sku",
            productType: "",
            name: "厨房地垫",
            brandName: "",
            category: "地垫类",
            categoryId: "floor-mats",
            subcategoryId: "kitchen-mat",
            audience: "",
            description: "",
            size: "",
            imageUrls: [],
            images: [{ id: "identity", name: "商品正面", url: "identity.jpg", source: "upload" }],
            extraFields: {},
            verifiedFacts: {},
            factsConfirmed: true,
            imageStatus: "ready",
            detailImages: [{ id: "back-photo", name: "背面实拍", url: "back.jpg", source: "upload", contentHash: "hash", purposes: ["back"], variantKey: "", shared: false }],
        },
        stage: "draft",
        assets: [],
        selectedTemplateIds: [],
        requirementSelections: [],
        compositions: [],
        copyZh: {},
        localizedCopy: {},
        approvals: [],
        checks: [],
        activeRevision: 1,
    };
    const job: CommerceJob = {
        id: "job",
        name: "test",
        platform: "shopee",
        locales: ["en-US"],
        generationConfig: normalizeGenerationConfig({ marketingEnabled: false }),
        policyPackId: pack.id,
        policyVersion: pack.version,
        visualPipelineVersion: 3,
        skus: [sku],
        status: "draft",
        createdAt: "",
        updatedAt: "",
    };
    const requirements = categoryRequirements(pack, sku.product);
    sku.requirementSelections = createRequirementSelections(requirements).map((selection) => ({ ...selection, enabled: false }));
    return { pack, sku, job, requirements };
}

describe("category generation request contract", () => {
    it("allows generation when all category requirements are left unselected", async () => {
        const { pack, sku, job } = fixture();
        const read = vi.fn(async () => ({ dataUrl: "data:image/jpeg;base64,ready", mimeType: "image/jpeg", contentHash: "hash", bytes: 1 }));

        await expect(preflightGenerationInputs(job, sku, pack, read)).resolves.toEqual(new Map([["identity", expect.anything()]]));
        expect(read).toHaveBeenCalledTimes(1);
    });

    it("sends the required category example even when the optional references are empty", () => {
        const { pack, sku, requirements } = fixture();
        const preset = requirements.find((item) => item.recipeRole === "hero")!;
        const selection = createRequirementSelections([preset])[0];
        expect(generationReferences(pack, sku, preset, selection, "").map((ref) => ref.id)).toEqual(["identity", "category-example-kitchen-mat"]);
        expect(categoryBrief(pack, sku, preset, selection)).toMatchObject({ people: "adult-half", scene: "厨房水槽或柜体前" });
        expect(generationCategoryPrompt(pack, sku, preset, selection)).toContain("人物出现半身");
    });
    it("lets an explicit no-people selection override the category people rule", () => {
        const { pack, sku, job, requirements } = fixture();
        const preset = requirements.find((item) => item.recipeRole === "hero")!;
        const selection = { ...createRequirementSelections([preset])[0], creativeBrief: { people: "none" as const } };

        expect(categoryBrief(pack, sku, preset, selection)).toMatchObject({ people: "none", scene: "厨房水槽或柜体前" });
        expect(generationCategoryPrompt(pack, sku, preset, selection)).not.toContain("人物出现半身");
        expect(categorySelectionErrors(pack, job, sku, preset, selection).join()).not.toContain("人物设置与类目要求冲突");
    });
    it("does not pass the white image, identity photo, scene example or people requirement to back detail", () => {
        const { pack, sku, requirements } = fixture();
        const preset = requirements.find((item) => item.detailPurpose === "back")!;
        const selection = { ...createRequirementSelections([preset])[0], sourceImageIds: ["back-photo"], primaryImageId: "back-photo" };
        const refs = generationReferences(pack, sku, preset, selection, "", { id: "white", name: "white", url: "white.jpg", source: "generated" });
        expect(refs.map((ref) => ref.id)).toEqual(["back-photo"]);
        expect(categoryBrief(pack, sku, preset, selection)).toEqual({ people: "none", framing: "close", scene: "" });
        expect(generationCategoryPrompt(pack, sku, preset, selection)).not.toContain("人物出现半身");
        expect(generationCategoryPrompt(pack, sku, preset, selection)).toContain("不从正面推测背面");
    });
    it.each(["adult-partial", "adult-half", "adult-full"] as const)("preserves explicit %s for detail and back schemes", (people) => {
        const { pack, sku, requirements } = fixture();
        const preset = requirements.find((item) => item.detailPurpose === "back")!;
        const selection = { ...createRequirementSelections([preset])[0], creativeBrief: { people } };
        expect(categoryBrief(pack, sku, preset, selection)?.people).toBe(people);
    });
    it("does not block explicit people choices that differ from the category suggestion", async () => {
        const { pack, sku, job, requirements } = fixture();
        const preset = requirements.find((item) => item.recipeRole === "hero")!;
        const selection = { ...createRequirementSelections([preset])[0], creativeBrief: { people: "adult-full" as const } };
        sku.requirementSelections = [selection];
        expect(categorySelectionErrors(pack, job, sku, preset, selection).join()).not.toContain("人物设置与类目要求冲突");
    });
    it("blocks a missing back image across the SKU before decoding any scene input", async () => {
        const { pack, sku, job, requirements } = fixture();
        sku.requirementSelections = createRequirementSelections(requirements.filter((item) => item.recipeRole === "hero" || item.detailPurpose === "back")).map((item) => ({ ...item, enabled: true }));
        const read = vi.fn();
        await expect(preflightGenerationInputs(job, sku, pack, read)).rejects.toThrow("缺少背面实拍");
        expect(read).not.toHaveBeenCalled();
    });
});
