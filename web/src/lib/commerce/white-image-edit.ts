import type { UploadedImage } from "@/services/image-storage";
import type { CommerceOutputSpec } from "@/types/commerce";
import { mapPoint, quadMatrix, QUAD_KEYS, type Matrix } from "./white-perspective";

export type WhiteOutput = Pick<CommerceOutputSpec, "size" | "format">;
export type WhiteAdjustments = {
    rotation: number;
    scale: number;
    x: number;
    y: number;
    temperature: number;
    tint: number;
    saturation: number;
    brightness: number;
    contrast: number;
    backgroundColor: string;
    backgroundOpacity: number;
    perspectiveEnabled: boolean;
    perspectiveInitialized?: boolean;
    perspectiveMode: "free" | "rectangle" | "parallelogram";
    perspective: { topLeft: { x: number; y: number }; topRight: { x: number; y: number }; bottomRight: { x: number; y: number }; bottomLeft: { x: number; y: number } };
};
export type WhiteBounds = { x: number; y: number; width: number; height: number };
export type WhiteEditorData = {
    version: 1;
    layer: UploadedImage;
    // Dimensions and visible bounds relative to the square output canvas.
    base: { width: number; height: number; bounds: WhiteBounds };
    applied: WhiteAdjustments;
};
export type WhiteDraft = { adjustments: WhiteAdjustments; output: WhiteOutput };

export const DEFAULT_WHITE_ADJUSTMENTS: WhiteAdjustments = {
    rotation: 0,
    scale: 100,
    x: 0.5,
    y: 0.5,
    temperature: 0,
    tint: 0,
    saturation: 0,
    brightness: 0,
    contrast: 0,
    backgroundColor: "#ffffff",
    backgroundOpacity: 100,
    perspectiveEnabled: false,
    perspectiveMode: "rectangle",
    perspective: { topLeft: { x: 0.25, y: 0.25 }, topRight: { x: 0.75, y: 0.25 }, bottomRight: { x: 0.75, y: 0.75 }, bottomLeft: { x: 0.25, y: 0.75 } },
};
export const WHITE_COLOR_KEYS = ["temperature", "tint", "saturation", "brightness", "contrast"] as const;
export type WhiteColorKey = (typeof WHITE_COLOR_KEYS)[number];

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
export function normalizeWhiteAdjustments(input: Partial<WhiteAdjustments>): WhiteAdjustments {
    const result = { ...DEFAULT_WHITE_ADJUSTMENTS };
    for (const key of ["rotation", "scale", "x", "y", "backgroundOpacity", ...WHITE_COLOR_KEYS] as const) {
        if (typeof input[key] === "number" && Number.isFinite(input[key])) result[key] = input[key]!;
    }
    if (typeof input.backgroundColor === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(input.backgroundColor)) {
        const hex = input.backgroundColor.slice(1).toLowerCase();
        result.backgroundColor = "#" + (hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex);
    }
    result.backgroundOpacity = clamp(result.backgroundOpacity, 0, 100);
    if (typeof input.perspectiveEnabled === "boolean") result.perspectiveEnabled = input.perspectiveEnabled;
    if (input.perspectiveInitialized !== undefined) result.perspectiveInitialized = input.perspectiveInitialized;
    if (input.perspectiveMode === "free" || input.perspectiveMode === "rectangle" || input.perspectiveMode === "parallelogram") result.perspectiveMode = input.perspectiveMode;
    result.perspective = structuredClone({ ...result.perspective, ...input.perspective });
    for (const key of QUAD_KEYS) for (const axis of ["x", "y"] as const) {
        const v = result.perspective[key]?.[axis];
        result.perspective[key][axis] = Number.isFinite(v) ? clamp(v, -16, 16) : DEFAULT_WHITE_ADJUSTMENTS.perspective[key][axis];
    }
    result.rotation = ((((Math.round(result.rotation) + 180) % 360) + 360) % 360) - 180;
    result.scale = clamp(result.scale, 10, 300);
    result.x = clamp(result.x, -3, 4);
    result.y = clamp(result.y, -3, 4);
    for (const key of WHITE_COLOR_KEYS) result[key] = clamp(result[key], -100, 100);
    return result;
}

export function whiteSamplePoint(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }, width: number, height: number) {
    if (rect.width <= 0 || rect.height <= 0 || width <= 0 || height <= 0) return undefined;
    return { x: clamp(Math.floor((clientX - rect.left) / rect.width * width), 0, width - 1), y: clamp(Math.floor((clientY - rect.top) / rect.height * height), 0, height - 1) };
}

// Perspective points are stored in output-canvas coordinates (also for legacy results).
// Apply the change in the subject transform to them, rather than applying scale twice.
export function updateWhiteAdjustments(base: WhiteEditorData["base"], previous: WhiteAdjustments, patch: Partial<WhiteAdjustments>): WhiteAdjustments {
    const next = normalizeWhiteAdjustments({ ...previous, ...patch });
    const initialized = previous.perspectiveInitialized || previous.perspectiveEnabled;
    if (!initialized && next.perspectiveEnabled) {
        const angle = next.rotation * Math.PI / 180;
        const point = (x: number, y: number) => {
            const dx = x * base.width * next.scale / 100, dy = y * base.height * next.scale / 100;
            return { x: next.x + dx * Math.cos(angle) - dy * Math.sin(angle), y: next.y + dx * Math.sin(angle) + dy * Math.cos(angle) };
        };
        next.perspective = { topLeft: point(-0.5, -0.5), topRight: point(0.5, -0.5), bottomRight: point(0.5, 0.5), bottomLeft: point(-0.5, 0.5) };
    } else if (initialized && !patch.perspective && (next.scale !== previous.scale || next.rotation !== previous.rotation || next.x !== previous.x || next.y !== previous.y)) {
        const angle = (next.rotation - previous.rotation) * Math.PI / 180;
        const ratio = next.scale / previous.scale;
        for (const key of Object.keys(next.perspective) as (keyof WhiteAdjustments["perspective"])[]) {
            const p = previous.perspective[key];
            const dx = (p.x - previous.x) * ratio, dy = (p.y - previous.y) * ratio;
            next.perspective[key] = { x: next.x + dx * Math.cos(angle) - dy * Math.sin(angle), y: next.y + dx * Math.sin(angle) + dy * Math.cos(angle) };
        }
    }
    if (initialized || next.perspectiveEnabled) next.perspectiveInitialized = true;
    return next;
}

export function whiteImageBounds(base: WhiteEditorData["base"], settings: WhiteAdjustments): WhiteBounds {
    let perspectiveMatrix: Matrix | undefined;
    try { if (settings.perspectiveEnabled) perspectiveMatrix = quadMatrix(settings.perspective); } catch { /* Invalid legacy data remains editable for correction. */ }
    const radians = (settings.rotation * Math.PI) / 180;
    const c = Math.cos(radians),
        s = Math.sin(radians),
        scale = settings.scale / 100;
    const b = base.bounds;
    const corners = [
        [b.x, b.y],
        [b.x + b.width, b.y],
        [b.x, b.y + b.height],
        [b.x + b.width, b.y + b.height],
    ].map(([x, y]) => {
        if (perspectiveMatrix) return mapPoint(perspectiveMatrix, x, y);
        const dx = (x - 0.5) * base.width * scale;
        const dy = (y - 0.5) * base.height * scale;
        return { x: settings.x + dx * c - dy * s, y: settings.y + dx * s + dy * c };
    });
    const x = Math.min(...corners.map((p) => p.x)),
        y = Math.min(...corners.map((p) => p.y));
    return { x, y, width: Math.max(...corners.map((p) => p.x)) - x, height: Math.max(...corners.map((p) => p.y)) - y };
}

export function isWhiteImageClipped(base: WhiteEditorData["base"], settings: WhiteAdjustments) {
    const b = whiteImageBounds(base, settings);
    return b.x < -0.00001 || b.y < -0.00001 || b.x + b.width > 1.00001 || b.y + b.height > 1.00001;
}

export function centerWhiteImage(base: WhiteEditorData["base"], settings: WhiteAdjustments): WhiteAdjustments {
    const b = whiteImageBounds(base, settings);
    return updateWhiteAdjustments(base, settings, { x: settings.x + 0.5 - b.x - b.width / 2, y: settings.y + 0.5 - b.y - b.height / 2 });
}

/** Remove the applied warp, returning to the original aspect ratio and current scale/position. */
export function correctWhitePerspective(base: WhiteEditorData["base"], settings: WhiteAdjustments) {
    return updateWhiteAdjustments(base, { ...settings, perspectiveEnabled: false, perspectiveInitialized: false }, { perspectiveEnabled: true, rotation: 0 });
}

export function fitWhiteImage(base: WhiteEditorData["base"], settings: WhiteAdjustments): WhiteAdjustments {
    const b = whiteImageBounds(base, updateWhiteAdjustments(base, settings, { scale: 100 }));
    return centerWhiteImage(base, updateWhiteAdjustments(base, settings, { scale: clamp(88 / Math.max(b.width, b.height), 10, 300) }));
}

// Operate on straight RGB; alpha and transparent pixels remain untouched.
// Neutral settings are an exact no-op, including partially transparent edges.
export function adjustWhitePixels(pixels: Uint8ClampedArray, settings: WhiteAdjustments) {
    if (WHITE_COLOR_KEYS.every((key) => settings[key] === 0)) return;
    const exposure = Math.pow(2, settings.brightness / 100);
    const contrast = Math.pow(2, settings.contrast / 100);
    const saturation = 1 + settings.saturation / 100;
    const red = Math.pow(2, (settings.temperature + settings.tint / 2) / 200);
    const green = Math.pow(2, -settings.tint / 200);
    const blue = Math.pow(2, (-settings.temperature + settings.tint / 2) / 200);
    for (let i = 0; i < pixels.length; i += 4) {
        if (!pixels[i + 3]) continue;
        let r = pixels[i] * red,
            g = pixels[i + 1] * green,
            b = pixels[i + 2] * blue;
        const gray = r * 0.2126 + g * 0.7152 + b * 0.0722;
        r = gray + (r - gray) * saturation;
        g = gray + (g - gray) * saturation;
        b = gray + (b - gray) * saturation;
        pixels[i] = (r * exposure - 127.5) * contrast + 127.5;
        pixels[i + 1] = (g * exposure - 127.5) * contrast + 127.5;
        pixels[i + 2] = (b * exposure - 127.5) * contrast + 127.5;
    }
}

export function whiteEditSignature(editor: WhiteEditorData | undefined, adjustments: WhiteAdjustments, output: WhiteOutput) {
    const normalized = normalizeWhiteAdjustments(adjustments);
    return JSON.stringify(["projective-v2", editor?.version, editor?.layer.storageKey || editor?.layer.url, editor?.base, ...Object.keys(DEFAULT_WHITE_ADJUSTMENTS).map((key) => normalized[key as keyof WhiteAdjustments]), output.size, output.format, ...(normalized.perspectiveInitialized ? [true] : [])]);
}

export function whiteOutputForImage(image: UploadedImage): WhiteOutput {
    return { size: ([800, 1024, 1254, 1600].includes(image.width) ? image.width : 1024) as WhiteOutput["size"], format: image.mimeType === "image/png" ? "png" : "jpeg" };
}
