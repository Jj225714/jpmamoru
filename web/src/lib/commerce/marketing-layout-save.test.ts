import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommerceJob, CommerceSku, CompositionLayer, GeneratedAsset, LayeredComposition } from "@/types/commerce";
import { DEFAULT_COMMERCE_GENERATION_CONFIG } from "./generation-config";
const mocks = vi.hoisted(() => ({ render: vi.fn(), upload: vi.fn(), inspect: vi.fn(), bind: vi.fn(), preset: vi.fn(), valid: true, dispose: vi.fn(), state: {} as Record<string, unknown>, set: vi.fn() }));
vi.mock("@/stores/use-commerce-store", () => ({ useCommerceStore: { getState: () => mocks.state, setState: (patch: Record<string, unknown>) => mocks.set(patch) } }));
vi.mock("@/services/image-storage", () => ({ uploadImage: mocks.upload }));
vi.mock("./request-session", () => ({ captureCommerceRequestSession: () => ({ assertCurrent: () => { if (!mocks.valid) throw new Error("账号已变化"); }, dispose: mocks.dispose }) }));
vi.mock("./marketing-typography", () => ({ freezeCompositionTypography: async (c: unknown) => c, inspectCompositionLayout: mocks.inspect }));
vi.mock("./marketing-layout", () => ({ saveLayoutPreset: mocks.preset }));
vi.mock("./marketing-layout-binding", () => ({ marketingReviewSignature: () => "review-signature", bindCompositionRaster: mocks.bind }));
vi.mock("./template-renderer", () => ({ renderLayeredComposition: mocks.render }));
import { saveMarketingLayout } from "./marketing-layout-save";

const text = (id: string, content: string): CompositionLayer => ({ id, type: "text", name: "营销文案", content, x: 40, y: 700, width: 940, height: 280, zIndex: 30, opacity: 1, rotation: 0, visible: true, locked: false, fontSize: 40 });
const image = (id: string, sourceId: string, role?: "before" | "after"): CompositionLayer => ({ id, type: "background", name: role || "商品", content: "data:image/png;base64," + sourceId, storageKey: sourceId, sourceAssetId: sourceId, comparisonRole: role, x: role === "after" ? 512 : 0, y: 90, width: role ? 512 : 1024, height: 512, zIndex: 10, opacity: 1, rotation: 0, visible: true, locked: false });
function fixture(): CommerceJob {
    const asset = (id: string, stage: GeneratedAsset["stage"], extra: Partial<GeneratedAsset> = {}): GeneratedAsset => ({ id, jobId: "job", skuId: "sku", stage, sequence: 1, revision: 1, title: id, url: "blob:" + id, storageKey: id, width: 1024, height: 1024, bytes: 10, mimeType: "image/png", createdAt: "old", ...extra });
    const comp = (id: string, locale: "en-US" | "en-GB" | undefined, variantKey: string): LayeredComposition => ({ id, jobId: "job", skuId: "sku", assetId: "asset-" + id, requirementId: "req", locale, siteLocale: locale || "en-US", variantKey, revision: 1, width: 1024, height: 1024, layout: "before-after", backgroundColor: "#fff", layers: [image(id + "-before", "before", "before"), image(id + "-after", "after", "after"), text(id + "-text", locale === "en-GB" ? "Colour favourites" : locale === "en-US" ? "Color favorites" : "中文文案")], createdAt: "old", updatedAt: "old" });
    const compositions = [comp("us", "en-US", "red"), comp("gb", "en-GB", "blue"), comp("preview", undefined, "red")];
    const assets = [asset("white", "main-white"), asset("before", "comparison-source", { comparisonRole: "before", comparisonGroupKey: "pair", visualKey: "v-before", visualFingerprint: "f-before" }), asset("after", "comparison-source", { comparisonRole: "after", comparisonGroupKey: "pair", visualKey: "v-after", visualFingerprint: "f-after" }), ...compositions.map(c => asset(c.assetId!, c.locale ? "marketing" : "marketing-preview", { compositionId: c.id, requirementId: c.requirementId, templateId: c.requirementId, locale: c.locale, siteLocale: c.siteLocale, variantKey: c.variantKey, sourceAssetIds: ["before", "after"], visualKey: "visual-" + c.id, visualFingerprint: "fingerprint-" + c.id }))];
    const sku = { id: "sku", activeRevision: 1, stage: "ready", product: { id: "product", sku: "A", images: [{ id: "upload-original", source: "upload", url: "blob:upload" }] }, assets, compositions, requirementSelections: [], selectedTemplateIds: [], copyZh: { req: "中文文案" }, localizedCopy: { "en-US": { req: "Color favorites" }, "en-GB": { req: "Colour favourites" } }, marketingLayouts: [{ id: "existing", name: "existing", width: 1024, height: 1024, layers: [] }], approvals: [{ gate: "white-background", approved: true, reviewer: "r", reviewedAt: "old", assetRevision: 1 }, { gate: "content", approved: true, reviewer: "r", reviewedAt: "old", assetRevision: 1 }], checks: [{ id: "check", severity: "BLOCK", status: "violation", reviewedAsFalsePositive: true }] } as unknown as CommerceSku;
    return { id: "job", name: "job", status: "ready", generationConfig: structuredClone(DEFAULT_COMMERCE_GENERATION_CONFIG), policyPackId: "pack", policyVersion: 1, brandProfileId: "brand", skus: [sku], locales: ["en-US", "en-GB"], platform: "shopee", createdAt: "old", updatedAt: "old" };
}
const job = () => (mocks.state.jobs as CommerceJob[])[0];
const sku = () => job().skus[0];
const draft = (id = "us") => ({ ...structuredClone(sku().compositions.find(c => c.id === id)!), layoutVersion: 2 as const });
beforeEach(() => {
    vi.clearAllMocks(); mocks.valid = true;
    mocks.state = { jobs: [fixture()], policyPacks: [{ id: "pack", version: 1 }], brands: [{ id: "brand" }], audit: [] };
    mocks.set.mockImplementation(patch => { mocks.state = { ...mocks.state, ...patch }; });
    mocks.render.mockResolvedValue(new Blob(["new pixels"], { type: "image/png" }));
    mocks.upload.mockResolvedValue({ url: "blob:new", storageKey: "new-storage", width: 1024, height: 1024, bytes: 10, mimeType: "image/png" });
    mocks.inspect.mockResolvedValue({ errors: [], warnings: [] });
    mocks.bind.mockResolvedValue({ layoutDigest: "layout-hash", rasterDigest: "raster-hash" });
    mocks.preset.mockReturnValue({ id: "preset", name: "Custom", width: 1024, height: 1024, layers: [] });
});

describe("marketing layout save", () => {
    it("commits a new revision with history, separate locale/variant lineage and paired source bindings", async () => {
        const previous = sku(), edited = draft(); edited.layers[2].fontSize = 34;
        await saveMarketingLayout("job", "sku", "us", edited, "operator", { presetName: "Custom" });
        const next = sku(); expect(next.activeRevision).toBe(2); expect(next.assets.filter(a => a.revision === 1)).toEqual(previous.assets); expect(next.compositions.filter(c => c.revision === 1)).toEqual(previous.compositions);
        const current = next.assets.filter(a => a.revision === 2), compositions = next.compositions.filter(c => c.revision === 2);
        expect(current).toHaveLength(previous.assets.length); expect(compositions).toHaveLength(3);
        for (const c of compositions) {
            const a = current.find(a => a.id === c.assetId)!; expect(a.compositionId).toBe(c.id); expect(a.locale).toBe(c.locale); expect(a.variantKey).toBe(c.variantKey); expect(a.siteLocale).toBe(c.siteLocale);
            expect(a.sourceAssetIds).toEqual(c.layers.filter(l => l.sourceAssetId).map(l => l.sourceAssetId));
            expect(a.sourceAssetIds?.map(id => current.find(a => a.id === id)?.comparisonRole)).toEqual(["before", "after"]);
        }
        const changed = current.find(a => a.locale === "en-US")!; expect(changed).toMatchObject({ storageKey: "new-storage", layoutDigest: "layout-hash", rasterDigest: "raster-hash", visualKey: "visual-us", visualFingerprint: "fingerprint-us", sequence: 1 });
        expect(current.find(a => a.locale === "en-GB")!.storageKey).toBe("asset-gb");
        expect(next.product).toBe(previous.product); expect(next.product.images[0].id).toBe("upload-original");
        expect(next.approvals).toEqual([{ ...previous.approvals[0], assetRevision: 2 }]); expect(next.checks).toEqual([]); expect(next.stage).toBe("content-review"); expect(job().status).toBe("waiting-review"); expect(next.marketingLayouts?.map(p => p.id)).toEqual(["existing", "preset"]);
        expect(mocks.set).toHaveBeenCalledOnce(); expect(mocks.dispose).toHaveBeenCalledOnce();
    });
    it("updates canonical localized copy without changing another language", async () => {
        const edited = draft(); edited.layers[2].content = "New color favorites";
        await saveMarketingLayout("job", "sku", "us", edited, "r");
        expect(sku().localizedCopy["en-US"]?.req).toBe("New color favorites"); expect(sku().localizedCopy["en-GB"]?.req).toBe("Colour favourites"); expect(sku().assets.find(a => a.revision === 2 && a.locale === "en-US")!.prompt).toBe("New color favorites");
    });
    it("invalidates final translations when Chinese copy changes, keeping prior history", async () => {
        const edited = draft("preview"); edited.layers[2].content = "新的中文文案";
        await saveMarketingLayout("job", "sku", "preview", edited, "r");
        expect(sku().copyZh.req).toBe("新的中文文案"); expect(sku().localizedCopy["en-US"]?.req).toBeUndefined(); expect(sku().localizedCopy["en-GB"]?.req).toBeUndefined();
        expect(sku().assets.filter(a => a.revision === 2 && a.stage === "marketing")).toEqual([]); expect(sku().compositions.filter(c => c.revision === 2).map(c => c.locale)).toEqual([undefined]); expect(sku().assets.filter(a => a.revision === 1 && a.stage === "marketing")).toHaveLength(2);
    });
    it.each(["content", "sourceAssetId", "comparisonRole", "visible"])("rejects source tampering: %s", async key => {
        const edited = draft(); Object.assign(edited.layers[0], { [key]: key === "visible" ? false : "tampered" });
        await expect(saveMarketingLayout("job", "sku", "us", edited, "r")).rejects.toThrow("来源图层"); expect(mocks.render).not.toHaveBeenCalled(); expect(mocks.set).not.toHaveBeenCalled();
    });
    it("rejects foreign composition and duplicate layer identity", async () => {
        const edited = draft(); edited.siteLocale = "en-GB";
        await expect(saveMarketingLayout("job", "sku", "us", edited, "r")).rejects.toThrow("当前任务版本");
        const duplicate = draft(); duplicate.layers[1].id = duplicate.layers[0].id;
        await expect(saveMarketingLayout("job", "sku", "us", duplicate, "r")).rejects.toThrow("图层结构"); expect(mocks.set).not.toHaveBeenCalled();
    });
    it("blocks safety errors without rendering or mutating", async () => {
        mocks.inspect.mockResolvedValueOnce({ errors: ["文案溢出"], warnings: [] });
        await expect(saveMarketingLayout("job", "sku", "us", draft(), "r")).rejects.toThrow("溢出"); expect(mocks.render).not.toHaveBeenCalled(); expect(mocks.set).not.toHaveBeenCalled();
    });
    it.each(["session", "sku", "in-place-sku", "policy", "brand", "config"])("rejects stale %s after rendering and keeps edits elsewhere", async kind => {
        const edited = draft(); mocks.render.mockImplementationOnce(async () => {
            if (kind === "session") mocks.valid = false;
            if (kind === "sku") job().skus = [{ ...sku(), stageMessage: "other edit" }];
            if (kind === "in-place-sku") sku().stageMessage = "in-place edit";
            if (kind === "policy") mocks.state.policyPacks = [{ id: "changed" }];
            if (kind === "brand") mocks.state.brands = [{ id: "changed" }];
            if (kind === "config") job().generationConfig = { ...job().generationConfig, marketingEnabled: !job().generationConfig.marketingEnabled };
            return new Blob(["new"]);
        });
        await expect(saveMarketingLayout("job", "sku", "us", edited, "r")).rejects.toThrow("变化"); expect(mocks.set).not.toHaveBeenCalled(); expect(sku().activeRevision).toBe(1); expect(mocks.dispose).toHaveBeenCalledOnce();
    });
    it("blocks conflicting canonical copies across variants rather than silently changing other images", async () => {
        const second = { ...structuredClone(sku().compositions[0]), id: "us2", variantKey: "blue" }; sku().compositions.push(second);
        const edited = draft(); edited.layers[2].content = "Different copy";
        await expect(saveMarketingLayout("job", "sku", "us", edited, "r")).rejects.toThrow("先统一文案"); expect(mocks.set).not.toHaveBeenCalled();
    });
    it("keeps unbound compositions and external upload references while only remapping current generated IDs", async () => {
        const extra = { ...structuredClone(sku().compositions[0]), id: "unbound", assetId: undefined, requirementId: "other", layers: [image("external-layer", "upload-original"), text("external-text", "External")] };
        sku().compositions.push(extra);
        await saveMarketingLayout("job", "sku", "us", draft(), "r");
        const currentExtra = sku().compositions.find(c => c.revision === 2 && c.requirementId === "other")!;
        expect(currentExtra).toBeDefined(); expect(currentExtra.layers[0].sourceAssetId).toBe("upload-original"); expect(currentExtra.layers[0].content).toBe(extra.layers[0].content);
    });
    it("does not invent white approval and does not commit when uploading fails", async () => {
        sku().approvals = [];
        mocks.upload.mockRejectedValueOnce(new Error("image storage full"));
        await expect(saveMarketingLayout("job", "sku", "us", draft(), "r")).rejects.toThrow("image storage full"); expect(mocks.set).not.toHaveBeenCalled();
        await saveMarketingLayout("job", "sku", "us", draft(), "r");
        expect(sku().stage).toBe("white-review"); expect(sku().approvals).toEqual([]);
    });
    it("waits for persistence and restores the prior state if persistence fails without intervening edits", async () => {
        const previous = sku(); mocks.set.mockImplementationOnce(patch => { mocks.state = { ...mocks.state, ...patch }; return Promise.reject(new Error("disk full")); });
        await expect(saveMarketingLayout("job", "sku", "us", draft(), "r")).rejects.toThrow("disk full"); expect(sku()).toBe(previous); expect(mocks.set).toHaveBeenCalledTimes(2);
    });
});
