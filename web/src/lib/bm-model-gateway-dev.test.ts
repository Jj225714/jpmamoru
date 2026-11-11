import { EventEmitter } from "node:events";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { type Connect, type ViteDevServer } from "vite";
import config, { bmModelGatewayGuard, bmModelGatewayProxy } from "../../vite.config";

function response() {
    const res = { writeHead: vi.fn(), end: vi.fn(), headersSent: false };
    res.writeHead.mockReturnValue(res);
    return res;
}

function proxyFixture() {
    const proxy = new EventEmitter();
    const options = bmModelGatewayProxy();
    options.configure!(proxy as Parameters<NonNullable<typeof options.configure>>[0], options);
    return { proxy, options };
}

describe("Vite BM relay", () => {
    it("uses one TLS-verified target without redirects, websocket forwarding or response buffering", () => {
        const { options } = proxyFixture();
        expect(options).toMatchObject({ target: "https://bm.clawvp.com", secure: true, changeOrigin: true, followRedirects: false, ws: false });
        expect(options.selfHandleResponse).not.toBe(true);
        expect(options.rewrite!("/api/model-gateway/bm/v1/images/edits")).toBe("/v1/images/edits");
        expect(config).toMatchObject({ preview: { proxy: {} } });
    });

    it("strips browser credentials while preserving Bearer auth and multipart/stream headers", () => {
        const { proxy } = proxyFixture();
        const headers: Record<string, string> = {
            origin: "http://localhost:3000",
            referer: "http://localhost:3000/canvas",
            cookie: "session=test",
            authorization: "Bearer test-only",
            "content-type": "multipart/form-data; boundary=test",
            accept: "text/event-stream",
        };
        proxy.emit("proxyReq", { removeHeader: (name: string) => delete headers[name] });
        expect(headers).toEqual({ authorization: "Bearer test-only", "content-type": "multipart/form-data; boundary=test", accept: "text/event-stream" });
    });

    it.each([300, 301, 302, 303, 304, 307, 308, 399])("turns upstream %s into an empty 502 without Location", (statusCode) => {
        const { proxy } = proxyFixture();
        const upstream = { statusCode, headers: { location: "https://other.test", "set-cookie": "session=test" }, resume: vi.fn() };
        const res = response();
        proxy.emit("proxyRes", upstream, {}, res);
        expect(upstream.headers).toEqual({});
        expect(res.writeHead).toHaveBeenCalledWith(502, { "Cache-Control": "no-store" });
        expect(res.end).toHaveBeenCalledWith();
        expect(upstream.resume).toHaveBeenCalledOnce();
    });

    it("leaves successful SSE and multipart responses available to the native streaming proxy", () => {
        const { proxy } = proxyFixture();
        const upstream = { statusCode: 200, headers: { "content-type": "text/event-stream" }, resume: vi.fn() };
        const res = response();
        proxy.emit("proxyRes", upstream, {}, res);
        expect(res.writeHead).not.toHaveBeenCalled();
        expect(res.end).not.toHaveBeenCalled();
        expect(upstream.resume).not.toHaveBeenCalled();
        expect(upstream.headers["content-type"]).toBe("text/event-stream");
    });

    it("keeps upstream error diagnostics generic", () => {
        const { proxy } = proxyFixture();
        const error = new Error("untrusted upstream diagnostic");
        const res = response();
        proxy.emit("error", error, {}, res);
        expect(error.message).toBe("BM model gateway upstream failure");
        expect(error.stack).toBe(error.message);
        expect(res.writeHead).toHaveBeenCalledWith(502, { "Cache-Control": "no-store" });
    });

    it("guards raw requests before proxy rewriting without reading the request body", () => {
        let middleware: Connect.NextHandleFunction | undefined;
        const plugin = bmModelGatewayGuard();
        const configureServer = plugin.configureServer;
        if (typeof configureServer !== "function") throw new Error("Missing middleware hook");
        configureServer.call(
            {} as never,
            {
                middlewares: {
                    use: (handler: Connect.NextHandleFunction) => {
                        middleware = handler;
                    },
                },
            } as unknown as ViteDevServer,
        );
        const base = { method: "POST", headers: { authorization: "Bearer test-only", host: "localhost:3000", origin: "http://localhost:3000" }, socket: { remoteAddress: "127.0.0.1" }, on: vi.fn() };
        for (const [path, status] of [
            ["/v1/images/edits", 0],
            ["/v1/%2e%2e/models", 404],
            ["/v1/models?key=test", 404],
            ["/v1/models", 405],
        ] as const) {
            const res = response();
            const next = vi.fn();
            middleware!({ ...base, url: `/api/model-gateway/bm${path}` } as unknown as IncomingMessage, res as unknown as ServerResponse, next);
            if (status) {
                expect(res.writeHead).toHaveBeenCalledWith(status, { "Cache-Control": "no-store" });
                expect(next).not.toHaveBeenCalled();
            } else {
                expect(next).toHaveBeenCalledOnce();
                expect(res.end).not.toHaveBeenCalled();
            }
        }
        expect(base.on).not.toHaveBeenCalled();
    });
});
