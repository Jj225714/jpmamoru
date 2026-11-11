import { expect, it } from "vitest";
import { quadMatrix, mapPoint, inverseMatrix, projectWhitePixels, snapWhitePoint, QUAD_KEYS } from "./white-perspective";
import { DEFAULT_WHITE_ADJUSTMENTS as defaults, correctWhitePerspective, normalizeWhiteAdjustments, updateWhiteAdjustments } from "./white-image-edit";
import { rememberWhiteEdit, travelWhiteEdit } from "./white-edit-history";
const quad = { topLeft: { x: 0.1, y: 0.2 }, topRight: { x: 0.85, y: 0.1 }, bottomRight: { x: 0.7, y: 0.8 }, bottomLeft: { x: 0.2, y: 0.9 } };
const base = { width: 0.8, height: 0.6, bounds: { x: 0, y: 0, width: 1, height: 1 } };
it("maps all four corners and a known grid with subpixel inverse error", () => {
    const matrix = quadMatrix(quad),
        inverse = inverseMatrix(matrix);
    [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
    ].forEach(([x, y], i) => {
        const p = mapPoint(matrix, x, y);
        expect(p.x).toBeCloseTo(quad[QUAD_KEYS[i]].x, 12);
        expect(p.y).toBeCloseTo(quad[QUAD_KEYS[i]].y, 12);
    });
    for (let y = 0; y <= 10; y++)
        for (let x = 0; x <= 10; x++) {
            const p = mapPoint(matrix, x / 10, y / 10),
                q = mapPoint(inverse, p.x, p.y);
            expect(Math.hypot(q.x - x / 10, q.y - y / 10) * 1600).toBeLessThan(1e-8);
        }
});
it("moving each corner changes actual raster pixels, including bottomRight", () => {
    const source = { width: 16, height: 16, data: new Uint8ClampedArray(16 * 16 * 4) };
    for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++) {
            const i = (y * 16 + x) * 4;
            source.data.set([x % 4 === 0 ? 255 : 0, y % 4 === 0 ? 255 : 0, 0, 255], i);
        }
    const original = projectWhitePixels(source, quad, 128);
    for (const key of QUAD_KEYS) {
        const changed = { ...quad, [key]: { x: quad[key].x + 0.03, y: quad[key].y + 0.02 } };
        expect(projectWhitePixels(source, changed, 128)).not.toEqual(original);
    }
});
it("filters alpha without introducing white fringe", () => {
    const source = { width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 0, 128, 255, 255, 255, 0]) };
    const pixels = projectWhitePixels(source, { topLeft: { x: 0, y: 0 }, topRight: { x: 1, y: 0 }, bottomRight: { x: 1, y: 1 }, bottomLeft: { x: 0, y: 1 } }, 8);
    for (let i = 0; i < pixels.length; i += 4)
        if (pixels[i + 3]) {
            expect(pixels[i]).toBe(255);
            expect(pixels[i + 1]).toBe(0);
            expect(pixels[i + 2]).toBe(0);
        }
});
it("rejects crossed/degenerate quads and bounds offscreen work", () => {
    expect(() => quadMatrix({ ...quad, bottomRight: quad.topLeft })).toThrow();
    expect(() => quadMatrix({ ...quad, bottomLeft: quad.bottomRight, bottomRight: quad.bottomLeft })).toThrow();
    const settings = normalizeWhiteAdjustments({ ...defaults, perspective: { ...quad, topLeft: { x: Infinity, y: -1e10 } } });
    expect(settings.perspective.topLeft).toEqual({ x: 0.25, y: -16 });
    const off = Object.fromEntries(QUAD_KEYS.map((k) => [k, { x: quad[k].x + 10, y: quad[k].y + 10 }])) as typeof quad;
    expect(projectWhitePixels({ width: 1, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255]) }, off, 16).some((v) => v !== 0)).toBe(false);
});
it("snaps only within adjustable tolerance", () => {
    expect(snapWhitePoint({ x: 0.496, y: 0.303 }, 0.1, 0.01, { x: 0.5, y: 0.5 })).toEqual({ x: 0.5, y: 0.30000000000000004 });
    expect(snapWhitePoint({ x: 0.47, y: 0.32 }, 0.1, 0.001, { x: 0.5, y: 0.5 })).toEqual({ x: 0.47, y: 0.32 });
});
it("corrects the warped grid, supports scale/off/on, and preserves immutable undo snapshots", () => {
    const warped = { ...defaults, perspectiveEnabled: true, perspectiveInitialized: true, perspective: quad };
    const corrected = correctWhitePerspective(base, warped);
    const m = quadMatrix(corrected.perspective);
    for (let y = 0; y <= 4; y++)
        for (let x = 0; x <= 4; x++) {
            const p = mapPoint(m, x / 4, y / 4);
            expect(p.x).toBeCloseTo(0.1 + (x / 4) * 0.8, 12);
            expect(p.y).toBeCloseTo(0.2 + (y / 4) * 0.6, 12);
        }
    const scaled = updateWhiteAdjustments(base, warped, { scale: 150 });
    const off = updateWhiteAdjustments(base, scaled, { perspectiveEnabled: false });
    expect(updateWhiteAdjustments(base, off, { perspectiveEnabled: true })).toEqual(scaled);
    const undo = travelWhiteEdit(rememberWhiteEdit({ past: [], future: [] }, warped), corrected, "undo")!;
    expect(undo.value.perspective).toEqual(quad);
    expect(travelWhiteEdit(undo.history, undo.value, "redo")?.value).toEqual(corrected);
    expect(JSON.parse(JSON.stringify(scaled))).toEqual(scaled);
});
