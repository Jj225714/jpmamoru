import { describe, expect, it } from "vitest";
import { DEFAULT_WHITE_ADJUSTMENTS, updateWhiteAdjustments } from "./white-image-edit";
import { projectWhitePixels, type Point, type Quad } from "./white-perspective";
import {
    createWhiteGeometrySnapshot,
    evaluateWhiteGeometryAnchors,
    isWhiteGeometrySnapshotCurrent,
    layerUVToOutputPixel,
    outputPixelToLayerUV,
    sourcePixelToLayerUV,
    type GeometryAnchor,
    type GeometryPixels,
    type SavedGeometryRecord,
    type WhiteGeometrySnapshot,
} from "./white-geometry-snapshot";

/** Deterministic RGBA fixture, never model-generated. Any 200x160mm interpretation
 * is a fictitious test definition only; the production adapter has no mm/DPI API.
 * Registration corners and nine internal validation centers are disjoint.
 */
function fixture() {
    const data = new Uint8ClampedArray(512 * 512 * 4);
    const put = (x: number, y: number, rgba: number[]) => data.set(rgba, (y * 512 + x) * 4);
    for (let y = 128; y < 384; y++)
        for (let x = 96; x < 416; x++) {
            put(x, y, [180, 150, 100, x === 96 || x === 415 || y === 128 || y === 383 ? 128 : 255]);
        }
    // 80px ruler, 16px ticks; endpoints describe pixel edges.
    for (let x = 144; x <= 224; x++) for (let y = 350; y < 353; y++) put(x, y, [0, 0, 0, 255]);
    for (let x = 144; x <= 224; x += 16) for (let y = 344; y < 357; y++) put(x, y, [0, 0, 0, 255]);
    // White pattern block must remain opaque, including when RGB equals background.
    for (let y = 340; y < 360; y++) for (let x = 350; x < 380; x++) put(x, y, [255, 255, 255, 255]);
    for (let dy = -8; dy <= 8; dy++)
        for (let dx = -8; dx <= 8; dx++) {
            if (dx * dx + dy * dy <= 64) put(128 + dx, 160 + dy, [255, 0, 0, 255]);
            if (dy >= -8 && Math.abs(dx) <= (dy + 8) / 2) put(384 + dx, 160 + dy, [0, 180, 0, 255]);
            if (Math.abs(dx) <= 2 || Math.abs(dy) <= 2) put(128 + dx, 320 + dy, [0, 0, 255, 255]);
            if (dx <= -4 || dy >= 4) put(384 + dx, 320 + dy, [128, 0, 180, 255]);
        }
    const anchors: GeometryAnchor[] = [
        [96, 128],
        [416, 128],
        [416, 384],
        [96, 384],
    ].map(([x, y], i) => ({ id: `corner-${i}`, uv: { x: x / 512, y: y / 512 }, role: "registration" }));
    for (const y of [200, 256, 312])
        for (const x of [200, 256, 312]) {
            anchors.push({ id: `pattern-${x}-${y}`, uv: { x: (x + 0.5) / 512, y: (y + 0.5) / 512 }, role: "validation" });
            for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) put(x + dx, y + dy, [0, 255, 255, 255]);
        }
    return { pixels: { width: 512, height: 512, data }, anchors };
}
function record(): SavedGeometryRecord {
    return {
        id: "saved-1",
        rootId: "root",
        createdAt: "2026-10-26T00:00:00Z",
        source: { id: "source-1" },
        output: { size: 1024, format: "png" },
        renderSignature: "same-url-is-not-content",
        editor: {
            version: 1,
            layer: { url: "same-url", width: 512, height: 512, bytes: 1, mimeType: "image/png" },
            base: { width: 1, height: 1, bounds: { x: 96 / 512, y: 128 / 512, width: 320 / 512, height: 256 / 512 } },
            applied: structuredClone(DEFAULT_WHITE_ADJUSTMENTS),
        },
    };
}
async function snapshot(r = record(), source = fixture().pixels, layer = source): Promise<WhiteGeometrySnapshot> {
    const result = await createWhiteGeometrySnapshot({ record: r, sourcePixels: source, layerPixels: layer, sourceToLayer: { kind: "identity" } });
    if (result.status !== "ready") throw new Error(result.reason);
    return result.snapshot;
}
function point(result: ReturnType<typeof layerUVToOutputPixel>): Point {
    if (result.status !== "measurable") throw new Error(result.reason);
    return result.point;
}
const trapezoid: Quad = { topLeft: { x: 0.2, y: 0.2 }, topRight: { x: 0.8, y: 0.2 }, bottomRight: { x: 0.9, y: 0.8 }, bottomLeft: { x: 0.1, y: 0.8 } };
// Independent reference formula, not quadMatrix/mapPoint or adapter output.
const expectedPerspective = ({ x: u, y: v }: Point) => ({ x: (1024 * (0.6 * u - 0.125 * v + 0.2)) / (1 - 0.25 * v), y: (1024 * (0.4 * v + 0.2)) / (1 - 0.25 * v) });
const gate = { maxPx: 2, rmsePx: 1 };

describe("saved white geometry snapshot", () => {
    it("keeps the 512 RGBA fixture, subject ratio, ruler, alpha edge and white pattern", async () => {
        const f = fixture();
        const repeated = fixture().pixels.data;
        expect(f.pixels.data.every((value, index) => value === repeated[index])).toBe(true);
        expect(f.pixels.data[(128 * 512 + 96) * 4 + 3]).toBe(128);
        expect(Array.from(f.pixels.data.slice((345 * 512 + 360) * 4, (345 * 512 + 360) * 4 + 4))).toEqual([255, 255, 255, 255]);
        const s = await snapshot();
        const tl = point(layerUVToOutputPixel(s, { x: 96 / 512, y: 128 / 512 }));
        const br = point(layerUVToOutputPixel(s, { x: 416 / 512, y: 384 / 512 }));
        expect(br.x - tl.x).toBe(640);
        expect(br.y - tl.y).toBe(512);
        expect((br.x - tl.x) / (br.y - tl.y)).toBe(1.25);
        const a = point(layerUVToOutputPixel(s, { x: 144 / 512, y: 350 / 512 }));
        const b = point(layerUVToOutputPixel(s, { x: 224 / 512, y: 350 / 512 }));
        expect(b.x - a.x).toBe(160);
    });

    it.each([50, 150])("matches independent scaling and rotation formula at %s%%", async (scale) => {
        const r = record();
        r.editor!.applied = { ...r.editor!.applied, scale, rotation: 30 };
        const s = await snapshot(r);
        const uv = { x: 0.6, y: 0.4 };
        const dx = (0.1 * scale) / 100,
            dy = (-0.1 * scale) / 100;
        const p = point(layerUVToOutputPixel(s, uv));
        expect(p.x).toBeCloseTo(1024 * (0.5 + (dx * Math.sqrt(3)) / 2 - dy / 2));
        expect(p.y).toBeCloseTo(1024 * (0.5 + dx / 2 + (dy * Math.sqrt(3)) / 2));
        const back = point(outputPixelToLayerUV(s, p));
        expect(back.x).toBeCloseTo(uv.x);
        expect(back.y).toBeCloseTo(uv.y);
    });

    it("uses absolute quad once and agrees with independent trapezoid and raster centroids", async () => {
        const r = record(),
            f = fixture();
        r.editor!.applied = { ...r.editor!.applied, perspectiveEnabled: true, perspective: trapezoid, scale: 150, rotation: 30 };
        const s = await snapshot(r, f.pixels);
        const raster = projectWhitePixels(f.pixels, trapezoid, 1024);
        const observed = f.anchors
            .filter((a) => a.role === "validation")
            .map((a) => {
                const expected = expectedPerspective(a.uv);
                const mapped = point(layerUVToOutputPixel(s, a.uv));
                expect(mapped.x).toBeCloseTo(expected.x, 8);
                expect(mapped.y).toBeCloseTo(expected.y, 8);
                const back = point(outputPixelToLayerUV(s, mapped));
                expect(back.x).toBeCloseTo(a.uv.x, 8);
                expect(back.y).toBeCloseTo(a.uv.y, 8);
                // Local cyan detector: alpha-weighted pixel-center centroid, never nearest pixel.
                let weight = 0,
                    sx = 0,
                    sy = 0;
                for (let y = Math.floor(expected.y) - 10; y <= Math.ceil(expected.y) + 10; y++)
                    for (let x = Math.floor(expected.x) - 10; x <= Math.ceil(expected.x) + 10; x++) {
                        const i = (y * 1024 + x) * 4;
                        if (raster[i] < 60 && raster[i + 1] > 220 && raster[i + 2] > 220) {
                            const w = raster[i + 3] / 255;
                            weight += w;
                            sx += (x + 0.5) * w;
                            sy += (y + 0.5) * w;
                        }
                    }
                expect(weight).toBeGreaterThan(0);
                return { id: a.id, outputPx: { x: sx / weight, y: sy / weight } };
            });
        expect(evaluateWhiteGeometryAnchors(s, f.anchors, observed, gate)).toMatchObject({ status: "pass", matched: 9 });
    });

    it("handles scale-before-perspective and perspective-before-scale identically", async () => {
        const a = record(),
            b = record();
        a.editor!.applied = updateWhiteAdjustments(a.editor!.base, a.editor!.applied, { scale: 50 });
        a.editor!.applied = updateWhiteAdjustments(a.editor!.base, a.editor!.applied, { perspectiveEnabled: true });
        b.editor!.applied = updateWhiteAdjustments(b.editor!.base, b.editor!.applied, { perspectiveEnabled: true });
        b.editor!.applied = updateWhiteAdjustments(b.editor!.base, b.editor!.applied, { scale: 50 });
        expect((await snapshot(a)).layerToOutput).toEqual((await snapshot(b)).layerToOutput);
    });

    it("requires explicit crop provenance, and never assumes AI redraw identity", async () => {
        const source = fixture().pixels;
        const layer: GeometryPixels = { width: 320, height: 256, data: new Uint8ClampedArray(320 * 256 * 4) };
        for (let y = 0; y < 256; y++) layer.data.set(source.data.subarray(((y + 128) * 512 + 96) * 4, ((y + 128) * 512 + 416) * 4), y * 320 * 4);
        const r = record();
        r.editor!.layer.width = 320;
        r.editor!.layer.height = 256;
        const result = await createWhiteGeometrySnapshot({ record: r, sourcePixels: source, layerPixels: layer, sourceToLayer: { kind: "crop", cropPx: { x: 96, y: 128, width: 320, height: 256 } } });
        if (result.status !== "ready") throw new Error(result.reason);
        expect(sourcePixelToLayerUV(result.snapshot, { x: 256, y: 256 })).toEqual({ status: "measurable", point: { x: 0.5, y: 0.5 } });
        expect(sourcePixelToLayerUV(result.snapshot, { x: 0, y: 0 })).toMatchObject({ status: "not-measurable", reason: "outside-layer" });
        for (const provenance of [undefined, { kind: "unknown", reason: "ai-redraw" } as const]) {
            const unknown = await createWhiteGeometrySnapshot({ record: record(), sourcePixels: source, layerPixels: source, sourceToLayer: provenance });
            if (unknown.status !== "ready") throw new Error(unknown.reason);
            expect(sourcePixelToLayerUV(unknown.snapshot, { x: 256, y: 256 }).status).toBe("not-measurable");
            expect(layerUVToOutputPixel(unknown.snapshot, { x: 0.5, y: 0.5 }).status).toBe("measurable");
        }
    });

    it("freezes/copies before awaiting and invalidates content, saved version and parameters", async () => {
        const r = record(),
            pixels = fixture().pixels;
        const pending = snapshot(r, pixels);
        r.id = "changed-during-hash";
        r.editor!.applied.scale = 50;
        pixels.data[0] = 1;
        const original = await pending,
            baseline = await snapshot();
        expect(isWhiteGeometrySnapshotCurrent(original, baseline)).toBe(true);
        expect(Object.isFrozen(original.applied.perspective.topLeft)).toBe(true);
        expect(Object.isFrozen(original.layerToOutput)).toBe(true);
        const changedPixels = fixture().pixels;
        changedPixels.data[0] = 1;
        for (const next of [await snapshot(record(), changedPixels), await snapshot(record(), fixture().pixels, changedPixels)]) {
            expect(isWhiteGeometrySnapshotCurrent(original, next)).toBe(false);
        }
        for (const edit of [(v: SavedGeometryRecord) => (v.id = "saved-2"), (v: SavedGeometryRecord) => (v.editor!.applied.scale = 50), (v: SavedGeometryRecord) => (v.output!.format = "jpeg"), (v: SavedGeometryRecord) => (v.output!.size = 800)]) {
            const next = record();
            edit(next);
            expect(isWhiteGeometrySnapshotCurrent(original, await snapshot(next))).toBe(false);
        }
        const draftRecord = { ...record(), draft: { adjustments: { scale: 200 } } };
        expect(isWhiteGeometrySnapshotCurrent(original, await snapshot(draftRecord))).toBe(true);
    });

    it("reports held-out errors, missing points, duplicate IDs and registration reuse", async () => {
        const s = await snapshot(),
            f = fixture();
        const observations = f.anchors.filter((a) => a.role === "validation").map((a) => ({ id: a.id, outputPx: { x: a.uv.x * 1024, y: a.uv.y * 1024 } }));
        expect(evaluateWhiteGeometryAnchors(s, f.anchors, observations, gate)).toMatchObject({ status: "pass", maxPx: 0, rmsePx: 0 });
        observations[0].outputPx.x += 8;
        expect(evaluateWhiteGeometryAnchors(s, f.anchors, observations, gate)).toMatchObject({ status: "deviation", maxPx: 8, rmsePx: 8 / 3 });
        expect(evaluateWhiteGeometryAnchors(s, f.anchors, observations.slice(1), gate).status).toBe("not-measurable");
        expect(evaluateWhiteGeometryAnchors(s, f.anchors, [...observations, observations[0]], gate).status).toBe("not-measurable");
        expect(evaluateWhiteGeometryAnchors(s, f.anchors.slice(0, 4), [], gate).status).toBe("not-measurable");
        expect(evaluateWhiteGeometryAnchors(s, [...f.anchors, { ...f.anchors[0], id: "reused", role: "validation" }], observations, gate).reasons).toContain("reused:registration-point-reused");
    });

    it("does not pass degenerate, nonfinite, clipped or missing saved geometry", async () => {
        const r = record();
        r.editor!.applied.perspectiveEnabled = true;
        r.editor!.applied.perspective.bottomRight = r.editor!.applied.perspective.topLeft;
        const s = await snapshot(r);
        expect(layerUVToOutputPixel(s, { x: 0.5, y: 0.5 })).toMatchObject({ status: "not-measurable" });
        const baseline = await snapshot();
        expect(layerUVToOutputPixel(baseline, { x: NaN, y: 0.5 }).status).toBe("not-measurable");
        expect(outputPixelToLayerUV(baseline, { x: -1, y: 5 }).status).toBe("not-measurable");
        r.editor!.applied.perspectiveEnabled = false;
        r.editor!.applied.x = 2;
        expect(layerUVToOutputPixel(await snapshot(r), { x: 0.5, y: 0.5 }).status).toBe("not-measurable");
        delete r.editor;
        const pixels = fixture().pixels;
        expect(await createWhiteGeometrySnapshot({ record: r, sourcePixels: pixels, layerPixels: pixels })).toMatchObject({ status: "not-measurable", reason: "missing-saved-editor-or-output" });
    });

    it.each([800, 1600] as const)("maps pixel edges and centers at output %s", async (size) => {
        const r = record();
        r.output!.size = size;
        const s = await snapshot(r);
        expect(point(layerUVToOutputPixel(s, { x: 1, y: 1 }))).toEqual({ x: size, y: size });
        expect(point(layerUVToOutputPixel(s, { x: 0.5 / 512, y: 0.5 / 512 }))).toEqual({ x: (size * 0.5) / 512, y: (size * 0.5) / 512 });
        expect(s.transformVersion).toBe("projective-v2");
    });

    it("rejects bad pixels/provenance and reports mirrored or obscured observations", async () => {
        const pixels = fixture().pixels,
            r = record();
        expect(await createWhiteGeometrySnapshot({ record: r, sourcePixels: { ...pixels, data: new Uint8ClampedArray(4) }, layerPixels: pixels })).toMatchObject({ status: "not-measurable", reason: "invalid-rgba" });
        expect(await createWhiteGeometrySnapshot({ record: r, sourcePixels: pixels, layerPixels: pixels, sourceToLayer: { kind: "crop", cropPx: { x: 96, y: 128, width: 320, height: 256 } } })).toMatchObject({
            status: "not-measurable",
            reason: "invalid-crop-provenance",
        });
        const s = await snapshot(),
            anchors = fixture().anchors;
        const mirrored = anchors.filter((a) => a.role === "validation").map((a) => ({ id: a.id, outputPx: { x: (1 - a.uv.x) * 1024, y: a.uv.y * 1024 } }));
        expect(evaluateWhiteGeometryAnchors(s, anchors, mirrored, gate).status).toBe("deviation");
        mirrored[0].outputPx.x = NaN;
        expect(evaluateWhiteGeometryAnchors(s, anchors, mirrored, gate).status).toBe("not-measurable");
        expect(evaluateWhiteGeometryAnchors(s, anchors, mirrored, { maxPx: NaN, rmsePx: 1 }).reasons).toContain("invalid-thresholds");
        const small = record();
        small.editor!.applied.scale = 50;
        expect(outputPixelToLayerUV(await snapshot(small), { x: 0, y: 0 })).toMatchObject({ status: "not-measurable", reason: "outside-layer" });
        const invalid = record();
        invalid.editor!.applied.rotation = NaN;
        expect(layerUVToOutputPixel(await snapshot(invalid), { x: 0.5, y: 0.5 })).toMatchObject({ status: "not-measurable", reason: "invalid-or-degenerate-transform" });
    });
});
