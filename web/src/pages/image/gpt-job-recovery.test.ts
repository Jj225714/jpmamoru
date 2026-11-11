import { beforeEach, expect, it, vi } from "vitest";
import { createStore, type StoreApi } from "zustand/vanilla";
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/services/server-config", () => ({ useServerConfigStore: createStore(() => ({ user: { id: "101" } as { id: string } | null, phase: "ready" })) }));
vi.mock("localforage", () => ({ default: { createInstance: () => ({ iterate: vi.fn(), setItem: vi.fn() }) } }));
import { useServerConfigStore } from "@/services/server-config";
import { defaultConfig, useConfigStore } from "@/stores/use-config-store";
import { createImageJobRecord, imageJobScope, imageJobStore, readImageJobs, recoverImageJob } from "./gpt-job-recovery";
import { createImageJobSessionGuard } from "./image-job-session";
const server = useServerConfigStore as unknown as StoreApi<{ user: { id: string } | null; phase: string }>;
const config = { ...defaultConfig, model: "default::gpt-image-2", channels: [{ ...defaultConfig.channels[0], apiKey: "TEST_SHARED", baseUrl: "https://llm.zhitouzhuan.com/v1" }] };
beforeEach(() => { server.setState({ user: { id: "101" }, phase: "ready" }); useConfigStore.setState({ config }); });
const record = async () => ({ ...createImageJobRecord({ operation: "generations", body: { prompt: "private" }, idempotencyKey: "intent-A" }, "private", config), scope: await imageJobScope(config) });
it("keeps unknown acknowledgement for review and never POSTs", async () => {
    const item = await record(), fetch = vi.fn();
    await expect(recoverImageJob(item, config, vi.fn(), { fetch })).rejects.toThrow("待核实");
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(item)).not.toContain("TEST_SHARED");
});
it.each([404, 409])("never creates replacement for old task response %s", async status => {
    const item = { ...await record(), jobId: "old-job" };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ error: { message: "requires review" } }), { status }));
    await expect(recoverImageJob(item, config, vi.fn(), { fetch })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]?.method).toBe("GET");
});
it("queries acknowledged task with the flag off and never invokes generation", async () => {
    const item = { ...await record(), jobId: "job-A" };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ job_id: "job-A", status: "succeeded", result: { data: [] } })));
    expect((await recoverImageJob(item, config, vi.fn(), { fetch })).jobId).toBe("job-A");
    expect(fetch.mock.calls[0][1]?.method).toBe("GET");
});
it("B sharing the key cannot read or recover A's durable intent", async () => {
    const item = { ...await record(), jobId: "job-A" }, fetch = vi.fn();
    vi.mocked(imageJobStore.iterate).mockImplementation(async callback => { callback(item, item.id, 1); });
    server.setState({ user: { id: "202" } });
    expect(await readImageJobs(await imageJobScope(config))).toEqual([]);
    await expect(recoverImageJob(item, config, vi.fn(), { fetch })).rejects.toThrow("账号或渠道");
    expect(fetch).not.toHaveBeenCalled();
});
it("does not adopt unowned legacy records", async () => {
    const item = { ...await record(), scope: undefined };
    vi.mocked(imageJobStore.iterate).mockImplementation(async callback => { callback(item, item.id, 1); });
    expect(await readImageJobs(await imageJobScope(config))).toEqual([]);
});
it("invalidates even synchronous A to B to A and channel changes", () => {
    const original = createImageJobSessionGuard(config);
    expect(original()?.accountId).toBe("101");
    server.setState({ user: { id: "202" } }); server.setState({ user: { id: "101" } });
    expect(original()).toBeNull();
    const next = createImageJobSessionGuard(config);
    useConfigStore.setState({ config: { ...config, channels: [{ ...config.channels[0], apiKey: "OTHER" }] } });
    expect(next()).toBeNull();
});
