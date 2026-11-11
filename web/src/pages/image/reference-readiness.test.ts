import { expect, it, vi } from "vitest";
import { ReferenceReadiness } from "./reference-readiness";
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
it("blocks rapid generation and concurrent batches until every upload commits", async () => {
    const queue = new ReferenceReadiness(), one = deferred<string>(), two = deferred<string>();
    const model = vi.fn(), commit = vi.fn();
    queue.add("one", () => one.promise, commit); queue.add("two", () => two.promise, commit);
    if (queue.ready()) model();
    one.resolve("one"); await flush(); if (queue.ready()) model();
    expect(model).not.toHaveBeenCalled();
    two.resolve("two"); await flush(); if (queue.ready()) model();
    expect(model).toHaveBeenCalledTimes(1); expect(commit).toHaveBeenCalledTimes(2);
});
it("keeps a failure blocking until retry succeeds or it is removed", async () => {
    const queue = new ReferenceReadiness(); const read = vi.fn().mockRejectedValueOnce(new Error("broken")).mockResolvedValueOnce("ok"); const commit = vi.fn();
    const id = queue.add("photo", read, commit); await flush(); expect(queue.ready()).toBe(false); expect(queue.getSnapshot()[0].status).toBe("failed");
    queue.retry(id); expect(queue.ready()).toBe(false); await flush(); expect(queue.ready()).toBe(true); expect(commit).toHaveBeenCalledOnce();
    const failed = queue.add("bad", async () => { throw new Error("bad"); }, commit); await flush(); queue.remove(failed); expect(queue.ready()).toBe(true);
});
it("ignores completions after removal and page/session changes", async () => {
    const queue = new ReferenceReadiness(), old = deferred<string>(), removed = deferred<string>(); const commit = vi.fn();
    queue.add("old", () => old.promise, commit); const id = queue.add("removed", () => removed.promise, commit);
    queue.remove(id); queue.reset(); old.resolve("old"); removed.resolve("removed"); await flush();
    expect(commit).not.toHaveBeenCalled(); expect(queue.getSnapshot()).toEqual([]);
});
it("keeps clipboard expansion blocked while child image reads are pending", async () => {
    const queue = new ReferenceReadiness(), image = deferred<string>();
    queue.add("clipboard", async () => "blob", () => { queue.add("image", () => image.promise, vi.fn()); });
    await flush(); expect(queue.ready()).toBe(false); image.resolve("ready"); await flush(); expect(queue.ready()).toBe(true);
});
