import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
import { buildApiUrl, useConfigStore, withLocalProxy } from "./use-config-store";
import { sub2apiModelGatewayRequestStatus, withSub2apiModelGateway } from "@/lib/sub2api-model-gateway";

const original = useConfigStore.getState().config;
afterEach(() => {
    useConfigStore.setState({ config: original });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe("Sub2API personal channel", () => {
    it.each(["https://llm.zhitouzhuan.com", "https://llm.zhitouzhuan.com/", "https://llm.zhitouzhuan.com/v1", "https://llm.zhitouzhuan.com/v1/"])("maps %s without duplicating v1 or changing user configuration", (base) => {
        vi.stubEnv("DEV", true);
        const config = { ...original, proxyEnabled: true, proxyUrl: "http://127.0.0.1:23210", apiKey: "personal-test-key" };
        useConfigStore.setState({ config });
        expect(buildApiUrl(base, "/images/edits")).toBe("/api/model-gateway/sub2api/v1/images/edits");
        expect(buildApiUrl(base, "/models")).toBe("/api/model-gateway/sub2api/v1/models");
        expect(useConfigStore.getState().config).toBe(config);
    });
    it("requires its own deployment flag and preserves the BM channel", () => {
        vi.stubEnv("DEV", false);
        vi.stubGlobal("window", { __RUNTIME_CONFIG__: { bmModelGatewayEnabled: true } });
        expect(withLocalProxy("https://llm.zhitouzhuan.com/v1/models")).toBe("https://llm.zhitouzhuan.com/v1/models");
        vi.stubGlobal("window", { __RUNTIME_CONFIG__: { bmModelGatewayEnabled: true, sub2apiModelGatewayEnabled: true } });
        expect(buildApiUrl("https://llm.zhitouzhuan.com", "/models")).toBe("/api/model-gateway/sub2api/v1/models");
        expect(buildApiUrl("https://bm.clawvp.com", "/models")).toBe("/api/model-gateway/bm/v1/models");
    });
    it.each(["https://llm.zhitouzhuan.com.evil.test/v1/models", "https://llm.zhitouzhuan.com@evil.test/v1/models", "http://llm.zhitouzhuan.com/v1/models", "https://llm.zhitouzhuan.com/v1/models?key=test", "https://llm.zhitouzhuan.com/v1/../admin", "https://llm.zhitouzhuan.com/v1/videos"])("does not map unapproved URL %s", (url) => {
        expect(withSub2apiModelGateway(url, true)).toBe(url);
    });
    it("guards credentials, origins, methods and paths in development", () => {
        const req = { url: "/api/model-gateway/sub2api/v1/models", method: "GET", authorization: "Bearer personal-test", host: "localhost:3000", origin: "http://localhost:3000" };
        expect(sub2apiModelGatewayRequestStatus(req)).toBe(0);
        expect(sub2apiModelGatewayRequestStatus({ ...req, authorization: undefined })).toBe(401);
        expect(sub2apiModelGatewayRequestStatus({ ...req, origin: "https://evil.test" })).toBe(403);
        expect(sub2apiModelGatewayRequestStatus({ ...req, method: "POST" })).toBe(405);
        expect(sub2apiModelGatewayRequestStatus({ ...req, url: req.url + "?key=test" })).toBe(404);
    });
});
