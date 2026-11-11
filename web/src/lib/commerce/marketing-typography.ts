import type { CompositionLayer, LayeredComposition } from "@/types/commerce";
import { layoutGeometryErrors, layoutText } from "./marketing-layout";

const quote = (name: string) => '"' + name.replace(/["\\]/g, "") + '"';
/** Resolve before measuring; rasterized text carries the resolved glyphs into SVG/export. */
export async function resolveLayoutFont(requested = "Arial") {
    const family = requested.split(",")[0].trim().replace(/^["']|["']$/g, "") || "Arial";
    const ctx = document.createElement("canvas").getContext("2d")!;
    let available = ["sans-serif", "serif", "monospace"].includes(family);
    try {
        await document.fonts.load(`16px ${quote(family)}`);
        const probe = "MWil@0123456789 Colour favourite 你好";
        available ||= ["monospace", "serif"].some((fallback) => {
            ctx.font = `32px ${fallback}`; const base = ctx.measureText(probe).width;
            ctx.font = `32px ${quote(family)}, ${fallback}`; return Math.abs(ctx.measureText(probe).width - base) > 0.01;
        });
    } catch { /* Failed font loads use the explicit fallback below. */ }
    return { family: available ? family : "Arial", warning: available ? undefined : `字体“${family}”不可用，已回退 Arial；预览和成图使用同一字形。` };
}
const textKey = (layer: CompositionLayer) => JSON.stringify([layer.content, layer.width, layer.height, layer.fontFamily, layer.fontSize, layer.fontWeight, layer.lineHeight, layer.letterSpacing, layer.textAlign, layer.autoFit, layer.minFontSize, layer.fill]);
export async function freezeCompositionTypography(composition: LayeredComposition) {
    for (const layer of composition.layers.filter(l => l.type === "text")) {
        if (layer.textRaster?.key === textKey(layer)) continue;
        delete layer.textRaster;
        const result = await measureLayoutLayer(layer);
        const dataUrl = await rasterizeLayoutText(layer);
        layer.textRaster = { key: textKey(layer), dataUrl, fontSize: result.fontSize, lineHeight: result.lineHeight, overflow: result.overflow, family: result.family, warning: result.warning };
    }
    return composition;
}
export async function measureLayoutLayer(layer: CompositionLayer) {
    if ((layer.content || "").length > 20000) throw new Error("文案超过 20000 字符，请精简后排版");
    if (layer.textRaster?.key === textKey(layer)) return { ...layer.textRaster, lines: [] as string[] };
    const font = await resolveLayoutFont(layer.fontFamily);
    const context = document.createElement("canvas").getContext("2d")!;
    const layout = layoutText(layer, (text, size) => { context.font = `${layer.fontWeight || 400} ${size}px ${quote(font.family)}`; const m = context.measureText(text); return Math.max(m.width, m.actualBoundingBoxRight || 0) + Math.max(0, m.actualBoundingBoxLeft || 0) + 2; });
    return { ...layout, ...font };
}
export async function inspectCompositionLayout(composition: LayeredComposition) {
    if (composition.layoutVersion !== 2) return { errors: [] as string[], warnings: [] as string[] };
    const errors = layoutGeometryErrors(composition), warnings: string[] = [];
    for (const layer of composition.layers.filter(l => l.type === "text" && l.visible)) {
        const result = await measureLayoutLayer(layer);
        if (result.warning) warnings.push(result.warning);
        if (result.overflow) errors.push(`${layer.name}：文案超出区域，自动缩小后仍放不下；请扩大文案区或精简文字。`);
        else if (result.fontSize < (layer.fontSize || 36)) warnings.push(`${layer.name}：已自动适配到 ${result.fontSize.toFixed(1)} px。`);
    }
    return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}
export async function rasterizeLayoutText(layer: CompositionLayer) {
    if (![layer.width, layer.height].every(n => Number.isFinite(n) && n > 0 && n <= 4096)) throw new Error("文案区域尺寸超过安全范围");
    if (layer.textRaster?.key === textKey(layer)) return layer.textRaster.dataUrl;
    const result = await measureLayoutLayer(layer);
    const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.ceil(layer.width)); canvas.height = Math.max(1, Math.ceil(layer.height));
    const context = canvas.getContext("2d")!;
    context.font = `${layer.fontWeight || 400} ${result.fontSize}px ${quote(result.family)}`;
    context.fillStyle = layer.fill || "#222"; context.textBaseline = "top";
    context.textAlign = "left";
    result.lines.forEach((line, index) => {
        context.letterSpacing = "0px";
        const metrics = context.measureText(line);
        const spacing = layer.letterSpacing || 0;
        const count = typeof Intl.Segmenter === "function" ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(line)].length : Array.from(line).length;
        const width = Math.max(metrics.width, metrics.actualBoundingBoxRight || 0) + Math.max(0, metrics.actualBoundingBoxLeft || 0) + 2 + Math.max(0, count - 1) * spacing;
        const left = layer.textAlign === "center" ? (layer.width - width) / 2 : layer.textAlign === "right" ? layer.width - width : 0;
        context.letterSpacing = `${spacing}px`;
        context.fillText(line, left + 1 + Math.max(0, metrics.actualBoundingBoxLeft || 0), index * result.lineHeight);
    });
    return canvas.toDataURL("image/png");
}
