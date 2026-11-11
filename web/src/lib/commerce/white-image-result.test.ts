import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WhiteResult } from "@/stores/use-product-white-store";
import { DEFAULT_WHITE_ADJUSTMENTS as defaults, whiteEditSignature, updateWhiteAdjustments } from "./white-image-edit";
const mocks = vi.hoisted(() => ({ render: vi.fn(), normalize: vi.fn() }));
vi.mock("./white-image-renderer", () => ({ renderWhiteImage: mocks.render, normalizeWhiteImage: mocks.normalize }));
import { materializeWhiteResult, whiteDraftForResult } from "./white-image-result";

const image = { url: "original", storageKey: "original", width: 1024, height: 1024, bytes: 100, mimeType: "image/jpeg" };
const record: WhiteResult = { id: "first", source: { id: "source", name: "商品", url: "source", source: "upload" }, image, createdAt: "2026-09-21" };
const editable: WhiteResult = {
    ...record,
    output: { size: 1024, format: "jpeg" },
    editor: { version: 1, layer: { ...image, url: "transparent", storageKey: "transparent" }, base: { width: 0.88, height: 0.44, bounds: { x: 0, y: 0, width: 1, height: 1 } }, applied: defaults },
};
beforeEach(() => {
    vi.clearAllMocks();
    mocks.render.mockResolvedValue({ ...image, url: "edited", storageKey: "edited" });
    mocks.normalize.mockResolvedValue({ ...image, url: "normalized" });
});
describe("white edit revisions", () => {
    it("saves background alpha and color and restores the identical export parameters", async () => {
        const draft = { ...whiteDraftForResult(editable), adjustments: { ...defaults, backgroundColor: "#123456", backgroundOpacity: 25 } };
        const next = await materializeWhiteResult(editable, draft, []);
        const reopened = JSON.parse(JSON.stringify(next)) as WhiteResult;
        expect(whiteDraftForResult(reopened)).toEqual(draft);
        expect(mocks.render).toHaveBeenCalledWith(editable.editor, draft.adjustments, draft.output);
        expect(await materializeWhiteResult(reopened, whiteDraftForResult(reopened), [reopened])).toBe(reopened);
    });
    it.each([true, false])("saves and reopens perspective with scale-first=%s and exports the same settings", async (scaleFirst) => {
        const base = editable.editor!.base;
        let settings = updateWhiteAdjustments(base, defaults, scaleFirst ? { scale: 150 } : { perspectiveEnabled: true });
        settings = updateWhiteAdjustments(base, settings, scaleFirst ? { perspectiveEnabled: true } : { scale: 150 });
        const draft = { adjustments: settings, output: { size: 1600 as const, format: "png" as const } };
        const saved = await materializeWhiteResult(editable, draft, []);
        const reopened = JSON.parse(JSON.stringify(saved)) as WhiteResult;
        expect(whiteDraftForResult(reopened)).toEqual(draft);
        expect(mocks.render).toHaveBeenCalledWith(editable.editor, settings, draft.output);
        expect(await materializeWhiteResult(reopened, whiteDraftForResult(reopened), [reopened])).toBe(reopened);
        expect(mocks.render).toHaveBeenCalledTimes(1);
        const resized = updateWhiteAdjustments(base, whiteDraftForResult(reopened).adjustments, { scale: 75 });
        expect(resized.perspective.topRight.x - resized.perspective.topLeft.x).toBeCloseTo(base.width * 0.75);
    });
    it("reads old records without a migration or reprocessing", async () => {
        const draft = whiteDraftForResult(record);
        expect(draft).toEqual({ adjustments: defaults, output: { size: 1024, format: "jpeg" } });
        expect(await materializeWhiteResult(record, draft, [record])).toBe(record);
        expect(mocks.render).not.toHaveBeenCalled();
        expect(mocks.normalize).not.toHaveBeenCalled();
    });
    it("restores saved drafts and their output settings over the committed revision", () => {
        const draft = { adjustments: { ...defaults, rotation: 35, temperature: 20 }, output: { size: 1600 as const, format: "png" as const } };
        expect(whiteDraftForResult({ ...editable, draft })).toEqual(draft);
    });
    it("renders a new version without modifying the original", async () => {
        const before = JSON.stringify(editable);
        const draft = { ...whiteDraftForResult(editable), adjustments: { ...defaults, rotation: 35, tint: 20 } };
        const next = await materializeWhiteResult(editable, draft, [editable]);
        expect(JSON.stringify(editable)).toBe(before);
        expect(next.id).not.toBe(editable.id);
        expect(next.rootId).toBe(editable.id);
        expect(next.editor?.applied).toEqual(draft.adjustments);
        expect(next.image.url).toBe("edited");
        expect(next.draft).toBeUndefined();
    });
    it("reuses the same materialized image for repeated downstream actions", async () => {
        const draft = whiteDraftForResult(editable);
        const committed = { ...editable, renderSignature: whiteEditSignature(editable.editor, draft.adjustments, draft.output) };
        expect(await materializeWhiteResult(committed, draft, [committed])).toBe(committed);
        expect(mocks.render).not.toHaveBeenCalled();
    });
    it("reuses a matching sibling revision without mixing different originals", async () => {
        const draft = whiteDraftForResult(editable);
        const signature = whiteEditSignature(editable.editor, draft.adjustments, draft.output);
        const unrelated = { ...editable, id: "other", renderSignature: signature };
        const sibling = { ...editable, id: "second", rootId: editable.id, renderSignature: signature };
        expect(await materializeWhiteResult(editable, draft, [unrelated, sibling])).toBe(sibling);
    });
    it("changing format alone creates a matching output version", async () => {
        const draft = { ...whiteDraftForResult(record), output: { size: 800 as const, format: "png" as const } };
        const next = await materializeWhiteResult(record, draft, [record]);
        expect(mocks.normalize).toHaveBeenCalledWith(image, draft.output);
        expect(next.output).toEqual(draft.output);
    });
    it("keeps failed renders and oversized PNGs from replacing history", async () => {
        const before = JSON.stringify(editable);
        mocks.render.mockRejectedValue(new Error("图片无法压缩到输出体积限制内"));
        await expect(materializeWhiteResult(editable, whiteDraftForResult(editable), [editable])).rejects.toThrow("体积限制");
        expect(JSON.stringify(editable)).toBe(before);
    });
    it("takes an immutable copy of parameters before asynchronous rendering", async () => {
        const draft = whiteDraftForResult(editable);
        const promise = materializeWhiteResult(editable, draft, []);
        draft.adjustments.rotation = 75;
        draft.output.size = 800;
        const next = await promise;
        expect(next.editor?.applied.rotation).toBe(0);
        expect(next.output?.size).toBe(1024);
    });
});
