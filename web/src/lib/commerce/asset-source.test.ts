import { beforeEach, expect, it, vi } from "vitest";
import type { AiConfig } from "@/stores/use-config-store";
import type { GeneratedAsset } from "@/types/commerce";
const mocks = vi.hoisted(() => ({ upload: vi.fn(), resolve: vi.fn(), add: vi.fn(), hydrated: true }));
vi.mock("@/services/image-storage", () => ({ uploadImage: mocks.upload, resolveImageUrl: mocks.resolve }));
vi.mock("@/stores/use-asset-store", () => ({ useAssetStore: { getState: () => ({ hydrated: mocks.hydrated, addAsset: mocks.add }) } }));
import { captureCommerceSource, saveCommerceAsset } from "./asset-source";
import { restoreGenerationInput } from "@/pages/assets/generation-info";
beforeEach(() => { vi.clearAllMocks(); mocks.hydrated = true; mocks.upload.mockResolvedValue({ storageKey: "persisted", url: "blob:saved" }); mocks.resolve.mockResolvedValue("blob:restored"); mocks.add.mockReturnValue("asset-id"); });
const asset = (): GeneratedAsset => ({ id: "a", jobId: "job", skuId: "sku", stage: "scene", sequence: 1, revision: 1, title: "scene", url: "blob:old", storageKey: "output-key", width: 1024, height: 1024, bytes: 10, mimeType: "image/png", createdAt: "then" });

it("captures only request parameters, persists ephemeral references and restores editable inputs after JSON reload", async () => {
    const generation = await captureCommerceSource("job", "真实提示词", { model: "channel::image", size: "1:1", count: "1", quality: "high", apiKey: "never-store" } as AiConfig, [{ id: "ref", name: "实拍", type: "image/png", dataUrl: "data:image/png;base64,AA" }]);
    expect(generation.references[0].storageKey).toBe("persisted");
    expect(JSON.stringify(generation)).not.toContain("never-store");
    const original = { ...asset(), generation };
    const before = JSON.stringify(original);
    await saveCommerceAsset(JSON.parse(before), "SKU-01", true);
    const saved = mocks.add.mock.calls[0][0];
    expect(saved.metadata).toMatchObject({ taskId: "job", skuId: "sku", sku: "SKU-01", generatedAt: "then" });
    const restored = await restoreGenerationInput(JSON.parse(JSON.stringify(saved.generation)));
    expect(restored).toMatchObject({ prompt: "真实提示词", model: "channel::image", parameters: { quality: "high", size: "1:1" } });
    restored.prompt = "另一个任务";
    expect(JSON.stringify(original)).toBe(before);
});
it("fails before saving when references cannot be made persistent or restored", async () => {
    mocks.upload.mockResolvedValue({ url: "blob:ephemeral" });
    await expect(captureCommerceSource("job", "p", { model: "m" } as AiConfig, [{ id: "r", name: "r", type: "image/png", dataUrl: "blob:x" }])).rejects.toThrow("持久保存");
    const generation = await captureCommerceSource("job", "p", { model: "m" } as AiConfig, [{ id: "r", name: "r", type: "image/png", storageKey: "missing", dataUrl: "" }]);
    mocks.resolve.mockResolvedValue("");
    await expect(saveCommerceAsset({ ...asset(), generation }, "SKU", true)).rejects.toThrow("重新上传");
    expect(mocks.add).not.toHaveBeenCalled();
});
it("saves historical images without inventing provenance but refuses one-click restoration", async () => {
    await saveCommerceAsset(asset(), "old");
    expect(mocks.add.mock.calls[0][0].generation).toBeUndefined();
    await expect(saveCommerceAsset(asset(), "old", true)).rejects.toThrow("没有完整模型生成来源");
});
