export type ExportImageFormat = "jpeg" | "webp";
export type ExportImageQuality = "high" | "balanced" | "small";
const QUALITY_STEPS: Record<ExportImageQuality, number[]> = {
    high: [0.92, 0.85, 0.75, 0.65, 0.5, 0.35, 0.2],
    balanced: [0.75, 0.65, 0.5, 0.35, 0.2],
    small: [0.5, 0.35, 0.2],
};

/** Export-only encoding: original assets and pixel dimensions are never changed. */
export async function fitExportImage(blob: Blob, maxBytes: number, format: ExportImageFormat = "jpeg", quality: ExportImageQuality = "high") {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("导出图片大小上限必须是正整数字节数");
    if (!blob.size) throw new Error("导出图片为空");
    if (blob.size <= maxBytes) return blob;
    const bitmap = await createImageBitmap(blob);
    try {
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("无法初始化导出图片压缩");
        // JPEG has no alpha; composite transparent PNGs onto white explicitly.
        if (format === "jpeg") { context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height); }
        context.drawImage(bitmap, 0, 0);
        for (const qualityValue of QUALITY_STEPS[quality]) {
            const result = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/" + format, qualityValue));
            if (!result || result.type !== "image/" + format) throw new Error("浏览器不支持所选导出压缩格式：" + format);
            if (result.size > 0 && result.size <= maxBytes) return result;
        }
        throw new Error(`保持 ${bitmap.width}×${bitmap.height} 尺寸压缩后仍无法达到 ${maxBytes} 字节上限；请降低输出尺寸或调整上限后重试，未生成交付包`);
    } finally { bitmap.close(); }
}
