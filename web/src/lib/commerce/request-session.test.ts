import { beforeEach, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
vi.mock("@/stores/use-config-store", () => ({ useConfigStore: createStore(() => ({ config: {} })) }));
vi.mock("@/services/server-config", () => ({ useServerConfigStore: createStore(() => ({ user: { id: 1 }, teamRevision: 1, phase: "ready" })) }));
import { useConfigStore } from "@/stores/use-config-store";
import { useServerConfigStore } from "@/services/server-config";
import { captureCommerceRequestSession } from "./request-session";
beforeEach(() => useServerConfigStore.setState({ user: { id: 1 } as never, phase: "ready", teamRevision: 1 }));
it("rejects delayed results even after A to B to A", async () => {
    const session = captureCommerceRequestSession();
    useServerConfigStore.setState({ user: { id: 2 } as never });
    useServerConfigStore.setState({ user: { id: 1 } as never });
    await Promise.resolve();
    expect(session.isCurrent()).toBe(false);
    expect(session.assertCurrent).toThrow("已丢弃");session.dispose();
});
it.each(["team", "config"])("invalidates %s updates while allowing normal sync progress", (kind) => {
    const session = captureCommerceRequestSession();
    useServerConfigStore.setState({ phase: "saving" });expect(session.isCurrent()).toBe(true);
    if (kind === "team") useServerConfigStore.setState({ teamRevision: 2 });
    else useConfigStore.setState({ config: {} as never });
    expect(session.isCurrent()).toBe(false);session.dispose();
});
