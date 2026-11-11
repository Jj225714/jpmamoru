const PRODUCT_ANALYSIS_MAX_EDGE = 1600;
const PRODUCT_ANALYSIS_MAX_BYTES = 1_500_000;

export async function compressAnalysisImage(dataUrl: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (!dataUrl.startsWith("data:image/") || dataUrl.length * 0.75 <= PRODUCT_ANALYSIS_MAX_BYTES) return dataUrl;
    try {
        const image = new Image();
        image.src = dataUrl;
        await image.decode();
        signal.throwIfAborted();
        const scale = Math.min(1, PRODUCT_ANALYSIS_MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/jpeg", 0.82);
    } catch {
        return dataUrl;
    }
}
