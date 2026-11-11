import { describe, expect, it } from "vitest";
import { evaluateConsistency, validateConsistencyConstraint } from "./consistency-check";
import type { ConsistencyConstraint, ConsistencyObservations, ConsistencyPoint } from "./consistency-types";
import { createWhiteGeometrySnapshot, type GeometryPixels, type SavedGeometryRecord } from "./white-geometry-snapshot";
import { DEFAULT_WHITE_ADJUSTMENTS } from "./white-image-edit";

const when = "2026-10-26T00:00:00.000Z";
function rgba(externalRuler = false): GeometryPixels {
    const data = new Uint8ClampedArray(512 * 512 * 4);
    for (let y = 128; y < 384; y++) for (let x = 96; x < 416; x++) data.set([180, 150, 100, x === 96 || x === 415 || y === 128 || y === 383 ? 128 : 255], (y * 512 + x) * 4);
    // Independent internal pattern IDs and a source ruler, never model-generated truth.
    for (const y of [200, 256, 312]) for (const x of [200, 256, 312]) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) data.set([0, 255, (x + y) % 256, 255], ((y + dy) * 512 + x + dx) * 4);
    for (let x = 144; x <= 224; x++) data.set([0, 0, 0, 255], ((externalRuler ? 440 : 350) * 512 + x) * 4);
    return { width: 512, height: 512, data };
}
function crop(source: GeometryPixels, p: ConsistencyConstraint["plane"]): GeometryPixels {
    const data = new Uint8ClampedArray(p.width * p.height * 4);
    for (let y = 0; y < p.height; y++) data.set(source.data.subarray(((y + p.y) * source.width + p.x) * 4, ((y + p.y) * source.width + p.x + p.width) * 4), y * p.width * 4);
    return { width: p.width, height: p.height, data };
}
async function fixture(cropped = false, projective = false, externalRuler = false) {
    const sourcePixels = rgba(externalRuler);
    const plane = { id: "front", x: cropped ? 64 : 0, y: cropped ? 64 : 0, width: cropped ? 384 : 512, height: cropped ? 384 : 512, frontViewConfirmed: true };
    const layerPixels = crop(sourcePixels, plane);
    const constraints: ConsistencyConstraint = {
        version: 1, revision: 1, sourceImageId: "source", sourceContentHash: "pending", sourceWidth: 512, sourceHeight: 512, scope: "dimension-pattern", provenance: "synthetic", plane,
        points: [200, 256, 312].flatMap(y => [200, 256, 312].map(x => ({ id: `pattern-${x}-${y}`, name: `Pattern ${x}/${y}`, sourcePx: { x, y }, role: "validation" as const }))),
        dimensions: [{ id: "width", label: "宽度", endpoints: ["width-a", "width-b"], value: 200, unit: "mm", evidence: "Synthetic 320px = 200 test mm" }, { id: "height", label: "高度", endpoints: ["height-a", "height-b"], value: 160, unit: "mm", evidence: "Synthetic 256px = 160 test mm" }],
        ruler: { endpoints: ["ruler-a", "ruler-b"], value: 50, unit: "mm", evidence: "Independent synthetic 80px ruler", independentConfirmed: true },
        regions: [{ id: "central-pattern", name: "内部图案", x: 190, y: 190, width: 140, height: 140, anchorIds: ["pattern-200-200", "pattern-256-256", "pattern-312-312"] }],
        thresholds: { maxPx: 2, rmsePx: 1, relative: 0.01 }, confirmedBy: "fixture reviewer", confirmedAt: when,
    };
    for (const [id, x, y] of [["width-a", 96, 128], ["width-b", 416, 128], ["height-a", 96, 128], ["height-b", 96, 384], ["ruler-a", 144, externalRuler ? 440 : 350], ["ruler-b", 224, externalRuler ? 440 : 350]] as const) constraints.points.push({ id, name: id, sourcePx: { x, y }, role: "measurement" });
    const record: SavedGeometryRecord = { id: "hash-only", createdAt: when, source: { id: "source" }, output: { size: 1024, format: "png" }, editor: { version: 1, layer: { url: "", width: layerPixels.width, height: layerPixels.height, bytes: layerPixels.data.length, mimeType: "image/png" }, base: { width: 1, height: 1, bounds: { x: 0, y: 0, width: 1, height: 1 } }, applied: { ...DEFAULT_WHITE_ADJUSTMENTS } } };
    const result = await createWhiteGeometrySnapshot({ record, sourcePixels, layerPixels, sourceToLayer: cropped ? { kind: "crop", cropPx: { x: plane.x, y: plane.y, width: plane.width, height: plane.height } } : { kind: "identity" } });
    if (result.status !== "ready") throw Error(result.reason);
    constraints.sourceContentHash = result.snapshot.sourceContentHash;
    // Independent closed-form truth; never calls the implementation's mapping functions.
    const transform = (point: ConsistencyPoint) => {
        const u = (point.x - plane.x) / plane.width, v = (point.y - plane.y) / plane.height;
        return projective ? { x: 1024 * (0.6 * u - 0.125 * v + 0.2) / (1 - 0.25 * v), y: 1024 * (0.4 * v + 0.2) / (1 - 0.25 * v) } : { x: 1024 * u, y: 1024 * v };
    };
    const observations: ConsistencyObservations = { id: "result-registration", savedAt: when, assetId: "result", resultContentHash: "actual-result-hash-supplied-by-service", width: 1024, height: 1024, corners: [{ x: plane.x, y: plane.y }, { x: plane.x + plane.width, y: plane.y }, { x: plane.x + plane.width, y: plane.y + plane.height }, { x: plane.x, y: plane.y + plane.height }].map(transform) as ConsistencyObservations["corners"], points: constraints.points.map(point => ({ id: point.id, state: "visible", outputPx: transform(point.sourcePx) })), planeConfirmed: true, independentConfirmed: true, mirrored: false, observer: "manual fixture observer" };
    return { constraints, observations, sourcePixels, layerPixels };
}

describe("independent synthetic geometry evidence", () => {
    it("uses a same-plane ruler outside the subject region in a 512px reference", async () => {
        const input = await fixture(false, true, true);
        input.constraints.regions = [{ id: "subject", name: "主体", x: 96, y: 128, width: 320, height: 256, anchorIds: input.constraints.points.filter(p => p.role === "validation").map(p => p.id) }];
        expect(input.constraints.plane).toMatchObject({ x: 0, y: 0, width: 512, height: 512 });
        for (const id of input.constraints.ruler!.endpoints) {
            expect(input.constraints.points.find(p => p.id === id)!.sourcePx.y).toBeGreaterThan(384);
        }
        expect(validateConsistencyConstraint(input.constraints)).toEqual([]);
        const result = await evaluateConsistency(input);
        expect(result.numericStatus).toBe("pass");
        expect(result.metrics.find(m => m.id === "dimension:width")!.actual).toBeCloseTo(200, 8);
        expect(result.metrics.find(m => m.id === "dimension:height")!.actual).toBeCloseTo(160, 8);
    });
    it.each([[false, false], [false, true], [true, false], [true, true]])("measures actual crop=%s perspective=%s against independent expected points", async (cropped, projective) => {
        const input = await fixture(cropped, projective); expect(validateConsistencyConstraint(input.constraints)).toEqual([]);
        const result = await evaluateConsistency(input); expect(result.numericStatus).toBe("pass"); expect(result.snapshotHash).toMatch(/^sha256:/);
        expect(result.metrics.find(m => m.id === "anchor-max")!.actual).toBeLessThan(1e-9);
        expect(result.metrics.find(m => m.id === "dimension:width")!.actual).toBeCloseTo(200, 8);
        expect(result.metrics.find(m => m.id === "dimension:height")!.actual).toBeCloseTo(160, 8);
        expect(result.metrics.find(m => m.id === "dimension-ratio")!.actual).toBeCloseTo(1.25, 8);
        expect(result.boundary).toContain("不是实物毫米精度");
    });
    it("detects an 8px holdout shift without allowing it into registration", async () => {
        const input = await fixture(); input.observations.points[0].outputPx!.x += 8;
        const result = await evaluateConsistency(input); expect(result.numericStatus).toBe("deviation");
        expect(result.metrics.find(m => m.id === "anchor-max")).toMatchObject({ actual: 8, threshold: 2, status: "deviation", unit: "output-px" });
        expect(result.metrics.find(m => m.id === "anchor-rmse")!.actual).toBeCloseTo(8 / 3, 8);
    });
    it("detects 10% width shrink while independent ruler and registration stay fixed", async () => {
        const input = await fixture(); input.observations.points.find(p => p.id === "width-b")!.outputPx!.x = (96 + 320 * 0.9) * 2;
        const result = await evaluateConsistency(input); expect(result.numericStatus).toBe("deviation");
        expect(result.metrics.find(m => m.id === "dimension:width")).toMatchObject({ actual: 180, expected: 200, threshold: 2, status: "deviation" });
        expect(result.metrics.find(m => m.id === "dimension-ratio")!.actual).toBeCloseTo(1.125);
    });
    it("keeps explicit missing pattern as deviation and reports coverage", async () => {
        const input = await fixture(); input.observations.points[0] = { id: input.observations.points[0].id, state: "missing" };
        const result = await evaluateConsistency(input); expect(result.numericStatus).toBe("deviation");
        expect(result.metrics.find(m => m.id === "validation-coverage")).toMatchObject({ actual: 8, expected: 9, status: "deviation" });
    });
    it.each(["width-a", "ruler-a"])("keeps explicitly missing %s as deviation even when dimensions cannot be measured", async id => {
        const input = await fixture(); input.observations.points.find(p => p.id === id)!.state = "missing";
        const result = await evaluateConsistency(input); expect(result.numericStatus).toBe("deviation");
        expect(result.metrics.find(m => m.id === "missing:" + id)!.status).toBe("deviation");
        expect(result.metrics.find(m => m.id === "dimension:width")).toMatchObject({ actual: null, status: "not-measurable" });
    });
    it("does not guess an occluded validation point", async () => {
        const input = await fixture(); input.observations.points[0] = { id: input.observations.points[0].id, state: "occluded" };
        const result = await evaluateConsistency(input); expect(result.numericStatus).toBe("not-measurable"); expect(result.metrics.some(m => m.reason?.includes("遮挡"))).toBe(true);
    });
    it("does not derive dimensions when the independent ruler is occluded", async () => {
        const input = await fixture(); input.observations.points.find(p => p.id === "ruler-a")!.state = "occluded";
        const result = await evaluateConsistency(input); expect(result.numericStatus).toBe("not-measurable");
        expect(result.metrics.find(m => m.id === "dimension:width")).toMatchObject({ actual: null, status: "not-measurable" });
    });
    it.each(["flag", "winding"])("rejects mirrored orientation via %s", async (method) => {
        const input = await fixture();
        if (method === "flag") input.observations.mirrored = true;
        else { const [a,b,c,d] = input.observations.corners; input.observations.corners = [b,a,d,c]; }
        const result = await evaluateConsistency(input); expect(result.numericStatus).toBe("deviation"); expect(result.metrics.find(m => m.id === "orientation")!.status).toBe("deviation");
    });
    it("reports a degenerate plane rather than a perfect fit", async () => {
        const input = await fixture(); input.observations.corners[2] = input.observations.corners[1];
        const result = await evaluateConsistency(input); expect(result.numericStatus).toBe("not-measurable"); expect(result.reasons.join()).toContain("退化");
    });
    it("supports unit conversions without using output DPI", async () => {
        const input = await fixture(); input.constraints.dimensions[0].value = 20; input.constraints.dimensions[0].unit = "cm"; input.constraints.ruler!.value = 50 / 25.4; input.constraints.ruler!.unit = "in";
        const result = await evaluateConsistency(input); expect(result.numericStatus).toBe("pass"); expect(result.metrics.find(m => m.id === "dimension:width")!.actual).toBeCloseTo(20, 8);
    });
    it("does not invent measurements in explicitly pattern-only mode", async () => {
        const input = await fixture(); input.constraints.scope = "pattern"; input.constraints.dimensions = []; delete input.constraints.ruler;
        const result = await evaluateConsistency(input); expect(result.numericStatus).toBe("pass"); expect(result.metrics.some(m => m.unit === "mm")).toBe(false); expect(result.boundary).toContain("二维几何");
    });
});

describe("fail-closed provenance and evidence", () => {
    it.each(["plane", "points", "thresholds", "dimensions", "regions"])("returns a reason instead of throwing for missing persisted %s", async field => {
        const input = await fixture(); delete (input.constraints as unknown as Record<string, unknown>)[field];
        expect(validateConsistencyConstraint(input.constraints).join()).toContain(field);
        const result = await evaluateConsistency(input);
        expect(result.numericStatus).toBe("not-measurable"); expect(result.reasons.join()).toContain(field);
    });
    it.each([null, [], { plane: null }, "old version"])("rejects invalid persisted constraint structure %j", async value => {
        const input = await fixture(); input.constraints = value as unknown as ConsistencyConstraint;
        expect(validateConsistencyConstraint(input.constraints).length).toBeGreaterThan(0);
        expect((await evaluateConsistency(input)).numericStatus).toBe("not-measurable");
    });
    it.each(["point", "endpoints", "region", "ruler", "identity"])("rejects damaged nested %s without throwing", async field => {
        const input = await fixture();
        if (field === "point") input.constraints.points[0] = null as never;
        if (field === "endpoints") input.constraints.dimensions[0].endpoints = {} as never;
        if (field === "region") input.constraints.regions[0].anchorIds = null as never;
        if (field === "ruler") input.constraints.ruler = [] as never;
        if (field === "identity") input.constraints.sourceImageId = 17 as never;
        expect(validateConsistencyConstraint(input.constraints).join()).toContain("结构损坏");
        expect((await evaluateConsistency(input)).numericStatus).toBe("not-measurable");
    });
    it.each(["corners", "points", "observer"])("rejects damaged persisted observation %s", async field => {
        const input = await fixture(); (input.observations as unknown as Record<string, unknown>)[field] = null;
        const result = await evaluateConsistency(input);
        expect(result.numericStatus).toBe("not-measurable"); expect(result.reasons.join()).toContain("观测数据结构损坏");
    });
    it.each(["constraint", "plane", "independence", "result-plane"])("blocks unconfirmed %s", async which => {
        const input = await fixture(); if (which === "constraint") delete input.constraints.confirmedBy; if (which === "plane") input.constraints.plane.frontViewConfirmed = false; if (which === "independence") input.observations.independentConfirmed = false; if (which === "result-plane") input.observations.planeConfirmed = false;
        expect((await evaluateConsistency(input)).numericStatus).toBe("not-measurable");
    });
    it("invalidates changed decoded source pixels despite same dimensions", async () => {
        const input = await fixture(); input.sourcePixels.data[0] = input.layerPixels.data[0] = 37;
        const result = await evaluateConsistency(input); expect(result.numericStatus).toBe("not-measurable"); expect(result.reasons.join()).toContain("RGBA内容已变化");
    });
    it("rejects a redrawn layer or an undeclared crop", async () => {
        const input = await fixture(true); input.layerPixels.data[0] ^= 1;
        const result = await evaluateConsistency(input); expect(result.numericStatus).toBe("not-measurable"); expect(result.reasons.join()).toContain("AI重画");
    });
    it("rejects dimensions absent from a dimension-enabled constraint", async () => {
        const input = await fixture(); input.constraints.dimensions = [];
        expect(validateConsistencyConstraint(input.constraints).join()).toContain("不能猜测"); expect((await evaluateConsistency(input)).numericStatus).toBe("not-measurable");
    });
    it("rejects fitting corners reused as holdouts or dimension endpoints", async () => {
        const input = await fixture(); input.constraints.points[0].sourcePx = { x: 0, y: 0 };
        expect(validateConsistencyConstraint(input.constraints).join()).toContain("复用配准四角");
    });
    it("rejects circular dimension-to-ruler calibration even under aliased IDs", async () => {
        const input = await fixture(); input.constraints.points.find(p => p.id === "ruler-a")!.sourcePx = { ...input.constraints.points.find(p => p.id === "width-a")!.sourcePx };
        expect(validateConsistencyConstraint(input.constraints).join()).toContain("不能与被测尺寸端点重用");
    });
    it("rejects duplicate or unowned observations", async () => {
        const input = await fixture(); input.observations.points.push({ ...input.observations.points[0] });
        expect((await evaluateConsistency(input)).numericStatus).toBe("not-measurable");
    });
    it("rejects unsupported/non-square result size instead of scaling thresholds invisibly", async () => {
        const input = await fixture(); input.observations.width = 2048; input.observations.height = 1280;
        const result = await evaluateConsistency(input); expect(result.numericStatus).toBe("not-measurable"); expect(result.reasons.join()).toContain("画幅暂不可量测");
    });
    it("requires pattern regions to reference contained independent points", async () => {
        const input = await fixture(); input.constraints.regions[0].anchorIds = ["width-a"];
        expect(validateConsistencyConstraint(input.constraints).join()).toContain("区域需绑定独立验证点");
    });
});
