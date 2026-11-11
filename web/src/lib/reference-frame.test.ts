import { describe, expect, it } from "vitest";
import { referenceFrameGeometry, targetAspectMismatch } from "./reference-frame";

describe("reference frame", () => {
    it("centers a landscape reference in the selected square without cropping or stretching", () => {
        expect(referenceFrameGeometry(1600, 900, 1024, 1024)).toEqual({ width: 1600, height: 1600, x: 0, y: 350, imageWidth: 1600, imageHeight: 900 });
    });

    it("fits a portrait reference inside a landscape target", () => {
        const frame = referenceFrameGeometry(900, 1600, 1536, 1024);
        expect(frame).not.toBeNull();
        if (!frame) throw new Error("Expected framed reference");
        expect(frame.width / frame.height).toBe(1.5);
        expect(frame.imageWidth / frame.imageHeight).toBeCloseTo(900 / 1600);
        expect(frame.x).toBeGreaterThan(0);
        expect(frame.y).toBe(0);
    });

    it("keeps matching references untouched and caps large frames", () => {
        expect(referenceFrameGeometry(1024, 1024, 2048, 2048)).toBeNull();
        expect(referenceFrameGeometry(4000, 2000, 1024, 1024)?.width).toBe(2048);
    });

    it("detects only material output aspect mismatches", () => {
        expect(targetAspectMismatch(1600, 900, "1024x1024")).toBe(true);
        expect(targetAspectMismatch(1024, 1024, "1024x1024")).toBe(false);
        expect(targetAspectMismatch(1360, 2048, "2:3")).toBe(false);
        expect(targetAspectMismatch(1600, 900, "auto")).toBe(false);
    });
});
