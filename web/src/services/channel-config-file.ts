import { createModelChannel, type AiConfig } from "@/stores/use-config-store";

/** Import one personal channel without replacing the workspace's other settings. */
export function mergeChannelConfigFile(config: AiConfig, input: unknown): AiConfig {
    const data = input as { app?: string; version?: number; channel?: Record<string, unknown> } | null;
    const c = data?.channel;
    if (data?.app !== "infinite-canvas-channel" || data.version !== 1 || !c || typeof c.baseUrl !== "string" || typeof c.apiKey !== "string" || !c.apiKey.trim() || !Array.isArray(c.models)) throw new Error("无效的渠道配置文件");
    const url = new URL(c.baseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("无效的渠道接口地址");
    if (!c.models.every((model) => model && typeof model.name === "string" && ["image", "text"].includes(model.capability))) throw new Error("无效的渠道模型列表");
    const baseUrl = c.baseUrl.replace(/\/+$/, "");
    const existing = config.channels.find((channel) => channel.baseUrl.replace(/\/+$/, "") === baseUrl);
    const channel = createModelChannel({ id: existing?.id, name: typeof c.name === "string" ? c.name : "Sub2API", baseUrl, apiKey: c.apiKey, apiFormat: "openai", provider: "general", models: c.models.map((model) => ({ name: model.name, capability: model.capability })) });
    const channels = existing ? config.channels.map((item) => (item.id === existing.id ? channel : item)) : [...config.channels, channel];
    const image = channel.models.find((model) => model.capability === "image");
    const text = channel.models.find((model) => model.capability === "text");
    return {
        ...config,
        channels,
        models: [...new Set([...config.models, ...channel.models.map((model) => `${channel.id}::${model.name}`)])],
        ...(image ? { model: `${channel.id}::${image.name}`, imageModel: `${channel.id}::${image.name}` } : {}),
        ...(text ? { textModel: `${channel.id}::${text.name}` } : {}),
    };
}
