/** Only known server error codes are translated; never echo configuration or credentials. */
export function managedModelErrorMessage(value: unknown): string | undefined {
    if (!value || typeof value !== "object") return undefined;
    const payload = value as { code?: unknown; error?: { code?: unknown } };
    const code = payload.error?.code ?? payload.code;
    const messages: Record<string, string> = {
        quota_exceeded: "今日模型请求额度已用完，请联系管理员调整额度。",
        concurrency_limit: "已有任务正在处理，请等待完成后再试。",
        authentication_required: "访问码授权已失效，请重新验证。",
        principal_changed: "访问码已在其他页面切换，本次请求未扣额度，请重新验证后再操作。",
        server_configuration: "服务器模型配置暂不可用，请联系管理员，无需填写API Key。",
        upstream_timeout: "模型服务响应超时，本次请求可能已计入额度，请检查结果后再决定是否重试。",
        upstream_error: "模型服务未能完成请求，请稍后检查或联系管理员。",
        gateway_error: "统一模型服务暂不可用，请稍后重试或联系管理员。",
        invalid_request: "请求参数不符合统一模型服务要求，请检查图片和生成设置。",
        payload_too_large: "上传内容超过服务器限制，请减少参考图片或压缩图片后重试。",
        media_unavailable: "生成图片暂时无法读取或链接已过期，请稍后重试。",
    };
    return typeof code === "string" ? messages[code] : undefined;
}
