import { expect, it, vi } from "vitest";
vi.mock("./generation-info", () => ({ restoreGenerationInput: vi.fn() }));
import { beginAssetReuse, assetReuseLink } from "./asset-reuse";
import { ReferenceReadiness } from "../image/reference-readiness";
import type { AssetGenerationInfo } from "./generation-info";
const info: AssetGenerationInfo = { version: 1, prompt: "restore", model: "image", parameters: {}, references: [], source: { kind: "image" } };
const restored = { prompt: "restore", model: "image", parameters: {}, references: [] };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
it("commits the second effect setup after StrictMode cleanup cancels the first", async () => {
    const queue = new ReferenceReadiness(), commit = vi.fn();
    let first!: (input: typeof restored) => void;
    const read = vi.fn().mockImplementationOnce(() => new Promise(resolve => { first = resolve; })).mockResolvedValue(restored);
    const cleanup = beginAssetReuse(queue, info, commit, read); cleanup();
    beginAssetReuse(queue, info, commit, read); first(restored); await flush();
    expect(commit).toHaveBeenCalledExactlyOnceWith(restored); expect(queue.ready()).toBe(true);
});
it("drops old response on account reset or navigation cleanup", async () => {
    const queue = new ReferenceReadiness(), commit = vi.fn(); let resolve!: (input: typeof restored) => void;
    const cleanup = beginAssetReuse(queue, info, commit, () => new Promise(yes => { resolve = yes; }));
    queue.reset(); cleanup(); resolve(restored); await flush(); expect(commit).not.toHaveBeenCalled();
});
it("repeated reuse has a fresh request identity and reapplies the input", async () => {
    expect(assetReuseLink("same")).not.toBe(assetReuseLink("same"));
    const queue = new ReferenceReadiness(), commit = vi.fn(), read = vi.fn().mockResolvedValue(restored);
    beginAssetReuse(queue, info, commit, read); await flush(); beginAssetReuse(queue, info, commit, read); await flush(); expect(commit).toHaveBeenCalledTimes(2);
});
it("failed restore remains blocking, exposes error and retries the same snapshot", async () => {
    const queue = new ReferenceReadiness(), commit = vi.fn(), read = vi.fn().mockRejectedValueOnce(Error("missing reference")).mockResolvedValue(restored);
    beginAssetReuse(queue, info, commit, read); await flush(); expect(queue.ready()).toBe(false); expect(queue.getSnapshot()[0]).toMatchObject({ status: "failed", error: "missing reference" });
    queue.retry(queue.getSnapshot()[0].id); await flush(); expect(queue.ready()).toBe(true); expect(commit).toHaveBeenCalledOnce();
});
it("missing generation metadata is visible instead of silently showing an empty form", async () => {
    const queue = new ReferenceReadiness(); beginAssetReuse(queue, undefined, vi.fn()); await flush(); expect(queue.getSnapshot()[0].status).toBe("failed"); expect(queue.ready()).toBe(false);
});
