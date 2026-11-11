import { expect, it, vi } from "vitest";
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
import { defaultConfig, getImageInputTextModelStatus, normalizePersonalConfig } from "./use-config-store";

it("preserves explicit image-input metadata and returns credential-free readiness", () => {
    const config = normalizePersonalConfig({ ...defaultConfig, textModel: "team::vision", channels: [{ id: "team", name: "Team", baseUrl: "https://example.test", apiKey: "test-private-key", apiFormat: "openai", models: [{ name: "vision", capability: "text", supportsImageInput: true }] }] });
    expect(config.channels[0].models[0].supportsImageInput).toBe(true);
    expect(getImageInputTextModelStatus(config)).toEqual({ status: "ready", model: "team::vision" });
    expect(JSON.stringify(getImageInputTextModelStatus(config))).not.toContain("test-private-key");
    config.channels[0].models[0].supportsImageInput = false;
    expect(getImageInputTextModelStatus(config).status).toBe("unsupported");
    delete config.channels[0].models[0].supportsImageInput;
    expect(getImageInputTextModelStatus(config).status).toBe("unknown-capability");
    config.channels[0].apiKey = "";
    expect(getImageInputTextModelStatus(config).status).toBe("missing-credentials");
    config.textModel = "missing::model";
    expect(getImageInputTextModelStatus(config).status).toBe("unconfigured");
});
