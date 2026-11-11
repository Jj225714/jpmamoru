import type { ConsistencyConstraint, ConsistencyMetric, ConsistencyObservations, ConsistencyPoint, ConsistencyUnit } from "./consistency-types";
import { DEFAULT_WHITE_ADJUSTMENTS } from "./white-image-edit";
import { createWhiteGeometrySnapshot, evaluateWhiteGeometryAnchors, outputPixelToLayerUV, sourcePixelToLayerUV, type GeometryAnchor, type GeometryPixels, type SavedGeometryRecord } from "./white-geometry-snapshot";

const boundary = "仅检查人工确认平面和独立留出点的二维几何。图案文字、材质、隐藏结构和生成真实性仍须人工复核；合成单位不是实物毫米精度。";
const finite = (point: ConsistencyPoint) => point && Number.isFinite(point.x) && Number.isFinite(point.y);
const distance = (a: ConsistencyPoint, b: ConsistencyPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const mm: Record<ConsistencyUnit, number> = { mm: 1, cm: 10, in: 25.4 };
const positive = (v: number) => Number.isFinite(v) && v > 0;
// plane is the registration surface (possibly the full frame), not the subject bounds.
// Subject/pattern regions can exclude the independent ruler on that same surface.
const planeCorners = (c: ConsistencyConstraint) => { const p = c.plane; return [{ x: p.x, y: p.y }, { x: p.x + p.width, y: p.y }, { x: p.x + p.width, y: p.y + p.height }, { x: p.x, y: p.y + p.height }]; };
const inside = (p: ConsistencyPoint, x: number, y: number, w: number, h: number) => finite(p) && p.x >= x && p.y >= y && p.x <= x + w && p.y <= y + h;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const strings = (v: Record<string, unknown>, keys: string[]) => keys.every(key => typeof v[key] === "string");
const numbers = (v: Record<string, unknown>, keys: string[]) => keys.every(key => typeof v[key] === "number" && Number.isFinite(v[key]));
const pointShape = (v: unknown) => object(v) && numbers(v, ["x", "y"]);
const pairShape = (v: unknown) => Array.isArray(v) && v.length === 2 && v.every(id => typeof id === "string");
function constraintShapeErrors(c: unknown): string[] {
    if (!object(c)) return ["约束数据结构损坏：需要对象"];
    const errors: string[] = [];
    if (!strings(c, ["sourceImageId", "sourceContentHash", "scope", "provenance"]) || !numbers(c, ["version", "revision", "sourceWidth", "sourceHeight"]) || ["confirmedBy", "confirmedAt"].some(key => c[key] !== undefined && typeof c[key] !== "string")) errors.push("约束数据结构损坏：基本字段无效");
    if (!object(c.plane) || !strings(c.plane, ["id"]) || !numbers(c.plane, ["x", "y", "width", "height"]) || typeof c.plane.frontViewConfirmed !== "boolean") errors.push("约束数据结构损坏：缺少或无效的配准平面 plane");
    if (!object(c.thresholds) || !numbers(c.thresholds, ["maxPx", "rmsePx", "relative"])) errors.push("约束数据结构损坏：缺少或无效的阈值 thresholds");
    if (!Array.isArray(c.points) || c.points.some(p => !object(p) || !strings(p, ["id", "name", "role"]) || !pointShape(p.sourcePx))) errors.push("约束数据结构损坏：缺少或无效的锚点 points");
    if (!Array.isArray(c.dimensions) || c.dimensions.some(d => !object(d) || !strings(d, ["id", "label", "unit", "evidence"]) || !numbers(d, ["value"]) || !pairShape(d.endpoints))) errors.push("约束数据结构损坏：缺少或无效的尺寸 dimensions");
    if (!Array.isArray(c.regions) || c.regions.some(r => !object(r) || !strings(r, ["id", "name"]) || !numbers(r, ["x", "y", "width", "height"]) || !Array.isArray(r.anchorIds) || r.anchorIds.some(id => typeof id !== "string"))) errors.push("约束数据结构损坏：缺少或无效的图案区域 regions");
    if (c.ruler !== undefined && (!object(c.ruler) || !strings(c.ruler, ["unit", "evidence"]) || !numbers(c.ruler, ["value"]) || !pairShape(c.ruler.endpoints) || typeof c.ruler.independentConfirmed !== "boolean")) errors.push("约束数据结构损坏：独立标尺 ruler 无效");
    return errors;
}
function observationShapeValid(o: unknown): o is ConsistencyObservations {
    return object(o) && strings(o, ["id", "savedAt", "assetId", "resultContentHash", "observer"]) && numbers(o, ["width", "height"])
        && ["planeConfirmed", "independentConfirmed", "mirrored"].every(key => typeof o[key] === "boolean")
        && Array.isArray(o.corners) && o.corners.length === 4 && o.corners.every(pointShape)
        && Array.isArray(o.points) && o.points.every(p => object(p) && strings(p, ["id", "state"]) && ["visible", "missing", "occluded"].includes(p.state as string) && (p.outputPx === undefined || pointShape(p.outputPx)));
}

/** Structural validation is separate from confirmation, so a draft can be saved then confirmed. */
export function validateConsistencyConstraint(c: ConsistencyConstraint): string[] {
    const shapeErrors = constraintShapeErrors(c);
    if (shapeErrors.length) return shapeErrors;
    const errors: string[] = [];
    const add = (message: string) => errors.push(message);
    if (c.version !== 1 || !Number.isSafeInteger(c.revision) || c.revision < 1) add("约束版本无效");
    if (!c.sourceImageId?.trim() || !c.sourceContentHash?.trim()) add("缺少参考图内容身份");
    if (![c.sourceWidth, c.sourceHeight].every(n => Number.isSafeInteger(n) && n > 0 && n <= 8192)) add("参考图尺寸无效");
    const p = c.plane;
    if (!p?.id?.trim() || ![p.x, p.y, p.width, p.height].every(Number.isInteger) || p.width <= 0 || p.height <= 0 || !inside(p, 0, 0, c.sourceWidth, c.sourceHeight) || !inside({ x: p.x + p.width, y: p.y + p.height }, 0, 0, c.sourceWidth, c.sourceHeight)) add("参考平面必须是图内有效整数矩形");
    if (!["pattern", "dimension-pattern"].includes(c.scope) || !["manual", "synthetic"].includes(c.provenance)) add("检查范围或证据来源无效");
    const t = c.thresholds;
    if (!t || ![t.maxPx, t.rmsePx, t.relative].every(Number.isFinite) || t.maxPx < 0 || t.maxPx > 100 || t.rmsePx < 0 || t.rmsePx > t.maxPx || t.relative < 0 || t.relative > 1) add("误差阈值无效");
    if (c.points.length > 128 || c.regions.length > 32 || c.dimensions.length > 16) add("标注数量超出安全范围");
    const ids = new Set<string>();
    for (const point of c.points) {
        if (!point.id?.trim() || point.id.startsWith("__plane-") || ids.has(point.id)) add("锚点标识为空、保留或重复");
        ids.add(point.id);
        if (!["validation", "measurement"].includes(point.role) || !inside(point.sourcePx, p.x, p.y, p.width, p.height)) add(point.id + "：锚点不在参考平面内");
        if (planeCorners(c).some(corner => finite(point.sourcePx) && distance(corner, point.sourcePx) < 1e-6)) add(point.id + "：留出点/量测端点不能复用配准四角");
    }
    const validation = c.points.filter(point => point.role === "validation");
    if (validation.length < 3) add("至少需要三个不参与配准的独立验证点");
    if (validation.some((point, i) => validation.slice(0, i).some(other => finite(point.sourcePx) && finite(other.sourcePx) && distance(point.sourcePx, other.sourcePx) < 1e-6))) add("独立验证点坐标不能重复");
    const endpoints = (pair: [string, string], name: string) => {
        const points = pair.map(id => c.points.find(point => point.id === id));
        if (pair.length !== 2 || pair[0] === pair[1] || points.some(point => !point || point.role !== "measurement") || points.every(Boolean) && distance(points[0]!.sourcePx, points[1]!.sourcePx) < 1e-6) add(name + "：需要两个不同的量测端点");
        return points;
    };
    const dimIds = new Set<string>();
    for (const dim of c.dimensions) {
        if (!dim.id?.trim() || dimIds.has(dim.id)) add("尺寸标识为空或重复");
        dimIds.add(dim.id);
        if (!positive(dim.value) || !Object.hasOwn(mm, dim.unit) || !dim.evidence?.trim()) add(dim.id + "：尺寸数值、单位或端点证据不完整");
        endpoints(dim.endpoints, dim.id);
    }
    if (c.scope === "dimension-pattern" && (!c.dimensions.length || !c.ruler)) add("尺寸检查需要已知尺寸及独立同平面标尺，不能猜测数值");
    if (c.ruler) {
        if (!positive(c.ruler.value) || !Object.hasOwn(mm, c.ruler.unit) || !c.ruler.evidence?.trim() || !c.ruler.independentConfirmed) add("独立标尺数值、单位、证据或独立性未确认");
        const rulerPoints = endpoints(c.ruler.endpoints, "独立标尺");
        if (c.dimensions.some(dim => dim.endpoints.some(id => rulerPoints.some(point => point && (id === point.id || distance(c.points.find(p => p.id === id)?.sourcePx || { x: NaN, y: NaN }, point.sourcePx) < 1e-6))))) add("独立标尺端点不能与被测尺寸端点重用");
    }
    const regions = new Set<string>();
    for (const region of c.regions) {
        if (!region.id?.trim() || regions.has(region.id)) add("图案区域标识为空或重复");
        regions.add(region.id);
        if (![region.x, region.y, region.width, region.height].every(Number.isFinite) || region.width <= 0 || region.height <= 0 || !inside(region, p.x, p.y, p.width, p.height) || !inside({ x: region.x + region.width, y: region.y + region.height }, p.x, p.y, p.width, p.height)) add(region.id + "：图案区域不在参考平面内");
        if (!region.anchorIds.length || region.anchorIds.some(id => !validation.some(point => point.id === id))) add(region.id + "：区域需绑定独立验证点");
        if (region.anchorIds.some(id => { const point = validation.find(point => point.id === id); return point && !inside(point.sourcePx, region.x, region.y, region.width, region.height); })) add(region.id + "：绑定点不在该图案区域内");
    }
    return [...new Set(errors)];
}

/** The transform comes only from saved manual result-plane annotations, never from the generator. */
export async function evaluateConsistency(input: { constraints: ConsistencyConstraint; observations: ConsistencyObservations; sourcePixels: GeometryPixels; layerPixels: GeometryPixels }) {
    const metrics: ConsistencyMetric[] = [], reasons = validateConsistencyConstraint(input?.constraints);
    const done = (snapshotHash?: string) => ({ numericStatus: (reasons.length ? "not-measurable" : metrics.some(m => m.status === "deviation") ? "deviation" : metrics.some(m => m.status === "not-measurable") ? "not-measurable" : "pass") as "pass" | "deviation" | "not-measurable", metrics, reasons, snapshotHash, boundary });
    if (reasons.length) return done();
    if (!observationShapeValid(input.observations)) { reasons.push("结果观测数据结构损坏：配准四角或观测点字段缺失/无效"); return done(); }
    if (![input.sourcePixels, input.layerPixels].every(p => p && Number.isSafeInteger(p.width) && p.width > 0 && Number.isSafeInteger(p.height) && p.height > 0 && p.data instanceof Uint8ClampedArray)) { reasons.push("参考图或平面RGBA像素数据缺失/无效"); return done(); }
    const c = structuredClone(input.constraints), o = structuredClone(input.observations);
    if (!c.confirmedBy?.trim() || !c.confirmedAt || !c.plane.frontViewConfirmed) reasons.push("参考平面、尺寸/图案证据尚未人工确认");
    if (!o.id || !o.savedAt || !o.assetId || !o.resultContentHash || !o.observer?.trim() || !o.planeConfirmed || !o.independentConfirmed) reasons.push("结果配准或留出点的独立性尚未人工确认");
    if (o.width !== o.height || ![800, 1024, 1254, 1600].includes(o.width)) reasons.push("该结果画幅暂不可量测；首版支持800/1024/1254/1600方图");
    if (input.sourcePixels.width !== c.sourceWidth || input.sourcePixels.height !== c.sourceHeight) reasons.push("参考图像素尺寸已变化");
    if (o.corners.length !== 4 || o.corners.some(point => !inside(point, 0, 0, o.width, o.height))) reasons.push("结果平面四角无效或超出图像");
    if (new Set(o.points.map(point => point.id)).size !== o.points.length || o.points.some(point => !c.points.some(expected => expected.id === point.id))) reasons.push("结果点标识重复或不属于当前约束");
    const source = input.sourcePixels, layer = input.layerPixels, p = c.plane;
    if (layer.width !== p.width || layer.height !== p.height || source.data.length !== source.width * source.height * 4 || layer.data.length !== layer.width * layer.height * 4) reasons.push("平面像素与已确认裁剪范围不匹配");
    if (!reasons.length) outer: for (let y = 0; y < layer.height; y++) for (let x = 0; x < layer.width; x++) for (let channel = 0; channel < 4; channel++) {
        if (layer.data[(y * layer.width + x) * 4 + channel] !== source.data[((y + p.y) * source.width + x + p.x) * 4 + channel]) { reasons.push("平面像素不是参考图的已声明裁剪；不得继承未知裁剪或AI重画变换"); break outer; }
    }
    if (reasons.length) return done();
    const keys = ["topLeft", "topRight", "bottomRight", "bottomLeft"] as const;
    const record: SavedGeometryRecord = {
        id: "commerce-registration:" + o.id, createdAt: o.savedAt, source: { id: c.sourceImageId },
        editor: { version: 1, layer: { url: "", width: layer.width, height: layer.height, bytes: layer.data.length, mimeType: "image/png" }, base: { width: 1, height: 1, bounds: { x: 0, y: 0, width: 1, height: 1 } }, applied: { ...DEFAULT_WHITE_ADJUSTMENTS, perspectiveEnabled: true, perspectiveMode: "free", perspective: Object.fromEntries(keys.map((key, i) => [key, { x: o.corners[i].x / o.width, y: o.corners[i].y / o.height }])) as typeof DEFAULT_WHITE_ADJUSTMENTS.perspective } },
        output: { size: o.width as 800 | 1024 | 1254 | 1600, format: "png" },
    };
    const full = p.x === 0 && p.y === 0 && p.width === source.width && p.height === source.height;
    const made = await createWhiteGeometrySnapshot({ record, sourcePixels: source, layerPixels: layer, sourceToLayer: full ? { kind: "identity" } : { kind: "crop", cropPx: { x: p.x, y: p.y, width: p.width, height: p.height } } });
    if (made.status !== "ready") { reasons.push(made.reason); return done(); }
    const snapshot = made.snapshot;
    if (snapshot.sourceContentHash !== c.sourceContentHash) { reasons.push("参考图RGBA内容已变化，原确认和报告已过期"); return done(snapshot.snapshotHash); }
    if ("status" in snapshot.layerToOutput) { reasons.push("结果配准退化或不可逆：" + snapshot.layerToOutput.reason); return done(snapshot.snapshotHash); }
    const winding = o.corners.reduce((sum, point, i) => { const next = o.corners[(i + 1) % 4]; return sum + point.x * next.y - point.y * next.x; }, 0);
    if (o.mirrored || winding < 0) metrics.push({ id: "orientation", label: "图案/平面方向", status: "deviation", actual: -1, expected: 1, threshold: 0, unit: "orientation", reason: "检测到镜像声明或平面四角方向反转" });
    else metrics.push({ id: "orientation", label: "图案/平面方向", status: "pass", actual: 1, expected: 1, threshold: 0, unit: "orientation" });
    const anchors: GeometryAnchor[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }].map((uv, i) => ({ id: "__plane-" + i, role: "registration", uv }));
    const observed: Array<{ id: string; outputPx: ConsistencyPoint }> = [];
    for (const point of c.points) {
        const observation = o.points.find(item => item.id === point.id);
        if (observation?.state === "missing") { metrics.push({ id: "missing:" + point.id, label: point.name + "存在性", status: "deviation", actual: 0, expected: 1, threshold: 0, unit: "count", reason: "人工标记图案/端点缺失" }); continue; }
        if (!observation || observation.state !== "visible" || !observation.outputPx || !inside(observation.outputPx, 0, 0, o.width, o.height)) {
            metrics.push({ id: "unavailable:" + point.id, label: point.name, status: "not-measurable", actual: null, threshold: null, unit: "output-px", reason: observation?.state === "occluded" ? "图案/端点遮挡，不能推测其位置" : "缺少可靠的结果点位置" }); continue;
        }
        if (point.role === "validation") {
            const uv = sourcePixelToLayerUV(snapshot, point.sourcePx);
            if (uv.status !== "measurable") { reasons.push(point.id + ":" + uv.reason); continue; }
            anchors.push({ id: point.id, uv: uv.point, role: "validation" }); observed.push({ id: point.id, outputPx: observation.outputPx });
        }
    }
    // Missing/occluded points are already explicit metrics; never fit the visible holdouts.
    const totalValidation = c.points.filter(point => point.role === "validation").length;
    metrics.push({ id: "validation-coverage", label: "独立验证点覆盖数", status: observed.length === totalValidation ? "pass" : metrics.some(m => m.status === "not-measurable") ? "not-measurable" : "deviation", actual: observed.length, expected: totalValidation, threshold: 0, unit: "count", reason: observed.length < totalValidation ? "验证点缺失或遮挡，不能以剩余点替代全量验证" : undefined });
    if (observed.length) {
        const result = evaluateWhiteGeometryAnchors(snapshot, anchors, observed, c.thresholds);
        metrics.push({ id: "anchor-max", label: "独立验证点最大误差", status: result.reasons.length ? "not-measurable" : result.maxPx! <= c.thresholds.maxPx ? "pass" : "deviation", actual: result.maxPx, expected: 0, threshold: c.thresholds.maxPx, unit: "output-px", reason: result.reasons.join("；") || undefined });
        for (const error of result.errors) metrics.push({ id: "anchor:" + error.id, label: "验证点 " + error.id, status: error.errorPx <= c.thresholds.maxPx ? "pass" : "deviation", actual: error.errorPx, expected: 0, threshold: c.thresholds.maxPx, unit: "output-px" });
        metrics.push({ id: "anchor-rmse", label: "独立验证点RMSE", status: result.reasons.length ? "not-measurable" : result.rmsePx! <= c.thresholds.rmsePx ? "pass" : "deviation", actual: result.rmsePx, expected: 0, threshold: c.thresholds.rmsePx, unit: "output-px", reason: result.reasons.join("；") || undefined });
    } else if (!metrics.some(m => m.id.startsWith("missing:"))) reasons.push("没有可量测的独立留出点");
    const length = (pair: [string, string]) => {
        const points = pair.map(id => o.points.find(point => point.id === id));
        if (points.some(point => point?.state !== "visible" || !point.outputPx)) return null;
        const mapped = points.map(point => outputPixelToLayerUV(snapshot, point!.outputPx!));
        if (mapped.some(point => point.status !== "measurable")) return null;
        const [a, b] = mapped.map(point => point.status === "measurable" ? { x: point.point.x * p.width, y: point.point.y * p.height } : { x: NaN, y: NaN });
        const value = distance(a, b); return positive(value) ? value : null;
    };
    if (c.scope === "dimension-pattern" && c.ruler) {
        const rulerLength = length(c.ruler.endpoints);
        for (const dimension of c.dimensions) {
            const measured = length(dimension.endpoints);
            const actual = measured !== null && rulerLength !== null ? measured / rulerLength * c.ruler.value * mm[c.ruler.unit] / mm[dimension.unit] : null;
            const deviation = actual === null ? null : Math.abs(actual / dimension.value - 1);
            metrics.push({ id: "dimension:" + dimension.id, label: dimension.label, status: deviation === null ? "not-measurable" : deviation <= c.thresholds.relative + 1e-9 ? "pass" : "deviation", actual, expected: dimension.value, threshold: dimension.value * c.thresholds.relative, unit: dimension.unit, reason: actual === null ? "量测端点或独立标尺缺失、遮挡或退化" : "依赖人工确认的同平面独立标尺；不证明实物尺寸精度" });
        }
        if (c.dimensions.length >= 2) {
            const [a, b] = c.dimensions, la = length(a.endpoints), lb = length(b.endpoints);
            const actual = la !== null && lb !== null ? la / lb : null, expected = a.value * mm[a.unit] / (b.value * mm[b.unit]);
            metrics.push({ id: "dimension-ratio", label: a.label + "/" + b.label + "比例", status: actual === null ? "not-measurable" : Math.abs(actual / expected - 1) <= c.thresholds.relative + 1e-9 ? "pass" : "deviation", actual, expected, threshold: expected * c.thresholds.relative, unit: "ratio", reason: actual === null ? "尺寸端点不足或不可量测" : undefined });
        }
    }
    return done(snapshot.snapshotHash);
}
