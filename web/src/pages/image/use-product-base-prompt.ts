import { useServerConfigStore } from "@/services/server-config";
import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import { generateProductBasePrompt, productTextModelReason } from "@/services/product-base-prompt";
import { getImageInputTextModelStatus, resolveModelChannel, resolveModelScript, type AiConfig } from "@/stores/use-config-store";
import { ProductBasePromptController } from "./product-base-prompt-controller";

export function hasConfiguredProductTextModel(config: AiConfig) {
    return getImageInputTextModelStatus(config).status === "ready";
}

export function productTextConfigKey(config: AiConfig) {
    const channel = resolveModelChannel(config, config.textModel);
    return JSON.stringify([config.textModel, channel.id, channel.baseUrl, channel.apiKey, channel.apiFormat, resolveModelScript(config, config.textModel), config.proxyEnabled, config.proxyUrl, config.reasoningEffort, getImageInputTextModelStatus(config).status]);
}

export function useProductBasePrompt(config: AiConfig) {
    const [controller] = useState(() => new ProductBasePromptController());
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
    const ready = hasConfiguredProductTextModel(config);
    // Keep this private: channel credentials are part of invalidation, never UI/log output.
    const accountId = useServerConfigStore((state) => state.user?.id);
    const key = JSON.stringify([accountId, productTextConfigKey(config)]);
    useLayoutEffect(() => {
        controller.configure(key, ready, (references, signal) => generateProductBasePrompt(config, references, { signal }));
        return controller.cancel;
        // Only changes relevant to text analysis should invalidate a request.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [controller, key, ready]);
    return { ...state, controller, ready, reason: productTextModelReason(getImageInputTextModelStatus(config).status) };
}
