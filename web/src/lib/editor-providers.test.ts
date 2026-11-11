import { describe, expect, it, vi } from "vitest";
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
import { editorChannel, editorModels, editorPresets } from "./editor-providers";
import { defaultConfig, isAiConfigReady, normalizePersonalConfig, resolveModelForCapability, resolveModelRequestConfig, selectableModelsByCapability, type AiConfig } from "@/stores/use-config-store";
const config: AiConfig = {
    ...defaultConfig,
    channels: [...defaultConfig.channels, { id: "fal", name: "fal", provider: "fal", apiFormat: "openai", baseUrl: "https://queue.fal.run", apiKey: "my-key", models: editorPresets.fal }],
    editorBindings: { erase: "fal::fal-ai/flux-pro/v1/fill" },
};
describe("personal channels", () => {
    it("does not guess credentials or models for deleted general bindings", () => {
        expect(isAiConfigReady(config, "deleted::model")).toBe(false);
        expect(() => resolveModelRequestConfig(config, "deleted::model")).toThrow("失效");
        expect(resolveModelForCapability({ ...config, channels: [], imageModel: "" }, "managed::old", "image")).toBe("");
    });
    it("preserves old personal channels and discards only retired ownership and model bindings", () => {
        const migrated = normalizePersonalConfig({ ...config, managedPrincipalId: "old", imageModel: "managed::image" });
        expect(migrated.channels[1].apiKey).toBe("my-key");
        expect(migrated.editorBindings).toEqual(config.editorBindings);
        expect(migrated).not.toHaveProperty("managedPrincipalId");
        expect(migrated.imageModel).toBe("");
        expect(migrated.channels[0].provider).toBe("general");
    });
    it("keeps specialized models out of general generation pickers", () => {
        expect(selectableModelsByCapability(config, "image")).not.toContain("fal::fal-ai/flux-pro/v1/fill");
        expect(editorModels(config, "erase")).toHaveLength(1);
        expect(editorModels(config, "ocr")).toHaveLength(0);
    });
    it("never falls back to another channel after deletion or a wrong binding", () => {
        expect(editorChannel(config, "erase").apiKey).toBe("my-key");
        expect(() => editorChannel({ ...config, channels: defaultConfig.channels }, "erase")).toThrow("选择消除");
        expect(() => editorChannel({ ...config, editorBindings: { erase: "default::gpt-image-2" } }, "erase")).toThrow();
    });
    it("rejects non-official provider addresses", () => {
        expect(() => editorChannel({ ...config, channels: config.channels.map((c) => ({ ...c, baseUrl: "https://queue.fal.run.evil.example" })) }, "erase")).toThrow("fal 渠道地址");
    });
});
