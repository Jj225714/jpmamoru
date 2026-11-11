import { beforeEach, expect, it, vi } from "vitest";
const fakes = vi.hoisted(() => ({ migrate: vi.fn(), blob: vi.fn(), guard: vi.fn(), libraryId: vi.fn().mockResolvedValue("stable-browser-library") }));
vi.mock("@/stores/use-asset-store", () => ({ getLocalAssetLibraryId: fakes.libraryId }));
vi.mock("@/services/image-storage", () => ({ getImageBlob: fakes.blob }));
vi.mock("@/services/file-storage", () => ({ getMediaBlob: fakes.blob }));
vi.mock("@/services/membership-library", () => ({ librarySession: () => fakes.guard, LibraryError: class extends Error { constructor(public status: number, text: string) { super(text); } } }));
vi.mock("@/services/asset-library", async () => ({ migrateLibraryAsset: fakes.migrate, mapLegacyAssetMetadata: (await import("@/services/asset-metadata")).mapLegacyAssetMetadata }));
import type { Asset } from "@/stores/use-asset-store";
import { migrateLocalAsset } from "./library-migration";
const generated = (): Asset => ({ id: "old-local", title: "generated", kind: "image", tags: [], coverUrl: "", createdAt: "", updatedAt: "", data: { dataUrl: "", storageKey: "main", width: 10, height: 10, bytes: 1, mimeType: "image/png" }, generation: { version: 1, prompt: "test", model: "gpt-image-2", parameters: { size: "1024x1024", quality: "high" }, references: [{ id: "r", name: "ref", storageKey: "reference", type: "image/png" }], source: { kind: "image", taskId: "task-1" } } });
beforeEach(() => { vi.clearAllMocks(); fakes.guard.mockImplementation(() => {}); fakes.blob.mockResolvedValue(new Blob(["image"], { type: "image/png" })); fakes.migrate.mockResolvedValue({ asset: { id: "00000000-0000-4000-8000-000000000001" }, verified: true, receiptKey: "receipt" }); });
it("copies references first and passes stable library/local IDs without mutating the original", async () => {
    const asset = generated(), before = structuredClone(asset);
    const result = await migrateLocalAsset({ scope: "personal" }, asset);
    expect(result.verified).toBe(true); expect(fakes.migrate).toHaveBeenCalledTimes(2);
    expect(fakes.migrate.mock.calls[0][1].localId).toBe("reference:reference");
    expect(fakes.migrate.mock.calls[1][1]).toMatchObject({ libraryId: "stable-browser-library", localId: "old-local", metadata: { generation: { prompt: "test" }, referenceIds: ["00000000-0000-4000-8000-000000000001"] } });
    expect(asset).toEqual(before);
});
it("rejects incompatible provenance before uploading references instead of silently dropping it", async () => {
    const asset = generated(); asset.generation!.parameters.size = "bogus";
    await expect(migrateLocalAsset({ scope: "personal" }, asset)).rejects.toThrow(); expect(fakes.migrate).not.toHaveBeenCalled(); expect(asset.generation!.parameters.size).toBe("bogus");
});
it("stops remaining writes after changing the selected container", async () => {
    let current = true; fakes.migrate.mockImplementationOnce(async () => { current = false; return { asset: { id: "00000000-0000-4000-8000-000000000001" } }; });
    const asset = generated(); await expect(migrateLocalAsset({ scope: "personal" }, asset, () => current)).rejects.toThrow("范围已切换"); expect(fakes.migrate).toHaveBeenCalledOnce(); expect(asset.id).toBe("old-local");
});
it("keeps local data when receipt verification fails or permission changes", async () => {
    fakes.migrate.mockRejectedValueOnce(new Error("permission revoked")); const asset = generated(), before = structuredClone(asset);
    await expect(migrateLocalAsset({ scope: "personal" }, asset)).rejects.toThrow("permission revoked"); expect(asset).toEqual(before);
});
it("migrates text using original content without copying arbitrary provider metadata", async () => {
    const asset: Asset = { id: "text", title: "note", kind: "text", tags: [], coverUrl: "", createdAt: "", updatedAt: "", data: { content: "hello" }, metadata: { apiKey: "must-not-copy" } };
    await migrateLocalAsset({ scope: "personal" }, asset); const input = fakes.migrate.mock.calls[0][1];
    expect(await input.blob.text()).toBe("hello"); expect(JSON.stringify(input.metadata)).not.toContain("must-not-copy"); expect(input.metadata.kind).toBe("original");
});

it("preserves standard channel selector/defaults through the closed compatibility adapter", async () => {
    const asset = generated(); asset.generation!.model = "channel::image-v1"; asset.generation!.parameters = { size: "1:1", quality: "auto", background: "" };
    await migrateLocalAsset({ scope: "personal" }, asset);
    expect(fakes.migrate.mock.calls[1][1].metadata.generation).toMatchObject({ model: "channel::image-v1", parameters: { requestedSize: "1:1", quality: "auto", background: "unspecified" } });
    expect(asset.generation!.parameters.background).toBe("");
});
