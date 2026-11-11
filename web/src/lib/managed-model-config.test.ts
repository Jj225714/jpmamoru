import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
import { defaultConfig, resolveModelRequestConfig, resolveModelScript, selectableModelsByCapability } from "@/stores/use-config-store";
import { managedEnabled, managedResponseStatus, withManagedModelConfig, queueManagedImage } from "./managed-model-config";
afterEach(() => vi.unstubAllGlobals());
it("never overlays server settings even when an old deployment flag is enabled", () => {
    vi.stubGlobal("window", { __RUNTIME_CONFIG__: { managedModelGatewayEnabled: true } });
    const config = { ...defaultConfig, channels: [{ ...defaultConfig.channels[0], apiKey: "personal", models: [{ name: "personal-model", capability: "text" as const, script: "custom" }] }] };
    expect(managedEnabled()).toBe(false);
    expect(withManagedModelConfig(config)).toBe(config);
    expect(resolveModelScript(config, "default::personal-model")).toBe("custom");
    expect(resolveModelRequestConfig(config, "default::personal-model")).toMatchObject({ apiKey: "personal", model: "personal-model" });
    expect(selectableModelsByCapability(config, "text")).toEqual(["default::personal-model"]);
});
it("does not emit access-code authorization events", () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    managedResponseStatus(401);
    managedResponseStatus(409, { error: { code: "principal_changed" } });
    expect(dispatchEvent).not.toHaveBeenCalled();
});
it("does not dispatch work canceled before it starts", async () => {
    const abort = new AbortController();
    abort.abort();
    const work = vi.fn();
    await expect(queueManagedImage(work, abort.signal)).rejects.toThrow();
    expect(work).not.toHaveBeenCalled();
});
