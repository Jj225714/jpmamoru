import { expect, it, vi } from "vitest";
vi.mock("../assets/generation-info", () => ({ restoreGenerationInput: vi.fn() }));
import { beginAssetReuse } from "../assets/asset-reuse";
import type { AssetGenerationInfo } from "../assets/generation-info";
import { ReferenceReadiness } from "./reference-readiness";
import { ReferenceInputState } from "./reference-input-state";
import { moveReferenceById, snapshotReferenceOrder } from "./reference-order";
const info: AssetGenerationInfo = { version: 1, prompt: "old", model: "old-model", parameters: {}, references: [], source: { kind: "image" } };
const restored = { prompt: "old", model: "old-model", parameters: {}, references: [] };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
it("reproduces unowned restore overwriting a newly uploaded reference", async () => {
    const queue = new ReferenceReadiness(); let finish!: (input: typeof restored) => void; let images = ["existing"];
    beginAssetReuse(queue, info, () => { images = ["old"]; }, () => new Promise(resolve => { finish = resolve; }));
    queue.add("new", async () => "new", value => { images.push(value); }); await flush();
    expect(images).toContain("new"); finish(restored); await flush(); expect(images).toEqual(["old"]);
});
it("new input cancels only the restore; concurrent uploads survive and old parameters cannot commit", async () => {
    const queue = new ReferenceReadiness(), input = new ReferenceInputState(), commit = vi.fn();
    let finish!: (value: typeof restored) => void;
    input.attachRestore(beginAssetReuse(queue, info, commit, () => new Promise(resolve => { finish = resolve; })));
    input.request("A"); const uploads = vi.fn(); queue.add("A", async () => "A", uploads);
    input.request("B"); queue.add("B", async () => "B", uploads);
    finish(restored); await flush();
    expect(commit).not.toHaveBeenCalled(); expect(uploads.mock.calls).toEqual([["A"], ["B"]]); expect(queue.ready()).toBe(true);
});
it("late older upload and retry cannot steal focus from newer input or explicit selection", async () => {
    const queue = new ReferenceReadiness(), input = new ReferenceInputState(), focus = vi.fn();
    const read = vi.fn<() => Promise<string>>().mockRejectedValueOnce(Error("failed")).mockResolvedValue("old");
    input.request("old"); const task = queue.add("old", read, id => { if (input.completed(id)) focus(id); }); await flush();
    input.request("new"); if (input.completed("new")) focus("new"); queue.retry(task); await flush();
    expect(focus.mock.calls).toEqual([["new"]]);
    input.request("pending"); input.select("existing"); expect(input.completed("pending")).toBe(false);
});
it("retry of the latest failed upload can reveal that image", async () => {
    const input = new ReferenceInputState(), queue = new ReferenceReadiness(), focus = vi.fn();
    input.request("new"); const read = vi.fn<() => Promise<string>>().mockRejectedValueOnce(Error("fail")).mockResolvedValue("new");
    const task = queue.add("new", read, id => { if (input.completed(id)) focus(id); }); await flush();
    queue.retry(task); await flush(); expect(focus).toHaveBeenCalledExactlyOnceWith("new");
});
it("focus tracking never changes submitted reference order or a captured snapshot", () => {
    const input = new ReferenceInputState(); let images = [{ id: "A" }, { id: "B" }, { id: "C" }];
    const snapshot = snapshotReferenceOrder(images); input.select("B"); images = moveReferenceById(images, "B", -1);
    images = images.filter(image => image.id !== "A"); input.select("C");
    expect(images.map(image => image.id)).toEqual(["B", "C"]); expect(snapshot.map(image => image.id)).toEqual(["A", "B", "C"]);
    input.reset(); expect(input.completed("C")).toBe(false);
});
it("reserves selection order across reverse completion, failure retry, removal and explicit reorder", () => {
    const input = new ReferenceInputState();
    let images: Array<{ id: string }> = [];
    for (const id of ["A", "B", "C"]) input.request(id);
    images = input.insert(images, { id: "C" });
    images = input.insert(images, { id: "A" });
    // B may fail and complete only on retry; its original reservation remains.
    images = input.insert(images, { id: "B" });
    expect(images.map(item => item.id)).toEqual(["A", "B", "C"]);
    input.request("D", images.map(item => item.id));
    images = moveReferenceById(images, "C", -1); input.arrange(images.map(item => item.id));
    input.remove("A"); images = images.filter(item => item.id !== "A");
    images = input.insert(images, { id: "D" });
    expect(images.map(item => item.id)).toEqual(["C", "B", "D"]);
});
