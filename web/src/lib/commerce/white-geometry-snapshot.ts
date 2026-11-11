import { normalizeWhiteAdjustments, type WhiteEditorData, type WhiteOutput } from "./white-image-edit";
import { inverseMatrix, mapPoint, quadMatrix, type Matrix, type Point } from "./white-perspective";

export const WHITE_GEOMETRY_VERSION = "projective-v2" as const;
type Frozen<T> = T extends object ? { readonly [K in keyof T]: Frozen<T[K]> } : T;
export type GeometryPixels = { width: number; height: number; data: Uint8ClampedArray };
export type SourceToLayer = { kind: "identity" } | { kind: "crop"; cropPx: { x: number; y: number; width: number; height: number } } | { kind: "unknown"; reason: "missing-provenance" | "ai-redraw" | "other"; detail?: string };
export type GeometryUnavailable = { status: "not-measurable"; reason: string };
export type GeometryPointResult = { status: "measurable"; point: Point } | GeometryUnavailable;
export type SavedGeometryRecord = {
    id: string;
    rootId?: string;
    createdAt: string;
    source: { id: string };
    editor?: WhiteEditorData;
    output?: WhiteOutput;
    renderSignature?: string;
};
export type WhiteGeometrySnapshot = Frozen<{
    version: 1;
    transformVersion: typeof WHITE_GEOMETRY_VERSION;
    snapshotHash: string;
    recordId: string;
    rootId: string | null;
    savedAt: string;
    sourceId: string;
    sourceContentHash: string;
    layerContentHash: string;
    sourcePixels: { width: number; height: number };
    layerPixels: { width: number; height: number };
    sourceToLayer: SourceToLayer;
    coordinateSpace: "layer-uv";
    applied: WhiteEditorData["applied"];
    base: WhiteEditorData["base"];
    output: WhiteOutput;
    layerToOutput: { matrix3x3: Matrix; inverse3x3: Matrix } | GeometryUnavailable;
    renderSignature: string | null;
}>;

function freeze<T>(value: T): Frozen<T> {
    if (value && typeof value === "object") {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
    }
    return value as Frozen<T>;
}
const unavailable = (reason: string): GeometryUnavailable => ({ status: "not-measurable", reason });
const finite = (p: Point) => Number.isFinite(p.x) && Number.isFinite(p.y);
const inside = (p: Point, w = 1, h = 1) => finite(p) && p.x >= -1e-9 && p.y >= -1e-9 && p.x <= w + 1e-9 && p.y <= h + 1e-9;
function validPixels(p: GeometryPixels) {
    return Number.isSafeInteger(p.width) && Number.isSafeInteger(p.height) && p.width > 0 && p.height > 0 && p.data.length === p.width * p.height * 4;
}
async function digest(bytes: Uint8Array) {
    const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
    return "sha256:" + Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}
function pixelDigest(p: GeometryPixels) {
    const header = new TextEncoder().encode(`white-geometry:rgba8-decoded-v1:${p.width}:${p.height}:`);
    const bytes = new Uint8Array(header.length + p.data.length);
    bytes.set(header);
    bytes.set(p.data, header.length);
    return digest(bytes);
}

/**
 * Module03 adapter: decode the persisted source and editor.layer to RGBA8, then
 * call this with the saved record. Unsaved draft fields are deliberately ignored.
 * Pixels must correspond to those assets; this pure adapter does not fetch URLs.
 * Hashes identify decoded RGBA (including dimensions), not compressed file bytes.
 * All inputs are copied before the first await. No buffers/store references escape.
 * Provenance must come from the actual operation: equal dimensions never imply
 * identity. For AI redraw use unknown/ai-redraw, even when its size is unchanged.
 * `ready` means a snapshot was built, not that its geometry passed: inspect the
 * mapping/report status (a saved degenerate transform remains not-measurable).
 * No mask accuracy, physical units, DPI, or generated-product fidelity is inferred.
 */
export async function createWhiteGeometrySnapshot(input: {
    record: SavedGeometryRecord;
    sourcePixels: GeometryPixels;
    layerPixels: GeometryPixels;
    sourceToLayer?: SourceToLayer;
}): Promise<{ status: "ready"; snapshot: WhiteGeometrySnapshot } | GeometryUnavailable> {
    if (!validPixels(input.sourcePixels) || !validPixels(input.layerPixels)) return unavailable("invalid-rgba");
    const record = structuredClone(input.record);
    const source = { ...input.sourcePixels, data: input.sourcePixels.data.slice() };
    const layer = { ...input.layerPixels, data: input.layerPixels.data.slice() };
    const provenance = structuredClone(input.sourceToLayer ?? ({ kind: "unknown", reason: "missing-provenance" } as SourceToLayer));
    const editor = record.editor;
    const output = record.output;
    if (!editor || !output) return unavailable("missing-saved-editor-or-output");
    if (editor.version !== 1) return unavailable("unsupported-editor-version");
    if (![800, 1024, 1254, 1600].includes(output.size) || !["png", "jpeg"].includes(output.format)) return unavailable("invalid-output");
    if (editor.layer.width !== layer.width || editor.layer.height !== layer.height) return unavailable("layer-dimensions-mismatch");
    if (provenance.kind === "identity" && (source.width !== layer.width || source.height !== layer.height)) return unavailable("invalid-identity-provenance");
    if (provenance.kind === "crop") {
        const c = provenance.cropPx;
        if (![c.x, c.y, c.width, c.height].every(Number.isInteger) || c.width !== layer.width || c.height !== layer.height || !inside(c, source.width, source.height) || !inside({ x: c.x + c.width, y: c.y + c.height }, source.width, source.height))
            return unavailable("invalid-crop-provenance");
    }
    const applied = normalizeWhiteAdjustments(editor.applied);
    let transform: { matrix3x3: Matrix; inverse3x3: Matrix } | GeometryUnavailable;
    try {
        // Reject invalid numeric geometry before normalization can replace it.
        const a = editor.applied;
        if (![a.rotation, a.scale, a.x, a.y, editor.base.width, editor.base.height, ...Object.values(editor.base.bounds)].every(Number.isFinite) || editor.base.width <= 0 || editor.base.height <= 0 || a.scale <= 0) throw new Error();
        const b = editor.base.bounds;
        if (b.width <= 0 || b.height <= 0 || !inside(b) || !inside({ x: b.x + b.width, y: b.y + b.height })) throw new Error();
        let m: Matrix;
        if (applied.perspectiveEnabled) {
            if (!Object.values(a.perspective).every(finite)) throw new Error();
            // Quad is already absolute output-normalized: never apply scale twice.
            m = quadMatrix(applied.perspective);
        } else {
            const angle = (applied.rotation * Math.PI) / 180;
            const w = (editor.base.width * applied.scale) / 100,
                h = (editor.base.height * applied.scale) / 100;
            const c = Math.cos(angle),
                s = Math.sin(angle);
            m = [w * c, -h * s, applied.x - (w * c) / 2 + (h * s) / 2, w * s, h * c, applied.y - (w * s) / 2 - (h * c) / 2, 0, 0, 1];
        }
        const matrix3x3 = m.map((v, i) => (i < 6 ? v * output.size : v)) as Matrix;
        const inverse3x3 = inverseMatrix(matrix3x3);
        if (![...matrix3x3, ...inverse3x3].every(Number.isFinite)) throw new Error();
        transform = { matrix3x3, inverse3x3 };
    } catch {
        transform = unavailable("invalid-or-degenerate-transform");
    }
    const [sourceContentHash, layerContentHash] = await Promise.all([pixelDigest(source), pixelDigest(layer)]);
    const body = {
        version: 1 as const,
        transformVersion: WHITE_GEOMETRY_VERSION,
        recordId: record.id,
        rootId: record.rootId ?? null,
        savedAt: record.createdAt,
        sourceId: record.source.id,
        sourceContentHash,
        layerContentHash,
        sourcePixels: { width: source.width, height: source.height },
        layerPixels: { width: layer.width, height: layer.height },
        sourceToLayer: provenance,
        coordinateSpace: "layer-uv" as const,
        applied,
        base: editor.base,
        output,
        layerToOutput: transform,
        renderSignature: record.renderSignature ?? null,
    };
    const snapshotHash = await digest(new TextEncoder().encode(JSON.stringify(body)));
    return { status: "ready", snapshot: freeze({ ...body, snapshotHash }) };
}

/** Pixel edges range 0..W/0..H; pixel (i,j) has center (i+.5,j+.5). */
export function sourcePixelToLayerUV(snapshot: WhiteGeometrySnapshot, point: Point): GeometryPointResult {
    const p = snapshot.sourceToLayer;
    if (p.kind === "unknown") return unavailable(`source-provenance:${p.reason}`);
    if (!inside(point, snapshot.sourcePixels.width, snapshot.sourcePixels.height)) return unavailable("outside-source");
    const c = p.kind === "crop" ? p.cropPx : { x: 0, y: 0, ...snapshot.layerPixels };
    const uv = { x: (point.x - c.x) / c.width, y: (point.y - c.y) / c.height };
    return inside(uv) ? { status: "measurable", point: uv } : unavailable("outside-layer");
}
function transformPoint(snapshot: WhiteGeometrySnapshot, point: Point, inverse: boolean): GeometryPointResult {
    const t = snapshot.layerToOutput;
    if ("status" in t) return t;
    const n = snapshot.output.size;
    if (!inside(point, inverse ? n : 1, inverse ? n : 1)) return unavailable(inverse ? "outside-output" : "outside-layer");
    const m = (inverse ? t.inverse3x3 : t.matrix3x3) as Matrix;
    const denominator = m[6] * point.x + m[7] * point.y + m[8];
    if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-12) return unavailable("projective-pole");
    const mapped = mapPoint(m, point.x, point.y);
    if (!inside(mapped, inverse ? 1 : n, inverse ? 1 : n)) return unavailable(inverse ? "outside-layer" : "outside-output");
    return { status: "measurable", point: mapped };
}
export const layerUVToOutputPixel = (snapshot: WhiteGeometrySnapshot, uv: Point) => transformPoint(snapshot, uv, false);
export const outputPixelToLayerUV = (snapshot: WhiteGeometrySnapshot, pixel: Point) => transformPoint(snapshot, pixel, true);

/** Rebuild from current saved assets before reuse; comparing URL/signature alone is insufficient. */
export const isWhiteGeometrySnapshotCurrent = (previous: WhiteGeometrySnapshot, current: WhiteGeometrySnapshot) => previous.snapshotHash === current.snapshotHash;

export type GeometryAnchor = { id: string; uv: Point; role: "registration" | "validation" };
export type GeometryObservation = { id: string; outputPx: Point };
/**
 * Caller supplies independently obtained observations and declares every point
 * used for registration. This function never fits a transform to validation data.
 * Roles cannot prove independence of an external detector: caller owns that evidence.
 * Observations must be in this local editor's output plane. A newly AI-generated
 * composition needs independent registration; it cannot automatically inherit H.
 * Missing, clipped, duplicate or reused anchors cannot produce a passing report.
 * Thresholds are output pixels, explicitly chosen by caller; never millimetres.
 */
export function evaluateWhiteGeometryAnchors(snapshot: WhiteGeometrySnapshot, anchors: readonly GeometryAnchor[], observations: readonly GeometryObservation[], thresholds: { maxPx: number; rmsePx: number }) {
    const errors: { id: string; errorPx: number }[] = [];
    const reasons: string[] = [];
    const validation = anchors.filter((a) => a.role === "validation");
    if (!validation.length) reasons.push("no-independent-validation-anchors");
    if (![thresholds.maxPx, thresholds.rmsePx].every((v) => Number.isFinite(v) && v >= 0)) reasons.push("invalid-thresholds");
    if (new Set(anchors.map((a) => a.id)).size !== anchors.length || new Set(observations.map((a) => a.id)).size !== observations.length) reasons.push("duplicate-anchor-id");
    const registrations = anchors.filter((a) => a.role === "registration");
    for (const anchor of validation) {
        if (registrations.some((a) => Math.hypot(a.uv.x - anchor.uv.x, a.uv.y - anchor.uv.y) < 1e-9)) {
            reasons.push(`${anchor.id}:registration-point-reused`);
            continue;
        }
        const expected = layerUVToOutputPixel(snapshot, anchor.uv);
        const observed = observations.find((o) => o.id === anchor.id);
        if (expected.status !== "measurable") reasons.push(`${anchor.id}:${expected.reason}`);
        else if (!observed) reasons.push(`${anchor.id}:missing-observation`);
        else if (!inside(observed.outputPx, snapshot.output.size, snapshot.output.size)) reasons.push(`${anchor.id}:invalid-or-outside-observation`);
        else errors.push({ id: anchor.id, errorPx: Math.hypot(observed.outputPx.x - expected.point.x, observed.outputPx.y - expected.point.y) });
    }
    const maxPx = errors.length ? Math.max(...errors.map((e) => e.errorPx)) : null;
    const rmsePx = errors.length ? Math.sqrt(errors.reduce((sum, e) => sum + e.errorPx ** 2, 0) / errors.length) : null;
    const status = reasons.length ? "not-measurable" : maxPx! <= thresholds.maxPx && rmsePx! <= thresholds.rmsePx ? "pass" : "deviation";
    return freeze({ status, snapshotHash: snapshot.snapshotHash, unit: "output-px", thresholds: { ...thresholds }, total: validation.length, matched: errors.length, maxPx, rmsePx, errors, reasons });
}
