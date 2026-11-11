import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@/services/image-storage", () => ({ uploadImage: vi.fn(), resolveImageUrl: vi.fn() }));
import { uploadImage, resolveImageUrl } from "@/services/image-storage";
import { captureGenerationInfo, restoreGenerationInput } from "./generation-info";
import type { Asset } from "@/stores/use-asset-store";
beforeEach(() => { vi.resetAllMocks(); vi.mocked(uploadImage).mockResolvedValue({ storageKey: "image:saved" } as Awaited<ReturnType<typeof uploadImage>>); vi.mocked(resolveImageUrl).mockResolvedValue("blob:fresh"); });
it.each(["image", "canvas"] as const)("roundtrips %s metadata and references without credentials or blob dependency", async (kind) => {
    const parameters = { size: "1:1", quality: "high", count: "1", apiKey: "secret", channels: [{ apiKey: "nested-secret" }] };
    const info = await captureGenerationInfo({ prompt: "original", model: "channel::gpt-image-1", parameters, references: [{ id: "r", name: "reference", type: "image/png", dataUrl: "blob:expired", storageKey: "image:stable" }], generatedAt: "2026-10-25T00:00:00Z", source: { kind, nodeId: kind === "canvas" ? "node" : undefined, taskId: "task" } });
    const saved = JSON.stringify(info);
    expect(saved).not.toContain("secret"); expect(saved).not.toContain("blob:"); expect(uploadImage).not.toHaveBeenCalled();
    const input = await restoreGenerationInput(JSON.parse(saved));
    expect(resolveImageUrl).toHaveBeenCalledWith("image:stable", "");
    input.prompt = "edited"; input.references[0].name = "edited"; input.parameters.size = "2:3";
    expect(info.prompt).toBe("original"); expect(info.references[0].name).toBe("reference"); expect(info.parameters.size).toBe("1:1");
});
it("persists a reference without a storage key before saving the asset", async () => {
    const info = await captureGenerationInfo({ prompt: "p", model: "m", parameters: {}, references: [{ id: "r", name: "r", type: "image/png", dataUrl: "blob:live" }], source: { kind: "image" } });
    expect(uploadImage).toHaveBeenCalledWith("blob:live"); expect(info.references[0].storageKey).toBe("image:saved");
});
it("keeps old assets valid without generation metadata", () => {
    const asset: Asset = { id: "old", kind: "text", title: "old", coverUrl: "", tags: [], createdAt: "", updatedAt: "", data: { content: "old" } };
    expect(JSON.parse(JSON.stringify(asset)).generation).toBeUndefined();
});
it("does not silently reuse a lost persisted reference", async () => {
    vi.mocked(resolveImageUrl).mockResolvedValue("");
    await expect(restoreGenerationInput({ version: 1, prompt: "p", model: "m", parameters: {}, references: [{ id: "r", name: "r", type: "image/png", storageKey: "image:lost" }], source: { kind: "canvas" } })).rejects.toThrow("重新上传");
});
