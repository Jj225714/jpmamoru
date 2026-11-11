import { BM_MODEL_GATEWAY_PREFIX, bmModelGatewayRequestStatus } from "./bm-model-gateway";

export const SUB2API_MODEL_GATEWAY_TARGET = "https://llm.zhitouzhuan.com";
export const SUB2API_MODEL_GATEWAY_PREFIX = "/api/model-gateway/sub2api";
const paths = new Set(["/v1/models", "/v1/images/generations", "/v1/images/edits", "/v1/responses", "/v1/chat/completions"]);

export function withSub2apiModelGateway(url: string, enabled: boolean): string {
    if (!enabled || !url.startsWith(`${SUB2API_MODEL_GATEWAY_TARGET}/`)) return url;
    const path = url.slice(SUB2API_MODEL_GATEWAY_TARGET.length);
    return paths.has(path) ? `${SUB2API_MODEL_GATEWAY_PREFIX}${path}` : url;
}

export function sub2apiModelGatewayRequestStatus(request: Parameters<typeof bmModelGatewayRequestStatus>[0]): ReturnType<typeof bmModelGatewayRequestStatus> {
    if (!request.url?.startsWith(`${SUB2API_MODEL_GATEWAY_PREFIX}/`)) return 404;
    const path = request.url.slice(SUB2API_MODEL_GATEWAY_PREFIX.length);
    if (!paths.has(path)) return 404;
    return bmModelGatewayRequestStatus({ ...request, url: `${BM_MODEL_GATEWAY_PREFIX}${path}` });
}
