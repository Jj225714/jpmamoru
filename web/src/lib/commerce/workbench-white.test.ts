import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultBrand } from "./defaults";
import { cloneGenerationConfig, DEFAULT_COMMERCE_GENERATION_CONFIG } from "./generation-config";
import type { CommerceJob, CommerceSku } from "@/types/commerce";

const mocks = vi.hoisted(() => ({ normalize: vi.fn(), getState: vi.fn() }));
vi.mock("@/lib/commerce/template-renderer", () => ({ normalizeOutputImage: mocks.normalize }));
vi.mock("@/stores/use-commerce-store", () => ({ useCommerceStore: { getState: mocks.getState } }));
vi.mock("@/stores/canvas/use-canvas-store", () => ({ useCanvasStore: { getState: () => ({ createProject: () => "canvas", openProject: () => undefined }) } }));
vi.mock("@/stores/use-config-store", () => ({ useConfigStore: { getState: () => ({ config: undefined }) }, resolveModelForCapability: vi.fn() }));
vi.mock("@/services/server-config", () => ({ useServerConfigStore: { subscribe: () => () => {}, getState: () => ({ serverTeam: null }) } }));
vi.mock("@/services/image-storage", () => ({ imageToDataUrl: vi.fn(), uploadImage: vi.fn() }));
vi.mock("@/services/api/image", () => ({ requestEdit: vi.fn(), requestImageQuestion: vi.fn() }));
vi.mock("@/lib/canvas/canvas-node-factory", () => ({ createCanvasNode: vi.fn() }));
import { adoptWorkbenchWhite } from "./pipeline";

let job: CommerceJob;
const image = { url: "blob:new", storageKey: "image:new", width: 1024, height: 1024, bytes: 1000, mimeType: "image/jpeg" };
beforeEach(() => {
    const brand = createDefaultBrand();
    job = { id: "job", name: "test", platform: "shopee", locales: ["en-US"], generationConfig: cloneGenerationConfig(DEFAULT_COMMERCE_GENERATION_CONFIG), brandProfileId: brand.id, status: "draft", createdAt: "", updatedAt: "", skus: [{ id: "sku", product: { id: "p", sku: "sku", name: "basket", productType: "basket", category: "通用", brandName: "", audience: "", description: "", size: "", images: [], imageUrls: [], extraFields: {}, verifiedFacts: {}, factsConfirmed: false, imageStatus: "ready" }, stage: "draft", activeRevision: 1, assets: [], compositions: [], approvals: [], checks: [], selectedTemplateIds: [], requirementSelections: [], copyZh: {}, localizedCopy: {} }] };
    mocks.normalize.mockReset().mockResolvedValue(image);
    mocks.getState.mockReturnValue({ jobs: [job], brands: [brand], operatorName: "operator", addAudit: vi.fn(), updateJob: (_id: string, patch: Partial<CommerceJob>) => Object.assign(job, patch), updateSku: (_job: string, _sku: string, patch: Partial<CommerceSku>) => Object.assign(job.skus[0], patch) });
});
describe("workbench white transfer", () => {
    it("adopts an existing image into a new task at white review without background removal", async () => {
        await adoptWorkbenchWhite("job", "sku", image);
        expect(job.skus[0].stage).toBe("white-review");
        expect(job.skus[0].assets[0]).toMatchObject({ stage: "main-white", revision: 1, storageKey: "image:new" });
        expect(job.status).toBe("waiting-review");
    });
    it("preserves old results and invalidates approvals when replacing a completed task", async () => {
        await adoptWorkbenchWhite("job", "sku", image);
        const old = job.skus[0].assets[0];
        job.skus[0].stage = "ready";
        job.skus[0].approvals = [{ gate: "content", approved: true, reviewer: "operator", reviewedAt: "", assetRevision: 1 }];
        job.skus[0].copyZh = { template: "old copy" };
        await adoptWorkbenchWhite("job", "sku", image);
        expect(job.skus[0].assets).toContainEqual(old);
        expect(job.skus[0]).toMatchObject({ activeRevision: 2, stage: "white-review", approvals: [], checks: [], copyZh: {}, localizedCopy: {} });
    });
    it("leaves a task intact when image normalization fails", async () => {
        const before = JSON.stringify(job);
        mocks.normalize.mockRejectedValue(new Error("image missing"));
        await expect(adoptWorkbenchWhite("job", "sku", image)).rejects.toThrow("image missing");
        expect(JSON.stringify(job)).toBe(before);
    });
    it("does not replace a white image while its downstream generation is running", async () => {
        job.status = "running"; job.skus[0].stage = "localization";
        await expect(adoptWorkbenchWhite("job", "sku", image)).rejects.toThrow("正在处理");
        expect(mocks.normalize).not.toHaveBeenCalled();
    });
});
