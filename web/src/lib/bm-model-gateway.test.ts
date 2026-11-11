import { describe, expect, it } from "vitest";
import { BM_MODEL_GATEWAY_PREFIX as prefix, BM_MODEL_GATEWAY_TARGET as target, bmModelGatewayMethods, bmModelGatewayRequestStatus, isBmModelGatewayRedirect, withBmModelGateway } from "./bm-model-gateway";

const paths = ["/v1/models", "/v1/images/generations", "/v1/images/edits", "/v1/responses", "/v1/chat/completions", "/v1/audio/speech", "/v1/videos", "/v1/videos/job_A-12", "/v1/videos/job_A-12/content"];
const request = { url: `${prefix}/v1/models`, method: "GET", authorization: "Bearer test-only", host: "localhost:3000", origin: "http://localhost:3000" };

describe("BM fixed-host mapping", () => {
    it.each(paths)("maps only the approved raw path %s", (path) => {
        expect(withBmModelGateway(`${target}${path}`, true)).toBe(`${prefix}${path}`);
        expect(withBmModelGateway(`${target}${path}`, false)).toBe(`${target}${path}`);
    });
    it.each([
        "https://api.openai.com/v1/models",
        "https://bm.clawvp.com.evil.test/v1/models",
        "https://bm.clawvp.com@evil.test/v1/models",
        "https://user@bm.clawvp.com/v1/models",
        "https://bm.clawvp.com:443/v1/models",
        "https://bm.clawvp.com:8443/v1/models",
        "http://bm.clawvp.com/v1/models",
        "//bm.clawvp.com/v1/models",
        "https://bm.clawvp.com./v1/models",
        "data:image/png;base64,test",
        "blob:https://example.test/id",
        `${prefix}/v1/models`,
    ])("leaves unrelated or noncanonical URLs unchanged: %s", (url) => {
        expect(withBmModelGateway(url, true)).toBe(url);
    });
    it.each([
        "/v1/admin",
        "/v1/models?key=test",
        "/v1/models?",
        "/v1/models#fragment",
        "/v1/../v1/models",
        "/v1/%2e%2e/v1/models",
        "/v1/%256dodels",
        "/v1/%6dodels",
        "/v1//models",
        "/v1/models/",
        "/v1\\models",
        "/v1/v1/models",
        "/v1/videos/id/../content",
        "/v1/videos/id%2fcontent",
        "/v1/videos/id/content?key=test",
        "/v1/videos/id\n",
        "/v1/videos/id/extra",
        "/v1/videos/",
    ])("rejects unsupported or ambiguous raw paths: %s", (path) => {
        expect(bmModelGatewayMethods(path)).toBeUndefined();
        expect(withBmModelGateway(`${target}${path}`, true)).toBe(`${target}${path}`);
        expect(bmModelGatewayRequestStatus({ ...request, url: `${prefix}${path}` })).toBe(404);
    });
});

describe("dev request policy", () => {
    it.each(paths)("enforces the method allowlist for %s", (path) => {
        const allowed = path === "/v1/models" || path.startsWith("/v1/videos/") ? ["GET", "HEAD"] : ["POST"];
        for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT"]) {
            expect(bmModelGatewayRequestStatus({ ...request, url: `${prefix}${path}`, method })).toBe(allowed.includes(method) ? 0 : 405);
        }
    });
    it.each([undefined, "", "Bearer", "Bearer ", "Basic test", "Bearer a b", "Bearer test\n"])("requires a Bearer header (%s)", (authorization) => {
        expect(bmModelGatewayRequestStatus({ ...request, authorization })).toBe(401);
    });
    it.each(["http://evil.test", "null", "http://localhost:3001", "http://localhost:3000.evil.test", "http://user@localhost:3000", "http://localhost:3000/path"])("rejects a foreign or malformed origin: %s", (origin) => {
        expect(bmModelGatewayRequestStatus({ ...request, origin })).toBe(403);
    });
    it("allows same-host and local loopback requests, rejecting remote requests without origin", () => {
        expect(bmModelGatewayRequestStatus(request)).toBe(0);
        expect(bmModelGatewayRequestStatus({ ...request, origin: "http://127.0.0.1:3000" })).toBe(0);
        expect(bmModelGatewayRequestStatus({ ...request, origin: undefined, referer: "http://localhost:3000/canvas" })).toBe(0);
        expect(bmModelGatewayRequestStatus({ ...request, origin: undefined, remoteAddress: "127.0.0.1" })).toBe(0);
        expect(bmModelGatewayRequestStatus({ ...request, origin: undefined, remoteAddress: "192.0.2.1" })).toBe(403);
        expect(bmModelGatewayRequestStatus({ ...request, fetchSite: "cross-site" })).toBe(403);
        expect(bmModelGatewayRequestStatus({ ...request, host: "evil.test", origin: undefined, remoteAddress: "127.0.0.1" })).toBe(403);
    });
    it.each([`${prefix}evil/v1/models`, `${prefix}//v1/models`, `https://bm.clawvp.com/v1/models`, `${prefix}?key=test`])("rejects invalid gateway targets: %s", (url) => {
        expect(bmModelGatewayRequestStatus({ ...request, url })).toBe(404);
    });
    it("blocks every 3xx status, including uncommon redirects", () => {
        for (let status = 300; status < 400; status++) expect(isBmModelGatewayRedirect(status)).toBe(true);
        for (const status of [undefined, 200, 204, 299, 400, 500]) expect(isBmModelGatewayRedirect(status)).toBe(false);
    });
});
