import { bindCompositionRaster } from "./marketing-layout-binding";
import { prepareEditableComposition, applyLayoutPreset, saveLayoutPreset } from "./marketing-layout";
import { inspectCompositionLayout, rasterizeLayoutText, freezeCompositionTypography } from "./marketing-typography";
import { nanoid } from "nanoid";

import { overlayApplies } from "@/lib/commerce/generation-config";
import { isSquareImage, requiresSquareScene } from "@/lib/commerce/scene-framing";
import { imageToDataUrl, uploadImage, type UploadedImage } from "@/services/image-storage";
import type { AssetStage, BrandProfile, CategoryTemplate, CommerceGenerationConfig, CommerceLocale, CommerceRequirementPreset, CompositionLayer, GeneratedAsset, LayeredComposition, MarketingLayoutPreset, StoredImageRef } from "@/types/commerce";

type RenderLocale = CommerceLocale | "zh-CN";
type RenderRequirement = CommerceRequirementPreset | CategoryTemplate;

export async function renderMarketingAsset(input: { jobId: string; skuId: string; revision: number; locale: RenderLocale; requirement: RenderRequirement; copy: string; productImage: StoredImageRef | GeneratedAsset; sourceImages?: GeneratedAsset[]; brand: BrandProfile; generationConfig: CommerceGenerationConfig; siteLocale?: CommerceLocale; variantKey?: string; sequence?: number; visualPipelineVersion?: 2 | 3; stage?: "marketing" | "marketing-preview"; layoutSource?: LayeredComposition }) {
    const paired = input.visualPipelineVersion === 3 && "generationStrategy" in input.requirement && input.requirement.generationStrategy === "paired-before-after";
    const sources = input.sourceImages;
    if (paired && (!sources || sources.length !== 2 || sources[0].comparisonRole !== "before" || sources[1].comparisonRole !== "after" ||
        sources.some((source) => source.stage !== "comparison-source" || source.revision !== input.revision) ||
        !sources[0].comparisonGroupKey || sources[0].comparisonGroupKey !== sources[1].comparisonGroupKey ||
        sources[0].id !== input.productImage.id || sources[0].id === sources[1].id ||
        (sources[0].storageKey || sources[0].url) === (sources[1].storageKey || sources[1].url))) throw new Error("前后对比需要精确匹配的 BEFORE 和 AFTER 独立素材");
    const isBase = "stage" in input.productImage && input.productImage.stage === "marketing-base";
    if ((input.visualPipelineVersion === 2 || input.visualPipelineVersion === 3) && !paired && !isBase && !("stage" in input.productImage && input.productImage.stage === "main-white")) throw new Error("营销渲染需要精确匹配的营销底图或显式白底排版");
    await ensureBrandFont(input.brand, input.locale).catch(() => undefined);
    const size = input.generationConfig.outputSpec.size;
    const requirementId = input.requirement.id;
    const layout = "layout" in input.requirement ? input.requirement.layout : inferLegacyLayout(input.requirement.title);
    const productData = await imageToDataUrl({ url: input.productImage.url, storageKey: input.productImage.storageKey });
    const logoData = input.brand.logo ? await imageToDataUrl({ url: input.brand.logo.url, storageKey: input.brand.logo.storageKey }) : "";
    const stage = input.stage || "marketing";
    const sourceData = paired ? await Promise.all(sources!.map((source) => imageToDataUrl({ url: source.url, storageKey: source.storageKey }))) : undefined;
    let composition = prepareEditableComposition(createComposition({ ...input, requirementId, layout, productData, logoData, size, stage, sourceData, sourceAssetIds: paired ? sources!.map((source) => source.id) : undefined, singleVisual: isBase || input.visualPipelineVersion === 2 || input.visualPipelineVersion === 3 }));
    if (input.layoutSource?.layoutVersion === 2) composition = applyLayoutPreset(composition, saveLayoutPreset(input.layoutSource, "已保存布局"));
    await freezeCompositionTypography(composition);
    const blob = await renderLayeredComposition(composition, input.generationConfig);
    const stored = await uploadImage(blob);
    return { stored: { url: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType, ...await bindCompositionRaster(composition, blob) }, composition };
}

export async function renderLayeredComposition(composition: LayeredComposition, config: CommerceGenerationConfig, options?: { allowUnsafe?: boolean }) {
    if (composition.layoutVersion === 2 && (![composition.width, composition.height].every(n => Number.isFinite(n) && n >= 64 && n <= 4096) || composition.layers.length > 128)) throw new Error("画幅或图层数量超过安全渲染范围");
    if (!options?.allowUnsafe) { const report = await inspectCompositionLayout(composition); if (report.errors.length) throw new Error(report.errors.join("；")); }
    const svg = await compositionSvg(composition);
    const svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);
    try {
        const image = await loadImage(url);
        const canvas = document.createElement("canvas"); canvas.width = composition.width; canvas.height = composition.height;
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("浏览器无法创建图片画布");
        context.fillStyle = composition.backgroundColor || "#ffffff"; context.fillRect(0, 0, composition.width, composition.height); context.drawImage(image, 0, 0, composition.width, composition.height);
        const mime = config.outputSpec.format === "png" ? "image/png" : "image/jpeg";
        if (mime === "image/png") {
            const blob = await canvasToBlob(canvas, mime);
            if (blob.size > config.outputSpec.maxBytes) throw new Error("PNG 图片超过体积上限，请改用 JPG 或减少复杂素材");
            return withDpiMetadata(blob, config.outputSpec.dpi);
        }
        for (let quality = 0.94; quality >= 0.46; quality -= 0.06) {
            const blob = await canvasToBlob(canvas, mime, quality);
            if (blob.size <= config.outputSpec.maxBytes) return withDpiMetadata(blob, config.outputSpec.dpi);
        }
        throw new Error("图片压缩后仍超过 " + Math.round(config.outputSpec.maxBytes / 1024 / 1024) + "MB");
    } finally { URL.revokeObjectURL(url); }
}

export async function normalizeOutputImage(image: UploadedImage, config: CommerceGenerationConfig, brand?: BrandProfile, stage: AssetStage = "main-white", preserveOriginal = false) {
    const dataUrl = await imageToDataUrl({ url: image.url, storageKey: image.storageKey });
    const source = await loadImage(dataUrl);
    if (!preserveOriginal && requiresSquareScene(stage) && !isSquareImage(source.naturalWidth, source.naturalHeight)) throw new Error("场景图不是1:1方图，请先补全背景或重新生成；系统不会再自动填充白边。");
    const canvas = document.createElement("canvas"); canvas.width = config.outputSpec.size; canvas.height = config.outputSpec.size;
    const context = canvas.getContext("2d", { alpha: config.outputSpec.format === "png" }); if (!context) throw new Error("浏览器无法创建输出画布");
    if (config.outputSpec.format === "jpeg" || stage === "main-white" || stage === "detail-white") { context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height); }
    const scale = Math.min(canvas.width / source.naturalWidth, canvas.height / source.naturalHeight);
    const width = source.naturalWidth * scale; const height = source.naturalHeight * scale;
    context.drawImage(source, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
    if (brand?.logo && stage !== "marketing-base" && stage !== "comparison-source") {
        const logo = await loadImage(await imageToDataUrl({ url: brand.logo.url, storageKey: brand.logo.storageKey }));
        const logoConfig = config.overlay.logo;
        if (logoConfig.placement !== "off" && overlayApplies(logoConfig.applyTo, logoConfig.customStages, stage)) drawLogo(context, logo, logoConfig.placement, canvas.width, 0.95);
        const watermark = config.overlay.watermark;
        if (watermark.mode !== "off" && overlayApplies(watermark.applyTo, watermark.customStages, stage)) drawWatermark(context, logo, watermark, canvas.width);
    }
    const mime = config.outputSpec.format === "png" ? "image/png" : "image/jpeg";
    let blob: Blob | undefined;
    if (mime === "image/png") blob = await canvasToBlob(canvas, mime);
    else for (let quality = 0.94; quality >= 0.46; quality -= 0.06) { const candidate = await canvasToBlob(canvas, mime, quality); if (candidate.size <= config.outputSpec.maxBytes) { blob = candidate; break; } }
    if (!blob || blob.size > config.outputSpec.maxBytes) throw new Error("图片无法压缩到输出体积限制内");
    return uploadImage(await withDpiMetadata(blob, config.outputSpec.dpi));
}

export async function renderCompositionLayerPng(composition: LayeredComposition, layer: CompositionLayer) {
    const isolated = { ...composition, backgroundColor: "transparent", layers: [{ ...layer, x: layer.x, y: layer.y }] };
    const svg = await compositionSvg(isolated, true);
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
    try {
        const image = await loadImage(url);
        const canvas = document.createElement("canvas"); canvas.width = composition.width; canvas.height = composition.height;
        const context = canvas.getContext("2d"); if (!context) throw new Error("浏览器无法创建图层画布");
        context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0);
        return canvasToBlob(canvas, "image/png");
    } finally { URL.revokeObjectURL(url); }
}

export function createComposition(input: { jobId: string; skuId: string; revision: number; locale: RenderLocale; requirementId: string; copy: string; productData: string; sourceData?: string[]; sourceAssetIds?: string[]; logoData: string; brand: BrandProfile; generationConfig: CommerceGenerationConfig; siteLocale?: CommerceLocale; variantKey?: string; sequence?: number; singleVisual?: boolean; layout: MarketingLayoutPreset; size: number; stage: "marketing" | "marketing-preview" }): LayeredComposition {
    const now = new Date().toISOString();
    const scale = input.size / 1024;
    const layer = (value: Omit<CompositionLayer, "id">): CompositionLayer => ({ ...value, id: nanoid() });
    const layers: CompositionLayer[] = [layer({ type: "shape", name: "画布背景", x: 0, y: 0, width: input.size, height: input.size, zIndex: 0, opacity: 1, rotation: 0, visible: true, locked: false, fill: input.brand.secondaryColor })];
    if (input.sourceData && (input.sourceData.length !== 2 || !input.sourceData[0] || !input.sourceData[1] || input.sourceData[0] === input.sourceData[1])) throw new Error("前后对比需要两张不同素材");
    const rects = input.sourceData ? [{ x: 0, y: 96 * scale, width: input.size / 2, height: input.size / 2 }, { x: input.size / 2, y: 96 * scale, width: input.size / 2, height: input.size / 2 }] : input.singleVisual ? [{ x: 0, y: 0, width: input.size, height: input.size }] : layoutRects(input.layout, input.size);
    rects.forEach((rect, index) => layers.push(layer({ type: input.sourceData || input.singleVisual ? "background" : "product", name: input.sourceData ? (index === 0 ? "BEFORE 场景" : "AFTER 场景") : input.singleVisual ? "需求场景底图（含商品）" : "商品图 " + (index + 1), ...rect, zIndex: 10 + index, opacity: 1, rotation: 0, visible: true, locked: false, content: input.sourceData?.[index] ?? input.productData, mimeType: "image/png", ...(input.sourceData ? { sourceAssetId: input.sourceAssetIds?.[index], comparisonRole: index === 0 ? "before" as const : "after" as const } : {}) })));
    const textBox = layoutTextBox(input.layout, input.size);
    const fontFamily = input.locale === "th-TH" && input.brand.thaiFont ? input.brand.thaiFont.family : input.brand.fontFamily || "Arial";
    if (input.sourceData) {
        const labels: Record<RenderLocale, [string, string]> = { "zh-CN": ["使用前", "使用后"], "en-US": ["Before", "After"], "en-GB": ["Before", "After"], "th-TH": ["ก่อน", "หลัง"], "vi-VN": ["Trước", "Sau"], "ms-MY": ["Sebelum", "Selepas"], "fil-PH": ["Bago", "Pagkatapos"], "id-ID": ["Sebelum", "Sesudah"] };
        labels[input.locale].forEach((content, index) => layers.push(layer({ type: "text", name: index === 0 ? "comparison-label-before" : "comparison-label-after", x: index * input.size / 2, y: 24 * scale, width: input.size / 2, height: 64 * scale, zIndex: 30, opacity: 1, rotation: 0, visible: true, locked: false, content, fill: "#2b2622", fontFamily, fontSize: Math.round(32 * scale), fontWeight: 600, lineHeight: 1.25, textAlign: "center" })));
    }
    layers.push(layer({ type: "text", name: "营销文案", ...textBox, zIndex: 30, opacity: 1, rotation: 0, visible: true, locked: false, content: input.copy, fill: "#2b2622", fontFamily, fontSize: Math.round(42 * scale), fontWeight: 600, lineHeight: 1.25, textAlign: input.layout === "before-after" || input.layout === "competitor-comparison" ? "center" : "left" }));
    if (input.logoData && input.generationConfig.overlay.logo.placement !== "off" && overlayApplies(input.generationConfig.overlay.logo.applyTo, input.generationConfig.overlay.logo.customStages, input.stage)) {
        const pos = cornerPosition(input.generationConfig.overlay.logo.placement, input.size, 140 * scale, 76 * scale);
        layers.push(layer({ type: "logo", name: "品牌 Logo", ...pos, width: 140 * scale, height: 76 * scale, zIndex: 50, opacity: 0.95, rotation: 0, visible: true, locked: false, content: input.logoData, mimeType: "image/png" }));
    }
    const watermark = input.generationConfig.overlay.watermark;
    if (input.logoData && watermark.mode !== "off" && overlayApplies(watermark.applyTo, watermark.customStages, input.stage)) {
        const pos = watermarkPosition(watermark.position, input.size, 230 * scale, 120 * scale);
        layers.push(layer({ type: "watermark", name: watermark.mode === "tile" ? "平铺水印" : "单枚水印", ...pos, width: 230 * scale, height: 120 * scale, zIndex: 45, opacity: watermark.opacity, rotation: watermark.mode === "tile" ? -18 : 0, visible: true, locked: false, content: input.logoData, mimeType: "image/png" }));
    }
    return { id: nanoid(), jobId: input.jobId, skuId: input.skuId, requirementId: input.requirementId, locale: input.locale === "zh-CN" ? undefined : input.locale, siteLocale: input.siteLocale, variantKey: input.variantKey, revision: input.revision, width: input.size, height: input.size, backgroundColor: input.brand.secondaryColor, layout: input.layout, layers, createdAt: now, updatedAt: now };
}

async function compositionSvg(composition: LayeredComposition, transparent = false) {
    const layers = await Promise.all(composition.layers.filter((item) => item.visible).sort((a, b) => a.zIndex - b.zIndex).map(async (layer) => {
        const transform = layer.rotation ? ` transform="rotate(${layer.rotation} ${layer.x + layer.width / 2} ${layer.y + layer.height / 2})"` : "";
        if (layer.type === "shape") return `<rect x="${layer.x}" y="${layer.y}" width="${layer.width}" height="${layer.height}" fill="${escapeXml(layer.fill || "#fff")}" opacity="${layer.opacity}"${transform}/>`;
        if (layer.type === "text") return composition.layoutVersion === 2 ? `<image href="${await rasterizeLayoutText(layer)}" x="${layer.x}" y="${layer.y}" width="${layer.width}" height="${layer.height}" opacity="${layer.opacity}"${transform}/>` : textSvg(layer);
        if (!layer.content) return "";
        const data = layer.content.startsWith("data:") ? layer.content : await imageToDataUrl({ url: layer.content, storageKey: layer.storageKey });
        if (composition.layoutVersion !== 2 && layer.type === "watermark" && layer.name === "平铺水印") {
            const patternId = "wm-" + layer.id.replace(/[^a-zA-Z0-9]/g, "");
            return `<defs><pattern id="${patternId}" width="300" height="190" patternUnits="userSpaceOnUse" patternTransform="rotate(${layer.rotation || -18})"><image href="${escapeXml(data)}" x="55" y="55" width="190" height="80" preserveAspectRatio="xMidYMid meet" opacity="${layer.opacity}"/></pattern></defs><rect width="${composition.width}" height="${composition.height}" fill="url(#${patternId})"/>`;
        }
        return `<image href="${escapeXml(data)}" x="${layer.x}" y="${layer.y}" width="${layer.width}" height="${layer.height}" preserveAspectRatio="xMidYMid ${layer.type === "product" && composition.layoutVersion !== 2 ? "slice" : "meet"}" opacity="${layer.opacity}"${transform}/>`;
    }));
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${composition.width}" height="${composition.height}" viewBox="0 0 ${composition.width} ${composition.height}">${transparent ? "" : `<rect width="100%" height="100%" fill="${escapeXml(composition.backgroundColor)}"/>`}${layers.join("")}</svg>`;
}

function textSvg(layer: CompositionLayer) {
    const fontSize = layer.fontSize || 36; const lineHeight = fontSize * (layer.lineHeight || 1.25); const limit = Math.max(8, Math.floor(layer.width / Math.max(8, fontSize * 0.58)));
    const lines = wrapText(layer.content || "", limit).slice(0, Math.max(1, Math.floor(layer.height / lineHeight)));
    const anchor = layer.textAlign === "center" ? "middle" : layer.textAlign === "right" ? "end" : "start";
    const x = layer.textAlign === "center" ? layer.x + layer.width / 2 : layer.textAlign === "right" ? layer.x + layer.width : layer.x;
    return `<g opacity="${layer.opacity}"${layer.rotation ? ` transform="rotate(${layer.rotation} ${layer.x + layer.width / 2} ${layer.y + layer.height / 2})"` : ""}>${lines.map((line, index) => `<text x="${x}" y="${layer.y + fontSize + index * lineHeight}" text-anchor="${anchor}" fill="${escapeXml(layer.fill || "#222")}" font-family="${escapeXml(layer.fontFamily || "Arial")}" font-size="${fontSize}" font-weight="${layer.fontWeight || 400}">${escapeXml(line)}</text>`).join("")}</g>`;
}

function layoutRects(layout: MarketingLayoutPreset, size: number) {
    const s = size / 1024;
    if (["before-after", "competitor-comparison", "lighting-comparison"].includes(layout)) return [{ x: 0, y: 0, width: 512 * s, height: 650 * s }, { x: 512 * s, y: 0, width: 512 * s, height: 650 * s }];
    if (["size-comparison", "color-options", "multi-scene", "installation-methods", "layer-structure"].includes(layout)) return [{ x: 0, y: 0, width: 512 * s, height: 500 * s }, { x: 512 * s, y: 0, width: 512 * s, height: 500 * s }, { x: 256 * s, y: 500 * s, width: 512 * s, height: 250 * s }];
    if (["installation-steps", "faq"].includes(layout)) return [{ x: 0, y: 0, width: 420 * s, height: 1024 * s }];
    return [{ x: 0, y: 0, width: size, height: 660 * s }];
}

function layoutTextBox(layout: MarketingLayoutPreset, size: number) { const s = size / 1024; return ["installation-steps", "faq"].includes(layout) ? { x: 454 * s, y: 70 * s, width: 500 * s, height: 880 * s } : { x: 64 * s, y: 680 * s, width: 896 * s, height: 300 * s }; }
function cornerPosition(placement: Exclude<CommerceGenerationConfig["overlay"]["logo"]["placement"], "off">, size: number, width: number, height: number) { const gap = size * 0.05; return { x: placement.endsWith("right") ? size - width - gap : gap, y: placement.startsWith("bottom") ? size - height - gap : gap }; }
function watermarkPosition(position: CommerceGenerationConfig["overlay"]["watermark"]["position"], size: number, width: number, height: number) { const [vertical, horizontal] = position === "center" ? ["center", "center"] : position.split("-"); const x = horizontal === "right" ? size - width - size * 0.06 : horizontal === "center" ? (size - width) / 2 : size * 0.06; const y = vertical === "bottom" ? size - height - size * 0.06 : vertical === "center" ? (size - height) / 2 : size * 0.06; return { x, y }; }
function inferLegacyLayout(title: string): MarketingLayoutPreset { if (/前后/.test(title)) return "before-after"; if (/尺寸/.test(title)) return "size-comparison"; if (/安装/.test(title)) return "installation-methods"; if (/结构/.test(title)) return "layer-structure"; if (/场景/.test(title)) return "multi-scene"; return "feature-grid"; }

async function ensureBrandFont(brand: BrandProfile, locale: RenderLocale) { const font = locale === "th-TH" ? brand.thaiFont : undefined; if (!font || document.fonts.check(`16px "${font.family}"`)) return; const face = new FontFace(font.family, `url(${font.dataUrl})`); await face.load(); document.fonts.add(face); }
function wrapText(value: string, limit: number) { const result: string[] = []; for (const line of value.split(/\n+/).map((item) => item.trim()).filter(Boolean)) { let current = ""; for (const token of /\s/.test(line) ? line.split(/\s+/) : Array.from(line)) { const next = current ? current + (/\s/.test(line) ? " " : "") + token : token; if (next.length > limit && current) { result.push(current); current = token; } else current = next; } if (current) result.push(current); } return result; }
function escapeXml(value: string) { return String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[char]!)); }
function loadImage(url: string) { return new Promise<HTMLImageElement>((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error("模板素材读取失败")); image.src = url; }); }
function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number) { return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("模板图片导出失败")), type, quality)); }

async function withDpiMetadata(blob: Blob, dpi: number) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (blob.type === "image/jpeg" && bytes.length > 18 && bytes[2] === 0xff && bytes[3] === 0xe0 && String.fromCharCode(...bytes.slice(6, 11)) === "JFIF\0") {
        bytes[13] = 1; bytes[14] = (dpi >> 8) & 255; bytes[15] = dpi & 255; bytes[16] = (dpi >> 8) & 255; bytes[17] = dpi & 255;
        return new Blob([bytes], { type: blob.type });
    }
    if (blob.type === "image/png" && bytes.length > 33) {
        const ppm = Math.round(dpi / 0.0254); const data = new Uint8Array(9); const view = new DataView(data.buffer); view.setUint32(0, ppm); view.setUint32(4, ppm); data[8] = 1;
        const type = new TextEncoder().encode("pHYs"); const crcInput = new Uint8Array(13); crcInput.set(type); crcInput.set(data, 4);
        const chunk = new Uint8Array(21); new DataView(chunk.buffer).setUint32(0, 9); chunk.set(type, 4); chunk.set(data, 8); new DataView(chunk.buffer).setUint32(17, crc32(crcInput));
        const output = new Uint8Array(bytes.length + chunk.length); output.set(bytes.slice(0, 33)); output.set(chunk, 33); output.set(bytes.slice(33), 54);
        return new Blob([output], { type: blob.type });
    }
    return blob;
}
function crc32(bytes: Uint8Array) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function drawLogo(context: CanvasRenderingContext2D, image: HTMLImageElement, placement: Exclude<CommerceGenerationConfig["overlay"]["logo"]["placement"], "off">, size: number, opacity: number) { const width = size * 0.14; const height = width * image.naturalHeight / image.naturalWidth; const pos = cornerPosition(placement, size, width, height); context.save(); context.globalAlpha = opacity; context.drawImage(image, pos.x, pos.y, width, height); context.restore(); }
function drawWatermark(context: CanvasRenderingContext2D, image: HTMLImageElement, config: CommerceGenerationConfig["overlay"]["watermark"], size: number) { const width = size * 0.22; const height = width * image.naturalHeight / image.naturalWidth; context.save(); context.globalAlpha = config.opacity; if (config.mode === "tile") { for (let y = -height; y < size + height; y += height * 1.8) for (let x = -width; x < size + width; x += width * 1.5) { context.save(); context.translate(x + width / 2, y + height / 2); context.rotate(-18 * Math.PI / 180); context.drawImage(image, -width / 2, -height / 2, width, height); context.restore(); } } else { const pos = watermarkPosition(config.position, size, width, height); context.drawImage(image, pos.x, pos.y, width, height); } context.restore(); }
