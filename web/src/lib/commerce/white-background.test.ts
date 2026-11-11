import { describe, expect, it } from "vitest";
import { DEFAULT_WHITE_ADJUSTMENTS as defaults, normalizeWhiteAdjustments, whiteEditSignature, whiteSamplePoint } from "./white-image-edit";
import { rememberWhiteEdit, travelWhiteEdit } from "./white-edit-history";

describe("white background parameters", () => {
    it("defaults old records to opaque white", () => {
        expect(normalizeWhiteAdjustments({ rotation: 20 })).toMatchObject({ backgroundColor: "#ffffff", backgroundOpacity: 100 });
    });
    it.each([[-10, 0], [0, 0], [50, 50], [100, 100], [200, 100], [NaN, 100], [Infinity, 100]])("normalizes opacity %s", (input, expected) => {
        expect(normalizeWhiteAdjustments({ backgroundOpacity: input }).backgroundOpacity).toBe(expected);
    });
    it.each([["#AbC", "#aabbcc"], ["#0123EF", "#0123ef"], ["red", "#ffffff"], ["#zzzzzz", "#ffffff"]])("normalizes color %s", (input, expected) => {
        expect(normalizeWhiteAdjustments({ backgroundColor: input }).backgroundColor).toBe(expected);
    });
    it("maps viewport coordinates to image pixels with scaling and edge clamping", () => {
        const rect = { left: 100, top: 200, width: 400, height: 200 };
        expect(whiteSamplePoint(300, 250, rect, 1600, 800)).toEqual({ x: 800, y: 200 });
        expect(whiteSamplePoint(500, 400, rect, 1600, 800)).toEqual({ x: 1599, y: 799 });
        expect(whiteSamplePoint(0, 0, rect, 1600, 800)).toEqual({ x: 0, y: 0 });
        expect(whiteSamplePoint(0, 0, { ...rect, width: 0 }, 1600, 800)).toBeUndefined();
    });
    it("includes backgrounds in result identity and restores them through undo/redo", () => {
        const changed = normalizeWhiteAdjustments({ ...defaults, backgroundColor: "#123456", backgroundOpacity: 25 });
        const output = { size: 1024 as const, format: "png" as const };
        expect(whiteEditSignature(undefined, defaults, output)).not.toBe(whiteEditSignature(undefined, changed, output));
        const undo = travelWhiteEdit(rememberWhiteEdit({ past: [], future: [] }, defaults), changed, "undo")!;
        expect(undo.value).toEqual(defaults);
        expect(travelWhiteEdit(undo.history, undo.value, "redo")?.value).toEqual(changed);
    });
});
