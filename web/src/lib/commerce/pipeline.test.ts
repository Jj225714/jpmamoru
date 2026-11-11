import { marketingReviewSignature } from "./marketing-layout-binding";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./asset-source", () => ({ captureCommerceSource: async (taskId: string, prompt: string, config: { model: string; size: string }, references: Array<{ id: string }>) => ({ version: 1, prompt, model: config.model, parameters: { size: config.size }, references: references.map((ref) => ({ ...ref, storageKey: "stable:" + ref.id })), generatedAt: "captured", source: { kind: "commerce", taskId } }) }));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
import { createBuiltInPolicyPack, createDefaultBrand } from "./defaults";
import { cloneGenerationConfig, DEFAULT_COMMERCE_GENERATION_CONFIG } from "./generation-config";
import { buildVisualPlan, matchVisualSources } from "./visual-plan";
import type { CommerceJob, CommerceSku, GeneratedAsset, CommerceRequirementPreset } from "@/types/commerce";
import actual40 from "./fixtures/aowei-visual-audit.json";
import { correctedPresetVisual } from "./requirement-visuals";

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
import { runCompliance, generateContent, refreshChinesePreviews, localizeAndRender, submitCanvasToJob, approveContent, markCheckFalsePositive, roleConfig } from "./pipeline";
import { useManagedModelStore } from "@/stores/use-managed-model-store";
import { useServerConfigStore } from "@/services/server-config";
import { CanvasNodeType } from "@/types/canvas";
const stored = { url: "blob:result", width: 1024, height: 1024, bytes: 1000, mimeType: "image/jpeg" };
it("keeps personal commerce model choices despite obsolete managed flags", () => {
    vi.stubGlobal("window", { __RUNTIME_CONFIG__: { managedModelGatewayEnabled: true } });
    useManagedModelStore.setState({ phase: "authenticated", session: { authenticated: true, enabled: true, models: [{ name: "server-text", capability: "text" }, { name: "server-image", capability: "image" }] } });
    mock.state().modelRoles.complianceModel = "private::old-image";
    try {
        expect(roleConfig("complianceModel", "text").model).toBe("private::old-image");
        expect(roleConfig("complianceModel", "text").baseUrl).not.toBe("/api/managed");
        expect(roleConfig("complianceModel", "image").model).toBe("private::old-image");
    } finally {
        vi.unstubAllGlobals();
        useManagedModelStore.setState({ phase: "anonymous", session: null });
    }
});
it("resolves commerce roles from the published team model configuration", () => {
    useServerConfigStore.setState({ serverTeam: { modelConfig: {
        channels: [{ id: "team", name: "团队统一渠道", baseUrl: "/api/managed", apiKey: "", apiFormat: "openai", models: [{ name: "team-image", capability: "image" }, { name: "team-text", capability: "text" }] }],
        defaults: { model: "team-text", imageModel: "team-image", videoModel: "team-text", textModel: "team-text", audioModel: "team-text" },
        roles: { sceneModel: "team-image", repairModel: "team-image", copyModel: "team-text", translationModel: "team-text", complianceModel: "team-text", removalApiUrl: "", removalApiKey: "" },
    } } as never });
    try {
        expect(roleConfig("copyModel", "text")).toMatchObject({ model: "team-text", channels: expect.any(Array) });
        expect(roleConfig("sceneModel", "image").model).toBe("team-image");
    } finally {
        useServerConfigStore.setState({ serverTeam: null });
    }
});
it("reports the missing team role instead of falling back to a personal model", () => {
    useServerConfigStore.setState({ serverTeam: { modelConfig: { channels: [], defaults: { model: "", imageModel: "", videoModel: "", textModel: "", audioModel: "" }, roles: { sceneModel: "", repairModel: "", copyModel: "", translationModel: "", complianceModel: "", removalApiUrl: "", removalApiKey: "" } } } as never });
    try { expect(() => roleConfig("copyModel", "text")).toThrow("团队统一模型配置缺少 copyModel"); } finally { useServerConfigStore.setState({ serverTeam: null }); }
});
let job: CommerceJob, sku: CommerceSku;
let pack: ReturnType<typeof createBuiltInPolicyPack>;
beforeEach(() => {
    vi.clearAllMocks();
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

describe("category bound independent detail generation", () => {
    it("keeps US and British translations and rendered sites separate", async () => {
        job.locales = ["en-US", "en-GB"];
        job.generationConfig.siteImageMode = "per-site";
        await generateContent(job.id, sku.id);
        mock.question.mockResolvedValue('{"en-US":{"m":"Organize by color"},"en-GB":{"m":"Organise by colour"}}');
        sku.approvals.push({ gate: "content", approved: true, assetRevision: 1, reviewer: "user", reviewedAt: "now" });
        await localizeAndRender(job.id, sku.id);
        expect(mock.question.mock.calls.at(-1)![1][0].content).toContain("organize → organise");
        expect(mock.question.mock.calls.at(-1)![1][0].content).toContain("en-US、en-GB");
        expect(sku.localizedCopy).toMatchObject({ "en-US": { m: "Organize by color" }, "en-GB": { m: "Organise by colour" } });
        for (const locale of job.locales) {
            const asset = sku.assets.find((item) => item.stage === "marketing" && item.locale === locale)!;
            expect(asset.siteLocale).toBe(locale);
            expect(asset.prompt).toBe(sku.localizedCopy[locale]!.m);
            expect(sku.assets.find((item) => item.id === asset.sourceAssetIds?.[0])?.siteLocale).toBe(locale);
        }
    });
    it("does not use US output as a fallback when British translation is missing", async () => {
        job.locales = ["en-US", "en-GB"];
        await generateContent(job.id, sku.id);
        mock.question.mockResolvedValue('{"en-US":{"m":"Color"}}');
        sku.approvals.push({ gate: "content", approved: true, assetRevision: 1, reviewer: "user", reviewedAt: "now" });
        await expect(localizeAndRender(job.id, sku.id)).rejects.toThrow("en-GB");
        expect(sku.assets.filter((item) => item.stage === "marketing")).toHaveLength(0);
    });
    function enableBack(mode: "optimize" | "original" = "optimize") {
        job.visualPipelineVersion = 3;
        job.generationConfig.marketingEnabled = false;
        pack.requirementPresets[0] = { ...pack.requirementPresets[0], stage: "detail", visualKind: "detail", detailPurpose: "back", title: "背面实拍" };
        pack.categories = [{ id: "mat", name: "垫", aliases: [], active: true, order: 0, rules: [], referenceIds: [], requirementIds: ["m"] }];
        sku.product.categoryId = "mat";
        sku.product.detailImages = [{ id: "back", name: "背面", url: "blob:back", source: "upload", contentHash: "hash", purposes: ["back"], variantKey: "", shared: false }];
        Object.assign(sku.requirementSelections[0], { sourceImageIds: ["back"], primaryImageId: "back", detailPurpose: "back", detailRenderMode: mode });
        sku.selectedTemplateIds = [];
    }
    it("passes only the actual back photo to the model", async () => {
        enableBack();
        await generateContent(job.id, sku.id);
        expect(mock.edit).toHaveBeenCalledTimes(1);
        const output = sku.assets.find((asset) => asset.stage === "detail")!;
        expect(output.generation?.prompt).toBe(mock.edit.mock.calls[0][1]);
        expect(output.generation?.model).toBe(mock.edit.mock.calls[0][0].model);
        expect(output.generation?.references[0].storageKey).toBe("stable:back");
        expect(mock.edit.mock.calls[0][2].map((ref: { id: string }) => ref.id)).toEqual(["back"]);
        expect(mock.edit.mock.calls[0][1]).toContain("不从正面推测背面");
        expect(mock.edit.mock.calls[0][1]).not.toContain("第 1 张为已审核白底");
    });
    it("binds the category example and required people to scene generation and repair", async () => {
        enableBack();
        pack.requirementPresets[0] = { ...pack.requirementPresets[0], stage: "scene", visualKind: "scene", detailPurpose: undefined };
        pack.categories![0].referenceIds = ["example"];
        pack.categories![0].rules = [{ id: "required-people", text: "人物半身在厨房自然操作", strength: "required", key: "people", value: "adult-half", stages: ["scene"] }];
        pack.references.push({ id: "example", name: "厨房示例", url: "example", source: "rule-reference", sheet: "Sheet1", anchor: "C11", kind: "example" });
        mock.upload.mockResolvedValueOnce({ ...stored, width: 1200, height: 900 });
        await generateContent(job.id, sku.id);
        expect(mock.edit).toHaveBeenCalledTimes(2);
        expect(mock.edit.mock.calls[0][2].map((ref: { id: string }) => ref.id)).toEqual(["white", "example"]);
        expect(mock.edit.mock.calls[0][1]).toContain("人物设置（类目默认建议，当前选择优先）：可出现成人半身");
        expect(mock.edit.mock.calls[1][1]).toContain("人物半身在厨房自然操作");
        expect(mock.edit.mock.calls[1][2].map((ref: { id: string }) => ref.id)).toEqual(["framing-source", "white", "example"]);
        const scene = sku.assets.find((asset) => asset.stage === "scene")!;
        expect(scene.generationHistory).toHaveLength(2);
        expect(scene.generation?.prompt).toBe(mock.edit.mock.calls[1][1]);
        expect(scene.generation?.references.map((ref) => ref.id)).toEqual(["framing-source", "white", "example"]);
    });
    it("renders originals without any image or copy model calls", async () => {
        enableBack("original");
        await generateContent(job.id, sku.id);
        expect(mock.edit).not.toHaveBeenCalled();
        expect(mock.question).not.toHaveBeenCalled();
        expect(mock.normalize.mock.calls[0][4]).toBe(true);
        expect(sku.assets.find((asset) => asset.stage === "detail")?.sourceAssetIds).toEqual(["back"]);
    });
    it("fails before spending when the back image has not been supplied", async () => {
        enableBack();
        sku.product.detailImages = [];
        await expect(generateContent(job.id, sku.id)).rejects.toThrow("素材已删除");
        expect(mock.edit).not.toHaveBeenCalled();
    });
    it("ignores results from a replaced source while model work is running", async () => {
        enableBack();
        mock.edit.mockImplementationOnce(async () => {
            sku.product.detailImages![0].contentHash = "new-back";
            return [{ dataUrl: "data:new" }];
        });
        await expect(generateContent(job.id, sku.id)).rejects.toThrow("已忽略过期结果");
        expect(sku.assets).toHaveLength(1);
    });
    it("does not invalidate a pinned run when another policy version is published", async () => {
        enableBack();
        mock.edit.mockImplementationOnce(async () => {
            mock.state().policyPacks.push({ ...pack, id: "new-version", version: pack.version + 1 });
            pack.status = "retired";
            return [{ dataUrl: "data:new" }];
        });
        await generateContent(job.id, sku.id);
        expect(sku.stage).toBe("content-review");
    });
});

describe("square scene generation", () => {
    it.each([false, true])("ignores retired access-code state during multistage generation (switch=%s)", async (switchPrincipal) => {
        vi.stubGlobal("window", { __RUNTIME_CONFIG__: { managedModelGatewayEnabled: true } });
        const session = { authenticated: true, enabled: true, principal: { id: "A", name: "A" }, models: [{ name: "server-image", capability: "image" as const }, { name: "server-text", capability: "text" as const }] };
        useManagedModelStore.setState({ phase: "authenticated", session });
        mock.edit.mockImplementationOnce(async (config) => {
            expect(config.managedPrincipalId).toBeUndefined();
            if (switchPrincipal) useManagedModelStore.getState().expire();
            useManagedModelStore.setState({ phase: "authenticated", session: { ...session, principal: { id: switchPrincipal ? "B" : "A", name: "refreshed" } } });
            return [{ dataUrl: "data:image/png;base64,AA" }];
        });
        try {
            const work = generateContent(job.id, sku.id);
            await work;
            expect(sku.stage).toBe("content-review");
        } finally {
            vi.unstubAllGlobals();
            useManagedModelStore.setState({ phase: "anonymous", session: null });
        }
    });
    it("extends a landscape result once before normalization, without padding or cropping", async () => {
        mock.upload.mockResolvedValueOnce({ ...stored, url: "landscape", width: 1200, height: 900 });
        await generateContent(job.id, sku.id);
        expect(mock.edit).toHaveBeenCalledTimes(2);
        expect(mock.edit.mock.calls[1][1]).toContain("向短边方向扩展真实背景");
        expect(mock.edit.mock.calls[1][2][0].dataUrl).toBe("landscape");
        expect(mock.edit.mock.calls[1][2][1].id).toBe("white");
        expect(mock.normalize.mock.calls[0][0]).toEqual(stored);
        expect(sku.stage).toBe("content-review");
    });
    it("stops after a bad repair instead of saving a padded final", async () => {
        mock.upload.mockResolvedValue({ ...stored, width: 1200, height: 900 });
        await expect(generateContent(job.id, sku.id)).rejects.toThrow("仍未返回1:1");
        expect(mock.edit).toHaveBeenCalledTimes(2);
        expect(mock.normalize).not.toHaveBeenCalled();
        expect(sku.assets).toHaveLength(1);
        expect(sku.stage).toBe("failed");
    });
});

describe("review decision freshness", () => {
    it("cannot promote a draft or cleared check list using a stale decision ID", () => {
        sku.stage = "draft";
        expect(() => markCheckFalsePositive(job.id, sku.id, "old-check", "owner")).toThrow("已失效");
        expect(sku.stage).toBe("draft");
        expect(mock.state().addAudit).not.toHaveBeenCalled();
    });
    it("requires revision-bound evidence in v3 and preserves evidence on valid approval", () => {
        job.visualPipelineVersion = 3;
        sku.stage = "compliance";
        sku.checks = [{ id: "manual", ruleId: "manual", severity: "BLOCK", status: "uncertain", message: "确认", evidence: "fixed-evidence", checkedAt: "now", assetRevision: 0 }];
        expect(() => markCheckFalsePositive(job.id, sku.id, "manual", "owner")).toThrow("当前版本");
        expect(sku.stage).toBe("compliance");
        sku.checks[0].assetRevision = sku.activeRevision;
        markCheckFalsePositive(job.id, sku.id, "manual", "owner");
        expect(sku.stage).toBe("ready");
        expect(sku.checks[0].evidence).toBe("fixed-evidence");
    });
});

describe("actual 40 audited requirements: mocked generation requests", () => {
    const facts: Record<string, string> = {
        产品尺寸: "30×45cm", 产品厚度: "8", 耐热温度: "100°C", 吸水时间: "3",
        竞品对比依据: "测试样品A与本品在同一条件下的已确认对比记录",
        孔距: "25mm", 孔径: "6mm", 配件数量: "8", 安装方式: "桌面支架、无痕贴、夹式支架",
        颜色: "红色、蓝色", 是否配盖: "配盖", 材质与工艺: "已确认手工编织及边缘处理",
        清洁方式: "已确认可吸尘清洁", 材质层次: "表层织物、中间吸水层、底层防滑层",
    };
    it("covers all four source categories", () => {
        expect(actual40).toHaveLength(40);
        expect(new Set(actual40.map((row) => row.category)).size).toBe(4);
    });
    it.each(actual40)("$category #$order builds the exact visual request or rejects blank instructions", async (row) => {
        const preset = correctedPresetVisual({ ...row, translationSeeds: {} } as CommerceRequirementPreset);
        pack.requirementPresets = [preset];
        pack.references = preset.referenceIds.map((id) => ({ id, name: "审计参考 " + id, url: "blob:audit-ref-" + id, source: "rule-reference", sheet: preset.category, anchor: String(preset.order), kind: "reference" }));
        sku.product.category = preset.category;
        sku.product.verifiedFacts = { 颜色: facts.颜色 };
        for (const fact of preset.requiredFacts) {
            expect(facts[fact], "explicit test fact: " + fact).toBeDefined();
            sku.product.verifiedFacts[fact] = facts[fact];
        }
        sku.product.factsConfirmed = true;
        sku.requirementSelections = [{ requirementId: preset.id, enabled: true, count: 1, referenceIds: [...preset.referenceIds], layout: preset.layout, variantScope: preset.variantScope, variantValues: [], reviewed: false }];
        sku.selectedTemplateIds = preset.stage === "marketing" ? [preset.id] : [];
        sku.copyZh = {};
        job.generationConfig.marketingEnabled = preset.stage === "marketing";
        mock.question.mockResolvedValue(JSON.stringify({ [preset.id]: "已核验商品文案" }));
        if (!preset.prompt.trim() || preset.prompt.trim() === "无") {
            await expect(generateContent("job", "sku")).rejects.toThrow("明确的画面要求");
            expect(mock.edit).not.toHaveBeenCalled();
            expect(sku.assets).toHaveLength(1);
            return;
        }
        await generateContent("job", "sku");
        const count = preset.variantScope === "per-color" ? 2 : 1;
        expect(mock.edit).toHaveBeenCalledTimes(count);
        for (const [, prompt, refs] of mock.edit.mock.calls) {
            expect(prompt).toContain(preset.prompt);
            expect(prompt).toContain("版式类型：" + preset.layout);
            expect(prompt).toContain("视觉类型：" + preset.visualKind);
            expect(prompt).toContain("站点规则");
            expect(refs.map((ref: { id: string; dataUrl: string }) => [ref.id, ref.dataUrl])).toEqual([
                ["white", stored.url], ...pack.references.map((ref) => [ref.id, ref.url]),
            ]);
        }
        const expectedStage = preset.stage === "marketing" ? "marketing-base" : preset.stage;
        const visuals = sku.assets.filter((asset) => asset.stage === expectedStage);
        expect(visuals).toHaveLength(count);
        expect(visuals.every((asset) => asset.requirementId === preset.id && !!asset.visualFingerprint && !!asset.visualKey)).toBe(true);
        expect(sku.assets.filter((asset) => asset.stage === "marketing-preview")).toHaveLength(preset.stage === "marketing" ? count : 0);
        expect(sku.stage).toBe("content-review");
        if (preset.prompt === "文案用里面的") {
            expect(preset.needsReview).toBe(true);
            await expect(approveContent("job", "sku", "user")).rejects.toThrow();
            sku.requirementSelections[0].reviewed = true;
            await expect(approveContent("job", "sku", "user")).resolves.toBeUndefined();
        }
    });
});
describe("v3 paired generation", () => {
    beforeEach(() => {
        job.visualPipelineVersion = 3;
        Object.assign(pack.requirementPresets[0], { generationStrategy: "paired-before-after", layout: "before-after", recipeRole: "before-after" });
        let index = 0;
        mock.normalize.mockImplementation(async () => ({ ...stored, url: "blob:pair-" + ++index }));
        mock.data.mockImplementation(async ({ url }) => url);
    });
    it("saves BEFORE before requesting AFTER, passes ordered references and renders the exact pair", async () => {
        sku.product.images = [{ id: "photo", name: "real", url: "real-photo", source: "upload" }];
        pack.references = [{ id: "ref", name: "layout", url: "reference", source: "rule-reference", sheet: "", anchor: "", kind: "reference" }];
        sku.requirementSelections[0].referenceIds = ["ref"];
        mock.edit.mockImplementation(async (_config, prompt, refs) => {
            if (prompt.includes("仅生成 AFTER")) {
                const before = sku.assets.find((asset) => asset.comparisonRole === "before")!;
                expect(before).toBeDefined();
                expect(refs.map((ref: { id: string }) => ref.id)).toEqual([before.id, "white", "photo", "ref"]);
            } else expect(refs.map((ref: { id: string }) => ref.id)).toEqual(["white", "photo", "ref"]);
            return [{ dataUrl: "generated-" + mock.edit.mock.calls.length }];
        });
        await generateContent("job", "sku");
        const pair = matchVisualSources(job, sku, pack.requirementPresets[0], sku.requirementSelections[0], 1, "");
        expect(pair.map((asset) => asset.comparisonRole)).toEqual(["before", "after"]);
        expect(mock.render.mock.calls[0][0].sourceImages).toEqual(pair);
        expect(sku.assets.find((asset) => asset.stage === "marketing-preview")?.sourceAssetIds).toEqual(pair.map((asset) => asset.id));
        expect(mock.normalize.mock.calls.map((call) => call[3])).toEqual(["comparison-source", "comparison-source"]);
        mock.question.mockResolvedValue('{"en-US":{"m":"English"},"id-ID":{"m":"Indonesia"}}');
        sku.approvals.push({ gate: "content", approved: true, assetRevision: 1, reviewer: "user", reviewedAt: "" });
        await localizeAndRender("job", "sku");
        const finals = sku.assets.filter((asset) => asset.stage === "marketing");
        expect(finals).toHaveLength(2);
        expect(finals.every((asset) => JSON.stringify(asset.sourceAssetIds) === JSON.stringify(pair.map((source) => source.id)))).toBe(true);
    });
    it("retains successful BEFORE after failure and retries only AFTER", async () => {
        mock.edit.mockResolvedValueOnce([{ dataUrl: "before" }]).mockRejectedValueOnce(new Error("after failed"));
        await expect(generateContent("job", "sku")).rejects.toThrow("after failed");
        const before = sku.assets.find((asset) => asset.comparisonRole === "before")!;
        expect(before).toBeDefined();
        expect(sku.stageMessage).toBe("after failed");
        await generateContent("job", "sku");
        expect(mock.edit).toHaveBeenCalledTimes(3);
        expect(sku.assets).toContainEqual(before);
        before.url = "changed-before-content";
        await generateContent("job", "sku");
        expect(mock.edit).toHaveBeenCalledTimes(4);
        expect(mock.edit.mock.calls[3][2][0].dataUrl).toBe("changed-before-content");
    });
    it("records first failure without requesting AFTER", async () => {
        mock.edit.mockRejectedValueOnce(new Error("before failed"));
        await expect(generateContent("job", "sku")).rejects.toThrow("before failed");
        expect(mock.edit).toHaveBeenCalledTimes(1);
        expect(sku.assets).toHaveLength(1);
        expect(sku.stage).toBe("failed");
    });
    it("keeps suggestion drafts out of snapshots and copy prompts while using adopted v3 fields", async () => {
        Object.assign(sku.product, { materialDescription: "adopted material", usageInstructions: "adopted usage", audience: "adopted audience" });
        mock.edit.mockImplementationOnce(async () => {
            sku.product.informationSuggestion = { information: { name: "DRAFT_ONLY", audience: "DRAFT_ONLY", sellingPoints: "DRAFT_ONLY", material: "DRAFT_ONLY", usage: "DRAFT_ONLY", category: "DRAFT_ONLY" }, uncertainties: ["UNCERTAIN_ONLY"], sourceFingerprint: "draft", createdAt: "now" };
            sku.product.categoryPath = "Home > Storage";
            return [{ dataUrl: "before" }];
        });
        await generateContent("job", "sku");
        const prompt = mock.question.mock.calls[0][1][0].content;
        expect(prompt).toContain("adopted material");
        expect(prompt).toContain("adopted usage");
        expect(prompt).toContain("adopted audience");
        expect(prompt).not.toContain("DRAFT_ONLY");
        expect(prompt).not.toContain("UNCERTAIN_ONLY");
    });
    it.each(["white-layout", "wrong-layout"])("rejects incompatible pair %s before any model request", async (mode) => {
        if (mode === "white-layout") sku.requirementSelections[0].visualMode = "white-layout";
        else sku.requirementSelections[0].layout = "multi-scene";
        await expect(generateContent("job", "sku")).rejects.toThrow();
        expect(mock.edit).not.toHaveBeenCalled();
        expect(mock.question).not.toHaveBeenCalled();
    });
    it("rejects repeated BEFORE content returned for AFTER", async () => {
        mock.edit.mockResolvedValueOnce([{ dataUrl: "before" }]).mockResolvedValueOnce([{ dataUrl: "blob:pair-1" }]);
        await expect(generateContent("job", "sku")).rejects.toThrow("原样返回 BEFORE");
        expect(sku.assets.filter((asset) => asset.stage === "comparison-source")).toHaveLength(1);
    });
    it("ignores stale AFTER results and preserves the successful BEFORE", async () => {
        mock.edit.mockResolvedValueOnce([{ dataUrl: "before" }]).mockImplementationOnce(async () => {
            sku.product.materialDescription = "changed";
            return [{ dataUrl: "late-after" }];
        });
        await expect(generateContent("job", "sku")).rejects.toThrow("过期");
        expect(sku.assets.filter((asset) => asset.stage === "comparison-source")).toHaveLength(1);
        expect(mock.normalize).toHaveBeenCalledTimes(1);
    });
    it("remaps both source IDs on canvas cloning without invalidating AFTER", async () => {
        await generateContent("job", "sku");
        const original = sku.assets.filter((asset) => asset.stage === "comparison-source");
        sku.canvasProjectId = "canvas";
        mock.canvas.mockReturnValueOnce({ nodes: [{ id: "n", type: CanvasNodeType.Image, metadata: { commerceSkuId: "sku", commerceAssetId: original[0].id, content: original[0].url } }] });
        await submitCanvasToJob("job", "sku", "user");
        const pair = matchVisualSources(job, sku, pack.requirementPresets[0], sku.requirementSelections[0], 1, "");
        expect(pair.map((asset) => asset.visualFingerprint)).toEqual(original.map((asset) => asset.visualFingerprint));
        expect(sku.assets.find((asset) => asset.stage === "marketing-preview" && asset.revision === 2)?.sourceAssetIds).toEqual(pair.map((asset) => asset.id));
    });
    it("blocks canvas bitmap substitution for v3 source layers", async () => {
        await generateContent("job", "sku");
        const before = sku.assets.find((asset) => asset.comparisonRole === "before")!;
        sku.canvasProjectId = "canvas";
        mock.canvas.mockReturnValueOnce({ nodes: [{ id: "n", type: CanvasNodeType.Image, metadata: { commerceSkuId: "sku", commerceAssetId: before.id, content: "replacement" } }] });
        await expect(submitCanvasToJob("job", "sku", "user")).rejects.toThrow("真实来源");
    });
    it("preserves editable comparison labels separately from marketing copy on canvas submission", async () => {
        await generateContent("job", "sku");
        const composition = sku.compositions[0];
        const text = { type: "text" as const, x: 0, y: 0, width: 512, height: 64, zIndex: 30, opacity: 1, rotation: 0, visible: true, locked: false };
        Object.assign(composition, { width: 1024, height: 1024, layers: [
            ...composition.layers.filter((layer) => layer.type !== "text"),
            { ...text, id: "before-label", name: "comparison-label-before", content: "使用前" },
            { ...text, id: "after-label", name: "comparison-label-after", content: "使用后" },
            { ...text, id: "copy", name: "营销文案", content: "文案" },
        ] });
        sku.canvasProjectId = "canvas";
        mock.canvas.mockReturnValueOnce({ nodes: [
            { id: "group", type: CanvasNodeType.Group, width: 1024, position: { x: 0, y: 0 }, metadata: { commerceSkuId: "sku", commerceAssetId: composition.assetId, commerceCompositionId: composition.id } },
            ...composition.layers.filter((layer) => layer.type === "text").map((layer) => ({ id: layer.id, type: CanvasNodeType.Text, width: 512, height: 64, position: { x: 0, y: 0 }, metadata: { commerceSkuId: "sku", commerceAssetId: composition.assetId, commerceCompositionId: composition.id, commerceLayerId: layer.id, content: layer.id === "copy" ? "修改文案" : layer.id === "before-label" ? "整理前" : layer.content } })),
        ] });
        await submitCanvasToJob("job", "sku", "user");
        expect(sku.copyZh.m).toBe("修改文案");
        expect(sku.compositions.find((item) => item.revision === 2)?.layers.find((layer) => layer.id === "before-label")?.content).toBe("整理前");
        expect(matchVisualSources(job, sku, pack.requirementPresets[0], sku.requirementSelections[0], 1, "")).toHaveLength(2);
    });
});

describe("v2 visual pipeline", () => {
    it("rejects legacy generation with an actionable upgrade message", async () => {
        job.visualPipelineVersion = undefined;
        await expect(generateContent("job", "sku")).rejects.toThrow("升级");
        expect(mock.edit).not.toHaveBeenCalled();
    });
    it("never refreshes from an arbitrary white or scene image", async () => {
        await expect(refreshChinesePreviews("job", "sku")).rejects.toThrow("缺少");
        expect(mock.render).not.toHaveBeenCalled();
    });
    it("checks unresolved references before any image request", async () => {
        sku.requirementSelections[0].referenceIds = ["missing"];
        await expect(generateContent("job", "sku")).rejects.toThrow("参考图不存在");
        expect(mock.edit).not.toHaveBeenCalled();
    });
    it("generates independent bases and exact previews for every sequence, variant and site", async () => {
        job.generationConfig.siteImageMode = "per-site";
        Object.assign(sku.requirementSelections[0], { count: 2, variantScope: "custom", variantValues: ["red", "blue"] });
        await generateContent("job", "sku");
        expect(mock.edit).toHaveBeenCalledTimes(8);
        expect(mock.edit.mock.calls[0][1]).toContain("用户画面要求");
        expect(mock.edit.mock.calls[0][1]).toContain("各面板");
        expect(mock.question.mock.calls[0][1][0].content).toContain("用户画面要求");
        const bases = sku.assets.filter((asset) => asset.stage === "marketing-base");
        expect(new Set(bases.map((asset) => asset.visualKey)).size).toBe(8);
        for (const preview of sku.assets.filter((asset) => asset.stage === "marketing-preview")) {
            const base = bases.find((asset) => asset.id === preview.sourceAssetIds?.[0])!;
            expect(preview).toMatchObject({ sequence: base.sequence, variantKey: base.variantKey, siteLocale: base.siteLocale, visualKey: base.visualKey, visualFingerprint: base.visualFingerprint, prompt: sku.copyZh.m });
        }
        mock.question.mockResolvedValue('{"en-US":{"m":"English"},"id-ID":{"m":"Indonesia"}}');
        sku.approvals.push({ gate: "content", approved: true, assetRevision: 1, reviewer: "user", reviewedAt: "" });
        await localizeAndRender("job", "sku");
        expect(sku.assets.filter((asset) => asset.stage === "marketing")).toHaveLength(8);
        for (const asset of sku.assets.filter((asset) => asset.stage === "marketing")) expect(asset.prompt).toBe(sku.localizedCopy[asset.locale!]!.m);
    });
    it("persists successes and retries only missing exact slots", async () => {
        sku.requirementSelections[0].count = 2;
        mock.edit.mockResolvedValueOnce([{ dataUrl: "first" }]).mockRejectedValueOnce(new Error("model failed"));
        await expect(generateContent("job", "sku")).rejects.toThrow("model failed");
        const first = sku.assets.find((asset) => asset.stage === "marketing-base")!;
        expect(first).toBeDefined();
        await generateContent("job", "sku");
        expect(mock.edit).toHaveBeenCalledTimes(3);
        expect(sku.assets).toContainEqual(first);
    });
    it("clears stale downstream results even if the first generation request fails", async () => {
        sku.assets.push({ ...sku.assets[0], id: "old-preview", stage: "marketing-preview" });
        sku.approvals.push({ gate: "content", approved: true, assetRevision: 1, reviewer: "user", reviewedAt: "" });
        mock.edit.mockRejectedValueOnce(new Error("model failed"));
        await expect(generateContent("job", "sku")).rejects.toThrow("model failed");
        expect(sku.assets.some((asset) => asset.stage === "marketing-preview")).toBe(false);
        expect(sku.approvals.some((approval) => approval.gate === "content")).toBe(false);
    });
    it("passes the brand and stage so the renderer can exclude intermediate overlays", async () => {
        job.generationConfig.overlay.logo.applyTo = "all";
        await generateContent("job", "sku");
        expect(mock.normalize.mock.calls[0][2]).toBe(mock.state().brands[0]);
        expect(mock.normalize.mock.calls[0][3]).toBe("marketing-base");
    });
    it("rejects an unchanged white bitmap returned by the model before normalization", async () => {
        mock.edit.mockResolvedValueOnce([{ dataUrl: "data:white" }]);
        await expect(generateContent("job", "sku")).rejects.toThrow("原样返回白底图");
        expect(mock.normalize).not.toHaveBeenCalled();
        expect(sku.assets.filter((asset) => asset.stage === "marketing-base")).toHaveLength(0);
    });
    it.each([false, true])("remaps canvas sources and invalidates edited base=%s", async (edited) => {
        await generateContent("job", "sku");
        const base = sku.assets.find((asset) => asset.stage === "marketing-base")!;
        sku.canvasProjectId = "canvas";
        mock.canvas.mockReturnValueOnce({ nodes: [{ id: "n", type: CanvasNodeType.Image, metadata: { commerceSkuId: "sku", commerceAssetId: base.id, commerceStage: "marketing-base", content: edited ? "blob:edited" : base.url, storageKey: base.storageKey } }] });
        if (edited) {
            await expect(submitCanvasToJob("job", "sku", "user")).rejects.toThrow("画布修改已保留");
            expect(sku.activeRevision).toBe(1);
            expect(sku.assets).toContainEqual(base);
            return;
        }
        await submitCanvasToJob("job", "sku", "user");
        const nextBase = sku.assets.find((asset) => asset.stage === "marketing-base" && asset.revision === 2)!;
        const nextPreview = sku.assets.find((asset) => asset.stage === "marketing-preview" && asset.revision === 2)!;
        expect(nextPreview.sourceAssetIds).toEqual([nextBase.id]);
        expect(nextBase.visualFingerprint).toBe(edited ? undefined : base.visualFingerprint);
        expect(sku.compositions.find((item) => item.id === nextPreview.compositionId)?.assetId).toBe(nextPreview.id);
    });
    it("does not mutate changed inputs when an old request completes", async () => {
        mock.edit.mockImplementationOnce(async () => { sku.activeRevision = 2; sku.stage = "white-review"; return [{ dataUrl: "late" }]; });
        await expect(generateContent("job", "sku")).rejects.toThrow("过期");
        expect(sku.stage).toBe("white-review");
        expect(sku.assets).toHaveLength(1);
        expect(mock.normalize).not.toHaveBeenCalled();
    });
    it("requires approval even for explicit white-layout", async () => {
        sku.requirementSelections[0].visualMode = "white-layout";
        expect(buildVisualPlan(job, sku, pack.requirementPresets)).toHaveLength(0);
        await refreshChinesePreviews("job", "sku");
        expect(mock.render.mock.calls[0][0].productImage.id).toBe("white");
        sku.approvals = [];
        await expect(refreshChinesePreviews("job", "sku")).rejects.toThrow("批准");
    });
    it("does not revive legacy counts for an explicitly disabled selection", async () => {
        job.generationConfig.marketingEnabled = false;
        sku.requirementSelections[0].enabled = false;
        await generateContent("job", "sku");
        expect(mock.edit).not.toHaveBeenCalled();
        expect(sku.stage).toBe("ready");
    });
    it("requires white regeneration after output size changes before any paid request", async () => {
        job.generationConfig.outputSpec.size = 1600;
        await expect(generateContent("job", "sku")).rejects.toThrow("重新生成并批准白底图");
        expect(mock.edit).not.toHaveBeenCalled();
    });
    it("sends identity, real product photos, then layout-only references", async () => {
        sku.product.images = [{ id: "photo", name: "real", url: "blob:real", source: "upload" }];
        pack.references = [{ id: "layout", name: "layout", url: "blob:layout", source: "rule-reference", sheet: "", anchor: "", kind: "reference" }];
        sku.requirementSelections[0].referenceIds = [pack.references[0].id];
        await generateContent("job", "sku");
        const [, prompt, refs] = mock.edit.mock.calls[0];
        expect(refs.map((ref: { id: string }) => ref.id)).toEqual(["white", "photo", pack.references[0].id]);
        expect(prompt).toContain("禁止以参考中的竞品");
    });
    it("does not reserve marketing copy whitespace in ordinary scenes", async () => {
        pack.requirementPresets[0].stage = "scene";
        job.generationConfig.marketingEnabled = false;
        job.generationConfig.overlay.logo.applyTo = "custom";
        job.generationConfig.overlay.logo.customStages = ["scene"];
        await generateContent("job", "sku");
        expect(mock.edit.mock.calls[0][1]).not.toContain("留白");
        expect(mock.normalize.mock.calls[0][2]).toBe(mock.state().brands[0]);
        expect(mock.normalize.mock.calls[0][1].overlay.logo.customStages).toEqual(["scene"]);
        expect(mock.normalize.mock.calls[0][3]).toBe("scene");
    });
    it.each([false, true])("can approve a canvas revision after a simple edit (copy changed=%s)", async (copyChanged) => {
        await generateContent("job", "sku");
        const composition = sku.compositions[0];
        composition.width = 1024;
        composition.layers = [{ id: "text", type: "text", name: "营销文案", x: 0, y: 0, width: 600, height: 200, zIndex: 30, opacity: 1, rotation: 0, visible: true, locked: false, content: "文案" }];
        const asset = sku.assets.find((item) => item.compositionId === composition.id)!;
        sku.canvasProjectId = "canvas";
        const metadata = { commerceSkuId: "sku", commerceAssetId: asset.id, commerceCompositionId: composition.id };
        mock.canvas.mockReturnValueOnce({ nodes: [
            { id: "group", type: CanvasNodeType.Group, width: 1024, position: { x: 0, y: 0 }, metadata },
            { id: "text", type: CanvasNodeType.Text, width: 600, height: 200, position: { x: 20, y: 10 }, metadata: { ...metadata, commerceLayerId: "text", content: copyChanged ? "新文案" : "文案" } },
        ] });
        await submitCanvasToJob("job", "sku", "user");
        expect(sku.approvals).toContainEqual(expect.objectContaining({ gate: "white-background", approved: true, assetRevision: 2 }));
        expect(sku.copyZh.m).toBe(copyChanged ? "新文案" : "文案");
        expect(sku.assets.find((item) => item.stage === "marketing-preview" && item.revision === 2)?.prompt).toBe(sku.copyZh.m);
        await expect(approveContent("job", "sku", "user")).resolves.toBeUndefined();
        expect(sku.stage).toBe("localization");
    });
    it("rejects divergent variant copy without advancing the revision", async () => {
        sku.requirementSelections[0].count = 2;
        await generateContent("job", "sku");
        for (const composition of sku.compositions) {
            composition.width = 1024;
            composition.layers = [{ id: "text", type: "text", name: "营销文案", x: 0, y: 0, width: 600, height: 200, zIndex: 30, opacity: 1, rotation: 0, visible: true, locked: false, content: "文案" }];
        }
        const composition = sku.compositions[0];
        const asset = sku.assets.find((item) => item.compositionId === composition.id)!;
        sku.canvasProjectId = "canvas";
        const metadata = { commerceSkuId: "sku", commerceAssetId: asset.id, commerceCompositionId: composition.id };
        mock.canvas.mockReturnValueOnce({ nodes: [
            { id: "group", type: CanvasNodeType.Group, width: 1024, position: { x: 0, y: 0 }, metadata },
            { id: "text", type: CanvasNodeType.Text, width: 600, height: 200, position: { x: 0, y: 0 }, metadata: { ...metadata, commerceLayerId: "text", content: "只改一张" } },
        ] });
        await expect(submitCanvasToJob("job", "sku", "user")).rejects.toThrow("不同文案");
        expect(sku.activeRevision).toBe(1);
    });
    it("rejects replacing an embedded visual without claiming its old source", async () => {
        await generateContent("job", "sku");
        const composition = sku.compositions[0];
        composition.layers = [{ id: "visual", type: "background", name: "需求场景底图（含商品）", x: 0, y: 0, width: 1024, height: 1024, zIndex: 10, opacity: 1, rotation: 0, visible: true, locked: false, content: "data:original" }];
        const asset = sku.assets.find((item) => item.compositionId === composition.id)!;
        sku.canvasProjectId = "canvas";
        mock.canvas.mockReturnValueOnce({ nodes: [{ id: "visual", type: CanvasNodeType.Image, metadata: { commerceSkuId: "sku", commerceAssetId: asset.id, commerceCompositionId: composition.id, commerceLayerId: "visual", content: "data:replacement" } }] });
        const before = JSON.stringify(sku);
        await expect(submitCanvasToJob("job", "sku", "user")).rejects.toThrow("真实来源");
        expect(JSON.stringify(sku)).toBe(before);
    });
});

it.each([false, undefined])("blocks compliance model image input %s before HTTP", async (supportsImageInput) => {
    const fetchSpy = vi.fn();vi.stubGlobal("fetch", fetchSpy);
    const channel = { id: "guard", name: "Guard", baseUrl: "https://example.test", apiKey: "synthetic", apiFormat: "openai", models: [{ name: "text", capability: "text", supportsImageInput }] };
    useServerConfigStore.setState({ serverTeam: { modelConfig: { channels: [channel], defaults: { textModel: "text" }, roles: { complianceModel: "text" } } } as never });
    mock.state().modelRoles.complianceModel = "guard::text";
    sku.assets.push({ ...sku.assets[0], id: "scene", stage: "scene" });
    mock.visionRules.mockReturnValue([{ id: "vision", title: "Vision", severity: "BLOCK", description: "Inspect" }] as never);
    try {
        await runCompliance(job.id, sku.id);
        expect(mock.question).not.toHaveBeenCalled();expect(mock.data).not.toHaveBeenCalled();expect(fetchSpy).not.toHaveBeenCalled();
        expect(sku.checks[0].evidence).toContain(supportsImageInput === false ? "unsupported" : "unknown-capability");
        expect(sku.checks[0].status).toBe("uncertain");
    } finally {useServerConfigStore.setState({serverTeam:null});vi.unstubAllGlobals();}
});
it("discards delayed generation after a real account A-B-A switch", async () => {
    useServerConfigStore.setState({user:{id:101} as never,phase:"ready"});
    const originalAssets = structuredClone(sku.assets);
    mock.edit.mockImplementationOnce(async () => {
        useServerConfigStore.setState({user:{id:202} as never});
        useServerConfigStore.setState({user:{id:101} as never});
        return [{dataUrl:"data:image/png;base64,AA"}];
    });
    try {
        await expect(generateContent(job.id,sku.id)).rejects.toThrow("已忽略过期结果");
        expect(sku.assets).toEqual(originalAssets);
        expect(mock.normalize).not.toHaveBeenCalled();
    } finally {useServerConfigStore.setState({user:null});}
});


it("retains approved manual marketing layout/copy without another paid translation", async () => {
    await generateContent(job.id, sku.id);
    sku.localizedCopy = { "en-US": { m: "My edited favourite colours" } };
    sku.marketingLayoutReview = { revision: sku.activeRevision, signature: marketingReviewSignature(job, sku) };
    sku.approvals.push({ gate: "content", approved: true, assetRevision: sku.activeRevision, reviewer: "user", reviewedAt: "now" });
    mock.question.mockClear(); mock.render.mockClear();
    await localizeAndRender(job.id, sku.id);
    expect(mock.question).not.toHaveBeenCalled(); expect(mock.render).not.toHaveBeenCalled();
    expect(sku.localizedCopy["en-US"]?.m).toBe("My edited favourite colours");
});

it("invalidates saved-layout review shortcut when generation configuration changes", async () => {
    await generateContent(job.id, sku.id);
    sku.marketingLayoutReview = { revision: sku.activeRevision, signature: marketingReviewSignature(job, sku) };
    sku.approvals.push({ gate: "content", approved: true, assetRevision: sku.activeRevision, reviewer: "user", reviewedAt: "now" });
    job.generationConfig.overlay.logo.placement = "off";
    mock.question.mockClear(); mock.question.mockResolvedValue('{"en-US":{"m":"New US"},"id-ID":{"m":"New ID"}}');
    await localizeAndRender(job.id, sku.id);
    expect(mock.question).toHaveBeenCalled();
});
