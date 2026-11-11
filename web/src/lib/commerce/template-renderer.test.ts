import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/services/image-storage", () => ({ imageToDataUrl: vi.fn(), uploadImage: vi.fn() }));
import { createComposition, normalizeOutputImage } from "./template-renderer";
import { imageToDataUrl, uploadImage } from "@/services/image-storage";
import { createDefaultBrand } from "./defaults";
import { cloneGenerationConfig, DEFAULT_COMMERCE_GENERATION_CONFIG } from "./generation-config";
import type { MarketingLayoutPreset } from "@/types/commerce";
afterEach(() => vi.unstubAllGlobals());

it("retains British copy and locale in the editable marketing composition", () => {
    const result = createComposition({ jobId: "job", skuId: "gb", revision: 1, locale: "en-GB", siteLocale: "en-GB", requirementId: "m", copy: "Organise by colour", productData: "data:base", logoData: "", brand: createDefaultBrand(), generationConfig: DEFAULT_COMMERCE_GENERATION_CONFIG, layout: "single-hero", size: 1024, stage: "marketing", singleVisual: true });
    expect(result.locale).toBe("en-GB");
    expect(result.siteLocale).toBe("en-GB");
    expect(result.layers.some((layer) => layer.content === "Organise by colour")).toBe(true);
});

describe("normalization overlays", () => {
    it.each(["main-white", "detail-white"] as const)("preserves centered product whitespace for %s", async (stage) => {
        const drawImage = vi.fn();
        vi.stubGlobal("Image", class {
            naturalWidth = 1200; naturalHeight = 900; onload?: () => void;
            set src(_url: string) { queueMicrotask(() => this.onload?.()); }
        });
        vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage, fillRect: vi.fn() }), toBlob: (callback: (blob: Blob) => void) => callback(new Blob(["png"], { type: "image/png" })) }) });
        vi.mocked(imageToDataUrl).mockResolvedValue("data:product");
        vi.mocked(uploadImage).mockResolvedValue({ url: "white", width: 1024, height: 1024, bytes: 3, mimeType: "image/png" });
        const config = cloneGenerationConfig(DEFAULT_COMMERCE_GENERATION_CONFIG);
        config.outputSpec.format = "png";
        await normalizeOutputImage({ url: "product", width: 1200, height: 900, bytes: 3, mimeType: "image/png" }, config, undefined, stage);
        expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 128, 1024, 768);
    });
    it.each(["scene", "marketing-base", "comparison-source"] as const)("never pads a non-square %s", async (stage) => {
        vi.stubGlobal("Image", class {
            naturalWidth = 1200; naturalHeight = 900; onload?: () => void;
            set src(_url: string) { queueMicrotask(() => this.onload?.()); }
        });
        const createElement = vi.fn();
        vi.stubGlobal("document", { createElement });
        vi.mocked(imageToDataUrl).mockResolvedValue("data:landscape");
        await expect(normalizeOutputImage({ url: "landscape", width: 1200, height: 900, bytes: 3, mimeType: "image/jpeg" }, DEFAULT_COMMERCE_GENERATION_CONFIG, undefined, stage)).rejects.toThrow("不会再自动填充白边");
        expect(createElement).not.toHaveBeenCalled();
    });
    it.each(["scene", "marketing-base", "comparison-source"] as const)("honors the overlay boundary for %s", async (stage) => {
        const drawImage = vi.fn();
        vi.stubGlobal("Image", class {
            naturalWidth = 1024; naturalHeight = 1024; onload?: () => void;
            set src(_url: string) { queueMicrotask(() => this.onload?.()); }
        });
        vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage, fillRect: vi.fn(), save: vi.fn(), restore: vi.fn() }), toBlob: (callback: (blob: Blob) => void) => callback(new Blob(["png"], { type: "image/png" })) }) });
        vi.mocked(imageToDataUrl).mockImplementation(async ({ url }) => url || "");
        vi.mocked(uploadImage).mockResolvedValue({ url: "blob:normalized", width: 1024, height: 1024, bytes: 3, mimeType: "image/png" });
        const brand = createDefaultBrand();
        brand.logo = { id: "logo", name: "logo", url: "data:logo", source: "upload" };
        const config = cloneGenerationConfig(DEFAULT_COMMERCE_GENERATION_CONFIG);
        config.outputSpec.format = "png";
        config.overlay.logo = { ...config.overlay.logo, placement: "top-right", applyTo: stage === "scene" ? "custom" : "all", customStages: ["scene"] };
        config.overlay.watermark.mode = "off";
        await normalizeOutputImage({ url: "data:product", width: 1024, height: 1024, bytes: 3, mimeType: "image/png" }, config, brand, stage);
        expect(drawImage).toHaveBeenCalledTimes(stage === "scene" ? 2 : 1);
    });
});

describe("marketing composition", () => {
    it("renders independent uncropped squares and editable localized labels", () => {
        const composition = createComposition({ jobId: "job", skuId: "sku", revision: 1, locale: "id-ID", requirementId: "pair", copy: "Salinan", productData: "data:before", sourceData: ["data:before", "data:after"], logoData: "", brand: createDefaultBrand(), generationConfig: DEFAULT_COMMERCE_GENERATION_CONFIG, layout: "before-after", size: 1024, stage: "marketing", singleVisual: true });
        const images = composition.layers.filter((layer) => layer.type === "background");
        expect(images.map((layer) => layer.content)).toEqual(["data:before", "data:after"]);
        expect(images.map((layer) => [layer.x, layer.width, layer.height])).toEqual([[0, 512, 512], [512, 512, 512]]);
        expect(composition.layers.filter((layer) => layer.type === "text").map((layer) => [layer.content, layer.locked])).toEqual([["Sebelum", false], ["Sesudah", false], ["Salinan", false]]);
        images[0].x = 10;
        expect(images[1].x).toBe(512);
    });
    const layouts: MarketingLayoutPreset[] = ["before-after", "competitor-comparison", "multi-scene", "installation-steps", "layer-structure", "color-options"];
    it.each(layouts)("draws the whole generated %s visual once", (layout) => {
        const composition = createComposition({ jobId: "job", skuId: "sku", revision: 1, locale: "zh-CN", siteLocale: "en-US", requirementId: "m", copy: "审核文案", productData: "data:base", logoData: "", brand: createDefaultBrand(), generationConfig: DEFAULT_COMMERCE_GENERATION_CONFIG, layout, size: 1024, stage: "marketing-preview", singleVisual: true });
        const images = composition.layers.filter((layer) => layer.content === "data:base");
        expect(images).toHaveLength(1);
        expect(images[0]).toMatchObject({ type: "background", name: "需求场景底图（含商品）", x: 0, y: 0, width: 1024, height: 1024 });
        expect(composition.siteLocale).toBe("en-US");
        expect(composition.layers.some((layer) => layer.content === "审核文案")).toBe(true);
    });
    it("preserves legacy layout rendering", () => {
        const composition = createComposition({ jobId: "job", skuId: "sku", revision: 1, locale: "zh-CN", requirementId: "m", copy: "copy", productData: "data:legacy", logoData: "", brand: createDefaultBrand(), generationConfig: DEFAULT_COMMERCE_GENERATION_CONFIG, layout: "before-after", size: 1024, stage: "marketing-preview" });
        expect(composition.layers.filter((layer) => layer.type === "product")).toHaveLength(2);
    });
});
