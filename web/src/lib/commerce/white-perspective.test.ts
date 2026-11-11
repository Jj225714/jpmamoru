import { describe, expect, it } from "vitest";
import { DEFAULT_WHITE_ADJUSTMENTS as defaults, updateWhiteAdjustments, whiteImageBounds, fitWhiteImage, isWhiteImageClipped } from "./white-image-edit";
import { rememberWhiteEdit, travelWhiteEdit } from "./white-edit-history";

const base = { width: 0.8, height: 0.4, bounds: { x: 0, y: 0, width: 1, height: 1 } };
describe("white perspective and scale", () => {
    it.each([50, 150, 250])("preserves %s percent scale when enabling perspective", (scale) => {
        const scaled = updateWhiteAdjustments(base, defaults, { scale });
        const enabled = updateWhiteAdjustments(base, scaled, { perspectiveEnabled: true });
        expect(enabled.perspective.topRight.x - enabled.perspective.topLeft.x).toBeCloseTo(0.8 * scale / 100);
        const actual = whiteImageBounds(base, enabled), expected = whiteImageBounds(base, scaled);
        for (const key of ["x", "y", "width", "height"] as const) expect(actual[key]).toBeCloseTo(expected[key]);
    });
    it("scales an edited perspective around the product center without changing its shape", () => {
        const enabled = updateWhiteAdjustments(base, defaults, { perspectiveEnabled: true });
        const edited = updateWhiteAdjustments(base, enabled, { perspective: { ...enabled.perspective, topRight: { x: 0.8, y: 0.2 } } });
        const before = JSON.stringify(edited);
        const scaled = updateWhiteAdjustments(base, edited, { scale: 200 });
        for (const corner of Object.keys(edited.perspective) as (keyof typeof edited.perspective)[]) {
            expect(scaled.perspective[corner].x).toBeCloseTo(0.5 + (edited.perspective[corner].x - 0.5) * 2);
            expect(scaled.perspective[corner].y).toBeCloseTo(0.5 + (edited.perspective[corner].y - 0.5) * 2);
        }
        expect(JSON.stringify(edited)).toBe(before);
    });
    it("preserves perspective across off/on and scales it while disabled", () => {
        const enabled = updateWhiteAdjustments(base, defaults, { perspectiveEnabled: true });
        const off = updateWhiteAdjustments(base, enabled, { perspectiveEnabled: false });
        const scaled = updateWhiteAdjustments(base, off, { scale: 150 });
        const on = updateWhiteAdjustments(base, scaled, { perspectiveEnabled: true });
        expect(on).toEqual(updateWhiteAdjustments(base, enabled, { scale: 150 }));
    });
    it("keeps legacy saved perspective coordinates and supports further scaling", () => {
        const legacy = { ...defaults, perspectiveEnabled: true, scale: 150 };
        const resized = updateWhiteAdjustments(base, legacy, { scale: 300 });
        expect(resized.perspective.topLeft.x).toBeCloseTo(0);
        expect(resized.perspective.topRight.x).toBeCloseTo(1);
    });
    it("undoes and redoes a perspective resize without mutating snapshots", () => {
        const enabled = updateWhiteAdjustments(base, defaults, { perspectiveEnabled: true });
        const scaled = updateWhiteAdjustments(base, enabled, { scale: 200 });
        const history = rememberWhiteEdit({ past: [], future: [] }, enabled);
        const undo = travelWhiteEdit(history, scaled, "undo")!;
        expect(undo.value).toEqual(enabled);
        const redo = travelWhiteEdit(undo.history, undo.value, "redo")!;
        expect(redo.value).toEqual(scaled);
        redo.value.perspective.topLeft.x = 999;
        expect(scaled.perspective.topLeft.x).not.toBe(999);
        expect(rememberWhiteEdit(undo.history, undo.value).future).toEqual([]);
    });
    it("fits and centers a rotated, enlarged perspective using its rendered bounds", () => {
        const enabled = updateWhiteAdjustments(base, defaults, { perspectiveEnabled: true });
        const enlarged = updateWhiteAdjustments(base, enabled, { scale: 300, rotation: 35, x: 1.2 });
        expect(isWhiteImageClipped(base, enlarged)).toBe(true);
        const fitted = fitWhiteImage(base, enlarged);
        const bounds = whiteImageBounds(base, fitted);
        expect(isWhiteImageClipped(base, fitted)).toBe(false);
        expect(Math.max(bounds.width, bounds.height)).toBeCloseTo(0.88);
        expect(bounds.x + bounds.width / 2).toBeCloseTo(0.5);
        expect(bounds.y + bounds.height / 2).toBeCloseTo(0.5);
    });
});
