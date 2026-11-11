import { describe, expect, it, vi } from "vitest";
import { ReferenceReadiness } from "@/pages/image/reference-readiness";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("commerce reference admission and SKU session isolation", () => {
    it("blocks a same-tick generate click and waits for every concurrent upload", async () => {
        const queue = new ReferenceReadiness();
        const a = deferred<string>(), b = deferred<string>();
        const materials: string[] = [];
        queue.add("a", () => a.promise, (value) => materials.push(value));
        queue.add("b", () => b.promise, (value) => materials.push(value));
        expect(queue.ready()).toBe(false);
        b.resolve("b"); await flush();
        expect(queue.ready()).toBe(false);
        a.resolve("a"); await flush();
        expect(queue.ready()).toBe(true);
        expect(materials).toEqual(["b", "a"]);
    });
    it("keeps failed uploads blocking until retry or removal", async () => {
        const queue = new ReferenceReadiness();
        const read = vi.fn().mockRejectedValueOnce(new Error("upload failed")).mockResolvedValue("ready");
        const commit = vi.fn();
        const id = queue.add("photo", read, commit);
        await flush(); expect(queue.ready()).toBe(false);
        queue.retry(id); await flush(); expect(queue.ready()).toBe(true);
        expect(commit).toHaveBeenCalledOnce();
        const failed = queue.add("missing", async () => { throw new Error("missing"); }, commit);
        await flush(); queue.remove(failed); expect(queue.ready()).toBe(true);
    });
    it("ignores old SKU uploads after switching sessions and invalidates snapshots", async () => {
        const queue = new ReferenceReadiness();
        const old = deferred<string>();
        const commit = vi.fn();
        const current = queue.checkpoint();
        queue.add("old SKU", () => old.promise, commit);
        queue.reset();
        queue.add("new SKU", async () => "new", commit);
        old.resolve("old"); await flush();
        expect(commit.mock.calls).toEqual([["new"]]);
        expect(current()).toBe(false);
    });
    it("allows existing tasks with no pending upload, but ignores removed uploads", async () => {
        const queue = new ReferenceReadiness();
        expect(queue.ready()).toBe(true);
        const pending = deferred<string>(), commit = vi.fn();
        const id = queue.add("removed", () => pending.promise, commit);
        queue.remove(id); pending.resolve("late"); await flush();
        expect(commit).not.toHaveBeenCalled();
        expect(queue.ready()).toBe(true);
    });
});
