import { nanoid } from "nanoid";
import type { CompositionLayer, LayeredComposition, MarketingLayout } from "@/types/commerce";

const subjectTypes = new Set(["product", "background", "flattened", "decoration"]);
const isSubject = (layer: Pick<CompositionLayer, "type">) => subjectTypes.has(layer.type);
const label = (layer: CompositionLayer) => layer.name.startsWith("comparison-label-");
const finitePositive = (value: number) => Number.isFinite(value) && value > 0;
const validCanvas = (width: number, height: number) => [width, height].every((value) => Number.isInteger(value) && value >= 64 && value <= 4096) && width * height <= 16_000_000;
const clone = (value: LayeredComposition): LayeredComposition => ({ ...value, layers: value.layers.map((layer) => ({ ...layer })) });
const glyphs = (text: string) => typeof Intl.Segmenter === "function"
    ? Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (part) => part.segment)
    : Array.from(text);

/** measure must measure the requested font/weight, excluding letter spacing. Never drops text. */
export function layoutText(layer: CompositionLayer, measure: (text: string, fontSize: number) => number) {
    const requested = finitePositive(layer.fontSize || 0) ? Math.max(8, Math.min(300, layer.fontSize!)) : 36;
    const spacing = Number.isFinite(layer.letterSpacing) ? layer.letterSpacing! : 0;
    const multiplier = finitePositive(layer.lineHeight || 0) ? layer.lineHeight! : 1.25;
    const content = (layer.content || "").replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
    if (!content) return { lines: [], fontSize: requested, lineHeight: requested * multiplier, overflow: false };
    const minimum = Math.min(requested, finitePositive(layer.minFontSize || 0) ? layer.minFontSize! : Math.max(12, requested * 0.45));
    const atSize = (fontSize: number) => {
        const width = (text: string) => measure(text, fontSize) + Math.max(0, glyphs(text).length - 1) * spacing;
        const lines: string[] = [];
        for (const paragraph of content.split("\n")) {
            let line = "";
            // Keep explicit line breaks and every non-space character. Wrap at word boundaries first.
            for (const token of paragraph.match(/\S+| +/gu) || []) {
                if (/^ +$/.test(token)) { line += token; continue; }
                const candidate = line + token;
                if (width(candidate.trimEnd()) <= layer.width) { line = candidate; continue; }
                if (line.trim()) { lines.push(line.trimEnd()); line = ""; }
                if (width(token) <= layer.width) { line = token; continue; }
                for (const char of glyphs(token)) {
                    if (line && width(line + char) > layer.width) { lines.push(line); line = ""; }
                    line += char;
                }
            }
            lines.push(line.trimEnd());
        }
        const lineHeight = fontSize * multiplier;
        const overflow = !finitePositive(layer.width) || !finitePositive(layer.height)
            || lines.length * lineHeight > layer.height + 0.01
            || lines.some((line) => !Number.isFinite(width(line)) || width(line) > layer.width + 0.01);
        return { lines, fontSize, lineHeight, overflow };
    };
    const original = atSize(requested);
    if (!original.overflow || layer.autoFit === false || minimum === requested) return original;
    let best = atSize(minimum);
    if (best.overflow) return best;
    let low = minimum, high = requested;
    for (let step = 0; step < 14 && high - low > 0.05; step++) {
        const mid = (low + high) / 2, attempt = atSize(mid);
        if (attempt.overflow) high = mid;
        else { low = mid; best = attempt; }
    }
    return best;
}

/** Opening a legacy layout only returns a draft. Persisting it is an explicit new revision. */
export function prepareEditableComposition(composition: LayeredComposition): LayeredComposition {
    const next = clone(composition);
    if (next.layoutVersion === 2) return next;
    next.layoutVersion = 2;
    const { width: w, height: h } = next;
    const gap = Math.max(w, h) * 0.025;
    const side = ["faq", "installation-steps"].includes(next.layout);
    const subjects = next.layers.filter(isSubject);
    const labels = next.layers.filter((layer) => layer.type === "text" && label(layer));
    const copies = next.layers.filter((layer) => layer.type === "text" && !label(layer));
    const brandLayers = next.layers.filter((layer) => ["logo", "watermark"].includes(layer.type));
    const brandHeight = h * 0.08;
    const labelTop = brandLayers.length ? gap * 2 + brandHeight : gap;
    const imageTop = labels.length ? labelTop + h * 0.075 + gap : labelTop;
    brandLayers.forEach((layer, index) => {
        const cellWidth = Math.min(w * 0.22, (w - gap * 2) / brandLayers.length);
        Object.assign(layer, { x: gap + index * cellWidth, y: gap, width: cellWidth - gap / 2, height: brandHeight, rotation: 0 });
    });
    const region = side
        ? { x: gap, y: imageTop, width: w * 0.40 - gap, height: h - imageTop - gap }
        : { x: gap, y: imageTop, width: w - gap * 2, height: h * 0.62 - imageTop };
    // Preserve every source separately. A contain renderer keeps the complete original bitmap.
    const columns = Math.max(1, subjects.length);
    subjects.forEach((layer, index) => Object.assign(layer, {
        x: region.x + index * region.width / columns, y: region.y,
        width: region.width / columns - (columns > 1 ? gap / 2 : 0), height: region.height,
        rotation: 0,
    }));
    labels.forEach((layer, index) => Object.assign(layer, {
        x: gap + index * (w - 2 * gap) / labels.length, y: labelTop,
        width: (w - 2 * gap) / labels.length - gap / 2, height: h * 0.075,
        autoFit: true, rotation: 0,
    }));
    const textRegion = side
        ? { x: w * 0.44, y: imageTop, width: w * 0.56 - gap, height: h - imageTop - gap }
        : { x: gap, y: h * 0.66, width: w - 2 * gap, height: h * 0.34 - gap };
    copies.forEach((layer, index) => Object.assign(layer, {
        x: textRegion.x, y: textRegion.y + index * textRegion.height / Math.max(1, copies.length),
        width: textRegion.width, height: textRegion.height / Math.max(1, copies.length) - (copies.length > 1 ? gap / 2 : 0),
        autoFit: true, rotation: 0, letterSpacing: layer.letterSpacing || 0,
    }));
    return next;
}

export function resizeComposition(composition: LayeredComposition, width: number, height: number): LayeredComposition {
    if (!validCanvas(width, height) || ![composition.width, composition.height].every(finitePositive)) throw new Error("画板宽高须为 64–4096 整数像素，总像素不得超过 1600 万");
    const sx = width / composition.width, sy = height / composition.height, textScale = Math.min(sx, sy);
    const scaleFont = (value: number) => Math.max(8, Math.min(300, value * textScale));
    return { ...composition, width, height, layers: composition.layers.map((layer) => ({
        ...layer, x: layer.x * sx, y: layer.y * sy, width: layer.width * sx, height: layer.height * sy,
        ...(layer.fontSize === undefined ? {} : { fontSize: scaleFont(layer.fontSize) }),
        ...(layer.minFontSize === undefined ? {} : { minFontSize: Math.min(scaleFont(layer.fontSize || 36), scaleFont(layer.minFontSize)) }),
        ...(layer.letterSpacing === undefined ? {} : { letterSpacing: Math.max(0, Math.min(30, layer.letterSpacing * textScale)) }),
    })) };
}

const overlaps = (a: CompositionLayer, b: CompositionLayer) =>
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0.01
    && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0.01;

/** Geometry checks are independent of font availability and do not infer a subject from pixels. */
export function layoutGeometryErrors(composition: LayeredComposition): string[] {
    if (composition.layoutVersion !== 2) return [];
    const errors: string[] = [];
    const { width, height } = composition;
    if (!validCanvas(width, height)) return ["画板尺寸无效（宽高须为 64–4096 整数像素，总像素不得超过 1600 万）"];
    const ids = new Set<string>();
    for (const layer of composition.layers) {
        const name = layer.name || "未命名图层";
        if (ids.has(layer.id)) errors.push("图层标识重复");
        ids.add(layer.id);
        if (![layer.x, layer.y, layer.width, layer.height, layer.zIndex, layer.rotation, layer.opacity].every(Number.isFinite)
            || layer.width <= 0 || layer.height <= 0 || layer.opacity < 0 || layer.opacity > 1) errors.push(name + "：图层尺寸或样式无效");
        if (layer.x < -0.01 || layer.y < -0.01 || layer.x + layer.width > width + 0.01 || layer.y + layer.height > height + 0.01) errors.push(name + "：超出画板边界");
        if (layer.rotation !== 0) errors.push(name + "：安全排版不支持旋转，请设为 0°");
        if (layer.type === "text") {
            if (layer.fontSize !== undefined && (!finitePositive(layer.fontSize) || layer.fontSize < 8 || layer.fontSize > 300)
                || layer.lineHeight !== undefined && (!finitePositive(layer.lineHeight) || layer.lineHeight < 1 || layer.lineHeight > 3)
                || layer.letterSpacing !== undefined && (!Number.isFinite(layer.letterSpacing) || layer.letterSpacing < 0 || layer.letterSpacing > 30)
                || layer.minFontSize !== undefined && (!finitePositive(layer.minFontSize) || layer.minFontSize < 8 || layer.minFontSize > (layer.fontSize || 36))) errors.push(name + "：字号需为 8–300，行距需为 1–3，字距需为 0–30，最小字号需为 8–当前字号");
            if (layer.visible && (layer.x < width * 0.02 - 0.01 || layer.y < height * 0.02 - 0.01
                || layer.x + layer.width > width * 0.98 + 0.01 || layer.y + layer.height > height * 0.98 + 0.01)) errors.push(name + "：文案需保留 2% 边缘安全区");
        }
    }
    const subjects = composition.layers.filter((layer) => layer.visible && layer.opacity > 0 && isSubject(layer));
    const overlays = composition.layers.filter((layer) => layer.visible && layer.opacity > 0 && ["text", "logo", "watermark"].includes(layer.type));
    for (const overlay of overlays) if (subjects.some((subject) => overlaps(overlay, subject))) errors.push(overlay.name + "：覆盖商品/场景主体保护区，请移至留白区");
    return [...new Set(errors)];
}

export function moveLayoutLayer(composition: LayeredComposition, id: string, x: number, y: number): LayeredComposition {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("图层坐标无效");
    return { ...composition, layers: composition.layers.map((layer) => layer.id === id && !layer.locked ? {
        ...layer, x: Math.max(0, Math.min(composition.width - layer.width, x)), y: Math.max(0, Math.min(composition.height - layer.height, y)),
    } : { ...layer }) };
}

export function saveLayoutPreset(composition: LayeredComposition, name: string): MarketingLayout {
    if (!name.trim()) throw new Error("请输入自定义布局名称");
    const errors = layoutGeometryErrors(composition);
    if (errors.length) throw new Error(errors.join("；"));
    return { id: nanoid(), name: name.trim(), width: composition.width, height: composition.height, layers: composition.layers.map((layer) => ({
        type: layer.type, name: layer.name, x: layer.x, y: layer.y, width: layer.width, height: layer.height,
        fontSize: layer.fontSize, fontFamily: layer.fontFamily, lineHeight: layer.lineHeight, letterSpacing: layer.letterSpacing,
        textAlign: layer.textAlign, autoFit: layer.autoFit, minFontSize: layer.minFontSize, zIndex: layer.zIndex,
    })) };
}

export function applyLayoutPreset(composition: LayeredComposition, preset: MarketingLayout): LayeredComposition {
    if (!validCanvas(preset.width, preset.height)) throw new Error("自定义布局尺寸无效");
    const key = (layer: Pick<CompositionLayer, "type" | "name">) => JSON.stringify([layer.type, layer.name]);
    const signature = (layers: Array<Pick<CompositionLayer, "type" | "name">>) => layers.filter(isSubject).map(key).sort().join("|");
    if (signature(composition.layers) !== signature(preset.layers)) throw new Error("自定义布局的主体图层与当前素材不匹配，请选择相同结构的布局");
    const byKey = new Map(preset.layers.map((layer) => [key(layer), layer]));
    if (byKey.size !== preset.layers.length || new Set(composition.layers.map(key)).size !== composition.layers.length) throw new Error("图层名称重复，无法安全套用自定义布局");
    const scaled = resizeComposition(prepareEditableComposition(composition), preset.width, preset.height);
    const next = { ...scaled, layers: scaled.layers.map((layer) => {
        const saved = byKey.get(key(layer));
        if (!saved) return layer;
        // Explicit allow-list: external/old preset records can never replace source/content/identity.
        return { ...layer, x: saved.x, y: saved.y, width: saved.width, height: saved.height, fontSize: saved.fontSize,
            fontFamily: saved.fontFamily, lineHeight: saved.lineHeight, letterSpacing: saved.letterSpacing,
            textAlign: saved.textAlign, autoFit: saved.autoFit, minFontSize: saved.minFontSize, zIndex: saved.zIndex };
    }) };
    const errors = layoutGeometryErrors(next);
    if (errors.length) throw new Error(errors.join("；"));
    return next;
}
