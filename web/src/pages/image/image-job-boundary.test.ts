import { afterEach, expect, it, vi } from "vitest";
import axios from "axios";
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/services/image-storage", () => ({ imageToDataUrl: vi.fn() }));
import { imageToDataUrl } from "@/services/image-storage";
import { requestEdit, requestGeneration } from "@/services/api/image";
import { defaultConfig } from "@/stores/use-config-store";
const config = { ...defaultConfig, channels: [{ ...defaultConfig.channels[0], baseUrl: "https://llm.zhitouzhuan.com/v1", apiKey: "TEST" }] };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it.each(["generation", "edit"])("known job bypasses disabled flag, reference hydration and synchronous %s", async mode => {
    vi.stubGlobal("window", { location: { origin: "https://local.test" }, __RUNTIME_CONFIG__: { gptImageJobsEnabled: false } });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ job_id: "existing", status: "succeeded", result: { data: [{ b64_json: "AA==" }] } })));
    vi.stubGlobal("fetch", fetch);
    const post = vi.spyOn(axios, "post");
    const options = { jobId: "existing", sessionGuard: () => ({ accountId: "101", channelId: "default", revision: 1 }) };
    await (mode === "edit" ? requestEdit(config, "do not create", [{ id: "x", name: "missing", type: "image/png", dataUrl: "" }], options) : requestGeneration(config, "do not create", options));
    expect(fetch).toHaveBeenCalledTimes(1); expect(fetch.mock.calls[0][1]?.method).toBe("GET");
    expect(imageToDataUrl).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
});
it("waits for durable intent before create and aborts create if persistence fails", async () => {
    vi.stubGlobal("window", { location: { origin: "https://local.test" }, __RUNTIME_CONFIG__: { gptImageJobsEnabled: true } });
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const persist = vi.fn(async () => { expect(fetch).not.toHaveBeenCalled(); throw Error("storage full"); });
    await expect(requestGeneration(config, "private", { onJobIntent: persist })).rejects.toThrow("storage full");
    expect(persist).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
});
