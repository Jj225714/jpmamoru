import { describe, expect, it } from "vitest";
import { adjustWhitePixels, centerWhiteImage, DEFAULT_WHITE_ADJUSTMENTS as defaults, fitWhiteImage, isWhiteImageClipped, normalizeWhiteAdjustments, whiteEditSignature, whiteImageBounds, type WhiteEditorData } from "./white-image-edit";

const base: WhiteEditorData["base"] = { width: 0.88, height: 0.44, bounds: { x: 0, y: 0, width: 1, height: 1 } };
describe("white product geometry", () => {
    it("rotates a landscape product around its center without changing its aspect ratio", () => {
        const bounds = whiteImageBounds(base, { ...defaults, rotation: 90 });
        expect(bounds.width).toBeCloseTo(0.44);
        expect(bounds.height).toBeCloseTo(0.88);
        expect(bounds.x + bounds.width / 2).toBeCloseTo(0.5);
        expect(bounds.y + bounds.height / 2).toBeCloseTo(0.5);
    });
    it.each([0, 35, 90, 135, -180])("fits rotated products fully inside the canvas at %s degrees", (rotation) => {
        const value = { ...defaults, rotation, scale: 300, x: -0.2, y: 1.3 };
        expect(isWhiteImageClipped(base, value)).toBe(true);
        const fitted = fitWhiteImage(base, value);
        expect(isWhiteImageClipped(base, fitted)).toBe(false);
        const b = whiteImageBounds(base, fitted);
        expect(Math.max(b.width, b.height)).toBeCloseTo(0.88);
    });
    it("preserves margins in legacy layers while centering only the visible product", () => {
        const legacy = { width: 1, height: 1, bounds: { x: 0.6, y: 0.2, width: 0.2, height: 0.4 } };
        const before = whiteImageBounds(legacy, defaults);
        expect(before.x).toBeCloseTo(0.6);
        const centered = whiteImageBounds(legacy, centerWhiteImage(legacy, { ...defaults, rotation: 35 }));
        expect(centered.x + centered.width / 2).toBeCloseTo(0.5);
        expect(centered.y + centered.height / 2).toBeCloseTo(0.5);
    });
    it("detects visible clipping without counting transparent margins", () => {
        const legacy = { width: 1, height: 1, bounds: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } };
        expect(isWhiteImageClipped(legacy, { ...defaults, scale: 300 })).toBe(false);
        expect(isWhiteImageClipped(legacy, { ...defaults, scale: 300, x: 0.1 })).toBe(true);
    });
    it("sanitizes non-finite inputs and wraps rotation", () => {
        expect(normalizeWhiteAdjustments({ rotation: 270, scale: 999, x: NaN, y: Infinity, tint: -999 })).toMatchObject({ rotation: -90, scale: 300, x: 0.5, y: 0.5, tint: -100 });
    });
});

describe("white product color", () => {
    it("keeps neutral pixels byte-identical, including transparent edges", () => {
        const pixels = new Uint8ClampedArray([123, 64, 217, 128, 255, 255, 255, 255, 11, 22, 33, 0]);
        const original = pixels.slice();
        adjustWhitePixels(pixels, defaults);
        expect(pixels).toEqual(original);
    });
    it("warms RGB without changing alpha or transparent pixels", () => {
        const pixels = new Uint8ClampedArray([100, 100, 100, 96, 11, 22, 33, 0]);
        adjustWhitePixels(pixels, { ...defaults, temperature: 100 });
        expect(pixels[0]).toBeGreaterThan(100);
        expect(pixels[2]).toBeLessThan(100);
        expect(pixels[3]).toBe(96);
        expect(Array.from(pixels.slice(4))).toEqual([11, 22, 33, 0]);
    });
    it("fully desaturates to neutral gray", () => {
        const pixels = new Uint8ClampedArray([180, 50, 80, 255]);
        adjustWhitePixels(pixels, { ...defaults, saturation: -100 });
        expect(pixels[0]).toBe(pixels[1]);
        expect(pixels[1]).toBe(pixels[2]);
    });
    it("includes output settings in result identity", () => {
        const editor = { version: 1, base, layer: { url: "layer", width: 20, height: 10, bytes: 10, mimeType: "image/png" }, applied: defaults } as WhiteEditorData;
        const key = whiteEditSignature(editor, defaults, { size: 1024, format: "jpeg" });
        expect(whiteEditSignature(editor, { ...defaults, rotation: 360 }, { size: 1024, format: "jpeg" })).toBe(key);
        expect(whiteEditSignature(editor, defaults, { size: 1600, format: "jpeg" })).not.toBe(key);
        expect(whiteEditSignature(editor, defaults, { size: 1024, format: "png" })).not.toBe(key);
    });
});
