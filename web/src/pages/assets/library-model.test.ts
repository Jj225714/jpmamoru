import { describe, expect, it, vi } from "vitest";
import type { LibraryAsset } from "@/services/asset-library";
import { AssetLibraryModel, rasterPreview, type LibraryApi } from "./library-model";
const asset: LibraryAsset = { id: "stable-id", ownerId: "A", scope: "personal", name: "image.png", mimeType: "image/png", bytes: 8, sha256: "hash", createdAt: "now", updatedAt: "now", deletedAt: null, thumbnailId: null };
const quota = { limitBytes: 8, usedBytes: 8, maxFileBytes: 20, maxAssets: 10, trashCounts: true };
const api = () => ({ list: vi.fn().mockResolvedValue({ assets: [asset] }), quota: vi.fn().mockResolvedValue(quota), detail: vi.fn().mockResolvedValue({ asset }), content: vi.fn().mockResolvedValue(new Blob(["abc"])), upload: vi.fn().mockResolvedValue({ asset, deduplicated: true }), trash: vi.fn().mockResolvedValue({ asset }), restore: vi.fn().mockResolvedValue({ asset }), audit: vi.fn().mockResolvedValue({ events: [{ action: "create" }], lastSequence: 1, retention: 1000 }) }) satisfies LibraryApi;
describe("asset library state", () => {
    it("reads stable ID/hash, quota and binary through authenticated API", async () => {
        const service = api(), model = new AssetLibraryModel(service, false, true, () => {}); await model.load();
        expect(model.getSnapshot().assets[0]).toMatchObject({ id: "stable-id", sha256: "hash" }); expect(model.getSnapshot().quota?.usedBytes).toBe(8);
        await model.readContent(asset.id); expect(await model.getSnapshot().content?.text()).toBe("abc"); expect(service.detail).toHaveBeenCalledWith(asset.id); model.dispose();
    });
    it("allows duplicate detection at full byte quota and reports server stable ID", async () => {
        const service = api(), model = new AssetLibraryModel(service, false, true, () => {}); await model.load(); await model.upload("again", new Blob(["12345678"]));
        expect(service.upload).toHaveBeenCalledOnce(); expect(model.getSnapshot().notice).toContain("复用稳定 ID：stable-id"); model.dispose();
    });
    it("rejects empty/oversized uploads before sending", async () => {
        const service = api(), model = new AssetLibraryModel(service, false, true, () => {}); await model.load(); await model.upload("empty", new Blob([]));
        expect(service.upload).not.toHaveBeenCalled(); expect(model.getSnapshot().error).toContain("单文件上限"); model.dispose();
    });
    it("read-only cannot mutate even if its method is called directly", async () => {
        const service = api(), model = new AssetLibraryModel(service, false, false, () => {}); await model.load(); await model.upload("x", new Blob(["x"])); await model.mutate(asset.id, "trash");
        expect(service.upload).not.toHaveBeenCalled(); expect(service.trash).not.toHaveBeenCalled(); model.dispose();
    });
    it("clears stale content and lists on revoked permission, keeping unrelated local data untouched", async () => {
        const historical = [{ id: "local", content: "keep" }], service = api(), model = new AssetLibraryModel(service, false, true, () => {});
        await model.load(); await model.readContent(asset.id); service.list.mockRejectedValueOnce(new Error("403 revoked")); await model.load();
        expect(model.getSnapshot()).toMatchObject({ assets: [], detail: null, content: null, quota: null }); expect(historical).toEqual([{ id: "local", content: "keep" }]); model.dispose();
    });
    it("discards delayed account A reads after scope/account disposal", async () => {
        const service = api(); let resolve!: (value: { assets: LibraryAsset[] }) => void;
        service.list.mockReturnValueOnce(new Promise(yes => { resolve = yes; }));
        const model = new AssetLibraryModel(service, false, true, () => {}), read = model.load(); model.dispose(); resolve({ assets: [asset] }); await read; expect(model.getSnapshot().assets).toEqual([]);
    });
    it("uses the session guard again after an asynchronous read", async () => {
        const service = api(); let alive = true;
        service.list.mockImplementationOnce(async () => { alive = false; return { assets: [asset] }; });
        const model = new AssetLibraryModel(service, false, true, () => { if (!alive) throw Error("account changed"); }); await model.load(); expect(model.getSnapshot().assets).toEqual([]); expect(model.getSnapshot().error).toBe("account changed");
    });
    it("restore retains server identity, reloads trash and never uploads", async () => {
        const service = api(), model = new AssetLibraryModel(service, true, true, () => {}); await model.load(); await model.mutate(asset.id, "restore");
        expect(service.restore).toHaveBeenCalledWith(asset.id); expect(service.list).toHaveBeenLastCalledWith(true); expect(service.upload).not.toHaveBeenCalled(); expect(model.getSnapshot().notice).toContain("原资产 ID");
    });
    it("handles quota rejection and uncertain errors without automatic upload retry", async () => {
        const service = api(), model = new AssetLibraryModel(service, false, true, () => {}); await model.load(); service.upload.mockRejectedValueOnce(new Error("413 quota")); await model.upload("new", new Blob(["new"]));
        expect(service.upload).toHaveBeenCalledOnce(); expect(model.getSnapshot().notice).toBe(""); expect(model.getSnapshot().error).toBe("413 quota");
    });
    it("shows confirmed-after-error and audit without raw payload rendering", async () => {
        const service = api(), model = new AssetLibraryModel(service, false, true, () => {}); await model.load(); service.upload.mockResolvedValueOnce({ asset, confirmedAfterError: true }); await model.upload("x", new Blob(["x"]));
        expect(model.getSnapshot().notice).toContain("按内容哈希确认"); await model.readAudit(); expect(model.getSnapshot().audit).toEqual([{ action: "create" }]);
    });
});
it("does not preview active content just because it has image MIME", async () => {
    expect(await rasterPreview(new Blob(["<svg onload='alert(1)'/>"], { type: "image/png" }))).toBeNull();
    expect((await rasterPreview(new Blob([new Uint8Array([0x89, 80, 78, 71, 13, 10, 26, 10])], { type: "application/octet-stream" })))?.type).toBe("image/png");
});

