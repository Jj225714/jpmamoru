import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsistencyConstraint } from "./consistency-types";
import { assertConsistencyCurrent, consistencyConstraintHash, consistencyPrompt } from "./consistency-service";
// Pixel decode and report acceptance are covered by service tests. Keep the real
// serializer/hash/prompt here and isolate only those browser-dependent boundaries.
vi.mock("./consistency-service", async importOriginal => {
    const actual = await importOriginal<typeof import("./consistency-service")>();
    return { ...actual, assertConsistencyCurrent: vi.fn(async () => {}), captureConsistencyRequest: async (_job: CommerceJob, value: CommerceSku) => {
        const constraints = value.consistency?.constraints;
        if (!constraints) return undefined;
        if (!constraints.confirmedBy || !constraints.confirmedAt || !constraints.plane.frontViewConfirmed) throw new Error("尺寸/图案约束尚未确认");
        return { version: 1 as const, hash: await actual.consistencyConstraintHash(constraints), capturedAt: "captured", constraints: structuredClone(constraints), sourceContentHash: constraints.sourceContentHash, sourceImageId: constraints.sourceImageId };
    } };
});
vi.mock("./asset-source", () => ({ captureCommerceSource: async (taskId: string, prompt: string, config: { model: string; size: string }, references: Array<{ id: string }>) => ({ version: 1, prompt, model: config.model, parameters: { size: config.size }, references: references.map((ref) => ({ ...ref, storageKey: "stable:" + ref.id })), generatedAt: "captured", source: { kind: "commerce", taskId } }) }));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
import { createBuiltInPolicyPack, createDefaultBrand } from "./defaults";
import { cloneGenerationConfig, DEFAULT_COMMERCE_GENERATION_CONFIG } from "./generation-config";
import type { CommerceJob, CommerceSku, GeneratedAsset } from "@/types/commerce";

const mock = vi.hoisted(() => ({ state: vi.fn(), edit: vi.fn(), question: vi.fn(), render: vi.fn(), normalize: vi.fn(), canvas: vi.fn(), data: vi.fn(), upload: vi.fn(), visionRules: vi.fn(() => []) }));
vi.mock("@/stores/use-commerce-store", () => ({ useCommerceStore: { getState: mock.state } }));
vi.mock("@/lib/canvas/canvas-node-factory", () => ({ createCanvasNode: vi.fn() }));
vi.mock("@/stores/canvas/use-canvas-store", () => ({ useCanvasStore: { getState: () => ({ createProject: () => "canvas", openProject: mock.canvas, updateProject: vi.fn() }) } }));
vi.mock("@/stores/use-config-store", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/stores/use-config-store")>();
    return { useConfigStore: { getState: () => ({ config: actual.defaultConfig, isAiConfigReady: () => true }) }, resolveModelForCapability: actual.resolveModelForCapability, getImageInputTextModelStatus: actual.getImageInputTextModelStatus };
});
vi.mock("@/services/api/image", () => ({ requestEdit: mock.edit, requestImageQuestion: mock.question }));
vi.mock("@/services/image-storage", () => ({ uploadImage: mock.upload, imageToDataUrl: mock.data }));
vi.mock("@/lib/commerce/generation-preflight", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./generation-preflight")>();
    return { ...actual, preflightGenerationInputs: (job: CommerceJob, sku: CommerceSku, pack: ReturnType<typeof createBuiltInPolicyPack>) => actual.preflightGenerationInputs(job, sku, pack, async (ref) => ({ dataUrl: "data:" + ref.id, mimeType: "image/jpeg", contentHash: "hash" })) };
});
vi.mock("@/lib/commerce/template-renderer", () => ({ normalizeOutputImage: mock.normalize, renderMarketingAsset: mock.render, renderLayeredComposition: async () => new Blob(["rendered"]) }));
vi.mock("@/lib/commerce/policy-engine", async (importOriginal) => ({ ...await importOriginal<typeof import("./policy-engine")>(), promptGuidance: () => "站点规则", runDeterministicChecks: () => [], runAssetContentChecks: async () => [], visionRules: mock.visionRules }));
import { approveWhiteBackground, approveContent, prepareWhiteBackground, generateContent, localizeAndRender } from "./pipeline";
const stored = { url: "blob:result", width: 1024, height: 1024, bytes: 1000, mimeType: "image/jpeg" };
let job: CommerceJob, sku: CommerceSku;
let pack: ReturnType<typeof createBuiltInPolicyPack>;
beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(assertConsistencyCurrent).mockReset().mockResolvedValue(undefined);
    mock.visionRules.mockReset().mockReturnValue([]);
    mock.canvas.mockReset();
    mock.data.mockReset().mockResolvedValue("data:white");
    mock.upload.mockReset().mockResolvedValue(stored);
    pack = createBuiltInPolicyPack();
    pack.requirementPresets = [{ id: "m", category: "通用", order: 1, title: "多场景", stage: "marketing", enabledByDefault: true, defaultCount: 1, prompt: "基础要求", layout: "multi-scene", chineseCopy: "文案", translationSeeds: {}, requiredFacts: [], referenceIds: [], variantScope: "per-sku", needsReview: false }];
    const white: GeneratedAsset = { ...stored, id: "white", jobId: "job", skuId: "sku", stage: "main-white", sequence: 1, revision: 1, title: "white", createdAt: "" };
    sku = { id: "sku", product: { id: "p", sku: "sku", name: "商品", productType: "", category: "通用", brandName: "", audience: "", description: "", size: "", images: [], imageUrls: [], extraFields: {}, verifiedFacts: {}, factsConfirmed: true, imageStatus: "ready" }, stage: "content-generation", activeRevision: 1, assets: [white], compositions: [], approvals: [{ gate: "white-background", approved: true, assetRevision: 1, reviewer: "user", reviewedAt: "" }], checks: [], selectedTemplateIds: ["m"], requirementSelections: [{ requirementId: "m", enabled: true, count: 1, referenceIds: [], variantScope: "per-sku", variantValues: [], promptOverride: "用户画面要求" }], copyZh: { m: "文案" }, localizedCopy: {} };
    const brand = createDefaultBrand();
    job = { id: "job", name: "test", platform: "shopee", visualPipelineVersion: 2, policyPackId: pack.id, policyVersion: pack.version, locales: ["en-US", "id-ID"], generationConfig: cloneGenerationConfig(DEFAULT_COMMERCE_GENERATION_CONFIG), brandProfileId: brand.id, status: "draft", createdAt: "", updatedAt: "", skus: [sku] };
    mock.state.mockReturnValue({ jobs: [job], brands: [brand], policyPacks: [pack], modelRoles: {}, operatorName: "user", addAudit: vi.fn(), updateJob: (_id: string, patch: Partial<CommerceJob>) => Object.assign(job, patch), updateSku: (_j: string, _s: string, patch: Partial<CommerceSku> | ((value: CommerceSku) => CommerceSku)) => Object.assign(sku, typeof patch === "function" ? patch(sku) : patch) });
    mock.edit.mockReset().mockResolvedValue([{ dataUrl: "data:image/png;base64,AA" }]);
    mock.normalize.mockReset().mockResolvedValue(stored);
    mock.question.mockReset().mockResolvedValue('{"m":"文案"}');
    mock.render.mockReset().mockImplementation(async (input) => {
        const { createComposition } = await vi.importActual<typeof import("./template-renderer")>("./template-renderer");
        const pair = input.requirement.generationStrategy === "paired-before-after" ? input.sourceImages as GeneratedAsset[] : undefined;
        return { stored, composition: createComposition({ ...input, requirementId: input.requirement.id, productData: input.productImage.url, sourceData: pair?.map((asset) => asset.url), sourceAssetIds: pair?.map((asset) => asset.id), logoData: "", layout: input.requirement.layout, size: 1024, singleVisual: true }) };
    });
});

function enableConsistency() {
    const constraints: ConsistencyConstraint = { version: 1, revision: 1, sourceImageId: "confirmed-source", sourceContentHash: "sha256:reference-rgba", sourceWidth: 512, sourceHeight: 512, scope: "pattern", provenance: "manual", plane: { id: "front", x: 0, y: 0, width: 512, height: 512, frontViewConfirmed: true }, points: [{ id: "a", name: "logo", role: "validation", sourcePx: { x: 128, y: 128 } }, { id: "b", name: "flower", role: "validation", sourcePx: { x: 256, y: 128 } }, { id: "c", name: "stripe", role: "validation", sourcePx: { x: 256, y: 256 } }], dimensions: [], regions: [], thresholds: { maxPx: 2, rmsePx: 1, relative: .01 }, confirmedBy: "reviewer", confirmedAt: "2026-10-26T00:00:00Z" };
    sku.consistency = { constraints, reports: [] };
    sku.product.images = [{ id: "confirmed-source", name: "确认的参考图", url: "data:confirmed-reference", source: "upload" }];
    job.locales = ["en-US"];
    const runtime = { assertCurrent: vi.fn(), image: vi.fn(async () => [{ id: "synthetic-result", dataUrl: "data:image/png;base64,AA" }]), text: vi.fn(async (slot: string) => slot.includes("translat") ? '{"en-US":{"m":"Copy"}}' : '{"m":"文案"}') };
    return { constraints, runtime };
}

describe("consistency binding through the real commerce pipeline", () => {
    describe.each(["white", "content"] as const)("%s approval awaits authoritative evidence", scope => {
        const approve = () => scope === "white" ? approveWhiteBackground("job", "sku", "reviewer") : approveContent("job", "sku", "reviewer");
        beforeEach(() => {
            job.generationConfig.marketingEnabled = false;
            job.generationConfig.assetCounts = { scene: 0, detail: 0, "usage-size": 0, "detail-white": 0 };
            sku.requirementSelections = []; pack.requirementPresets = [];
            sku.stage = scope === "white" ? "white-review" : "content-review";
        });
        it("does not mutate state or audit while verification is pending or rejected", async () => {
            let reject!: (error: Error) => void;
            vi.mocked(assertConsistencyCurrent).mockImplementationOnce(() => new Promise((_, no) => { reject = no; }));
            const before = JSON.stringify(job), pending = approve();
            expect(assertConsistencyCurrent).toHaveBeenCalledWith(job, sku, scope);
            expect(JSON.stringify(job)).toBe(before); expect(mock.state().addAudit).not.toHaveBeenCalled();
            reject(new Error("参考图或结果像素内容变化，一致性报告已过期"));
            await expect(pending).rejects.toThrow("像素内容变化");
            expect(JSON.stringify(job)).toBe(before); expect(mock.state().addAudit).not.toHaveBeenCalled();
        });
        it("approves unchanged evidence after verification", async () => {
            await approve();
            expect(assertConsistencyCurrent).toHaveBeenCalledWith(job, sku, scope);
            expect(sku.stage).toBe(scope === "white" ? "content-generation" : "localization");
            expect(sku.approvals).toContainEqual(expect.objectContaining({ gate: scope === "white" ? "white-background" : "content", reviewer: "reviewer", approved: true }));
        });
        it("does not approve inputs changed during the async check", async () => {
            vi.mocked(assertConsistencyCurrent).mockImplementationOnce(async () => { sku.activeRevision++; });
            const approvals = structuredClone(sku.approvals), stage = sku.stage;
            await expect(approve()).rejects.toThrow("任务输入或版本已变化");
            expect(sku.approvals).toEqual(approvals); expect(sku.stage).toBe(stage); expect(mock.state().addAudit).not.toHaveBeenCalled();
        });
    });
    it.each(["white", "content"])("blocks unconfirmed constraints before any %s image request", async stage => {
        const { constraints, runtime } = enableConsistency(); delete constraints.confirmedAt;
        await expect(stage === "white" ? prepareWhiteBackground(job.id, sku.id, "local", runtime) : generateContent(job.id, sku.id, runtime)).rejects.toThrow("尚未确认");
        expect(runtime.image).not.toHaveBeenCalled(); expect(mock.edit).not.toHaveBeenCalled();
    });
    it("sends the exact confirmed prompt/reference and retains request hash on white output", async () => {
        const { constraints, runtime } = enableConsistency();
        const asset = await prepareWhiteBackground(job.id, sku.id, "local", runtime);
        expect(runtime.image).toHaveBeenCalledTimes(1);
        const [, , prompt, refs] = runtime.image.mock.calls[0] as unknown as [string, unknown, string, Array<{ id: string; dataUrl: string }>];
        expect(asset.consistencyRequest?.hash).toBe(await consistencyConstraintHash(constraints));
        expect(prompt).toContain(consistencyPrompt(asset.consistencyRequest!));
        expect(prompt).toContain("不得猜测或绘制毫米/厘米/英寸数值");
        expect(refs).toContainEqual(expect.objectContaining({ id: "confirmed-source", dataUrl: "data:confirmed-reference" }));
        expect(asset.generation?.prompt).toBe(prompt);
        expect(sku.assets.find(a => a.id === asset.id)?.consistencyRequest).toEqual(asset.consistencyRequest);
    });
    it("binds actual content requests and invalidates cached visuals after constraints change", async () => {
        const { constraints, runtime } = enableConsistency();
        await generateContent(job.id, sku.id, runtime);
        const calls = runtime.image.mock.calls.length;
        expect(calls).toBeGreaterThan(0);
        const initialHash = await consistencyConstraintHash(constraints);
        const generated = sku.assets.filter(a => a.stage !== "main-white" && a.stage !== "marketing-preview");
        expect(generated.length).toBe(calls);
        for (const asset of generated) expect(asset.consistencyRequest?.hash).toBe(initialHash);
        for (const call of runtime.image.mock.calls) {
            const [, , prompt, refs] = call as unknown as [string, unknown, string, Array<{ id: string }>];
            expect(prompt).toContain(consistencyPrompt(generated[0].consistencyRequest!));
            expect(prompt).toContain("参考 RGBA 内容身份：sha256:reference-rgba");
            expect(prompt).toContain('"confirmedBy":"reviewer"');
            expect(refs).toContainEqual(expect.objectContaining({ id: "confirmed-source", dataUrl: "data:confirmed-reference" }));
        }
        await generateContent(job.id, sku.id, runtime);
        expect(runtime.image).toHaveBeenCalledTimes(calls);
        constraints.revision += 1; constraints.thresholds.maxPx = 3;
        await generateContent(job.id, sku.id, runtime);
        expect(runtime.image).toHaveBeenCalledTimes(calls * 2);
        const nextHash = await consistencyConstraintHash(constraints);
        expect(nextHash).not.toBe(initialHash);
        for (const asset of sku.assets.filter(a => a.stage !== "main-white")) expect(asset.consistencyRequest?.hash).toBe(nextHash);
    });
    it("inherits the source request snapshot in Chinese previews and localized marketing assets", async () => {
        const { runtime } = enableConsistency();
        await generateContent(job.id, sku.id, runtime);
        const previews = sku.assets.filter(a => a.stage === "marketing-preview"); expect(previews.length).toBeGreaterThan(0);
        sku.approvals.push({ gate: "content", approved: true, assetRevision: 1, reviewer: "user", reviewedAt: "now" });
        runtime.text.mockResolvedValue('{"en-US":{"m":"Copy"}}');
        await localizeAndRender(job.id, sku.id, runtime);
        const marketing = sku.assets.filter(a => a.stage === "marketing"); expect(marketing.length).toBeGreaterThan(0);
        for (const asset of [...previews, ...marketing]) {
            const source = sku.assets.find(a => a.id === asset.sourceAssetIds?.[0]);
            expect(source?.consistencyRequest).toBeDefined();
            expect(asset.consistencyRequest).toEqual(source!.consistencyRequest);
            expect(asset.consistencyRequest?.hash).toBe(await consistencyConstraintHash(sku.consistency!.constraints));
        }
    });
});


