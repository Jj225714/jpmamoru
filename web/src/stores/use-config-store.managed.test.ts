import { afterEach, expect, it, vi } from "vitest";
const saved = vi.hoisted(() => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
    vi.stubGlobal("window", { localStorage: storage });
    return values;
});
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
import { useConfigStore, defaultConfig, modelOptionLabel, CONFIG_STORE_KEY } from "./use-config-store";
const original = useConfigStore.getState().config;
afterEach(() => {
    useConfigStore.setState({ config: original });
    vi.unstubAllGlobals();
});

it("allows personal channel edits even with a stale managed deployment flag", () => {
    vi.stubGlobal("window", { __RUNTIME_CONFIG__: { managedModelGatewayEnabled: true } });
    useConfigStore.setState({ config: { ...defaultConfig } });
    const { updateConfig } = useConfigStore.getState();
    updateConfig("apiKey", "personal-key");
    updateConfig("imageModel", "personal::image");
    expect(useConfigStore.getState().config).toMatchObject({ apiKey: "personal-key", imageModel: "personal::image" });
    updateConfig("managedPrincipalId", "old");
    expect(useConfigStore.getState().config).not.toHaveProperty("managedPrincipalId");
});

it("strips snapshot ownership on persistence and hydration even if supplied directly", async () => {
    useConfigStore.setState({ config: { ...defaultConfig, managedPrincipalId: "A" } });
    expect(JSON.parse(saved.get(CONFIG_STORE_KEY)!).state.config).not.toHaveProperty("managedPrincipalId");
    saved.set(CONFIG_STORE_KEY, JSON.stringify({ state: { config: { ...defaultConfig, managedPrincipalId: "old-owner" } }, version: 0 }));
    await useConfigStore.persist.rehydrate();
    expect(useConfigStore.getState().config).not.toHaveProperty("managedPrincipalId");
});

it("still permits personal credential and model changes when managed mode is off", () => {
    vi.stubGlobal("window", { __RUNTIME_CONFIG__: {} });
    useConfigStore.getState().updateConfig("apiKey", "local-only");
    useConfigStore.getState().updateConfig("imageModel", "personal::model");
    expect(useConfigStore.getState().config).toMatchObject({ apiKey: "local-only", imageModel: "personal::model" });
});
