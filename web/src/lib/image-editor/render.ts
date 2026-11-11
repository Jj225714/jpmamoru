import { blendMaskedPixels } from "./pixels";
import { imageToDataUrl } from "@/services/image-storage";
import type { EditImage, EditLayer, ImageEditDocument } from "@/types/image-editor";

const decoded = new Map<string, Promise<HTMLImageElement>>();
export function loadEditImage(image: EditImage | string): Promise<HTMLImageElement> {
    const key = typeof image === "string" ? image : image.storageKey || image.url;
    const cached = decoded.get(key);
    if (cached) return cached;
    const pending = decodeImage(image).catch((error) => {
        decoded.delete(key);
        throw error;
    });
    if (decoded.size >= 12) decoded.delete(decoded.keys().next().value!);
    decoded.set(key, pending);
    return pending;
}
async function decodeImage(image: EditImage | string): Promise<HTMLImageElement> {
    const src = typeof image === "string" ? image : await imageToDataUrl(image);
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("图片加载失败，请重试"));
        img.src = src;
    });
}
export function makeCanvas(width: number, height: number) {
    if (!Number.isFinite(width + height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 33554432) throw new Error("画布尺寸超过限制");
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width);
    canvas.height = Math.round(height);
    return canvas;
}
export function textLines(layer: EditLayer, context: CanvasRenderingContext2D) {
    context.font = `${layer.bold ? 700 : 400} ${layer.fontSize || 40}px ${layer.fontFamily || "Arial"}`;
    return (layer.text || "").split("\n").flatMap((line) => {
        const lines: string[] = [];
        let current = "";
        for (const char of line) {
            if (current && context.measureText(current + char).width > layer.width) {
                lines.push(current);
                current = "";
            }
            current += char;
        }
        return [...lines, current];
    });
}
export async function renderDocument(doc: ImageEditDocument, jpeg = false) {
    await document.fonts.ready;
    const canvas = makeCanvas(doc.width, doc.height);
    const ctx = canvas.getContext("2d")!;
    if (jpeg) {
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    if (doc.background !== "transparent") {
        ctx.fillStyle = doc.background;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    for (const layer of doc.layers.filter((l) => l.visible)) {
        ctx.save();
        ctx.globalAlpha = layer.opacity;
        ctx.translate(layer.x + layer.width / 2, layer.y + layer.height / 2);
        ctx.rotate((layer.rotation * Math.PI) / 180);
        ctx.translate(-layer.width / 2, -layer.height / 2);
        if (layer.kind === "image" && layer.image) ctx.drawImage(await loadEditImage(layer.image), 0, 0, layer.width, layer.height);
        else {
            const lines = textLines(layer, ctx);
            ctx.fillStyle = layer.color || "#222222";
            ctx.textBaseline = "top";
            ctx.textAlign = layer.align || "left";
            ctx.beginPath();
            ctx.rect(0, 0, layer.width, layer.height);
            ctx.clip();
            lines.forEach((line, index) => ctx.fillText(line, layer.align === "center" ? layer.width / 2 : layer.align === "right" ? layer.width : 0, index * (layer.fontSize || 40) * 1.25));
        }
        ctx.restore();
    }
    return canvas;
}
export function canvasBlob(canvas: HTMLCanvasElement, format = "image/png"): Promise<Blob> {
    return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("图片导出失败"))), format, 0.95));
}
/** Restore original pixels outside a white edit mask. RGB comparison is exact. */
export async function compositeMasked(original: string, generated: string, mask: string) {
    const [base, result, selection] = await Promise.all([loadEditImage(original), loadEditImage(generated), loadEditImage(mask)]);
    const canvas = makeCanvas(base.width, base.height);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(result, 0, 0, canvas.width, canvas.height);
    const edited = ctx.getImageData(0, 0, canvas.width, canvas.height);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(selection, 0, 0, canvas.width, canvas.height);
    const masks = ctx.getImageData(0, 0, canvas.width, canvas.height);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(base, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    pixels.data.set(blendMaskedPixels(pixels.data, edited.data, masks.data));
    ctx.putImageData(pixels, 0, 0);
    return canvasBlob(canvas);
}
export async function opaqueInput(image: EditImage) {
    const source = await loadEditImage(image);
    const canvas = makeCanvas(source.width, source.height);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0);
    return canvas.toDataURL();
}
export async function alphaStats(image: EditImage) {
    const source = await loadEditImage(image);
    const canvas = makeCanvas(source.width, source.height);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(source, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let transparent = false,
        visible = false;
    for (let i = 3; i < pixels.length; i += 4) {
        transparent ||= pixels[i] < 250;
        visible ||= pixels[i] > 5;
        if (transparent && visible) break;
    }
    return { transparent, visible };
}
export async function restoreAlpha(image: EditImage, output: string, scale: number) {
    const [source, generated] = await Promise.all([loadEditImage(image), loadEditImage(output)]);
    if (generated.width !== source.width * scale || generated.height !== source.height * scale) throw new Error("高清模型输出尺寸与请求不一致，未应用结果");
    const canvas = makeCanvas(source.width * scale, source.height * scale);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(generated, 0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvasBlob(canvas);
}
