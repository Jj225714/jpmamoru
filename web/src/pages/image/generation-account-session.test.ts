import { expect, it, vi } from "vitest";
import { createStore, type StoreApi } from "zustand/vanilla";
vi.mock("@/services/server-config", () => ({ useServerConfigStore: createStore(() => ({ user: { id: "A" } as { id: string } | null, phase: "ready" })) }));
import { useServerConfigStore } from "@/services/server-config";
import { getGenerationAccountRevision } from "./generation-account-session";
const store = useServerConfigStore as unknown as StoreApi<{ user: { id: string } | null; phase: string }>;
it("retains workbench across same-account checking/saving/ready", () => {
    const before = getGenerationAccountRevision();
    for (const phase of ["checking", "saving", "ready"]) store.setState({ phase });
    expect(getGenerationAccountRevision()).toBe(before);
});
it("changes the boundary on A to B to A even in one synchronous batch", () => {
    const before = getGenerationAccountRevision();
    store.setState({ user: { id: "B" } }); store.setState({ user: { id: "A" } });
    expect(getGenerationAccountRevision()).toBe(before + 2);
});
it("logout still clears account-owned work", () => {
    const before = getGenerationAccountRevision(); store.setState({ user: null, phase: "signed-out" });
    expect(getGenerationAccountRevision()).toBe(before + 1);
});
