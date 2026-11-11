import { describe, expect, it, vi } from "vitest";
import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import { hasConfiguredProductTextModel, productTextConfigKey } from "./use-product-base-prompt";

vi.mock("@/services/product-base-prompt", () => ({ generateProductBasePrompt: vi.fn(), productTextModelReason: vi.fn() }));
vi.mock("@/services/server-config", () => ({ useServerConfigStore: vi.fn() }));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));

const configured = (): AiConfig => ({
    ...defaultConfig,
    textModel: "test::vision-text",
    channels: [
        {
            id: "test",
            name: "Test",
            baseUrl: "https://example.invalid/v1",
            apiKey: "test-only",
            apiFormat: "openai",
            models: [
                { name: "vision-text", capability: "text", supportsImageInput: true },
                { name: "image", capability: "image" },
            ],
        },
    ],
});

describe("product text model readiness", () => {
    it("ignores unrelated model metadata when identifying the text request config", () => {
        const config = configured();
        const key = productTextConfigKey(config);
        config.channels[0].models[1].script = "changed image script";
        config.channels[0].models.push({ name: "another-image", capability: "image" });
        config.channels[0].name = "Renamed channel";
        config.imageModel = "test::another-image";
        expect(productTextConfigKey(config)).toBe(key);
        config.channels[0].models[0].script = "changed text script";
        expect(productTextConfigKey(config)).not.toBe(key);
    });
    it.each(["baseUrl", "apiKey", "apiFormat", "id"] as const)("tracks selected channel %s", (field) => {
        const config = configured();
        const key = productTextConfigKey(config);
        if (field === "apiFormat") config.channels[0].apiFormat = "gemini";
        else config.channels[0][field] = "changed";
        expect(productTextConfigKey(config)).not.toBe(key);
    });
    it("accepts an explicitly selected configured text model", () => {
        expect(hasConfiguredProductTextModel(configured())).toBe(true);
    });
    it.each(["", "test::missing", "test::image"])("rejects unselectable text model %s even with channel credentials", (textModel) => {
        expect(hasConfiguredProductTextModel({ ...configured(), textModel })).toBe(false);
    });
    it.each(["baseUrl", "apiKey"] as const)("rejects missing %s", (field) => {
        const config = configured();
        config.channels[0][field] = " ";
        expect(hasConfiguredProductTextModel(config)).toBe(false);
    });
});

it("blocks unknown or unsupported capability and accepts team capability sync", () => {
    const config = configured();
    config.channels[0].models[0].supportsImageInput = undefined;
    const key = productTextConfigKey(config);
    expect(hasConfiguredProductTextModel(config)).toBe(false);
    config.channels[0].models[0].supportsImageInput = false;
    expect(hasConfiguredProductTextModel(config)).toBe(false);
    config.channels[0].models[0].supportsImageInput = true;
    expect(hasConfiguredProductTextModel(config)).toBe(true);
    expect(productTextConfigKey(config)).not.toBe(key);
});
