import type { GeneratedAsset, LayeredComposition } from "@/types/commerce";

/** Pure validation of the two source panels; editable text and brand layers are independent. */
export function comparisonCompositionErrors(composition: LayeredComposition | undefined, sources: GeneratedAsset[]): string[] {
    if (!composition) return ["前后对比缺少当前版本的分层画板"];
    const errors: string[] = [];
    const validCanvas = Number.isFinite(composition.width) && composition.width > 0 && Number.isFinite(composition.height) && composition.height > 0;
    if (!validCanvas) errors.push("前后对比画板尺寸无效");
    const validSources = sources.length === 2 && sources[0].id !== sources[1].id
        && sources.filter((source) => source.comparisonRole === "before").length === 1
        && sources.filter((source) => source.comparisonRole === "after").length === 1;
    if (!validSources) errors.push("前后对比需要不同的使用前、使用后来源素材");
    const layers = composition.layers.filter((layer) => ["background", "product", "flattened", "decoration"].includes(layer.type));
    if (layers.length !== 2) errors.push("前后对比必须恰好保留两个来源图层");
    if (validSources) for (const source of sources) {
        if (layers.filter((layer) => layer.sourceAssetId === source.id && layer.comparisonRole === source.comparisonRole).length !== 1) {
            errors.push("前后对比图层必须分别绑定正确的使用前、使用后素材及角色");
        }
    }
    for (const layer of layers) {
        if (layer.visible !== true || !Number.isFinite(layer.opacity) || layer.opacity < 0.95) errors.push("前后对比来源图层必须显示且不透明度至少为 95%");
        if (layer.rotation !== 0) errors.push("前后对比来源图层不能旋转");
        const validGeometry = [layer.x, layer.y, layer.width, layer.height].every(Number.isFinite);
        if (!validGeometry || layer.width <= 0 || layer.height <= 0 || validCanvas && (layer.width < composition.width * 0.2 || layer.height < composition.height * 0.2)) {
            errors.push("前后对比每个来源图层的宽高必须至少为画板对应尺寸的 20%");
        }
        if (!validGeometry || validCanvas && (layer.x < -1 || layer.y < -1 || layer.x + layer.width > composition.width + 1 || layer.y + layer.height > composition.height + 1)) {
            errors.push("前后对比来源图层必须完整位于画板内（容差 1px）");
        }
    }
    if (layers.length === 2) {
        const [before, after] = layers;
        const overlapWidth = Math.min(before.x + before.width, after.x + after.width) - Math.max(before.x, after.x);
        const overlapHeight = Math.min(before.y + before.height, after.y + after.height) - Math.max(before.y, after.y);
        if (overlapWidth > 1 && overlapHeight > 1) errors.push("前后对比来源图层不能重叠（容差 1px）");
    }
    return [...new Set(errors)];
}
