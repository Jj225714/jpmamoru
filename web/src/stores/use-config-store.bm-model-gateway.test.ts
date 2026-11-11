import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
import { getBmModelGatewayEnabled } from "@/constant/runtime-config";
import { buildApiUrl, useConfigStore, withLocalProxy } from "./use-config-store";

const original = useConfigStore.getState().config;
afterEach(() => {
    useConfigStore.setState({ config: original });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe("BM gateway integration", () => {
    it.each(["https://bm.clawvp.com", "https://bm.clawvp.com/", "https://bm.clawvp.com/v1", "https://bm.clawvp.com/v1/"])("keeps /v1 exactly once for %s and takes priority over the old proxy", (baseUrl) => {
        vi.stubEnv("DEV", true);
        const config = { ...original, baseUrl, proxyEnabled: true, proxyUrl: "http://127.0.0.1:23210" };
        useConfigStore.setState({ config });
        expect(buildApiUrl(baseUrl, "/images/generations")).toBe("/api/model-gateway/bm/v1/images/generations");
        expect(buildApiUrl(baseUrl, "/models")).toBe("/api/model-gateway/bm/v1/models");
        expect(useConfigStore.getState().config).toBe(config);
        expect(config).toEqual({ ...original, baseUrl, proxyEnabled: true, proxyUrl: "http://127.0.0.1:23210" });
    });
    it("requires boolean true in production and reads the runtime flag dynamically", () => {
        vi.stubEnv("DEV", false);
        vi.stubGlobal("window", { __RUNTIME_CONFIG__: {} });
        expect(getBmModelGatewayEnabled()).toBe(false);
        expect(withLocalProxy("https://bm.clawvp.com/v1/models")).toBe("https://bm.clawvp.com/v1/models");
        for (const value of [false, "true", 1, undefined]) {
            vi.stubGlobal("window", { __RUNTIME_CONFIG__: { bmModelGatewayEnabled: value } });
            expect(getBmModelGatewayEnabled()).toBe(false);
        }
        vi.stubGlobal("window", { __RUNTIME_CONFIG__: { bmModelGatewayEnabled: true } });
        expect(getBmModelGatewayEnabled()).toBe(true);
        expect(buildApiUrl("https://bm.clawvp.com/v1", "/responses")).toBe("/api/model-gateway/bm/v1/responses");
    });
    it("preserves legacy local-proxy behavior for other providers and data/blob URLs", () => {
        vi.stubEnv("DEV", true);
        useConfigStore.setState({ config: { ...original, proxyEnabled: true, proxyUrl: "http://127.0.0.1:23210" } });
        expect(buildApiUrl("https://api.openai.com/v1", "/models")).toBe("http://127.0.0.1:23210/https://api.openai.com/v1/models");
        for (const url of ["data:image/png;base64,test", "blob:https://example.test/id", "/api/model-gateway/bm/v1/models", "http://127.0.0.1:23210/https://example.test"]) expect(withLocalProxy(url)).toBe(url);
        vi.stubEnv("DEV", false);
        expect(buildApiUrl("https://bm.clawvp.com/v1", "/models")).toBe("http://127.0.0.1:23210/https://bm.clawvp.com/v1/models");
    });
});
