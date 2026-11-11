import { describe, expect, it, vi } from "vitest";
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
import { defaultConfig } from "@/stores/use-config-store";
import { mergeChannelConfigFile } from "./channel-config-file";

const input = { app: "infinite-canvas-channel", version: 1, channel: { name: "Sub2API", baseUrl: "https://llm.zhitouzhuan.com/v1", apiKey: "test-only", models: [{ name: "image-model", capability: "image" }, { name: "text-model", capability: "text" }] } };
describe("personal channel import", () => {
    it("preserves existing channels and preferences, binding the imported models", () => {
        const config = { ...defaultConfig, proxyUrl: "http://localhost:23210", quality: "low" };
        const result = mergeChannelConfigFile(config, input);
        expect(result.channels.slice(0, -1)).toEqual(config.channels);
        expect(result.proxyUrl).toBe(config.proxyUrl);
        expect(result.quality).toBe("low");
        const channel = result.channels.at(-1)!;
        expect(result.imageModel).toBe(`${channel.id}::image-model`);
        expect(result.textModel).toBe(`${channel.id}::text-model`);
        expect(config.channels).toHaveLength(defaultConfig.channels.length);
        expect(mergeChannelConfigFile(result, input)).toEqual(result);
    });
    it.each(["http://llm.zhitouzhuan.com/v1", "https://user:password@llm.zhitouzhuan.com/v1", "https://llm.zhitouzhuan.com/v1?key=unsafe"])("rejects unsafe address %s", (baseUrl) => {
        expect(() => mergeChannelConfigFile(defaultConfig, { ...input, channel: { ...input.channel, baseUrl } })).toThrow();
    });
    it("rejects malformed input without changing the configuration", () => {
        for (const bad of [null, {}, { ...input, channel: { ...input.channel, models: [null] } }, { ...input, channel: { ...input.channel, apiKey: "" } }]) expect(() => mergeChannelConfigFile(defaultConfig, bad)).toThrow();
    });
});
