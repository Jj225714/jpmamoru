import { bindCompositionRaster } from "./marketing-layout-binding";
import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@/services/server-config", () => ({ useServerConfigStore: { getState: () => ({ serverTeam: null }) } }));
import { createBuiltInPolicyPack, createDefaultBrand } from "./defaults";
import { cloneGenerationConfig, DEFAULT_COMMERCE_GENERATION_CONFIG } from "./generation-config";
import { runDeterministicChecks } from "./policy-engine";
import type { CommerceJob, CommerceSku, GeneratedAsset } from "@/types/commerce";

vi.mock("./marketing-typography", () => ({ inspectCompositionLayout: async () => ({errors:[],warnings:[]}), freezeCompositionTypography: async (c: unknown) => c }));
const mocks = vi.hoisted(() => ({ zip: vi.fn(), blob: vi.fn(), state: vi.fn(), fit: vi.fn() }));
vi.mock("./export-image", () => ({ fitExportImage: mocks.fit }));
vi.mock("@/stores/use-commerce-store", () => ({ useCommerceStore: { getState: mocks.state } }));
vi.mock("@/stores/canvas/use-canvas-store", () => ({ useCanvasStore: { getState: vi.fn() } }));
vi.mock("@/lib/canvas/canvas-node-factory", () => ({ createCanvasNode: vi.fn() }));
vi.mock("@/stores/use-config-store", () => ({ useConfigStore: { getState: vi.fn() }, resolveModelForCapability: vi.fn() }));
vi.mock("@/services/api/image", () => ({ requestEdit: vi.fn(), requestImageQuestion: vi.fn() }));
vi.mock("@/lib/zip", () => ({ createZip: mocks.zip }));
vi.mock("@/services/image-storage", () => ({ getImageBlob: mocks.blob }));
vi.mock("@/lib/commerce/template-renderer", () => ({ renderCompositionLayerPng: vi.fn() }));
vi.mock("@/lib/commerce/policy-engine", async (original) => ({ ...await original<typeof import("./policy-engine")>(), runAssetContentChecks: async () => [] }));
import { estimateCommerceExport, exportCommerceJob } from "./export";
import { markCheckFalsePositive } from "./pipeline";

beforeEach(() => { vi.clearAllMocks(); mocks.fit.mockReset().mockImplementation(async (blob) => blob); mocks.blob.mockResolvedValue(new Blob(["image"])); mocks.zip.mockResolvedValue(new Blob()); });

function fixture() {
    const brand = createDefaultBrand();
    const pack = createBuiltInPolicyPack();
    pack.requirementPresets = []; pack.rules = [];
    const white: GeneratedAsset = { id: "white", jobId: "job", skuId: "sku", stage: "main-white", sequence: 1, revision: 1, title: "white", url: "white", storageKey: "white", width: 1024, height: 1024, bytes: 20, mimeType: "image/jpeg", createdAt: "now" };
    const sku: CommerceSku = { id: "sku", product: { id: "p", sku: "SKU", productType: "", name: "", brandName: "", category: "", audience: "", description: "", size: "", images: [], imageUrls: [], extraFields: {}, verifiedFacts: {}, factsConfirmed: true, imageStatus: "ready" }, stage: "ready", assets: [white, { ...white, id: "base", stage: "marketing-base", url: "base", storageKey: "base" }], selectedTemplateIds: [], requirementSelections: [], compositions: [], copyZh: {}, localizedCopy: {}, approvals: [{ gate: "white-background", approved: true, assetRevision: 1, reviewer: "user", reviewedAt: "now" }], checks: [], activeRevision: 1 };
    const config = cloneGenerationConfig(DEFAULT_COMMERCE_GENERATION_CONFIG);
    config.assetCounts = { scene: 0, detail: 0, "usage-size": 0, "detail-white": 0 }; config.marketingEnabled = false; config.delivery = "flattenedOnly";
    const job: CommerceJob = { id: "job", name: "Job", visualPipelineVersion: 2, platform: "shopee", locales: ["en-US"], generationConfig: config, skus: [sku], status: "ready", createdAt: "now", updatedAt: "now" };
    return { job, sku, brand, pack };
}

it("estimates current final assets across SKUs without claiming codec precision", () => {
    const { job, sku } = fixture();
    sku.assets.push({ ...sku.assets[0], revision: 0, bytes: 999 });
    const second = structuredClone(sku);
    second.assets[0].bytes = 0;
    job.skus.push(second);
    expect(estimateCommerceExport(job)).toEqual({ count: 2, unknownCount: 1, sourceBytes: 20, deliveredCeilingBytes: 4 * 1024 * 1024 });
});

it("exports final files/counts only, while keeping source lineage in the report", async () => {
    const { job, pack, brand } = fixture();
    await exportCommerceJob(job, pack, brand);
    const files = mocks.zip.mock.calls[0][0] as Array<{ name: string; data: string }>;
    expect(files.filter((file) => file.name.endsWith(".jpg"))).toHaveLength(1);
    expect(mocks.blob).toHaveBeenCalledTimes(1);
    const report = JSON.parse(files.find((file) => file.name.endsWith("compliance-report.json"))!.data);
    expect(report.skus[0]).toMatchObject({ expectedAssetCount: 1, actualAssetCount: 1 });
    expect(report.skus[0].visualSources).toHaveLength(2);
});

it.each(["image/png", "image/jpeg", "image/webp"])("writes actual %s bytes and extension into the delivery manifest", async (type) => {
    const { job, pack, brand } = fixture();
    const snapshot = JSON.stringify(job);
    mocks.fit.mockResolvedValue(new Blob(["1234567"], { type }));
    await exportCommerceJob(job, pack, brand, { compressionFormat: "webp", compressionQuality: "balanced" });
    const files = mocks.zip.mock.calls[0][0] as Array<{ name: string; data: string }>;
    expect(files.find((file) => file.name.endsWith("manifest.csv"))!.data).toContain('"7"');
    expect(files.some((file) => file.name.endsWith(type === "image/jpeg" ? ".jpg" : type === "image/png" ? ".png" : ".webp"))).toBe(true);
    expect(mocks.fit).toHaveBeenCalledWith(expect.any(Blob), 2 * 1024 * 1024, "webp", "balanced");
    expect(JSON.stringify(job)).toBe(snapshot);
});

it("does not create a partial ZIP when a later SKU cannot fit the limit", async () => {
    const { job, sku, pack, brand } = fixture();
    job.skus.push({ ...structuredClone(sku), id: "second", product: { ...sku.product, sku: "SECOND" } });
    mocks.fit.mockResolvedValueOnce(new Blob(["ok"])).mockRejectedValueOnce(new Error("无法达到上限"));
    await expect(exportCommerceJob(job, pack, brand)).rejects.toThrow("SECOND / white：无法达到上限");
    expect(mocks.zip).not.toHaveBeenCalled();
});

it("packages all SKUs only after every image passes export preparation", async () => {
    const { job, sku, pack, brand } = fixture();
    job.skus.push({ ...structuredClone(sku), id: "second", product: { ...sku.product, sku: "SECOND" } });
    await exportCommerceJob(job, pack, brand);
    expect(mocks.fit).toHaveBeenCalledTimes(2);
    const files = mocks.zip.mock.calls[0][0] as Array<{ name: string }>;
    expect(files.filter((file) => file.name.endsWith(".jpg"))).toHaveLength(2);
    expect(files.some((file) => file.name.includes("/SECOND/"))).toBe(true);
});

it("keeps en-US and en-GB SKU site names in paths and manifest", async () => {
    const { job, sku, pack, brand } = fixture();
    job.locales = ["en-US", "en-GB"];
    sku.assets[0].siteLocale = "en-US";
    const second = structuredClone(sku);
    second.product.sku = "GB-SKU";
    second.assets[0].siteLocale = "en-GB";
    job.skus.push(second);
    await exportCommerceJob(job, pack, brand);
    const files = mocks.zip.mock.calls[0][0] as Array<{ name: string; data: string }>;
    expect(files.some((file) => file.name.includes("/SKU/en-US/"))).toBe(true);
    expect(files.some((file) => file.name.includes("/GB-SKU/en-GB/"))).toBe(true);
    const manifest = files.find((file) => file.name.endsWith("manifest.csv"))!.data;
    expect(manifest).toContain('"GB-SKU","en-GB"');
    expect(manifest).toContain('"SKU","en-US"');
});

it("allows export-time compression of stale oversized metadata instead of trusting it", async () => {
    const { job, sku, pack, brand } = fixture();
    sku.assets[0].bytes = 3 * 1024 * 1024;
    await expect(exportCommerceJob(job, pack, brand)).resolves.toBeDefined();
    expect(mocks.fit).toHaveBeenCalledOnce();
});

it("honors reviewed manual evidence, but never waives changed evidence or dimensions", async () => {
    const { job, sku, pack, brand } = fixture();
    pack.rules = [{ id: "manual", title: "Confirm", description: "manual rule", severity: "BLOCK", priority: 1, countries: [], platforms: [], categories: [], locales: [], assetStages: [], phase: "post-render", checker: "manual", source: { fileName: "", sheet: "", range: "" } }];
    sku.checks = runDeterministicChecks(job, sku, pack, brand);
    sku.stage = "compliance";
    mocks.state.mockReturnValue({ jobs: [job], addAudit: vi.fn(), updateJob: (_id: string, patch: Partial<CommerceJob>) => Object.assign(job, patch), updateSku: (_job: string, _sku: string, patch: Partial<CommerceSku> | ((sku: CommerceSku) => CommerceSku)) => Object.assign(sku, typeof patch === "function" ? patch(sku) : patch) });
    const evidence = sku.checks[0].evidence;
    markCheckFalsePositive(job.id, sku.id, sku.checks[0].id, "owner");
    expect(sku.checks[0].evidence).toBe(evidence);
    expect(sku.stage).toBe("ready");
    await expect(exportCommerceJob(job, pack, brand)).resolves.toBeDefined();
    pack.rules[0].description = "changed evidence";
    await expect(exportCommerceJob(job, pack, brand)).rejects.toThrow("复检");
    pack.rules = []; sku.assets[0].width = 1;
    await expect(exportCommerceJob(job, pack, brand)).rejects.toThrow("复检");
});

it("rejects a stale layout or changed raster before exporting a v2 composition", async () => {
    const { job, sku, pack, brand } = fixture();
    const composition = { id: "comp", jobId: job.id, skuId: sku.id, requirementId: "m", revision: 1, width: 1024, height: 1024, backgroundColor: "white", layoutVersion: 2 as const, layout: "single-hero" as const, layers: [], createdAt: "now", updatedAt: "now" };
    sku.compositions=[composition]; const blob=new Blob(["saved-raster"]);mocks.blob.mockResolvedValue(blob);
    Object.assign(sku.assets[0],{compositionId:"comp",...await bindCompositionRaster(composition,blob)});
    await expect(exportCommerceJob(job,pack,brand)).resolves.toBeInstanceOf(Blob);
    composition.backgroundColor="black";
    await expect(exportCommerceJob(job,pack,brand)).rejects.toThrow("布局与保存成图不一致");
    composition.backgroundColor="white"; mocks.blob.mockResolvedValue(new Blob(["different-raster"]));
    await expect(exportCommerceJob(job,pack,brand)).rejects.toThrow("布局与保存成图不一致");
});
