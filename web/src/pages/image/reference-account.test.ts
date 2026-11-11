import { afterEach, expect, it, vi } from "vitest";
import { createStore, type StoreApi } from "zustand/vanilla";
vi.mock("@/services/server-config", () => ({ useServerConfigStore: createStore(() => ({ user: { id: "A" } as { id: string } | null, phase: "ready" })) }));
import { useServerConfigStore } from "@/services/server-config";
import { bindReferenceAccount } from "./reference-readiness-panel";
import { ReferenceReadiness } from "./reference-readiness";
import { ProductBasePromptController } from "./product-base-prompt-controller";
const store = useServerConfigStore as unknown as StoreApi<{ user: { id: string } | null; phase: string }>;
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const delayed = () => { let resolve!: (value: string) => void; const promise = new Promise<string>(yes => { resolve = yes; }); return { promise, resolve }; };
afterEach(() => store.setState({ user: { id: "A" }, phase: "ready" }));
it.each(["B", "A", "logout"])("drops an old upload across account transition %s, including batched ABA", async target => {
    const queue = new ReferenceReadiness(), pending = delayed(), commit = vi.fn(), reset = vi.fn();
    const unsubscribe = bindReferenceAccount(queue, reset);
    queue.add("old-account.png", () => pending.promise, commit);
    const ready = queue.checkpoint();
    store.setState({ user: { id: "B" } });
    if (target === "A") store.setState({ user: { id: "A" } });
    if (target === "logout") store.setState({ user: null, phase: "signed-out" });
    pending.resolve("old"); await flush();
    expect(commit).not.toHaveBeenCalled(); expect(queue.getSnapshot()).toEqual([]); expect(ready()).toBe(false);
    expect(reset).toHaveBeenCalledTimes(target === "B" ? 1 : 2);
    unsubscribe();
});
it("clears ready references and pending automatic recognition on switch", async () => {
    const queue = new ReferenceReadiness(), controller = new ProductBasePromptController(), recognition = delayed();
    controller.configure("A", true, () => recognition.promise);
    controller.setReferences([{ id: "a", dataUrl: "data:a", name: "a", type: "image/png" }]);
    controller.retry();
    const unsubscribe = bindReferenceAccount(queue, controller.reset);
    store.setState({ user: { id: "B" } });
    recognition.resolve("A recognition"); await flush();
    expect(controller.getSnapshot().references).toEqual([]); expect(controller.getSnapshot().prompt).toBe(""); expect(controller.getSnapshot().stale).toBe(false);
    unsubscribe(); controller.cancel();
});
it("accepts only the new account upload after a project reset and ignores old failures", async () => {
    const queue = new ReferenceReadiness(), old = delayed(), commit = vi.fn();
    const unsubscribe = bindReferenceAccount(queue);
    queue.add("project A", () => old.promise, commit);
    queue.reset(); // same reset used by the canvas project-key layout effect
    store.setState({ user: { id: "B" } });
    queue.add("new B", async () => "new", commit);
    old.resolve("old"); await flush();
    expect(commit).toHaveBeenCalledExactlyOnceWith("new");
    expect(queue.getSnapshot().map(item => item.name)).toEqual(["new B"]);
    unsubscribe();
});
it("does not clear references for an unrelated save within the same account", () => {
    const queue = new ReferenceReadiness(), reset = vi.fn(), unsubscribe = bindReferenceAccount(queue, reset);
    store.setState({ phase: "saving" }); expect(reset).not.toHaveBeenCalled(); unsubscribe();
});
