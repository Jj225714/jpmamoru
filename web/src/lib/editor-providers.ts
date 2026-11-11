import type { AiConfig, ChannelModel, ModelChannel } from "@/stores/use-config-store";
import type { EditOperation } from "@/types/image-editor";

export type ChannelProvider = "general" | "fal" | "azure-vision";
export const editorOperationNames: Record<EditOperation, string> = { erase: "消除", expand: "扩图", upscale: "高清", ocr: "文字识别", layers: "复杂拆层" };
export const editorPresets: Record<Exclude<ChannelProvider, "general">, ChannelModel[]> = {
    fal: [
        { name: "fal-ai/flux-pro/v1/fill", capability: "image", editorOperations: ["erase", "expand"] },
        { name: "fal-ai/esrgan", capability: "image", editorOperations: ["upscale"] },
        { name: "fal-ai/qwen-image-layered", capability: "image", editorOperations: ["layers"] },
    ],
    "azure-vision": [{ name: "read", capability: "text", editorOperations: ["ocr"] }],
};
export const isGeneralChannel = (channel: ModelChannel) => !channel.provider || channel.provider === "general";
export function editorModels(config: AiConfig, operation: EditOperation) {
    return config.channels.flatMap((channel) => {
        const presets = channel.provider && channel.provider !== "general" ? editorPresets[channel.provider] || [] : [];
        return channel.models
            .filter((model) => model.editorOperations?.includes(operation) && presets.some((p) => p.name === model.name && p.editorOperations?.includes(operation)))
            .map((model) => ({ value: `${channel.id}::${model.name}`, label: `${model.name}（${channel.name}）`, channel, model }));
    });
}
export function editorChannel(config: AiConfig, operation: EditOperation) {
    const binding = config.editorBindings?.[operation];
    const selected = editorModels(config, operation).find((m) => m.value === binding);
    if (!selected) throw new Error(`请在“配置 → 高级图片工具”选择${editorOperationNames[operation]}使用的渠道与模型`);
    const { channel, model } = selected;
    if (!channel.apiKey.trim()) throw new Error(`请在“配置 → 渠道”为“${channel.name}”填写 API Key`);
    const base = new URL(channel.baseUrl);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || (base.pathname !== "/" && base.pathname !== "")) throw new Error("专用渠道地址须为官方 HTTPS 服务根地址");
    if (channel.provider === "fal" && base.origin !== "https://queue.fal.run") throw new Error("fal 渠道地址须为 https://queue.fal.run");
    if (channel.provider === "azure-vision" && (!/^[a-z0-9-]+\.cognitiveservices\.azure\.com$/i.test(base.hostname) || base.port)) throw new Error("请填写 Azure Vision 官方资源地址 https://资源名.cognitiveservices.azure.com");
    return { provider: channel.provider!, baseUrl: base.origin, apiKey: channel.apiKey.trim(), model: model.name };
}
