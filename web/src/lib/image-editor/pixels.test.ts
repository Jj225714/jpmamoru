import { describe, expect, it } from "vitest";
import { blendMaskedPixels } from "./pixels";
import { estimateTextColor } from "./text-color";

describe("non-destructive pixels", () => {
    it("preserves every channel outside the mask and applies only white selected pixels", () => {
        const original = new Uint8ClampedArray([10, 20, 30, 17, 100, 80, 40, 255]);
        const generated = new Uint8ClampedArray([255, 0, 255, 255, 70, 60, 50, 255]);
        const mask = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);
        expect(Array.from(blendMaskedPixels(original, generated, mask))).toEqual([10, 20, 30, 17, 70, 60, 50, 255]);
        expect(Array.from(original)).toEqual([10, 20, 30, 17, 100, 80, 40, 255]);
    });
    it("rejects mismatched masks and treats transparent masks as no edit", () => {
        const source = new Uint8ClampedArray([10, 20, 30, 255]);
        expect(blendMaskedPixels(source, new Uint8ClampedArray(4), new Uint8ClampedArray([255, 255, 255, 0]))).toEqual(source);
        expect(() => blendMaskedPixels(source, source, new Uint8ClampedArray(8))).toThrow();
    });
    it.each([
        [255, 20],
        [15, 240],
    ])("estimates contrasting text on light and dark surfaces", (background, text) => {
        const values = Array.from({ length: 100 }, (_, i) => [...Array(3).fill(i < 80 ? background : text), 255]).flat();
        const expected = "#" + text.toString(16).padStart(2, "0").repeat(3);
        expect(estimateTextColor(new Uint8ClampedArray(values))).toBe(expected);
    });
});
