import type { AssetStage } from "@/types/commerce";
import type { UploadedImage } from "@/services/image-storage";

export const FULL_BLEED_GUIDANCE = "输出真正的1:1方形满幅照片，环境背景连续延伸到四边；禁止上下或左右白条、相框、画布补白。保留完整商品，不拉伸商品、不裁掉主体。";

export function requiresSquareScene(stage: AssetStage) {
    return !["main-white", "detail-white"].includes(stage);
}

export function isSquareImage(width: number, height: number) {
    return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 && width === height;
}

/** One bounded repair, never a hidden crop/stretch/padding fallback. */
export async function ensureSquareScene(image: UploadedImage, stage: AssetStage, repair: (image: UploadedImage) => Promise<UploadedImage>, assertCurrent: () => void = () => undefined) {
    assertCurrent();
    if (!requiresSquareScene(stage) || isSquareImage(image.width, image.height)) return image;
    const repaired = await repair(image);
    assertCurrent();
    if (!isSquareImage(repaired.width, repaired.height)) throw new Error("模型补全后仍未返回1:1方图，已停止以避免白条或商品裁切。请重试或更换支持方图的模型。");
    return repaired;
}
