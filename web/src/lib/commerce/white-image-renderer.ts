import { imageToDataUrl, uploadImage, type UploadedImage } from "@/services/image-storage";
import { cloneGenerationConfig, DEFAULT_COMMERCE_GENERATION_CONFIG } from "./generation-config";
import { normalizeOutputImage } from "./template-renderer";
import { adjustWhitePixels, normalizeWhiteAdjustments, DEFAULT_WHITE_ADJUSTMENTS, WHITE_COLOR_KEYS, type WhiteAdjustments, type WhiteEditorData, type WhiteOutput } from "./white-image-edit";

import { projectWhitePixels } from "./white-perspective";

function context2d(canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("浏览器无法创建图片画布");
    return context;
}

export function whiteCanvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("图片编码失败，请重试"))), "image/png"));
}

async function blobCanvas(blob: Blob) {
    const bitmap = await createImageBitmap(blob);
    try {
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        context2d(canvas).drawImage(bitmap, 0, 0);
        return canvas;
    } finally {
        bitmap.close();
    }
}

export async function inspectWhiteLayer(blob: Blob) {
    const canvas = await blobCanvas(blob);
    const pixels = context2d(canvas).getImageData(0, 0, canvas.width, canvas.height);
    let left = canvas.width,
        top = canvas.height,
        right = -1,
        bottom = -1,
        transparent = false;
    for (let y = 0; y < canvas.height; y++)
        for (let x = 0; x < canvas.width; x++) {
            const alpha = pixels.data[(y * canvas.width + x) * 4 + 3];
            if (alpha < 255) transparent = true;
            if (alpha > 0) {
                left = Math.min(left, x);
                top = Math.min(top, y);
                right = Math.max(right, x);
                bottom = Math.max(bottom, y);
            }
        }
    if (right < left) throw new Error("未识别到商品，请更换图片或重试抠图");
    return { canvas, transparent, bounds: { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } };
}

export async function createWhiteEditor(blob: Blob, preserveLayout = false): Promise<WhiteEditorData> {
    const inspected = await inspectWhiteLayer(blob);
    if (!inspected.transparent) throw new Error("抠图结果没有透明背景，无法单独调整商品，请重试抠图");
    let canvas = inspected.canvas;
    if (!preserveLayout) {
        canvas = document.createElement("canvas");
        canvas.width = inspected.bounds.width;
        canvas.height = inspected.bounds.height;
        context2d(canvas).drawImage(inspected.canvas, -inspected.bounds.x, -inspected.bounds.y);
    }
    const b = preserveLayout ? inspected.bounds : { x: 0, y: 0, width: canvas.width, height: canvas.height };
    const extent = preserveLayout ? 1 : 900 / 1024;
    const longest = Math.max(canvas.width, canvas.height);
    const layer = await uploadImage(await whiteCanvasBlob(canvas));
    return {
        version: 1,
        layer,
        base: { width: (extent * canvas.width) / longest, height: (extent * canvas.height) / longest, bounds: { x: b.x / canvas.width, y: b.y / canvas.height, width: b.width / canvas.width, height: b.height / canvas.height } },
        applied: { ...DEFAULT_WHITE_ADJUSTMENTS },
    };
}

export type PreparedWhiteLayer = { source: HTMLCanvasElement; pixels: ImageData; colored: HTMLCanvasElement; colorKey?: string; projected?: { key: string; canvas: HTMLCanvasElement } };
export async function loadWhiteLayer(layer: UploadedImage): Promise<PreparedWhiteLayer> {
    const data = await imageToDataUrl(layer);
    const source = await blobCanvas(await fetch(data).then((response) => response.blob()));
    const colored = document.createElement("canvas");
    colored.width = source.width;
    colored.height = source.height;
    return { source, pixels: context2d(source).getImageData(0, 0, source.width, source.height), colored };
}

export function drawWhiteImage(canvas: HTMLCanvasElement, prepared: PreparedWhiteLayer, editor: WhiteEditorData, settings: WhiteAdjustments, size: number, format: WhiteOutput["format"] = "png") {
    settings = normalizeWhiteAdjustments(settings);
    let product = prepared.source;
    if (WHITE_COLOR_KEYS.some((key) => settings[key] !== 0)) {
        const key = WHITE_COLOR_KEYS.map((name) => settings[name]).join(",");
        if (key !== prepared.colorKey) {
            const pixels = new ImageData(new Uint8ClampedArray(prepared.pixels.data), prepared.pixels.width, prepared.pixels.height);
            adjustWhitePixels(pixels.data, settings);
            context2d(prepared.colored).putImageData(pixels, 0, 0);
            prepared.colorKey = key;
        }
        product = prepared.colored;
    }
    if (canvas.width !== size || canvas.height !== size) {
        canvas.width = size;
        canvas.height = size;
    }
    const context = context2d(canvas);
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
    context.clearRect(0, 0, size, size);
    // JPEG has no alpha: explicitly composite the transparent background over white.
    if (format === "jpeg") {
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, size, size);
    }
    context.fillStyle = settings.backgroundColor;
    context.globalAlpha = settings.backgroundOpacity / 100;
    context.fillRect(0, 0, size, size);
    context.globalAlpha = 1;
    context.save();
    context.translate(settings.x * size, settings.y * size);
    context.rotate((settings.rotation * Math.PI) / 180);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    const width = (editor.base.width * size * settings.scale) / 100;
    const height = (editor.base.height * size * settings.scale) / 100;
    if (settings.perspectiveEnabled) {
        const key = JSON.stringify([settings.perspective, size, WHITE_COLOR_KEYS.map(k => settings[k])]);
        if (prepared.projected?.key !== key) {
            const pixels = product === prepared.source ? prepared.pixels : context2d(product).getImageData(0, 0, product.width, product.height);
            const projected = document.createElement("canvas");
            projected.width = projected.height = size;
            context2d(projected).putImageData(new ImageData(projectWhitePixels(pixels, settings.perspective, size), size, size), 0, 0);
            prepared.projected = { key, canvas: projected };
        }
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.drawImage(prepared.projected.canvas, 0, 0);
    } else context.drawImage(product, -width / 2, -height / 2, width, height);
    context.restore();
}

export async function renderWhiteImage(editor: WhiteEditorData, adjustments: WhiteAdjustments, output: WhiteOutput) {
    const prepared = await loadWhiteLayer(editor.layer);
    const canvas = document.createElement("canvas");
    drawWhiteImage(canvas, prepared, editor, adjustments, output.size, output.format);
    const blob = await whiteCanvasBlob(canvas);
    const url = URL.createObjectURL(blob);
    try {
        return await normalizeWhiteImage({ url, width: output.size, height: output.size, bytes: blob.size, mimeType: "image/png" }, output);
    } finally {
        URL.revokeObjectURL(url);
    }
}

export async function normalizeWhiteImage(image: UploadedImage, output: WhiteOutput) {
    const config = cloneGenerationConfig(DEFAULT_COMMERCE_GENERATION_CONFIG);
    config.outputSpec = { ...config.outputSpec, ...output };
    // The background has already been rendered. Do not use main-white, which
    // unconditionally flattens even transparent PNGs onto white.
    return normalizeOutputImage(image, config, undefined, "marketing-preview", true);
}
