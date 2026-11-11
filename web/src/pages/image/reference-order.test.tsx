import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReferenceOrderButtons, moveReferenceById, snapshotReferenceOrder } from "./reference-order";
import { ProductBasePromptController } from "./product-base-prompt-controller";
import { ReferenceReadiness } from "./reference-readiness";

const reference = (id: string) => ({ id, name: id, dataUrl: `data:${id}`, type: "image/png" });
const ids = (items: { id: string }[]) => items.map((item) => item.id);
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("general image reference ordering", () => {
    it("moves the same identity repeatedly without mutating the source", () => {
        const original = [reference("a"), reference("b"), reference("c")];
        let items = moveReferenceById(original, "c", -1);
        items = moveReferenceById(items, "c", -1);
        expect(ids(items)).toEqual(["c", "a", "b"]);
        expect(ids(original)).toEqual(["a", "b", "c"]);
        expect(ids(moveReferenceById(items, "c", 1))).toEqual(["a", "c", "b"]);
    });
    it("keeps first, last, single and removed identities unchanged at boundaries", () => {
        const items = [reference("a"), reference("b")];
        expect(moveReferenceById(items, "a", -1)).toBe(items);
        expect(moveReferenceById(items, "b", 1)).toBe(items);
        expect(moveReferenceById(items, "removed", 1)).toBe(items);
        const single = [reference("a")];
        expect(moveReferenceById(single, "a", 1)).toBe(single);
        expect(moveReferenceById([], "a", -1)).toEqual([]);
    });
    it("renders numbered, named native keyboard buttons with explicit boundary states", () => {
        const first = renderToStaticMarkup(<ReferenceOrderButtons index={0} total={3} onMove={() => {}} />);
        expect(first).toContain("参考图 1 / 3");
        expect(first).toContain('aria-label="参考图 1前移" aria-disabled="true"');
        expect(first).toContain('aria-label="参考图 1后移" aria-disabled="false"');
        expect(first).toContain('type="button"');
        const last = renderToStaticMarkup(<ReferenceOrderButtons index={2} total={3} onMove={() => {}} />);
        expect(last).toContain('aria-label="参考图 3后移" aria-disabled="true"');
        const single = renderToStaticMarkup(<ReferenceOrderButtons index={0} total={1} onMove={() => {}} />);
        expect(single.match(/aria-disabled="true"/g)).toHaveLength(2);
    });
    it("keeps controller/UI order and immutable submission snapshot in sync", () => {
        const controller = new ProductBasePromptController();
        controller.setReferences([reference("a"), reference("b"), reference("c")]);
        controller.setPrompt("manual");
        controller.setReferences((items) => moveReferenceById(items, "c", -1));
        controller.setReferences((items) => moveReferenceById(items, "c", -1));
        const submitted = snapshotReferenceOrder(controller.getSnapshot().references);
        expect(ids(submitted)).toEqual(["c", "a", "b"]);
        expect(controller.canGenerate()).toBe(true);
        controller.setReferences((items) => moveReferenceById(items, "c", 1));
        expect(ids(submitted)).toEqual(["c", "a", "b"]);
        expect(submitted[0]).not.toBe(controller.getSnapshot().references[1]);
        controller.cancel();
    });
    it("preserves reorder across upload completion, failure and retry without changing queue state", async () => {
        const controller = new ProductBasePromptController(), queue = new ReferenceReadiness();
        controller.setReferences([reference("a"), reference("b")]);
        let complete!: (value: ReturnType<typeof reference>) => void;
        queue.add("upload", () => new Promise<ReturnType<typeof reference>>((resolve) => { complete = resolve; }), (image) => controller.setReferences((items) => [...items, image]));
        let fail = true;
        const failedId = queue.add("retry", async () => { if (fail) throw new Error("failed"); return reference("d"); }, (image) => controller.setReferences((items) => [...items, image]));
        await flush();
        controller.setReferences((items) => moveReferenceById(items, "b", -1));
        expect(queue.getSnapshot().map((item) => item.status)).toEqual(["reading", "failed"]);
        complete(reference("c")); await flush();
        expect(ids(controller.getSnapshot().references)).toEqual(["b", "a", "c"]);
        expect(queue.ready()).toBe(false);
        controller.setReferences((items) => moveReferenceById(items, "c", -1));
        fail = false; queue.retry(failedId); await flush();
        expect(queue.ready()).toBe(true);
        expect(ids(snapshotReferenceOrder(controller.getSnapshot().references))).toEqual(["b", "c", "a", "d"]);
        controller.cancel();
    });
});
