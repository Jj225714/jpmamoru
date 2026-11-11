import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
import { defaultConfig, useConfigStore } from "@/stores/use-config-store";
import { editorPresets } from "@/lib/editor-providers";
import { captureEditorConfig, editCapabilities, runEditTask, type EditRequest } from "./image-editor";
const config = {
    ...defaultConfig,
    channels: [{ id: "fal", name: "personal", provider: "fal" as const, baseUrl: "https://queue.fal.run", apiKey: "snapshot-key", apiFormat: "openai" as const, models: editorPresets.fal }],
    editorBindings: { layers: "fal::fal-ai/qwen-image-layered" },
};
let sequence = 0;
const input = (): EditRequest => ({ operation: "layers", documentId: "draft", revision: 4, idempotencyKey: `one-${++sequence}`, image: "data:image/png;base64,fixture", width: 64, height: 32 });
afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    useConfigStore.setState({ config: defaultConfig });
});
describe("personal editor adapter", () => {
    it("does not submit an operation canceled before dispatch", async () => {
        const fetch = vi.fn();
        vi.stubGlobal("fetch", fetch);
        const controller = new AbortController();
        controller.abort();
        await expect(runEditTask(input(), controller.signal, vi.fn(), captureEditorConfig(config))).rejects.toMatchObject({ name: "AbortError" });
        expect(fetch).not.toHaveBeenCalled();
    });
    it("reports missing configuration locally without any authorization request", async () => {
        const fetch = vi.fn();
        vi.stubGlobal("fetch", fetch);
        const capabilities = await editCapabilities(defaultConfig);
        expect(capabilities.operations.layers.enabled).toBe(false);
        expect(capabilities.operations.layers.message).toContain("配置");
        expect(fetch).not.toHaveBeenCalled();
    });
    it("uses its initial credentials throughout polling even if settings change", async () => {
        vi.useFakeTimers();
        const fetch = vi.fn(
            async (url: string) => new Response(JSON.stringify(url.includes("/submit/") ? { request_id: "job-1" } : url.endsWith("/status") ? { status: "COMPLETED" } : { images: [{ url: "https://fal.media/result.png" }] }), { status: 200 }),
        );
        vi.stubGlobal("fetch", fetch);
        const snapshot = captureEditorConfig(config);
        const work = runEditTask(input(), new AbortController().signal, vi.fn(), snapshot);
        useConfigStore.setState({ config: { ...config, channels: config.channels.map((c) => ({ ...c, apiKey: "new-key" })) } });
        await vi.advanceTimersByTimeAsync(1300);
        const result = await work;
        expect(result.revision).toBe(4);
        expect(result.result?.images?.[0].url).toContain("/api/providers/media?");
        for (const [, init] of fetch.mock.calls as unknown as Array<[string, RequestInit]>) {
            expect(init.headers).toHaveProperty("Authorization", "Bearer snapshot-key");
            expect(init.headers).not.toHaveProperty("X-Managed-Principal");
            expect(init.credentials).toBe("omit");
        }
    });
    it("does not retry failed paid submissions", async () => {
        const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "service failure" } }), { status: 502 }));
        vi.stubGlobal("fetch", fetch);
        const request = input();
        await expect(runEditTask(request, new AbortController().signal, vi.fn(), captureEditorConfig(config))).rejects.toThrow("service failure");
        await expect(runEditTask(request, new AbortController().signal, vi.fn(), captureEditorConfig(config))).rejects.toThrow("service failure");
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});
