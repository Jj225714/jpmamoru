import { expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
vi.mock("@/stores/use-config-store", () => ({ useConfigStore: createStore(() => ({ config: { channels: [
    { id: "g", name: "GPT", baseUrl: "https://llm.zhitouzhuan.com/v1", apiKey: "test-key", provider: "general" },
    { id: "f", name: "Fal", baseUrl: "https://queue.fal.run", apiKey: "fal-test", provider: "fal" },
] } })) }));
vi.mock("@/services/server-config", () => ({ useServerConfigStore: createStore(() => ({ user: { id: "A" } as { id: string } | null, phase: "ready" })) }));
vi.mock("@/constant/runtime-config", () => ({ getServerConfigEnabled: () => true }));
import { useServerConfigStore } from "@/services/server-config";
import { useConfigStore } from "@/stores/use-config-store";
import { taskClient, taskLink, taskSources } from "./session";
it("builds separate GPT and Fal sources without credentials in links", () => {
    const sources = taskSources(); expect(sources).toHaveLength(4); expect(sources.map(item => item.id)).toEqual(["g:gpt", "f:fal:esrgan", "f:fal:flux-fill", "f:fal:qwen-layered"]);
    expect(taskLink(sources[0].id, "job")).toBe("/tasks?source=g%3Agpt&job=job");
});
it("increments the epoch for synchronous A->B->A and invalidates the old client", async () => {
    const before = taskSources()[0], client = taskClient(before);
    const server = useServerConfigStore as unknown as { setState: (state: unknown) => void };
    server.setState({ user: { id: "B" } }); server.setState({ user: { id: "A" } });
    expect(taskSources()[0].session.revision).toBeGreaterThan(before.session.revision);
    await expect(client.list()).rejects.toMatchObject({ code: "session_changed" });
    server.setState({ user: null, phase: "signed-out" }); expect(taskSources()).toEqual([]);
    server.setState({ user: { id: "A" }, phase: "ready" });
});
it("invalidates the session when a channel key changes", async () => {
    const before = taskSources()[0], client = taskClient(before), config = useConfigStore.getState().config;
    useConfigStore.setState({ config: { ...config, channels: config.channels.map(channel => ({ ...channel, apiKey: "rotated" })) } });
    await expect(client.list()).rejects.toMatchObject({ code: "session_changed" });
});
