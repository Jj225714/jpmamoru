import { parseAspectRatio, parsePixelSize } from "@/lib/media-size";

const MAX_REFERENCE_EDGE = 2048;

/** Place the whole source in a canvas with the requested aspect ratio; never crop or stretch it. */
export function referenceFrameGeometry(sourceWidth: number, sourceHeight: number, targetWidth: number, targetHeight: number) {
    if ([sourceWidth, sourceHeight, targetWidth, targetHeight].some((value) => !Number.isFinite(value) || value <= 0)) throw new Error("Invalid reference dimensions");
    const targetRatio = targetWidth / targetHeight;
    if (Math.abs(sourceWidth / sourceHeight / targetRatio - 1) < 0.01) return null;
    const rawWidth = Math.max(sourceWidth, sourceHeight * targetRatio);
    const rawHeight = rawWidth / targetRatio;
    const factor = Math.min(1, MAX_REFERENCE_EDGE / Math.max(rawWidth, rawHeight));
    const divisor = gcd(targetWidth, targetHeight);
    const baseWidth = targetWidth / divisor;
    const baseHeight = targetHeight / divisor;
    const units = Math.max(1, Math.floor(Math.min((rawWidth * factor) / baseWidth, (rawHeight * factor) / baseHeight)));
    const width = baseWidth * units;
    const height = baseHeight * units;
    const imageScale = Math.min(width / sourceWidth, height / sourceHeight);
    const imageWidth = sourceWidth * imageScale;
    const imageHeight = sourceHeight * imageScale;
    return { width, height, x: (width - imageWidth) / 2, y: (height - imageHeight) / 2, imageWidth, imageHeight };
}

export function targetAspectMismatch(width: number, height: number, size: string) {
    const target = parsePixelSize(size) || parseAspectRatio(size);
    if (!target || !width || !height) return false;
    return Math.abs(width / height / (target.width / target.height) - 1) > 0.02;
}

export async function frameReferenceToSize(dataUrl: string, size: string): Promise<string> {
    const target = parsePixelSize(size);
    if (!target) return dataUrl;
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error("无法读取参考图，未发起生图请求"));
        element.src = dataUrl;
    });
    const frame = referenceFrameGeometry(image.naturalWidth, image.naturalHeight, target.width, target.height);
    if (!frame) return dataUrl;
    const canvas = document.createElement("canvas");
    canvas.width = frame.width;
    canvas.height = frame.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法准备参考图比例，未发起生图请求");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, frame.width, frame.height);
    context.drawImage(image, frame.x, frame.y, frame.imageWidth, frame.imageHeight);
    return canvas.toDataURL("image/jpeg", 0.94);
}

function gcd(a: number, b: number): number {
    let x = Math.round(a);
    let y = Math.round(b);
    while (y) [x, y] = [y, x % y];
    return x;
}
