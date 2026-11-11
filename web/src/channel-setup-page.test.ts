import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ config: { channels: [], imageModel: "old", textModel: "old" } as unknown, setState: vi.fn() }));
vi.mock("@/stores/use-config-store", () => ({ CONFIG_STORE_KEY: "test-config", buildApiUrl: () => "/api/model-gateway/sub2api/v1/models", useConfigStore: { getState: () => ({ config: state.config }), setState: state.setState } }));
vi.mock("@/services/channel-config-file", () => ({ mergeChannelConfigFile: (_current: unknown, input: { channel: unknown }) => ({ channels: [{ ...input.channel as object, id: "new" }], imageModel: "new::gpt-image-2", textModel: "new::gpt-5.5" }) }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.resetModules(); });

async function setup(modelsOk: boolean) {
    const token = "a".repeat(43);
    const status = { textContent: "" };
    const values = new Map([["test-config", JSON.stringify({ state: { config: { imageModel: "old" } } })]]);
    const replace = vi.fn();
    vi.stubGlobal("location", { hash: `#setup=${token}`, pathname: "/channel-setup.html", replace });
    vi.stubGlobal("history", { replaceState: vi.fn() });
    vi.stubGlobal("document", { getElementById: () => status });
    vi.stubGlobal("localStorage", { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v) });
    state.setState.mockImplementation((value) => values.set("test-config", JSON.stringify({ state: value })));
    const fetch = vi.fn(async (url: string) => {
        if (url.endsWith("claim")) return { ok: true, json: async () => ({ channel: { baseUrl: "https://llm.zhitouzhuan.com/v1", apiKey: "private-test-key" } }) };
        if (url.endsWith("models")) return { ok: modelsOk, json: async () => ({ data: [{ id: "gpt-image-2" }, { id: "gpt-5.5" }] }) };
        return { ok: true };
    });
    vi.stubGlobal("fetch", fetch);
    await import("./channel-setup-page");
    return { fetch, replace, status, values };
}

it("persists verified personal models before acknowledging and returning to canvas", async () => {
    const { fetch, replace, values } = await setup(true);
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/canvas"));
    expect(state.setState).toHaveBeenCalledOnce();
    expect(values.has("test-config:before-sub2api")).toBe(true);
    const completion = fetch.mock.calls.find((call) => call[0].endsWith("complete"));
    expect(completion).toBeDefined();
    expect(JSON.stringify(completion)).not.toContain("private-test-key");
});

it("retains existing settings and sends no completion when model validation fails", async () => {
    const { fetch, replace, status } = await setup(false);
    await vi.waitFor(() => expect(status.textContent).toContain("模型连接验证失败"));
    expect(state.setState).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(fetch.mock.calls.some((call) => call[0].endsWith("complete"))).toBe(false);
});
