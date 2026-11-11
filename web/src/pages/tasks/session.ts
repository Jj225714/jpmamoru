import { useSyncExternalStore } from "react";
import { useConfigStore } from "@/stores/use-config-store";
import { useServerConfigStore } from "@/services/server-config";
import { getServerConfigEnabled } from "@/constant/runtime-config";
import { isGptImageJobEligible } from "@/services/api/gpt-jobs";
import { createTaskCenterClient, type TaskSession, type TaskTarget } from "@/services/api/task-center";

export type TaskSource = { id: string; label: string; target: TaskTarget; session: TaskSession };
let revision = 0;
function identity() {
    const server = useServerConfigStore.getState();
    const channels = useConfigStore.getState().config.channels;
    return JSON.stringify([getServerConfigEnabled(), server.user?.id, server.phase === "checking" || server.phase === "signed-out", channels.map(c => [c.id, c.name, c.provider, c.baseUrl, c.apiKey])]);
}
let previous = identity();
const listeners = new Set<() => void>();
function changed() {
    const next = identity();
    if (next === previous) return;
    previous = next; revision++;
    listeners.forEach(listener => listener());
}
useConfigStore.subscribe(changed);
useServerConfigStore.subscribe(changed);
export function taskSources(): TaskSource[] {
    const server = useServerConfigStore.getState();
    if (getServerConfigEnabled() && (!server.user || server.phase === "checking" || server.phase === "signed-out")) return [];
    const accountId = server.user ? String(server.user.id) : "local";
    return useConfigStore.getState().config.channels.flatMap(channel => {
        if (!channel.apiKey.trim()) return [];
        const targets: TaskTarget[] = channel.provider === "fal"
            ? ["esrgan", "flux-fill", "qwen-layered"].map(model => ({ provider: "fal", model } as TaskTarget))
            : isGptImageJobEligible({ ...channel, model: "gpt-image-2" }, true) ? [{ provider: "gpt" }] : [];
        return targets.map(target => ({
            id: `${channel.id}:${target.provider}${target.provider === "fal" ? `:${target.model}` : ""}`,
            label: `${channel.name} · ${target.provider === "gpt" ? "GPT Image" : `Fal ${target.model}`}`,
            target, session: { accountId, channelId: channel.id, apiKey: channel.apiKey, revision },
        }));
    });
}
export function useTaskSessionRevision() {
    return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => revision);
}
export function taskClient(source: TaskSource) {
    return createTaskCenterClient({ target: source.target, getSession: () => taskSources().find(item => item.id === source.id)?.session || null });
}
export function taskLink(source: string, jobId?: string) {
    const params = new URLSearchParams({ source });
    if (jobId) params.set("job", jobId);
    return `/tasks?${params}`;
}
