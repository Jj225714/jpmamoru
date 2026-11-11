export const BM_MODEL_GATEWAY_PREFIX = "/api/model-gateway/bm";
export const BM_MODEL_GATEWAY_TARGET = "https://bm.clawvp.com";

const postPaths = new Set(["/v1/images/generations", "/v1/images/edits", "/v1/responses", "/v1/chat/completions", "/v1/audio/speech", "/v1/videos"]);

/** Match raw paths, never URL-normalized paths: escapes, queries and traversal fail closed. */
export function bmModelGatewayMethods(path: string): readonly string[] | undefined {
    if (/[^A-Za-z0-9/_-]/.test(path)) return undefined;
    if (path === "/v1/models" || /^\/v1\/videos\/[A-Za-z0-9_-]+(?:\/content)?$/.test(path)) return ["GET", "HEAD"];
    if (postPaths.has(path)) return ["POST"];
    return undefined;
}

/** Pure mapping; never change credentials, stored base URLs or unrelated providers. */
export function withBmModelGateway(url: string, enabled: boolean): string {
    if (!enabled || !url.startsWith(`${BM_MODEL_GATEWAY_TARGET}/`)) return url;
    const path = url.slice(BM_MODEL_GATEWAY_TARGET.length);
    return bmModelGatewayMethods(path) ? `${BM_MODEL_GATEWAY_PREFIX}${path}` : url;
}

type GatewayRequest = {
    url?: string;
    method?: string;
    authorization?: string;
    host?: string;
    origin?: string;
    referer?: string;
    fetchSite?: string;
    remoteAddress?: string;
};

const isLoopbackHost = (host: string) => ["localhost", "127.0.0.1", "[::1]"].includes(host);

function hasLocalOrigin(request: GatewayRequest): boolean {
    if (request.fetchSite === "cross-site") return false;
    try {
        const host = new URL(`http://${request.host}`);
        if (host.host !== request.host || host.username || host.password) return false;
        const source = request.origin ?? request.referer;
        if (source !== undefined) {
            const origin = new URL(source);
            if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password) return false;
            if (request.origin !== undefined && origin.origin !== request.origin) return false;
            return origin.host === host.host || (isLoopbackHost(origin.hostname) && isLoopbackHost(host.hostname) && origin.port === host.port);
        }
        // Non-browser clients without Origin/Referer are restricted to the local machine.
        return isLoopbackHost(host.hostname) && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.remoteAddress || "");
    } catch {
        return false;
    }
}

/** Zero means allowed. Validate the original request target before rewriting it. */
export function bmModelGatewayRequestStatus(request: GatewayRequest): 0 | 401 | 403 | 404 | 405 {
    const rawUrl = request.url || "";
    if (!rawUrl.startsWith(`${BM_MODEL_GATEWAY_PREFIX}/`)) return 404;
    const methods = bmModelGatewayMethods(rawUrl.slice(BM_MODEL_GATEWAY_PREFIX.length));
    if (!methods) return 404;
    if (!methods.includes(request.method || "")) return 405;
    if (!/^Bearer [A-Za-z0-9._~+\/-]+=*$/i.test(request.authorization || "") || /[\r\n]/.test(request.authorization || "")) return 401;
    if (!hasLocalOrigin(request)) return 403;
    return 0;
}

export function isBmModelGatewayRedirect(status: number | undefined): boolean {
    return status !== undefined && status >= 300 && status < 400;
}
