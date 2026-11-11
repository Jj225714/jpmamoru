import { useServerConfigStore } from "@/services/server-config";
import { resolveModelChannel, useConfigStore, type AiConfig } from "@/stores/use-config-store";

let revision = 0;
function identity() {
    const server = useServerConfigStore.getState();
    return JSON.stringify([server.user?.id, server.phase === "checking" || server.phase === "signed-out", useConfigStore.getState().config.channels]);
}
let previous = identity();
function changed() { const next = identity(); if (next !== previous) { previous = next; revision++; } }
useServerConfigStore.subscribe(changed);
useConfigStore.subscribe(changed);

export type ImageJobSessionGuard = () => { accountId: string; channelId: string; revision: number } | null;
/** Snapshot before any async reference preparation. A -> B -> A still invalidates this guard. */
export function createImageJobSessionGuard(config: AiConfig): ImageJobSessionGuard {
    const started = revision;
    const channel = resolveModelChannel(config, config.model || config.imageModel);
    const accountId = useServerConfigStore.getState().user?.id;
    return () => {
        const state = useServerConfigStore.getState();
        const current = useConfigStore.getState().config.channels.find(item => item.id === channel.id);
        if (!accountId || state.user?.id !== accountId || state.phase === "checking" || state.phase === "signed-out" || started !== revision || !current || current.apiKey !== channel.apiKey || current.baseUrl !== channel.baseUrl) return null;
        return { accountId: String(accountId), channelId: channel.id, revision };
    };
}
